// =============================================================================
// test/worker/cas-concurrency.test.ts — S-B(楽観ロックの作り直し)のテスト。
// =============================================================================
//
// 【背景(R-7 → S-B の経緯)】
// R-7 はコレクション sync_counter の baseline 比較 CAS を導入したが、これは「別リソースへの
// 並行書き込みまで 412 にする過剰ガード」だと実機で判明した(iOS の PUT・LLM の update-event・
// カードの保存が別々のリソースでも重なると「変更を保存できません」— docs/modeling/12 §7.4)。
// S-B で:
//   - コレクション CAS を廃止し、採番は `sync_counter = sync_counter + 1` のアトミック
//     インクリメント + sync_changes token はトランザクション内サブクエリで DB 側採番。
//   - 同一リソースの整合検知はリソース単位の DB 側 ETag CAS(③の書き込みに etag 条件)で閉じる。
//   - 同一リソース競合時は update-event/update-todo UC が1回だけ自動 re-read→re-patch
//     (ETagConditionError=メモリ判定 / ConcurrencyConflictError=DB 側 CAS のどちらでも発火)。
// このファイルはその4点を固定する(旧 R-7 CAS テストは前提ごと書き換えた)。
//
// 【なぜ workerd レーンか】
// D1CollectionUnitOfWork は実 D1Database を触るため、bun test(Node ライク環境)には
// D1 が無く再現できない(d1-repositories.test.ts と同じ判断基準)。
//
// 【sleep を使わず決定的にテストする方法】
// miniflare ローカル D1 はクエリを逐次処理するので、真の並行実行は作れない(旧ファイルの
// 実測どおり Promise.all の2 PUT も直列化される)。代わりに:
//   - 別リソース並行: 「同一コレクションを2回 hydrate → それぞれ recordChange → 順に
//     saveResource」という制御フローを直接組み立てる(2つの並行リクエストが同じ状態を読んだ
//     状況の決定的な再現。期待値は「両方成功」)。
//   - ETag CAS: uow.saveResource に「stale な expected etag」を直接渡し、③の 0 行検知を確かめる。
//   - UC 自動リトライ: (b)(c) は lookup にだけ stale を返すデコレータ(メモリ判定経路)、
//     (d) は put の Step 2 read 直後に競合書き込みを差し込むデコレータ(DB CAS 経路)で、
//     いずれも実時間に依存せず決定的に競合を作る。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	D1CalendarCollectionRepository,
	D1CalendarObjectResourceRepository,
	D1CollectionUnitOfWork,
	D1PrincipalRepository,
} from "../../src/infrastructure/d1/repositories";
import { IcaljsRRuleIterator } from "../../src/infrastructure/recurrence/icaljs-rrule-iterator";
import { ConcurrencyConflictError, type CalendarObjectResourceRepository } from "../../src/application/ports";
import { ETagConditionError, PutCalendarObject } from "../../src/application/usecases/put-calendar-object";
import { UpdateEvent } from "../../src/application/usecases/update-event";
import {
	CalendarCollection,
	CalendarObjectResource,
	Principal,
	collectionId,
	principalPath,
	resourceUri,
	type CollectionId,
	type PrincipalRef,
	type ResourceUri,
} from "../../src/domain/caldav";

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

/** owner + collection をシードして各リポジトリを束ねて返す(全テスト共通の前準備)。 */
async function setup(ownerPath: string, colId: string) {
	const owner = principalPath(ownerPath);
	const id = collectionId(colId);
	await new D1PrincipalRepository(env.DB).save(Principal.create(owner, ownerPath.replace("principals", "calendars")));
	const collectionRepo = new D1CalendarCollectionRepository(env.DB);
	const resourceRepo = new D1CalendarObjectResourceRepository(env.DB);
	const uow = new D1CollectionUnitOfWork(env.DB);
	await collectionRepo.save(new CalendarCollection({ id, owner, displayName: "S-B test" }));
	return { owner, id, collectionRepo, resourceRepo, uow };
}

