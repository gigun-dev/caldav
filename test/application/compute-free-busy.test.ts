// =============================================================================
// ComputeFreeBusy ユースケース(G-4)テスト
// =============================================================================
// CalendarQuery のテスト(calendar-query.test.ts)と同じフェイクリポジトリを使い回す。
// PutCalendarObject で実際にリソースを保存してから ComputeFreeBusy を呼ぶ。
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { PutCalendarObject, ComputeFreeBusy } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";

describe("ComputeFreeBusy", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let computeFreeBusy: ComputeFreeBusy;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		computeFreeBusy = new ComputeFreeBusy(resourceRepo, TEST_RECURRENCE_ITERATOR);
		collectionRepo.seed(makeTestCollection());
	});

	it("単発 VEVENT(TRANSP 未指定・STATUS 未指定)は BUSY 区間になる", async () => {
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

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});
		expect(result.intervals).toEqual([
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY" },
		]);
	});

	it("TRANSP=TRANSPARENT のイベントは除外される", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:transparent",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"TRANSP:TRANSPARENT",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "transparent.ics", ics });

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});
		expect(result.intervals).toEqual([]);
	});

	it("STATUS=CANCELLED のイベントは除外される", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:cancelled",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"STATUS:CANCELLED",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "cancelled.ics", ics });

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});
		expect(result.intervals).toEqual([]);
	});

	it("STATUS=TENTATIVE のイベントは BUSY-TENTATIVE になる", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:tentative",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"STATUS:TENTATIVE",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "tentative.ics", ics });

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 7, 0, 0, 0),
		});
		expect(result.intervals).toEqual([
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY-TENTATIVE" },
		]);
	});

	it("反復 VEVENT は range 内の各回で busy 区間になり、range 外の回は含まれない", async () => {
		// 毎週火曜 9:00〜10:00 UTC、2026-01-06 から4回。range は最初の2回だけを含む。
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

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 20, 0, 0, 0), // 2026-01-06 と 01-13 のみ含む
		});
		expect(result.intervals).toEqual([
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY" },
			{ startMillis: Date.UTC(2026, 0, 13, 9, 0, 0), endMillis: Date.UTC(2026, 0, 13, 10, 0, 0), type: "BUSY" },
		]);
	});

	it("range をまたぐ occurrence は range の境界にクリップされる", async () => {
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

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 9, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 6, 10, 0, 0),
		});
		expect(result.intervals).toEqual([
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY" },
		]);
	});

	it("オーバーライドで TENTATIVE 化した回は BUSY-TENTATIVE になり、他の回は BUSY のまま", async () => {
		// 毎週火曜 9:00〜10:00 UTC、3回。2回目(2026-01-13)だけ TENTATIVE + 時刻変更のオーバーライド。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:overridden",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=WEEKLY;COUNT=3",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"UID:overridden",
			"DTSTAMP:20260101T000000Z",
			"RECURRENCE-ID:20260113T090000Z",
			"DTSTART:20260113T110000Z",
			"DTEND:20260113T120000Z",
			"STATUS:TENTATIVE",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "overridden.ics", ics });

		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 6, 0, 0, 0),
			rangeEndMillis: Date.UTC(2026, 0, 21, 0, 0, 0),
		});
		expect(result.intervals).toEqual([
			{ startMillis: Date.UTC(2026, 0, 6, 9, 0, 0), endMillis: Date.UTC(2026, 0, 6, 10, 0, 0), type: "BUSY" },
			{ startMillis: Date.UTC(2026, 0, 13, 11, 0, 0), endMillis: Date.UTC(2026, 0, 13, 12, 0, 0), type: "BUSY-TENTATIVE" },
			{ startMillis: Date.UTC(2026, 0, 20, 9, 0, 0), endMillis: Date.UTC(2026, 0, 20, 10, 0, 0), type: "BUSY" },
		]);
	});

	it("空コレクションは空区間を返す", async () => {
		const result = await computeFreeBusy.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			rangeStartMillis: Date.UTC(2026, 0, 1),
			rangeEndMillis: Date.UTC(2026, 1, 1),
		});
		expect(result.intervals).toEqual([]);
	});
});
