// =============================================================================
// semantics/vtodo-patch.ts のテスト(E-1 スライス②-b 新設)
// =============================================================================
// patchVTodoFields/applyCompletion/applyReopen が「指定したプロパティだけを触り、
// 他(VALARM/VTIMEZONE/未指定プロパティ)には一切触れない」ことを検証する。
// vtodo-recurring-master.ics(VALARM/VTIMEZONE 同梱の実機フィクスチャ)を使い、
// ロスレス編集であることを構造的に確認する。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyCompletion,
	applyReopen,
	patchVTodoFields,
	pruneUnreferencedVTimezones,
	removeDueAnchoredAlarmTriggers,
	removeProximityAlarms,
	upsertProximityAlarm,
} from "../../../src/domain/ical/semantics/vtodo-patch";
import type { NowStamp } from "../../../src/domain/ical/semantics/vtodo-stamp";
import { parse } from "../../../src/domain/ical/parse/parser";
import type { Component } from "../../../src/domain/ical/structure/types";

const NOW: NowStamp = { utcRaw: "20260713T090000Z", unixSeconds: 1783933200 };

function emptyVTodo(): Component {
	return { name: "VTODO", properties: [], components: [] };
}

function propValue(c: Component, name: string): string | undefined {
	return c.properties.find((p) => p.name === name)?.value;
}

function loadRecurringMasterVTodo(): Component {
	const ics = readFileSync(
		join(__dirname, "fixtures/real-ios/vtodo-recurring-master.ics"),
		"utf-8",
	);
	const vcalendar = parse(ics);
	const vtodo = vcalendar.components.find((c) => c.name === "VTODO");
	if (vtodo === undefined) throw new Error("fixture has no VTODO");
	return vtodo;
}

