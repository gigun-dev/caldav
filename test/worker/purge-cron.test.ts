// =============================================================================
// test/worker/purge-cron.test.ts — R2 ゴミ箱 purge cron(scheduled ハンドラ)の実 D1 検証
// =============================================================================
// 【なぜ workerd レーンか】Cron Trigger の scheduled ディスパッチ(exports.default.scheduled)や
// D1 の実データ(deleted_at の backdate)は bun test のフェイクでは検証できない
// (soft-delete.test.ts と同じ理由・同じ方針)。
//
// 【何を保証するか(What)】
//   - 30日より古い deleted_at の tombstone は scheduled 実行で物理削除される。
//   - 30日以内(境界より新しい)の tombstone は残る(誤って消さない)。
//   - 生存中(deleted_at IS NULL)の行は触らない。
//   - PURGE_DELETED_AFTER_DAYS(app.ts)の値そのもの(30)を固定する — この定数は
//     「iOS の最近削除した項目が30日」という UX 慣行に合わせた意図的な値なので、
//     無自覚な変更をテストで検知できるようにする。
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	D1CalendarCollectionRepository,
	D1CalendarObjectResourceRepository,
	D1CollectionUnitOfWork,
	D1PrincipalRepository,
} from "../../src/infrastructure/d1/repositories";
import { PURGE_DELETED_AFTER_DAYS } from "../../src/app";
import { CalendarCollection, CalendarObjectResource, Principal, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";

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

async function setup(tag: string) {
	const owner = principalPath(`/dav/principals/purge-cron-${tag}/`);
	const cid = collectionId(`pc-${tag}`);
	await new D1PrincipalRepository(env.DB).save(Principal.create(owner, `/dav/purge-cron-${tag}/`));
	const collections = new D1CalendarCollectionRepository(env.DB);
	await collections.save(new CalendarCollection({ id: cid, owner, displayName: "PC", supportedComponents: ["VTODO"] }));
	const resources = new D1CalendarObjectResourceRepository(env.DB);
	const uow = new D1CollectionUnitOfWork(env.DB);
	return { owner, cid, collections, resources, uow };
}

async function createAndSoftDeleteTodo(
	deps: Awaited<ReturnType<typeof setup>>,
	uri: string,
	uid: string,
): Promise<void> {
	const collection = (await deps.collections.findById(deps.owner, deps.cid))!;
	collection.recordChange(resourceUri(uri), "created");
	const resource = await CalendarObjectResource.fromIcs(resourceUri(uri), vtodo(uid, uid));
	await deps.uow.saveResource(deps.owner, deps.cid, resource, collection, NO_BOUNDS, { kind: "create" });
	const collection2 = (await deps.collections.findById(deps.owner, deps.cid))!;
	collection2.recordChange(resourceUri(uri), "deleted");
	await deps.uow.deleteResource(deps.owner, deps.cid, resourceUri(uri), collection2, { kind: "overwrite" });
}

/** deleted_at を直接書き換えて「N日前に削除された」状態を模擬する(cron の実行時刻に依存させないため)。 */
async function backdateDeletedAt(owner: string, cid: string, uri: string, daysAgo: number): Promise<void> {
	const millis = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
	await env.DB.prepare(
		"UPDATE calendar_objects SET deleted_at = ? WHERE owner = ? AND collection_id = ? AND uri = ?",
	).bind(millis, owner, cid, uri).run();
}

async function rowExists(owner: string, cid: string, uri: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 as x FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
	).bind(owner, cid, uri).first<{ x: number }>();
	return row !== null;
}

describe("R2 ゴミ箱 purge cron(scheduled ハンドラ)", () => {
	it("PURGE_DELETED_AFTER_DAYS は30日(iOS の最近削除した項目の慣行に合わせた意図的な値)", () => {
		expect(PURGE_DELETED_AFTER_DAYS).toBe(30);
	});

	it("30日より古い tombstone は scheduled 実行で物理削除され、境界内・生存中の行は残る", async () => {
		const deps = await setup("mixed");
		// old: 31日前に削除(purge 対象)。
		await createAndSoftDeleteTodo(deps, "old.ics", "uid-old");
		await backdateDeletedAt(deps.owner, deps.cid, "old.ics", 31);
		// recent: 1日前に削除(purge 対象外・境界内)。
		await createAndSoftDeleteTodo(deps, "recent.ics", "uid-recent");
		await backdateDeletedAt(deps.owner, deps.cid, "recent.ics", 1);
		// alive: 生存中(deleted_at NULL のまま・purge の対象外)。
		{
			const collection = (await deps.collections.findById(deps.owner, deps.cid))!;
			collection.recordChange(resourceUri("alive.ics"), "created");
			const resource = await CalendarObjectResource.fromIcs(resourceUri("alive.ics"), vtodo("uid-alive", "alive"));
			await deps.uow.saveResource(deps.owner, deps.cid, resource, collection, NO_BOUNDS, { kind: "create" });
		}

		// exports.default.scheduled を実 workerd 上で叩く(spike.test.ts が確立した exports.default 直叩き
		// 方式を scheduled にも適用)。
		// 【なぜ cloudflare:test の createScheduledController()/SELF.scheduled() を使わないか(実測ボツ案)】
		// (a) createScheduledController() が返す ScheduledController の実体は internal スタブで、
		//     exports.default.scheduled(...) へ渡すと DataCloneError("ScheduledController")で落ちた
		//     (worker 境界を跨ぐ RPC 相当の引数受け渡しが structured clone を要求するため)。
		// (b) SELF.scheduled() も同様に DataCloneError("LoopbackServiceStub")で落ちた(このプロジェクトの
		//     vitest-pool-workers バージョン/config では SELF 経由の scheduled RPC が正しく機能しなかった)。
		// spike.test.ts の ExecutionContext と同じ「プロトコルが要求する最小フィールドを持つ素の
		// オブジェクトリテラルを直接渡す」方式に倒すのが最も安定した(scheduledController は
		// scheduledTime/cron/noRetry の3フィールドしか要求しない単純な形なので、これで十分)。
		const scheduledController = { scheduledTime: Date.now(), cron: "0 3 * * *", noRetry: () => {} };
		const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
		await exports.default.scheduled!(scheduledController, env, ctx);

		expect(await rowExists(deps.owner, deps.cid, "old.ics")).toBe(false);
		expect(await rowExists(deps.owner, deps.cid, "recent.ics")).toBe(true);
		expect(await rowExists(deps.owner, deps.cid, "alive.ics")).toBe(true);
	});
});
