// =============================================================================
// RFC 5545 §3.3 値型コーデック群のテスト
// =============================================================================
//
// values/ 層は「Property.value の生文字列」を必要なときだけ型付き値に持ち上げる
// レンズ。構造層(parse/serialize)のロスレス保持とは別に、ここでは各値型の
// parse↔format の対称性と、不変条件違反を確実に拒否することを確認する。
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
	InvalidValueError,
	compareUtc,
	formatCalAddress,
	formatCalDate,
	formatCalDateTime,
	formatDurationValue,
	formatPeriodValue,
	formatRecurrenceRule,
	formatTextValue,
	formatUtcOffset,
	parseCalAddress,
	parseCalDate,
	parseCalDateTime,
	parseDurationValue,
	parsePeriodValue,
	parseRecurrenceRule,
	parseTextValue,
	parseUtcOffset,
	toEpochMillis,
} from "../../../../src/domain/ical/values";

function expectInvalid(fn: () => unknown): void {
	expect(fn).toThrow(InvalidValueError);
}

describe("CalDate(§3.3.4 DATE)", () => {
	test("YYYYMMDD を parse↔format できる", () => {
		const date = parseCalDate("20260708");
		expect(date).toEqual({ year: 2026, month: 7, day: 8 });
		expect(formatCalDate(date)).toBe("20260708");
	});

	test("実在しない日付は拒否する", () => {
		expectInvalid(() => parseCalDate("20260230"));
		expectInvalid(() => parseCalDate("20261301"));
	});
});

describe("CalDateTime(§3.3.5 DATE-TIME)", () => {
	test("floating / utc / zoned の3形態を判別する", () => {
		expect(parseCalDateTime("20260708T090000")).toMatchObject({ kind: "floating" });
		expect(parseCalDateTime("20260708T000000Z")).toMatchObject({ kind: "utc" });
		expect(parseCalDateTime("20260708T090000", "Asia/Tokyo")).toMatchObject({
			kind: "zoned",
			tzid: "Asia/Tokyo",
		});
	});

	test("TZID と Z 付き UTC 値の併用は拒否する", () => {
		expectInvalid(() => parseCalDateTime("20260708T000000Z", "Asia/Tokyo"));
	});

	test("UTC だけエポック変換と比較ができる", () => {
		const early = parseCalDateTime("20260708T000000Z");
		const late = parseCalDateTime("20260708T000001Z");
		if (early.kind !== "utc" || late.kind !== "utc") throw new Error("test setup bug");

		expect(toEpochMillis(early)).toBe(Date.UTC(2026, 6, 8, 0, 0, 0));
		expect(compareUtc(early, late)).toBe(-1);
		expect(formatCalDateTime(late)).toBe("20260708T000001Z");
	});

	test("うるう秒 60 は受理して保持する", () => {
		const dt = parseCalDateTime("20260630T235960Z");
		expect(dt).toMatchObject({ kind: "utc", second: 60 });
		expect(formatCalDateTime(dt)).toBe("20260630T235960Z");
	});
});

describe("DurationValue(§3.3.6 DURATION)", () => {
	test("週形式と日時形式を parse↔format できる", () => {
		expect(formatDurationValue(parseDurationValue("P2W"))).toBe("P2W");
		expect(formatDurationValue(parseDurationValue("-P1DT12H30M5S"))).toBe("-P1DT12H30M5S");
		expect(formatDurationValue(parseDurationValue("PT30M"))).toBe("PT30M");
	});

	test("週形式と日時形式の混在や空の duration は拒否する", () => {
		expectInvalid(() => parseDurationValue("P2W1D"));
		expectInvalid(() => parseDurationValue("P"));
		expectInvalid(() => parseDurationValue("PT"));
		expectInvalid(() => parseDurationValue("P1Y"));
	});
});

describe("PeriodValue(§3.3.9 PERIOD)", () => {
	test("start/end 形式と start/duration 形式を parse↔format できる", () => {
		expect(formatPeriodValue(parsePeriodValue("20260708T000000Z/20260708T010000Z"))).toBe(
			"20260708T000000Z/20260708T010000Z",
		);
		expect(formatPeriodValue(parsePeriodValue("20260708T000000Z/PT1H"))).toBe("20260708T000000Z/PT1H");
	});

	test("start/duration 形式の負 duration は拒否する", () => {
		expectInvalid(() => parsePeriodValue("20260708T000000Z/-PT1H"));
	});

	test("比較可能な start/end 形式では end が start より後でなければならない", () => {
		expectInvalid(() => parsePeriodValue("20260708T010000Z/20260708T000000Z"));
		expectInvalid(() => parsePeriodValue("20260708T000000Z/20260708T000000Z"));
		expectInvalid(() => parsePeriodValue("20260708T090000/20260708T080000"));
		expectInvalid(() => parsePeriodValue("20260708T090000/20260708T080000", "Asia/Tokyo"));
	});
});