describe("patchVTodoFields", () => {
	test("summary のみ指定すると SUMMARY だけが変わる", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [
				{ name: "SUMMARY", parameters: [], value: "old" },
				{ name: "PRIORITY", parameters: [], value: "5" },
			],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { summary: "new" });
		expect(propValue(out, "SUMMARY")).toBe("new");
		expect(propValue(out, "PRIORITY")).toBe("5"); // 触っていない
	});

	test("due を指定すると DTSTART/DUE が VALUE=DATE で同値 upsert される", () => {
		const out = patchVTodoFields(emptyVTodo(), { due: { kind: "date", raw: "20260715" } });
		expect(propValue(out, "DTSTART")).toBe("20260715");
		expect(propValue(out, "DUE")).toBe("20260715");
		const dtstart = out.properties.find((p) => p.name === "DTSTART");
		expect(dtstart?.parameters).toEqual([{ name: "VALUE", values: ["DATE"] }]);
	});

	test("priority:0 は PRIORITY を削除する(§3.8.1.9: 0=未定義)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "PRIORITY", parameters: [], value: "5" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { priority: 0 });
		expect(propValue(out, "PRIORITY")).toBeUndefined();
	});

	test("priority が正の値なら PRIORITY を upsert する", () => {
		const out = patchVTodoFields(emptyVTodo(), { priority: 1 });
		expect(propValue(out, "PRIORITY")).toBe("1");
	});

	test("undefined のフィールドには一切触れない(何も指定しなければ元のまま)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "keep" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, {});
		expect(out).toEqual(vtodo);
	});

	test("実機フィクスチャ(VALARM/VTIMEZONE 同梱)に対して指定外のプロパティ・サブコンポーネントは不変", () => {
		const vtodo = loadRecurringMasterVTodo();
		const out = patchVTodoFields(vtodo, { summary: "renamed" });

		expect(propValue(out, "SUMMARY")).toBe("renamed");
		// RRULE/UID/STATUS 等の未指定プロパティは値が変わらない。
		expect(propValue(out, "RRULE")).toBe(propValue(vtodo, "RRULE"));
		expect(propValue(out, "UID")).toBe(propValue(vtodo, "UID"));
		expect(propValue(out, "STATUS")).toBe(propValue(vtodo, "STATUS"));
		// VALARM サブコンポーネントは構造ごと不変(ロスレス編集の核心)。
		expect(out.components).toEqual(vtodo.components);
	});

	// --- A-2 回帰テスト群 ------------------------------------------------------------------
	// iOS 発の反復マスターは DTSTART;TZID=...(DATE-TIME) + RRULE の UNTIL も DATE-TIME
	// (§3.3.10 ③ TZID/UTC 付き DTSTART → UNTIL は UTC 形式)。due を「終日(DATE)」に変更する
	// patchVTodoFields の due 分岐は DTSTART/DUE を VALUE=DATE に書き換えるが、RRULE の UNTIL を
	// 追従させないと DTSTART=DATE なのに UNTIL=DATE-TIME という I6 違反(RFC 5545 §3.3.10)状態が
	// 残ってしまう。vtodo-recurring-master.ics(RRULE:FREQ=WEEKLY;UNTIL=20260731T111300Z;BYDAY=SU,SA)
	// を使い、UNTIL が日付部分だけ残して DATE 化されることを確認する。

	test("due を DATE に patch すると RRULE:UNTIL(DATE-TIME) も DATE に追従する(A-2)", () => {
		const vtodo = loadRecurringMasterVTodo();
		expect(propValue(vtodo, "RRULE")).toBe("FREQ=WEEKLY;UNTIL=20260731T111300Z;BYDAY=SU,SA");

		const out = patchVTodoFields(vtodo, { due: { kind: "date", raw: "20260801" } });

		// UNTIL の日付部分(20260731)はそのまま、時刻(T111300Z)だけ落ちて DATE 型になる。
		expect(propValue(out, "RRULE")).toBe("FREQ=WEEKLY;UNTIL=20260731;BYDAY=SU,SA");
		expect(propValue(out, "DTSTART")).toBe("20260801");
		expect(propValue(out, "DUE")).toBe("20260801");
	});

	test("RRULE が無ければ何もしない(UNTIL 追従の対象がない)", () => {
		const out = patchVTodoFields(emptyVTodo(), { due: { kind: "date", raw: "20260715" } });
		expect(propValue(out, "RRULE")).toBeUndefined();
	});

	test("RRULE に UNTIL が無ければ(COUNT 等)不変", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "RRULE", parameters: [], value: "FREQ=DAILY;COUNT=5" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { due: { kind: "date", raw: "20260715" } });
		expect(propValue(out, "RRULE")).toBe("FREQ=DAILY;COUNT=5");
	});

	test("UNTIL が既に DATE 型なら不変", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "RRULE", parameters: [], value: "FREQ=DAILY;UNTIL=20260801" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { due: { kind: "date", raw: "20260715" } });
		expect(propValue(out, "RRULE")).toBe("FREQ=DAILY;UNTIL=20260801");
	});

	// --- V6 フォローアップ: 時刻付き due(kind:"date-time")---------------------------------
	test("kind:date-time は DTSTART/DUE を TZID 付きで同値 upsert する", () => {
		const out = patchVTodoFields(emptyVTodo(), { due: { kind: "date-time", raw: "20260715T090000", tzid: "Asia/Tokyo" } });
		expect(propValue(out, "DTSTART")).toBe("20260715T090000");
		expect(propValue(out, "DUE")).toBe("20260715T090000");
		const dtstart = out.properties.find((p) => p.name === "DTSTART");
		expect(dtstart?.parameters).toEqual([{ name: "TZID", values: ["Asia/Tokyo"] }]);
	});

	test("終日→時刻付きに変えると DTSTART の VALUE=DATE が TZID に置き換わる(残らない)", () => {
		const allDay = patchVTodoFields(emptyVTodo(), { due: { kind: "date", raw: "20260715" } });
		const timed = patchVTodoFields(allDay, { due: { kind: "date-time", raw: "20260715T090000", tzid: "Asia/Tokyo" } });
		const dtstart = timed.properties.find((p) => p.name === "DTSTART");
		// VALUE=DATE パラメータは消え TZID だけになる(upsertProperty が Property ごと丸ごと置換)。
		expect(dtstart?.parameters).toEqual([{ name: "TZID", values: ["Asia/Tokyo"] }]);
		expect(propValue(timed, "DTSTART")).toBe("20260715T090000");
	});

	test("時刻付き化すると RRULE:UNTIL(DATE) が DATE-TIME(UTC)に追従する(I6・逆方向)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [
				{ name: "DTSTART", parameters: [{ name: "VALUE", values: ["DATE"] }], value: "20260715" },
				{ name: "RRULE", parameters: [], value: "FREQ=DAILY;UNTIL=20260731" },
			],
			components: [],
		};
		// 新 due の壁時計 09:00 JST(+09:00)= UTC 00:00。UNTIL の日付 20260731 + 09:00 JST = 20260731T000000Z。
		const out = patchVTodoFields(vtodo, { due: { kind: "date-time", raw: "20260715T090000", tzid: "Asia/Tokyo" } });
		expect(propValue(out, "RRULE")).toBe("FREQ=DAILY;UNTIL=20260731T000000Z");
	});

	// --- V6 フォローアップ: due 除去(kind:"remove")---------------------------------------
	test("kind:remove は DTSTART/DUE を取り除く(他プロパティは不変)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [
				{ name: "SUMMARY", parameters: [], value: "keep" },
				{ name: "DTSTART", parameters: [{ name: "VALUE", values: ["DATE"] }], value: "20260715" },
				{ name: "DUE", parameters: [{ name: "VALUE", values: ["DATE"] }], value: "20260715" },
			],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { due: { kind: "remove" } });
		expect(propValue(out, "DTSTART")).toBeUndefined();
		expect(propValue(out, "DUE")).toBeUndefined();
		expect(propValue(out, "SUMMARY")).toBe("keep");
	});

	test("kind:remove は RRULE があると防御的に throw する(アンカー無し反復を作らない)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [
				{ name: "DTSTART", parameters: [{ name: "VALUE", values: ["DATE"] }], value: "20260715" },
				{ name: "RRULE", parameters: [], value: "FREQ=DAILY;COUNT=5" },
			],
			components: [],
		};
		expect(() => patchVTodoFields(vtodo, { due: { kind: "remove" } })).toThrow(/RRULE/);
	});
});