// =============================================================================
// 1. 別リソースへの並行書き込みは両方成功する(R-7 では片方が 412 だった — S-B の是正本体)
// =============================================================================
describe("D1CollectionUnitOfWork: S-B アトミック採番(コレクション CAS 廃止)", () => {
	it("同じ状態を hydrate した2本が別リソースへ書いても両方成功し、token は 1,2 と重複しない", async () => {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(
			"/dav/principals/sb-parallel/", "sb-calendar",
		);

		// 「2つの並行リクエストが同じコレクション状態を読んだ」ことを2回の findById で決定的に再現。
		// R-7 ではこの2本の後発側が baseline CAS で ConcurrencyConflictError になっていた。
		const collectionA = await collectionRepo.findById(owner, id);
		const collectionB = await collectionRepo.findById(owner, id);
		if (!collectionA || !collectionB) throw new Error("test setup: collection not found");

		const resourceA = await CalendarObjectResource.fromIcs(resourceUri("a.ics"), makeIcs("uid-a", "A"));
		const resourceB = await CalendarObjectResource.fromIcs(resourceUri("b.ics"), makeIcs("uid-b", "B"));
		collectionA.recordChange(resourceA.uri, "created");
		collectionB.recordChange(resourceB.uri, "created");

		// S-B: どちらも成功する(別リソースなので競合ではない)。create 前提条件で書く。
		await uow.saveResource(owner, id, resourceA, collectionA, { firstMillis: null, lastMillis: null }, { kind: "create" });
		await uow.saveResource(owner, id, resourceB, collectionB, { firstMillis: null, lastMillis: null }, { kind: "create" });

		// counter は 0 → 2 に単調増加(RFC 6578 のトークン後退なし)。
		const finalCollection = await collectionRepo.findById(owner, id);
		expect(finalCollection?.syncToken.counter).toBe(2);

		// sync_changes の token は DB 側採番により 1, 2 で重複しない(メモリ上は両方 counter=1 を
		// 計算していた — それを書かないことがサブクエリ採番の狙い。repositories.ts ②コメント)。
		const tokens = await env.DB.prepare(
			"SELECT token, uri FROM sync_changes WHERE owner = ? AND collection_id = ? ORDER BY token",
		).bind(owner, id).all<{ token: number; uri: string }>();
		expect(tokens.results.map((r) => r.token)).toEqual([1, 2]);

		// 両リソースとも保存されている。
		expect((await resourceRepo.findByUri(owner, id, resourceA.uri))?.uid).toBe("uid-a");
		expect((await resourceRepo.findByUri(owner, id, resourceB.uri))?.uid).toBe("uid-b");
	});

	it("saveResource と deleteResource が同じ状態から並行しても両方成功する", async () => {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(
			"/dav/principals/sb-parallel-del/", "sb-del-calendar",
		);

		// 削除対象を先に1件作る(counter は 1 になる)。
		const seedCollection = await collectionRepo.findById(owner, id);
		if (!seedCollection) throw new Error("test setup: collection not found");
		const target = await CalendarObjectResource.fromIcs(resourceUri("target.ics"), makeIcs("uid-t", "T"));
		seedCollection.recordChange(target.uri, "created");
		await uow.saveResource(owner, id, target, seedCollection, { firstMillis: null, lastMillis: null }, { kind: "create" });

		// 同じ状態(counter=1)を読んだ2本: A は別リソース作成、B は target 削除(無条件削除)。
		// R-7 の旧テストではこの B が ConcurrencyConflictError になることを固定していた(反転)。
		const collectionA = await collectionRepo.findById(owner, id);
		const collectionB = await collectionRepo.findById(owner, id);
		if (!collectionA || !collectionB) throw new Error("test setup: collection not found");
		const other = await CalendarObjectResource.fromIcs(resourceUri("other.ics"), makeIcs("uid-o", "O"));
		collectionA.recordChange(other.uri, "created");
		collectionB.recordChange(target.uri, "deleted");

		await uow.saveResource(owner, id, other, collectionA, { firstMillis: null, lastMillis: null }, { kind: "create" });
		await uow.deleteResource(owner, id, target.uri, collectionB, { kind: "overwrite" });

		// counter 1 → 3、target は消え、other は残る。
		const finalCollection = await collectionRepo.findById(owner, id);
		expect(finalCollection?.syncToken.counter).toBe(3);
		expect(await resourceRepo.findByUri(owner, id, target.uri)).toBeNull();
		expect((await resourceRepo.findByUri(owner, id, other.uri))?.uid).toBe("uid-o");

		// 変更ログ: created(1), created(2), deleted(3) — sync-collection の差分計算が成立する形。
		const changes = await env.DB.prepare(
			"SELECT token, kind FROM sync_changes WHERE owner = ? AND collection_id = ? ORDER BY token",
		).bind(owner, id).all<{ token: number; kind: string }>();
		expect(changes.results.map((r) => [r.token, r.kind])).toEqual([
			[1, "created"], [2, "created"], [3, "deleted"],
		]);
	});
});

