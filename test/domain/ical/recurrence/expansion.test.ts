// =============================================================================
// RecurrenceExpansion(G-2)のテスト
// =============================================================================
// 実 ICS 断片を parse() で読み込み、infrastructure の ical.js アダプタ
// (IcaljsRRuleIterator)を注入して検証する。テストは層境界(dependency-cruiser)の
// 対象外(depcruise src のみを見るので test/ は対象外。Makefile の boundaries スクリプト
// コメント参照)なので、domain のテストから infrastructure を import してよい。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { parse } from "../../../../src/domain/ical";
import { ICalendarObject } from "../../../../src/domain/ical/semantics";
import { expandRecurrenceSet } from "../../../../src/domain/ical/recurrence";
import type { VEvent } from "../../../../src/domain/ical/semantics";
import { IcaljsRRuleIterator } from "../../../../src/infrastructure/recurrence/icaljs-rrule-iterator";

const iterator = new IcaljsRRuleIterator();

// 恒等 zoneOf(テストでは tzid にそのまま IANA 名を入れるので素通し)。
// 実運用の resolveTimeZoneId チェーンは timezone/tz-resolution.test.ts で別途検証済み。
const idZone = (t: string): string => t;

/** ICS 文字列(VCALENDAR 全体)から最初の VEVENT 群(master + overrides)を取り出す。 */
function loadEvents(ics: string): VEvent[] {
	return ICalendarObject.fromComponent(parse(ics)).events();
}

/** 1マスター + オーバーライド無しの単純なケース向けヘルパー。 */
function loadMaster(ics: string): VEvent {
	const events = loadEvents(ics);
	// RECURRENCE-ID を持たないものがマスター。
	const master = events.find((e) => e.recurrenceId === undefined);
	if (master === undefined) throw new Error("test fixture has no master VEVENT");
	return master;
}

const HUGE_RANGE = { startMillis: Date.UTC(2000, 0, 1), endMillis: Date.UTC(2100, 0, 1) };

describe("FREQ=WEEKLY + COUNT", () => {
	test("COUNT=3 で3件、間隔1週間", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:weekly-count",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z", // 2026-01-06 は火曜
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=WEEKLY;COUNT=3",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences, limitHit } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(limitHit).toBe(false);
		expect(occurrences).toHaveLength(3);
		expect(occurrences.map((o) => o.startMillis)).toEqual([
			Date.UTC(2026, 0, 6, 9, 0, 0),
			Date.UTC(2026, 0, 13, 9, 0, 0),
			Date.UTC(2026, 0, 20, 9, 0, 0),
		]);
		expect(occurrences.map((o) => o.endMillis)).toEqual([
			Date.UTC(2026, 0, 6, 10, 0, 0),
			Date.UTC(2026, 0, 13, 10, 0, 0),
			Date.UTC(2026, 0, 20, 10, 0, 0),
		]);
		for (const o of occurrences) expect(o.source).toBe("master");
	});
});

describe("FREQ=DAILY + UNTIL(inclusive・epoch厳密打ち切り)", () => {
	test("UNTIL ちょうどの回は含み、その先は打ち切る", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:daily-until",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"DTEND:20260101T010000Z",
			"RRULE:FREQ=DAILY;UNTIL=20260103T000000Z", // 01, 02, 03 の3回だけ(04は超過)
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(3);
		expect(occurrences[2]!.startMillis).toBe(Date.UTC(2026, 0, 3, 0, 0, 0)); // UNTIL 自身を含む
	});
});

describe("EXDATE による除外", () => {
	test("EXDATE と epoch 一致する回が除かれる", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:daily-exdate",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"DTEND:20260101T010000Z",
			"RRULE:FREQ=DAILY;COUNT=5",
			"EXDATE:20260103T000000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(4);
		expect(occurrences.map((o) => o.startMillis)).not.toContain(Date.UTC(2026, 0, 3, 0, 0, 0));
	});
});

describe("RDATE による追加(DATE-TIME と PERIOD)", () => {
	test("RDATE;VALUE=DATE-TIME で単発イベントに1回追加", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:rdate-dt",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"RDATE:20260105T090000Z", // マスターと同じ1時間の長さが適用されるはず
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		// マスター自身は RRULE も RDATE も…あるが、item10 は「RRULE も RDATE も無い」場合のみの
		// 特別扱い。RDATE がある以上、マスターの回も通常の展開ロジックで1件、RDATE 追加分で
		// 1件の計2件になる。
		expect(occurrences).toHaveLength(2);
		expect(occurrences.map((o) => o.startMillis)).toEqual([
			Date.UTC(2026, 0, 1, 9, 0, 0),
			Date.UTC(2026, 0, 5, 9, 0, 0),
		]);
		expect(occurrences[1]!.endMillis).toBe(Date.UTC(2026, 0, 5, 10, 0, 0)); // マスターと同じ1時間
	});

	test("RDATE;VALUE=PERIOD は明示された start/end をそのまま使う", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:rdate-period",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"RDATE;VALUE=PERIOD:20260110T140000Z/20260110T163000Z", // マスターと違う2.5時間
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(2);
		const periodOcc = occurrences[1]!;
		expect(periodOcc.startMillis).toBe(Date.UTC(2026, 0, 10, 14, 0, 0));
		expect(periodOcc.endMillis).toBe(Date.UTC(2026, 0, 10, 16, 30, 0));
	});
});

