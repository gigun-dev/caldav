// =============================================================================
// semantics/vtodo-write.ts のテスト(E-1 スライス①新設)
// =============================================================================
// buildVTodoCalendar → serialize → parse → VTodo レンズで読み戻し、
// title/due/priority が往復一致することを確認する。validate() の違反もゼロであること。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildVTodoCalendar } from "../../../src/domain/ical/semantics/vtodo-write";
import { ICalendarObject, VTodo } from "../../../src/domain/ical/semantics";
import { serialize } from "../../../src/domain/ical/serialize/serializer";
import { parse } from "../../../src/domain/ical/parse/parser";
import { recurrenceRule } from "../../../src/domain/ical/values/recurrence-rule";
import { parseCalDate } from "../../../src/domain/ical/values/cal-date";
import { buildVTimezone } from "../../../src/domain/ical/timezone/vtimezone-write";
import type { Component } from "../../../src/domain/ical/structure/types";

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
			due: { type: "DATE", raw: "20260715" },
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

	test("due:DATE-TIME を vtimezone 無しで指定すると throw する(§3.6.5 違反の防御)", () => {
		expect(() =>
			buildVTodoCalendar({
				uid: "uid-6",
				now: NOW,
				summary: "vtimezone 欠落ケース",
				due: { type: "DATE-TIME", raw: "20260715T090000", tzid: "Asia/Tokyo" },
			}),
		).toThrow();
	});

	test("due:DATE-TIME + vtimezone で DTSTART;TZID/DUE;TZID が同値で立ち、VTIMEZONE が VTODO より先に来る", () => {
		const vtimezone = {
			name: "VTIMEZONE",
			properties: [{ name: "TZID", parameters: [], value: "Asia/Tokyo" }],
			components: [
				{
					name: "STANDARD",
					properties: [
						{ name: "DTSTART", parameters: [], value: "19700101T000000" },
						{ name: "TZOFFSETFROM", parameters: [], value: "+0900" },
						{ name: "TZOFFSETTO", parameters: [], value: "+0900" },
						{ name: "TZNAME", parameters: [], value: "JST" },
					],
					components: [],
				},
			],
		};
		const component = buildVTodoCalendar({
			uid: "uid-6b",
			now: NOW,
			summary: "時刻付き期限",
			due: { type: "DATE-TIME", raw: "20260715T090000", tzid: "Asia/Tokyo" },
			vtimezone,
		});
		expect(component.components[0]?.name).toBe("VTIMEZONE"); // VTODO より先(iOS 実機キャプチャの並び)。
		expect(component.components[1]?.name).toBe("VTODO");

		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const vtodo = reparsed.todos()[0]!;
		expect(vtodo.dtstart).toEqual({ kind: "zoned", tzid: "Asia/Tokyo", year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 });
		expect(vtodo.due).toEqual({ kind: "zoned", tzid: "Asia/Tokyo", year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 });
	});

	// --- recurrence(タスク③: 反復付き create-todo。RRULE 生成)-----------------------

	describe("recurrence", () => {
		test("daily + count で FREQ=DAILY;COUNT=5 の RRULE が立ち、DTSTART/DUE は VALUE=DATE のまま", () => {
			const component = buildVTodoCalendar({
				uid: "uid-rec-1",
				now: NOW,
				summary: "毎日のタスク",
				due: { type: "DATE", raw: "20260715" },
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
				due: { type: "DATE", raw: "20260718" }, // 2026-07-18 は土曜(BYDAY の並びは呼び出し側の指定順をそのまま出す)。
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
				due: { type: "DATE", raw: "20260715" },
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
				due: { type: "DATE", raw: "20260715" },
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

	// --- V6: 時刻付き due(DATE-TIME;TZID)+ 生成 VTIMEZONE(2026-07-13 追加)-------------------
	//
	// real-ios/vtodo-timed-due.ics(iOS 実機の時刻付きリマインダー PUT。由来は
	// fixtures/real-ios/README.md 参照)と buildVTodoCalendar の出力を**構造比較**する。
	// 【バイト一致でなく構造比較にする理由】VTIMEZONE の DTSTART は iOS が "19510909T010000"
	// (Asia/Tokyo の JST 制定日)を送るのに対し、buildVTimezone は "19700101T000000" 固定を返す
	// (vtimezone-write.ts の設計判断コメント)。TZOFFSETFROM=TZOFFSETTO の STANDARD が
	// 「その日付以降ずっと有効」を表す点は同じなので、RFC 上は等価(§3.6.5 は DTSTART の
	// 実際の日付値そのものに意味を持たせていない)。よってオクテット等価ではなく
	// 「§3.6.5 必須要素充足 + オフセット値一致」で検証する。
	describe("V6: 時刻付き due(DATE-TIME)+ VTIMEZONE(real-ios/vtodo-timed-due.ics との構造比較)", () => {
		function loadFixtureVTodo(): { vcalendar: ReturnType<typeof parse>; vtodo: VTodo; ics: string } {
			const ics = readFileSync(join(__dirname, "fixtures/real-ios/vtodo-timed-due.ics"), "utf-8");
			const vcalendar = parse(ics);
			const obj = ICalendarObject.fromComponent(vcalendar);
			const vtodo = obj.todos()[0]!;
			return { vcalendar, vtodo, ics };
		}

		test("DTSTART/DUE が TZID 付き同値で立ち、VALARM TRIGGER が due の UTC 瞬間と一致する(iOS 実機フィクスチャ準拠)", () => {
			// fixture 実測: DTSTART;TZID=Asia/Tokyo:20260710T140000 → UTC 2026-07-10T05:00:00Z。
			const vtimezone = buildVTimezone("Asia/Tokyo", {
				startMillis: Date.UTC(2026, 0, 1),
				endMillis: Date.UTC(2027, 0, 1),
			});
			const component = buildVTodoCalendar({
				uid: "generated-uid",
				now: NOW,
				summary: "CAP-TIMEDDUE",
				due: { type: "DATE-TIME", raw: "20260710T140000", tzid: "Asia/Tokyo" },
				vtimezone,
				alarm: { triggerUtcRaw: "20260710T050000Z", uid: "generated-alarm-uid" },
			});
			const generatedVTodo = ICalendarObject.fromComponent(component).todos()[0]!;

			const { vtodo: fixtureVTodo } = loadFixtureVTodo();

			// DTSTART==DUE(TZID 込みで同値)。両方とも zoned CalDateTime で、生成側と
			// fixture 側の壁時計フィールド + TZID が一致することを確認する(UID/DTSTAMP 等の
			// 生成プロパティは意図的に別値なのでここでは比較しない)。
			expect(generatedVTodo.dtstart).toEqual(fixtureVTodo.dtstart);
			expect(generatedVTodo.due).toEqual(fixtureVTodo.due);
			expect(generatedVTodo.dtstart).toEqual(generatedVTodo.due); // DTSTART=DUE 同値(iOS 実機準拠)。

			// VALARM: TRIGGER の生値(絶対 UTC)・UID==X-WR-ALARMUID の構造が一致。
			const fixtureAlarm = fixtureVTodo.raw.components.find((c) => c.name === "VALARM")!;
			const generatedAlarm = generatedVTodo.raw.components.find((c) => c.name === "VALARM")!;
			const triggerOf = (c: typeof fixtureAlarm) => c.properties.find((p) => p.name === "TRIGGER")?.value;
			expect(triggerOf(generatedAlarm)).toBe(triggerOf(fixtureAlarm));
			expect(triggerOf(generatedAlarm)).toMatch(/Z$/); // §3.8.6.3: trigabs は UTC(Z 終端)MUST。
			const alarmUidOf = (c: typeof fixtureAlarm) => c.properties.find((p) => p.name === "UID")?.value;
			const alarmWrUidOf = (c: typeof fixtureAlarm) => c.properties.find((p) => p.name === "X-WR-ALARMUID")?.value;
			expect(alarmUidOf(generatedAlarm)).toBe(alarmWrUidOf(generatedAlarm)); // 生成側も UID==X-WR-ALARMUID。
			expect(alarmUidOf(fixtureAlarm)).toBe(alarmWrUidOf(fixtureAlarm)); // fixture 側も同様(実機観測)。

			// プロパティ集合(生成プロパティ UID/DTSTAMP/CREATED/LAST-MODIFIED を除く「意味のある」
			// プロパティ名の集合)が一致することを確認する — buildVTodoCalendar が iOS 実機と
			// 同じ「形」の VTODO を組み立てていることの構造保証。
			const GENERATED_ONLY = new Set(["UID", "DTSTAMP", "CREATED", "LAST-MODIFIED", "X-APPLE-SORT-ORDER"]);
			const meaningfulNames = (c: Component) =>
				new Set(c.properties.map((p) => p.name).filter((n) => !GENERATED_ONLY.has(n)));
			expect([...meaningfulNames(generatedVTodo.raw)].sort()).toEqual([...meaningfulNames(fixtureVTodo.raw)].sort());
		});

		test("VTIMEZONE は §3.6.5 必須要素充足 + オフセット値一致で検証する(DTSTART 1951 vs 1970 は仕様上等価)", () => {
			const { vcalendar: fixtureVCalendar } = loadFixtureVTodo();
			const fixtureVTimezoneComponent = fixtureVCalendar.components.find((c) => c.name === "VTIMEZONE")!;
			const fixtureTzid = fixtureVTimezoneComponent.properties.find((p) => p.name === "TZID")?.value;

			const generatedVTimezone = buildVTimezone("Asia/Tokyo", {
				startMillis: Date.UTC(2026, 0, 1),
				endMillis: Date.UTC(2027, 0, 1),
			});

			// TZID 一致。
			expect(generatedVTimezone.properties.find((p) => p.name === "TZID")?.value).toBe(fixtureTzid);

			// TZOFFSETTO(=このゾーンの「今」有効なオフセット。解釈に実際に使われる値)は一致を要求する。
			// 【TZOFFSETFROM は比較しない理由】fixture 側は iOS 実機の歴史的1回限りの改定
			// (JST 制定=1951-09-09 に UTC+10→+09 へ変わった、という日本の実史)を反映して
			// TZOFFSETFROM=+1000(制定"前"のオフセット)を持つ。buildVTimezone は Phase 1
			// (固定オフセットゾーン限定)の設計上 TZOFFSETFROM=TZOFFSETTO で生成する
			// (vtimezone-write.ts の「窓内に遷移が無い」前提の帰結— DTSTART:19700101 以降は
			// 遷移が無いので FROM=TO で正しく、あえて 1951 年の史実改定を再現する必要が無い)。
			// よって TZOFFSETFROM は意図的に不一致であり、この設計の帰結を比較対象から外す。
			const fixtureStandard = fixtureVTimezoneComponent.components.find((c) => c.name === "STANDARD")!;
			const generatedStandard = generatedVTimezone.components.find((c) => c.name === "STANDARD")!;
			expect(generatedStandard.properties.find((p) => p.name === "TZOFFSETTO")?.value).toBe(
				fixtureStandard.properties.find((p) => p.name === "TZOFFSETTO")?.value,
			);
		});
	});
});
