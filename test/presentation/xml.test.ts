import { describe, expect, it } from "bun:test";
import {
	multistatus,
	parseCalendarQueryFilter,
	parseCollectionProperties,
	parseHrefs,
	parsePropFilter,
	responseXml,
} from "../../src/presentation/dav/xml";

describe("DAV XML", () => {
	it("要求された未知プロパティを404 propstatへ列挙する", () => {
		const filter = parsePropFilter(`<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:unknown/></d:prop></d:propfind>`);
		const xml = multistatus(responseXml("/dav/", {
			resourcetype: "<d:resourcetype><d:collection/></d:resourcetype>",
		}, filter));
		expect(xml).toContain("HTTP/1.1 200 OK");
		expect(xml).toContain("<d:unknown/>");
		expect(xml).toContain("HTTP/1.1 404 Not Found");
	});

	it("prefixに依存せずhrefを抽出してXML entityを戻す", () => {
		expect(parseHrefs(`<x:href xmlns:x="DAV:">/a&amp;b.ics</x:href>`)).toEqual(["/a&b.ics"]);
	});

	it("Extended MKCOLの表示名・種別・Apple属性を読む", () => {
		const props = parseCollectionProperties(`<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>仕事 &amp; 私用</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><i:calendar-color symbolic-color="blue">#112233FF</i:calendar-color><i:calendar-order>4</i:calendar-order></d:prop></d:set></d:mkcol>`);
		expect(props).toEqual({ displayName: "仕事 & 私用", component: "VTODO", color: "#112233FF", order: 4 });
	});

	// =========================================================================
	// G-3: parseCalendarQueryFilter
	// =========================================================================
	describe("parseCalendarQueryFilter", () => {
		it("comp-filter + time-range を抜き出す(VEVENT)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<D:prop><D:getetag/><C:calendar-data/></D:prop>",
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VEVENT">',
				'<C:time-range start="20260101T000000Z" end="20260201T000000Z"/>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VEVENT");
			expect(filter.timeRange).toEqual({
				startMillis: Date.UTC(2026, 0, 1),
				endMillis: Date.UTC(2026, 1, 1),
			});
			expect(filter.floatingTimeZone).toBeUndefined();
		});

		it("time-range が無ければ comp-filter のみ(range=undefined)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VTODO"/>',
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VTODO");
			expect(filter.timeRange).toBeUndefined();
		});

		it("prop-filter があれば unsupported=true(§7.8 supported-filter 対象外)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VEVENT">',
				'<C:prop-filter name="UID"><C:text-match>abc</C:text-match></C:prop-filter>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(true);
		});

		it("ネストした comp-filter(VALARM 等)は unsupported=true", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VTODO">',
				'<C:comp-filter name="VALARM"><C:time-range start="20260106T100000Z"/></C:comp-filter>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			expect(parseCalendarQueryFilter(body).unsupported).toBe(true);
		});

		it("CALDAV:expand は unsupported=true", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				'<D:prop><C:calendar-data><C:expand start="20260101T000000Z" end="20260201T000000Z"/></C:calendar-data></D:prop>',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>',
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			expect(parseCalendarQueryFilter(body).unsupported).toBe(true);
		});

		it("CALDAV:timezone の VTIMEZONE を解決して floatingTimeZone に入れる", () => {
			const vtimezoneIcs = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTIMEZONE",
				"TZID:Asia/Tokyo",
				"BEGIN:STANDARD",
				"DTSTART:19700101T000000",
				"TZOFFSETFROM:+0900",
				"TZOFFSETTO:+0900",
				"END:STANDARD",
				"END:VTIMEZONE",
				"END:VCALENDAR",
			].join("\n");
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				`<C:timezone>${vtimezoneIcs}</C:timezone>`,
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>',
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.floatingTimeZone).toBe("Asia/Tokyo");
		});

		// =====================================================================
		// J-1: VJOURNAL の comp-filter 対応(time-range 無しのみ許可)
		// =====================================================================
		it("comp-filter VJOURNAL(time-range 無し)は unsupported=false で通す", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VJOURNAL"/>',
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VJOURNAL");
			expect(filter.timeRange).toBeUndefined();
		});

		it("comp-filter VJOURNAL + time-range は unsupported=true(反復展開は J-4 送り)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VJOURNAL">',
				'<C:time-range start="20260101T000000Z" end="20260201T000000Z"/>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			expect(parseCalendarQueryFilter(body).unsupported).toBe(true);
		});
	});
});
