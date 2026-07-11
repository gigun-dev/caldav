// Wrangler は secret 名を設定ファイルから生成できないため、生成済み CloudflareBindings に
// secret binding だけを declaration merging で追加する。DB/vars/runtime API は
// worker-configuration.d.ts が source of truth であり、ここへ手書きしない。
// 2026-07-12 注意: この import がファイルを「モジュール」にする(TS の仕様上、
// import/export を1つでも持つ .d.ts はグローバルスクリプトではなくモジュールスコープになる)。
// モジュールスコープのままだと下の `interface CloudflareBindings` が
// worker-configuration.d.ts のグローバル宣言とマージされず、DUMP_DAV_REQUESTS が
// worker-configuration.d.ts 側のリテラル型 "0" だけに narrow されて index.ts の
// `!== "1"` 比較が型エラーになる(実際に発生・make check で検出)。
// 対処: `declare global` で明示的にグローバルスコープへ戻す。
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
	interface CloudflareBindings {
		CALDAV_PASSWORD: string;
		PROXY_SHARED_SECRET: string;
		// iOS 実機検証用のキャプチャログを有効化するゲート(var)。"1" で有効。
		// 検証時のみ有効化する。通常は 0(または未設定)。旧名 CAPTURE_LOG(2026-07-11 改名)。
		// vars なので worker-configuration.d.ts が本来の source of truth だが、
		// wrangler types 再生成前でも tsc を通すためここに任意 var として足しておく。
		DUMP_DAV_REQUESTS?: string;
		// OAuthProvider(@cloudflare/workers-oauth-provider)が defaultHandler / apiHandler を
		// 呼び出す直前に env へ差し込むヘルパー(wrangler.jsonc の binding ではなくライブラリが
		// 実行時に注入するので、KV/D1 と違い wrangler types では生成されない → ここに手書き)。
		// 2026-07-12 OAuth-for-MCP 第1スライス: 型だけ先行追加。next-directions M2 の authorize UI で
		// c.env.OAUTH_PROVIDER として使う予定(このスライスではまだ OAuthProvider を new していない)。
		OAUTH_PROVIDER: OAuthHelpers;
	}
}
