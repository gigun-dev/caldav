// =============================================================================
// CalendarQuery ユースケース(G-3)テスト
// =============================================================================
// PutCalendarObject で実際にリソースを保存する(occurrence bounds が計算され、
// フェイクリポジトリの findInCollectionByTimeRange が使う索引が埋まる)。
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { PutCalendarObject, CalendarQuery } from "../../src/application/usecases";
import { resourceUri } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";

describe("CalendarQuery", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let query: CalendarQuery;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		query = new CalendarQuery(resourceRepo, TEST_RECURRENCE_ITERATOR);
		collectionRepo.seed(makeTestCollection());
	});

	it("反復イベントは、ヒットする回が window 外の回を持っていても採用される", async () => {
		// 毎週火曜 9:00〜10:00、2026-01-06 から10回。window は最初の回だけを含む狭い範囲。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:weekly",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260106T090000Z",
			"DTEND:20260106T100000Z",
			"RRULE:FREQ=WEEKLY;COUNT=10",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "weekly.ics", ics });

		const result = await query.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			componentKind: "VEVENT",
			range: { startMillis: Date.UTC(2026, 0, 6, 0, 0, 0), endMillis: Date.UTC(2026, 0, 7, 0, 0, 0) },
		});
		expect(result.resources).toHaveLength(1);
		expect(result.resources[0]?.uri).toBe(resourceUri("weekly.ics"));
	});

	it("window 外のイベントは除外される", async () => {
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:far-away",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20270101T090000Z",
			"DTEND:20270101T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "far-away.ics", ics });

		const result = await query.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			componentKind: "VEVENT",
			range: { startMillis: Date.UTC(2026, 0, 1), endMillis: Date.UTC(2026, 1, 1) },
		});
		expect(result.resources).toHaveLength(0);
	});

	it("floating イベントは TIME_RANGE_TZ_SLACK_MS のおかげで別ゾーン解釈でギリギリ入る回を拾う", async () => {
		// floating DTSTART(TZID なし、Z なし)。PUT 時の索引は floatingTimeZone=UTC 固定で
		// 計算されるため 2026-01-01T23:30 UTC が occurrence bounds になる。しかし calendar-query
		// 側で floatingTimeZone="Asia/Tokyo"(UTC+9)を指定すると実際の occurrence は
		// 2026-01-01T23:30 JST = 2026-01-01T14:30 UTC になり、range を "2026-01-01T00:00Z 〜
		// 2026-01-01T15:00Z" のように JST 解釈のときだけ収まる窓にすると、UTC 索引だけでは
		// SQL 側で落ちてしまう。スラック(24h)が SQL 候補に含め、最終判定(展開)が
		// floatingTimeZone=Asia/Tokyo で正しく overlap 判定する。
		const ics = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:floating",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T233000", // floating(TZID なし・Z なし)
			"DTEND:20260102T003000",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "floating.ics", ics });

		// JST 解釈での実際の occurrence: 2026-01-01T14:30Z 〜 2026-01-01T15:30Z。
		// window をこの近辺(UTC 索引の bounds=23:30Z からは外れるがスラック内)に取る。
		const result = await query.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			componentKind: "VEVENT",
			range: { startMillis: Date.UTC(2026, 0, 1, 14, 0, 0), endMillis: Date.UTC(2026, 0, 1, 15, 0, 0) },
			floatingTimeZone: "Asia/Tokyo",
		});
		expect(result.resources).toHaveLength(1);
		expect(result.resources[0]?.uri).toBe(resourceUri("floating.ics"));
	});

	it("comp-filter のみ(range 無し)は componentKind で絞った全件を返す", async () => {
		const eventIcs = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:ev1",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const todoIcs = [
			"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:td1",
			"DTSTAMP:20260101T000000Z",
			"SUMMARY:todo",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "ev1.ics", ics: eventIcs });
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "td1.ics", ics: todoIcs });

		const result = await query.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			componentKind: "VEVENT",
		});
		expect(result.resources).toHaveLength(1);
		expect(result.resources[0]?.uri).toBe(resourceUri("ev1.ics"));
	});

	// J-4: VJOURNAL の time-range フィルタ(RFC 4791 §9.9 の VJOURNAL 実効値表 + RRULE 展開)。
	describe("VJOURNAL time-range(J-4・§9.9 VJOURNAL 実効値表)", () => {
		it("DTSTART が DATE-TIME: window が (start<=DTSTART かつ end>DTSTART) を満たせばヒット", async () => {
			const ics = [
				"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				"BEGIN:VJOURNAL",
				"UID:journal-dt",
				"DTSTAMP:20260101T000000Z",
				"DTSTART:20260715T120000Z",
				"END:VJOURNAL",
				"END:VCALENDAR",
			].join("\r\n");
			await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "journal-dt.ics", ics });

			const hit = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2026, 6, 15, 11, 0, 0), endMillis: Date.UTC(2026, 6, 15, 13, 0, 0) },
			});
			expect(hit.resources).toHaveLength(1);

			// end<=DTSTART はミス(§9.9 表: end > DTSTART が必須)。
			const miss = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2026, 6, 15, 10, 0, 0), endMillis: Date.UTC(2026, 6, 15, 12, 0, 0) },
			});
			expect(miss.resources).toHaveLength(0);
		});

		it("DTSTART が DATE: 効果的 duration +P1D の範囲でヒット/ミスが分かれる", async () => {
			const ics = [
				"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				"BEGIN:VJOURNAL",
				"UID:journal-date",
				"DTSTAMP:20260101T000000Z",
				"DTSTART;VALUE=DATE:20260715",
				"END:VJOURNAL",
				"END:VCALENDAR",
			].join("\r\n");
			await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "journal-date.ics", ics });

			// window が 07-15 のうち一部でも重なればヒット(効果的期間は 07-15T00:00Z〜07-16T00:00Z)。
			const hit = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2026, 6, 15, 23, 0, 0), endMillis: Date.UTC(2026, 6, 16, 1, 0, 0) },
			});
			expect(hit.resources).toHaveLength(1);

			// 翌日 07-16 以降だけの window はミス。
			const miss = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2026, 6, 16, 0, 0, 0), endMillis: Date.UTC(2026, 6, 17, 0, 0, 0) },
			});
			expect(miss.resources).toHaveLength(0);
		});

		it("DTSTART 無しの VJOURNAL は §9.9 表どおり常にミス(FALSE)", async () => {
			const ics = [
				"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				"BEGIN:VJOURNAL",
				"UID:journal-no-dtstart",
				"DTSTAMP:20260101T000000Z",
				"SUMMARY:何もない",
				"END:VJOURNAL",
				"END:VCALENDAR",
			].join("\r\n");
			await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "journal-no-dtstart.ics", ics });

			// 索引は null/null(常に候補)に倒しているが、最終判定(vjournalOverlapsRange)は
			// §9.9 表どおり厳密に FALSE を返すので、どんな window でもヒットしない。
			const result = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: 0, endMillis: Date.UTC(2099, 0, 1) },
			});
			expect(result.resources).toHaveLength(0);
		});

		it("RRULE 付き VJOURNAL: window に落ちる反復回があればヒットする(遠い未来の回でも索引の無限扱いで拾える)", async () => {
			// 毎年1/1、DTSTART は2026年。2030年の window でもヒットするはず
			// (occurrence-bounds.ts の RRULE 付き VJOURNAL の lastMillis 無限扱いの回帰確認も兼ねる)。
			const ics = [
				"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				"BEGIN:VJOURNAL",
				"UID:journal-yearly",
				"DTSTAMP:20260101T000000Z",
				"DTSTART;VALUE=DATE:20260101",
				"RRULE:FREQ=YEARLY",
				"END:VJOURNAL",
				"END:VCALENDAR",
			].join("\r\n");
			await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "journal-yearly.ics", ics });

			const hit = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2030, 0, 1, 0, 0, 0), endMillis: Date.UTC(2030, 0, 2, 0, 0, 0) },
			});
			expect(hit.resources).toHaveLength(1);
			expect(hit.resources[0]?.uri).toBe(resourceUri("journal-yearly.ics"));

			// 1/2〜1/3(反復回の効果的期間の外)はミス。
			const miss = await query.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				componentKind: "VJOURNAL",
				range: { startMillis: Date.UTC(2030, 0, 2, 0, 0, 0), endMillis: Date.UTC(2030, 0, 3, 0, 0, 0) },
			});
			expect(miss.resources).toHaveLength(0);
		});
	});
});
