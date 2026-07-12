// =============================================================================
// vitest.config.ts — 実 workerd(Miniflare)上でテストを走らせる「もう一方のレーン」。
// =============================================================================
// 【なぜ bun test と別レーンなのか】
// このリポジトリの主テストランナーは `bun test`(Bun 内蔵、Node ライク環境)。
// だが `src/index.ts`(OAuthProvider 本体・`cloudflare:workers` の値 import を含む)や、
// `cloudflare:workers` の `exports.default.fetch` を叩く検証、KV/D1 バインディングを
// 実物で触る検証は Bun の Node ライク環境では原理的に再現できない
// (`cloudflare:*` は workerd が提供する仮想モジュールで Node には存在しない)。
// そこで `@cloudflare/vitest-pool-workers` を使い、実 workerd ランタイム上でだけ
// 走らせるテストを `test/worker/` に隔離し、vitest 専用レーンとして追加する
// (2026-07-12 ハイブリッド導入スライス1・スパイク)。
//
// 【振り分け基準】(Makefile の check ターゲット側にも同じ説明を残す)
//   - `cloudflare:workers` / `cloudflare:test` を import する、または
//     provider 本体(src/index.ts の default export)を実際に fetch で叩く検証
//     → test/worker/(このレーン、vitest run)
//   - それ以外(domain/application/infrastructure/presentation の大半)
//     → test/(従来どおり、bun test)
//
// 【未確定事項の判定結果は test/worker/spike.test.ts 冒頭コメントに記録】
// （#1 exports.default.fetch 経由の呼び出し可否、#2 KV の自動起動、#3 ファイル内 state
//   持続、#4 D1 マイグレーション適用、#5 config 側の readD1Migrations 配線、
//   #6 tsconfig 分離の要否 — 詳細は spike.test.ts を参照）。
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
// テスト専用ダミー secret の単一ソース。test/worker/test-secrets.ts から import する
// (apply-migrations.ts から直接 import しないのは、apply-migrations.ts が
// `cloudflare:test`(workerd 専用の仮想モジュール)を import しており、Node 側の
// この config から辿ると `ERR_UNSUPPORTED_ESM_URL_SCHEME` で落ちるため。
// test-secrets.ts 冒頭コメント参照)。
import { TEST_DUMMY_SECRETS } from "./test/worker/test-secrets";

export default defineConfig({
	test: {
		// test/worker/ 配下だけをこのレーンで拾う。bun test 側(test/domain 等)と
		// ディレクトリで完全に分離し、二重実行や取りこぼしを防ぐ。
		include: ["test/worker/**/*.test.ts"],
		// D1 マイグレーション適用(env.DB に対して)をテスト本体の前に必ず走らせる。
		// setupFile 側は `cloudflare:test` の env からしか DB ハンドルに触れられないため、
		// ここで一度だけ実行し、以降の各テストファイル(ファイル単位でストレージ隔離される
		// デフォルト挙動)は適用済みの DB を使い回す。
		setupFiles: ["./test/worker/apply-migrations.ts"],
	},
	plugins: [
		// options を async 関数で渡せるのは、readD1Migrations がファイル I/O を伴う
		// 非同期処理のため(config 構築時に Node 側で一度だけ読む)。
		cloudflareTest(async () => {
			// migrations/ 直下の *.sql を通し番号順に読み、setupFile へ
			// env.TEST_MIGRATIONS として渡す(applyD1Migrations の第2引数)。
			const migrations = await readD1Migrations("./migrations");

			return {
				// wrangler.jsonc をそのまま読ませることで、d1_databases(DB)・
				// kv_namespaces(OAUTH_KV)・vars 等のバインディング定義を二重管理しない。
				// main(Worker エントリポイント = src/index.ts)もここから自動導出される
				// (unstable_getMiniflareWorkerOptions が options.main を補完するため、
				// このファイルで明示指定は不要 — 未確定事項 #1 の判定結果は
				// spike.test.ts 参照)。
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						// D1 マイグレーション本体。setupFile(apply-migrations.ts)が
						// env.TEST_MIGRATIONS として受け取って applyD1Migrations に渡す。
						TEST_MIGRATIONS: migrations,
						// 本番 secret は Wrangler secret(.dev.vars 等)で管理し、この
						// テスト config には一切登場させない。ここに書くのは
						// 「テストでしか使わないダミー値」であることを明示するため、
						// 本物と紛れない値にしている(test-password / test-mcp-token)。
						// 値の単一ソースは test/worker/apply-migrations.ts
						// (TEST_DUMMY_SECRETS)— ここでは import して詰めるだけにし、
						// 二重定義による 定義ズレ を防ぐ。
						...TEST_DUMMY_SECRETS,
					},
					// KV は wrangler.jsonc の kv_namespaces(OAUTH_KV)を configPath 経由で
					// 読ませれば自動で立った(未確定事項 #2 の判定結果、
					// spike.test.ts 参照)。miniflare.kvNamespaces の明示指定は不要だった。
				},
			};
		}),
	],
});
