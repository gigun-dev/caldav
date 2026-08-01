// =============================================================================
// WebDAV / CalDAV XML codec
// =============================================================================
// XML の知識は presentation 層だけに置く。入力側は iOS/一般クライアントが送る既知要素を
// 名前空間 prefix 非依存で抽出し、出力側は要求された property ごとに 200/404 propstat を返す。

import type { CalendarCollection, CalendarObjectResource } from "../../domain/caldav";
// J-2: supported-calendar-component-set の宣言フォールバック / parseCollectionProperties の
// comp 名解析を domain/caldav の COMPONENT_KINDS / parseComponentKind と単一ソース化するための import。
// presentation → domain は層順方向(内側依存)なので問題ない。
import { COMPONENT_KINDS, parseComponentKind, type ComponentKind } from "../../domain/caldav/values/component-kind";
// G-3: calendar-query REPORT の <C:timezone> 要素(§9.8)は VTIMEZONE を丸ごと1個埋め込む
// PCDATA。parse/ICalendarObject/resolveTimeZoneId を使って TZID → IANA 名へ解決する
// ここだけが presentation 層で domain/ical の parse を直接呼ぶ箇所(XML 内に埋め込まれた
// もう1つの ICS を読む必要があるための例外的な依存。domain → presentation の逆方向ではない
// ので層境界は破っていない)。OCCURRENCE_INDEX_MAX は time-range の end 属性省略時の
// 既定上限(§9.9: 片側欠落は「無限大」の意)に使う — domain/ical/recurrence の
// occurrence-bounds.ts と同じ定数を共有することで、PUT 側の索引の last キャップと
// REPORT 側のデフォルト窓の上限が食い違わないようにする。
import { parse, ICalendarObject, resolveTimeZoneId, serialize, type Component, type Property } from "../../domain/ical";
import { OCCURRENCE_INDEX_MAX } from "../../domain/ical/recurrence";
import type { BusyInterval } from "../../domain/ical/freebusy";

const NS_CALDAV = "urn:ietf:params:xml:ns:caldav";
const NS_CS = "http://calendarserver.org/ns/";
const NS_APPLE = "http://apple.com/ns/ical/";

// =============================================================================
// 要求プロパティ名の保持(2026-08-01 修正: 404 propstat の名前空間/大文字が壊れていた)
// =============================================================================
// 【何が壊れていたか】旧実装の PropFilter は `Set<string>`(小文字化したローカル名だけ)で、
// 404 propstat は `<d:${name}/>` と決め打ちしていた。つまり
//   - 要求 `<B:calendar-color xmlns:B="http://apple.com/ns/ical/"/>`
//     → 応答 `<d:calendar-color/>`(**DAV: に潰れる**)
//   - 要求 `<C:schedule-default-calendar-URL/>`
//     → 応答 `<d:schedule-default-calendar-url/>`(**名前空間 + 大文字小文字が壊れる**)
// という別物の要素を返していた(本番実測。caldav/carddav/calendarserver/apple-ical/me.com の
// 5 名前空間すべて・PROPFIND と REPORT の両方で再現)。
//
// 【なぜ直すか(RFC 原文)】docs/rfc/rfc4918.txt より:
//   - §14.22 propstat: "The contents of the prop XML element MUST only list the names of
//     properties to which the result in the status element applies."
//   - §4.4 Property Names: "A property name is a universally unique identifier ...
//     The XML namespace mechanism, which is based on URIs ([RFC3986]), is used to name
//     properties because it prevents namespace collisions"
//   - §17: "WebDAV property names are qualified XML names (pairs of XML namespace name and
//     local name)."
// つまりプロパティ「名」= (名前空間 URI, ローカル名) の対であり、名前空間を潰した時点で
// 「要求されたプロパティの名前」ではなくなる = §14.22 の MUST 違反。さらに XML の要素名は
// 大文字小文字を区別する(REC-XML)ので `...-URL` を `...-url` にするのも別要素化である。
// 一方 prefix そのものは §4.3 の例の注記 "The [prefix] for the property name itself was not
// preserved, being non-significant" のとおり保存不要 — **保存すべきは名前空間 URI だけ**。
//
// 【iOS への影響の程度(過大評価しないための注記)】docs/modeling/06 の
// 「要求されたプロパティを黙って落とすと NG。404 propstat に列挙必須」は列挙の**有無**の話で、
// 今回は列挙自体はできていた。iOS 26.5 は現状この壊れた名前でもアカウント追加に成功する(実測)。
// よってこれは「証明された iOS 破壊」ではなく **仕様違反 + 潜在リスク**(名前空間で判定する
// 他クライアント・将来の iOS で壊れうる)として直す。
//
// 【設計の要点: 「マッチング用の正規化」と「応答に書き戻す表現」を分ける】
// 200 側の照合は今までどおり小文字ローカル名(props Record のキー)で行い、404 側に書き戻す
// ときだけ元の名前空間 URI と原表記のローカル名を使う。両者を1つの文字列で兼ねようとしたのが
// そもそもの敗因なので、型で分離する。

/** 要求された1つのプロパティ名。マッチング用の key と、応答へ書き戻す原表現を両方持つ。 */
export interface RequestedPropName {
	/** マッチング用の正規化キー = ローカル名の小文字化。props Record のキーと突き合わせる。 */
	readonly key: string;
	/** 応答へ書き戻すローカル名。**要求されたままの大文字小文字**(schedule-default-calendar-URL 等)。 */
	readonly localName: string;
	/** 名前空間 URI。prefix ではなく URI で持つ(prefix は §4.3 のとおり非保存でよい)。
	 *  宣言が見つからなければ ""(= 名前空間なし)。 */
	readonly namespace: string;
}

/**
 * PROPFIND/REPORT の `<prop>` 要求。"allprop" か、要求プロパティの Map。
 *
 * 【なぜ Set<string> ではなく Map<key, RequestedPropName> か】
 * 呼び出し側(responseXml)は `filter.has(name)` と `filter === "allprop"` しか使っておらず、
 * Map は Set と同じ `has()` を持つので **既存コードの形をほぼ変えずに** 情報量だけ増やせる。
 * 【採らなかった案】`{ kind: "names"; props: RequestedPropName[] }` の判別共用体。
 * 表現としては素直だが `filter === "allprop"` の比較が全部 `filter.kind === ...` に変わり、
 * このバグ修正と無関係な差分が増える(レビューで本質が埋もれる)。
 * 【採らなかった案2】Set<string> のまま「ns URI と原表記を1つの文字列に埋め込む」
 * (例 `"{DAV:}displayname"` の Clark 記法)。props Record 側のキーも全部書き換えが必要になり、
 * 200 側の照合規則(小文字ローカル名のみ)まで巻き込む大改修になるので見送った。
 */
