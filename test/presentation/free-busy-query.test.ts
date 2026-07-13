// =============================================================================
// presentation/dav/xml — parseFreeBusyQuery / serializeFreeBusyResponse テスト(G-4)
// =============================================================================
import { describe, expect, it } from "bun:test";
import { parseFreeBusyQuery, serializeFreeBusyResponse } from "../../src/presentation/dav/xml";
import type { BusyInterval } from "../../src/domain/ical/freebusy";

describe("parseFreeBusyQuery", () => {
	it("time-range の start/end を抜き出す", () => {
		const body = [
			'<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">',
			'<C:time-range start="20060104T140000Z" end="20060105T220000Z"/>',
			"</C:free-busy-query>",
		].join("");
		expect(parseFreeBusyQuery(body)).toEqual({
			startMillis: Date.UTC(2006, 0, 4, 14, 0, 0),
			endMillis: Date.UTC(2006, 0, 5, 22, 0, 0),
		});
	});

	it("start/end 省略時は 0 / OCCURRENCE_INDEX_MAX へ正規化する(parseCalendarQueryFilter と同じ規約)", () => {
		const body = [
			'<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">',
			"<C:time-range/>",
			"</C:free-busy-query>",
		].join("");
		const result = parseFreeBusyQuery(body);
		expect(result).not.toBeNull();
		expect(result!.startMillis).toBe(0);
		expect(result!.endMillis).toBeGreaterThanOrEqual(Date.UTC(2100, 0, 1)); // OCCURRENCE_INDEX_MAX は遠い未来
	});

	it("free-busy-query 要素が無ければ null", () => {
		const body = '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"></C:calendar-query>';
		expect(parseFreeBusyQuery(body)).toBeNull();
	});

	it("time-range 要素が無ければ null(§9.11 の必須要素違反)", () => {
		const body = '<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"></C:free-busy-query>';
		expect(parseFreeBusyQuery(body)).toBeNull();
	});

	// R-4: §9.11 の DTD `<!ELEMENT free-busy-query (time-range)>` は time-range が
	// ちょうど1個であることを要求する。旧実装は最初の1個だけ拾って2個目以降を黙認していた。
	it("time-range が複数あれば null(§9.11: ちょうど1個の構造制約違反)", () => {
		const body = [
			'<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">',
			'<C:time-range start="20060104T140000Z" end="20060105T220000Z"/>',
			'<C:time-range start="20060106T140000Z" end="20060107T220000Z"/>',
			"</C:free-busy-query>",
		].join("");
		expect(parseFreeBusyQuery(body)).toBeNull();
	});

	// R-4: time-range 以外の余剰子要素が紛れ込んでいる場合も「time-range のみを含む」という
	// DTD 制約に反するので拒否する(壊れた/想定外のリクエストを安全側に倒す)。
	it("time-range 以外の余剰子要素があれば null", () => {
		const body = [
			'<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">',
			'<C:time-range start="20060104T140000Z" end="20060105T220000Z"/>',
			"<C:comp-filter/>",
			"</C:free-busy-query>",
		].join("");
		expect(parseFreeBusyQuery(body)).toBeNull();
	});
});

describe("serializeFreeBusyResponse", () => {
	it("VCALENDAR > VFREEBUSY 1個 + FREEBUSY 行を出す", () => {
		const intervals: BusyInterval[] = [
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY" },
			{ startMillis: Date.UTC(2026, 0, 6, 11, 0, 0), endMillis: Date.UTC(2026, 0, 6, 12, 0, 0), type: "BUSY-TENTATIVE" },
		];
		const ics = serializeFreeBusyResponse(intervals, Date.UTC(2026, 0, 6, 0, 0, 0), Date.UTC(2026, 0, 7, 0, 0, 0));

		expect(ics).toContain("BEGIN:VCALENDAR\r\n");
		// VFREEBUSY はちょうど1個。
		expect(ics.match(/BEGIN:VFREEBUSY/g)).toHaveLength(1);
		expect(ics).toContain("DTSTART:20260106T000000Z\r\n");
		expect(ics).toContain("DTEND:20260107T000000Z\r\n");
		expect(ics).toContain("FREEBUSY;FBTYPE=BUSY:20260106T090000Z/20260106T100000Z\r\n");
		expect(ics).toContain("FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260106T110000Z/20260106T120000Z\r\n");
		// DTSTAMP と UID は必須(§3.6.4)。中身までは問わないが存在は確認する。
		expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z\r\n/);
		expect(ics).toMatch(/UID:.+\r\n/);
	});

	it("intervals が空なら FREEBUSY 行を出さない(§7.10 MUST: VFREEBUSY 自体は返す)", () => {
		const ics = serializeFreeBusyResponse([], Date.UTC(2026, 0, 6, 0, 0, 0), Date.UTC(2026, 0, 7, 0, 0, 0));
		expect(ics.match(/BEGIN:VFREEBUSY/g)).toHaveLength(1);
		// "VFREEBUSY" 自体には "FREEBUSY" が部分文字列として含まれるので、行頭の
		// FREEBUSY プロパティ(改行直後に FREEBUSY: または FREEBUSY; で始まる行)が
		// 無いことを確認する。
		expect(ics).not.toMatch(/\r\nFREEBUSY[:;]/);
	});
});
