// =============================================================================
// 不変条件 I1〜I10 + VALARM 細則の検証テスト(合成データ)
// =============================================================================
// 各不変条件について「違反する最小の VCALENDAR」を ICS 文字列で組み、parse → レンズの
// validate() が該当 invariant を報告することを確認する。validate は throw せず全違反を
// 配列で返す方針(errors.ts)なので、「該当 id を含む」で検証する(他の付随違反が
// 混ざってもよい)。
import { describe, expect, test } from "bun:test";
import { parse } from "../../../../src/domain/ical";
import { ICalendarObject, type InvariantId } from "../../../../src/domain/ical/semantics";

// ICS 文字列 → 違反 id の集合。
function violate(ics: string): Set<InvariantId> {
	const violations = ICalendarObject.fromComponent(parse(ics)).validate();
	return new Set(violations.map((v) => v.invariant));
}
// 「この id の違反を含む」アサーション。
function expectViolation(ics: string, id: InvariantId): void {
	expect(violate(ics).has(id)).toBe(true);
}

// 妥当な骨格の部品(ノイズ違反を避けるため、対象以外は正しくしておく)。
const VALID_STAMP = "DTSTAMP:20260101T000000Z"; // UTC DATE-TIME(I2 を満たす)

describe("I1: VCALENDAR は VERSION:2.0 と PRODID", () => {
	test("PRODID 欠落 + VERSION 不正 → I1", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:1.0\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nEND:VEVENT\nEND:VCALENDAR`,
			"I1",
		);
	});
});

describe("I2: VEVENT/VTODO は UID + DTSTAMP(UTC)必須", () => {
	test("DTSTAMP が UTC でない(floating)→ I2", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\nDTSTAMP:20260101T000000\nEND:VEVENT\nEND:VCALENDAR`,
			"I2",
		);
	});
	test("UID 欠落 → I2", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\n${VALID_STAMP}\nEND:VEVENT\nEND:VCALENDAR`,
			"I2",
		);
	});
	test("UID 2 個(複数出現)→ I2", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\nUID:b\n${VALID_STAMP}\nEND:VEVENT\nEND:VCALENDAR`,
			"I2",
		);
	});
});

describe("I3: VEVENT の DTEND/DURATION 排他・DTEND>DTSTART", () => {
	test("DTEND と DURATION 併存 → I3", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDTEND:20260101T110000Z\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR`,
			"I3",
		);
	});
	test("DTEND が DTSTART 以前(同時刻含む)→ I3", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDTEND:20260101T100000Z\nEND:VEVENT\nEND:VCALENDAR`,
			"I3",
		);
	});
});

describe("I4: VTODO の DUE/DURATION 排他・DURATION には DTSTART 必須", () => {
	test("DURATION あり DTSTART 無し → I4", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDURATION:PT1H\nEND:VTODO\nEND:VCALENDAR`,
			"I4",
		);
	});
	test("DUE と DURATION 併存 → I4", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDUE:20260102T100000Z\nDURATION:PT1H\nEND:VTODO\nEND:VCALENDAR`,
			"I4",
		);
	});
});

describe("I5: RRULE の UNTIL/COUNT 排他(values 層の throw を validate が収集)", () => {
	test("UNTIL と COUNT 同時 → I5", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=5;UNTIL=20260201T000000Z\nEND:VEVENT\nEND:VCALENDAR`,
			"I5",
		);
	});
});

describe("I6: 値型一致", () => {
	test("DTSTART が DATE-TIME・DTEND が DATE → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDTEND;VALUE=DATE:20260102\nEND:VEVENT\nEND:VCALENDAR`,
			"I6",
		);
	});
	test("RRULE UNTIL の値型が DTSTART と不一致 → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;UNTIL=20260201\nEND:VEVENT\nEND:VCALENDAR`,
			"I6",
		);
	});
	test("VTODO: DUE の値型が DTSTART と不一致 → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDUE;VALUE=DATE:20260102\nEND:VTODO\nEND:VCALENDAR`,
			"I6",
		);
	});
});

describe("I7: SEQUENCE は 0 以上の整数", () => {
	test("SEQUENCE が負 → I7", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nSEQUENCE:-1\nEND:VEVENT\nEND:VCALENDAR`,
			"I7",
		);
	});
});

describe("I8: TZID 参照整合と MUST NOT", () => {
	test("TZID 参照先の VTIMEZONE が不在 → I8", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART;TZID=Asia/Tokyo:20260101T100000\nEND:VEVENT\nEND:VCALENDAR`,
			"I8",
		);
	});
	test("DATE 型へ TZID を付与(MUST NOT)→ I8", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART;VALUE=DATE;TZID=Asia/Tokyo:20260101\nEND:VEVENT\nEND:VCALENDAR`,
			"I8",
		);
	});
});

describe("I9: DATE 型 DTSTART の DURATION は日/週単位のみ", () => {
	test("DATE 型 DTSTART + DURATION に時刻成分 → I9", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART;VALUE=DATE:20260101\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR`,
			"I9",
		);
	});
});

describe("I10: VTIMEZONE の必須要素", () => {
	test("TZID 欠落 + STANDARD が TZOFFSETTO 欠落 → I10", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTIMEZONE\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0900\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nEND:VEVENT\nEND:VCALENDAR`,
			"I10",
		);
	});
	test("STANDARD/DAYLIGHT がどちらも無い → I10", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTIMEZONE\nTZID:Asia/Tokyo\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nEND:VEVENT\nEND:VCALENDAR`,
			"I10",
		);
	});
});

describe("VALARM 細則(番号なし・VALARM タグ)", () => {
	test("ACTION=DISPLAY で DESCRIPTION 欠落 → VALARM", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`,
			"VALARM",
		);
	});
	test("TRIGGER 欠落 → VALARM", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nBEGIN:VALARM\nACTION:AUDIO\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`,
			"VALARM",
		);
	});
	test("DURATION だけあって REPEAT が無い → VALARM", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nBEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT15M\nDURATION:PT5M\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`,
			"VALARM",
		);
	});
});
