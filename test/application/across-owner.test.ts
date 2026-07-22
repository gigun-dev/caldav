// =============================================================================
// ListOccurrencesAcrossOwner / ComputeFreeBusyAcrossOwner ユースケーステスト
// =============================================================================
// レイテンシ案2「コレクション横断1クエリ化」の新 UC。単一コレクション版
// (list-occurrences.test.ts / compute-free-busy.test.ts)と同じフェイクを使い回し、
// 複数コレクション混在のマージ・truncated の OR 畳み込み・空・collectionIds 絞り込みを保証する。
// あわせて「1 execute = findByOwnerTimeRange 1 回だけ(findAllByOwner を呼ばない)」を
// カウント用デコレータで確認し、旧 3 波(列挙 + N+1 hydrate + N 並列)が 1 クエリに畳まれたことを
// 回帰ガードする。
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	PutCalendarObject,
	ListOccurrencesAcrossOwner,
	ComputeFreeBusyAcrossOwner,
} from "../../src/application/usecases";
import type { CalendarObjectResourceRepository } from "../../src/application/ports";
import type { CollectionId } from "../../src/domain/caldav";
import { collectionId as mkCollectionId } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";

// 2 コレクション(work / home)を用意する。
const WORK = mkCollectionId("work");
const HOME = mkCollectionId("home");

function vevent(uid: string, startUtc: [number, number, number, number], transp?: "TRANSPARENT"): string {
	const [y, m, d, h] = startUtc;
	const pad = (n: number) => String(n).padStart(2, "0");
	const dt = (hh: number) => `${y}${pad(m + 1)}${pad(d)}T${pad(hh)}0000Z`;
	return [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`DTSTART:${dt(h)}`,
		`DTEND:${dt(h + 1)}`,
		...(transp ? [`TRANSP:${transp}`] : []),
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

/** findByOwnerTimeRange の呼び出し回数を数える薄いデコレータ(それ以外は素通し)。 */
function countingRepo(real: FakeCalendarObjectResourceRepository): {
	repo: CalendarObjectResourceRepository;
	ownerTimeRangeCalls: () => number;
} {
	let calls = 0;
	const repo: CalendarObjectResourceRepository = {
		findAllInCollection: (o, c) => real.findAllInCollection(o, c),
		findByUri: (o, c, u) => real.findByUri(o, c, u),
		findManyByUri: (o, c, u) => real.findManyByUri(o, c, u),
		findUriByUid: (o, c, u) => real.findUriByUid(o, c, u),
		getUidAtUri: (o, c, u) => real.getUidAtUri(o, c, u),
		findInCollectionByTimeRange: (o, c, k, s, e) => real.findInCollectionByTimeRange(o, c, k, s, e),
		findVTodosInCollection: (o, c) => real.findVTodosInCollection(o, c),
		findByOwnerTimeRange: (o, k, s, e, cids) => {
			calls += 1;
			return real.findByOwnerTimeRange(o, k, s, e, cids);
		},
	};
	return { repo, ownerTimeRangeCalls: () => calls };
}

describe("ListOccurrencesAcrossOwner / ComputeFreeBusyAcrossOwner", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;

	// テスト全体の窓: 2026-01-06 全日(UTC)。
	const rangeStartMillis = Date.UTC(2026, 0, 6, 0, 0, 0);
	const rangeEndMillis = Date.UTC(2026, 0, 7, 0, 0, 0);

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "work"));
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "home"));
	});

	async function seedEvent(cid: CollectionId, uri: string, ics: string) {
		await put.execute({ owner: TEST_OWNER, collectionId: cid, resourceUri: uri, ics });
	}

	it("複数コレクションの occurrence を per-event calendarId 付きで始点昇順にマージする", async () => {
		// home の 11:00、work の 09:00 の順に投入(=解決順とソート後の順が異なるようにする)。
		await seedEvent(HOME, "h.ics", vevent("home-evt", [2026, 0, 6, 11]));
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9]));

		const uc = new ListOccurrencesAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis });

		expect(out.truncated).toBe(false);
		expect(out.occurrences.map((o) => o.uid)).toEqual(["work-evt", "home-evt"]); // 始点昇順
		expect(out.occurrences.map((o) => o.calendarId)).toEqual([WORK, HOME]); // per-event
	});

	it("1 execute につき findByOwnerTimeRange は 1 回だけ(全横断でコレクション列挙しない)", async () => {
		await seedEvent(HOME, "h.ics", vevent("home-evt", [2026, 0, 6, 11]));
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9]));

		const { repo, ownerTimeRangeCalls } = countingRepo(resourceRepo);
		const uc = new ListOccurrencesAcrossOwner(repo, TEST_RECURRENCE_ITERATOR);
		await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis });
		expect(ownerTimeRangeCalls()).toBe(1);
	});

	it("collectionIds 指定でその集合だけに絞る(work だけ)", async () => {
		await seedEvent(HOME, "h.ics", vevent("home-evt", [2026, 0, 6, 11]));
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9]));

		const uc = new ListOccurrencesAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis, collectionIds: [WORK] });
		expect(out.occurrences.map((o) => o.uid)).toEqual(["work-evt"]);
	});

	it("空配列 collectionIds は空結果(全横断に化けない)", async () => {
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9]));
		const uc = new ListOccurrencesAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis, collectionIds: [] });
		expect(out.occurrences).toEqual([]);
	});

	it("該当なしなら空 + truncated=false", async () => {
		const uc = new ListOccurrencesAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis });
		expect(out.occurrences).toEqual([]);
		expect(out.truncated).toBe(false);
	});

	it("いずれかの候補が maxOccurrences 到達で truncated=true(OR 畳み込み)", async () => {
		// 毎日 09:00 の無限反復。窓を広くとって maxOccurrences(3000)を超えさせる。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:daily",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=DAILY",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await seedEvent(WORK, "daily.ics", ics);

		const uc = new ListOccurrencesAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({
			owner: TEST_OWNER,
			rangeStartMillis: Date.UTC(2026, 0, 6),
			rangeEndMillis: Date.UTC(2050, 0, 1), // 約 8760 日 > 3000
		});
		expect(out.truncated).toBe(true);
	});

	it("ComputeFreeBusyAcrossOwner: コレクションをまたいだ隣接区間を横断 coalesce する", async () => {
		// work 09:00-10:00 と home 10:00-11:00 は隣接 → 1 区間 09:00-11:00 に融合する。
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9]));
		await seedEvent(HOME, "h.ics", vevent("home-evt", [2026, 0, 6, 10]));

		const uc = new ComputeFreeBusyAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis });
		expect(out.intervals.length).toBe(1);
		expect(out.intervals[0].startMillis).toBe(Date.UTC(2026, 0, 6, 9));
		expect(out.intervals[0].endMillis).toBe(Date.UTC(2026, 0, 6, 11));
	});

	it("ComputeFreeBusyAcrossOwner: TRANSPARENT は busy に寄与しない", async () => {
		await seedEvent(WORK, "w.ics", vevent("work-evt", [2026, 0, 6, 9], "TRANSPARENT"));
		const uc = new ComputeFreeBusyAcrossOwner(resourceRepo, TEST_RECURRENCE_ITERATOR);
		const out = await uc.execute({ owner: TEST_OWNER, rangeStartMillis, rangeEndMillis });
		expect(out.intervals).toEqual([]);
	});
});
