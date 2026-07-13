// =============================================================================
// computeOccurrenceBounds(G-3)のテスト
// =============================================================================
// expansion.test.ts と同じ流儀: 実 ICS を parse() で読み込み、infrastructure の
// ical.js アダプタ(IcaljsRRuleIterator)を注入する。test/ は層境界(dependency-cruiser)の
// 対象外なので infrastructure を import してよい。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { parse } from "../../../../src/domain/ical";
import { ICalendarObject } from "../../../../src/domain/ical/semantics";
import type { VEvent, VJournal, VTodo } from "../../../../src/domain/ical/semantics";
import { computeOccurrenceBounds, OCCURRENCE_INDEX_MAX } from "../../../../src/domain/ical/recurrence";
import { IcaljsRRuleIterator } from "../../../../src/infrastructure/recurrence/icaljs-rrule-iterator";

const iterator = new IcaljsRRuleIterator();
const idZone = (t: string): string => t;
const OPTS = { zoneOf: idZone, maxOccurrences: 1000 };

function loadCalendar(ics: string): ICalendarObject {
	return ICalendarObject.fromComponent(parse(ics));
}

function loadVEvents(ics: string): { master: VEvent; overrides: VEvent[] } {
	const events = loadCalendar(ics).events();
	const master = events.find((e) => e.recurrenceId === undefined);
	if (master === undefined) throw new Error("test fixture has no master VEVENT");
	return { master, overrides: events.filter((e) => e.recurrenceId !== undefined) };
}

function loadVTodo(ics: string): VTodo {
	const todo = loadCalendar(ics).todos()[0];
	if (todo === undefined) throw new Error("test fixture has no VTODO");
	return todo;
}

function loadVJournal(ics: string): VJournal {
	const journal = loadCalendar(ics).journals()[0];
	if (journal === undefined) throw new Error("test fixture has no VJOURNAL");
	return journal;
}

describe("computeOccurrenceBounds — VEVENT", () => {
	test("単発イベント: first=DTSTART, last=DTEND", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:single",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260710T100000Z",
			"DTEND:20260710T110000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { master, overrides } = loadVEvents(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VEVENT", master, overrides }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 6, 10, 10, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 6, 10, 11, 0, 0));
	});

	test("有限反復(COUNT): first=最初の回, last=最後の回の end", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:finite",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=WEEKLY;COUNT=3",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { master, overrides } = loadVEvents(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VEVENT", master, overrides }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 6, 9, 0, 0));
		// 3回目: 2026-01-20 09:00〜10:00
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 0, 20, 10, 0, 0));
	});

	test("無限反復(COUNT/UNTIL 無し): last=OCCURRENCE_INDEX_MAX、展開を回避する", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:infinite",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=DAILY",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { master, overrides } = loadVEvents(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VEVENT", master, overrides }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 6, 9, 0, 0));
		expect(bounds.lastMillis).toBe(OCCURRENCE_INDEX_MAX);
	});

	test("limitHit(maxOccurrences 到達)なら last=OCCURRENCE_INDEX_MAX(安全側の過剰包含)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:limit-hit",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			// COUNT=50 だが maxOccurrences=5 で打ち切らせる(有限反復でも limitHit になりうる)。
			"RRULE:FREQ=DAILY;COUNT=50",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { master, overrides } = loadVEvents(ics);
		const bounds = computeOccurrenceBounds(
			iterator,
			{ componentKind: "VEVENT", master, overrides },
			{ zoneOf: idZone, maxOccurrences: 5 },
		);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
		expect(bounds.lastMillis).toBe(OCCURRENCE_INDEX_MAX);
	});

	test("壊れた RRULE は throw せず null/null", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:broken-rrule",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			// COUNT と UNTIL の同時指定は §3.3.10 の排他違反(パース時に InvalidValueError)。
			"RRULE:FREQ=DAILY;COUNT=5;UNTIL=20260201T000000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { master, overrides } = loadVEvents(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VEVENT", master, overrides }, OPTS);
		expect(bounds.firstMillis).toBeNull();
		expect(bounds.lastMillis).toBeNull();
	});
});

