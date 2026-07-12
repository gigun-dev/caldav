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

describe("buildVTodoCalendar", () => {
	test("最小構成(UID/DTSTAMP/SUMMARY のみ)が VCALENDAR+VTODO として往復する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-1",
			dtstamp: "20260712T120000Z",
			summary: "牛乳を買う",
		});
		expect(component.name).toBe("VCALENDAR");
		expect(component.properties).toContainEqual({ name: "VERSION", parameters: [], value: "2.0" });

		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const vtodo = reparsed.todos()[0]!;
		expect(vtodo.uid).toBe("uid-1");
		expect(vtodo.summary).toBe("牛乳を買う");
		expect(vtodo.due).toBeUndefined();
		expect(vtodo.priority).toBeUndefined();
	});

	test("due 指定時は DTSTART/DUE が同値の VALUE=DATE で両方立つ(iOS 実機キャプチャ準拠)", () => {
		const component = buildVTodoCalendar({
			uid: "uid-2",
			dtstamp: "20260712T120000Z",
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
			dtstamp: "20260712T120000Z",
			summary: "重要タスク",
			priority: 1,
		});
		const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
		expect(vtodo.priority).toBe(1);
	});

	test("priority:0(未設定)は PRIORITY プロパティ自体を省略する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-4",
			dtstamp: "20260712T120000Z",
			summary: "優先度なし",
			priority: 0,
		});
		const vtodo = ICalendarObject.fromComponent(parse(serialize(component))).todos()[0]!;
		expect(vtodo.priority).toBeUndefined();
	});

	test("description が TEXT エスケープを経て往復する", () => {
		const component = buildVTodoCalendar({
			uid: "uid-5",
			dtstamp: "20260712T120000Z",
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
				dtstamp: "20260712T120000Z",
				summary: "未対応ケース",
				due: "20260715T090000",
				// @ts-expect-error dueValueType は "DATE" のみサポート(型でも縛っているが実行時ガードも確認する)
				dueValueType: "DATE-TIME",
			}),
		).toThrow();
	});
});