// =============================================================================
// 2. リソース単位 ETag CAS(③の 0 行検知)— 同一リソースの TOCTOU を DB 側で閉じる
// =============================================================================
describe("D1CollectionUnitOfWork: S-B リソース単位 ETag CAS(③)", () => {
	it("match 前提条件で expected etag がずれていると ③ が 0 行になり ConcurrencyConflictError(counter も進まない)", async () => {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(
			"/dav/principals/sb-etag-stale/", "sb-etag-calendar",
		);

		// v1 を作成(counter=1)。
		const seed = await collectionRepo.findById(owner, id);
		if (!seed) throw new Error("test setup: collection not found");
		const v1 = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r", "V1"));
		seed.recordChange(v1.uri, "created");
		await uow.saveResource(owner, id, v1, seed, { firstMillis: null, lastMillis: null }, { kind: "create" });

		// v2(別内容 = 別 etag)を「stale な expected」で書こうとする。expected を実在しない etag に
		// することで「lookup 後に他者が書いて etag がずれた」状況を直接作る。
		const v2 = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r", "V2"));
		const col = await collectionRepo.findById(owner, id);
		if (!col) throw new Error("test setup: collection not found");
		col.recordChange(v2.uri, "modified");
		const staleExpected = "0".repeat(64); // 現在 etag(v1)とは絶対に一致しない SHA-256 hex 長。
		await expect(
			uow.saveResource(owner, id, v2, col, { firstMillis: null, lastMillis: null }, { kind: "match", expectedEtag: staleExpected }),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);

		// ①②③すべてが 0 行 no-op になっているので、counter は 1 のまま・中身も v1 のまま。
		const finalCol = await collectionRepo.findById(owner, id);
		expect(finalCol?.syncToken.counter).toBe(1);
		const stored = await resourceRepo.findByUri(owner, id, v1.uri);
		expect(stored?.rawIcs).toContain("SUMMARY:V1");
	});

	it("match 前提条件で expected etag が現在値と一致すれば成功し counter が進む", async () => {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(
			"/dav/principals/sb-etag-ok/", "sb-etag-ok-calendar",
		);

		const seed = await collectionRepo.findById(owner, id);
		if (!seed) throw new Error("test setup: collection not found");
		const v1 = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r", "V1"));
		seed.recordChange(v1.uri, "created");
		await uow.saveResource(owner, id, v1, seed, { firstMillis: null, lastMillis: null }, { kind: "create" });

		// 正しい expected(= v1 の etag)で v2 を書く → 成功。
		const v2 = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r", "V2"));
		const col = await collectionRepo.findById(owner, id);
		if (!col) throw new Error("test setup: collection not found");
		col.recordChange(v2.uri, "modified");
		await uow.saveResource(owner, id, v2, col, { firstMillis: null, lastMillis: null }, { kind: "match", expectedEtag: v1.etag.hex });

		const finalCol = await collectionRepo.findById(owner, id);
		expect(finalCol?.syncToken.counter).toBe(2);
		expect((await resourceRepo.findByUri(owner, id, v1.uri))?.rawIcs).toContain("SUMMARY:V2");
	});

	it("create 前提条件で対象 URI が既に在れば ConcurrencyConflictError(TOCTOU create)", async () => {
		const { owner, id, collectionRepo, uow } = await setup(
			"/dav/principals/sb-create-race/", "sb-create-calendar",
		);

		const seed = await collectionRepo.findById(owner, id);
		if (!seed) throw new Error("test setup: collection not found");
		const first = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r", "First"));
		seed.recordChange(first.uri, "created");
		await uow.saveResource(owner, id, first, seed, { firstMillis: null, lastMillis: null }, { kind: "create" });

		// 同じ URI へもう一度 create(並行 create が先に入っていた状況)→ PK 制約違反 → 競合。
		const dup = await CalendarObjectResource.fromIcs(resourceUri("r.ics"), makeIcs("uid-r2", "Dup"));
		const col = await collectionRepo.findById(owner, id);
		if (!col) throw new Error("test setup: collection not found");
		col.recordChange(dup.uri, "created");
		await expect(
			uow.saveResource(owner, id, dup, col, { firstMillis: null, lastMillis: null }, { kind: "create" }),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);
	});
});

// =============================================================================
// 3. UpdateEvent の自動リトライ(1回だけ re-read→re-patch)
// =============================================================================

