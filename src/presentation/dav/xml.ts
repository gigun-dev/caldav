// =============================================================================
// WebDAV / CalDAV XML codec
// =============================================================================
// XML の知識は presentation 層だけに置く。入力側は iOS/一般クライアントが送る既知要素を
// 名前空間 prefix 非依存で抽出し、出力側は要求された property ごとに 200/404 propstat を返す。

import type { CalendarCollection, CalendarObjectResource } from "../../domain/caldav";

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
