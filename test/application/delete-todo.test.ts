// =============================================================================
// DeleteTodo ユースケース テスト(E-1 スライス②-b)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	CreateTodo,
	DeleteCalendarObject,
	DeleteTodo,
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

describe("DeleteTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let createTodo: CreateTodo;
	let deleteTodo: DeleteTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		const deleteCalendarObject = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		createTodo = new CreateTodo(putCalendarObject);
		deleteTodo = new DeleteTodo(deleteCalendarObject, resourceRepo);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("todoId を無条件削除する(古い ETag を保持していても消せる)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "削除対象" });

		await deleteTodo.execute({ owner: TEST_OWNER, todoId: created.id });

		const remaining = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(remaining).toHaveLength(0);
	});

	it("存在しない todoId は TodoNotFoundError(DeleteCalendarObject を呼ぶ前に弾く)", async () => {
		await expect(
			deleteTodo.execute({ owner: TEST_OWNER, todoId: "no-such-uid" }),
		).rejects.toBeInstanceOf(TodoNotFoundError);
	});
});
