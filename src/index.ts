// =============================================================================
// CalDAV Worker entrypoint(薄い OAuth エントリ)
// =============================================================================
// 2026-07-12 OAuth-for-MCP 第2スライス・物理分離リファクタ: このファイルは
// OAuthProvider を組み立てて default export するだけの薄いコンポジションルートに
// した。DAV 用 Hono アプリ・helper 関数・mcpApiApp・resolveExternalToken の実体は
// すべて src/app.ts に切り出した(理由は src/app.ts 冒頭コメント参照)。
//
// 【なぜ静的 import に戻せたか(= lazy import 撤廃)】
// 以前はこのファイルに honoApp と OAuthProvider が同居しており、
// `import OAuthProvider from "@cloudflare/workers-oauth-provider"` を静的に書くと、
// provider の実体(dist/oauth-provider.js)が先頭で
// `import { WorkerEntrypoint } from "cloudflare:workers"` している影響で、
// honoApp だけを使いたいテスト(app.test.ts 等)まで巻き込んで bun test が
// `Cannot find package 'cloudflare:workers'` で落ちていた。その回避策として
// `await import(...)` による遅延構築(getOAuthProvider() / cachedProvider)という
// bespoke な構成を取っていた。
// 今回、honoApp 側を src/app.ts に物理分離し、bun test は provider を一切 import
// しない src/app.ts だけを叩く構成に変えた。結果としてこのファイル(src/index.ts)は
// 単体で見れば「provider を静的 import してそのまま default export するだけ」の
// 薄いファイルになり、bun test がこのファイルを import すること自体が無くなった
// (テストは src/app.ts を直接叩く)。よって lazy import・getOAuthProvider・
// cachedProvider は不要になり、@cloudflare/workers-oauth-provider が想定する
// canonical な形 `export default new OAuthProvider(...)` に戻せる。
// =============================================================================

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { app, mcpApiApp, resolveExternalTokenForMcp } from "./app";

// =============================================================================
// OAuthProvider — Worker のエントリポイント(default export)
// =============================================================================
// 【なぜ index.ts だけがこの import を持つのか】
// .dependency-cruiser.cjs のコメントどおり index.ts はコンポジションルート(全層を配線する
// ので層境界の例外)。OAuthProvider は infrastructure 相当の外部技術だが、Worker の
// エントリポイントそのものを差し替える性質上(fetch ルーティングの最上位)、
// infrastructure に隠さずここに直接置く(OAuthPropsAuth のような「ポートの実装」とは
// 性質が違う — provider 自体はポート化しない)。
export default new OAuthProvider<CloudflareBindings>({
	// /mcp 宛のリクエストだけを「有効なアクセストークンが必要な API」として扱う。
	// それ以外(DAV/health/.well-known)は defaultHandler にそのまま素通しする。
	apiRoute: "/mcp",
	apiHandler: { fetch: (request, env, ctx) => mcpApiApp.fetch(request, env, ctx) },
	// DAV/iOS/health は全部素通し(provider が認証を強制するのは apiRoute だけ)。
	// DAV 側の認証(authenticateBasic)は app(src/app.ts)内部で従来どおり自前でかける。
	defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },

	// --- authorize エンドポイント(実装は第3スライス) ---
	// ここでは OAuth discovery metadata(/.well-known/oauth-authorization-server 等)に
	// 広告するだけ。GET /authorize は provider がハンドルせず(authorizeEndpoint は
	// 「metadata に載せる URL」であって「provider がこのパスを実装する」という意味ではない
	// — authorizeEndpoint の実体は defaultHandler = 上の app(src/app.ts の app.all("*", ...))
	// 任せになる。現状 app 側にも /authorize のハンドラは無いので、そのまま app.all("*") の
	// authenticateBasic ガードに落ちて 401 Basic チャレンジになる。UI 実装(第3スライス)まで
	// この挙動のままでよい(意図的な未実装。TODO ではなく「今回のスコープ外」の記録)。
	authorizeEndpoint: "/authorize",
	// トークン発行・更新・失効は provider がフルで実装する(RFC 6749 §3.2 相当)。
	tokenEndpoint: "/oauth/token",
	// Dynamic Client Registration(RFC 7591)も provider 実装に任せる。CIMD 主流化の流れは
	// 承知の上で、まずは DCR を素直に有効化する(MCP クライアント側の実装がまだ DCR 前提の
	// ものが多いため。docs 記載の「DCR は MAY 降格・CIMD 主流」は中長期方針であり、
	// 今すぐ DCR を無効化する理由にはならない)。
	clientRegistrationEndpoint: "/oauth/register",
	// 現状の MCP ツール(get-current-time / list-events-expanded / get-freebusy)は
	// すべて読み取り専用。将来 PUT 相当の書き込みツールを足すときに write スコープを追加する
	// 前提で、今は read スコープのみを広告する(最小権限の原則)。
	scopesSupported: ["claudedav:read"],
	// implicit フローは OAuth 2.1 で非推奨(トークンが URL fragment に露出し漏洩しやすい)。
	// MCP クライアントは authorization code + PKCE を使うのが前提なので明示的に無効化する。
	allowImplicitFlow: false,
	// PKCE の plain 方式(code_verifier をそのまま code_challenge に使う)は暗号的な保護が
	// 無く OAuth 2.1 が S256 のみを推奨している。plain を無効化して S256 のみ受理する。
	allowPlainPKCE: false,

	// --- MCP_TOKEN(静的トークン)との共存口 ---
	// 実体は src/app.ts の resolveExternalTokenForMcp(純関数として named export)。
	// provider の値 import を持たない src/app.ts 側にロジックを置くことで、provider を
	// 経由せずに bun test でユニットテストできる(mcp-api-wiring.test.ts 参照)。
	// ここではその関数をそのまま options に渡すだけの配線に徹する。
	resolveExternalToken: resolveExternalTokenForMcp,
});
