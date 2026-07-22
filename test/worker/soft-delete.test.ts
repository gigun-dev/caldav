// =============================================================================
// test/worker/soft-delete.test.ts — R2 ソフトデリートの実 D1 検証
// =============================================================================
// 【なぜ workerd レーンか】partial unique index(calendar_objects_uid_live)や
// deleted_at フィルタ、UPDATE ベースの soft-delete、restore の atomic 書き込みは
// 実 D1(migrations/0004 が適用された calendar_objects)でしか正確に固定できない。
// bun test には D1 が無いので、application 層のフェイクでは近似できる意味論(fakes.ts)を
// ここで「本物のスキーマ制約」に対して裏取りする(CLAUDE.md: コメントの主張を実行して確認)。
//
// 【repositories/UoW を直接叩く理由】HTTP/MCP 層を通すより、D1CollectionUnitOfWork の
// saveResource/deleteResource/restoreResource と D1CalendarObjectResourceRepository の
// 読み取り/ゴミ箱/purge を最短距離で exercise できる(既存 d1-repositories.test.ts と同方針)。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	D1CalendarCollectionRepository,
	D1CalendarObjectResourceRepository,
	D1CollectionUnitOfWork,
	D1PrincipalRepository,
} from "../../src/infrastructure/d1/repositories";
import { ConcurrencyConflictError } from "../../src/application/ports";
import { ListDeleted, RestoreDeleted, SyncCollection } from "../../src/application/usecases";
import {
	CalendarCollection,
	CalendarObjectResource,
	Principal,
	collectionId,
	principalPath,
	resourceUri,
} from "../../src/domain/caldav";

const NO_BOUNDS = { firstMillis: null, lastMillis: null } as const;

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

// 各 it() ごとにユニークな owner/collection を使い、同一 D1(ファイル内で持続)での相互干渉を避ける。
async function setup(tag: string) {
	const owner = principalPath(`/dav/principals/soft-del-${tag}/`);
	const cid = collectionId(`sd-${tag}`);
	await new D1PrincipalRepository(env.DB).save(Principal.create(owner, `/dav/soft-del-${tag}/`));
	const collections = new D1CalendarCollectionRepository(env.DB);
	await collections.save(new CalendarCollection({ id: cid, owner, displayName: "SD", supportedComponents: ["VTODO"] }));
	const resources = new D1CalendarObjectResourceRepository(env.DB);
	const uow = new D1CollectionUnitOfWork(env.DB);
	return { owner, cid, collections, resources, uow };
}

async function createTodo(
	deps: Awaited<ReturnType<typeof setup>>,
	uri: string,
	uid: string,
	summary: string,
): Promise<void> {
	const collection = (await deps.collections.findById(deps.owner, deps.cid))!;
	collection.recordChange(resourceUri(uri), "created");
	const resource = await CalendarObjectResource.fromIcs(resourceUri(uri), vtodo(uid, summary));
	await deps.uow.saveResource(deps.owner, deps.cid, resource, collection, NO_BOUNDS, { kind: "create" });
}

async function softDelete(deps: Awaited<ReturnType<typeof setup>>, uri: string): Promise<void> {
	const collection = (await deps.collections.findById(deps.owner, deps.cid))!;
	collection.recordChange(resourceUri(uri), "deleted");
	await deps.uow.deleteResource(deps.owner, deps.cid, resourceUri(uri), collection, { kind: "overwrite" });
}