/**
 * UpdateEvent の lookup にだけ stale な読み取り結果を返すデコレータ(メモリ判定経路の競合)。
 *
 * lookup が古い ETag を掴む → patch → must-match PUT が古い ETag で飛ぶ → put の Step 3 メモリ
 * 判定(現在 etag と食い違う)で ETagConditionError。実時間の割り込みは miniflare では作れない
 * ので、「UC が読んだ時点ではまだ古かった」ことをデコレータで決定的に模す。
 */
function staleReadRepo(
	real: CalendarObjectResourceRepository,
	stale: CalendarObjectResource,
	staleServings: number,
): CalendarObjectResourceRepository {
	let remaining = staleServings;
	return {
		findAllInCollection: (o, c) => real.findAllInCollection(o, c),
		findManyByUri: (o, c, u) => real.findManyByUri(o, c, u),
		findUriByUid: (o, c, u) => real.findUriByUid(o, c, u),
		getUidAtUri: (o, c, u) => real.getUidAtUri(o, c, u),
		findInCollectionByTimeRange: (o, c, k, s, e) => real.findInCollectionByTimeRange(o, c, k, s, e),
		findVTodosInCollection: (o, c) => real.findVTodosInCollection(o, c),
		async findByUri(o: PrincipalRef, c: CollectionId, u: ResourceUri) {
			if (remaining > 0 && u === stale.uri) {
				remaining -= 1;
				return stale;
			}
			return real.findByUri(o, c, u);
		},
	};
}

/**
 * put の Step 2 read の「直後」に一度だけ競合書き込みを差し込むデコレータ(DB CAS 経路の競合)。
 *
 * findByUri は現在値を real から読んで返すが、返す前に onFirstRead(= 別クライアントの書き込み)を
 * 一度だけ実行する。これにより put は「読んだ時点の etag」を expected にして UoW へ渡すが、DB は
 * その後 competing 書き込みで別 etag に進んでいるため、③の etag CAS が 0 行 → ConcurrencyConflictError
 * になる(= put の Step 3 メモリ判定は通過したのに、書き込み直前の TOCTOU を DB 側で捕まえる経路)。
 */
function conflictInjectingRepo(
	real: CalendarObjectResourceRepository,
	targetUri: ResourceUri,
	onFirstRead: () => Promise<void>,
): CalendarObjectResourceRepository {
	let armed = true;
	return {
		findAllInCollection: (o, c) => real.findAllInCollection(o, c),
		findManyByUri: (o, c, u) => real.findManyByUri(o, c, u),
		findUriByUid: (o, c, u) => real.findUriByUid(o, c, u),
		getUidAtUri: (o, c, u) => real.getUidAtUri(o, c, u),
		findInCollectionByTimeRange: (o, c, k, s, e) => real.findInCollectionByTimeRange(o, c, k, s, e),
		findVTodosInCollection: (o, c) => real.findVTodosInCollection(o, c),
		async findByUri(o: PrincipalRef, c: CollectionId, u: ResourceUri) {
			const value = await real.findByUri(o, c, u);
			// put の Step 2 read(= このデコレータへの findByUri)を掴んだら、返す前に競合を注入する。
			// 一度だけ(armed)。返す value は「注入前」の読み取り結果なので、put は古い etag を掴む。
			if (armed && u === targetUri && value !== null) {
				armed = false;
				await onFirstRead();
			}
			return value;
		},
	};
}

