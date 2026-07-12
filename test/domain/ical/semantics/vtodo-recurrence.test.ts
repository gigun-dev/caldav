// =============================================================================
// vtodo-recurrence テスト(D4 モデル: 反復 VTODO 完了。E-1 スライス②-c)
// =============================================================================
// buildCompletionSnapshot は実機フィクスチャ2本(vtodo-recurring-master.ics /
// vtodo-recurring-completed-instance.ics)を突き合わせて検証する。
// advanceMasterToNextOccurrence は同じマスターに対して IcaljsRRuleIterator を実際に注入し、
// DUE の週次前進(7/12→7/18→7/19→7/25→7/26→exhausted)を確認する。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse, serialize } from "../../../../src/domain/ical";
import { ICalendarObject, VTodo } from "../../../../src/domain/ical/semantics";
import {
	advanceMasterToNextOccurrence,
	buildCompletionSnapshot,
	type NowStamp,
} from "../../../../src/domain/ical/semantics";
import { zoneResolverFor } from "../../../../src/domain/ical/recurrence";
import { IcaljsRRuleIterator } from "../../../../src/infrastructure/recurrence/icaljs-rrule-iterator";
import type { Component } from "../../../../src/domain/ical";

const fixture = (name: string): string =>
	readFileSync(`${import.meta.dir}/../fixtures/real-ios/${name}`, "utf8");

const MASTER_ICS = fixture("vtodo-recurring-master.ics");
const COMPLETED_INSTANCE_ICS = fixture("vtodo-recurring-completed-instance.ics");

function masterVTodoComponent(): Component {
	const cal = ICalendarObject.fromComponent(parse(MASTER_ICS));
	return cal.todos()[0]!.raw;
}

const NOW: NowStamp = { utcRaw: "20260712T111359Z", unixSeconds: 1783941219 };

describe("buildCompletionSnapshot", () => {
	test("実機フィクスチャ(completed-instance.ics)と構造一致する", () => {
		const master = masterVTodoComponent();
		let alarmSeq = 0;
		const snapshot = buildCompletionSnapshot(
			master,
			{ uid: "99C71199-96C9-467D-96C9-5C6069EC6E97", nextAlarmUid: () => `alarm-${++alarmSeq}` },
			NOW,
		);

		const expected = VTodo.fromComponent(
			ICalendarObject.fromComponent(parse(COMPLETED_INSTANCE_ICS)).todos()[0]!.raw,
		);
		const got = VTodo.fromComponent(snapshot);

		// RRULE 無し。
		expect(got.rrule).toBeUndefined();
		// 三点セット。
		expect(got.status).toBe("COMPLETED");
		expect(got.percentComplete).toBe(100);
		expect(got.completed).not.toBeUndefined();
		// DTSTART/DUE は TZID params ごとマスターと同値(fixture でも同じ)。
		expect(got.dtstart).toEqual(expected.dtstart);
		expect(got.due).toEqual(expected.due);
		// CREATED/DTSTAMP/LAST-MODIFIED = now。
		expect(got.raw.properties.find((p) => p.name === "CREATED")?.value).toBe(NOW.utcRaw);
		expect(got.raw.properties.find((p) => p.name === "DTSTAMP")?.value).toBe(NOW.utcRaw);
		expect(got.raw.properties.find((p) => p.name === "LAST-MODIFIED")?.value).toBe(NOW.utcRaw);
		// SUMMARY 素通し。
		expect(got.summary).toBe(expected.summary);
		// UID は新採番。
		expect(got.uid).toBe("99C71199-96C9-467D-96C9-5C6069EC6E97");

		// VALARM: TRIGGER/ACTION/DESCRIPTION は不変、UID==X-WR-ALARMUID==新採番(スタブ採番で決定的)。
		const alarm = got.alarms()[0]!;
		const expectedAlarm = expected.alarms()[0]!;
		expect(alarm.raw.properties.find((p) => p.name === "TRIGGER")?.value).toBe(
			expectedAlarm.raw.properties.find((p) => p.name === "TRIGGER")?.value,
		);
		expect(alarm.raw.properties.find((p) => p.name === "ACTION")?.value).toBe("DISPLAY");
		expect(alarm.raw.properties.find((p) => p.name === "DESCRIPTION")?.value).toBe("Reminder");
		const alarmUid = alarm.raw.properties.find((p) => p.name === "UID")?.value;
		const alarmWrUid = alarm.raw.properties.find((p) => p.name === "X-WR-ALARMUID")?.value;
		expect(alarmUid).toBe("alarm-1");
		expect(alarmWrUid).toBe("alarm-1");
	});

	test("純関数性: 入力 Component は変更されない", () => {
		const master = masterVTodoComponent();
		const before = serialize({ name: "VCALENDAR", properties: [], components: [master] });
		buildCompletionSnapshot(master, { uid: "x", nextAlarmUid: () => "y" }, NOW);
		const after = serialize({ name: "VCALENDAR", properties: [], components: [master] });
		expect(after).toBe(before);
	});
});

