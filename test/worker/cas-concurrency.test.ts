// =============================================================================
// test/worker/cas-concurrency.test.ts — R-7 (楽観ロックの CAS 化) スライス S1 のテスト。
// =============================================================================
//
// 【背景(何の回帰/機序を固定するテストか)】
// D1CollectionUnitOfWork.saveResource/deleteResource は以前、collection.syncToken.counter を
// `UPDATE calendar_collections SET sync_counter = ?`(無条件)で書いていた。並行する2リクエストが
// 同じ baseline(hydrate 時点の syncCounter=N)から N+1 を計算すると、両者とも無条件 UPDATE には
// 成功してしまい、最終的な整合性は sync_changes の PK 制約違反(偶発的な砦)にだけ頼っていた
// (制約違反はキャッチされず生の 500 になっていた)。R-7 はこれを CAS(Compare-And-Swap)に
// 昇格させ、①baseline を条件にした UPDATE が空振りしたら意図した ConcurrencyConflictError を
// throw する / ②presentation 層がそれを 412 に写す、という設計にした。
//
// 【なぜ workerd レーンか】
// D1CollectionUnitOfWork は実 D1Database を触るため、bun test(Node ライク環境)には
// D1 が無く再現できない(d1-repositories.test.ts と同じ判断基準)。
//
// 【sleep を使わず決定的にテストする方法】
// D1 ローカルはクエリを逐次処理する。「同一 collection を2回 hydrate してから、それぞれの
// recordChange 結果を順番に書き込む」という制御フローそのものを直接組み立てれば、
// 「2つ目の書き込みだけが古い baseline を使っている」状態を sleep 無しで確実に再現できる
// (2回の findById 呼び出しの間には何も書き込みが起きないので、両方とも同じ baseline=N を
// 読む。これは実際の同時リクエストが同じ N を読むのと同じ状況を、単一スレッドの
// テストコードで確定的に組み立てているだけ)。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	D1CalendarCollectionRepository,
	D1CalendarObjectResourceRepository,
	D1CollectionUnitOfWork,
	D1PrincipalRepository,
} from "../../src/infrastructure/d1/repositories";
import { ConcurrencyConflictError } from "../../src/application/ports";
import { CalendarCollection, CalendarObjectResource, Principal, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";

/** テスト用の最小限 ICS(VEVENT 1件)。uid/resourceUri は呼び出し側で変える。 */
function makeIcs(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		"DTSTART:20260710T100000Z",
		"DTEND:20260710T110000Z",
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

// =============================================================================
// 1. D1CollectionUnitOfWork 単体: stale baseline から書こうとすると ConcurrencyConflictError
// =============================================================================
describe("D1CollectionUnitOfWork.saveResource: R-7 CAS 化", () => {
	it("同じ baseline から2回 recordChange+saveResource すると、片方だけ成功しもう片方は ConcurrencyConflictError になる", async () => {
		const owner = principalPath("/dav/principals/cas-test/");
		const id = collectionId("cas-calendar");

		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/calendars/cas-test/"));
		const collectionRepo = new D1CalendarCollectionRepository(env.DB);
		const resourceRepo = new D1CalendarObjectResourceRepository(env.DB);
		const uow = new D1CollectionUnitOfWork(env.DB);
		await collectionRepo.save(new CalendarCollection({ id, owner, displayName: "CAS test" }));

		// 「2つの並行リクエストが同じコレクションを hydrate した」ことを、2回の findById 呼び出しで
		// 確定的に再現する(冒頭コメントのとおり、この2回の間には何も書き込みが起きないので
		// 両方とも baseline=0(初期値)を読む)。
		const collectionA = await collectionRepo.findById(owner, id);
		const collectionB = await collectionRepo.findById(owner, id);
		if (!collectionA || !collectionB) throw new Error("test setup: collection not found");
		expect(collectionA.baselineSyncCounter.counter).toBe(0);
		expect(collectionB.baselineSyncCounter.counter).toBe(0);

		const resourceA = await CalendarObjectResource.fromIcs(resourceUri("winner.ics"), makeIcs("winner-uid", "Winner"));
		const resourceB = await CalendarObjectResource.fromIcs(resourceUri("loser.ics"), makeIcs("loser-uid", "Loser"));
		collectionA.recordChange(resourceA.uri, "created");
		collectionB.recordChange(resourceB.uri, "created");

		// A が先に書き込む: baseline=0 が DB の現在値(0)と一致するので成功し、sync_counter は 1 になる。
		await uow.saveResource(owner, id, resourceA, collectionA, { firstMillis: null, lastMillis: null });

		// B は同じ baseline=0 のまま書き込もうとする: DB はすでに 1 なので CAS が空振りし、
		// ConcurrencyConflictError になる(呼び出し側は catch せず伝播させる契約 — ports/index.ts 参照)。
		await expect(
			uow.saveResource(owner, id, resourceB, collectionB, { firstMillis: null, lastMillis: null }),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);

		// DB の最終状態: sync_counter は 1(A の分だけ進む)、sync_changes は1行(A の分だけ)、
		// calendar_objects には A の内容だけが入り、B の upsert は③のガードで混入しない。
		const finalCollection = await collectionRepo.findById(owner, id);
		expect(finalCollection?.syncToken.counter).toBe(1);

		const changes = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM sync_changes WHERE owner = ? AND collection_id = ?",
		).bind(owner, id).first<{ n: number }>();
		expect(changes?.n).toBe(1);

		const winnerRow = await resourceRepo.findByUri(owner, id, resourceA.uri);
		const loserRow = await resourceRepo.findByUri(owner, id, resourceB.uri);
		expect(winnerRow?.uid).toBe("winner-uid");
		expect(loserRow).toBeNull();
	});

	it("deleteResource でも同じ CAS 契約が働く(stale baseline からの削除は ConcurrencyConflictError)", async () => {
		const owner = principalPath("/dav/principals/cas-delete-test/");
		const id = collectionId("cas-delete-calendar");

		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/calendars/cas-delete-test/"));
		const collectionRepo = new D1CalendarCollectionRepository(env.DB);
		const resourceRepo = new D1CalendarObjectResourceRepository(env.DB);
		const uow = new D1CollectionUnitOfWork(env.DB);
		await collectionRepo.save(new CalendarCollection({ id, owner, displayName: "CAS delete test" }));

		// 事前に1件作っておく(削除対象)。
		const seedCollection = await collectionRepo.findById(owner, id);
		if (!seedCollection) throw new Error("test setup: collection not found");
		const target = await CalendarObjectResource.fromIcs(resourceUri("target.ics"), makeIcs("target-uid", "Target"));
		seedCollection.recordChange(target.uri, "created");
		await uow.saveResource(owner, id, target, seedCollection, { firstMillis: null, lastMillis: null });
		// この時点で sync_counter=1。

		// 2つの並行リクエストが同じ baseline=1 を hydrate したことを再現する。
		const collectionA = await collectionRepo.findById(owner, id);
		const collectionB = await collectionRepo.findById(owner, id);
		if (!collectionA || !collectionB) throw new Error("test setup: collection not found");
		expect(collectionA.baselineSyncCounter.counter).toBe(1);
		expect(collectionB.baselineSyncCounter.counter).toBe(1);

		const other = await CalendarObjectResource.fromIcs(resourceUri("other.ics"), makeIcs("other-uid", "Other"));
		collectionA.recordChange(other.uri, "created");
		collectionB.recordChange(target.uri, "deleted");

		// A(別リソースの作成)が先に書き込み成功、sync_counter は 2 になる。
		await uow.saveResource(owner, id, other, collectionA, { firstMillis: null, lastMillis: null });

		// B(target の削除)は stale baseline=1 のまま削除しようとして競合する。
		await expect(
			uow.deleteResource(owner, id, target.uri, collectionB),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);

		// target は削除されずに残っている(③のガードにより DELETE 文自体が空振りする)。
		const stillThere = await resourceRepo.findByUri(owner, id, target.uri);
		expect(stillThere?.uid).toBe("target-uid");
	});
});

// =============================================================================
// 2. HTTP 層(412 マッピング)についての注記
// =============================================================================
//
// 【bun test 側(test/presentation/app.test.ts)に置いた理由・ここに置かなかった理由】
// 当初この workerd レーンで「Promise.all で2つの PUT を同時発火し、片方が 412 になること」を
// 確認しようとしたが、実測でこの vitest-pool-workers 環境(ローカル D1)は Promise.all で
// fetch を2本同時に投げても実際には完全に直列実行される(3回試行して3回とも [201, 201] —
// 一方が完了してから他方が始まる)ことが分かった。CAS の baseline は「PUT のたびに fresh に
// hydrate する」設計(put-calendar-object.ts Step 1)なので、直列実行では baseline は常に
// 最新になり、原理的に競合を再現できない(これは実装のバグではなく、この環境で HTTP レベルの
// 真の並行アクセスを sleep 無しに決定的に作る手段が無いという環境上の制約)。
//
// 「ConcurrencyConflictError が投げられたら 412 になる」という presentation 層のマッピング
// 自体は、D1 の実挙動に依存しない純粋な if 分岐(app.ts の errorResponse)なので、
// __setRepositoriesFactoryForTest で「常に ConcurrencyConflictError を throw する UoW」を
// 注入すれば bun test(D1 不要)で決定的に検証できる。「CAS が実際に競合を検知できること」は
// 上の D1CollectionUnitOfWork テスト(①②)が実 D1 で確定的に保証しているので、テストの役割を
// 「検知(D1 実装、ここ)」と「マッピング(presentation、bun test)」に分けた
// (test/presentation/app.test.ts の「R-7: ConcurrencyConflictError → 412 マッピング」参照)。
