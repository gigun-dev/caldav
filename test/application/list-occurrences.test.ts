// =============================================================================
// ListOccurrences ユースケース(G-5 共通 UC)テスト
// =============================================================================
// CalendarQuery/ComputeFreeBusy のテストと同じフェイクリポジトリを使い回す。
// PutCalendarObject で実際にリソースを保存してから ListOccurrences を呼ぶ。
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { PutCalendarObject, ListOccurrences } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";

describe("ListOccurrences", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let listOccurrences: ListOccurrences;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		listOccurrences = new ListOccurrences(resourceRepo, TEST_RECURRENCE_ITERATOR);
		collectionRepo.seed(makeTestCollection());
	});

	it("単発 VEVENT が1 occurrence として返る", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:single",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "single.ics", ics });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});

		expect(result.truncated).toBe(false);
		expect(result.occurrences.length).toBe(1);
		const entry = result.occurrences[0];
		expect(entry.uid).toBe("single");
		expect(entry.calendarId).toBe(TEST_COLLECTION_ID);
		expect(entry.occurrence.startMillis).toBe(Date.UTC(2026, 0, 6, 9, 0, 0));
		expect(entry.occurrence.endMillis).toBe(Date.UTC(2026, 0, 6, 10, 0, 0));
	});

	it("反復 VEVENT は range 内の各回に RECURRENCE-ID 込みで展開される", async () => {
		// 毎週火曜 9:00〜10:00 UTC、4回。range は最初の2回だけを含む。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:weekly",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=WEEKLY;COUNT=4",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "weekly.ics", ics });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 20, 0, 0, 0), // 2026-01-06 と 01-13 のみ含む
		});

		expect(result.truncated).toBe(false);
		expect(result.occurrences.length).toBe(2);
		expect(result.occurrences.map((e) => e.occurrence.startMillis)).toEqual([
			Date.UTC(2026, 0, 6, 9, 0, 0),
			Date.UTC(2026, 0, 13, 9, 0, 0),
		]);
		for (const entry of result.occurrences) {
			expect(entry.uid).toBe("weekly");
			expect(entry.occurrence.recurrenceId).toBeDefined();
		}
	});

	it("range をまたぐ長時間イベントは含まれる", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:overlapping",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T080000Z",
			"DTEND:20260106T110000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "overlapping.ics", ics });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 9, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 6, 10, 0, 0),
		});

		expect(result.occurrences.length).toBe(1);
		expect(result.occurrences[0].occurrence.startMillis).toBe(Date.UTC(2026, 0, 6, 8, 0, 0));
		expect(result.occurrences[0].occurrence.endMillis).toBe(Date.UTC(2026, 0, 6, 11, 0, 0));
	});

	it("range 外のイベントは除外される", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:outside",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260301T090000Z",
			"DTEND:20260301T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "outside.ics", ics });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});

		expect(result.occurrences).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it("複数リソースの occurrence が startMillis 昇順にマージされる", async () => {
		const icsB = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:b-later",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T150000Z",
			"DTEND:20260106T160000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const icsA = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:a-earlier",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		// わざと「後の時刻のリソース」を先に保存し、出力側のソートが効いていることを確認する。
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "b.ics", ics: icsB });
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "a.ics", ics: icsA });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});

		expect(result.occurrences.map((e) => e.uid)).toEqual(["a-earlier", "b-later"]);
	});

	it("maxOccurrences 到達で truncated=true になる", async () => {
		// 毎日 9:00〜10:00 UTC、上限なし(UNTIL/COUNT 無し)の反復。range を広く取り、
		// LIST_OCCURRENCES_MAX_OCCURRENCES(3000)を明らかに超える候補数にする。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:daily-forever",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"RRULE:FREQ=DAILY",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "daily.ics", ics });

		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 1, 0, 0, 0),
			rangeEndMillis: Date.UTC(2050, 0, 1, 0, 0, 0), // 3000 日をゆうに超える幅
		});

		expect(result.truncated).toBe(true);
		expect(result.occurrences.length).toBeGreaterThan(0);
	});

	it("空コレクションは空配列・truncated=false を返す", async () => {
		const result = await listOccurrences.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 1),
			rangeEndMillis: Date.UTC(2026, 1, 1),
		});

		expect(result.occurrences).toEqual([]);
		expect(result.truncated).toBe(false);
	});
});
