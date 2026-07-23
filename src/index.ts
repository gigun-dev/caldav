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
import { app, mcpApiApp, resolveExternalTokenForMcp, scheduled } from "./app";
// R-6: OAuth scope 分離(read/write)。authorization server metadata の scopes_supported に
// 両 scope を広告する。語彙は presentation/mcp/scopes.ts に一元化(強制側と同じ定義を使い、
// 「広告した scope」と「強制する scope」がズレない — index.ts はコンポジションルートなので
// presentation からの import が許される)。
import { ALL_SCOPES } from "./presentation/mcp/scopes";

// =============================================================================
// OAuthProvider — Worker のエントリポイント(fetch 側)
// =============================================================================
// 【なぜ index.ts だけがこの import を持つのか】
// .dependency-cruiser.cjs のコメントどおり index.ts はコンポジションルート(全層を配線する
// ので層境界の例外)。OAuthProvider は infrastructure 相当の外部技術だが、Worker の
// エントリポイントそのものを差し替える性質上(fetch ルーティングの最上位)、
// infrastructure に隠さずここに直接置く(OAuthPropsAuth のような「ポートの実装」とは
// 性質が違う — provider 自体はポート化しない)。
// 【なぜ const にして default export を分けたか(2026-07-23 #47 R2 cron 配線)】
// 以前は `export default new OAuthProvider(...)` を直接 default export していたが、
// OAuthProvider の型(dist/oauth-provider.d.ts)は fetch/purgeExpiredData しか持たず
// scheduled を実装しない。Cron Trigger は Worker の default export に scheduled ハンドラを
// 要求する(wrangler.jsonc の triggers.crons を足すと、scheduled 未実装の default export では
// 実行時にディスパッチできない)。そこで provider インスタンスは const で保持し、
// default export は「fetch は provider に委譲・scheduled は app.ts の purge cron」を持つ
// 素の ExportedHandler オブジェクトへ組み替える(下部の `export default { ... }` 参照)。
const oauthProvider = new OAuthProvider<CloudflareBindings>({
	// /mcp 宛のリクエストだけを「有効なアクセストークンが必要な API」として扱う。
	// それ以外(DAV/health/.well-known)は defaultHandler にそのまま素通しする。
	apiRoute: "/mcp",
	apiHandler: { fetch: (request, env, ctx) => mcpApiApp.fetch(request, env, ctx) },
	// DAV/iOS/health は全部素通し(provider が認証を強制するのは apiRoute だけ)。
	// DAV 側の認証(authenticateBasic)は app(src/app.ts)内部で従来どおり自前でかける。
	defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },

	// --- authorize エンドポイント ---
	// ここでは OAuth discovery metadata(/.well-known/oauth-authorization-server 等)に
	// この URL を広告するだけ。authorizeEndpoint は「metadata に載せる URL」であって
	// 「provider がこのパスを実装する」という意味ではない — 実体は defaultHandler(= 上の app)
	// に一任される。2026-07-12 第3スライスで src/app.ts に GET/POST /authorize(単一ユーザーの
	// password 同意フォーム。parseAuthRequest → completeAuthorization)を実装済み。
	// app.all("*") の Basic 認証 catch-all より前に登録してあるので、未トークンのクライアントが
	// Basic 401 に飲まれず同意フォームに到達できる(詳細は src/app.ts の /authorize コメント)。
	authorizeEndpoint: "/authorize",
	// トークン発行・更新・失効は provider がフルで実装する(RFC 6749 §3.2 相当)。
	tokenEndpoint: "/oauth/token",
	// Dynamic Client Registration(RFC 7591)も provider 実装に任せる。CIMD 主流化の流れは
	// 承知の上で、まずは DCR を素直に有効化する(MCP クライアント側の実装がまだ DCR 前提の
	// ものが多いため。docs 記載の「DCR は MAY 降格・CIMD 主流」は中長期方針であり、
	// 今すぐ DCR を無効化する理由にはならない)。
	clientRegistrationEndpoint: "/oauth/register",
	// R-6(2026-07-15): read/write scope を分離して両方広告する。以前は read のみを広告したまま
	// write 系ツール(create/update/delete/complete/move 等)が実行できてしまっていた(公開前必須の
	// 是正 + 第三者クライアント受け入れの前提整備)。read 名(claudedav:read)は既発行 grant との
	// 整合のため変えない。強制(write ツールに claudedav:write を要求)は presentation/mcp が行い、
	// ここは discovery metadata への広告に徹する(ALL_SCOPES = [claudedav:read, claudedav:write])。
	scopesSupported: [...ALL_SCOPES],
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

// =============================================================================
// 401 / トークン発行の自己診断ログ(2026-07-23 iOS claude.ai カード 401 切り分け)
// =============================================================================
// 【背景】docs/log.md の「iOS描画切り分けの結論」で判明した構図は「provider の
// accessTokenTTL 既定 1時間で失効後、claude.ai web のカード描画パスはリフレッシュして
// 継続するが、iOS アプリのカード描画パスはリフレッシュせず 401 のまま『サーバーに
// 接続できません』になる」。ただしこれは診断カード(diag-card)1件の再現で得た仮説であり、
// 「本当に 1時間 TTL どおりに切れているのか」「もっと短い周期(iOS 側の何らかの事情)で
// 切れているのか」「そもそも古いコネクタの失効済みトークンを掴んだまま再試行していて
// 発行記録自体が無いのか」を区別する一次データが無い。この節はそれを埋めるための
// 自己診断ログ(Workers Logs に出すだけ・機能に影響しない)。
//
// 【なぜ SHA-256 の指紋だけをログに出すか】トークン値そのもの・Authorization ヘッダ生値を
// ログに残すと、Workers Logs(7日保持だが閲覧可能な人間がアクセス制御外に増える)経由で
// 実質的に有効なアクセストークンが漏洩する。指紋(先頭16 hex)は「同一トークンかどうかの
// 突き合わせ」には十分で、元のトークン値を復元できない(ハッシュの原像計算困難性)。
//
// 【判定手順(このログの読み方)】
//  1. Workers Logs から diag:"tokenIssued" を全件集め、tokenFp → { ts, expiresIn } の表を作る。
//  2. diag:"auth401" の tokenFp をその表と突き合わせる。
//     - 表に無い(発行記録が無い) → そのトークンは今回のログ観測期間より前に発行された
//       ものか、無効なトークンを最初から掴んでいる(コネクタの古いトークン再利用説の証拠)。
//     - 表にあり、401.ts >= issued.ts + expiresIn*1000 → 申告どおりの TTL 失効
//       (1時間 TTL 失効説を裏付け)。
//     - 表にあり、401.ts < issued.ts + expiresIn*1000 → TTL 内での 401 = provider 側の
//       別要因(KV 未反映・失効操作・invalid_token 以外の理由)。expiresIn 未満での早期失効を
//       示すので「もっと短い周期説」の裏付けになる。
//  3. 期間中に diag:"tokenIssued" が1件も無いのに diag:"auth401" が出ている場合、iOS が
//     このデプロイ以降トークンを一度も新規発行していない = 古いセッション/コネクタが
//     ずっと同じ(既に失効済みの)トークンを使い回している可能性が高い。
//
// 【Workers Logs の保持期間について】既定 7日保持で、TTL 1時間 vs もっと短い周期かを
// 見分けるには十分な解像度(1時間单位の事象を7日分追える)。
// =============================================================================

/** Bearer トークン文字列から SHA-256 先頭16 hex の指紋を作る(生値はログに出さない)。 */
async function fingerprintToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const hex = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, 16);
}

