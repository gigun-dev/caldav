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
import { D1CalendarCollectionRepository, D1PrincipalRepository } from "../../src/infrastructure/d1/repositories";
import { CalendarCollection, Principal, collectionId, principalPath } from "../../src/domain/caldav";

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