describe("RecurrenceRule(§3.3.10 RECUR)", () => {
	test("RFC 実例: MONTHLY + 序数 BYDAY", () => {
		const rule = parseRecurrenceRule("FREQ=MONTHLY;BYDAY=2MO");
		expect(rule).toMatchObject({ freq: "MONTHLY", byDay: [{ ordinal: 2, weekday: "MO" }] });
		expect(formatRecurrenceRule(rule)).toBe("FREQ=MONTHLY;BYDAY=2MO");
	});

	test("RFC 実例: YEARLY + INTERVAL + BYMONTH/BYDAY/BYHOUR/BYMINUTE", () => {
		const raw = "FREQ=YEARLY;INTERVAL=2;BYMONTH=1;BYDAY=SU;BYHOUR=8,9;BYMINUTE=30";
		const rule = parseRecurrenceRule(raw);
		expect(rule).toMatchObject({
			freq: "YEARLY",
			interval: 2,
			byMonth: [1],
			byDay: [{ weekday: "SU" }],
			byHour: [8, 9],
			byMinute: [30],
		});
		// format は FREQ 先頭を守りつつ、以降は recurrence-rule.ts のコメントどおり
		// RFC の rule-part 列挙順に正規化する。入力順の保持は RRULE 値型の責務ではない。
		expect(formatRecurrenceRule(rule)).toBe(
			"FREQ=YEARLY;INTERVAL=2;BYMINUTE=30;BYHOUR=8,9;BYDAY=SU;BYMONTH=1",
		);
	});

	test("順不同で受理し、format は FREQ を先頭に正規化する", () => {
		const rule = parseRecurrenceRule("COUNT=3;INTERVAL=2;FREQ=DAILY");
		expect(formatRecurrenceRule(rule)).toBe("FREQ=DAILY;COUNT=3;INTERVAL=2");
	});

	// 2026-07-09 原文再照合で期待値を修正: §3.3.10 は UNTIL を DTSTART に合わせて3ケース
	// (① DATE / ② floating DATE-TIME / ③ UTC DATE-TIME)許す。よって values 層は DATE・utc・
	// floating の3形態を「構文上あり得る」として受理する(どれが正しいかは DTSTART 依存なので
	// semantics 層の責務)。旧テストは floating(末尾 Z なし DATE-TIME)を expectInvalid にしていたが、
	// これは docs の誤り(② floating ケース欠落)の転写で、合法な floating UNTIL を拒否していた。
	test("UNTIL は DATE / UTC DATE-TIME / floating DATE-TIME を受理し往復する", () => {
		expect(formatRecurrenceRule(parseRecurrenceRule("FREQ=DAILY;UNTIL=20260708"))).toBe(
			"FREQ=DAILY;UNTIL=20260708",
		);
		// ③ UTC(末尾 Z)。非退行。
		expect(formatRecurrenceRule(parseRecurrenceRule("FREQ=DAILY;UNTIL=20260708T000000Z"))).toBe(
			"FREQ=DAILY;UNTIL=20260708T000000Z",
		);
		// ② floating(末尾 Z なし DATE-TIME)。parse→format でロスレスに戻る(Z を付け足さない)。
		const rule = parseRecurrenceRule("FREQ=DAILY;UNTIL=20260801T000000");
		expect(rule.until).toMatchObject({ type: "date-time", dateTime: { kind: "floating" } });
		expect(formatRecurrenceRule(rule)).toBe("FREQ=DAILY;UNTIL=20260801T000000");
	});

	test("不変条件違反を拒否する", () => {
		expectInvalid(() => parseRecurrenceRule("COUNT=1"));
		expectInvalid(() => parseRecurrenceRule("FREQ=DAILY;COUNT=1;UNTIL=20260708"));
		expectInvalid(() => parseRecurrenceRule("FREQ=DAILY;COUNT=1;COUNT=2"));
		expectInvalid(() => parseRecurrenceRule("FREQ=WEEKLY;BYDAY=2MO"));
		expectInvalid(() => parseRecurrenceRule("FREQ=YEARLY;BYWEEKNO=1;BYDAY=2MO"));
		expectInvalid(() => parseRecurrenceRule("FREQ=DAILY;BYMONTH=13"));
		expectInvalid(() => parseRecurrenceRule("FREQ=DAILY;BYSETPOS=0"));
	});
});

describe("UtcOffset(§3.3.14 UTC-OFFSET)", () => {
	test("秒あり/なしを区別して parse↔format できる", () => {
		expect(formatUtcOffset(parseUtcOffset("+0900"))).toBe("+0900");
		expect(formatUtcOffset(parseUtcOffset("+090000"))).toBe("+090000");
		expect(formatUtcOffset(parseUtcOffset("-0830"))).toBe("-0830");
	});

	test("-0000 と範囲外の分秒は拒否する", () => {
		expectInvalid(() => parseUtcOffset("-0000"));
		expectInvalid(() => parseUtcOffset("-000000"));
		expectInvalid(() => parseUtcOffset("+0960"));
		expectInvalid(() => parseUtcOffset("+090060"));
	});
});

describe("TextValue(§3.3.11 TEXT)", () => {
	test("エスケープ済み TEXT を decode/encode できる", () => {
		const value = parseTextValue(String.raw`A\, B\; C\nD\\E`);
		expect(value.text).toBe("A, B; C\nD\\E");
		expect(formatTextValue(value)).toBe(String.raw`A\, B\; C\nD\\E`);
	});

	test("大文字 N の改行を受理し、生成は小文字 n に正規化する", () => {
		expect(formatTextValue(parseTextValue(String.raw`A\NB`))).toBe(String.raw`A\nB`);
	});

	test("COLON はエスケープしない", () => {
		expect(formatTextValue({ text: "http://example.test/a,b;c" })).toBe(String.raw`http://example.test/a\,b\;c`);
	});
});

describe("CalAddress(§3.3.3 CAL-ADDRESS)", () => {
	test("URI をそのまま保持し、scheme を小文字で抽出する", () => {
		const address = parseCalAddress("MAILTO:Alice@example.com");
		expect(address).toEqual({ uri: "MAILTO:Alice@example.com", scheme: "mailto" });
		expect(formatCalAddress(address)).toBe("MAILTO:Alice@example.com");
	});

	test("スキーム無しの実データも受理するが、空値は拒否する", () => {
		expect(parseCalAddress("alice@example.com")).toEqual({ uri: "alice@example.com" });
		expectInvalid(() => parseCalAddress(""));
	});
});
