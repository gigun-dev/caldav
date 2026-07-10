// =============================================================================
// SyncCollection ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	PutCalendarObject,
	DeleteCalendarObject,
	SyncCollection,
	InvalidSyncTokenError,
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

describe("SyncCollection", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let del: DeleteCalendarObject;
	let sync: SyncCollection;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow);
		del = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		sync = new SyncCollection(collectionRepo, resourceRepo);
		collectionRepo.seed(makeTestCollection());
	});

	// =========================================================================
	// 初回同期
	// =========================================================================

	it("初回同期(syncToken=null): 全リソースを changed として返す", async () => {
		// 2件追加。
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "a.ics", ics: makeVEventIcs("uid-a") });
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "b.ics", ics: makeVEventIcs("uid-b") });

		const result = await sync.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			syncToken: null,
		});

		expect(result.diffs).toHaveLength(2);
		expect(result.diffs.every((d) => d.kind === "changed")).toBe(true);
		expect(result.newSyncToken).toBeDefined();
	});

	it("初回同期(syncToken=空文字): null と同等", async () => {
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "c.ics", ics: makeVEventIcs("uid-c") });

		const result = await sync.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			syncToken: "",
		});
		expect(result.diffs).toHaveLength(1);
	});

	// =========================================================================
	// 差分同期
	// =========================================================================

	it("差分同期: トークン以降に追加されたリソースが changed に含まれる", async () => {
		// 同期前に1件追加。
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "pre.ics", ics: makeVEventIcs("uid-pre") });

		// 現在の syncToken を取得。
		const r1 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: null });
		const token = r1.newSyncTokenUri;

		// トークン取得後に1件追加。
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "post.ics", ics: makeVEventIcs("uid-post") });

		// 差分取得: post.ics だけが changed に来るはず。
		const r2 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: token });
		expect(r2.diffs).toHaveLength(1);
		expect(r2.diffs[0]?.kind).toBe("changed");
		const changed = r2.diffs[0] as { kind: "changed"; resource: any };
		expect(changed.resource.uri).toBe("post.ics");
	});

	it("差分同期: 削除されたリソースが removed に含まれる", async () => {
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "gone.ics", ics: makeVEventIcs("uid-gone") });
		const r1 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: null });
		const token = r1.newSyncTokenUri;

		// 削除。
		await del.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "gone.ics" });

		const r2 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: token });
		expect(r2.diffs).toHaveLength(1);
		expect(r2.diffs[0]?.kind).toBe("removed");
		const removed = r2.diffs[0] as { kind: "removed"; uri: string };
		expect(removed.uri).toBe("gone.ics");
	});

	it("差分なし: 同じトークンを送ると diffs が空", async () => {
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "x.ics", ics: makeVEventIcs("uid-x") });
		const r1 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: null });

		// 何も変更しないで再度 sync。
		const r2 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: r1.newSyncTokenUri });
		expect(r2.diffs).toHaveLength(0);
	});

	it("newSyncToken が毎回進む(変更があるたびにカウンタが増える)", async () => {
		const r1 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: null });
		const cnt1 = r1.newSyncToken.counter;

		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "y.ics", ics: makeVEventIcs("uid-y") });

		const r2 = await sync.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, syncToken: r1.newSyncTokenUri });
		expect(r2.newSyncToken.counter).toBe(cnt1 + 1);
	});

	// =========================================================================
	// エラー系
	// =========================================================================

	it("無効な syncToken は InvalidSyncTokenError", async () => {
		await expect(
			sync.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				syncToken: "https://invalid-other-server.example/sync/99",
			})
		).rejects.toBeInstanceOf(InvalidSyncTokenError);
	});
});
