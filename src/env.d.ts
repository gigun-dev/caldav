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
		// S1(docs/modeling/14 確認カード): 破壊的操作(delete 系)の確認トークンを HMAC 署名する
		// Workers secret。CALDAV_PASSWORD 等と同じ「秘密は wrangler.jsonc の vars に載せず secret 化」
		// の既存慣行に従う(本番は `wrangler secret put CONFIRM_SECRET`・dev/テストは .dev.vars)。
		// 型は「必須の string」にするが、未設定(空文字)は server.ts 側でランタイムに検出して
		// propose-* をエラーにする(空鍵で誰でも通る事故を防ぐ — MCP_TOKEN と同じガード思想)。
		CONFIRM_SECRET: string;
		// #45 場所モデル: Google Maps Places API キー(secret)。wrangler.jsonc の secrets.required に
		// 載せる(CONFIRM_SECRET と同じ扱い)が、未設定(空文字)でも Worker 起動・他ツールは正常で、
		// search-location ツールを呼んだときだけ GeocodingNotConfiguredError に縮退する
		// (infrastructure/geocoding/google-places-geocoding.ts の縮退方針)。本番は
		// `wrangler secret put GOOGLE_MAPS_API_KEY`・dev/テストは .dev.vars / .secrets.local.json。
		GOOGLE_MAPS_API_KEY: string;
		// #45 追加要件: geocoding の月次上限(env で設定可能)。未設定時は app.ts が既定 1000 を使う
		// (Text Search Pro の無料枠 月5,000 の 20% 保守マージン — 根拠は app.ts の wiring コメント)。
		// var(秘密ではない)扱い。wrangler types 再生成前でも tsc を通すため任意 var として手書きする
		// (DUMP_DAV_REQUESTS と同じ扱い。値は文字列で来るので app.ts で Number 化する)。
		GEOCODING_MONTHLY_LIMIT?: string;
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