describe("removeDueAnchoredAlarmTriggers", () => {
	function vtodoWithAlarms(): Component {
		return {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "t" }],
			components: [
				// 絶対トリガー(期日依存)。
				{
					name: "VALARM",
					properties: [
						{ name: "ACTION", parameters: [], value: "DISPLAY" },
						{ name: "TRIGGER", parameters: [{ name: "VALUE", values: ["DATE-TIME"] }], value: "20260715T000000Z" },
					],
					components: [],
				},
				// 相対トリガー(DTSTART/DUE 依存)。
				{
					name: "VALARM",
					properties: [
						{ name: "ACTION", parameters: [], value: "DISPLAY" },
						{ name: "TRIGGER", parameters: [{ name: "RELATED", values: ["START"] }], value: "-PT15M" },
					],
					components: [],
				},
				// 位置アラーム(期日非依存)。
				{
					name: "VALARM",
					properties: [
						{ name: "ACTION", parameters: [], value: "DISPLAY" },
						{ name: "X-APPLE-PROXIMITY", parameters: [], value: "DEPART" },
						{ name: "TRIGGER", parameters: [], value: "-PT0S" },
					],
					components: [],
				},
			],
		};
	}

	test("期日依存アラーム(絶対 + 相対)を除去し、位置アラーム(X-APPLE-PROXIMITY)は残す", () => {
		const out = removeDueAnchoredAlarmTriggers(vtodoWithAlarms());
		const alarms = out.components.filter((c) => c.name === "VALARM");
		expect(alarms).toHaveLength(1);
		expect(alarms[0]?.properties.some((p) => p.name === "X-APPLE-PROXIMITY")).toBe(true);
	});
});

