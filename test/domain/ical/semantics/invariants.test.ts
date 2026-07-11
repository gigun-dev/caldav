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
// 「一切違反が無い」アサーション(P2 誤検知の回帰用: 過去は誤って違反を出していた入力が
// 今はクリーンであることを確かめる)。どの id が混ざっても落ちるよう集合が空であることを見る。
function expectNoViolations(ics: string): void {
	expect([...violate(ics)]).toEqual([]);
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
	// 2026-07-08 レビュー時追記(§3.8.2.3): DUE は DTSTART より後。同値型・比較可能形態でのみ検証。
	// 2026-07-10 実測修正(iOS 26.5、docs 06 A4): iOS は「期限日付のみ」で DTSTART==DUE(同日)を
	// 常用する(real-ios/vtodo-completed.ics)。同値は違反にしない(逆転だけ違反)ように緩和した。
	test("DUE が DTSTART と同時刻(同 UTC 形態)→ 違反なし(iOS が等号を常用)", () => {
		expectNoViolations(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDUE:20260101T100000Z\nEND:VTODO\nEND:VCALENDAR`,
		);
	});
	test("DUE が DTSTART より前(逆転、同 UTC 形態)→ I4", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nDUE:20260101T090000Z\nEND:VTODO\nEND:VCALENDAR`,
			"I4",
		);
	});
});

// P2(2026-07-08 レビュー指摘)の回帰: DTSTART;TZID=... と DUE:...Z は「値型は一致(共に DATE-TIME)、
// 形態だけ違う」。形態一致まで縛るのは RECURRENCE-ID のみ(§3.8.4.4)なので、これは違反ゼロが正しい。
// 旧実装は sameDateForm で形態一致まで要求し I6 を誤検知していた。zoned+utc は時系列比較もしない(I4 も出ない)。
describe("P2 回帰: DTSTART(TZID)+ DUE(UTC)は誤検知しない", () => {
	// Asia/Tokyo の VTIMEZONE を同梱(TZID 参照整合 I8 を満たすため)。
	const TOKYO_TZ =
		"BEGIN:VTIMEZONE\nTZID:Asia/Tokyo\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0900\nTZOFFSETTO:+0900\nEND:STANDARD\nEND:VTIMEZONE";
	test("DTSTART;TZID=Asia/Tokyo + DUE:UTC → 違反ゼロ", () => {
		expectNoViolations(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\n${TOKYO_TZ}\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART;TZID=Asia/Tokyo:20260101T100000\nDUE:20260102T100000Z\nEND:VTODO\nEND:VCALENDAR`,
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
	// 2026-07-08 レビュー指摘の回帰: 以前 VTODO は RRULE を一切検証せず、UNTIL/COUNT 併存を素通りしていた。
	test("VTODO でも UNTIL と COUNT 同時 → I5(共通化の回帰)", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=5;UNTIL=20260201T000000Z\nEND:VTODO\nEND:VCALENDAR`,
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
	// P2 の逆パターン: DATE 型 DTSTART + DATE-TIME 型 DUE も値型不一致。
	test("VTODO: DATE 型 DTSTART + DATE-TIME 型 DUE → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART;VALUE=DATE:20260101\nDUE:20260102T100000Z\nEND:VTODO\nEND:VCALENDAR`,
			"I6",
		);
	});
	// 2026-07-08 レビュー指摘の回帰: VTODO の RRULE が素通りしていた(共通化で UNTIL 値型一致も効く)。
	test("VTODO: DATE 型 DTSTART + DATE-TIME 型 UNTIL → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VTODO\nUID:a\n${VALID_STAMP}\nDTSTART;VALUE=DATE:20260101\nRRULE:FREQ=DAILY;UNTIL=20260201T000000Z\nEND:VTODO\nEND:VCALENDAR`,
			"I6",
		);
	});
});

// 2026-07-09 原文再照合で追加: §3.3.10 の UNTIL 3ケース(DATE/floating/utc)を DTSTART の
// 形態と突き合わせて検証する。values 層は utc / floating を「構文上あり得る2形態」として
// 受理するようになった(合法な floating UNTIL の拒否バグを修正)ため、①②③のどれに当たるか
// (形態の正しさ)を判断する責務が semantics 層(validateRRule)に来た。その3ケースの検証。
describe("§3.3.10: RRULE UNTIL の形態が DTSTART に整合する(I6)", () => {
	// ② floating DTSTART + floating UNTIL → 合法(旧実装はそもそも floating UNTIL を values 層で
	//    拒否していたため、この合法ケースをテストできていなかった)。違反ゼロが正しい。
	test("floating DTSTART + floating UNTIL → 違反ゼロ", () => {
		expectNoViolations(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000\nRRULE:FREQ=DAILY;UNTIL=20260801T000000\nEND:VEVENT\nEND:VCALENDAR`,
		);
	});
	// ② の違反: floating DTSTART なのに UNTIL が utc(末尾 Z)→ 形態不一致 I6。
	test("floating DTSTART + utc UNTIL → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000\nRRULE:FREQ=DAILY;UNTIL=20260801T000000Z\nEND:VEVENT\nEND:VCALENDAR`,
			"I6",
		);
	});
	// ③ の違反: utc DTSTART なのに UNTIL が floating → 形態不一致 I6。
	test("utc DTSTART + floating UNTIL → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;UNTIL=20260801T000000\nEND:VEVENT\nEND:VCALENDAR`,
			"I6",
		);
	});
});