describe("RECURRENCE-ID オーバーライド", () => {
	test("時刻変更が反映され、recurrenceId は master 時刻のまま", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:override-uid",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"RRULE:FREQ=DAILY;COUNT=3",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"UID:override-uid",
			"DTSTAMP:20260101T000000Z",
			"RECURRENCE-ID:20260102T090000Z", // 2回目のマスター時刻を指す
			"DTSTART:20260102T110000Z", // 11:00 に変更
			"DTEND:20260102T113000Z",
			"SUMMARY:Rescheduled",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const events = loadEvents(ics);
		const master = events.find((e) => e.recurrenceId === undefined)!;
		const overrides = events.filter((e) => e.recurrenceId !== undefined);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides, range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(3);
		const overridden = occurrences[1]!;
		expect(overridden.source).toBe("override");
		expect(overridden.startMillis).toBe(Date.UTC(2026, 0, 2, 11, 0, 0));
		expect(overridden.endMillis).toBe(Date.UTC(2026, 0, 2, 11, 30, 0));
		// recurrenceId は master の本来の時刻(2026-01-02 09:00Z)のまま。
		const rid = overridden.recurrenceId;
		if (!("kind" in rid)) throw new Error("expected CalDateTime");
		expect(rid.kind).toBe("utc");
		expect(rid.year).toBe(2026);
		expect(rid.month).toBe(1);
		expect(rid.day).toBe(2);
		expect(rid.hour).toBe(9);
	});
});

describe("DST 跨ぎ: America/New_York の FREQ=DAILY(TZID 付き)", () => {
	test("壁時計 09:00 を維持し、EST/EDT の切り替わりで epoch が変わる", () => {
		// 2026-03-08 が America/New_York の DST 開始(実測は tz-resolution.test.ts で別途固定)。
		// 3/7(EST, UTC-5)と 3/9(EDT, UTC-4)を跨ぐ3日間で検証する。
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:dst-daily",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;TZID=America/New_York:20260307T090000",
			"DTEND;TZID=America/New_York:20260307T100000",
			"RRULE:FREQ=DAILY;COUNT=3",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		// zoneOf は本テストでは resolver を介さず、実際に使われる TZID をそのまま IANA 名として
		// 素通しする(Intl がそのまま Asia/Tokyo 等と同様に解決できる)。
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(3);
		// 壁時計は常に 09:00 America/New_York のまま。
		for (const o of occurrences) {
			const rid = o.recurrenceId;
			if (!("kind" in rid)) throw new Error("expected CalDateTime");
			expect(rid.hour).toBe(9);
			expect(rid.minute).toBe(0);
		}
		// 3/7 は EST(UTC-5)= 14:00Z、3/9 は EDT(UTC-4)= 13:00Z(3/8 に切り替わる)。
		expect(occurrences[0]!.startMillis).toBe(Date.UTC(2026, 2, 7, 14, 0, 0));
		expect(occurrences[2]!.startMillis).toBe(Date.UTC(2026, 2, 9, 13, 0, 0));
	});
});

describe("終日(DATE)反復の +P1D nominal", () => {
	test("DTEND 省略の終日 RRULE は各回 +P1D 継続", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:allday-daily",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260301",
			"RRULE:FREQ=DAILY;COUNT=2",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(2);
		// floatingTimeZone 既定 UTC。DATE の現地 00:00 = UTC 00:00。
		expect(occurrences[0]!.startMillis).toBe(Date.UTC(2026, 2, 1, 0, 0, 0));
		expect(occurrences[0]!.endMillis).toBe(Date.UTC(2026, 2, 2, 0, 0, 0)); // +P1D
		expect(occurrences[1]!.startMillis).toBe(Date.UTC(2026, 2, 2, 0, 0, 0));
		expect(occurrences[1]!.endMillis).toBe(Date.UTC(2026, 2, 3, 0, 0, 0));
	});
});

describe("maxOccurrences で limitHit=true", () => {
	test("無限 RRULE(COUNT も UNTIL も無し)を予算で打ち切る", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:infinite-daily",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"DTEND:20260101T010000Z",
			"RRULE:FREQ=DAILY",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences, limitHit } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 5 },
		);
		expect(limitHit).toBe(true);
		expect(occurrences).toHaveLength(5);
	});
});

describe("range 開始前から続く長時間 occurrence が拾える", () => {
	test("開始が range 前、終了が range 内のイベントも含まれる", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:long-event",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"DTEND:20260110T000000Z", // 9日間の長時間単発イベント
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		// range は 1/5〜1/6 の1日だけ。イベント開始(1/1)は range より前だが、
		// 終了(1/10)は range よりずっと後なので overlap する。
		const range = { startMillis: Date.UTC(2026, 0, 5), endMillis: Date.UTC(2026, 0, 6) };
		const { occurrences } = expandRecurrenceSet(iterator, { master, overrides: [], range }, { zoneOf: idZone, maxOccurrences: 10 });
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]!.startMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(occurrences[0]!.endMillis).toBe(Date.UTC(2026, 0, 10, 0, 0, 0));
	});
});

describe("I9: DATE dtstart + BYHOUR が無視される", () => {
	test("BYHOUR を持つ終日 RRULE でも occurrence は現地 00:00 のまま", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//test//test//EN",
			"BEGIN:VEVENT",
			"UID:allday-byhour",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260301",
			// I9: DATE dtstart には BYHOUR は無意味(§3.3.10「無視 MUST」)。無視されれば
			// 通常の FREQ=DAILY と同じ結果になるはず。
			"RRULE:FREQ=DAILY;COUNT=2;BYHOUR=15",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\n");
		const master = loadMaster(ics);
		const { occurrences } = expandRecurrenceSet(
			iterator,
			{ master, overrides: [], range: HUGE_RANGE },
			{ zoneOf: idZone, maxOccurrences: 1000 },
		);
		expect(occurrences).toHaveLength(2);
		expect(occurrences[0]!.startMillis).toBe(Date.UTC(2026, 2, 1, 0, 0, 0));
		expect(occurrences[1]!.startMillis).toBe(Date.UTC(2026, 2, 2, 0, 0, 0));
	});
});