describe("R2 soft-delete on real D1", () => {
	it("deleteResource は物理削除でなく deleted_at を立て、読み取りから不可視化する", async () => {
		const deps = await setup("invis");
		await createTodo(deps, "a.ics", "uid-a", "A");
		await softDelete(deps, "a.ics");

		// 物理的には残っている(deleted_at 付き)。
		const raw = await env.DB.prepare(
			"SELECT deleted_at FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
		).bind(deps.owner, deps.cid, "a.ics").first<{ deleted_at: number | null }>();
		expect(raw?.deleted_at).toBeTypeOf("number");

		// 読み取りからは不可視。
		expect(await deps.resources.findByUri(deps.owner, deps.cid, resourceUri("a.ics"))).toBeNull();
		expect(await deps.resources.findAllInCollection(deps.owner, deps.cid)).toHaveLength(0);
		expect(await deps.resources.findVTodosInCollection(deps.owner, deps.cid)).toHaveLength(0);
		expect(await deps.resources.findUriByUid(deps.owner, deps.cid, "uid-a")).toBeNull();

		// ゴミ箱には見える。
		const trash = await new ListDeleted(deps.resources).execute({ owner: deps.owner });
		expect(trash.entries.map((e) => e.uid)).toEqual(["uid-a"]);
	});

	it("partial unique index: soft-delete 済みの同 UID は再作成できるが、生存2件は拒否される", async () => {
		const deps = await setup("uid");
		await createTodo(deps, "u1.ics", "uid-u", "First");
		await softDelete(deps, "u1.ics");

		// soft-delete 済み → 同 UID の別 uri 作成は成功(partial unique は tombstone を対象外にする)。
		await expect(createTodo(deps, "u2.ics", "uid-u", "Recreated")).resolves.toBeUndefined();

		// 生存2件目の同 UID は partial unique に阻まれて競合(ConcurrencyConflictError)。
		await expect(createTodo(deps, "u3.ics", "uid-u", "Dup live")).rejects.toBeInstanceOf(ConcurrencyConflictError);
	});

	it("soft-delete 済み URI への If-None-Match:* 作成: ゴーストを退避 rename して成功する", async () => {
		const deps = await setup("reuse");
		await createTodo(deps, "r.ics", "uid-r1", "First");
		await softDelete(deps, "r.ics");

		// create(= If-None-Match:*)で同じ uri を再利用。ゴースト退避 rename が働き PK 衝突しない。
		await expect(createTodo(deps, "r.ics", "uid-r2", "Reused")).resolves.toBeUndefined();
		expect((await deps.resources.findByUri(deps.owner, deps.cid, resourceUri("r.ics")))?.uid).toBe("uid-r2");

		// 旧ゴーストは別 uri でゴミ箱に残る(同 uri の亡霊にならない)。
		const trash = await new ListDeleted(deps.resources).execute({ owner: deps.owner });
		expect(trash.entries).toHaveLength(1);
		expect(trash.entries[0]!.uid).toBe("uid-r1");
		expect(trash.entries[0]!.uri).not.toBe("r.ics");
	});

	it("restore は deleted_at を外し、sync report を changed のみ(removed なし)にする", async () => {
		const deps = await setup("restore");
		const sync = new SyncCollection(deps.collections, deps.resources);
		await createTodo(deps, "s.ics", "uid-s", "S");
		const base = await sync.execute({ owner: deps.owner, collectionId: deps.cid, syncToken: null });

		await softDelete(deps, "s.ics");
		const restored = await new RestoreDeleted(deps.collections, deps.resources, deps.uow).execute({
			owner: deps.owner,
			resourceUri: "s.ics",
			calendarId: deps.cid,
		});
		expect(restored.uid).toBe("uid-s");
		// 生存へ戻る。
		expect(await deps.resources.findByUri(deps.owner, deps.cid, resourceUri("s.ics"))).not.toBeNull();

		// delete→create の後勝ち fold で s.ics は changed 1件(removed は出ない)。
		const diff = await sync.execute({ owner: deps.owner, collectionId: deps.cid, syncToken: base.newSyncTokenUri });
		expect(diff.diffs.every((d) => d.kind === "changed")).toBe(true);
		const changed = diff.diffs.flatMap((d) => (d.kind === "changed" ? [String(d.resource.uri)] : []));
		expect(changed).toContain("s.ics");
	});

	it("restore は生存側に同 UID が居たら拒否する", async () => {
		const deps = await setup("conflict");
		await createTodo(deps, "c1.ics", "uid-c", "First");
		await softDelete(deps, "c1.ics");
		await createTodo(deps, "c2.ics", "uid-c", "Live recreate");

		await expect(
			new RestoreDeleted(deps.collections, deps.resources, deps.uow).execute({
				owner: deps.owner,
				resourceUri: "c1.ics",
				calendarId: deps.cid,
			}),
		).rejects.toMatchObject({ kind: "RestoreUidConflictError", conflictUri: "c2.ics" });
	});

	it("purgeDeletedBefore は tombstone を物理削除し、sync_changes を1件も書かない", async () => {
		const deps = await setup("purge");
		await createTodo(deps, "p.ics", "uid-p", "P");
		await softDelete(deps, "p.ics");

		const changesBefore = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM sync_changes WHERE owner = ? AND collection_id = ?",
		).bind(deps.owner, deps.cid).first<{ n: number }>();

		const purged = await deps.resources.purgeDeletedBefore(Date.now() + 60_000);
		expect(purged).toBeGreaterThanOrEqual(1);

		// 物理的に消えている。
		const rowsAfter = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
		).bind(deps.owner, deps.cid, "p.ics").first<{ n: number }>();
		expect(rowsAfter?.n).toBe(0);

		// sync_changes は purge の前後で不変(物理掃除は変更ログを書かない — 仕様 #7)。
		const changesAfter = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM sync_changes WHERE owner = ? AND collection_id = ?",
		).bind(deps.owner, deps.cid).first<{ n: number }>();
		expect(changesAfter?.n).toBe(changesBefore?.n);
	});
});
