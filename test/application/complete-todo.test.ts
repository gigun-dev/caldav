// =============================================================================
// CompleteTodo ユースケース テスト(E-1 スライス②-b 単発 → ②-c 反復対応)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CompleteTodo,
	CreateTodo,
	PutCalendarObject,
	TodoNotFoundError,
} from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";
import { collectionId as mkCollectionId, CalendarObjectResource, resourceUri as mkResourceUri } from "../../src/domain/caldav";

const RECURRING_MASTER_ICS = readFileSync(
	join(__dirname, "../domain/ical/fixtures/real-ios/vtodo-recurring-master.ics"),
	"utf-8",
);

describe("CompleteTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let createTodo: CreateTodo;
	let completeTodo: CompleteTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		createTodo = new CreateTodo(putCalendarObject);
		completeTodo = new CompleteTodo(putCalendarObject, resourceRepo, TEST_RECURRENCE_ITERATOR);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("単発 VTODO を完了すると三点セットが書き込まれ must-match PUT が発行される", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "単発タスク" });
		const before = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		const etagBefore = before[0]!.etag.hex;

		const { task } = await completeTodo.execute({ owner: TEST_OWNER, todoId: created.id });
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");
		expect(task.percentComplete).toBe(100);
		expect(task.completedAt).not.toBeNull();

		const after = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(after[0]!.etag.hex).not.toBe(etagBefore); // 更新が実際に PUT されたことの証跡。
	});

	it("反復 VTODO(RRULE あり)を完了すると D4 モデル(新 UID スナップショット + マスター前進)で処理される", async () => {
		// vtodo-recurring-master.ics(RRULE:FREQ=WEEKLY;... 実機フィクスチャ)をそのまま
		// リソースとして seed する(コレクション自体の VTODO サポートも設定済み)。
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		const { task } = await completeTodo.execute({ owner: TEST_OWNER, todoId: masterUid });

		// 返る Task は「完了スナップショット」(新 UID・COMPLETED)。
		expect(task.id).not.toBe(masterUid);
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");
		expect(task.percentComplete).toBe(100);

		// マスターは同じ UID のまま NEEDS-ACTION で残り、DUE が次回(7/18)へ前進している。
		const all = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(all).toHaveLength(2); // マスター + 完了スナップショット。
		const masterUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), masterUid);
		const masterResource = masterUri === null ? null : await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), masterUri);
		expect(masterResource).not.toBeNull();
		const masterVtodo = masterResource!.payload.todos()[0]!;
		expect(masterVtodo.status).toBe("NEEDS-ACTION");
		expect(masterVtodo.rrule).not.toBeUndefined();
	});

	it("存在しない todoId は TodoNotFoundError", async () => {
		await expect(
			completeTodo.execute({ owner: TEST_OWNER, todoId: "no-such-uid" }),
		).rejects.toBeInstanceOf(TodoNotFoundError);
	});
});
