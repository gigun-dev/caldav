// =============================================================================
// test/worker/d1-repositories.test.ts — D1CalendarCollectionRepository の
// supported_components 往復テスト(R-1 回帰修正)。
// =============================================================================
//
// 【なぜ workerd レーンか】
// src/infrastructure/d1/repositories.ts は実 D1Database(cloudflare:workers の
// env.DB)を触る。bun test には D1 が無いため、D1 実体を要求するこのテストは
// cloudflare:workers を import できる workerd レーン(vitest run)に置く
// (todo-e2e.test.ts / oauth-e2e.test.ts と同じ判断基準。vitest.config.ts 冒頭コメント参照)。
//
// 【HTTP 越し(MKCALENDAR)ではなくリポジトリを直接叩く理由】
// R-1 の本質的な回帰は「D1 に保存済みの VJOURNAL を含む supported_components を
// 読み戻す(hydrate)ときに parseSupported が VEVENT/VTODO のみのハードコード判定で
// throw する」という、HTTP layer より下のリポジトリ内部の往復バグ。MKCALENDAR を
// HTTP 経由で通すには本番同様 x-caldav-method 書き換えプロキシの偽装(PROXY_SHARED_SECRET
// 発行)が要るが、それは「プロキシ配線が正しいか」のテストであってこのバグの再現には
// 無関係な複雑さを持ち込む。D1CalendarCollectionRepository.save/findById を直接呼べば
// hydrateCollection → parseSupported を最短距離で通せるため、こちらを選んだ。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	D1CalendarCollectionRepository,
	D1CalendarObjectResourceRepository,
	D1PrincipalRepository,
} from "../../src/infrastructure/d1/repositories";
import { CalendarCollection, CalendarObjectResource, Principal, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";

describe("D1CalendarCollectionRepository: supported_components 往復", () => {
	it("VJOURNAL を含む supportedComponents を保存して読み戻せる(J-2 後の回帰: 以前は VEVENT/VTODO のみ許容で throw していた)", async () => {
		const repo = new D1CalendarCollectionRepository(env.DB);
		const owner = principalPath("/dav/principals/d1-repo-test/");
		const id = collectionId("journal-only");

		// calendar_collections.owner は principals.principal_path への外部キー
		// (migrations 参照)。先に principal を作らないと save が FK 違反で落ちる。
		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/d1-repo-test/"));

		const collection = new CalendarCollection({
			id,
			owner,
			displayName: "Journal only",
			supportedComponents: ["VJOURNAL"],
		});

		await repo.save(collection);

		const reloaded = await repo.findById(owner, id);
		expect(reloaded).not.toBeNull();
		expect(reloaded?.supportedComponents).toEqual(["VJOURNAL"]);
	});
});

// =============================================================================
// E-1 レイテンシ改善(2026-07-14): findVTodosInCollection の component_kind SQL 絞り込み
// =============================================================================
//
// 【UoW を使わず calendar_objects へ直接 INSERT する理由】
// D1CollectionUnitOfWork.saveResource は CalendarCollection の changeLog(直近の SyncChange)を
// 要求するため、このテストの主眼(SQL の WHERE component_kind = 'VTODO' が正しく絞り込むか)
// には不要な準備(sync_changes への記録)が付いてくる。calendar_objects の列は他の migration
// テストと同じくシンプルな INSERT で満たせるので、ここでは直接 INSERT する
// (上の supported_components テストが D1CalendarCollectionRepository を直接叩くのと同じ判断)。
describe("D1CalendarObjectResourceRepository.findVTodosInCollection: component_kind の SQL 絞り込み", () => {
	it("VEVENT/VJOURNAL を除外し、STATUS:COMPLETED の VTODO も含めて VTODO だけを返す", async () => {
		const owner = principalPath("/dav/principals/d1-repo-vtodo-test/");
		const id = collectionId("mixed");

		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/d1-repo-vtodo-test/"));
		await new D1CalendarCollectionRepository(env.DB).save(
			new CalendarCollection({ id, owner, displayName: "Mixed kinds" }),
		);

		// STATUS:COMPLETED の VTODO も SQL レベルでは絞られない(完了状態は
		// findVTodosInCollection のスコープ外。呼び出し側 UC がメモリで判定する設計 —
		// ports/index.ts の findVTodosInCollection コメント参照)ことを確認するため、
		// あえて完了済みの VTODO も1件混ぜる。
		const vtodoOpen = await CalendarObjectResource.fromIcs(
			resourceUri("open.ics"),
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:vtodo-open-001",
				"DTSTAMP:20260101T000000Z",
				"SUMMARY:Open Todo",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n"),
		);
		const vtodoCompleted = await CalendarObjectResource.fromIcs(
			resourceUri("done.ics"),
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTODO",
				"UID:vtodo-done-001",
				"DTSTAMP:20260101T000000Z",
				"STATUS:COMPLETED",
				"SUMMARY:Done Todo",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n"),
		);
		const vevent = await CalendarObjectResource.fromIcs(
			resourceUri("event.ics"),
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VEVENT",
				"UID:vevent-001",
				"DTSTAMP:20260101T000000Z",
				"DTSTART:20260710T100000Z",
				"DTEND:20260710T110000Z",
				"SUMMARY:An Event",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
		);

		for (const resource of [vtodoOpen, vtodoCompleted, vevent]) {
			await env.DB.prepare(
				`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(owner, id, resource.uri, resource.etag.hex, resource.rawIcs, resource.componentKind, resource.uid, Date.now()).run();
		}

		const repo = new D1CalendarObjectResourceRepository(env.DB);
		const results = await repo.findVTodosInCollection(owner, id);

		const uids = results.map((r) => r.uid).sort();
		expect(uids).toEqual(["vtodo-done-001", "vtodo-open-001"]);
		expect(results.every((r) => r.componentKind === "VTODO")).toBe(true);
	});
});

// =============================================================================
// D1CalendarCollectionRepository.delete: FK ON DELETE CASCADE の実 D1 検証(MCP delete-calendar 追加分)
// =============================================================================
//
// 【何を確認したいか】
// migrations/0001_init.sql の calendar_objects/sync_changes は両方とも
// `FOREIGN KEY (owner, collection_id) REFERENCES calendar_collections(owner, id) ON DELETE CASCADE`
// を持つ(0003_vjournal.sql の再作成後も同じ定義を維持)。D1CalendarCollectionRepository.delete は
// `DELETE FROM calendar_collections ...` を発行するだけで配下テーブルを明示的に消していない
// (repositories.ts 参照)ので、この CASCADE が実 D1 上で本当に効くこと自体をテストで固定する
// (アプリコードのコメントの「思い込み」を実機で裏取りする — CLAUDE.md の RFC 原文確認と同じ
// 精神で、D1 の挙動もコードコメントの主張だけに頼らず実行して確認する)。
//
// 【calendar_objects/sync_changes とも直接 INSERT する理由】
// 上の findVTodosInCollection テストと同じ判断: D1CollectionUnitOfWork を経由すると
// CalendarCollection の changeLog 構築など本題(CASCADE の確認)に不要な準備が増える。
// PRIMARY KEY/CHECK 制約さえ満たせば足りるので直接 INSERT する。
describe("D1CalendarCollectionRepository.delete: FK ON DELETE CASCADE", () => {
	it("コレクション削除で配下の calendar_objects と sync_changes も一括削除される", async () => {
		const owner = principalPath("/dav/principals/d1-repo-cascade-test/");
		const id = collectionId("cascade-target");

		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/d1-repo-cascade-test/"));
		await new D1CalendarCollectionRepository(env.DB).save(
			new CalendarCollection({ id, owner, displayName: "Cascade target" }),
		);

		await env.DB.prepare(
			`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(owner, id, "cascade.ics", "deadbeef", "BEGIN:VCALENDAR\r\nEND:VCALENDAR", "VEVENT", "cascade-uid", Date.now()).run();
		await env.DB.prepare(
			`INSERT INTO sync_changes(owner, collection_id, token, uri, kind) VALUES (?, ?, ?, ?, ?)`,
		).bind(owner, id, 1, "cascade.ics", "created").run();

		// 削除前提: 両テーブルに確かに1行ずつ存在すること。
		const objectsBefore = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM calendar_objects WHERE owner = ? AND collection_id = ?",
		).bind(owner, id).first<{ n: number }>();
		const changesBefore = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM sync_changes WHERE owner = ? AND collection_id = ?",
		).bind(owner, id).first<{ n: number }>();
		expect(objectsBefore?.n).toBe(1);
		expect(changesBefore?.n).toBe(1);

		await new D1CalendarCollectionRepository(env.DB).delete(owner, id);

		const objectsAfter = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM calendar_objects WHERE owner = ? AND collection_id = ?",
		).bind(owner, id).first<{ n: number }>();
		const changesAfter = await env.DB.prepare(
			"SELECT COUNT(*) as n FROM sync_changes WHERE owner = ? AND collection_id = ?",
		).bind(owner, id).first<{ n: number }>();
		expect(objectsAfter?.n).toBe(0);
		expect(changesAfter?.n).toBe(0);
	});
});

