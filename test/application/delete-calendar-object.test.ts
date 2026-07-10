// =============================================================================
// DeleteCalendarObject ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	PutCalendarObject,
	DeleteCalendarObject,
	DeleteTargetNotFoundError,
	DeleteETagMismatchError,
	CollectionNotFoundError,
} from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	makeVEventIcs,
	makeTestCollection,
} from "./fakes";
import { collectionId } from "../../src/domain/caldav";

describe("DeleteCalendarObject", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let del: DeleteCalendarObject;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow);
		del = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		collectionRepo.seed(makeTestCollection());
	});

	it("存在するリソースを削除できる", async () => {
		await put.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del.ics",
			ics: makeVEventIcs("uid-del"),
		});

		await del.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del.ics",
		});

		// リソースが消えていること。
		const saved = await resourceRepo.findByUri(TEST_OWNER, TEST_COLLECTION_ID, "uid-del.ics" as any);
		expect(saved).toBeNull();
	});

	it("削除後に syncCounter が進む(変更ログに deleted が記録される)", async () => {
		await put.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del2.ics",
			ics: makeVEventIcs("uid-del2"),
		});

		const colBefore = await collectionRepo.findById(TEST_OWNER, TEST_COLLECTION_ID);
		const counterBefore = colBefore!.syncToken.counter;

		await del.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del2.ics",
		});

		const colAfter = await collectionRepo.findById(TEST_OWNER, TEST_COLLECTION_ID);
		expect(colAfter!.syncToken.counter).toBe(counterBefore + 1);
		// 変更ログの最後が deleted であること。
		const lastChange = colAfter!.changes[colAfter!.changes.length - 1];
		expect(lastChange?.kind).toBe("deleted");
	});

	it("If-Match ETag 一致なら削除できる", async () => {
		const r = await put.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del3.ics",
			ics: makeVEventIcs("uid-del3"),
		});

		await expect(
			del.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "uid-del3.ics",
				ifMatchEtag: r.etag.hex,
			})
		).resolves.toBeUndefined();
	});

	it("If-Match ETag 不一致は DeleteETagMismatchError", async () => {
		await put.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-del4.ics",
			ics: makeVEventIcs("uid-del4"),
		});

		await expect(
			del.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "uid-del4.ics",
				ifMatchEtag: "0".repeat(64),
			})
		).rejects.toBeInstanceOf(DeleteETagMismatchError);
	});

	it("存在しないリソースの削除は DeleteTargetNotFoundError", async () => {
		await expect(
			del.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "ghost.ics",
			})
		).rejects.toBeInstanceOf(DeleteTargetNotFoundError);
	});

	it("存在しないコレクションへの削除は CollectionNotFoundError", async () => {
		await expect(
			del.execute({
				owner: TEST_OWNER,
				collectionId: collectionId("no-such") as any,
				resourceUri: "x.ics",
			})
		).rejects.toBeInstanceOf(CollectionNotFoundError);
	});
});
