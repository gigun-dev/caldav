// =============================================================================
// vtodo-recurrence テスト(D4 モデル: 反復 VTODO 完了。E-1 スライス②-c)
// =============================================================================
// buildCompletionSnapshot は実機フィクスチャ2本(vtodo-recurring-master.ics /
// vtodo-recurring-completed-instance.ics)を突き合わせて検証する。
// advanceMasterToNextOccurrence は同じマスターに対して IcaljsRRuleIterator を実際に注入し、
// DUE の週次前進(7/12→7/18→7/19→7/25→7/26→UNTIL 越えの次の生ステップ)を確認する。
// 2026-07-13 V8 本番実機実測で「最終 occurrence も次の生ステップへ前進する」ことが判明したため、
// advanceMasterToNextOccurrence の "exhausted" 分岐は撤去し、常に "advanced"(+ seriesEnded
// フラグ)を返す契約に変更した(下記テストもその契約で書く)。
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
			expect(result.seriesEnded).toBe(false); // まだ UNTIL 未到達(継続)。
			expect(VTodo.fromComponent(result.vtodo).status).toBe("NEEDS-ACTION");
			current = result.vtodo;
		}
	});

	// 2026-07-13 V8 実機実測: iOS は UNTIL を越えても "advanced"(次の生ステップへ前進)を返す。
	// 前は "exhausted" を返して前進しない仕様だったが、本番実機で「最終回もマスターは次の生
	// ステップへ前進し、RRULE(UNTIL 込み)は不変」という挙動が確認されたため、この仕様に揃えた。
	test("UNTIL(20260731T111300Z)を超えても advanced・seriesEnded=true で RRULE 不変のまま次の生ステップへ前進する", () => {
		let current = masterVTodoComponent();
		const rruleBefore = rruleRaw(current);
		for (let i = 0; i < 4; i++) {
			const result = advanceMasterToNextOccurrence(current, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error("expected advanced during warm-up");
			current = result.vtodo;
		}
		// current の DUE は 7/26。次候補は 8/1(WEEKLY;BYDAY=SU,SA の次は土曜 8/1)で UNTIL を超える。
		const result = advanceMasterToNextOccurrence(current, iterator, zoneOf);
		if (result.kind !== "advanced") throw new Error("expected advanced");
		expect(result.seriesEnded).toBe(true); // UNTIL を越えた生ステップ。
		expect(due(result.vtodo)).toBe("20260801T211000"); // UNTIL 無視で次の生ステップ(8/1 土曜)へ前進。
		expect(rruleRaw(result.vtodo)).toBe(rruleBefore); // UNTIL 込みで RRULE は不変(実測どおり)。
	});

	// COUNT 系列の最終回(count<=1 で今回が最後)の RRULE 書き戻しは実機未検証(推定)。
	// UNTIL 系列で「RRULE 不変」が実測されたことに揃え、count を減算しない判断を採用している
	// (vtodo-recurrence.ts の実装コメント参照。可逆な判断)。
	test("COUNT=3→2(継続)、count<=1(最終回)は advanced・seriesEnded=true で RRULE 不変のまま前進する", () => {
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
		expect(r1.seriesEnded).toBe(false); // COUNT=3 は継続中(まだ2回残る)。

		const r2 = advanceMasterToNextOccurrence(r1.vtodo, iterator, zoneOf);
		if (r2.kind !== "advanced") throw new Error("expected advanced");
		expect(rruleRaw(r2.vtodo)).toBe("FREQ=DAILY;COUNT=1");
		expect(r2.seriesEnded).toBe(false); // COUNT=2 も継続中(まだ1回残る)。

		// 3回目(COUNT=1 だった occurrence の完了): 今回が数え上げ上の最後 → seriesEnded=true。
		// RRULE は不変(count を減算しない — 実機未検証の推定)。DTSTART は次の生ステップ
		// (FREQ=DAILY なので+1日)へ前進する。
		const r3 = advanceMasterToNextOccurrence(r2.vtodo, iterator, zoneOf);
		if (r3.kind !== "advanced") throw new Error("expected advanced");
		expect(r3.seriesEnded).toBe(true);
		expect(rruleRaw(r3.vtodo)).toBe("FREQ=DAILY;COUNT=1"); // 減算しない(推定)。
		expect(VTodo.fromComponent(r3.vtodo).raw.properties.find((p) => p.name === "DTSTART")?.value).toBe(
			"20260104T090000Z",
		);
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
		expect(result.seriesEnded).toBe(false); // COUNT=3 の1回目、継続中。
		const vtodo = VTodo.fromComponent(result.vtodo);
		expect(vtodo.raw.properties.find((p) => p.name === "DTSTART")?.value).toBe("20260102");
		// DATE dtstart なので BYHOUR は無視される(構文上残っていても展開に影響しないことの確認)。
		expect(vtodo.raw.properties.find((p) => p.name === "DTSTART")?.parameters[0]?.values[0]).toBe("DATE");
		// DUE-DTSTART の日数差(2日)を保持。
		expect(vtodo.raw.properties.find((p) => p.name === "DUE")?.value).toBe("20260104");
	});

	// 2026-07-13 本番 D1 実測(カスタム RRULE)由来のレグレッション。
	// INTERVAL=3;BYDAY=SU,WE,TH という「複数曜日 × 3週間隔」の RRULE でも、前進先が
	// 「固定 +1日」でも「固定 +21日(3週間)」でもなく、iterator が FREQ/INTERVAL/BYDAY を
	// 正しく解釈した実 occurrence(DTSTART 07-13 月曜の次に該当する BYDAY は 07-15 水曜)へ
	// 前進することを iOS 実機出力(本番 D1 のマスター最終形)と突き合わせて固定する。
	// また UNTIL=20260714(07-14)を 07-15 が越えるため seriesEnded=true になることも実測どおり。
	test("INTERVAL=3;BYDAY=SU,WE,TH の複雑な RRULE でも実 occurrence(07-13→07-15)へ前進し UNTIL 越えで seriesEnded=true(本番 D1 実測)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:interval-byday-test",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260713",
			"DUE;VALUE=DATE:20260713",
			"RRULE:FREQ=WEEKLY;INTERVAL=3;UNTIL=20260714;BYDAY=SU,WE,TH",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const cal = ICalendarObject.fromComponent(parse(ics));
		const master = cal.todos()[0]!.raw;
		const rruleBefore = rruleRaw(master);

		const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
		if (result.kind !== "advanced") throw new Error("expected advanced");
		// 固定+1日(07-14)でも固定+21日(3週間後の07-13系)でもなく、iterator の実 occurrence。
		expect(due(result.vtodo)).toBe("20260715");
		expect(
			VTodo.fromComponent(result.vtodo).raw.properties.find((p) => p.name === "DTSTART")?.value,
		).toBe("20260715");
		expect(result.seriesEnded).toBe(true); // 前進先 07-15 が UNTIL=20260714 を越える。
		expect(rruleRaw(result.vtodo)).toBe(rruleBefore); // RRULE(UNTIL 込み)は前進しても不変。
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
		expect(result.seriesEnded).toBe(false); // COUNT=2 の1回目、継続中。
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
		expect(result.seriesEnded).toBe(false); // UNTIL(20260731)にはまだ遠い。
		expect(due(result.vtodo)).toBe("20260718T211000");
	});

	// -----------------------------------------------------------------------
	// VALARM 絶対トリガーの前進(2026-07-13 追加。本番 D1 実機検証 V3 で判明した欠落の回帰防止)
	// -----------------------------------------------------------------------
	// 本番実測値(CAP-RRULE2・FREQ=DAILY): DTSTART が 20260713T010000+09:00 → 20260714T010000+09:00
	// へ前進したとき、VALARM の絶対トリガーは 20260712T160000Z → 20260713T160000Z へ、
	// ちょうど DTSTART と同じ絶対時間差(+86400秒)だけ前進していた。この節はその実測値を
	// 固定値として貼る回帰テスト(実運用の本番 D1 から採取した値そのもの)。
	describe("VALARM 絶対トリガーの前進", () => {
		function triggerValue(component: Component, alarmIndex = 0): string | undefined {
			const alarm = VTodo.fromComponent(component).alarms()[alarmIndex];
			return alarm?.raw.properties.find((p) => p.name === "TRIGGER")?.value;
		}

		test("絶対トリガー(VALUE=DATE-TIME)は DTSTART と同じ絶対時間差で前進する(本番 D1 実測値)", () => {
			const ics = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:absolute-trigger-test",
				"DTSTAMP:20260101T000000Z",
				"DTSTART;TZID=Asia/Tokyo:20260713T010000",
				"DUE;TZID=Asia/Tokyo:20260713T010000",
				"RRULE:FREQ=DAILY",
				"STATUS:NEEDS-ACTION",
				"BEGIN:VALARM",
				"ACTION:DISPLAY",
				"DESCRIPTION:Reminder",
				"TRIGGER;VALUE=DATE-TIME:20260712T160000Z",
				"END:VALARM",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n");
			const cal = ICalendarObject.fromComponent(parse(ics));
			const master = cal.todos()[0]!.raw;

			const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error("expected advanced");
			expect(result.seriesEnded).toBe(false); // RRULE に UNTIL/COUNT 無し(無限反復)、常に継続。
			expect(
				VTodo.fromComponent(result.vtodo).raw.properties.find((p) => p.name === "DTSTART")?.value,
			).toBe("20260714T010000");
			expect(triggerValue(result.vtodo)).toBe("20260713T160000Z");
		});

		test("相対トリガー(RELATED=START の DURATION)は前進で不変", () => {
			const ics = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:relative-trigger-test",
				"DTSTAMP:20260101T000000Z",
				"DTSTART;TZID=Asia/Tokyo:20260713T010000",
				"DUE;TZID=Asia/Tokyo:20260713T010000",
				"RRULE:FREQ=DAILY",
				"STATUS:NEEDS-ACTION",
				"BEGIN:VALARM",
				"ACTION:DISPLAY",
				"DESCRIPTION:Reminder",
				"TRIGGER;RELATED=START:-PT15M",
				"END:VALARM",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n");
			const cal = ICalendarObject.fromComponent(parse(ics));
			const master = cal.todos()[0]!.raw;

			const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error("expected advanced");
			expect(triggerValue(result.vtodo)).toBe("-PT15M");
		});

		test("位置アラーム(X-APPLE-PROXIMITY を持つ VALARM のダミー絶対トリガー)は前進で不変", () => {
			const ics = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:proximity-trigger-test",
				"DTSTAMP:20260101T000000Z",
				"DTSTART;TZID=Asia/Tokyo:20260713T010000",
				"DUE;TZID=Asia/Tokyo:20260713T010000",
				"RRULE:FREQ=DAILY",
				"STATUS:NEEDS-ACTION",
				"BEGIN:VALARM",
				"ACTION:DISPLAY",
				"DESCRIPTION:Reminder",
				"TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
				"X-APPLE-PROXIMITY:LEAVE",
				"END:VALARM",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n");
			const cal = ICalendarObject.fromComponent(parse(ics));
			const master = cal.todos()[0]!.raw;

			const result = advanceMasterToNextOccurrence(master, iterator, zoneOf);
			if (result.kind !== "advanced") throw new Error("expected advanced");
			expect(triggerValue(result.vtodo)).toBe("19760401T005545Z");
		});

		// -------------------------------------------------------------------
		// 週末反復(BYDAY=SU,SA)の不揃い間隔での VALARM 前進(2026-07-13 追加)
		// -------------------------------------------------------------------
		// 【何を裏取りしたいか】上の「本番 D1 実測値」テストは FREQ=DAILY(常に +86400秒の等間隔)
		// なので、triggerShiftMs = nextEpoch - currentEpoch が「たまたま固定 +1日と一致した」
		// だけでも green になってしまう懸念がある(固定 +N ミリ秒を足すだけの実装でもこのテストは
		// 通ってしまう)。vtodo-recurring-master.ics の RRULE(FREQ=WEEKLY;BYDAY=SU,SA)は
		// 「日曜の次は6日後の土曜、土曜の次は1日後の日曜」という不揃いな実 occurrence 間隔を持つ。
		// この fixture で VALARM が「固定 +7日」ではなく「iterator が返す実際の occurrence 間隔」
		// (6日→1日)ぶん前進することを固定値で確認すれば、triggerShiftMs が RRULE 展開結果
		// (nextEpoch/currentEpoch)に正しく連動していることの証拠になる。
		test("週末反復(BYDAY=SU,SA)で VALARM が不揃いな実 occurrence 間隔(6日→1日)ぶん前進する", () => {
			const master = masterVTodoComponent();
			expect(triggerValue(master)).toBe("20260712T121000Z"); // fixture 初期値(07-12 日曜 12:10Z)。

			// 1回目: 07-12(日)→ 次の occurrence は6日後の07-18(土)。固定+7日なら 07-19 になるはずだが
			// 実際は6日後の07-18になる(BYDAY=SU,SA の実展開どおり)。VALARM も同じ+6日で前進する。
			const r1 = advanceMasterToNextOccurrence(master, iterator, zoneOf);
			if (r1.kind !== "advanced") throw new Error("expected advanced");
			expect(
				VTodo.fromComponent(r1.vtodo).raw.properties.find((p) => p.name === "DTSTART")?.value,
			).toBe("20260718T211000");
			expect(triggerValue(r1.vtodo)).toBe("20260718T121000Z"); // 07-12T12:10Z + 6日。

			// 2回目: 07-18(土)→ 次の occurrence は1日後の07-19(日)。固定+7日ではなく実間隔(1日)で
			// 前進することを確認する(1回目の6日と非対称であることが RRULE 解釈が効いている証拠)。
			const r2 = advanceMasterToNextOccurrence(r1.vtodo, iterator, zoneOf);
			if (r2.kind !== "advanced") throw new Error("expected advanced");
			expect(
				VTodo.fromComponent(r2.vtodo).raw.properties.find((p) => p.name === "DTSTART")?.value,
			).toBe("20260719T211000");
			expect(triggerValue(r2.vtodo)).toBe("20260719T121000Z"); // 07-18T12:10Z + 1日。
		});

		test("VALARM が無いマスターの前進は従来どおり動く(回帰)", () => {
			const noDueIcs = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:no-alarm-test",
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
			expect(VTodo.fromComponent(result.vtodo).alarms()).toHaveLength(0);
		});
	});
});
