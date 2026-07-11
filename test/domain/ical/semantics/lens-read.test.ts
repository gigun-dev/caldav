// =============================================================================
// semantics レンズの「読み取り」テスト(実フィクスチャを parse → レンズで読む)
// =============================================================================
// レンズは Component を独自構造へ変換しない(§1-1)ので、ここでの狙いは
// 「生 Component から型付きの意味論値が正しく取り出せる」ことの確認。
// フィクスチャは既存の実データ(iOS 実機由来 + 繰り返しオーバーライド)を流用する。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "../../../../src/domain/ical";
import { ICalendarObject } from "../../../../src/domain/ical/semantics";

// フィクスチャは roundtrip.test.ts と同じ規則で読む(import.meta.dir 基準の相対)。
const fixture = (name: string): string =>
	readFileSync(`${import.meta.dir}/../fixtures/${name}`, "utf8");
const load = (name: string): ICalendarObject =>
	ICalendarObject.fromComponent(parse(fixture(name)));

describe("ICalendarObject: VCALENDAR レンズ", () => {
	test("ios-event: prodid / version / events / timezones が読める", () => {
		const cal = load("ios-event.ics");
		expect(cal.version).toBe("2.0");
		expect(cal.prodid).toBe("-//Apple Inc.//iPhone OS 17.5//EN");
		expect(cal.method).toBeUndefined(); // 通常リソースに METHOD は無い
		expect(cal.events()).toHaveLength(1);
		expect(cal.todos()).toHaveLength(0);
		expect(cal.timezones()).toHaveLength(1);
		expect(cal.timezones()[0]!.tzid).toBe("Asia/Tokyo");
	});

	test("ios-event: VEvent の日時アクセサが TZID 付き(zoned)で解釈される", () => {
		const ev = load("ios-event.ics").events()[0]!;
		expect(ev.uid).toBe("1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
		expect(ev.summary).toBe("Team sync");
		expect(ev.status).toBeUndefined();
		expect(ev.transp).toBe("OPAQUE");
		expect(ev.sequence).toBe(0);

		const start = ev.dtstart!;
		// zoned 形態(TZID=Asia/Tokyo)であること。CalDateTime だけが kind を持つ。
		if (!("kind" in start)) throw new Error("dtstart should be a DATE-TIME");
		expect(start.kind).toBe("zoned");
		if (start.kind !== "zoned") throw new Error("unreachable");
		expect(start.tzid).toBe("Asia/Tokyo");
		expect(start.hour).toBe(10);

		// DTSTAMP は UTC 形態。
		const stamp = ev.dtstamp!;
		if (!("kind" in stamp)) throw new Error("dtstamp should be a DATE-TIME");
		expect(stamp.kind).toBe("utc");
	});

	test("ios-event: VALARM をレンズ化して読める", () => {
		const ev = load("ios-event.ics").events()[0]!;
		const alarms = ev.alarms();
		expect(alarms).toHaveLength(1);
		expect(alarms[0]!.action).toBe("DISPLAY");
	});

	test("ios-reminder: VTodo のアクセサ(status/priority)", () => {
		const cal = load("ios-reminder.ics");
		expect(cal.todos()).toHaveLength(1);
		const todo = cal.todos()[0]!;
		expect(todo.uid).toBe("B2C3D4E5-F6A7-8B9C-0D1E-2F3A4B5C6D7E");
		expect(todo.summary).toBe("Buy milk");
		expect(todo.status).toBe("NEEDS-ACTION");
		expect(todo.priority).toBe(1);
	});

	test("recurrence-override: 同一 UID の master + override を events() で2つ読む", () => {
		const events = load("recurrence-override.ics").events();
		expect(events).toHaveLength(2);
		// マスターは RRULE を持ち RECURRENCE-ID を持たない。
		expect(events[0]!.rrule?.freq).toBe("WEEKLY");
		expect(events[0]!.recurrenceId).toBeUndefined();
		// オーバーライドは RECURRENCE-ID を持つ(zoned)。
		const rid = events[1]!.recurrenceId!;
		if (!("kind" in rid)) throw new Error("recurrence-id should be DATE-TIME");
		expect(rid.kind).toBe("zoned");
		// UID は両者同一(UID 一意性の検証はこの層の責務ではない — CalDAV R3/R4)。
		expect(events[0]!.uid).toBe(events[1]!.uid);
	});
});

describe("ICalendarObject: VJournal レンズ(J-1)", () => {
	test("最小 VJOURNAL のアクセサが読める(UID/DTSTAMP/複数 DESCRIPTION/RELATED-TO)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VJOURNAL",
			"UID:j-1",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260101",
			"SUMMARY:Daily log",
			"DESCRIPTION:one",
			"DESCRIPTION:two",
			"CATEGORIES:WORK,PERSONAL",
			"RELATED-TO:vtodo-uid-1",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		expect(cal.journals()).toHaveLength(1);
		const journal = cal.journals()[0]!;
		expect(journal.uid).toBe("j-1");
		expect(journal.summary).toBe("Daily log");
		expect(journal.descriptions()).toEqual(["one", "two"]);
		expect(journal.categories()).toEqual(["WORK,PERSONAL"]);
		expect(journal.relatedTo()).toEqual([{ value: "vtodo-uid-1", reltype: "PARENT" }]);
		// DTSTART は VALUE=DATE なので CalDate(kind を持たない)。
		expect("kind" in journal.dtstart!).toBe(false);
	});
});