/** Authorization: Bearer <token> ヘッダから指紋を作る。ヘッダ無し/形式不正は "none"。 */
async function fingerprintAuthHeader(request: Request): Promise<string> {
	const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
	if (!header) return "none";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match) return "none";
	return await fingerprintToken(match[1]);
}

/**
 * provider.fetch を診断ログでラップする。診断ログの実装ミスが本経路を絶対に壊さないよう
 * 関数全体を try/catch で包み、失敗時は診断をスキップして素のレスポンスをそのまま返す
 * (診断ログは「あれば嬉しい」であって「無いと困る」ではない — 本番の可用性を優先)。
 */
async function fetchWithAuthDiagnostics(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
	// 【なぜ provider.fetch を呼ぶ「前」に request.clone() するか(実装時に踏んだ罠)】
	// Request.clone() は body ストリームが未消費でないと呼べない(呼ぶと
	// "Body has already been used" で例外)。oauthProvider.fetch(request, ...) は
	// /oauth/token のような POST リクエストの body を内部で読んでしまうため、
	// provider.fetch を呼んだ**後**に request.clone() しようとすると必ず例外になり、
	// この関数全体を包む try/catch に静かに飲まれて診断ログが1件も出ない
	// (この壊れ方は「ログが出ない」以外の症状が無く気づきにくい — worker テストの
	// (c) で実際に踏んで気づいた)。よって「後で clone するかもしれない」判断が
	// できる時点(= provider.fetch を呼ぶ前)でリクエストの複製を確保しておく。
	const requestForDiagnostics = request.clone();
	const response = await oauthProvider.fetch(request, env, ctx);

	try {
		const url = new URL(request.url);

		// --- ①401 応答の観測(/mcp の invalid_token 401 が主対象だが、パス限定はせず
		//     provider が 401 を返した全リクエストを拾う。診断対象を広めに取ることで
		//     「/mcp 以外の経路でも 401 切れが起きているか」まで併せて確認できる) ---
		if (response.status === 401) {
			const tokenFp = await fingerprintAuthHeader(request);
			const userAgent = request.headers.get("user-agent") ?? "";
			console.log(
				JSON.stringify({
					diag: "auth401",
					path: url.pathname,
					method: request.method,
					ua: userAgent.slice(0, 80),
					tokenFp,
					ts: Date.now(),
				}),
			);
		}

		// --- ②トークン発行の観測(POST /oauth/token が 200 を返したとき) ---
		if (url.pathname === "/oauth/token" && request.method === "POST" && response.status === 200) {
			// grant_type は request body(form-urlencoded)から読む。関数冒頭で確保した
			// requestForDiagnostics(provider.fetch に渡す前に clone 済み)を使う理由は
			// requestForDiagnostics 定義のコメント参照(ここで request.clone() すると
			// 既に body 消費済みで例外になる)。
			const grantType = new URLSearchParams(await requestForDiagnostics.text()).get("grant_type") ?? undefined;

			// レスポンス body は clone() してから読む。clone しないと呼び出し元(実際に
			// この Response を使う側)がボディを読めなくなり、診断ログの追加が本経路を
			// 壊してしまう(この関数の最優先事項 = 素通しを壊さないこと)。
			const body = (await response.clone().json()) as {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
			};
			const tokenFp = body.access_token ? await fingerprintToken(body.access_token) : "none";
			const refreshFp = body.refresh_token ? await fingerprintToken(body.refresh_token) : undefined;
			console.log(
				JSON.stringify({
					diag: "tokenIssued",
					tokenFp,
					refreshFp,
					grantType,
					expiresIn: body.expires_in,
					ts: Date.now(),
				}),
			);
		}
	} catch {
		// 診断ログ自体の失敗(JSON パース失敗・想定外のボディ形状等)は握りつぶす。
		// 本経路の応答(response)には一切触れていないので、ここに来ても呼び出し元への
		// 影響はゼロ。
	}

	return response;
}

// =============================================================================
// Worker のエントリポイント(default export)— fetch は provider に委譲・scheduled は R2 ゴミ箱 purge
// =============================================================================
// 【R2 ソフトデリート purge cron(2026-07-23 #47)】wrangler.jsonc の triggers.crons(日次1回)から
// 呼ばれる。実体(30日 TTL・repositoriesFactory 経由の D1 アクセス)は app.ts の scheduled 関数に
// 置く(provider 非依存を保つ app.ts の絶対ルールと矛盾しない — scheduled 関数のコメント参照)。
// ここではそれをそのまま default export の scheduled フィールドへ配線するだけ。
// fetch は診断ログ付きの fetchWithAuthDiagnostics 経由にする(2026-07-23 iOS 401 切り分け用。
// 上のコメントブロック参照)。診断ログは判定材料が揃い次第(1時間 TTL 失効どおりか確定次第)
// 撤去する想定 — 恒久機能ではない。
export default {
	fetch: (request: Request, env: CloudflareBindings, ctx: ExecutionContext) => fetchWithAuthDiagnostics(request, env, ctx),
	scheduled,
};
