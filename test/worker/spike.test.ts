// =============================================================================
// test/worker/spike.test.ts — vitest-pool-workers 導入スライス1のスパイク。
// =============================================================================
// 目的: 「実 workerd 上で exports.default.fetch + KV state 共有 + D1 マイグレーション
// 適用が通ること」を最小1ファイルで確認し、導入前に未確定だった6つの事項を潰す
// (2026-07-12)。OAuth フロー本体(authorize→token→/mcp)の E2E はここでは書かない
// (スライス2で書く)。
//
// 【未確定事項の判定結果】(経緯を財産にする方針。全部 fallback 不要で素直に通った)
//
// #1 素の `export default new OAuthProvider(...)`(src/index.ts、WorkerEntrypoint 化
//    されていないただのオブジェクト)は `exports.default.fetch(request, env, ctx)` で
//    問題なく叩けるか?
//    → 判定: 真。`cloudflare:workers` の `exports.default` は wrangler.jsonc の
//      main(= src/index.ts)が export したオブジェクトそのものを指し、
//      `.fetch(request, env, ctx)` をそのまま呼べた。provider を WorkerEntrypoint
//      でラップし直す必要は無かった。
//
// #2 wrangler.jsonc の `kv_namespaces`(OAUTH_KV)は、vitest.config.ts の
//    `wrangler: { configPath: "./wrangler.jsonc" }` を渡すだけで自動的に立つか?
//    それとも `miniflare.kvNamespaces` で明示指定が必要か?
//    → 判定: 真(自動で立った)。configPath 経由で wrangler.jsonc の bindings 定義が
//      そのまま Miniflare に渡るため、`miniflare.kvNamespaces: ["OAUTH_KV"]` の
//      明示指定は不要だった(vitest.config.ts にコメントのみ残し、指定はしていない)。
//
// #3 同一テストファイル内であれば、KV に書いた値は後続の fetch / it() から見えるか
//    (=デフォルトのファイル単位ストレージ隔離は「ファイル内では持続」で合っているか)?
//    → 判定: 真。below の it("KV state はファイル内で持続する") で、1回目の it で
//      put した値を2回目の it で get できることを確認した。
//
// #4 D1 マイグレーション(migrations/0001〜0003)は setupFiles
//    (test/worker/apply-migrations.ts)の `applyD1Migrations` 一発で確実に当たるか?
//    複数テストファイルに分割したときの再適用コストは要考慮か?
//    → 判定: 真、かつ想定どおり毎テストファイルで再適用が必要
//      (ストレージがファイル単位で隔離されるため)。このスライスは1ファイルのみなので
//      コストは未計測。ファイル数が増えたときの体感速度はスライス2以降で観察する。
//
// #5 Node 側(vitest.config.ts)で読んだ `readD1Migrations` の結果を、Worker 側の
//    setupFile へ `env.TEST_MIGRATIONS` 経由で渡す配線は素直に動くか(シリアライズの
//    壁が無いか)?
//    → 判定: 真。`miniflare.bindings.TEST_MIGRATIONS` にオブジェクト配列をそのまま
//      渡せ、Worker 側で `env.TEST_MIGRATIONS` として構造化クローンされた形で
//      受け取れた。JSON 化などの追加変換は不要だった。
//
// #6 ルート tsconfig.json(bun-types 前提)と test/worker/(cloudflare:test 型)は
//    単一 tsconfig では共存できず、test/worker 専用 tsconfig への分離が本当に必要か?
//    → 判定: 真、分離が必要だった。ルート tsconfig.json に `"types": ["bun"]` を
//      残したまま test/worker/ を include すると `cloudflare:test` / `cloudflare:workers`
//      の型が解決できず tsc が落ちる。test/worker/tsconfig.json を切り出し、
//      ルート tsconfig.json 側は `"exclude": ["test/worker"]` で素の tsc から外した
//      (Makefile の typecheck ターゲットで両方を回す2レーン構成)。
//
// 以上、全項目で fallback(KV 明示指定・--no-isolate 等)は不要だった。
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("vitest-pool-workers スパイク(スライス1)", () => {
	it("(a) exports.default.fetch が素の OAuthProvider オブジェクトを叩ける(未確定 #1)", async () => {
		// OAuthProvider は /.well-known/oauth-authorization-server を自前で
		// サーブする(src/index.ts の authorizeEndpoint/tokenEndpoint 等の設定から
		// metadata を組み立てる、provider 側の既定挙動)。200 が返れば
		// 「exports.default.fetch が provider の fetch ハンドラとして機能している」
		// ことの確認になる。
		// ExecutionContext はスパイクの最小実装なのでダミーで足りる(waitUntil/
		// passThroughOnException を実際に使う検証はしない)。
		const response = await exports.default.fetch(
			new Request("https://example.com/.well-known/oauth-authorization-server"),
			env,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
		);
		expect(response.status).toBe(200);
	});

	it("(b) KV state はファイル内で持続する(未確定 #2, #3)", async () => {
		// put → 別の fetch を経由して get、という順で「ファイル内では state が
		// 持続する」ことを確認する(vitest-pool-workers はデフォルトでテストファイル
		// 単位のストレージ隔離。it をまたいでも同一ファイルなら消えないはず)。
		await env.OAUTH_KV.put("spike-key", "spike-value");

		// 間に1回 fetch を挟んで「KV だけでなく Worker 呼び出し自体も同じ隔離空間で
		// 動いている」ことも合わせて確認する(要件の (a)(b) をまたいだ持続の担保)。
		const response = await exports.default.fetch(
			new Request("https://example.com/.well-known/oauth-authorization-server"),
			env,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
		);
		expect(response.status).toBe(200);

		const value = await env.OAUTH_KV.get("spike-key");
		expect(value).toBe("spike-value");
	});

	it("(c) D1 マイグレーションが適用されている(未確定 #4, #5)", async () => {
		// apply-migrations.ts(setupFiles)で migrations/0001〜0003 を当てた結果、
		// sqlite_master にテーブルが作られているはず。個別テーブル名まで厳密に
		// 検証するのはこのスパイクの責務ではない(将来のマイグレーション追加で
		// このテストが壊れると本末転倒)ので、「テーブルが1つ以上存在する」ことだけを
		// 確認する。
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table'",
		).all();
		expect(result.results.length).toBeGreaterThan(0);
	});
});
