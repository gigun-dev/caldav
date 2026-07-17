// =============================================================================
// task-dto ユニットテスト — LOCATION / RRULE の additive 拡張(2026-07-14)
// =============================================================================
// taskFromVTodo が返す Task.location / Task.recurrence を狙い撃ちで検証する。他の既存
// フィールド(due/priority/notes 等)は list-todos.test.ts / create-todo.test.ts 等で
// 既にカバー済みなので、ここでは新規フィールドの振る舞い(値あり/なし・degrade)に絞る
// (テストコード=What の原則。何を保証するかをテスト名で表現する)。
import { describe, expect, test } from "bun:test";
import { parse } from "../../src/domain/ical";
import { ICalendarObject } from "../../src/domain/ical/semantics";
import { taskFromVTodo } from "../../src/application/usecases/task-dto";

// VCALENDAR 1枚 + VTODO 1個のミニマル ICS を組み立てる(list-todos.test.ts と同じ流儀)。
function vtodoIcs(lines: string[]): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", "BEGIN:VTODO", ...lines, "END:VTODO", "END:VCALENDAR"].join(
		"\r\n",
	);
}

function firstTodo(ics: string) {
	return ICalendarObject.fromComponent(parse(ics)).todos()[0]!;
}

describe("taskFromVTodo: location", () => {
	test("LOCATION が無ければ null", () => {
		const ics = vtodoIcs(["UID:t1", "DTSTAMP:20260101T000000Z", "SUMMARY:牛乳を買う"]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.location).toBeNull();
	});

	test("LOCATION があれば decodeText した値を返す(エスケープ解除)", () => {
		// TEXT 値のエスケープ(§3.3.11): カンマ・セミコロンは \, \; でエスケープされる。
		const ics = vtodoIcs(["UID:t2", "DTSTAMP:20260101T000000Z", "SUMMARY:買い物", "LOCATION:渋谷\\, 東京"]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.location).toBe("渋谷, 東京");
	});
});

describe("taskFromVTodo: structuredLocation / proximityAlarm(C1・設計 05 §1-a)", () => {
	test("proximity/場所いずれも無ければ両フィールド null", () => {
		const ics = vtodoIcs(["UID:t-noloc", "DTSTAMP:20260101T000000Z", "SUMMARY:場所なし"]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.structuredLocation).toBeNull();
		expect(task.proximityAlarm).toBeNull();
	});

	test("自宅到着 VTODO: proximityAlarm に ARRIVE + VALARM 内 location が載る", () => {
		const ics = vtodoIcs([
			"UID:t-home",
			"DTSTAMP:20260101T000000Z",
			"SUMMARY:自宅に到着時に通知",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
			"X-APPLE-PROXIMITY:ARRIVE",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE=福登の自宅:geo:35.017639,136.954547",
			"END:VALARM",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.proximityAlarm).toEqual({
			proximity: "ARRIVE",
			location: { title: "福登の自宅", address: null, geo: { lat: 35.017639, lon: 136.954547 }, radiusMeters: 100 },
		});
		// VTODO 直下に structured-location は無いので structuredLocation は null(場所は proximity 側)。
		expect(task.structuredLocation).toBeNull();
	});
});

describe("taskFromVTodo: recurrence", () => {
	test("RRULE が無ければ null", () => {
		const ics = vtodoIcs(["UID:r0", "DTSTAMP:20260101T000000Z", "SUMMARY:単発タスク"]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toBeNull();
	});

	test("FREQ=WEEKLY;BYDAY=MO,WE → chat 語彙 weekly + weekdays 配列", () => {
		const ics = vtodoIcs([
			"UID:r1",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:週次タスク",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toEqual({
			frequency: "weekly",
			interval: 1, // INTERVAL 未指定 → RFC 既定値 1 を補完する設計(Task.recurrence の JSDoc 参照)。
			weekdays: ["MO", "WE"],
			count: null,
			until: null,
		});
	});

	test("COUNT 指定 → count に数値、until は null", () => {
		const ics = vtodoIcs([
			"UID:r2",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:5回だけ",
			"RRULE:FREQ=DAILY;COUNT=5",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toEqual({
			frequency: "daily",
			interval: 1,
			weekdays: null,
			count: 5,
			until: null,
		});
	});

	test("UNTIL=DATE 指定 → until が YYYY-MM-DD 文字列、count は null", () => {
		const ics = vtodoIcs([
			"UID:r3",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:年末まで毎週",
			"RRULE:FREQ=WEEKLY;UNTIL=20261231",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toEqual({
			frequency: "weekly",
			interval: 1,
			weekdays: null,
			count: null,
			until: "2026-12-31",
		});
	});

	test("UNTIL=DATE-TIME(UTC) 指定 → until が offset 付き ISO8601('...Z')", () => {
		const ics = vtodoIcs([
			"UID:r4",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;TZID=Asia/Tokyo:20260101T090000",
			"DUE;TZID=Asia/Tokyo:20260101T090000",
			"SUMMARY:時刻付き反復",
			"RRULE:FREQ=DAILY;UNTIL=20260201T000000Z",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence?.frequency).toBe("daily");
		expect(task.recurrence?.until).toBe("2026-02-01T00:00:00Z");
	});

	test("INTERVAL 明示指定は補完せずそのまま反映する", () => {
		const ics = vtodoIcs([
			"UID:r5",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:隔週タスク",
			"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toEqual({
			frequency: "weekly",
			interval: 2,
			weekdays: ["MO"],
			count: null,
			until: null,
		});
	});

	test("chat 語彙に無い FREQ(HOURLY)は degrade して生の FREQ 値を frequency に返す", () => {
		const ics = vtodoIcs([
			"UID:r6",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:毎時タスク",
			"RRULE:FREQ=HOURLY;INTERVAL=3",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		// create-todo の chat 語彙(daily/weekly/monthly/yearly)には HOURLY が無いので、
		// 丸めずに RRULE の生 FREQ("HOURLY")をそのまま返す degrade 方針(Task.recurrence JSDoc)。
		expect(task.recurrence?.frequency).toBe("HOURLY");
		expect(task.recurrence?.interval).toBe(3);
	});

	test("構文的に不正な RRULE は例外にせず、生の RRULE 値を frequency に degrade して返す", () => {
		// FREQ 欠落は parseRecurrenceRule が InvalidValueError を投げる不正値(§3.3.10 は FREQ 必須)。
		const ics = vtodoIcs([
			"UID:r7",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:壊れたRRULE",
			"RRULE:COUNT=3",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence).toEqual({
			frequency: "COUNT=3",
			interval: 1,
			weekdays: null,
			count: null,
			until: null,
		});
	});

	test("序数付き BYDAY(FREQ=MONTHLY;BYDAY=2MO)はロスレスに '2MO' で返す", () => {
		const ics = vtodoIcs([
			"UID:r8",
			"DTSTAMP:20260101T000000Z",
			"DUE;VALUE=DATE:20260106",
			"SUMMARY:第2月曜",
			"RRULE:FREQ=MONTHLY;BYDAY=2MO",
		]);
		const task = taskFromVTodo(firstTodo(ics));
		expect(task.recurrence?.weekdays).toEqual(["2MO"]);
		expect(task.recurrence?.frequency).toBe("monthly");
	});
});
