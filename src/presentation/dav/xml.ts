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

export type PropFilter = Set<string> | "allprop";

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function unescapeXml(value: string): string {
	return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

export function parsePropFilter(body: string): PropFilter {
	if (!body.trim() || /<(?:[^:>]+:)?allprop\b/i.test(body)) return "allprop";
	const block = body.match(/<(?:[^:>]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?prop>/i)?.[1];
	if (!block) return "allprop";
	const result = new Set<string>();
	for (const match of block.matchAll(/<(?!\/)(?:[^:>\s]+:)?([\w-]+)\b/g)) {
		result.add(match[1].toLowerCase());
	}
	return result.size === 0 ? "allprop" : result;
}

function requested(filter: PropFilter, name: string): boolean {
	return filter === "allprop" || filter.has(name);
}

function propstat(props: string, status = "200 OK"): string {
	return `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;
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
	const missing = filter === "allprop" ? [] : [...filter].filter((name) => !known.includes(name));
	return `<d:response><d:href>${escapeXml(href)}</d:href>${ok ? propstat(ok) : ""}${
		missing.length ? propstat(missing.map((name) => `<d:${name}/>`).join(""), "404 Not Found") : ""
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

export function davError(name: string, detail?: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><d:error xmlns:d="DAV:" xmlns:c="${NS_CALDAV}"><c:${name}/>${detail ? `<d:responsedescription>${escapeXml(detail)}</d:responsedescription>` : ""}</d:error>`;
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