export type PropFilter = ReadonlyMap<string, RequestedPropName> | "allprop";

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function unescapeXml(value: string): string {
	return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/**
 * ドキュメント全体の xmlns 宣言を prefix → 名前空間 URI に集める。
 *
 * 【なぜ「ドキュメント全体を舐める」という雑な方法でよいか】
 * 本来 XML の名前空間宣言は要素のスコープを持ち、内側で同じ prefix を別 URI に再束縛できる。
 * ここはそこまで見ない = **最初に現れた宣言が勝つ**近似。理由は3つ:
 *   1. このファイルはそもそも正規表現ベースの codec で、DOM を持たない(Workers に DOMParser が
 *      無く、XML パーサを1つ足すのはこのバグ修正には過剰。既存の parseHrefs 等も同じ流儀)。
 *   2. 実クライアント(iOS / macOS / tsdav / Thunderbird)は全宣言を root 要素に置く。
 *      prefix の再束縛を使う CalDAV クライアントは観測されていない。
 *   3. 外した場合の被害は「404 propstat の名前空間が要求と違う」= **修正前と同じ状態**に戻るだけで、
 *      新たな退行にはならない(200 側の照合はローカル名だけなので影響を受けない)。
 * もし将来 prefix 再束縛を踏んだら、そのときこそ本物の XML パーサを入れる判断をする。
 */
function parseNamespaceDeclarations(body: string): Map<string, string> {
	const declarations = new Map<string, string>();
	// `xmlns:B="..."` と既定名前空間 `xmlns="..."` の両方。既定は prefix "" として持つ。
	for (const match of body.matchAll(/\bxmlns(?::([^=\s>/]+))?\s*=\s*["']([^"']*)["']/g)) {
		const prefix = match[1] ?? "";
		// 最初の宣言が勝つ(上のコメントの「近似」の実体)。root 要素の宣言が document 順で先頭に来る。
		if (!declarations.has(prefix)) declarations.set(prefix, unescapeXml(match[2]));
	}
	return declarations;
}

export function parsePropFilter(body: string): PropFilter {
	if (!body.trim() || /<(?:[^:>]+:)?allprop\b/i.test(body)) return "allprop";
	const block = body.match(/<(?:[^:>]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?prop>/i)?.[1];
	if (!block) return "allprop";
	const declarations = parseNamespaceDeclarations(body);
	// Map は挿入順を保つので、404 propstat には**クライアントが要求した順**でプロパティが並ぶ。
	// RFC 上の要求ではないが、リクエストと応答を目視で突き合わせるデバッグが格段に楽になる。
	const result = new Map<string, RequestedPropName>();
	// group1 = prefix(無ければ undefined)/ group2 = ローカル名。`(?!\/)` で閉じタグを除外。
	// prefix から `/` を除いているのは `<foo/>` の自己終端スラッシュを prefix と誤読しないため。
	for (const match of block.matchAll(/<(?!\/)(?:([^:>\s/]+):)?([\w-]+)\b/g)) {
		const localName = match[2];
		const key = localName.toLowerCase();
		// 同じローカル名が別名前空間で2回来た場合は先勝ち。200 側の照合がローカル名でしか
		// 行われない以上どちらか一方しか表現できず、「先に書かれた方」が最も素直な選択。
		// (実クライアントで衝突は観測されていない。踏んだら名前空間つき照合への移行を検討する。)
		if (result.has(key)) continue;
		result.set(key, {
			key,
			localName,
			// 宣言の無い prefix は「名前空間なし」に倒す。壊れた要求(prefix を宣言し忘れ)なので
			// どう返しても正解は無いが、勝手に DAV: を割り当てる(= 旧実装の挙動)よりは
			// 「知らない名前空間を捏造しない」方が誠実。宣言していない prefix をそのまま応答に
			// 書き戻すのは名前空間的に非整形式な XML になるので論外。
			namespace: declarations.get(match[1] ?? "") ?? "",
		});
	}
	return result.size === 0 ? "allprop" : result;
}

/**
 * 「この名前の集合が要求された」とみなす PropFilter を組み立てる(PROPPATCH 応答用)。
 *
 * PROPPATCH は「受理したプロパティ」をそのまま props Record と filter の両方に渡すため
 * 404 側には決して回らない(known ⊇ filter)。よって namespace / localName は使われないが、
 * PropFilter 型を1本に保つためにダミーを埋める。
 * 【なぜ PropFilter を `Set<string> も可` の共用体にしなかったか】responseXml が
 * 「Set なら名前空間不明」の分岐を持つことになり、404 の書き戻し経路が再び2本になる。
 * 今回のバグの原因がまさに「404 側だけ別経路で名前を組み立てていた」ことなので、
 * 経路は1本に保つ。
 */
export function propFilterFromKeys(keys: readonly string[]): PropFilter {
	return new Map(keys.map((key) => [key, {
		key,
		localName: key,
		// 名前空間不明を "" で表す。仮に将来この filter が 404 経路に回っても、
		// 実在しない名前空間を捏造せず「名前空間なし」として出るだけで済む。
		namespace: "",
	}]));
}

function requested(filter: PropFilter, name: string): boolean {
	return filter === "allprop" || filter.has(name);
}

function propstat(props: string, status = "200 OK"): string {
	return `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;
}

/**
 * multistatus() が `<d:multistatus>` 要素で宣言済みの名前空間 URI → prefix。
 *
 * 404 propstat に書き戻す要素は、ここに載っている名前空間なら**宣言済み prefix を再利用**する。
 * 要素ごとに xmlns を撒かずに済み、200 側(props Record が手書きで `<c:...>` 等を使っている)と
 * 見た目も揃う。multistatus() のテンプレートと二重管理になるが、テンプレートは1行の文字列
 * リテラルなので機械的に導出するより「並べて読める」方が事故が少ないと判断した
 * (どちらかを増やしたらもう一方も、というのは下のテストで固定してある)。
 */
const DECLARED_NS_PREFIXES: ReadonlyMap<string, string> = new Map([
	["DAV:", "d"],
	[NS_CALDAV, "c"],
	[NS_CS, "cs"],
	[NS_APPLE, "ical"],
]);

/**
 * 404 propstat に列挙する「要求されたが存在しないプロパティ名」を要素として書き出す。
 *
 * 名前空間の扱いは3通り:
 *   1. multistatus で宣言済み → その prefix を使う(`<ical:calendar-color/>`)
 *   2. 未宣言の名前空間 → **その要素自身に xmlns を付けて** ad-hoc prefix を宣言する
 *      (`<x1:bulk-requests xmlns:x1="http://me.com/_namespace/"/>`)。
 *      【なぜ multistatus 側に足さないか】要求されうる名前空間は無限(クライアントは任意の
 *      ベンダ拡張を要求できる)なので、静的な宣言リストでは原理的に閉じない。要素ローカル宣言なら
 *      どんな URI でも正しく返せる。
 *      【なぜ既定名前空間形式 `<bulk-requests xmlns="..."/>` を採らなかったか】XML 的には等価で
 *      短いが、応答中で prefix 付きと無しが混在すると、prefix を文字列照合する素朴な
 *      クライアント実装(DAV の世界には実在する)がさらに混乱しやすい。全要素 prefix 付きで揃える。
 *      なお ad-hoc prefix は要素ごとに宣言を**毎回**付ける — 宣言のスコープは要素なので、
 *      同じ URI の2個目に宣言を省くと非整形式になる(ここは踏みやすい罠)。
 *   3. 名前空間なし(要求側が prefix も既定 xmlns も持たなかった/prefix 未宣言)→ prefix 無しで
 *      そのまま書く。multistatus は既定名前空間を宣言していないので、prefix 無し = 名前空間なしが
 *      正しく表現できる。
 *
 * localName は parsePropFilter の `[\w-]+` 由来なので XML メタ文字を含まず、エスケープ不要。
 * 名前空間 URI はクライアント由来の任意文字列なので属性値としてエスケープする。
 */
function missingPropNameXml(missing: readonly RequestedPropName[]): string {
	// 同じ未宣言名前空間には同じ ad-hoc prefix を割り当てる(応答の読みやすさのため。
	// 別 prefix でも XML 的には正しいが、目 grep で「同じ名前空間だ」と分かる方がよい)。
	const adhocPrefixes = new Map<string, string>();
	return missing.map((prop) => {
		if (prop.namespace === "") return `<${prop.localName}/>`;
		const declared = DECLARED_NS_PREFIXES.get(prop.namespace);
		if (declared !== undefined) return `<${declared}:${prop.localName}/>`;
		let prefix = adhocPrefixes.get(prop.namespace);
		if (prefix === undefined) {
			prefix = `x${adhocPrefixes.size + 1}`;
			adhocPrefixes.set(prop.namespace, prefix);
		}
		return `<${prefix}:${prop.localName} xmlns:${prefix}="${escapeXml(prop.namespace)}"/>`;
	}).join("");
}

export function responseXml(href: string, props: Record<string, string>, filter: PropFilter): string {
	const known = Object.keys(props);
	// R-5b: DAV:sync-token は RFC 6578 §4 で「PROPFIND allprop で SHOULD NOT 返す」と明記されている
	// (sync-collection REPORT と同じ値を返す「同期用」プロパティであり、allprop の一般列挙に
	// 紛れ込ませる想定ではない、という位置づけ)。collectionProps() は明示要求時に返せるよう
	// 常に "sync-token" キーを props に含めているので、ここ(allprop 展開の唯一の集約点)で
	// 名指しに除外する。iOS 実機は sync-collection REPORT 経由でしか sync-token を見ておらず
	// allprop 応答中の sync-token には依存していない(既存の sync 系テストを参照して確認済み)。
	const ok = known.filter((name) => requested(filter, name) && !(filter === "allprop" && name === "sync-token"))
		.map((name) => props[name]).join("");
	// 404 側: 要求されたが props に無いもの。照合は key(小文字ローカル名)で行い、書き戻しは
	// RequestedPropName が保持している原表記 + 名前空間で行う(旧実装はここで `<d:${name}/>` と
	// 決め打ちしていたのが本バグの正体。冒頭の RequestedPropName のコメント参照)。
	const missing = filter === "allprop" ? [] : [...filter.values()].filter((prop) => !known.includes(prop.key));
	return `<d:response><d:href>${escapeXml(href)}</d:href>${ok ? propstat(ok) : ""}${
		missing.length ? propstat(missingPropNameXml(missing), "404 Not Found") : ""
	}</d:response>`;
}

export function statusResponseXml(href: string, status: string): string {
	return `<d:response><d:href>${escapeXml(href)}</d:href><d:status>HTTP/1.1 ${status}</d:status></d:response>`;
}

export function multistatus(responses: string, syncToken?: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="${NS_CALDAV}" xmlns:cs="${NS_CS}" xmlns:ical="${NS_APPLE}">${responses}${syncToken ? `<d:sync-token>${escapeXml(syncToken)}</d:sync-token>` : ""}</d:multistatus>`;
}

export function entryProps(principalHref: string): Record<string, string> {
	return {
		displayname: "<d:displayname>CalDAV</d:displayname>",
		resourcetype: "<d:resourcetype><d:collection/></d:resourcetype>",
		"current-user-principal": `<d:current-user-principal><d:href>${escapeXml(principalHref)}</d:href></d:current-user-principal>`,
		"principal-url": `<d:principal-URL><d:href>${escapeXml(principalHref)}</d:href></d:principal-URL>`,
	};
}

export function principalProps(displayName: string, principalHref: string, homeHref: string): Record<string, string> {
	return {
		displayname: `<d:displayname>${escapeXml(displayName)}</d:displayname>`,
		resourcetype: "<d:resourcetype><d:collection/><d:principal/></d:resourcetype>",
		"calendar-home-set": `<c:calendar-home-set><d:href>${escapeXml(homeHref)}</d:href></c:calendar-home-set>`,
		"calendar-user-address-set": `<c:calendar-user-address-set><d:href>mailto:${escapeXml(displayName)}</d:href></c:calendar-user-address-set>`,
		"current-user-principal": `<d:current-user-principal><d:href>${escapeXml(principalHref)}</d:href></d:current-user-principal>`,
		"principal-url": `<d:principal-URL><d:href>${escapeXml(principalHref)}</d:href></d:principal-URL>`,
		// 2026-08-01: principal URL で実際に応答できる REPORT を広告する(RFC 3253 §3.1.5
		// DAV:supported-report-set)。collectionProps の R-5a 是正と同じ「実装しているものは
		// 広告する / 広告したものは実装する」規律。ここに載せるのは principal-search-property-set
		// だけ — DAV:principal-property-search(RFC 3744 §9.4。原文は "Support ... is REQUIRED")は
		// 未実装なので**あえて広告しない**。広告して 403 を返すより、広告せず「無い」と言う方が
		// クライアントの分岐が素直になる(未実装であること自体は docs/modeling/05 に gap として記録)。
		"supported-report-set": "<d:supported-report-set><d:supported-report><d:report><d:principal-search-property-set/></d:report></d:supported-report></d:supported-report-set>",
	};
}

export function homeProps(displayName: string): Record<string, string> {
	return {
		displayname: `<d:displayname>${escapeXml(displayName)} Calendars</d:displayname>`,
		resourcetype: "<d:resourcetype><d:collection/></d:resourcetype>",
		"current-user-privilege-set": "<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set>",
	};
}

export function collectionProps(collection: CalendarCollection, syncTokenUri: string): Record<string, string> {
	// J-2: supportedComponents が undefined のコレクションは RFC 4791 §5.2.3 により
	// 「supported-calendar-component-set プロパティ不在 = 全コンポーネント accept」MUST であり、
	// put-preconditions.ts の checkSupportedComponent も実際に undefined を「全受理」として扱っている。
	// 旧実装はここを ["VEVENT", "VTODO"] にハードコードしており、「宣言は VEVENT/VTODO だけなのに
	// 実際は VJOURNAL も PUT できる」という宣言と実装の乖離があった(2026-07-11 是正)。
	// COMPONENT_KINDS(domain 側の single source of truth)をそのまま宣言することで
	// 「宣言 = 実際の受理」を一致させる。ハードコードしないのは、将来コンポーネント種別が
	// 増えたときに宣言側の追従漏れを構造的に防ぐため。
	const components = (collection.supportedComponents ?? COMPONENT_KINDS)
		.map((name) => `<c:comp name="${name}"/>`).join("");
	const props: Record<string, string> = {
		displayname: `<d:displayname>${escapeXml(collection.displayName)}</d:displayname>`,
		resourcetype: "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
		"supported-calendar-component-set": `<c:supported-calendar-component-set>${components}</c:supported-calendar-component-set>`,
		// R-5a: free-busy-query REPORT(G-4 で実装済み・§7.10.2)を supported-report-set の広告に
		// 追加していなかった漏れ。実装はあるのに広告に無いと、広告ベースで対応 REPORT を判定する
		// クライアント/ツールから「未対応」に見えてしまう(実装と宣言の不一致は他の J-2 是正
		// (collectionProps 冒頭コメント参照)と同種の反省)。
		"supported-report-set": "<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report><d:supported-report><d:report><c:free-busy-query/></d:report></d:supported-report></d:supported-report-set>",
		"current-user-privilege-set": "<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set>",
		getctag: `<cs:getctag>${escapeXml(collection.ctag.toString())}</cs:getctag>`,
		"sync-token": `<d:sync-token>${escapeXml(syncTokenUri)}</d:sync-token>`,
	};
	if (collection.color) props["calendar-color"] = `<ical:calendar-color>${collection.color}</ical:calendar-color>`;
	if (collection.order !== undefined) props["calendar-order"] = `<ical:calendar-order>${collection.order}</ical:calendar-order>`;
	return props;
}

export function objectProps(resource: CalendarObjectResource, includeData: boolean): Record<string, string> {
	const props: Record<string, string> = {
		getetag: `<d:getetag>${escapeXml(resource.etag.toHeader())}</d:getetag>`,
		getcontenttype: `<d:getcontenttype>text/calendar; charset=utf-8; component=${resource.componentKind}</d:getcontenttype>`,
		getcontentlength: `<d:getcontentlength>${new TextEncoder().encode(resource.rawIcs).byteLength}</d:getcontentlength>`,
	};
	if (includeData) props["calendar-data"] = `<c:calendar-data>${escapeXml(resource.rawIcs)}</c:calendar-data>`;
	return props;
}

export function parseHrefs(body: string): string[] {
	return [...body.matchAll(/<(?:[^:>]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?href>/gi)]
		.map((match) => unescapeXml(match[1].trim()));
}

function textElement(body: string, localName: string): string | undefined {
	return unescapeXml(body.match(new RegExp(`<(?:[^:>]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${localName}>`, "i"))?.[1]?.trim() ?? "") || undefined;
}

// J-2: supported-calendar-component-set は <C:comp name="..."/> を複数並べられる(§5.2.3)。
// 旧実装は単一 comp(VEVENT|VTODO 決め打ち)しか拾えず、MKCALENDAR で VJOURNAL コレクションを
// オプトイン作成する経路が無かった。ここで全 comp 名を拾って ComponentKind[] を返すよう拡張し、
// journal(agentic 日誌)は自動 provision せず「欲しい人だけ MKCALENDAR で作る」を実現する
// (2026-07-11 判断。除去可能性を優先する journal の設計方針は provision-default-collections.ts 参照)。
export function parseCollectionProperties(body: string): {
	displayName?: string; components?: ComponentKind[]; color?: string; order?: number;
} {
	// global マッチで全 comp name="..." を拾う → parseComponentKind で正規化(不正名は捨てる)。
	// parseComponentKind は COMPONENT_KINDS(VEVENT/VTODO/VJOURNAL)を single source にしているので、
	// ここに手を加えなくても将来コンポーネント種別が増えれば自動で通るようになる。
	const components = [...body.matchAll(/<(?:[^:>]+:)?comp\b[^>]*\bname=["']([\w-]+)["']/gi)]
		.map((m) => parseComponentKind(m[1]))
		.filter((c): c is ComponentKind => c !== undefined);
	const orderRaw = textElement(body, "calendar-order");
	return {
		displayName: textElement(body, "displayname"),
		components: components.length > 0 ? components : undefined,
		color: textElement(body, "calendar-color"),
		order: orderRaw === undefined ? undefined : Number(orderRaw),
	};
}

export function parseSyncToken(body: string): string | null {
	return textElement(body, "sync-token") ?? null;
}

/**
 * RFC 3253 §1.6 が定める precondition/postcondition の失敗応答ボディ。
 * 「403/409 の本体は、違反した condition を表す XML 要素を子に持つ DAV:error でなければならない」
 * (原文: docs/rfc/ に 3253 のスナップショットは無い。2026-08-01 時点では rfc-editor.org から
 *  取得した原文で §1.6 / §3.6 を確認済み。照合結果は docs/modeling/05 に記録)。
 * RFC 4918 §16 も同じ形("DAV:error containing the violated precondition")を踏襲している。
 *
 * 【namespace オプションを足した理由(2026-08-01)】
 * この関数はもともと CalDAV 由来の precondition(CALDAV:supported-filter 等)専用で、
 * 要素名を無条件に `c:`(urn:ietf:params:xml:ns:caldav)へ付けていた。だが RFC 3253 §3.6 の
 * REPORT precondition は **DAV:supported-report** で、DAV: 名前空間に属する。
 * `c:supported-report` と書くと別物の要素になり、名前空間で判別するクライアントには
 * 「未知の precondition」に見える。
 * 【なぜ関数を2本に分けなかったか】呼び出し側から見て「precondition 名 → 403 本体」という
 * 役割は完全に同じで、違うのは名前空間だけ。2本にすると「どっちを呼ぶか」を都度考えることになり、
 * かつ将来 precondition が増えるたびに分岐が増える。オプション1個で済ませる方が薄い。
 *
 * 【解決済み: valid-sync-token は DAV: 名前空間(2026-08-01 修正)】
 * 上の段落を書いた時点では「c: を付けているが誤りの疑い」として据え置いていた(iOS の
 * 「無効 sync-token からの回復」経路に触れるため単独で検証したかった)。原文を再確認して確定:
 * docs/rfc/rfc6578.txt §3.2 Preconditions は "(DAV:valid-sync-token): The DAV:sync-token
 * element value MUST be a valid token previously returned by the server ..." と書いており、
 * RFC 3253 §1.6 の記法どおり precondition 名の `DAV:` は名前空間を指す。よって
 * app.ts は `davError("valid-sync-token", { namespace: "dav" })` を呼ぶよう修正した。
 * 回復経路(403 を受けたクライアントが token 無しで full sync し直す)は app.test.ts の
 * 「無効 sync-token」テストで固定してある。
 *
 * @param name precondition 要素のローカル名(例 "supported-report" / "supported-filter")。
 * @param options.detail DAV:responsedescription に載せる人間向け説明(任意)。
 * @param options.namespace 要素を置く名前空間。既定は既存呼び出しとの互換のため "caldav"。
 */
export function davError(
	name: string,
	options?: { detail?: string; namespace?: "caldav" | "dav" },
): string {
	const prefix = options?.namespace === "dav" ? "d" : "c";
	const detail = options?.detail;
	return `<?xml version="1.0" encoding="UTF-8"?><d:error xmlns:d="DAV:" xmlns:c="${NS_CALDAV}"><${prefix}:${name}/>${detail ? `<d:responsedescription>${escapeXml(detail)}</d:responsedescription>` : ""}</d:error>`;
}

// =============================================================================
// DAV:principal-search-property-set REPORT(RFC 3744 §9.5)
// =============================================================================
// 【なぜ実装するか(2026-08-01)】OPTIONS の Allow は REPORT を広告しているのに、
// principal URL への REPORT がルーティングに引っかからず 404 を返していた
// (app.ts の calendar-home prefix 判定に落ちる)。「広告したメソッドが 404」は不整合。
// この REPORT は Apple 自身の負荷シミュレータ(ccs-calendarserver
// simplugin/caldavclient.py の BaseAppleClient startup シーケンス)がブートストラップで
// 投げる経路であり、iOS も結果をアカウント属性に保存している実績がある。
//
// RFC 3744 §9.5 原文(docs/rfc/rfc3744.txt)の要件:
//   - リクエストボディは空の DAV:principal-search-property-set 要素 MUST
//   - Depth は "0" のときだけ定義される。他の値は 400 (Bad Request) MUST
//     (Depth ヘッダ省略時は RFC 3253 §3.6 により 0 とみなす)
//   - レスポンスボディは DAV:principal-search-property-set 要素 MUST。子は
//     `<!ELEMENT principal-search-property-set (principal-search-property*)>` = **0個でもよい**
//   - 各 principal-search-property は prop 1個 + description(xml:lang 必須)

/**
 * DAV:principal-search-property-set REPORT の応答ボディ。
 *
 * 【なぜ「空」で返すのか(採用理由)】
 * この REPORT が返すのは「DAV:principal-property-search REPORT で **検索できる** プロパティ」
 * (§9.5 冒頭)。本サーバーは principal-property-search を実装していない(§9.4 は REQUIRED だが
 * 未実装 — docs/modeling/05 に gap として記録)。したがって「検索できるプロパティ」は
 * 現時点で存在せず、空集合が事実に一致する。DTD も `principal-search-property*` で 0 個を許す。
 *
 * 【なぜ Apple(ccs-calendarserver)のように displayname / calendar-user-address-set を
 *   並べなかったか】ccs の CalendarPrincipalCollectionResource.principalSearchPropertySet() は
 * この2つを返す(twistedcaldav/resource.py)。真似れば「それっぽい」応答になるが、
 * 続けて principal-property-search を投げられても本サーバーは応答できない = **宣言と実装の乖離**
 * になる。このリポジトリは supported-report-set の R-5a 是正・supported-calendar-component-set の
 * J-2 是正で「宣言 = 実際に受理できるもの」を明示的な規律にしてきたので、ここでも同じ側に倒す。
 * principal-property-search を実装したら、その時点で検索可能プロパティをここへ追加する
 * (実装と広告を同じコミットで動かせるよう、意図的に1関数に閉じてある)。
 *
 * 【空集合のリスクとして認識していること】クライアントが結果をキャッシュする場合
 * (iOS は CalDAVMobileAccountSearchPropertySetKey_CoreDAV に保存する挙動が観測されている)、
 * 後から検索可能プロパティを増やしてもアカウント再設定まで反映されない可能性がある。
 * ただし本サーバーはスケジューリング(schedule-inbox/outbox)を広告しておらず、
 * 「参加者を検索する UI」を必要とする経路がそもそも無いので、実害は無いと判断した。
 */
export function principalSearchPropertySetXml(): string {
	// 自己終端タグで返す(`<d:principal-search-property-set/>`)。開始+終了タグの空要素と
	// XML 的には等価だが、意図が「子が0個」であることを一目で示せるこちらを選ぶ。
	return `<?xml version="1.0" encoding="UTF-8"?><d:principal-search-property-set xmlns:d="DAV:"/>`;
}

// =============================================================================
// calendar-query REPORT(RFC 4791 §7.8/§9.7〜9.9)フィルタの解析(G-3)
// =============================================================================
//
// 【対応するもの(確定設計メモ「④ スコープ」の Yes。J-4 で VJOURNAL+time-range も解禁)】
//   - VCALENDAR 直下の単一 comp-filter(VEVENT / VTODO / VJOURNAL)
//   - その中の time-range(start/end。§9.9 の UTC 形式 YYYYMMDDTHHMMSSZ。片側欠落は
//     0 / OCCURRENCE_INDEX_MAX へ正規化)。VJOURNAL も含め全 componentName で対応
//     (J-1 では VJOURNAL+time-range を暫定 unsupported にしていたが、J-4 で
//     application 層(vjournalOverlapsRange)に §9.9 VJOURNAL 実効値表 + RRULE 展開を
//     実装したため解禁した)。
//   - トップレベル(filter の外)の CALDAV:timezone(§9.8。VTIMEZONE 1個の PCDATA)
// 【対応しないもの(No。検出したら unsupported=true)】
//   prop-filter / param-filter / ネスト comp-filter / CALDAV:expand / limit-recurrence-set。
//   呼び出し側(index.ts)は unsupported=true を 403 CALDAV:supported-filter
//   (§7.8 precondition)へ写像する。
// =============================================================================

export interface CalendarQueryFilter {
	/** comp-filter で指定されたトップレベルコンポーネント名。unsupported=true のときは
	 *  判定不能な場合の便宜上の既定値("VEVENT")が入るので、呼び出し側は unsupported を
	 *  先にチェックしてから使うこと。 */
	componentName: "VEVENT" | "VTODO" | "VJOURNAL";
	/** time-range が無ければ undefined(comp-filter のみ = 絞り込み無し)。 */
	timeRange?: { startMillis: number; endMillis: number };
	/** CALDAV:timezone で解決された IANA ゾーン名。指定が無い/解決できなければ undefined
	 *  (呼び出し側が §7.3 の既定である UTC にフォールバックする)。 */
	floatingTimeZone?: string;
	/** prop-filter 等、この G-3 実装が対応しない要素を検出したら true。 */
	unsupported: boolean;
}

/** §9.9 の time-range 属性値(常に UTC 形式 YYYYMMDDTHHMMSSZ)をエポックミリ秒へ。 */
const TIME_RANGE_UTC_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
function parseTimeRangeAttr(v: string): number {
	const m = v.match(TIME_RANGE_UTC_RE);
	if (!m) throw new Error(`invalid CALDAV:time-range attribute (expected YYYYMMDDTHHMMSSZ): ${v}`);
	const [, y, mo, d, h, mi, s] = m;
	return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** <C:timezone>...</C:timezone> の PCDATA は CDATA か実体参照のどちらかで ICS を包む(§9.8 Note)。 */
function unescapeEmbeddedIcs(raw: string): string {
	const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
	if (cdata) return cdata[1];
	return unescapeXml(raw);
}

/**
 * XML 要素をタグバランスを考慮して1個取り出す。
 *
 * 【なぜ必要か(素朴な非貪欲正規表現の落とし穴)】
 * comp-filter は同名要素が入れ子になる(`<comp-filter name="VCALENDAR"><comp-filter
 * name="VEVENT">...</comp-filter></comp-filter>`)。素朴に `<comp-filter ...>([\s\S]*?)
 * <\/comp-filter>` のような非貪欲マッチをすると、外側の開始タグに対して「最初に見つかった
 * 閉じタグ」(=内側 VEVENT の閉じタグ)を対応させてしまい、外側の中身を正しく切り出せない
 * (2026-07-11 のテスト失敗で実際に踏んだ罠)。正規表現に再帰は無いので、開始/終了タグを
 * 順番に走査して深さを数える簡易パーサーで対応する。
 *
 * @param xml 検索対象。
 * @param localName タグのローカル名(prefix なし。例 "comp-filter")。
 * @param fromIndex この位置以降で最初に見つかった開始タグを対象にする。
 * @returns 見つからなければ undefined。見つかれば
 *   - attrs: 開始タグの属性部分(生文字列。name="..." 等をさらに正規表現で拾う)
 *   - inner: 開始タグ〜対応する終了タグの間(自己終端タグなら空文字列)
 *   - afterIndex: 終了タグ直後の index(次の探索の再開位置に使える)
 */
function extractBalancedElement(
	xml: string,
	localName: string,
	fromIndex = 0,
): { attrs: string; inner: string; afterIndex: number } | undefined {
	// group1: "/" があれば閉じタグ。group2: 属性部分。group3: 自己終端の "/"(あれば)。
	const tagRe = new RegExp(`<(/?)(?:[^:>\\s/]+:)?${localName}\\b([^>]*?)(/?)>`, "gi");
	tagRe.lastIndex = fromIndex;
	const open = tagRe.exec(xml);
	if (!open || open[1] === "/") return undefined; // 見つからない、または先に閉じタグが来た。
	if (open[3] === "/") {
		// 自己終端タグ(<comp-filter .../>)。中身は無い。
		return { attrs: open[2], inner: "", afterIndex: tagRe.lastIndex };
	}
	let depth = 1;
	const innerStart = tagRe.lastIndex;
	let m: RegExpExecArray | null = tagRe.exec(xml);
	for (; m !== null; m = tagRe.exec(xml)) {
		const isClose = m[1] === "/";
		const isSelfClose = !isClose && m[3] === "/";
		if (isSelfClose) continue; // 深さに影響しない同名の自己終端子要素。
		depth += isClose ? -1 : 1;
		if (depth === 0) {
			return { attrs: open[2], inner: xml.slice(innerStart, m.index), afterIndex: tagRe.lastIndex };
		}
	}
	return undefined; // 対応する終了タグが見つからない(壊れた XML)。
}

export function parseCalendarQueryFilter(body: string): CalendarQueryFilter {
	const unsupported = (componentName: "VEVENT" | "VTODO" | "VJOURNAL" = "VEVENT"): CalendarQueryFilter => ({
		componentName,
		unsupported: true,
	});

	// CALDAV:expand / CALDAV:limit-recurrence-set はどこに現れても非対応(§9 の transformation 系)。
	if (/<(?:[^:>]+:)?(expand|limit-recurrence-set)\b/i.test(body)) return unsupported();

	const filterEl = extractBalancedElement(body, "filter");
	if (!filterEl) return unsupported(); // C:filter は calendar-query の必須要素(§9.7)。

	const vcalEl = extractBalancedElement(filterEl.inner, "comp-filter");
	if (!vcalEl || !/\bname=["']VCALENDAR["']/i.test(vcalEl.attrs)) return unsupported();
	const vcalBody = vcalEl.inner;

	// VCALENDAR 直下の単一 comp-filter(VEVENT/VTODO)。同じ階層に複数(VEVENT と VTODO を
	// 同時指定 等)あるのはこの実装のスコープ外なので non-nested の1個だけを対応とする
	// (2個目が見つかったら unsupported)。
	const compEl = extractBalancedElement(vcalBody, "comp-filter");
	if (!compEl) return unsupported();
	if (extractBalancedElement(vcalBody, "comp-filter", compEl.afterIndex) !== undefined) return unsupported();

	const nameAttr = compEl.attrs.match(/\bname=["']([\w-]+)["']/i)?.[1]?.toUpperCase();
	if (nameAttr !== "VEVENT" && nameAttr !== "VTODO" && nameAttr !== "VJOURNAL") return unsupported(); // VFREEBUSY 等、対応外。
	const componentName = nameAttr;
	const compBody = compEl.inner;

	// prop-filter / param-filter / ネスト comp-filter(§9 の落とし穴リストの No 側)。
	// ここは「1個でも含まれているか」の検出だけなので、バランス走査までは不要
	// (`(?!\/)` で閉じタグの誤カウントだけ避ければ十分)。
	if (/<(?!\/)(?:[^:>]+:)?(prop-filter|param-filter|comp-filter)\b/i.test(compBody)) return unsupported(componentName);

	const result: CalendarQueryFilter = { componentName, unsupported: false };

	const trMatch = compBody.match(/<(?:[^:>]+:)?time-range\b([^>]*?)\/?>/i);
	// J-4(2026-07-14): VJOURNAL + time-range は unsupported だった(J-1 の暫定処置)が、
	// application 層に §9.9 VJOURNAL 実効値表 + RRULE 展開(vjournalOverlapsRange)を実装した
	// ので解禁。ここでは VEVENT/VTODO と同じ time-range 属性パースを共通に通すだけでよい
	// (VJOURNAL 固有の判定はすべて application 層 CalendarQuery が担う。presentation 層は
	// 属性の構文解析だけに専念する層境界の原則どおり)。
	if (trMatch) {
		const attrs = trMatch[1];
		const startAttr = attrs.match(/\bstart=["']([^"']+)["']/i)?.[1];
		const endAttr = attrs.match(/\bend=["']([^"']+)["']/i)?.[1];
		try {
			result.timeRange = {
				startMillis: startAttr !== undefined ? parseTimeRangeAttr(startAttr) : 0,
				endMillis: endAttr !== undefined ? parseTimeRangeAttr(endAttr) : OCCURRENCE_INDEX_MAX,
			};
		} catch {
			// 壊れた time-range 属性は安全側(絞り込み不能)に倒し、supported-filter 違反として扱う。
			return unsupported(componentName);
		}
	}

	// CALDAV:timezone(filter の外、calendar-query 直下)。§9.8: VTIMEZONE を1個含む ICS。
	const tzMatch = body.match(/<(?:[^:>]+:)?timezone\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?timezone>/i);
	if (tzMatch) {
		try {
			const obj = ICalendarObject.fromComponent(parse(unescapeEmbeddedIcs(tzMatch[1])));
			const vtimezone = obj.timezones()[0];
			if (vtimezone?.tzid !== undefined) {
				result.floatingTimeZone = resolveTimeZoneId(vtimezone.tzid, vtimezone).ianaId;
			}
		} catch {
			// timezone 要素が壊れていても REPORT 全体を失敗させず §7.3 既定(UTC)へ黙って倒す
			// (これは resolveTimeZoneId 自体の「暗黙フォールバック禁止」方針とは別の話 — あちらは
			// 「解決できない TZID を勝手に UTC 化して間違った occurrence を返す」事故を防ぐためのもの。
			// ここは「クライアント指定のオプション要素が壊れているだけ」なので、既定へ倒しても
			// 「間違った時刻を正として返す」事故にはならない)。
		}
	}

	return result;
}

// =============================================================================
// free-busy-query REPORT(RFC 4791 §7.10/§9.11)フィルタの解析 + 応答シリアライズ(G-4)
// =============================================================================

/**
 * <C:free-busy-query> ボディから唯一の <C:time-range> を抜き出す(§9.11 の
 * `<!ELEMENT free-busy-query (time-range)>` = free-busy-query は time-range を
 * ちょうど1個含む)。属性の解釈(YYYYMMDDTHHMMSSZ、片側省略は 0 / OCCURRENCE_INDEX_MAX)は
 * parseCalendarQueryFilter の time-range 解析と完全に同じ規約(parseTimeRangeAttr を共有)。
 *
 * @returns free-busy-query 要素自体が無ければ null(呼び出し側 index.ts は「REPORT ボディが
 *   free-busy-query ではない」と判断してよい)。time-range が壊れている場合も安全側に倒して
 *   null を返す(parseCalendarQueryFilter が壊れた time-range を supported-filter 403 へ
 *   倒すのと同じ考え方だが、free-busy-query には対応する precondition 名が定義されていない
 *   ため、呼び出し側が「解析失敗」として扱えるよう null で統一する)。
 *
 * 【R-4: time-range はちょうど1個(§9.11 DTD `<!ELEMENT free-busy-query (time-range)>`)】
 * DTD の `(time-range)` は「子要素は time-range 1個のみ」という構造制約であり、`(time-range*)`
 * や `(time-range?)` ではない(0個や複数個を許す記法ではない)。旧実装は最初の time-range に
 * `.match()` するだけで、0個(要素が無い)は弾いていたが複数個は最初の1個を黙って採用していた
 * (末尾の余剰子要素も無視)。RFC の構造制約に忠実にするため、まず子要素の並びを
 * extractBalancedElement で1個ずつ走査してタグ名を数え、「time-range がちょうど1個・
 * それ以外の子要素が無い」ときだけ受理する。走査に extractBalancedElement を使うのは
 * comp-filter と同様 time-range 自身は入れ子構造を持たない自己終端要素だが、free-busy-query
 * の直下に想定外の要素(例: バグで comp-filter が紛れ込む等)が来た場合も「exactly one
 * time-range」という契約から外れたことを検出できるようにするため。
 */
export function parseFreeBusyQuery(body: string): { startMillis: number; endMillis: number } | null {
	const fbEl = extractBalancedElement(body, "free-busy-query");
	if (!fbEl) return null; // free-busy-query 要素自体が無い。

	// fbEl.inner の直下子要素を先頭から1個ずつ切り出し、"time-range" 以外が混ざっていないか・
	// time-range が複数無いかを数える。extractBalancedElement は「次に見つかった開始タグ」を
	// 対象にするので、タグ名を指定せず走査するために生の開始タグ探索を先に行う。
	const childTagRe = /<(?:[^:>\s/]+:)?([\w-]+)\b[^>]*?\/?>/g;
	let childCount = 0;
	let timeRangeCount = 0;
	let cursor = 0;
	while (cursor < fbEl.inner.length) {
		childTagRe.lastIndex = cursor;
		const tagMatch = childTagRe.exec(fbEl.inner);
		if (!tagMatch) break;
		const localName = tagMatch[1].toLowerCase();
		const el = extractBalancedElement(fbEl.inner, localName, tagMatch.index);
		if (!el) break; // 対応する終了タグが見つからない壊れた XML。下の exactly-one チェックで弾かれる。
		childCount += 1;
		if (localName === "time-range") timeRangeCount += 1;
		cursor = el.afterIndex;
	}
	if (childCount !== 1 || timeRangeCount !== 1) return null; // exactly one time-range 以外は拒否 → 呼び出し側の 400 経路へ。

	const trMatch = fbEl.inner.match(/<(?:[^:>]+:)?time-range\b([^>]*?)\/?>/i);
	if (!trMatch) return null; // 上のチェックで通っていれば通常ここには来ないが、保険として残す。

	const attrs = trMatch[1];
	const startAttr = attrs.match(/\bstart=["']([^"']+)["']/i)?.[1];
	const endAttr = attrs.match(/\bend=["']([^"']+)["']/i)?.[1];
	try {
		return {
			startMillis: startAttr !== undefined ? parseTimeRangeAttr(startAttr) : 0,
			endMillis: endAttr !== undefined ? parseTimeRangeAttr(endAttr) : OCCURRENCE_INDEX_MAX,
		};
	} catch {
		return null;
	}
}

/**
 * UTC エポックミリ秒 → §3.3.5 FORM #2(UTC DATE-TIME)の生値文字列 YYYYMMDDTHHMMSSZ。
 * domain/ical/values/cal-date-time.ts の formatCalDateTime は CalDateTime 値オブジェクトを
 * 要求するが、ここは応答シリアライズ専用の小さな変換(epoch → UTC 文字列)だけが要るので、
 * わざわざ CalDateTime を組み立てず Date の UTC ゲッターから直接組み立てる
 * (VFREEBUSY の DTSTAMP/DTSTART/DTEND/FREEBUSY はすべて UTC 形式 MUST。§3.6.4/§3.8.2.6)。
 */
function epochMillisToUtcIcs(millis: number): string {
	const d = new Date(millis);
	const pad2 = (n: number): string => n.toString().padStart(2, "0");
	const y = d.getUTCFullYear().toString().padStart(4, "0");
	return `${y}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/**
 * VFREEBUSY 応答本体(text/calendar)を組み立てる(RFC 4791 §7.10)。
 *
 * 【VCALENDAR > VFREEBUSY 1個、という契約】
 * §7.10: "a VFREEBUSY component with no FREEBUSY property MUST be returned" が空でも
 * VFREEBUSY 自体は必ず返す MUST を示している。よって intervals が空でも VFREEBUSY は作り、
 * FREEBUSY 行だけを省く(下のループが0回になるだけで自然にこの MUST を満たす)。
 *
 * 【DTSTAMP/UID】
 * DTSTAMP は §3.8.7.2 のとおり現在時刻の UTC(new Date() でよい — Workers ランタイムの
 * ワークフロー的な決定性制約はアプリコードには課されない)。UID は §3.8.4.7 で必須だが
 * free-busy-query の応答は「保存されるリソース」ではなく都度生成する使い捨て VFREEBUSY
 * なので、一意性の強い保証(UUID 等)までは不要と判断し、DTSTAMP と同じ時刻の
 * エポックミリ秒を使った `freebusy-<epoch>@<固定サフィックス>` で済ませる
 * (同一ミリ秒に複数リクエストが来ても実害はない = ただの識別子であって永続化キーではない)。
 *
 * 【DTSTART/DTEND = range】
 * §7.10.1 の応答例が DTSTART/DTEND に time-range の範囲をそのまま使っているのでそれに倣う
 * (VFREEBUSY 自体の「問い合わせ対象期間」を示す情報として自然)。
 *
 * 【FREEBUSY 行の PERIOD 形式】
 * 確定設計メモの指示どおり「開始/終了の explicit 形式」(START/END、DURATION 形式ではない)
 * で1区間1行にする。§3.8.2.6 のとおり FBTYPE パラメータを付ける。
 *
 * 【serialize への委譲】
 * Component ツリーを組み立てて domain/ical の serialize() にそのまま渡す。これにより
 * CRLF 終端・75 オクテット折り畳みは serializer.ts の既存実装をそのまま再利用でき、
 * この関数が独自に改行規則を持つ必要がない(iCalendar は CRLF 必須。CLAUDE.md 方針どおり
 * 既存の正しい実装を再利用する)。
 */
export function serializeFreeBusyResponse(
	intervals: readonly BusyInterval[],
	rangeStartMillis: number,
	rangeEndMillis: number,
): string {
	const nowMillis = Date.now();
	const freebusyProps: Property[] = [
		{ name: "DTSTAMP", parameters: [], value: epochMillisToUtcIcs(nowMillis) },
		// UID 生成方針は上のコメントを参照。永続化しない使い捨て応答なので厳密な一意性は求めない。
		{ name: "UID", parameters: [], value: `freebusy-${nowMillis}@caldav-freebusy-query` },
		{ name: "DTSTART", parameters: [], value: epochMillisToUtcIcs(rangeStartMillis) },
		{ name: "DTEND", parameters: [], value: epochMillisToUtcIcs(rangeEndMillis) },
	];
	for (const interval of intervals) {
		freebusyProps.push({
			name: "FREEBUSY",
			parameters: [{ name: "FBTYPE", values: [interval.type] }],
			// PERIOD の explicit 形式(START/END、§3.3.9)。両端 UTC の YYYYMMDDTHHMMSSZ。
			value: `${epochMillisToUtcIcs(interval.startMillis)}/${epochMillisToUtcIcs(interval.endMillis)}`,
		});
	}

	const vfreebusy: Component = { name: "VFREEBUSY", properties: freebusyProps, components: [] };
	const vcalendar: Component = {
		name: "VCALENDAR",
		properties: [
			{ name: "VERSION", parameters: [], value: "2.0" },
			{ name: "PRODID", parameters: [], value: "-//gigun-dev//caldav//EN" },
		],
		components: [vfreebusy],
	};
	return serialize(vcalendar);
}