describe("ICalendarObject: VTodo レンズ — ical-tasks draft / RFC 9253 先取りアクセサ(J-3)", () => {
	test("STATUS:PENDING は status で受かる(union 化せず string のまま。draft-ietf-calext-ical-tasks-17 §11.2/§15.3)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-pending",
			"DTSTAMP:20260101T000000Z",
			"STATUS:PENDING",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		expect(cal.todos()[0]!.status).toBe("PENDING");
	});

	test("SUBSTATE/REASON は VSTATUS サブコンポーネント配下から読める(draft §10.2/§10.3。VTODO 直下ではない)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-substate",
			"DTSTAMP:20260101T000000Z",
			"STATUS:FAILED",
			"BEGIN:VSTATUS",
			"STATUS:FAILED",
			"REASON:https://example.com/reason/no-one-home",
			"SUBSTATE:ERROR",
			"END:VSTATUS",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const todo = cal.todos()[0]!;
		expect(todo.substate).toBe("ERROR");
		expect(todo.reason).toBe("https://example.com/reason/no-one-home");
	});

	test("SUBSTATE/REASON は VSTATUS が無ければ undefined", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-no-vstatus",
			"DTSTAMP:20260101T000000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const todo = cal.todos()[0]!;
		expect(todo.substate).toBeUndefined();
		expect(todo.reason).toBeUndefined();
	});

	test("ESTIMATED-DURATION は DURATION 値として parseDurationValue で読める(draft §10.1)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-estimated",
			"DTSTAMP:20260101T000000Z",
			"ESTIMATED-DURATION:PT1H",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		expect(cal.todos()[0]!.estimatedDuration).toEqual({ positive: true, hours: 1 });
	});

	test("DEPENDS-ON は RELATED-TO;RELTYPE=DEPENDS-ON;GAP=... の形で読める(RFC 9253 §5/§6.2/§9.1)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-depends",
			"DTSTAMP:20260101T000000Z",
			"RELATED-TO;RELTYPE=DEPENDS-ON;GAP=P1D:paint-the-room",
			"RELATED-TO;RELTYPE=DEPENDS-ON:electrical-work",
			"RELATED-TO:parent-uid",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const todo = cal.todos()[0]!;
		expect(todo.dependsOn()).toEqual([
			{ value: "paint-the-room", gap: { positive: true, days: 1 } },
			{ value: "electrical-work", gap: undefined },
		]);
		// RELTYPE 未指定(既定 PARENT)は relatedTo() 側にだけ現れ、dependsOn() には含まれない。
		expect(todo.relatedTo()).toEqual([
			{ value: "paint-the-room", reltype: "DEPENDS-ON" },
			{ value: "electrical-work", reltype: "DEPENDS-ON" },
			{ value: "parent-uid", reltype: "PARENT" },
		]);
	});

	test("REFID は複数プロパティとして全件読める(RFC 9253 §8.3。1プロパティ複数値ではない)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-refid",
			"DTSTAMP:20260101T000000Z",
			"REFID:itinerary-2014-11-17",
			"REFID:trip-42",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		expect(cal.todos()[0]!.refids()).toEqual(["itinerary-2014-11-17", "trip-42"]);
	});

	test("VTodo.relatedTo() と VJournal.relatedTo() は同じ共通ヘルパー経由で同じ結果を返す(helpers.relatedToOf の回帰)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:t-shared",
			"DTSTAMP:20260101T000000Z",
			"RELATED-TO:shared-uid",
			"RELATED-TO;RELTYPE=SIBLING:sibling-uid",
			"END:VTODO",
			"BEGIN:VJOURNAL",
			"UID:j-shared",
			"DTSTAMP:20260101T000000Z",
			"RELATED-TO:shared-uid",
			"RELATED-TO;RELTYPE=SIBLING:sibling-uid",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		expect(cal.todos()[0]!.relatedTo()).toEqual(cal.journals()[0]!.relatedTo());
	});
});

describe("validate: 実データは妥当(違反ゼロ)", () => {
	test("ios-event.ics は違反なし", () => {
		expect(load("ios-event.ics").validate()).toEqual([]);
	});
	test("ios-reminder.ics は違反なし", () => {
		expect(load("ios-reminder.ics").validate()).toEqual([]);
	});

	// recurrence-override.ics は TZID=Asia/Tokyo を使うが VTIMEZONE を同梱していない
	// (テストデータとしては iOS 非同梱ケースを模す)。よって I8(参照整合)違反が出るのが正しい。
	test("recurrence-override.ics は VTIMEZONE 不在で I8 を報告する", () => {
		const violations = load("recurrence-override.ics").validate();
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.every((v) => v.invariant === "I8")).toBe(true);
		expect(violations.some((v) => v.message.includes("Asia/Tokyo"))).toBe(true);
	});
});
