// =============================================================================
// ListTodos ユースケース テスト(E-1 スライス①)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { ListTodos, PutCalendarObject } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";
import { collectionId as mkCollectionId, resourceUri } from "../../src/domain/caldav";

const TASKS = mkCollectionId("tasks");

// VALUE=DATE の due 付き VTODO(iOS 実機キャプチャに合わせ DTSTART/DUE 同値で両方立てる)。
function vtodoWithDueDate(uid: string, summary: string, dueYmd: string, status?: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`DTSTART;VALUE=DATE:${dueYmd}`,
		`DUE;VALUE=DATE:${dueYmd}`,
		`SUMMARY:${summary}`,
		...(status !== undefined ? [`STATUS:${status}`] : []),
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

function vtodoNoDue(uid: string, summary: string, status?: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		...(status !== undefined ? [`STATUS:${status}`] : []),
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

// X-APPLE-SORT-ORDER 付き VTODO(スライス②-a のソート順テスト用)。
function vtodoWithSortOrder(uid: string, summary: string, sortOrder: number): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		`X-APPLE-SORT-ORDER:${sortOrder}`,
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

// 時刻付き(VALUE=DATE-TIME・TZID 付き)due の VTODO。iOS 実機が壁時計 + TZID で送ってくる形
// (real-ios/vtodo-recurring-master.ics と同じ DTSTART;TZID=.../DUE;TZID=... 構造)を最小構成で再現。
// VTIMEZONE を含めるのは、zoneResolverFor が TZID→IANA 名を解決するのに VTIMEZONE レンズを
// 使うため(TZID がそのまま IANA 名でも解決できるが、実機に忠実な形にしておく)。
function vtodoWithDueDateTime(uid: string, summary: string, tzid: string, dueLocalRaw: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTIMEZONE",
		`TZID:${tzid}`,
		"BEGIN:STANDARD",
		"DTSTART:19700101T000000",
		"TZOFFSETFROM:+0900",
		"TZOFFSETTO:+0900",
		"TZNAME:JST",
		"END:STANDARD",
		"END:VTIMEZONE",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`DTSTART;TZID=${tzid}:${dueLocalRaw}`,
		`DUE;TZID=${tzid}:${dueLocalRaw}`,
		`SUMMARY:${summary}`,
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

// 反復(RRULE)付き VTODO。既存の反復 TODO も list-todos が壊さず一覧できることを確認する
// (master を展開せず1件として返す、という仕様どおりの挙動)。
function vtodoRecurring(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		"RRULE:FREQ=DAILY;COUNT=5",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

describe("ListTodos", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let usecase: ListTodos;

	async function seed(uid: string, ics: string): Promise<void> {
		await put.execute({
			owner: TEST_OWNER,
			collectionId: TASKS,
			resourceUri: resourceUri(`${uid}.ics`),
			ics,
			condition: { kind: "must-not-exist" },
		});
	}

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		usecase = new ListTodos(resourceRepo);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("既定(includeCompleted 省略)は未完了のみを返す", async () => {
		await seed("a", vtodoNoDue("a", "未完了"));
		await seed("b", vtodoNoDue("b", "完了済み", "COMPLETED"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER });
		expect(tasks.map((t) => t.id).sort()).toEqual(["a"]);
	});

	it("includeCompleted:true で完了済みも含める", async () => {
		await seed("a", vtodoNoDue("a", "未完了"));
		await seed("b", vtodoNoDue("b", "完了済み", "COMPLETED"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER, includeCompleted: true });
		expect(tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);
	});

	it("反復(RRULE)付き VTODO も展開せず master 1件として一覧に含める", async () => {
		await seed("r1", vtodoRecurring("r1", "毎日タスク"));
		const { tasks } = await usecase.execute({ owner: TEST_OWNER });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.id).toBe("r1");
	});

	it("dueBefore/dueAfter で終日 due をフィルタし、due 無しは除外する", async () => {
		await seed("early", vtodoWithDueDate("early", "早い", "20260701"));
		await seed("late", vtodoWithDueDate("late", "遅い", "20260801"));
		await seed("none", vtodoNoDue("none", "期限なし"));

		const { tasks } = await usecase.execute({
			owner: TEST_OWNER,
			dueBefore: "2026-07-15T00:00:00Z",
		});
		expect(tasks.map((t) => t.id)).toEqual(["early"]);

		const { tasks: after } = await usecase.execute({
			owner: TEST_OWNER,
			dueAfter: "2026-07-15T00:00:00Z",
		});
		expect(after.map((t) => t.id)).toEqual(["late"]);
	});

	// 【E-2 スライス①: 00:00 問題の回帰防止】
	// 時刻付き due は「その todo 自身の TZID」で offset ISO 整形して返す(応答基準 timeZone=UTC 既定に
	// 引きずられて UTC 整形= "00:00" にならない)。iOS 実機の壁時計 09:00 表示と一致させる truth surface。
	it("時刻付き due は timeZone 未指定でも自ゾーン(TZID)の offset ISO で返す(00:00 問題の回帰防止)", async () => {
		// JST 09:00 のタスク。旧実装は UTC 整形で "2026-07-14T00:00:00Z" と返し UI が 00:00 と誤表示した。
		await seed("jst", vtodoWithDueDateTime("jst", "朝のタスク", "Asia/Tokyo", "20260714T090000"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.due).toBe("2026-07-14T09:00:00+09:00");
		expect(tasks[0]!.isAllDay).toBe(false);
	});

	// 応答基準 timeZone を明示しても、zoned due の表示ゾーンは変わらない(自ゾーン優先の証明)。
	// 表示 TZ(presentation の都合)と、UTC+TZID という真実を分離する設計の固定。
	it("応答基準 timeZone を別ゾーンで指定しても zoned due は自ゾーンのまま整形する", async () => {
		await seed("jst", vtodoWithDueDateTime("jst", "朝のタスク", "Asia/Tokyo", "20260714T090000"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER, timeZone: "America/New_York" });
		expect(tasks[0]!.due).toBe("2026-07-14T09:00:00+09:00");
	});

	it("calendarId を指定すればそのコレクションだけを見る", async () => {
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "other-tasks", { supportedComponents: ["VTODO"] }));
		await put.execute({
			owner: TEST_OWNER,
			collectionId: mkCollectionId("other-tasks"),
			resourceUri: resourceUri("x.ics"),
			ics: vtodoNoDue("x", "別コレクション"),
			condition: { kind: "must-not-exist" },
		});
		await seed("a", vtodoNoDue("a", "既定コレクション"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER, calendarId: "other-tasks" });
		expect(tasks.map((t) => t.id)).toEqual(["x"]);
	});

	it("既定並びは X-APPLE-SORT-ORDER 昇順、sortOrder 無し(null)は末尾になる", async () => {
		// 挿入順をわざと並び順と逆にして、フィルタではなくソートが効いていることを確認する。
		await seed("z-high", vtodoWithSortOrder("z-high", "後", 300));
		await seed("a-low", vtodoWithSortOrder("a-low", "先", 100));
		await seed("m-mid", vtodoWithSortOrder("m-mid", "中", 200));
		await seed("no-order", vtodoNoDue("no-order", "順序情報なし"));

		const { tasks } = await usecase.execute({ owner: TEST_OWNER });
		expect(tasks.map((t) => t.id)).toEqual(["a-low", "m-mid", "z-high", "no-order"]);
	});
});
