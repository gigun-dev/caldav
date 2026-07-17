// =============================================================================
// event-dto ユニットテスト — structuredLocation / conference / proximityAlarm(C1・設計 05 §1)
// =============================================================================
// eventFromVEvent が返す C1 派生フィールドを狙い撃ちで検証する(task-dto.test.ts と対称)。
// 既存フィールド(start/end/recurrence/alarms 等)は event-usecases.test.ts でカバー済みなので、
// ここでは C1 の additive フィールドの振る舞い(値あり/なし・source 出し分け・生 url 温存)に絞る。
import { describe, expect, test } from "bun:test";
import { parse } from "../../src/domain/ical";
import { ICalendarObject } from "../../src/domain/ical/semantics";
import { eventFromVEvent } from "../../src/application/usecases/event-dto";

// VCALENDAR 1枚 + VEVENT 1個のミニマル ICS を組む。
function veventIcs(lines: string[]): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

function firstEvent(ics: string) {
	return ICalendarObject.fromComponent(parse(ics)).events()[0]!;
}

describe("eventFromVEvent: structuredLocation(設計 05 §1-b)", () => {
	test("X-APPLE-STRUCTURED-LOCATION から title/geo/radius を派生する", () => {
		const ics = veventIcs([
			"UID:e-gifu",
			"DTSTAMP:20260717T000000Z",
			"DTSTART:20260718T010000Z",
			"SUMMARY:岐阜大学で会議",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=柳戸1-1;X-APPLE-RADIUS=100;X-TITLE=岐阜大学:geo:35.463012,136.737202",
		]);
		const event = eventFromVEvent(firstEvent(ics), (t) => t, "UTC");
		expect(event.structuredLocation).toEqual({
			title: "岐阜大学",
			address: "柳戸1-1",
			geo: { lat: 35.463012, lon: 136.737202 },
			radiusMeters: 100,
		});
	});

	test("未設定なら null", () => {
		const ics = veventIcs(["UID:e0", "DTSTAMP:20260717T000000Z", "DTSTART:20260718T010000Z", "SUMMARY:場所なし"]);
		expect(eventFromVEvent(firstEvent(ics), (t) => t, "UTC").structuredLocation).toBeNull();
	});
});

describe("eventFromVEvent: conference(設計 05 §1-c)", () => {
	test("paiza 招待型: URL=message + DESCRIPTION 会議ブロック → conference source:description・url は生値温存", () => {
		const ics = veventIcs([
			"UID:e-paiza",
			"DTSTAMP:20260717T000000Z",
			"DTSTART:20260718T010000Z",
			"SUMMARY:paiza 面談",
			"URL;VALUE=URI:message:%3Cabc@amazonses.com%3E?c=xyz",
			"DESCRIPTION:面談です\\n----( ビデオ通話 )----\\nhttps://meet.google.com/xpk-yooe-eev\\n---===---",
		]);
		const event = eventFromVEvent(firstEvent(ics), (t) => t, "UTC");
		expect(event.conference).toEqual({ url: "https://meet.google.com/xpk-yooe-eev", source: "description" });
		// 既存 url フィールドは生値(message: スキーム)のまま温存する(後方互換)。
		expect(event.url).toBe("message:%3Cabc@amazonses.com%3E?c=xyz");
	});

	test("URL に http 直入れ → conference source:url・url も同じ生値のまま", () => {
		const ics = veventIcs([
			"UID:e-meet",
			"DTSTAMP:20260717T000000Z",
			"DTSTART:20260718T010000Z",
			"SUMMARY:Meet",
			"URL;VALUE=URI:https://meet.google.com/abc",
		]);
		const event = eventFromVEvent(firstEvent(ics), (t) => t, "UTC");
		expect(event.conference).toEqual({ url: "https://meet.google.com/abc", source: "url" });
		expect(event.url).toBe("https://meet.google.com/abc");
	});

	test("URL も会議ブロックも無い → conference null", () => {
		const ics = veventIcs(["UID:e-plain", "DTSTAMP:20260717T000000Z", "DTSTART:20260718T010000Z", "SUMMARY:ただの予定"]);
		expect(eventFromVEvent(firstEvent(ics), (t) => t, "UTC").conference).toBeNull();
	});
});
