// =============================================================================
// test/worker/apply-migrations.ts — vitest の setupFiles(vitest.config.ts 参照)。
// =============================================================================
// vitest-pool-workers はテストファイル単位でストレージ(D1/KV/Durable Objects等)を
// 隔離する(デフォルト挙動)。そのため D1 マイグレーションは「1回だけグローバルに
// 適用」ではなく、setupFiles として各テストファイルの実行前に毎回適用する必要がある
// (未確定事項 #4 の判定結果: これで問題なく通った。D1 の中身自体はテストファイル
// 内では持続するので、同一ファイル内で複数 it() をまたいでも再適用されない)。
//
// env.TEST_MIGRATIONS は vitest.config.ts の miniflare.bindings で
// readD1Migrations("./migrations") の結果を渡している(Node 側で読んだものを
// Worker 側の env 経由で受け取る、という cloudflare:test の想定どおりの配線)。
import { applyD1Migrations, env } from "cloudflare:test";

// テスト専用ダミー secret の値そのものは test/worker/test-secrets.ts に切り出してある
// (このファイルが `cloudflare:test` を import しており、Node 側の vitest.config.ts から
// 直接 import すると起動時に落ちるため。test-secrets.ts 冒頭コメント参照)。
// re-export しておくと「このファイルさえ見れば setupFile 全体の挙動が分かる」ため
// 参照しやすいが、値の単一ソースは test-secrets.ts 側。
export { TEST_DUMMY_SECRETS } from "./test-secrets";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