describe("computeOccurrenceBounds — VTODO", () => {
	test("DUE のみ: first=last=DUE", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:due-only",
			"DTSTAMP:20260101T000000Z",
			"DUE:20260715T120000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 6, 15, 12, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 6, 15, 12, 0, 0));
	});

	test("DTSTART+DURATION: last は DTSTART+DURATION の end", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:dtstart-duration",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260715T090000Z",
			"DURATION:PT2H",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 6, 15, 9, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 6, 15, 11, 0, 0));
	});

	test("DTSTART/DUE/COMPLETED/CREATED すべて欠落 → null/null(§9.9 VTODO 表の最終行と一致)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:no-dates",
			"DTSTAMP:20260101T000000Z",
			"SUMMARY:何もない",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBeNull();
		expect(bounds.lastMillis).toBeNull();
	});

	// --- A-1 回帰テスト群 ------------------------------------------------------------------
	// 実測で踏んだ不整合: 単発終日 VTODO(DTSTART=DUE=2026-12-23, CREATED=2026-07-12)で
	// first が CREATED(07-12)まで巻き戻っていた。RFC 4791 §9.9 の表(rfc4791.txt L5104-5137)は
	// DTSTART/DUE が存在する行では CREATED を一切参照しない。旧実装(min/max 集合演算)は
	// これに反していたので、表の行を1つずつ固定するテストを足す。

	test("単発終日 VTODO: DTSTART=DUE(終日)、CREATED は無視され first=last=DUE(A-1 実測ケース)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:single-allday-due-created-mismatch",
			"DTSTAMP:20260712T142933Z",
			"CREATED:20260712T142933Z",
			"DTSTART;VALUE=DATE:20261223",
			"DUE;VALUE=DATE:20261223",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		const expected = Date.UTC(2026, 11, 23, 0, 0, 0);
		expect(bounds.firstMillis).toBe(expected);
		expect(bounds.lastMillis).toBe(expected);
	});

	test("DTSTART のみ(DUE/DURATION 無し): CREATED があっても無視され first=last=DTSTART", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:dtstart-only-with-created",
			"DTSTAMP:20260101T000000Z",
			"CREATED:20260101T000000Z",
			"DTSTART:20260715T090000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		const expected = Date.UTC(2026, 6, 15, 9, 0, 0);
		expect(bounds.firstMillis).toBe(expected);
		expect(bounds.lastMillis).toBe(expected);
	});

	test("DUE のみ + CREATED: CREATED は無視され first=last=DUE", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:due-only-with-created",
			"DTSTAMP:20260101T000000Z",
			"CREATED:20260101T000000Z",
			"DUE:20260715T120000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		const expected = Date.UTC(2026, 6, 15, 12, 0, 0);
		expect(bounds.firstMillis).toBe(expected);
		expect(bounds.lastMillis).toBe(expected);
	});

	test("DTSTART/DUE とも無し、CREATED のみ: first=CREATED, last=OCCURRENCE_INDEX_MAX(§9.9 の end>CREATED は上限が無い)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:created-only",
			"DTSTAMP:20260101T000000Z",
			"CREATED:20260101T000000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(bounds.lastMillis).toBe(OCCURRENCE_INDEX_MAX);
	});

	test("DTSTART/DUE とも無し、COMPLETED+CREATED: first=min, last=max", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:completed-and-created",
			"DTSTAMP:20260101T000000Z",
			"CREATED:20260101T000000Z",
			"COMPLETED:20260201T000000Z",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const todo = loadVTodo(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VTODO", master: todo, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 1, 1, 0, 0, 0));
	});
});

// =============================================================================
// J-1: VJOURNAL の bounds(RFC 4791 §9.9 の VJOURNAL 実効値表: 効果的 duration は
// DATE-TIME→0秒 / DATE→+P1D。DTSTART 無しはこの索引では null/null に倒す
// — occurrence-bounds.ts の computeVJournalBounds コメント参照)。
// =============================================================================
describe("computeOccurrenceBounds — VJOURNAL", () => {
	test("DTSTART が DATE-TIME: first=last=DTSTART(効果的 duration 0 秒)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VJOURNAL",
			"UID:journal-datetime",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260715T120000Z",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const journal = loadVJournal(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VJOURNAL", master: journal, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 6, 15, 12, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 6, 15, 12, 0, 0));
	});

	test("DTSTART が DATE: last=first+P1D(効果的 duration 1日)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VJOURNAL",
			"UID:journal-date",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260715",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const journal = loadVJournal(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VJOURNAL", master: journal, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
		expect(bounds.lastMillis).toBe(Date.UTC(2026, 6, 16, 0, 0, 0));
	});

	test("DTSTART 無し → null/null(§9.9 表の FALSE ではなく安全側の「常に候補」に倒す設計)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VJOURNAL",
			"UID:journal-no-dtstart",
			"DTSTAMP:20260101T000000Z",
			"SUMMARY:何もない",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const journal = loadVJournal(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VJOURNAL", master: journal, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBeNull();
		expect(bounds.lastMillis).toBeNull();
	});

	// J-4: RRULE 付き VJOURNAL は索引を展開しない代わりに lastMillis を無限扱いにする
	// (occurrence-bounds.ts の computeVJournalBounds コメント参照。未来の occurrence を
	// SQL 側の索引で恒久的に取りこぼさないための対策)。
	test("RRULE 付き: lastMillis は OCCURRENCE_INDEX_MAX(無限扱い)", () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VJOURNAL",
			"UID:journal-rrule",
			"DTSTAMP:20260101T000000Z",
			"DTSTART;VALUE=DATE:20260101",
			"RRULE:FREQ=YEARLY",
			"END:VJOURNAL",
			"END:VCALENDAR",
		].join("\r\n");
		const journal = loadVJournal(ics);
		const bounds = computeOccurrenceBounds(iterator, { componentKind: "VJOURNAL", master: journal, overrides: [] }, OPTS);
		expect(bounds.firstMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(bounds.lastMillis).toBe(OCCURRENCE_INDEX_MAX);
	});
});