describe("applyCompletion", () => {
	test("STATUS:COMPLETED / COMPLETED:<now> / PERCENT-COMPLETE:100 の三点セットを upsert する", () => {
		const out = applyCompletion(emptyVTodo(), NOW);
		expect(propValue(out, "STATUS")).toBe("COMPLETED");
		expect(propValue(out, "COMPLETED")).toBe("20260713T090000Z");
		expect(propValue(out, "PERCENT-COMPLETE")).toBe("100");
	});

	test("他のプロパティ・サブコンポーネントには触れない", () => {
		const vtodo = loadRecurringMasterVTodo();
		const out = applyCompletion(vtodo, NOW);
		expect(propValue(out, "SUMMARY")).toBe(propValue(vtodo, "SUMMARY"));
		expect(propValue(out, "RRULE")).toBe(propValue(vtodo, "RRULE"));
		expect(out.components).toEqual(vtodo.components);
	});
});

describe("pruneUnreferencedVTimezones", () => {
	// 2026-07-15 是正: update-todo で due+recurrence を両方外すと、どのプロパティからも
	// TZID 参照されなくなった VTIMEZONE が VCALENDAR に取り残される(本番 D1 で確認)。
	// この関数はそのケースの掃除役。VCALENDAR.components 相当の配列を受け取る。

	function vtimezone(tzid: string): Component {
		return {
			name: "VTIMEZONE",
			properties: [{ name: "TZID", parameters: [], value: tzid }],
			components: [
				{
					name: "STANDARD",
					properties: [
						{ name: "DTSTART", parameters: [], value: "19700101T000000" },
						{ name: "TZOFFSETFROM", parameters: [], value: "+0900" },
						{ name: "TZOFFSETTO", parameters: [], value: "+0900" },
					],
					components: [],
				},
			],
		};
	}

	test("due+recurrence 除去後(TZID 参照ゼロ)の VTIMEZONE は取り除かれる", () => {
		// due/recurrence を外した後の VTODO(patchVTodoFields(due:"remove")+recurrence:null 相当の
		// 結果を模した最終形): TZID 参照を持つプロパティが一つも無い。
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "no due, no recurrence" }],
			components: [],
		};
		const components = [vtimezone("Asia/Tokyo"), vtodo];
		const out = pruneUnreferencedVTimezones(components);
		expect(out).toEqual([vtodo]);
	});

	test("DUE 以外(DTSTART)が TZID を参照していれば VTIMEZONE は消えない", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "DTSTART", parameters: [{ name: "TZID", values: ["Asia/Tokyo"] }], value: "20260715T090000" }],
			components: [],
		};
		const tz = vtimezone("Asia/Tokyo");
		const out = pruneUnreferencedVTimezones([tz, vtodo]);
		expect(out).toEqual([tz, vtodo]);
	});

	test("VALARM(サブコンポーネント)からの TZID 参照でも消えない(再帰走査)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "t" }],
			components: [
				{
					name: "VALARM",
					properties: [
						{ name: "ACTION", parameters: [], value: "DISPLAY" },
						// 通常 VALARM の TRIGGER は TZID を持たないが、走査ロジックが
						// 「全コンポーネントの全プロパティ」を再帰的に見ることを確認する目的で
						// 意図的に TZID パラメータを持つプロパティを仕込む。
						{ name: "X-TEST-TZID-REF", parameters: [{ name: "TZID", values: ["Asia/Tokyo"] }], value: "dummy" },
					],
					components: [],
				},
			],
		};
		const tz = vtimezone("Asia/Tokyo");
		const out = pruneUnreferencedVTimezones([tz, vtodo]);
		expect(out).toEqual([tz, vtodo]);
	});

	test("複数 VTIMEZONE のうち、参照が残るものだけ選択的に残す", () => {
		const tokyo = vtimezone("Asia/Tokyo");
		const losAngeles = vtimezone("America/Los_Angeles");
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "DTSTART", parameters: [{ name: "TZID", values: ["Asia/Tokyo"] }], value: "20260715T090000" }],
			components: [],
		};
		// Asia/Tokyo は参照あり(残る)、America/Los_Angeles は参照なし(消える)。
		const out = pruneUnreferencedVTimezones([tokyo, losAngeles, vtodo]);
		expect(out).toEqual([tokyo, vtodo]);
	});

	test("VTIMEZONE 以外のコンポーネントの並び・内容は一切変えない", () => {
		const vtodo1: Component = { name: "VTODO", properties: [{ name: "SUMMARY", parameters: [], value: "a" }], components: [] };
		const vtodo2: Component = { name: "VTODO", properties: [{ name: "SUMMARY", parameters: [], value: "b" }], components: [] };
		const out = pruneUnreferencedVTimezones([vtimezone("Asia/Tokyo"), vtodo1, vtodo2]);
		expect(out).toEqual([vtodo1, vtodo2]);
	});
});

