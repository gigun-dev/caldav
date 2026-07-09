// =============================================================================
// CalendarObjectResource.fromIcs のテスト(RFC 4791 §4.1)
// =============================================================================
// 検証項目(タスク指定):
//   - 正常(既存フィクスチャを活用)
//   - R1 違反(VEVENT+VTODO 混在)
//   - R3 違反(UID 不一致)
//   - R7 違反(METHOD 付き)
//   - recurrence-override.ics(同一 UID 複数 VEVENT)が正当に通る
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CalendarObjectResource, InvalidResourceError, resourceUri } from "../../../src/domain/caldav";

// caldav テストから ical のフィクスチャを流用(実データの宝庫。CLAUDE.md)。
const fixture = (name: string): string => readFileSync(`${import.meta.dir}/../ical/fixtures/${name}`, "utf8");

const URI = resourceUri("x.ics");

describe("fromIcs: 正常系", () => {
	test("iOS の VEVENT を読み込み、種別/UID/etag を導出する", async () => {
		const res = await CalendarObjectResource.fromIcs(URI, fixture("ios-event.ics"));
		expect(res.componentKind).toBe("VEVENT");
		expect(res.uid).toBe("1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
		// rawIcs は渡した ICS そのまま(再シリアライズしない)。
		expect(res.rawIcs).toBe(fixture("ios-event.ics"));
		// etag は 16 進 64 桁。
		expect(res.etag.hex).toMatch(/^[0-9a-f]{64}$/);
	});

	test("iOS の VTODO(リマインダー)を読み込む", async () => {
		const res = await CalendarObjectResource.fromIcs(URI, fixture("ios-reminder.ics"));
		expect(res.componentKind).toBe("VTODO");
		expect(res.uid).toBe("B2C3D4E5-F6A7-8B9C-0D1E-2F3A4B5C6D7E");
	});

	test("recurrence-override.ics(同一 UID の VEVENT 複数)は正当に通る(§3.8.4.4)", async () => {
		// マスター + RECURRENCE-ID オーバーライドで VEVENT が2つ並ぶが、UID は同一なので R3 は満たす。
		const res = await CalendarObjectResource.fromIcs(URI, fixture("recurrence-override.ics"));
		expect(res.componentKind).toBe("VEVENT");
		expect(res.uid).toBe("REC-0001");
		// payload から VEVENT が2つ見えること(畳んでいない)。
		expect(res.payload.events().length).toBe(2);
	});
});

// 違反系の共通ヘルパー: fromIcs が InvalidResourceError を投げ、その中に指定 rule が含まれること。
async function expectRule(ics: string, rule: "R1" | "R3" | "R7"): Promise<void> {
	try {
		await CalendarObjectResource.fromIcs(URI, ics);
		throw new Error("expected InvalidResourceError but fromIcs succeeded");
	} catch (e) {
		expect(e).toBeInstanceOf(InvalidResourceError);
		const rules = (e as InvalidResourceError).violations.map((v) => v.rule);
		expect(rules).toContain(rule);
	}
}

describe("fromIcs: 違反系", () => {
	test("R1: VEVENT + VTODO 混在は拒否", async () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//t//t//EN",
			"BEGIN:VEVENT",
			"UID:same",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"END:VEVENT",
			"BEGIN:VTODO",
			"UID:same",
			"DTSTAMP:20260101T000000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		await expectRule(ics, "R1");
	});

	test("R3: UID 不一致は拒否", async () => {
		// 同種(VEVENT)2つだが UID が違う → R3 違反(R1 は満たす)。
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//t//t//EN",
			"BEGIN:VEVENT",
			"UID:uid-A",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"UID:uid-B",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260102T000000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await expectRule(ics, "R3");
	});

	test("R7: METHOD プロパティ付きは拒否(§4.1)", async () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//t//t//EN",
			"METHOD:REQUEST",
			"BEGIN:VEVENT",
			"UID:m1",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T000000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await expectRule(ics, "R7");
	});
});
