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
});