// 2026-07-09 原文再照合で追加/緩和: RECURRENCE-ID の DTSTART 一致 MUST は §3.8.4.4 上
// 「値型一致 + floating iff floating」の2点のみ。utc⇔utc/zoned+tzid の完全一致は MUST でない。
// 旧実装(sameDateForm)は zoned DTSTART + utc RECURRENCE-ID を誤検知していた。その緩和の回帰。
describe("§3.8.4.4: RECURRENCE-ID は DTSTART と値型一致 + floating iff floating(I6)", () => {
	// Asia/Tokyo VTIMEZONE 同梱(zoned DTSTART の TZID 参照整合 I8 を満たすため)。
	const TOKYO_TZ =
		"BEGIN:VTIMEZONE\nTZID:Asia/Tokyo\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0900\nTZOFFSETTO:+0900\nEND:STANDARD\nEND:VTIMEZONE";
	// ④ 緩和の核心: zoned DTSTART(共に非 floating)+ utc RECURRENCE-ID → 違反ゼロが正しい。
	//    旧 sameDateForm は kind(zoned vs utc)不一致で I6 を誤検知していた。
	test("zoned DTSTART + utc RECURRENCE-ID → 違反ゼロ", () => {
		expectNoViolations(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\n${TOKYO_TZ}\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART;TZID=Asia/Tokyo:20260101T100000\nRECURRENCE-ID:20260101T010000Z\nEND:VEVENT\nEND:VCALENDAR`,
		);
	});
	// ⑤ floating DTSTART なのに RECURRENCE-ID が utc(非 floating)→ floating iff floating 違反 I6。
	test("floating DTSTART + utc RECURRENCE-ID → I6", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:a\n${VALID_STAMP}\nDTSTART:20260101T100000\nRECURRENCE-ID:20260101T100000Z\nEND:VEVENT\nEND:VCALENDAR`,
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

// =============================================================================
// J-1: VJOURNAL(§3.6.3)の不変条件テスト
// =============================================================================
describe("VJOURNAL: I2(UID/DTSTAMP 必須・DTSTAMP UTC)", () => {
	test("最小 VJOURNAL(UID/DTSTAMP のみ)→ 違反なし", () => {
		expectNoViolations(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\nUID:a\n${VALID_STAMP}\nEND:VJOURNAL\nEND:VCALENDAR`,
		);
	});
	test("UID 欠落 → I2", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\n${VALID_STAMP}\nEND:VJOURNAL\nEND:VCALENDAR`,
			"I2",
		);
	});
	test("DTSTAMP が UTC でない(floating)→ I2", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\nUID:a\nDTSTAMP:20260101T000000\nEND:VJOURNAL\nEND:VCALENDAR`,
			"I2",
		);
	});
});

describe("VJOURNAL: 複数 DESCRIPTION / RELATED-TO(§3.6.3 jourprop)", () => {
	test("複数 DESCRIPTION が全件 descriptions() で返る", () => {
		const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\nUID:a\n${VALID_STAMP}\nDESCRIPTION:first\nDESCRIPTION:second\nEND:VJOURNAL\nEND:VCALENDAR`;
		const journal = ICalendarObject.fromComponent(parse(ics)).journals()[0]!;
		expect(journal.descriptions()).toEqual(["first", "second"]);
		// 複数出現していても VJOURNAL では違反にならない(§3.6.3: MAY occur more than once)。
		expect(journal.validate()).toEqual([]);
	});

	test("RELATED-TO が RELTYPE 込みで返る(未指定は既定 PARENT)", () => {
		const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\nUID:a\n${VALID_STAMP}\nRELATED-TO:task-uid-1\nRELATED-TO;RELTYPE=SIBLING:journal-uid-2\nEND:VJOURNAL\nEND:VCALENDAR`;
		const journal = ICalendarObject.fromComponent(parse(ics)).journals()[0]!;
		expect(journal.relatedTo()).toEqual([
			{ value: "task-uid-1", reltype: "PARENT" },
			{ value: "journal-uid-2", reltype: "SIBLING" },
		]);
	});
});

describe("VJOURNAL: RRULE の UNTIL/COUNT 排他(I5、VEvent/VTodo と共通ロジック)", () => {
	test("UNTIL と COUNT 同時 → I5", () => {
		expectViolation(
			`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VJOURNAL\nUID:a\n${VALID_STAMP}\nDTSTART;VALUE=DATE:20260101\nRRULE:FREQ=DAILY;COUNT=5;UNTIL=20260201\nEND:VJOURNAL\nEND:VCALENDAR`,
			"I5",
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
