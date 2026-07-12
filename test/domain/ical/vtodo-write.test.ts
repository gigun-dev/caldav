// =============================================================================
// semantics/vtodo-write.ts のテスト(E-1 スライス①新設)
// =============================================================================
// buildVTodoCalendar → serialize → parse → VTodo レンズで読み戻し、
// title/due/priority が往復一致することを確認する。validate() の違反もゼロであること。
import { describe, expect, test } from "bun:test";
import { buildVTodoCalendar } from "../../../src/domain/ical/semantics/vtodo-write";
import { ICalendarObject, VTodo } from "../../../src/domain/ical/semantics";
import { serialize } from "../../../src/domain/ical/serialize/serializer";
import { parse } from "../../../src/domain/ical/parse/parser";
import { recurrenceRule } from "../../../src/domain/ical/values/recurrence-rule";
import { parseCalDate } from "../../../src/domain/ical/values/cal-date";

// テスト全体で使う固定 NowStamp(vtodo-stamp.test.ts と同じ実測ペア。決定的な期待値にするため)。
const NOW = { utcRaw: "20260712T114830Z", unixSeconds: 1783856910 };

describe("buildVTodoCalendar", () => {
	test("最小構成(UID/SUMMARY のみ)が VCALENDAR+VTODO として往復する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-1",
			now: NOW,
			summary: "牛乳を買う",
		});
		expect(component.name).toBe("VCALENDAR");
		expect(component.properties).toContainEqual({ name: "VERSION", parameters: [], value: "2.0" });
		// CALSCALE(§3.7.1)。②-a で追加(iOS 実機キャプチャ準拠)。
		expect(component.properties).toContainEqual({ name: "CALSCALE", parameters: [], value: "GREGORIAN" });

		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const vtodo = reparsed.todos()[0]!;
		expect(vtodo.uid).toBe("uid-1");
		expect(vtodo.summary).toBe("牛乳を買う");
		expect(vtodo.due).toBeUndefined();
		expect(vtodo.priority).toBeUndefined();
		// stampCreate(vtodo-stamp.ts)が付ける生成プロパティ。
		expect(vtodo.status).toBe("NEEDS-ACTION");
		expect(vtodo.dtstamp).toEqual({ kind: "utc", year: 2026, month: 7, day: 12, hour: 11, minute: 48, second: 30 });
		expect(vtodo.raw.properties.find((p) => p.name === "CREATED")?.value).toBe("20260712T114830Z");
		expect(vtodo.raw.properties.find((p) => p.name === "LAST-MODIFIED")?.value).toBe("20260712T114830Z");
		expect(vtodo.raw.properties.find((p) => p.name === "X-APPLE-SORT-ORDER")?.value).toBe("805549710");
	});

	test("due 指定時は DTSTART/DUE が同値の VALUE=DATE で両方立つ(iOS 実機キャプチャ準拠)", () => {
		const component = buildVTodoCalendar({
			uid: "uid-2",
			now: NOW,
			summary: "資料を提出",
			due: "20260715",
			dueValueType: "DATE",
		});
		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const vtodo = reparsed.todos()[0]!;
		expect(vtodo.dtstart).toEqual({ year: 2026, month: 7, day: 15 });
		expect(vtodo.due).toEqual({ year: 2026, month: 7, day: 15 });
	});

	test("priority が往復する(iOS 準拠: 1=高/5=中/9=低)", () => {
		const component = buildVTodoCalendar({
			uid: "uid-3",
			now: NOW,
			summary: "重要タスク",
			priority: 1,
		});
		const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
		expect(vtodo.priority).toBe(1);
	});

	test("priority:0(未設定)は PRIORITY プロパティ自体を省略する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-4",
			now: NOW,
			summary: "優先度なし",
			priority: 0,
		});
		const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
		expect(vtodo.priority).toBeUndefined();
	});

	test("description が TEXT エスケープを経て往復する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-5",
			now: NOW,
			summary: "カンマ, セミコロン; を含む",
			description: "改行\nと\\バックスラッシュ",
		});
		const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
		expect(vtodo.summary).toBe("カンマ\\, セミコロン\\; を含む"); // 生値(エスケープ済み)がそのまま返る(vtodo.ts の既存方針)。
		const descProp = vtodo.raw.properties.find((p) => p.name === "DESCRIPTION")!;
		// decodeText は application 層(task-dto.ts)の責務なのでここでは生値の中身だけ検証する。
		expect(descProp.value).toContain("\\n");
		expect(descProp.value).toContain("\\\\");
	});

	test("due 指定時に dueValueType が 'DATE' 以外だと throw する(時刻付き due は未対応)", () => {
		expect(() =>
			buildVTodoCalendar({
				uid: "uid-6",
				now: NOW,
				summary: "未対応ケース",
				due: "20260715T090000",
				// @ts-expect-error dueValueType は "DATE" のみサポート(型でも縛っているが実行時ガードも確認する)
				dueValueType: "DATE-TIME",
			}),
		).toThrow();
	});

	// --- recurrence(タスク③: 反復付き create-todo。RRULE 生成)-----------------------

	describe("recurrence", () => {
		test("daily + count で FREQ=DAILY;COUNT=5 の RRULE が立ち、DTSTART/DUE は VALUE=DATE のまま", () => {
			const component = buildVTodoCalendar({
				uid: "uid-rec-1",
				now: NOW,
				summary: "毎日のタスク",
				due: "20260715",
				dueValueType: "DATE",
				recurrence: recurrenceRule({ freq: "DAILY", count: 5 }),
			});
			const ics = serialize(component);
			const reparsed = ICalendarObject.fromComponent(parse(ics));
			expect(reparsed.validate()).toEqual([]);

			const vtodo = reparsed.todos()[0]!;
			expect(vtodo.dtstart).toEqual({ year: 2026, month: 7, day: 15 });
			expect(vtodo.due).toEqual({ year: 2026, month: 7, day: 15 });
			const rruleProp = vtodo.raw.properties.find((p) => p.name === "RRULE")!;
			expect(rruleProp.value).toBe("FREQ=DAILY;COUNT=5");
		});

		test("weekly + weekdays で FREQ=WEEKLY;BYDAY=SU,SA の RRULE が立つ", () => {
			const component = buildVTodoCalendar({
				uid: "uid-rec-2",
				now: NOW,
				summary: "週末のタスク",
				due: "20260718", // 2026-07-18 は土曜(BYDAY の並びは呼び出し側の指定順をそのまま出す)。
				dueValueType: "DATE",
				recurrence: recurrenceRule({ freq: "WEEKLY", byDay: [{ weekday: "SU" }, { weekday: "SA" }] }),
			});
			const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
			const rruleProp = vtodo.raw.properties.find((p) => p.name === "RRULE")!;
			expect(rruleProp.value).toBe("FREQ=WEEKLY;BYDAY=SU,SA");
		});

		test("interval で FREQ=DAILY;INTERVAL=2 の RRULE が立つ", () => {
			const component = buildVTodoCalendar({
				uid: "uid-rec-3",
				now: NOW,
				summary: "2日おきのタスク",
				due: "20260715",
				dueValueType: "DATE",
				recurrence: recurrenceRule({ freq: "DAILY", interval: 2 }),
			});
			const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
			const rruleProp = vtodo.raw.properties.find((p) => p.name === "RRULE")!;
			expect(rruleProp.value).toBe("FREQ=DAILY;INTERVAL=2");
		});

		test("until(DATE 型)で FREQ=DAILY;UNTIL=20260731 の RRULE が立ち、DTSTART と値型が揃う", () => {
			const component = buildVTodoCalendar({
				uid: "uid-rec-4",
				now: NOW,
				summary: "月末までの毎日タスク",
				due: "20260715",
				dueValueType: "DATE",
				recurrence: recurrenceRule({ freq: "DAILY", until: { type: "date", date: parseCalDate("20260731") } }),
			});
			const ics = serialize(component);
			const reparsed = ICalendarObject.fromComponent(parse(ics));
			// DTSTART が DATE、UNTIL も DATE(RFC 5545 §3.3.10「UNTIL は DTSTART と同じ値型」)。
			// 値型不一致なら validate() が何か違反を返すはずなので、ここでゼロ件であることも
			// 合わせて確認する(update-todo.ts で判明した I6 の罠を作っていないことの回帰確認)。
			expect(reparsed.validate()).toEqual([]);

			const vtodo = reparsed.todos()[0]!;
			const rruleProp = vtodo.raw.properties.find((p) => p.name === "RRULE")!;
			expect(rruleProp.value).toBe("FREQ=DAILY;UNTIL=20260731");
		});

		test("recurrence 指定時は due 無しだと throw する(RRULE は DTSTART アンカーが必須)", () => {
			expect(() =>
				buildVTodoCalendar({
					uid: "uid-rec-5",
					now: NOW,
					summary: "due 無しの反復(不正)",
					recurrence: recurrenceRule({ freq: "DAILY" }),
				}),
			).toThrow();
		});
	});

	// --- alarm(VALARM。V5 実機検証の前提。2026-07-13 追加)-----------------------------

	describe("alarm", () => {
		test("alarm 指定で iOS 実機フィクスチャ準拠の VALARM が1個足される(ACTION/DESCRIPTION/TRIGGER;VALUE=DATE-TIME/UID/X-WR-ALARMUID)", () => {
			const component = buildVTodoCalendar({
				uid: "uid-alarm-1",
				now: NOW,
				summary: "通知つきタスク",
				alarm: { triggerUtcRaw: "20260714T000000Z", uid: "alarm-uid-1" },
			});
			const ics = serialize(component);
			const reparsed = ICalendarObject.fromComponent(parse(ics));
			expect(reparsed.validate()).toEqual([]);

			const vtodo = reparsed.todos()[0]!;
			const valarms = vtodo.raw.components.filter((c) => c.name === "VALARM");
			expect(valarms).toHaveLength(1);
			const valarm = valarms[0]!;
			expect(valarm.properties.find((p) => p.name === "ACTION")?.value).toBe("DISPLAY");
			expect(valarm.properties.find((p) => p.name === "DESCRIPTION")?.value).toBe("Reminder");
			const trigger = valarm.properties.find((p) => p.name === "TRIGGER")!;
			expect(trigger.value).toBe("20260714T000000Z");
			expect(trigger.parameters).toContainEqual({ name: "VALUE", values: ["DATE-TIME"] });
			const uidProp = valarm.properties.find((p) => p.name === "UID")?.value;
			const alarmUidProp = valarm.properties.find((p) => p.name === "X-WR-ALARMUID")?.value;
			expect(uidProp).toBe("alarm-uid-1");
			expect(alarmUidProp).toBe("alarm-uid-1");
			expect(uidProp).toBe(alarmUidProp); // UID と X-WR-ALARMUID は同値(iOS 実機準拠)。
		});

		test("alarm 未指定なら VALARM は無い", () => {
			const component = buildVTodoCalendar({
				uid: "uid-alarm-2",
				now: NOW,
				summary: "通知なしタスク",
			});
			const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
			expect(vtodo.raw.components.filter((c) => c.name === "VALARM")).toHaveLength(0);
		});

		test("due 無しでもアラーム単体で設定できる(due とアラームは独立)", () => {
			const component = buildVTodoCalendar({
				uid: "uid-alarm-3",
				now: NOW,
				summary: "due なし通知タスク",
				alarm: { triggerUtcRaw: "20260714T090000Z", uid: "alarm-uid-3" },
			});
			const ics = serialize(component);
			const reparsed = ICalendarObject.fromComponent(parse(ics));
			expect(reparsed.validate()).toEqual([]);
			const vtodo = reparsed.todos()[0]!;
			expect(vtodo.due).toBeUndefined();
			expect(vtodo.raw.components.filter((c) => c.name === "VALARM")).toHaveLength(1);
		});
	});
});
