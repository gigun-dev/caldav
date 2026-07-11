// =============================================================================
// WebDAV / CalDAV XML codec
// =============================================================================
// XML の知識は presentation 層だけに置く。入力側は iOS/一般クライアントが送る既知要素を
// 名前空間 prefix 非依存で抽出し、出力側は要求された property ごとに 200/404 propstat を返す。

import type { CalendarCollection, CalendarObjectResource } from "../../domain/caldav";
// G-3: calendar-query REPORT の <C:timezone> 要素(§9.8)は VTIMEZONE を丸ごと1個埋め込む
// PCDATA。parse/ICalendarObject/resolveTimeZoneId を使って TZID → IANA 名へ解決する
// ここだけが presentation 層で domain/ical の parse を直接呼ぶ箇所(XML 内に埋め込まれた
// もう1つの ICS を読む必要があるための例外的な依存。domain → presentation の逆方向ではない
// ので層境界は破っていない)。OCCURRENCE_INDEX_MAX は time-range の end 属性省略時の
// 既定上限(§9.9: 片側欠落は「無限大」の意)に使う — domain/ical/recurrence の
// occurrence-bounds.ts と同じ定数を共有することで、PUT 側の索引の last キャップと
// REPORT 側のデフォルト窓の上限が食い違わないようにする。
import { parse, ICalendarObject, resolveTimeZoneId } from "../../domain/ical";
import { OCCURRENCE_INDEX_MAX } from "../../domain/ical/recurrence";

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
	const ok = known.filter((name) => requested(filter, name)).map((name) => props[name]).join("");
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
	const components = (collection.supportedComponents ?? ["VEVENT", "VTODO"])
		.map((name) => `<c:comp name="${name}"/>`).join("");
	const props: Record<string, string> = {
		displayname: `<d:displayname>${escapeXml(collection.displayName)}</d:displayname>`,
		resourcetype: "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
		"supported-calendar-component-set": `<c:supported-calendar-component-set>${components}</c:supported-calendar-component-set>`,
		"supported-report-set": "<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>",
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

export function parseCollectionProperties(body: string): {
	displayName?: string; component?: "VEVENT" | "VTODO"; color?: string; order?: number;
} {
	const componentRaw = body.match(/<(?:[^:>]+:)?comp\b[^>]*\bname=["'](VEVENT|VTODO)["']/i)?.[1]?.toUpperCase();
	const orderRaw = textElement(body, "calendar-order");
	return {
		displayName: textElement(body, "displayname"),
		component: componentRaw === "VEVENT" || componentRaw === "VTODO" ? componentRaw : undefined,
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
// 【対応するもの(確定設計メモ「④ スコープ」の Yes)】
//   - VCALENDAR 直下の単一 comp-filter(VEVENT または VTODO)
//   - その中の time-range(start/end。§9.9 の UTC 形式 YYYYMMDDTHHMMSSZ。片側欠落は
//     0 / OCCURRENCE_INDEX_MAX へ正規化)
//   - トップレベル(filter の外)の CALDAV:timezone(§9.8。VTIMEZONE 1個の PCDATA)
// 【対応しないもの(No。検出したら unsupported=true)】
//   prop-filter / param-filter / ネスト comp-filter / VJOURNAL / CALDAV:expand /
//   limit-recurrence-set。呼び出し側(index.ts)は unsupported=true を
//   403 CALDAV:supported-filter(§7.8 precondition)へ写像する。
// =============================================================================

export interface CalendarQueryFilter {
	/** comp-filter で指定されたトップレベルコンポーネント名。unsupported=true のときは
	 *  判定不能な場合の便宜上の既定値("VEVENT")が入るので、呼び出し側は unsupported を
	 *  先にチェックしてから使うこと。 */
	componentName: "VEVENT" | "VTODO";
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
	const unsupported = (componentName: "VEVENT" | "VTODO" = "VEVENT"): CalendarQueryFilter => ({ componentName, unsupported: true });

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
	if (nameAttr !== "VEVENT" && nameAttr !== "VTODO") return unsupported(); // VJOURNAL 等、対応外。
	const componentName = nameAttr;
	const compBody = compEl.inner;

	// prop-filter / param-filter / ネスト comp-filter(§9 の落とし穴リストの No 側)。
	// ここは「1個でも含まれているか」の検出だけなので、バランス走査までは不要
	// (`(?!\/)` で閉じタグの誤カウントだけ避ければ十分)。
	if (/<(?!\/)(?:[^:>]+:)?(prop-filter|param-filter|comp-filter)\b/i.test(compBody)) return unsupported(componentName);

	const result: CalendarQueryFilter = { componentName, unsupported: false };

	const trMatch = compBody.match(/<(?:[^:>]+:)?time-range\b([^>]*?)\/?>/i);
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