// =============================================================================
// レイテンシ案2(2026-07-22): findByOwnerTimeRange — コレクション横断1クエリ + collection_id 復元
// =============================================================================
//
// 【何を実 D1 で固定したいか】
// 1) owner 配下の複数コレクションの行を 1 クエリで返し、行ごとに collection_id を正しく復元すること
//    (application 層の across-owner UC が per-event calendarId を組み立てる土台)。
// 2) NULL の first/last_occurrence は常に候補に含める(索引未書き込み行を取りこぼさない)こと。
// 3) collectionIds 指定でその集合に絞り、undefined で全横断になること。
// 直接 INSERT する理由は上の findVTodosInCollection テストと同じ(UoW の changeLog 準備を避ける)。
describe("D1CalendarObjectResourceRepository.findByOwnerTimeRange: 横断1クエリ + collection_id 復元", () => {
	it("owner 配下の複数コレクションを 1 呼び出しで返し、collection_id を復元 / NULL bounds を含める / IN 絞り込みが効く", async () => {
		const owner = principalPath("/dav/principals/d1-repo-owner-tr-test/");
		const work = collectionId("owner-tr-work");
		const home = collectionId("owner-tr-home");

		await new D1PrincipalRepository(env.DB).save(Principal.create(owner, "/dav/d1-repo-owner-tr-test/"));
		const collections = new D1CalendarCollectionRepository(env.DB);
		await collections.save(new CalendarCollection({ id: work, owner, displayName: "Work" }));
		await collections.save(new CalendarCollection({ id: home, owner, displayName: "Home" }));

		// 窓 [2026-01-06, 2026-01-07)。work は窓内の bounds 付き VEVENT、home は bounds NULL の VEVENT。
		const windowStart = Date.UTC(2026, 0, 6);
		const windowEnd = Date.UTC(2026, 0, 7);
		// findByOwnerTimeRange は行を hydrate(fromIcs)するので、空 ICS ではなく妥当な本文が要る。
		const bodyFor = (uid: string, kind: string) =>
			kind === "VTODO"
				? ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				   "BEGIN:VTODO", `UID:${uid}`, "DTSTAMP:20260101T000000Z", "SUMMARY:t", "END:VTODO", "END:VCALENDAR"].join("\r\n")
				: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
				   "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z",
				   "DTSTART:20260106T090000Z", "DTEND:20260106T100000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		const insert = async (
			cid: string,
			uri: string,
			uid: string,
			kind: string,
			first: number | null,
			last: number | null,
		) => {
			await env.DB.prepare(
				`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(owner, cid, uri, `etag-${uid}`, bodyFor(uid, kind), kind, uid, Date.now(), first, last).run();
		};
		// work: 窓内に収まる VEVENT。
		await insert("owner-tr-work", "w.ics", "w-evt", "VEVENT", Date.UTC(2026, 0, 6, 9), Date.UTC(2026, 0, 6, 10));
		// home: bounds NULL(未索引)の VEVENT → 常に候補に含まれるべき。
		await insert("owner-tr-home", "h.ics", "h-evt", "VEVENT", null, null);
		// work: 窓の外(前日で完結)の VEVENT → 除外されるべき。
		await insert("owner-tr-work", "past.ics", "past-evt", "VEVENT", Date.UTC(2026, 0, 1, 9), Date.UTC(2026, 0, 1, 10));
		// work: 別 component_kind(VTODO)→ VEVENT クエリでは除外されるべき。
		await insert("owner-tr-work", "t.ics", "t-todo", "VTODO", null, null);

		const repo = new D1CalendarObjectResourceRepository(env.DB);

		// 全横断(collectionIds 省略)。
		const all = await repo.findByOwnerTimeRange(owner, "VEVENT", windowStart, windowEnd);
		const byUid = new Map(all.map((m) => [m.resource.uid, m.collectionId]));
		expect([...byUid.keys()].sort()).toEqual(["h-evt", "w-evt"]); // past-evt(窓外)/ t-todo(VTODO)は除外
		expect(byUid.get("w-evt")).toBe(work); // collection_id 復元
		expect(byUid.get("h-evt")).toBe(home); // NULL bounds でも含む + 復元

		// collectionIds=[work] に絞ると home の h-evt は落ちる。
		const workOnly = await repo.findByOwnerTimeRange(owner, "VEVENT", windowStart, windowEnd, [work]);
		expect(workOnly.map((m) => m.resource.uid)).toEqual(["w-evt"]);

		// 空配列は空結果(全横断に化けない)。
		const none = await repo.findByOwnerTimeRange(owner, "VEVENT", windowStart, windowEnd, []);
		expect(none).toEqual([]);
	});
});