describe("applyReopen", () => {
	test("STATUS:NEEDS-ACTION に戻し、COMPLETED/PERCENT-COMPLETE を削除する", () => {
		const completed: Component = {
			name: "VTODO",
			properties: [
				{ name: "STATUS", parameters: [], value: "COMPLETED" },
				{ name: "COMPLETED", parameters: [], value: "20260710T045638Z" },
				{ name: "PERCENT-COMPLETE", parameters: [], value: "100" },
				{ name: "SUMMARY", parameters: [], value: "keep" },
			],
			components: [],
		};
		const out = applyReopen(completed);
		expect(propValue(out, "STATUS")).toBe("NEEDS-ACTION");
		expect(propValue(out, "COMPLETED")).toBeUndefined();
		expect(propValue(out, "PERCENT-COMPLETE")).toBeUndefined();
		expect(propValue(out, "SUMMARY")).toBe("keep"); // 触っていない
	});
});

// --- proximity(位置)VALARM の add/remove(#51 Phase 1)------------------------------------
describe("upsertProximityAlarm / removeProximityAlarms", () => {
	// 時刻アラーム(絶対トリガー)を1個持つ VTODO。proximity 操作がこれに干渉しないことを確認する。
	function vtodoWithTimeAlarm(): Component {
		return {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "t" }],
			components: [
				{
					name: "VALARM",
					properties: [
						{ name: "ACTION", parameters: [], value: "DISPLAY" },
						{ name: "TRIGGER", parameters: [{ name: "VALUE", values: ["DATE-TIME"] }], value: "20260715T000000Z" },
					],
					components: [],
				},
			],
		};
	}

	test("upsert で proximity VALARM が1個足され、時刻アラームは温存される(共存)", () => {
		const out = upsertProximityAlarm(vtodoWithTimeAlarm(), { title: "自宅", lat: 1, lon: 2, trigger: "arrive" });
		const alarms = out.components.filter((c) => c.name === "VALARM");
		expect(alarms).toHaveLength(2); // 時刻 + 位置。
		const proximity = alarms.filter((a) => a.properties.some((p) => p.name === "X-APPLE-PROXIMITY"));
		expect(proximity).toHaveLength(1);
		// 時刻アラーム(X-APPLE-PROXIMITY 無し)は消えていない。
		expect(alarms.some((a) => !a.properties.some((p) => p.name === "X-APPLE-PROXIMITY"))).toBe(true);
	});

	test("upsert を2回呼んでも proximity は1個に保たれる(差し替え)", () => {
		let out = upsertProximityAlarm(vtodoWithTimeAlarm(), { title: "自宅", lat: 1, lon: 2, trigger: "arrive" });
		out = upsertProximityAlarm(out, { title: "オフィス", lat: 3, lon: 4, trigger: "arrive" });
		const proximity = out.components.filter(
			(c) => c.name === "VALARM" && c.properties.some((p) => p.name === "X-APPLE-PROXIMITY"),
		);
		expect(proximity).toHaveLength(1);
		const loc = proximity[0]!.properties.find((p) => p.name === "X-APPLE-STRUCTURED-LOCATION")!;
		expect(loc.parameters.find((p) => p.name === "X-TITLE")?.values[0]).toBe("オフィス"); // 新しい方に差し替わる。
	});

	test("remove で proximity VALARM だけ消え、時刻アラームは残る", () => {
		const withProx = upsertProximityAlarm(vtodoWithTimeAlarm(), { title: "自宅", lat: 1, lon: 2, trigger: "arrive" });
		const out = removeProximityAlarms(withProx);
		const alarms = out.components.filter((c) => c.name === "VALARM");
		expect(alarms).toHaveLength(1);
		expect(alarms[0]?.properties.some((p) => p.name === "X-APPLE-PROXIMITY")).toBe(false); // 残ったのは時刻アラーム。
	});
});