describe("UpdateEvent: S-B 同一リソース競合の自動リトライ", () => {
	const iterator = new IcaljsRRuleIterator();

	/** 共通シナリオ: v1 を作成 → stale(v1)を捕捉 → 他クライアントが summary を書き換え(v2)。 */
	async function seedConflict(ownerPath: string, colId: string) {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(ownerPath, colId);
		const put = new PutCalendarObject(collectionRepo, resourceRepo, uow, iterator);

		await put.execute({
			owner, collectionId: id, resourceUri: "conflict.ics",
			ics: makeIcs("conflict-uid", "Original"),
		});
		const stale = await resourceRepo.findByUri(owner, id, resourceUri("conflict.ics"));
		if (!stale) throw new Error("test setup: resource not found");

		// 「他クライアント」が同じリソースを書き換える(iOS の素の PUT を模して unconditional)。
		await put.execute({
			owner, collectionId: id, resourceUri: "conflict.ics",
			ics: makeIcs("conflict-uid", "Changed by other client"),
		});
		return { owner, id, collectionRepo, resourceRepo, uow, put, stale };
	}

	it("(b) メモリ判定経路: stale lookup → ETagConditionError → 自動 re-read→re-patch で成功し他クライアントの変更も残る", async () => {
		const { owner, id, resourceRepo, put, stale } = await seedConflict(
			"/dav/principals/sb-retry/", "sb-retry-calendar",
		);

		// 1回目の lookup だけ stale を返す。→ 1回目 PUT は must-match(旧 ETag)で ETagConditionError
		// → UC が re-read して2回目で成功。
		const updateEvent = new UpdateEvent(put, staleReadRepo(resourceRepo, stale, 1));
		const output = await updateEvent.execute({
			owner, eventId: "conflict-uid", calendarId: "sb-retry-calendar",
			location: "Meeting Room 1",
		});
		expect(output.event.location).toBe("Meeting Room 1");

		// lost update になっていないこと: 意味的パッチ(location のみ)の再適用なので、他クライアントが
		// 書いた SUMMARY は上書きされず最新のまま残る(リトライ安全性の核心)。
		expect(output.event.title).toBe("Changed by other client");
		const finalIcs = (await resourceRepo.findByUri(owner, id, stale.uri))?.rawIcs ?? "";
		expect(finalIcs).toContain("SUMMARY:Changed by other client");
		expect(finalIcs).toContain("LOCATION:Meeting Room 1");
	});

	it("(c) リトライ後もまだ競合する(2回連続 stale)なら ETagConditionError を伝播する(素の 412 が最後の砦)", async () => {
		const { owner, resourceRepo, put, stale } = await seedConflict(
			"/dav/principals/sb-retry-fail/", "sb-retry-fail-calendar",
		);

		// 2回とも stale を返す = re-read しても古い状態しか読めない(ビジー状態の模擬)。
		// 3回目のリトライはしない(update-event.ts の execute コメント: 無限再適用の方が危険)。
		const updateEvent = new UpdateEvent(put, staleReadRepo(resourceRepo, stale, 2));
		await expect(
			updateEvent.execute({
				owner, eventId: "conflict-uid", calendarId: "sb-retry-fail-calendar",
				location: "Meeting Room 1",
			}),
		).rejects.toBeInstanceOf(ETagConditionError);
	});

	it("(d) DB CAS 経路: メモリ判定を通過した後の TOCTOU を③の 0 行が捕まえ、ConcurrencyConflictError でも自動リトライして成功する", async () => {
		const { owner, id, collectionRepo, resourceRepo, uow } = await setup(
			"/dav/principals/sb-dbcas/", "sb-dbcas-calendar",
		);
		// v1 を作る。
		const realPut = new PutCalendarObject(collectionRepo, resourceRepo, uow, iterator);
		await realPut.execute({ owner, collectionId: id, resourceUri: "r.ics", ics: makeIcs("uid-r", "V1") });

		// put の Step 2 read の直後に「他クライアントの書き込み(v2)」を一度だけ注入する。
		// competing は本物のリポジトリを使う別 PutCalendarObject(注入デコレータを介さない)。
		const competingPut = new PutCalendarObject(collectionRepo, resourceRepo, uow, iterator);
		const injectedRepo = conflictInjectingRepo(resourceRepo, resourceUri("r.ics"), async () => {
			await competingPut.execute({
				owner, collectionId: id, resourceUri: "r.ics",
				ics: makeIcs("uid-r", "Changed by other client"),
			});
		});
		// update-event が使う put は「注入デコレータ」を読み取り側に持つ(= Step 2 read で競合注入)。
		// lookup 側は本物の resourceRepo を使う(注入は put の Step 2 でだけ起こす)。
		const injectingPut = new PutCalendarObject(collectionRepo, injectedRepo, uow, iterator);
		const updateEvent = new UpdateEvent(injectingPut, resourceRepo);

		const output = await updateEvent.execute({
			owner, eventId: "uid-r", calendarId: "sb-dbcas-calendar",
			location: "Meeting Room 2",
		});

		// 1回目: put の Step 3 メモリ判定は expected==現在(v1)で通過 → だが uow 直前に v2 が入り、
		// ③の etag CAS が 0 行 → ConcurrencyConflictError → UC が isSameResourceConflict でリトライ。
		// 2回目: lookup が v2 を読み、location を再適用して成功。
		expect(output.event.location).toBe("Meeting Room 2");
		// lost update なし: 競合クライアントの SUMMARY は残る。
		expect(output.event.title).toBe("Changed by other client");
		const finalIcs = (await resourceRepo.findByUri(owner, id, resourceUri("r.ics")))?.rawIcs ?? "";
		expect(finalIcs).toContain("SUMMARY:Changed by other client");
		expect(finalIcs).toContain("LOCATION:Meeting Room 2");
	});
});
