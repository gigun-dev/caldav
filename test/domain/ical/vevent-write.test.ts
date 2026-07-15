// =============================================================================
// semantics/vevent-write.ts のテスト(E-3 スライス S1 新設)
// =============================================================================
// buildVEventCalendar → serialize → parse → VEvent レンズで読み戻し、
// title/start/end/location/recurrence が往復一致することを確認する。validate() の違反もゼロであること。
// vtodo-write.test.ts と対称。
import { describe, expect, test } from "bun:test";
import { buildVEventCalendar } from "../../../src/domain/ical/semantics/vevent-write";
import { ICalendarObject } from "../../../src/domain/ical/semantics";
import { serialize } from "../../../src/domain/ical/serialize/serializer";
import { parse } from "../../../src/domain/ical/parse/parser";
import { recurrenceRule } from "../../../src/domain/ical/values/recurrence-rule";
import { buildVTimezone } from "../../../src/domain/ical/timezone/vtimezone-write";

const NOW = { utcRaw: "20260712T114830Z", unixSeconds: 1783856910 };

describe("buildVEventCalendar", () => {
	test("最小構成(UID/SUMMARY/DTSTART のみ)が VCALENDAR+VEVENT として往復する", () => {
		const component = buildVEventCalendar({
			uid: "ev-1",
			now: NOW,
			summary: "会議",
			start: { type: "DATE-TIME", raw: "20260715T100000", tzid: "Asia/Tokyo" },
			vtimezone: buildVTimezone("Asia/Tokyo", { startMillis: Date.parse("2026-07-01T00:00:00Z"), endMillis: Date.parse("2026-08-01T00:00:00Z") }),
		});
		expect(component.name).toBe("VCALENDAR");
		expect(component.properties).toContainEqual({ name: "CALSCALE", parameters: [], value: "GREGORIAN" });
		// VTIMEZONE が VEVENT より先に並ぶ(iOS 実機の並び)。
		expect(component.components[0]!.name).toBe("VTIMEZONE");
		expect(component.components[1]!.name).toBe("VEVENT");

		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const ev = reparsed.events()[0]!;
		expect(ev.uid).toBe("ev-1");
		expect(ev.summary).toBe("会議");
		expect(ev.dtstart).toEqual({ kind: "zoned", tzid: "Asia/Tokyo", year: 2026, month: 7, day: 15, hour: 10, minute: 0, second: 0 });
		// end 省略 = DTEND を書かない(§3.8.2.2 の排他的終端は OPTIONAL)。
		expect(ev.dtend).toBeUndefined();
		// VTODO 固有プロパティは書かない(STATUS:NEEDS-ACTION / X-APPLE-SORT-ORDER)。
		expect(ev.status).toBeUndefined();
		expect(ev.raw.properties.find((p) => p.name === "X-APPLE-SORT-ORDER")).toBeUndefined();
		// イベントの生成プロパティは DTSTAMP/CREATED/LAST-MODIFIED のみ。
		expect(ev.raw.properties.find((p) => p.name === "CREATED")?.value).toBe("20260712T114830Z");
		expect(ev.raw.properties.find((p) => p.name === "LAST-MODIFIED")?.value).toBe("20260712T114830Z");
	});

	test("終日イベント(DATE)+ DTEND(排他的終端)が往復する", () => {
		const component = buildVEventCalendar({
			uid: "ev-2",
			now: NOW,
			summary: "旅行",
			start: { type: "DATE", raw: "20260715" },
			end: { type: "DATE", raw: "20260718" }, // 排他的終端 = 7/15〜7/17 の3日間。
			location: "京都",
		});
		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const ev = reparsed.events()[0]!;
		expect(ev.dtstart).toEqual({ year: 2026, month: 7, day: 15 });
		expect(ev.dtend).toEqual({ year: 2026, month: 7, day: 18 });
		expect(ev.location).toBe("京都");
		// 終日は VTIMEZONE 不要(DATE 値は TZID を持たない)。
		expect(component.components.some((c) => c.name === "VTIMEZONE")).toBe(false);
	});

	test("時刻付き start/end(DATE-TIME;TZID)+ RRULE が往復する", () => {
		const component = buildVEventCalendar({
			uid: "ev-3",
			now: NOW,
			summary: "定例",
			start: { type: "DATE-TIME", raw: "20260715T100000", tzid: "Asia/Tokyo" },
			end: { type: "DATE-TIME", raw: "20260715T110000", tzid: "Asia/Tokyo" },
			recurrence: recurrenceRule({ freq: "WEEKLY" }),
			vtimezone: buildVTimezone("Asia/Tokyo", { startMillis: Date.parse("2026-07-01T00:00:00Z"), endMillis: Date.parse("2027-08-01T00:00:00Z") }),
		});
		const ics = serialize(component);
		expect(ics).toContain("FREQ=WEEKLY");
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);

		const ev = reparsed.events()[0]!;
		expect(ev.dtend).toEqual({ kind: "zoned", tzid: "Asia/Tokyo", year: 2026, month: 7, day: 15, hour: 11, minute: 0, second: 0 });
		expect(ev.rrule?.freq).toBe("WEEKLY");
	});

	test("DATE-TIME start なのに vtimezone 未指定は防御的に throw する(§3.6.5)", () => {
		expect(() =>
			buildVEventCalendar({
				uid: "ev-4",
				now: NOW,
				summary: "no tz",
				start: { type: "DATE-TIME", raw: "20260715T100000", tzid: "Asia/Tokyo" },
			}),
		).toThrow(/vtimezone/);
	});
});
