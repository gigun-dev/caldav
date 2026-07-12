// =============================================================================
// UpdateTodo ユースケース テスト(E-1 スライス②-b)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CreateTodo,
	PutCalendarObject,
	TodoNotFoundError,
	UpdateTodo,
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

// CompleteTodo テストと同じ実機フィクスチャ(RRULE:FREQ=WEEKLY;... を持つ VTODO)。
// UpdateTodo.status:"COMPLETED" にも同じ反復ガードが効くことを検証する(2026-07-12 レビューで
// 追加した不変条件 — update-todo.ts の入力コメント参照)。
const RECURRING_MASTER_ICS = readFileSync(
	join(__dirname, "../domain/ical/fixtures/real-ios/vtodo-recurring-master.ics"),
	"utf-8",
);

describe("UpdateTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let createTodo: CreateTodo;
	let updateTodo: UpdateTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		createTodo = new CreateTodo(putCalendarObject);
		updateTodo = new UpdateTodo(putCalendarObject, resourceRepo, TEST_RECURRENCE_ITERATOR);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("title を更新すると SUMMARY が変わり、他フィールドは維持される", async () => {
		const { task: created } = await createTodo.execute({
			owner: TEST_OWNER,
			title: "旧タイトル",
			notes: "メモ",
			priority: 5,
		});

		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, title: "新タイトル" });
		expect(task.title).toBe("新タイトル");
		expect(task.notes).toBe("メモ");
		expect(task.priority).toBe(5);
	});

	it("due を更新すると VALUE=DATE の DTSTART/DUE が同値で書き換わる", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "提出物" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, due: "2026-08-01" });
		expect(task.due).toBe("2026-08-01");
		expect(task.isAllDay).toBe(true);
	});

	it("priority:0 を渡すと PRIORITY が未設定に戻る", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "優先度あり", priority: 1 });
		expect(created.priority).toBe(1);
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, priority: 0 });
		expect(task.priority).toBe(0);
	});

	it("status:'COMPLETED' で完了状態になる(三点セット)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "完了テスト" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "COMPLETED" });
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");
		expect(task.percentComplete).toBe(100);
		expect(task.completedAt).not.toBeNull();
	});

	it("status:'NEEDS-ACTION' で再開できる(COMPLETED/PERCENT-COMPLETE が消える)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "再開テスト" });
		await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "COMPLETED" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "NEEDS-ACTION" });
		expect(task.completed).toBe(false);
		expect(task.status).toBe("NEEDS-ACTION");
		expect(task.percentComplete).toBeNull();
		expect(task.completedAt).toBeNull();
	});

	it("status:'COMPLETED' + title 変更(反復 VTODO): スナップショットとマスター両方に新 title が反映される", async () => {
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: masterUid,
			title: "新タイトル(反復)",
			status: "COMPLETED",
		});
		// 返る Task = 完了スナップショット。
		expect(task.title).toBe("新タイトル(反復)");
		expect(task.completed).toBe(true);

		const masterUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), masterUid);
		const masterResource = masterUri === null ? null : await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), masterUri);
		const masterVtodo = masterResource!.payload.todos()[0]!;
		expect(masterVtodo.summary).toBe("新タイトル(反復)");
		expect(masterVtodo.status).toBe("NEEDS-ACTION"); // マスターは前進するが完了扱いにはならない。
	});

	it("status:'NEEDS-ACTION'(反復 VTODO): reopen のみ行われる(前進しない)", async () => {
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: masterUid, status: "NEEDS-ACTION" });
		expect(task.status).toBe("NEEDS-ACTION");
		expect(task.completed).toBe(false);
		// reopen は反復性に関係なくガードしない = completeRecurringTodo を経由しないので
		// リソース件数は1件のまま(スナップショットは作られない)。
		const all = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(all).toHaveLength(1);
	});

	it("存在しない todoId は TodoNotFoundError", async () => {
		await expect(
			updateTodo.execute({ owner: TEST_OWNER, todoId: "no-such-uid", title: "x" }),
		).rejects.toBeInstanceOf(TodoNotFoundError);
	});

	it("更新後は resourceRepo 上の ETag も変わっている(must-match PUT が発行された証跡)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "etag確認" });
		const before = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		const etagBefore = before[0]!.etag.hex;
		await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, title: "etag確認・更新後" });
		const after = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(after[0]!.etag.hex).not.toBe(etagBefore);
	});
});
