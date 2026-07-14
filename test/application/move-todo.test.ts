// =============================================================================
// MoveTodo ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	CalDAVPreconditionError,
	CollectionNotFoundError,
	CreateTodo,
	DeleteCalendarObject,
	ETagConditionError,
	MoveTodo,
	MoveTodoSameCollectionError,
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
import { collectionId as mkCollectionId } from "../../src/domain/caldav";

describe("MoveTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let putCalendarObject: PutCalendarObject;
	let createTodo: CreateTodo;
	let moveTodo: MoveTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		const deleteCalendarObject = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		createTodo = new CreateTodo(putCalendarObject);
		moveTodo = new MoveTodo(putCalendarObject, deleteCalendarObject, resourceRepo);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "work", { supportedComponents: ["VTODO"] }));
		// VEVENT 専用コレクション(supported-calendar-component-set 違反を再現するため)。
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "events-only", { supportedComponents: ["VEVENT"] }));
	});

	it("移動先に現れ移動元から消える(ICS バイト列は不変)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "移動対象", notes: "note" });

		const beforeMoveSourceResource = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), await resourceUriOf(resourceRepo, "tasks", created.id));
		const rawIcsBefore = beforeMoveSourceResource!.rawIcs;

		const { removed } = await moveTodo.execute({
			owner: TEST_OWNER,
			todoId: created.id,
			calendarId: "tasks",
			toCalendarId: "work",
		});

		expect(removed.id).toBe(created.id);
		expect(removed.title).toBe("移動対象");

		// 移動元(tasks)から消えている。
		const remainingInSource = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remainingInSource).toHaveLength(0);

		// 移動先(work)に現れる。
		const remainingInDest = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("work"));
		expect(remainingInDest).toHaveLength(1);
		expect(remainingInDest[0]!.uid).toBe(created.id);

		// ICS バイト列が完全に一致する(rawIcs 無変更)。
		expect(remainingInDest[0]!.rawIcs).toBe(rawIcsBefore);
	});

	it("sync-change: 移動元は deleted・移動先は created として syncToken が進む", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "sync 対象" });

		const sourceBefore = await collectionRepo.findById(TEST_OWNER, mkCollectionId("tasks"));
		const destBefore = await collectionRepo.findById(TEST_OWNER, mkCollectionId("work"));
		const sourceTokenBefore = sourceBefore!.syncToken;
		const destTokenBefore = destBefore!.syncToken;

		await moveTodo.execute({ owner: TEST_OWNER, todoId: created.id, calendarId: "tasks", toCalendarId: "work" });

		const sourceAfter = await collectionRepo.findById(TEST_OWNER, mkCollectionId("tasks"));
		const destAfter = await collectionRepo.findById(TEST_OWNER, mkCollectionId("work"));

		expect(sourceAfter!.syncToken.equals(sourceTokenBefore)).toBe(false);
		expect(destAfter!.syncToken.equals(destTokenBefore)).toBe(false);

		const sourceChange = sourceAfter!.changes.find((c) => c.uri === `${created.id}.ics` && c.kind === "deleted");
		expect(sourceChange).toBeDefined();
		const destChange = destAfter!.changes.find((c) => c.uri === `${created.id}.ics` && c.kind === "created");
		expect(destChange).toBeDefined();
	});

	it("移動元に存在しない UID は TodoNotFoundError", async () => {
		await expect(
			moveTodo.execute({ owner: TEST_OWNER, todoId: "no-such-uid", calendarId: "tasks", toCalendarId: "work" }),
		).rejects.toBeInstanceOf(TodoNotFoundError);
	});

	it("移動先コレクションが無ければ CollectionNotFoundError", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "対象" });

		await expect(
			moveTodo.execute({ owner: TEST_OWNER, todoId: created.id, calendarId: "tasks", toCalendarId: "no-such-collection" }),
		).rejects.toBeInstanceOf(CollectionNotFoundError);

		// 移動元はまだ生きている(移動先検証失敗で移動元は消えない)。
		const remaining = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remaining).toHaveLength(1);
	});

	it("移動先が VTODO を supported しなければ CalDAVPreconditionError", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "対象" });

		await expect(
			moveTodo.execute({ owner: TEST_OWNER, todoId: created.id, calendarId: "tasks", toCalendarId: "events-only" }),
		).rejects.toBeInstanceOf(CalDAVPreconditionError);

		const remaining = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remaining).toHaveLength(1);
	});

	it("移動元=移動先は MoveTodoSameCollectionError(no-op)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "対象" });

		await expect(
			moveTodo.execute({ owner: TEST_OWNER, todoId: created.id, calendarId: "tasks", toCalendarId: "tasks" }),
		).rejects.toBeInstanceOf(MoveTodoSameCollectionError);

		// no-op: 何も変わらない。
		const remaining = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remaining).toHaveLength(1);
	});

	it("移動先に同 UID のリソースが既にあれば ETagConditionError(移動元は消えない)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "衝突対象" });

		// 移動先に同じ UID の VTODO を先に作っておく(同名衝突を再現)。
		await putCalendarObject.execute({
			owner: TEST_OWNER,
			collectionId: mkCollectionId("work"),
			resourceUri: `${created.id}.ics`,
			ics: (await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks")))[0]!.rawIcs,
			condition: { kind: "must-not-exist" },
		});

		await expect(
			moveTodo.execute({ owner: TEST_OWNER, todoId: created.id, calendarId: "tasks", toCalendarId: "work" }),
		).rejects.toBeInstanceOf(ETagConditionError);

		// 移動元はまだ生きている(移動先作成失敗時は移動元を消さない順序保証)。
		const remaining = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remaining).toHaveLength(1);
	});
});

// --- テストヘルパー ---

/** id(UID) からリソース URI を引く小さなヘルパー(findUriByUid のラッパー)。 */
async function resourceUriOf(resourceRepo: FakeCalendarObjectResourceRepository, calendarId: string, uid: string) {
	const uri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId(calendarId), uid);
	if (uri === null) throw new Error(`test setup error: uid not found: ${uid}`);
	return uri;
}
