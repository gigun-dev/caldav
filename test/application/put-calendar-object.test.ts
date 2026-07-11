// =============================================================================
// PutCalendarObject ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { PutCalendarObject, ETagConditionError, CalDAVPreconditionError, CollectionNotFoundError } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	TEST_RECURRENCE_ITERATOR,
	makeVEventIcs,
	makeVTodoIcs,
	makeVJournalIcs,
	makeTestCollection,
} from "./fakes";
import { resourceUri } from "../../src/domain/caldav";

describe("PutCalendarObject", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let usecase: PutCalendarObject;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		usecase = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);

		// テスト用コレクションを事前に作成しておく。
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar", { supportedComponents: ["VEVENT"] }));
	});

	// =========================================================================
	// 正常系
	// =========================================================================

	it("新規リソースを作成できる(created=true / ETag が返る)", async () => {
		const ics = makeVEventIcs("uid-001");
		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-001.ics",
			ics,
		});

		expect(result.created).toBe(true);
		expect(result.etag).toBeDefined();
		// リソースが実際に保存されていること。
		const saved = await resourceRepo.findByUri(TEST_OWNER, TEST_COLLECTION_ID, resourceUri("uid-001.ics"));
		expect(saved).not.toBeNull();
		expect(saved?.uid).toBe("uid-001");
	});

	it("既存リソースを更新できる(created=false / 新 ETag が返る)", async () => {
		// 先に作成。
		const ics1 = makeVEventIcs("uid-upd", "Before");
		const r1 = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-upd.ics",
			ics: ics1,
		});
		expect(r1.created).toBe(true);

		// 更新。
		const ics2 = makeVEventIcs("uid-upd", "After");
		const r2 = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-upd.ics",
			ics: ics2,
		});
		expect(r2.created).toBe(false);
		// 内容が変わったので ETag も変わるはず。
		expect(r2.etag.hex).not.toBe(r1.etag.hex);
	});

	it("コレクションの syncCounter が進む", async () => {
		const col = await collectionRepo.findById(TEST_OWNER, TEST_COLLECTION_ID);
		const beforeCounter = col!.syncToken.counter;

		await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-sync.ics",
			ics: makeVEventIcs("uid-sync"),
		});

		const colAfter = await collectionRepo.findById(TEST_OWNER, TEST_COLLECTION_ID);
		expect(colAfter!.syncToken.counter).toBe(beforeCounter + 1);
	});

	// =========================================================================
	// ETag 条件テスト
	// =========================================================================

	it("If-None-Match:* 条件 — リソースが存在しなければ作成できる", async () => {
		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-new.ics",
			ics: makeVEventIcs("uid-new"),
			condition: { kind: "must-not-exist" },
		});
		expect(result.created).toBe(true);
	});

	it("If-None-Match:* 条件 — リソースが存在する場合は 412(ETagConditionError)", async () => {
		// 先に作成。
		await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-dup.ics",
			ics: makeVEventIcs("uid-dup"),
		});

		// 同じ URI に must-not-exist で再度 PUT → 412。
		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "uid-dup.ics",
				ics: makeVEventIcs("uid-dup"),
				condition: { kind: "must-not-exist" },
			})
		).rejects.toBeInstanceOf(ETagConditionError);
	});

	it("If-Match 条件 — ETag が一致すれば更新できる", async () => {
		const r1 = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-match.ics",
			ics: makeVEventIcs("uid-match"),
		});

		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-match.ics",
			ics: makeVEventIcs("uid-match", "Updated"),
			condition: { kind: "must-match", etag: r1.etag.hex },
		});
		expect(result.created).toBe(false);
	});

	it("If-Match 条件 — ETag 不一致なら 412(ETagConditionError)", async () => {
		await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-mismatch.ics",
			ics: makeVEventIcs("uid-mismatch"),
		});

		// 間違った ETag を送る。
		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "uid-mismatch.ics",
				ics: makeVEventIcs("uid-mismatch", "Updated"),
				condition: { kind: "must-match", etag: "0".repeat(64) },
			})
		).rejects.toBeInstanceOf(ETagConditionError);
	});

	// =========================================================================
	// CalDAV precondition テスト
	// =========================================================================

	it("valid-calendar-data 違反: 不正な ICS は CalDAVPreconditionError", async () => {
		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "bad.ics",
				ics: "NOT-AN-ICS",
			})
		).rejects.toBeInstanceOf(CalDAVPreconditionError);
	});

	it("supported-calendar-component 違反: VTODO を VEVENT のみのコレクションに PUT", async () => {
		// collectionRepo には VEVENT のみのコレクション(beforeEach で設定済み)。
		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "todo.ics",
				ics: makeVTodoIcs("todo-uid"),
			})
		).rejects.toBeInstanceOf(CalDAVPreconditionError);
	});

	it("no-uid-conflict: 同 UID のリソースが別 URI に存在する場合は 409", async () => {
		// uid-conflict を uid-a.ics に保存。
		await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-a.ics",
			ics: makeVEventIcs("uid-conflict"),
		});

		// 同じ UID を uid-b.ics に PUT → no-uid-conflict。
		const err = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-b.ics",
			ics: makeVEventIcs("uid-conflict"),
		}).catch((e) => e);
		expect(err).toBeInstanceOf(CalDAVPreconditionError);
		const violations = (err as CalDAVPreconditionError).violations;
		expect(violations.some((v) => v.precondition === "no-uid-conflict")).toBe(true);
	});

	it("コレクションが存在しない場合は CollectionNotFoundError", async () => {
		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: "nonexistent" as any,
				resourceUri: "uid-x.ics",
				ics: makeVEventIcs("uid-x"),
			})
		).rejects.toBeInstanceOf(CollectionNotFoundError);
	});

	// =========================================================================
	// J-1: VJOURNAL の PUT(precondition 通過 + bounds 計算)
	// =========================================================================
	describe("VJOURNAL", () => {
		it("VJOURNAL の PUT は precondition を通り componentKind=VJOURNAL で保存される", async () => {
			// TEST_COLLECTION_ID(既定の "calendar")は supportedComponents:["VEVENT"] 限定なので、
			// VJOURNAL を受理する専用コレクションを別途 seed する(R2 supported-calendar-component)。
			collectionRepo.seed(makeTestCollection(TEST_OWNER, "journal-cal", { supportedComponents: ["VJOURNAL"] }));

			const result = await usecase.execute({
				owner: TEST_OWNER,
				collectionId: "journal-cal" as any,
				resourceUri: "journal-001.ics",
				ics: makeVJournalIcs("journal-uid-001"),
			});
			expect(result.created).toBe(true);

			const saved = await resourceRepo.findByUri(TEST_OWNER, "journal-cal" as any, resourceUri("journal-001.ics"));
			expect(saved).not.toBeNull();
			expect(saved?.componentKind).toBe("VJOURNAL");
			expect(saved?.uid).toBe("journal-uid-001");
		});

		it("VJOURNAL(DTSTART 無し)の bounds は null/null で保存される(フェイク UoW で捕捉)", async () => {
			collectionRepo.seed(makeTestCollection(TEST_OWNER, "journal-cal", { supportedComponents: ["VJOURNAL"] }));

			await usecase.execute({
				owner: TEST_OWNER,
				collectionId: "journal-cal" as any,
				resourceUri: "journal-002.ics",
				ics: makeVJournalIcs("journal-uid-002"),
			});

			const bounds = resourceRepo.boundsOf(TEST_OWNER, "journal-cal" as any, resourceUri("journal-002.ics"));
			// makeVJournalIcs は DTSTART を含めない最小 ICS なので、computeVJournalBounds は
			// null/null を返す(occurrence-bounds.ts の VJOURNAL 節参照)。
			expect(bounds).toEqual({ firstMillis: null, lastMillis: null });
		});
	});
});
