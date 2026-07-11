// =============================================================================
// domain/ical/freebusy — deriveFreeBusyType / coalesceBusyIntervals テスト(G-4)
// =============================================================================
// RFC 4791 §7.10 のテーブルどおりに導出されるかを VEvent レンズ経由で確認する
// (レンズは Component を独自構造へ変換しないので、実際に ICS 断片を parse して確かめる)。
import { describe, expect, test } from "bun:test";
import { parse } from "../../../../src/domain/ical";
import { ICalendarObject } from "../../../../src/domain/ical/semantics";
import { deriveFreeBusyType, coalesceBusyIntervals, type BusyInterval } from "../../../../src/domain/ical/freebusy";
import type { VEvent } from "../../../../src/domain/ical/semantics";

// 最小限の VEVENT を組み立てて VEvent レンズにする。TRANSP/STATUS 行は呼び出し側が渡す
// (空文字なら省略)。
function makeEvent(extraLines: string): VEvent {
	const ics = [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		"UID:test",
		"DTSTAMP:20260101T000000Z",
		"DTSTART:20260106T090000Z",
		"DTEND:20260106T100000Z",
		...(extraLines ? [extraLines] : []),
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
	return ICalendarObject.fromComponent(parse(ics)).events()[0]!;
}

describe("deriveFreeBusyType", () => {
	test("OPAQUE + STATUS:CONFIRMED → BUSY", () => {
		expect(deriveFreeBusyType(makeEvent("TRANSP:OPAQUE\r\nSTATUS:CONFIRMED"))).toBe("BUSY");
	});

	test("TRANSP=TRANSPARENT → null(FREE)", () => {
		expect(deriveFreeBusyType(makeEvent("TRANSP:TRANSPARENT"))).toBeNull();
	});

	test("STATUS=CANCELLED(OPAQUE)→ null(FREE)", () => {
		expect(deriveFreeBusyType(makeEvent("STATUS:CANCELLED"))).toBeNull();
	});

	test("STATUS=TENTATIVE → BUSY-TENTATIVE", () => {
		expect(deriveFreeBusyType(makeEvent("STATUS:TENTATIVE"))).toBe("BUSY-TENTATIVE");
	});

	test("TRANSP/STATUS どちらも未指定 → 既定 OPAQUE + CONFIRMED 相当で BUSY", () => {
		expect(deriveFreeBusyType(makeEvent(""))).toBe("BUSY");
	});

	test("x-name STATUS(未知の値)は当面 BUSY にまとめる", () => {
		expect(deriveFreeBusyType(makeEvent("STATUS:X-MY-CUSTOM"))).toBe("BUSY");
	});
});

describe("coalesceBusyIntervals", () => {
	test("同一 type の隣接区間(隙間ゼロ)はマージされる", () => {
		const intervals: BusyInterval[] = [
			{ startMillis: 1000, endMillis: 2000, type: "BUSY" },
			{ startMillis: 2000, endMillis: 3000, type: "BUSY" },
		];
		expect(coalesceBusyIntervals(intervals)).toEqual([
			{ startMillis: 1000, endMillis: 3000, type: "BUSY" },
		]);
	});

	test("同一 type の重複区間はマージされる", () => {
		const intervals: BusyInterval[] = [
			{ startMillis: 1000, endMillis: 2500, type: "BUSY" },
			{ startMillis: 2000, endMillis: 3000, type: "BUSY" },
		];
		expect(coalesceBusyIntervals(intervals)).toEqual([
			{ startMillis: 1000, endMillis: 3000, type: "BUSY" },
		]);
	});

	test("異なる type は重ならせたままにする(マージしない)", () => {
		const intervals: BusyInterval[] = [
			{ startMillis: 1000, endMillis: 3000, type: "BUSY" },
			{ startMillis: 1500, endMillis: 2500, type: "BUSY-TENTATIVE" },
		];
		const result = coalesceBusyIntervals(intervals);
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ startMillis: 1000, endMillis: 3000, type: "BUSY" });
		expect(result).toContainEqual({ startMillis: 1500, endMillis: 2500, type: "BUSY-TENTATIVE" });
	});

	test("離れた同一 type の区間はマージされず、開始時刻昇順で返る", () => {
		const intervals: BusyInterval[] = [
			{ startMillis: 5000, endMillis: 6000, type: "BUSY" },
			{ startMillis: 1000, endMillis: 2000, type: "BUSY" },
		];
		expect(coalesceBusyIntervals(intervals)).toEqual([
			{ startMillis: 1000, endMillis: 2000, type: "BUSY" },
			{ startMillis: 5000, endMillis: 6000, type: "BUSY" },
		]);
	});
});
