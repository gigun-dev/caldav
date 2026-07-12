// =============================================================================
// test/worker/test-secrets.ts — テスト専用ダミー secret の単一ソース。
// =============================================================================
// vitest.config.ts(Node 側、config 構築時に実行される)と
// test/worker/apply-migrations.ts(Worker 側、setupFile として実行される)の
// 両方からこの定数を参照したい。しかし apply-migrations.ts は
// `import { applyD1Migrations, env } from "cloudflare:test"` を持ち、
// `cloudflare:test` は workerd 専用の仮想モジュールで Node(vitest.config.ts を
// 読む側)からは解決できない。config 側が誤って apply-migrations.ts を import すると
// Node の ESM ローダーが `cloudflare:test` のスキームを解決できず起動時に落ちる
// (実際に踏んだ: `ERR_UNSUPPORTED_ESM_URL_SCHEME`)。
// そのため cloudflare:* に一切依存しないこのファイルを値の単一ソースとして切り出し、
// vitest.config.ts と apply-migrations.ts の双方から import する。
export const TEST_DUMMY_SECRETS = {
	CALDAV_PASSWORD: "test-password",
	MCP_TOKEN: "test-mcp-token",
} as const;
