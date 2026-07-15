// =============================================================================
// vevent-alarm.ts + vevent-patch.ts の通知(開始相対 VALARM)テスト(E-3 スライス S1.5)
// =============================================================================
// build/predicate/read の往復 + 「開始相対のみ管理・他 VALARM 温存」の patch を確認する。
import { describe, expect, test } from "bun:test";
import {
	buildStartRelativeAlarm,
	isStartRelativeAlarm,
	startRelativeAlarmMinutesBefore,
	patchVEventFields,
} from "../../../src/domain/ical/semantics";
import type { Component } from "../../../src/domain/ical/structure/types";

// 絶対トリガー VALARM(他クライアント/iOS 由来を模す。開始相対では「ない」ので温存対象)。
const absoluteAlarm: Component = {
	name: "VALARM",
	properties: [
		{ name: "ACTION", parameters: [], value: "DISPLAY" },
		{ name: "DESCRIPTION", parameters: [], value: "Reminder" },
		{ name: "TRIGGER", parameters: [{ name: "VALUE", values: ["DATE-TIME"] }], value: "20260715T003000Z" },
		{ name: "UID", parameters: [], value: "abs-1" },
	],
	components: [],
};

// 終了相対 VALARM(RELATED=END)。開始相対ではないので温存対象。
const endRelativeAlarm: Component = {
	name: "VALARM",
	properties: [
		{ name: "ACTION", parameters: [], value: "DISPLAY" },
		{ name: "DESCRIPTION", parameters: [], value: "Reminder" },
		{ name: "TRIGGER", parameters: [{ name: "RELATED", values: ["END"] }], value: "PT5M" },
	],
	components: [],
};

function veventWith(...alarms: Component[]): Component {
	return {
		name: "VEVENT",
		properties: [
			{ name: "UID", parameters: [], value: "ev-1" },
			{ name: "DTSTART", parameters: [{ name: "TZID", values: ["Asia/Tokyo"] }], value: "20260715T100000" },
		],
		components: alarms,
	};
}

describe("vevent-alarm 開始相対 VALARM プリミティブ", () => {
	test("build → isStartRelativeAlarm=true・minutesBefore を読み戻せる(0 は -PT0M)", () => {
		const a30 = buildStartRelativeAlarm(30, "u1");
		expect(isStartRelativeAlarm(a30)).toBe(true);
		expect(startRelativeAlarmMinutesBefore(a30)).toBe(30);
		// UID==X-WR-ALARMUID の流儀。
		expect(a30.properties.find((p) => p.name === "X-WR-ALARMUID")?.value).toBe("u1");

		const a0 = buildStartRelativeAlarm(0, "u2");
		expect(a0.properties.find((p) => p.name === "TRIGGER")?.value).toBe("-PT0M");
		expect(startRelativeAlarmMinutesBefore(a0)).toBe(0);
	});

	test("絶対トリガー・終了相対は開始相対と見なさない(管理対象外)", () => {
		expect(isStartRelativeAlarm(absoluteAlarm)).toBe(false);
		expect(isStartRelativeAlarm(endRelativeAlarm)).toBe(false);
		expect(startRelativeAlarmMinutesBefore(absoluteAlarm)).toBeUndefined();
	});
});

describe("patchVEventFields の alarms 全置換(開始相対のみ管理)", () => {
	test("配列で全置換すると開始相対だけ差し替わり、絶対/終了相対 VALARM は温存される", () => {
		const vevent = veventWith(absoluteAlarm, buildStartRelativeAlarm(15, "old"), endRelativeAlarm);
		const out = patchVEventFields(vevent, {
			alarms: [
				{ minutesBefore: 60, uid: "new-1" },
				{ minutesBefore: 0, uid: "new-2" },
			],
		});
		const valarms = out.components.filter((c) => c.name === "VALARM");
		// 絶対 + 終了相対(温存)+ 新規2件 = 4件。旧開始相対(15分前)は消える。
		expect(valarms).toHaveLength(4);
		expect(valarms).toContainEqual(absoluteAlarm);
		expect(valarms).toContainEqual(endRelativeAlarm);
		const managed = valarms.filter(isStartRelativeAlarm).map(startRelativeAlarmMinutesBefore).sort((a, b) => a! - b!);
		expect(managed).toEqual([0, 60]);
	});

	test("null で開始相対だけ全除去し、他 VALARM は温存する", () => {
		const vevent = veventWith(absoluteAlarm, buildStartRelativeAlarm(15, "old"));
		const out = patchVEventFields(vevent, { alarms: null });
		const valarms = out.components.filter((c) => c.name === "VALARM");
		expect(valarms).toEqual([absoluteAlarm]);
	});

	test("undefined(未指定)なら VALARM に一切触れない", () => {
		const vevent = veventWith(buildStartRelativeAlarm(15, "keep"));
		const out = patchVEventFields(vevent, { summary: "変更" });
		expect(out.components.filter((c) => c.name === "VALARM")).toHaveLength(1);
	});

	test("travelMinutes を設定/除去できる(X-APPLE-TRAVEL-DURATION)", () => {
		const set = patchVEventFields(veventWith(), { travelMinutes: 20 });
		expect(set.properties.find((p) => p.name === "X-APPLE-TRAVEL-DURATION")?.value).toBe("PT20M");
		const cleared = patchVEventFields(set, { travelMinutes: null });
		expect(cleared.properties.find((p) => p.name === "X-APPLE-TRAVEL-DURATION")).toBeUndefined();
	});
});