describe("advanceMasterToNextOccurrence", () => {
	const iterator = new IcaljsRRuleIterator();
	const zoneOf = (tzid: string): string => {
		// フィクスチャに VTIMEZONE:Asia/Tokyo があるので実際は zoneResolverFor を使うが、
		// ここでは単体で呼ぶテストのため素朴に tzid をそのまま IANA 名として渡す
		// (Asia/Tokyo は IANA 名そのものなので resolveTimeZoneId の①段で解決できる)。
		return tzid;
	};

	function due(component: Component): string {
		return VTodo.fromComponent(component).raw.properties.find((p) => p.name === "DUE")!.value;
	}
	function rruleRaw(component: Component): string {
		return VTodo.fromComponent(component).raw.properties.find((p) => p.name === "RRULE")!.value;
	}

	test("DUE が週次で 7/12→7/18→7/19→7/25→7/26 と前進し RRULE(UNTIL 含む)はバイト不変・STATUS:NEEDS-ACTION", () => {
		let current = masterVTodoComponent();
		const expectedDue = [
			"20260718T211000",
			"20260719T211000",
			"20260725T211000",
			"20260726T211000",
		];
		const rruleBefore = rruleRaw(current);
		for (const expected of expectedDue) {
			const result = advanceMasterToNextOccurrence(current, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error(`expected advanced, got ${result.kind}`);
			expect(due(result.vtodo)).toBe(expected);
			expect(rruleRaw(result.vtodo)).toBe(rruleBefore); // UNTIL のとき RRULE は前進しても不変。
			expect(VTodo.fromComponent(result.vtodo).status).toBe("NEEDS-ACTION");
			current = result.vtodo;
		}
	});

	test("UNTIL(20260731T111300Z)を超えたら exhausted", () => {
		let current = masterVTodoComponent();
		for (let i = 0; i < 4; i++) {
			const result = advanceMasterToNextOccurrence(current, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error("expected advanced during warm-up");
			current = result.vtodo;
		}
		// current の DUE は 7/26。次候補は 8/1(WEEKLY;BYDAY=SU,SA の次は土曜 8/1)で UNTIL を超える。
		const result = advanceMasterToNextOccurrence(current, iterator, zoneOf);
		expect(result.kind).toBe("exhausted");
	});

	test("COUNT=3→2、COUNT=1→exhausted", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:count-test",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DUE:20260101T100000Z",
			"RRULE:FREQ=DAILY;COUNT=3",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const master = cal.todos()[0]!.raw;

		const r1 = advanceMasterToNextOccurrence(master, iterator, zoneOf);
		if (r1.kind !== "advanced") throw new Error("expected advanced");
		expect(rruleRaw(r1.vtodo)).toBe("FREQ=DAILY;COUNT=2");

		const r2 = advanceMasterToNextOccurrence(r1.vtodo, iterator, zoneOf);
		if (r2.kind !== "advanced") throw new Error("expected advanced");
		expect(rruleRaw(r2.vtodo)).toBe("FREQ=DAILY;COUNT=1");

		const r3 = advanceMasterToNextOccurrence(r2.vtodo, iterator, zoneOf);
		expect(r3.kind).toBe("exhausted");
	});

	test("VALUE=DATE 反復(FREQ=DAILY)は VALUE=DATE のまま前進する", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:date-test",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260101",
			"DUE;VALUE=DATE:20260103",
			"RRULE:FREQ=DAILY;COUNT=3;BYHOUR=9",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const master = cal.todos()[0]!.raw;

		const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
		if (result.kind !== "advanced") throw new Error("expected advanced");
		const vtodo = VTodo.fromComponent(result.vtodo);
		expect(vtodo.raw.properties.find((p) => p.name === "DTSTART")?.value).toBe("20260102");
		// DATE dtstart なので BYHOUR は無視される(構文上残っていても展開に影響しないことの確認)。
		expect(vtodo.raw.properties.find((p) => p.name === "DTSTART")?.parameters[0]?.values[0]).toBe("DATE");
		// DUE-DTSTART の日数差(2日)を保持。
		expect(vtodo.raw.properties.find((p) => p.name === "DUE")?.value).toBe("20260104");
	});

	test("DUE≠DTSTART の差分保持・DUE 無しは DTSTART のみ前進する", () => {
		const withDue = masterVTodoComponent();
		const r = advanceMasterToNextOccurrence(withDue, iterator, zoneOf);
		if (r.kind !== "advanced") throw new Error("expected advanced");
		// このフィクスチャは DTSTART==DUE(差分0)。差分ありのケースは COUNT テストの DATE ケースで検証済み。
		expect(due(r.vtodo)).toBe(VTodo.fromComponent(r.vtodo).raw.properties.find((p) => p.name === "DTSTART")!.value);

		const noDueIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:no-due-test",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"RRULE:FREQ=DAILY;COUNT=2",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(noDueIcs));
		const master = cal.todos()[0]!.raw;
		const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
		if (result.kind !== "advanced") throw new Error("expected advanced");
		expect(VTodo.fromComponent(result.vtodo).raw.properties.some((p) => p.name === "DUE")).toBe(false);
	});

	test("純関数性: 入力 Component は変更されない", () => {
		const master = masterVTodoComponent();
		const before = serialize({ name: "VCALENDAR", properties: [], components: [master] });
		advanceMasterToNextOccurrence(master, iterator, zoneOf);
		const after = serialize({ name: "VCALENDAR", properties: [], components: [master] });
		expect(after).toBe(before);
	});

	test("zoneResolverFor 経由(実際の VTIMEZONE 解決)でも同じ結果になる", () => {
		const cal = ICalendarObject.fromComponent(parse(MASTER_ICS));
		const master = cal.todos()[0]!.raw;
		const result = advanceMasterToNextOccurrence(master, iterator, zoneResolverFor(cal));
		if (result.kind !== "advanced") throw new Error("expected advanced");
		expect(due(result.vtodo)).toBe("20260718T211000");
	});
});
