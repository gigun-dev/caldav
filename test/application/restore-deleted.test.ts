// =============================================================================
// R2 ソフトデリート: ListDeleted / RestoreDeleted + soft-delete の可観測挙動
// =============================================================================
// docs/modeling/15 §A-3 R2 / docs/next-directions.md「R2 RFC 検証完了」の要件を
// application 層(フェイクリポジトリ)で固定する:
//   - soft-delete 後の不可視化(findByUri が null・一覧から消える)
//   - If-None-Match:*(must-not-exist)PUT が unmapped として成功する
//   - 同 UID の再作成が partial unique の意味論で成功する(findUriByUid が tombstone を無視)
//   - restore の UID 衝突拒否 / URI 再利用時の新採番
//   - restore 後の sync report が changed のみ(removed なし)
// D1 固有(partial unique index の実制約・sync report の実往復)は worker レーンで別途固定する。
// =============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import {
	PutCalendarObject,
	DeleteCalendarObject,
	ListDeleted,
	RestoreDeleted,
	RestoreTargetNotFoundError,
	RestoreUidConflictError,
	SyncCollection,
	type ETagCondition,
} from "../../src/application/usecases";
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

function vtodo(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

describe("R2 soft-delete: ListDeleted / RestoreDeleted", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let del: DeleteCalendarObject;
	let listDeleted: ListDeleted;
	let restore: RestoreDeleted;

	const MUST_NOT_EXIST: ETagCondition = { kind: "must-not-exist" };

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		del = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		listDeleted = new ListDeleted(resourceRepo);
		restore = new RestoreDeleted(collectionRepo, resourceRepo, uow);
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	async function putTodo(uri: string, uid: string, summary: string, condition?: ETagCondition): Promise<void> {
		await put.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: uri, ics: vtodo(uid, summary), condition });
	}

	it("soft-delete 後は不可視(findByUri 404 相当)だがゴミ箱には残り、restore で戻る", async () => {
		await putTodo("a.ics", "uid-a", "Task A");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "a.ics" });

		// 不可視: findByUri は null、一覧からも消える。
		expect(await resourceRepo.findByUri(TEST_OWNER, TASKS, resourceUri("a.ics"))).toBeNull();
		expect(await resourceRepo.findAllInCollection(TEST_OWNER, TASKS)).toHaveLength(0);

		// ゴミ箱には残る。
		const trash = await listDeleted.execute({ owner: TEST_OWNER });
		expect(trash.entries).toHaveLength(1);
		expect(trash.entries[0]).toMatchObject({ uri: "a.ics", uid: "uid-a", summary: "Task A", calendarId: "tasks", componentKind: "VTODO" });
		expect(typeof trash.entries[0]!.deletedAtMillis).toBe("number");

		// restore で生存へ戻る(同 uri を維持)。
		const restored = await restore.execute({ owner: TEST_OWNER, resourceUri: "a.ics" });
		expect(restored).toMatchObject({ uri: "a.ics", uid: "uid-a", calendarId: "tasks" });
		expect(await resourceRepo.findByUri(TEST_OWNER, TASKS, resourceUri("a.ics"))).not.toBeNull();
		expect((await listDeleted.execute({ owner: TEST_OWNER })).entries).toHaveLength(0);
	});

	it("If-None-Match:* PUT は soft-delete 済み URI を unmapped として成功する", async () => {
		await putTodo("b.ics", "uid-b1", "First");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "b.ics" });

		// soft-delete 済み URI は unmapped 扱い → must-not-exist(If-None-Match:*)が通る。
		await expect(putTodo("b.ics", "uid-b2", "Second", MUST_NOT_EXIST)).resolves.toBeUndefined();
		const live = await resourceRepo.findByUri(TEST_OWNER, TASKS, resourceUri("b.ics"));
		expect(live?.uid).toBe("uid-b2");

		// 旧ゴーストは退避 rename され、ゴミ箱に別 uri で残る(同 uri の亡霊にならない)。
		const trash = await listDeleted.execute({ owner: TEST_OWNER });
		expect(trash.entries).toHaveLength(1);
		expect(trash.entries[0]!.uid).toBe("uid-b1");
		expect(trash.entries[0]!.uri).not.toBe("b.ics"); // 退避済み
	});

	it("同 UID の再作成が成功する(findUriByUid が tombstone を無視 = partial unique の意味論)", async () => {
		await putTodo("c1.ics", "uid-c", "Original");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "c1.ics" });

		// 別 uri に同 UID を新規作成 — soft-delete 済みの同 UID は no-uid-conflict に引っかからない。
		await expect(putTodo("c2.ics", "uid-c", "Recreated", MUST_NOT_EXIST)).resolves.toBeUndefined();
		expect((await resourceRepo.findByUri(TEST_OWNER, TASKS, resourceUri("c2.ics")))?.uid).toBe("uid-c");
	});

	it("restore は生存側に同 UID が居たら拒否し、衝突相手 uri を示す", async () => {
		await putTodo("d1.ics", "uid-d", "Original");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "d1.ics" });
		await putTodo("d2.ics", "uid-d", "Recreated live", MUST_NOT_EXIST);

		const err = await restore
			.execute({ owner: TEST_OWNER, resourceUri: "d1.ics" })
			.then(() => null)
			.catch((e) => e);
		expect(err).toBeInstanceOf(RestoreUidConflictError);
		// conflictUri は branded ResourceUri。文字列として突き合わせる。
		expect(String((err as RestoreUidConflictError).conflictUri)).toBe("d2.ics");
	});

	it("restore は元 uri が生存リソースに再利用されていたら新 uri を採番する", async () => {
		// e.ics を作って削除 → 別 UID で e.ics を再利用(ゴースト退避)。
		await putTodo("e.ics", "uid-e1", "First");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "e.ics" });
		await putTodo("e.ics", "uid-e2", "Reused", MUST_NOT_EXIST);

		// ゴミ箱のゴーストは退避 uri を持つ。その退避 uri は空いているので restore はそれを維持する。
		const ghost = (await listDeleted.execute({ owner: TEST_OWNER })).entries[0]!;
		const restored = await restore.execute({ owner: TEST_OWNER, resourceUri: ghost.uri });
		expect(restored.uid).toBe("uid-e1");
		// 生存側の e.ics(uid-e2)は温存されている。
		expect((await resourceRepo.findByUri(TEST_OWNER, TASKS, resourceUri("e.ics")))?.uid).toBe("uid-e2");
	});

	it("存在しない uri の restore は RestoreTargetNotFoundError", async () => {
		await expect(restore.execute({ owner: TEST_OWNER, resourceUri: "nope.ics" })).rejects.toBeInstanceOf(
			RestoreTargetNotFoundError,
		);
	});

	it("restore 後の sync report は changed のみ(removed なし)— 6578 §3.5.1", async () => {
		const sync = new SyncCollection(collectionRepo, resourceRepo);

		// 初期状態のトークンを控える(この時点以降の差分を後で問う)。
		await putTodo("f.ics", "uid-f", "Task F");
		const base = await sync.execute({ owner: TEST_OWNER, collectionId: TASKS, syncToken: null });
		const tokenBeforeDelete = base.newSyncTokenUri;

		// delete → restore(同 uri を維持)。
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "f.ics" });
		await restore.execute({ owner: TEST_OWNER, resourceUri: "f.ics" });

		const diff = await sync.execute({ owner: TEST_OWNER, collectionId: TASKS, syncToken: tokenBeforeDelete });
		// deleted → created の後勝ち fold で、f.ics は「changed」1件に畳まれる(removed は出ない)。
		expect(diff.diffs.every((d) => d.kind === "changed")).toBe(true);
		const changedUris = diff.diffs.flatMap((d) => (d.kind === "changed" ? [String(d.resource.uri)] : []));
		expect(changedUris).toContain("f.ics");
	});

	it("purge は TTL より古い tombstone を物理削除する(cron 配線は別スライス)", async () => {
		await putTodo("g.ics", "uid-g", "Task G");
		await del.execute({ owner: TEST_OWNER, collectionId: TASKS, resourceUri: "g.ics" });
		// deletedAt は Date.now() 付近。未来の cutoff で purge すれば消える。
		const purged = await resourceRepo.purgeDeletedBefore(Date.now() + 1000);
		expect(purged).toBe(1);
		expect((await listDeleted.execute({ owner: TEST_OWNER })).entries).toHaveLength(0);
	});
});
