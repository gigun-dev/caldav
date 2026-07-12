// =============================================================================
// CreateTodo ユースケース テスト(E-1 スライス①)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	CreateTodo,
	PutCalendarObject,
	InvalidDueError,
	RecurrenceRequiresDueError,
	RecurrenceCountUntilConflictError,
	RecurrenceWeekdaysRequireWeeklyError,
	ListTodos,
	CompleteTodo,
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

describe("CreateTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let usecase: CreateTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		usecase = new CreateTodo(putCalendarObject);

		// 既定コレクション "tasks"(VTODO 専用)を用意しておく(provision-default-collections.ts の実体に揃える)。
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("UID/DTSTAMP を自動生成し、must-not-exist で保存する(新規リソースとして PutCalendarObject に渡る)", async () => {
		const { task } = await usecase.execute({ owner: TEST_OWNER, title: "牛乳を買う" });

		expect(task.title).toBe("牛乳を買う");
		expect(task.completed).toBe(false);
		expect(task.id.length).toBeGreaterThan(0); // crypto.randomUUID() の非空文字列であること。

		// PutCalendarObject 経由で実際に "tasks" コレクションへ保存されていること
		// (独自の保存経路を作っていないことの確認 — ポートモック越しの検証)。
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(stored).toHaveLength(1);
		expect(stored[0]!.uid).toBe(task.id);
	});

	it("スライス②-a: STATUS:NEEDS-ACTION と sortOrder(X-APPLE-SORT-ORDER)が自動生成される", async () => {
		const { task } = await usecase.execute({ owner: TEST_OWNER, title: "生成プロパティ確認" });
		expect(task.status).toBe("NEEDS-ACTION");
		// unixSeconds は now 依存で決定的値にできないので、数値であることだけ検証する
		// (固定値でのデコード確認は vtodo-stamp.test.ts が担う)。
		expect(typeof task.sortOrder).toBe("number");
	});

	it("due が 'YYYY-MM-DD' なら終日(VALUE=DATE)として保存され、DTSTART/DUE が同値になる", async () => {
		const { task } = await usecase.execute({ owner: TEST_OWNER, title: "提出物", due: "2026-07-15" });
		expect(task.due).toBe("2026-07-15");
		expect(task.isAllDay).toBe(true);
	});

	it("priority を指定すると Task.priority に反映される", async () => {
		const { task } = await usecase.execute({ owner: TEST_OWNER, title: "重要", priority: 1 });
		expect(task.priority).toBe(1);
	});

	it("priority 省略時は 0(未設定)を返す", async () => {
		const { task } = await usecase.execute({ owner: TEST_OWNER, title: "普通" });
		expect(task.priority).toBe(0);
	});

	it("notes(DESCRIPTION)が意味的文字列のまま往復する(TEXT エスケープを気にしなくてよい)", async () => {
		const { task } = await usecase.execute({
			owner: TEST_OWNER,
			title: "メモ付き",
			notes: "カンマ, セミコロン; 改行\nあり",
		});
		expect(task.notes).toBe("カンマ, セミコロン; 改行\nあり");
	});

	it("due が時刻付き(YYYY-MM-DDTHH:mm:ss)だと InvalidDueError を投げる(スライス①未対応)", async () => {
		await expect(
			usecase.execute({ owner: TEST_OWNER, title: "未対応ケース", due: "2026-07-15T09:00:00" }),
		).rejects.toThrow(InvalidDueError);
	});

	it("calendarId を明示すればそのコレクションに保存される", async () => {
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "other-tasks", { supportedComponents: ["VTODO"] }));
		await usecase.execute({ owner: TEST_OWNER, title: "別コレクション", calendarId: "other-tasks" });
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("other-tasks"));
		expect(stored).toHaveLength(1);
	});

	// --- recurrence(タスク③: 反復付き create-todo。RRULE 生成)-----------------------

	describe("recurrence", () => {
		it("recurrence + due で反復 VTODO ができ、list-todos が master 1件として返す(展開しない)", async () => {
			const { task } = await usecase.execute({
				owner: TEST_OWNER,
				title: "毎日の薬",
				due: "2026-07-15",
				recurrence: { frequency: "daily" },
			});
			expect(task.due).toBe("2026-07-15");

			// PutCalendarObject 経由で保存された生 ICS に RRULE が含まれること(RRULE 自体の
			// 詳細な組み立ては vtodo-write.test.ts が担うので、ここでは「反復付きで保存され、
			// list-todos が展開せず master 1件として返す」という UC 間の結線だけを確認する。
			const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
			expect(stored).toHaveLength(1);
			expect(stored[0]!.payload.raw).toBeDefined();

			const listTodos = new ListTodos(resourceRepo);
			const { tasks } = await listTodos.execute({ owner: TEST_OWNER });
			expect(tasks).toHaveLength(1);
			expect(tasks[0]!.id).toBe(task.id);
		});

		it("recurrence 指定だが due が無いと RecurrenceRequiresDueError を投げる", async () => {
			await expect(
				usecase.execute({ owner: TEST_OWNER, title: "due 無し反復(不正)", recurrence: { frequency: "weekly" } }),
			).rejects.toThrow(RecurrenceRequiresDueError);
		});

		it("count と until を両方指定すると RecurrenceCountUntilConflictError を投げる", async () => {
			await expect(
				usecase.execute({
					owner: TEST_OWNER,
					title: "排他違反",
					due: "2026-07-15",
					recurrence: { frequency: "daily", count: 3, until: "2026-08-01" },
				}),
			).rejects.toThrow(RecurrenceCountUntilConflictError);
		});

		it("weekly 以外に weekdays を指定すると RecurrenceWeekdaysRequireWeeklyError を投げる", async () => {
			await expect(
				usecase.execute({
					owner: TEST_OWNER,
					title: "monthly + weekdays(不正)",
					due: "2026-07-15",
					recurrence: { frequency: "monthly", weekdays: ["MO"] },
				}),
			).rejects.toThrow(RecurrenceWeekdaysRequireWeeklyError);
		});

		it("反復付き create → 生成された UID を complete-todo に渡すと D4 経路(スナップショット+前進)が動く", async () => {
			// ②-c の D4 モデル(反復完了)は「iOS 発マスター」だけでなく「我々が作ったマスター」でも
			// 成立するはず、という確認(complete-todo.test.ts は real-ios フィクスチャを使うが、
			// ここでは CreateTodo が組み立てたマスターをそのまま使う)。
			const { task: created } = await usecase.execute({
				owner: TEST_OWNER,
				title: "毎週の水やり",
				due: "2026-07-15",
				recurrence: { frequency: "weekly", weekdays: ["SU"] },
			});

			const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
			const completeTodo = new CompleteTodo(putCalendarObject, resourceRepo, TEST_RECURRENCE_ITERATOR);
			const { task: completedSnapshot } = await completeTodo.execute({ owner: TEST_OWNER, todoId: created.id });

			// D4: 完了操作は「新 UID の完了スナップショット」を返す(マスター自身の UID とは別)。
			expect(completedSnapshot.id).not.toBe(created.id);
			expect(completedSnapshot.completed).toBe(true);

			// マスター(元の UID)は次回 occurrence へ前進しており、コレクション中に
			// マスター + 完了スナップショットの計2件が存在する。
			const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
			expect(stored).toHaveLength(2);
			const master = stored.find((r) => r.uid === created.id);
			expect(master).toBeDefined();
		});
	});
});
