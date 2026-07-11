// =============================================================================
// CalDAV アプリ本体(マウント可能な Hono アプリ + provider 非依存の配線一式)
// =============================================================================
// 2026-07-12 OAuth-for-MCP 第2スライス・物理分離リファクタ: このファイルは元々
// src/index.ts に同居していた「honoApp とその周辺(helper 関数・DAV ルーティング・
// mcpApiApp・resolveExternalToken)」を丸ごと切り出したもの。
//
// 【なぜ切り出したか】研究の結果、@cloudflare/workers-oauth-provider の canonical な
// 使い方は `export default new OAuthProvider(...)` を Worker のエントリポイントとして
// 直接エクスポートする形だと分かった(fetch でラップして lazy import する構成は先例のない
// bespoke 解)。ところが provider の実体(dist/oauth-provider.js)は先頭で
// `import { WorkerEntrypoint } from "cloudflare:workers"` している。"cloudflare:workers" は
// workerd(本番 Workers ランタイム)専用の仮想モジュールで bun test には存在しない。
// 以前は src/index.ts に honoApp と OAuthProvider が同居していたため、honoApp だけを
// import したいテスト(app.test.ts / tsdav-harness.test.ts)まで provider の静的 import に
// 巻き込まれて `Cannot find package 'cloudflare:workers'` で落ちていた — その回避策として
// provider の構築を `await import(...)` で遅延させる bespoke な構成にしていた。
//
// 今回、honoApp 側(= このファイル)と provider 側(= src/index.ts)をファイルとして
// 物理分離し、bun test が provider を一切 import しない src/app.ts だけを叩くようにした。
// これにより src/index.ts 側は lazy import を撤廃して canonical な静的 import +
// `export default new OAuthProvider(...)` に戻せる(index.ts 側のコメント参照)。
//
// 【このファイルの絶対ルール】@cloudflare/workers-oauth-provider の**値**を import しない。
// import type すら基本的に不要(options は index.ts 側で組む)。これを破ると
// cloudflare:workers が再びこのファイル経由で bun test に巻き込まれ、今回の分離が
// 無意味になる。`grep -rn "cloudflare:workers\|workers-oauth-provider" src/app.ts` が
// 常に空であることをこのファイルの健全性の指標とする。
//
// 長期ビジョン(CLAUDE.md)との整合: 「マウント可能な Hono アプリ(= このファイル)/
// それを OAuth で包む薄い Worker エントリ(= src/index.ts)」という分離は、OSS
// 「CalDAV サーバーキット」としてコアをマウント可能な Hono アプリとして切り出す方針
// そのものであり、今回のリファクタは技術的負債の解消であると同時にビジョンへの前進でもある。
// =============================================================================

import { Hono } from "hono";
import {
	CalDAVPreconditionError,
	CalendarQuery,
	CollectionAlreadyExistsError,
	CollectionNotFoundError,
	ComputeFreeBusy,
	CreateCollection,
	DeleteCalendarObject,
	DeleteETagMismatchError,
	DeleteTargetNotFoundError,
	ETagConditionError,
	GetCalendarObject,
	InvalidSyncTokenError,
	ListCollections,
	MultigetObjects,
	ProvisionDefaultCollections,
	PutCalendarObject,
	ResourceNotFoundError,
	SyncCollection,
	UpdateCollectionProperties,
} from "./application";
import { Principal, collectionId, principalPath } from "./domain/caldav";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
	PrincipalRepository,
} from "./application/ports";
import { createD1Repositories, IcaljsRRuleIterator, OAuthPropsAuth, type OAuthPrincipalProps } from "./infrastructure";
import { authenticateBasic, secureStringEqual, UNAUTHORIZED_HEADERS } from "./presentation/auth/basic-auth";
import { createMcpApp } from "./presentation/mcp/server";
import {
	collectionProps,
	davError,
	entryProps,
	homeProps,
	multistatus,
	objectProps,
	parseCalendarQueryFilter,
	parseCollectionProperties,
	parseFreeBusyQuery,
	parseHrefs,
	parsePropFilter,
	parseSyncToken,
	principalProps,
	responseXml,
	serializeFreeBusyResponse,
	statusResponseXml,
} from "./presentation/dav/xml";

// G-3: RRULE 反復 port の実装。PutCalendarObject(occurrence bounds 計算)と
// CalendarQuery(REPORT 時の展開)の両方から共有する。ical.js アダプタは内部状態を
// 持たない(iterate() のたびに新しい ICAL.RecurIterator を作る)ので、Workers の
// リクエスト間で使い回しても安全 — DB 接続のようなリクエストスコープの資源ではない。
const recurrenceIterator = new IcaljsRRuleIterator();

const DAV_HEADERS = {
	DAV: "1, 3, calendar-access, sync-collection, extended-mkcol",
	Allow: "OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE, PROPPATCH, MKCOL",
} as const;
const XML_HEADERS = { ...DAV_HEADERS, "Content-Type": "application/xml; charset=utf-8" };
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function principalHref(username: string): string {
	return `/dav/principals/${encodeURIComponent(username)}/`;
}

function homeHref(username: string): string {
	return `/dav/calendars/${encodeURIComponent(username)}/`;
}

function normalizeCollectionHref(username: string, id: string): string {
	return `${homeHref(username)}${encodeURIComponent(id)}/`;
}

// 2026-07-10 レビュー P1-4: 207 の <d:href> はすべて「リクエスト URI(実際に受けたパス)」基点で
// 生成する。docs/modeling/06 の教訓③「response href はリクエスト URI と一致(iOS が実際に強制)」。
// 以前は entry が requestPath(url) 基点、principal/home が内部 path(= url.pathname)基点で、
// 値としては両者一致していたが「どこを基点にすべきか」の意図がバラバラだった。この helper に集約し
// 意図を一本化する。プロキシ経由(x-forwarded-host)でも URL.pathname はホスト名にしか関与しない
// リバースプロキシでは不変なので、href はリクエストで受けた pathname のままで iOS と一致する
// (origin を差し替えたいのは sync-token URI だけで、そこは publicOrigin を別途使う)。
function requestHref(url: URL): string {
	return url.pathname || "/";
}

function externalOrigin(request: Request, internalUrl: URL): string {
	const forwardedHost = request.headers.get("x-forwarded-host");
	const forwardedProto = request.headers.get("x-forwarded-proto");
	if (!forwardedHost) return internalUrl.origin;
	return `${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`;
}

async function readBody(request: Request): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw new RangeError("request body too large");
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new RangeError("request body too large");
	return body;
}

function rawEtagCondition(request: Request) {
	const ifNoneMatch = request.headers.get("if-none-match");
	if (ifNoneMatch === "*") return { kind: "must-not-exist" as const };
	const ifMatch = request.headers.get("if-match");
	if (ifMatch) return { kind: "must-match" as const, etag: ifMatch };
	return { kind: "unconditional" as const };
}

function xml(body: string, status = 207): Response {
	return new Response(body, { status, headers: XML_HEADERS });
}

function errorResponse(error: unknown): Response {
	if (error instanceof RangeError) return new Response(error.message, { status: 413 });
	if (error instanceof ResourceNotFoundError || error instanceof DeleteTargetNotFoundError) return new Response("Not Found", { status: 404 });
	if (error instanceof CollectionNotFoundError) return new Response("Collection not found", { status: 409 });
	if (error instanceof CollectionAlreadyExistsError) return new Response("Collection already exists", { status: 405, headers: DAV_HEADERS });
	if (error instanceof ETagConditionError || error instanceof DeleteETagMismatchError) return new Response("Precondition Failed", { status: 412 });
	if (error instanceof InvalidSyncTokenError) return xml(davError("valid-sync-token"), 403);
	if (error instanceof CalDAVPreconditionError) {
		const violation = error.violations[0];
		const status = violation?.precondition === "no-uid-conflict" ? 409 : 403;
		return xml(davError(violation?.precondition ?? "valid-calendar-data", violation?.detail), status);
	}
	console.error(JSON.stringify({ event: "unhandled_error", message: error instanceof Error ? error.message : String(error) }));
	return new Response("Internal Server Error", { status: 500 });
}

// リポジトリ群のポート型(presentation はポートにだけ依存し、D1 の具象クラスは知らない)。
export interface Repositories {
	principals: PrincipalRepository;
	collections: CalendarCollectionRepository;
	resources: CalendarObjectResourceRepository;
	uow: CollectionUnitOfWork;
}

// リポジトリ生成を差し替え可能にする hook。既定は D1 実装。
// テスト(bun test 環境には workerd/D1 が無い)ではインメモリ Fake を注入して
// app.fetch を丸ごと exercise できるようにするための注入点。本番では触らない。
let repositoriesFactory: (env: CloudflareBindings) => Repositories =
	(env) => createD1Repositories(env.DB);

/** テスト専用: リポジトリファクトリを差し替える。返り値で元に戻せる。 */
export function __setRepositoriesFactoryForTest(
	factory: (env: CloudflareBindings) => Repositories,
): () => void {
	const previous = repositoriesFactory;
	repositoriesFactory = factory;
	return () => {
		repositoriesFactory = previous;
	};
}

// DAV 用 Hono アプリ本体。src/index.ts はこれを OAuthProvider の defaultHandler として
// 配線する(honoApp という別名は以前 index.ts の named export だった名残 — 呼び出し側
// 〈テスト含む〉との互換のため下でも同名を維持している)。
export const app = new Hono<{ Bindings: CloudflareBindings }>();

// =============================================================================
// iOS 実機検証用キャプチャログミドルウェア
// -----------------------------------------------------------------------------
// 目的: `wrangler tail` で iOS クライアントの全リクエスト(特に PUT の生 ICS と
//       PROPFIND/REPORT の XML ボディ)を観測する。docs/modeling/06 の検証項目
//       A1〜A9 / B3〜B9 のデータ源。大学 Wi-Fi では MITM プロキシ(Proxyman)が
//       使えないため、サーバー側 tail 方式に決定(2026-07-10)。
//
// 一時的な検証用途。iOS 検証が完了したら DUMP_DAV_REQUESTS=0(または var 削除)で
// 無効化する。コードは削除しない — 将来の再検証で同じ観測系を使い回すため。
//
// ゲート: 環境変数 DUMP_DAV_REQUESTS(var)が "1" のときだけ有効。既定は無効。
// 命名は Xandikos(--dump-dav-xml / DUMP_DAV_XML)に倣う。この種の「サーバー側で生
// リクエストをダンプする env ゲート」は Radicale(request_content_on_debug)等でも定番
// (2026-07-11 調査。旧名 CAPTURE_LOG から改名)。
//
// 【セキュリティ最重要】Authorization ヘッダおよびあらゆる資格情報は
// 絶対にログへ出さない。下の allowlist に authorization は入れていない。
// Basic 認証の生パスワードが tail 経由で漏れることを構造的に防ぐ。
//
// ボディ読み取り: c.req.raw.clone() で複製してから text() する。Workers の
// Request も一度 body stream を消費すると二度読めないため、後段のハンドラ
// (readBody = request.text())を壊さないようクローン側だけを消費する。
// =============================================================================

// ログに出してよいヘッダの allowlist。authorization / cookie / proxy secret は
// 意図的に含めない(資格情報漏洩防止)。iOS 挙動の解析に必要なものだけ。
const CAPTURE_HEADERS = [
	"user-agent",
	"depth",
	"content-type",
	"if-match",
	"if-none-match",
	"brief",
	"prefer",
	"x-caldav-method",
] as const;

// ボディを取得するメソッド。GET/HEAD/OPTIONS/DELETE は基本ボディ無しなので除外し、
// 折り畳み ICS や XML を持つ書き込み/問い合わせ系だけをキャプチャする。
const CAPTURE_BODY_METHODS = new Set(["PROPFIND", "REPORT", "PUT", "PROPPATCH", "MKCOL", "POST"]);

app.use("*", async (c, next) => {
	// ゲート off ならフックを一切通さず素通し(本番のホットパスに負荷を乗せない)。
	if (c.env.DUMP_DAV_REQUESTS !== "1") return next();

	const request = c.req.raw;
	const url = new URL(request.url);
	const method = request.method.toUpperCase();

	// --- リクエスト ---
	const reqHeaders: Record<string, string> = {};
	for (const name of CAPTURE_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) reqHeaders[name] = value;
	}
	let reqBody: string | undefined;
	if (CAPTURE_BODY_METHODS.has(method)) {
		try {
			// clone() 必須: 元 Request の body stream を消費すると後段 readBody が壊れる。
			reqBody = await request.clone().text();
		} catch {
			reqBody = "<capture: body read failed>";
		}
	}
	// JSON.stringify で 1 行化。tail は複数行ログを扱いにくく、ICS の CRLF 折り畳みや
	// XML の改行をそのまま出すと行がバラける。stringify ならエスケープを崩さず 1 行に載る。
	console.log(`[DUMP][req] ${JSON.stringify({ method, path: url.pathname, headers: reqHeaders, body: reqBody })}`);

	await next();

	// --- レスポンス ---
	// 検証で「何を返したか」を照合するため、ステータスと ETag、207 系はボディも出す。
	const res = c.res;
	const resHeaders: Record<string, string> = {};
	const etag = res.headers.get("etag");
	if (etag !== null) resHeaders.etag = etag;
	const resContentType = res.headers.get("content-type");
	if (resContentType !== null) resHeaders["content-type"] = resContentType;
	let resBody: string | undefined;
	if (res.status === 207) {
		try {
			// レスポンスも clone() してから読む。元の Response body を消費すると
			// クライアントへ空ボディが返ってしまう。
			resBody = await res.clone().text();
		} catch {
			resBody = "<capture: body read failed>";
		}
	}
	console.log(`[DUMP][res] ${JSON.stringify({ method, path: url.pathname, status: res.status, headers: resHeaders, body: resBody })}`);
});

app.get("/health", (c) => c.json({ ok: true, service: "caldav" }));

// iOS はこの場所を最初に PROPFIND する。認証前でも正規DAV入口へ誘導できるようリダイレクト自体は公開する。
app.all("/.well-known/caldav", (c) => c.redirect("/dav/", 301));

// =============================================================================
// OAuth-for-MCP 第3スライス: GET/POST /authorize(同意 UI)
// =============================================================================
// 2026-07-12 追加。src/index.ts の OAuthProvider は `authorizeEndpoint: "/authorize"` を
// discovery metadata(/.well-known/oauth-authorization-server 等)に広告するだけで、
// このパス自体の実装は defaultHandler(= この app)に一任される(index.ts のコメント参照)。
// なので同意フォームの表示・パスワード検証・grant 確定はすべてここに書く。
//
// 【なぜ app.all("*") より前に置くか】app.all("*") は末尾で必ず authenticateBasic の
// Basic 認証ガードに落ちる(DAV 用)。/authorize は「MCP クライアントがまだトークンを
// 持っていない状態」で叩かれる入口であり、Basic 認証を要求してはいけない
// (iOS の CalDAV Basic 認証とは別の認証コンテキスト — パスワードの照合はこの中で
// 自前に secureStringEqual を使って行う)。Hono はマッチした最初のルートで確定するため、
// この2ハンドラを catch-all より前に登録しておかないと Basic 401 に飲まれてしまう。
//
// 【単一ユーザー前提】username 入力は無い(env.CALDAV_USERNAME 固定の単一ユーザー運用。
// CLAUDE.md の「現状は単一ユーザー Basic」を踏襲)。password 入力1個だけの最小フォーム。
// =============================================================================

/**
 * HTML への埋め込み用エスケープ。クライアント名(lookupClient の clientName)は
 * OAuth クライアント登録者が任意の文字列を送れる外部由来データなので、フォーム HTML に
 * 埋める前に必ず通す(XSS 対策。`<script>` 等を仕込まれても文字列として表示されるだけにする)。
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * 同意フォームの HTML を組み立てる。GET(初回表示)と POST 失敗時(パスワード誤り再表示)の
 * 両方から呼ぶ共通 helper。テンプレートエンジンは使わない(単一フォーム・凝った UI 不要な
 * ミニマル運用なので、依存を増やすコストに見合わない)。
 */
function authorizeFormHtml(input: { query: string; clientName: string; error?: string }): string {
	const safeClientName = escapeHtml(input.clientName);
	// action の query 文字列には元の OAuth 認可リクエストパラメータ(client_id/redirect_uri/
	// state/code_challenge 等)をそのまま持ち回す。hidden input で個別に持つより、
	// 「provider が生成したクエリ文字列をそのまま POST でも parseAuthRequest にかけられる」
	// 形が最小で改竄面も小さい(POST 側は body ではなく URL のクエリを見て再構築する)。
	// query 自体は URL からそのまま取っているので追加エスケープは不要(URL エンコード済み文字列)。
	const errorHtml = input.error
		? `<p style="color:#b00020;font-weight:bold;">${escapeHtml(input.error)}</p>`
		: "";
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>caldav MCP 認可</title>
<style>
	body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
	p { line-height: 1.6; }
	input[type="password"] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; margin: 0.5rem 0 1rem; }
	button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<h1>caldav MCP への接続を許可しますか?</h1>
<p>クライアント「<strong>${safeClientName}</strong>」が caldav MCP への接続を要求しています。</p>
${errorHtml}
<form method="POST" action="/authorize?${input.query}">
	<label for="password">パスワード</label>
	<input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
	<button type="submit">許可する</button>
</form>
</body>
</html>`;
}

app.get("/authorize", async (c) => {
	// parseAuthRequest はクエリパラメータ不正(client_id 欠落等)なら例外を投げる想定
	// (.d.ts のコメントに明記の失敗時挙動は無いため、防御的に try/catch で 400 に落とす)。
	let oauthReqInfo: Awaited<ReturnType<typeof c.env.OAUTH_PROVIDER.parseAuthRequest>>;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		return c.text("Bad Request: invalid OAuth authorization request", 400);
	}
	// クライアント名はベストエフォート。lookupClient が失敗/null でも認可フロー自体は
	// 続行できるようにする(「不明なクライアント」表示のまま進める — 致命的にしない)。
	let clientName = "unknown client";
	try {
		const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
		if (client?.clientName) clientName = client.clientName;
	} catch {
		// lookupClient 失敗はログに残す価値はあるが、UI をブロックしてはいけない。
	}
	const query = new URL(c.req.url).search.replace(/^\?/, "");
	return c.html(authorizeFormHtml({ query, clientName }));
});

app.post("/authorize", async (c) => {
	// POST でも同じクエリ文字列から parseAuthRequest をもう一度実行する(GET 時と同じ
	// oauthReqInfo を再構築 — フォームの hidden ではなく URL クエリで運んでいるので、
	// この POST ハンドラ自身がリクエスト URL のクエリを読む形で足りる)。
	let oauthReqInfo: Awaited<ReturnType<typeof c.env.OAUTH_PROVIDER.parseAuthRequest>>;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		return c.text("Bad Request: invalid OAuth authorization request", 400);
	}

	const body = await c.req.parseBody();
	const password = typeof body.password === "string" ? body.password : "";

	// 【CSRF トークンを別途発行しない判断】通常の CSRF 対策(anti-CSRF token)は
	// 「攻撃者が被害者のセッション Cookie に便乗して意図しない POST を送らせる」ことを防ぐ
	// ためのものだが、このフォームには Cookie セッションが存在せず、代わりに
	// パスワード入力そのものが「本人であることの証明」になっている。攻撃者がこの POST を
	// 成立させるには CALDAV_PASSWORD を知っている必要があり、知っていれば CSRF を経由せず
	// 直接 completeAuthorization を叩けてしまうのと変わらない(パスワードが実質的な
	// CSRF トークンの役割を兼ねる)。単一ユーザー・Basic 相当の認証強度という現段階の
	// 前提が崩れたら(=マルチユーザー化やパスワード以外の要素を足す等)この判断は要再検討 ——
	// その時点ではセッション Cookie + SameSite または専用トークンでの CSRF 対策を追加すること。
	const passwordMatches = await secureStringEqual(password, c.env.CALDAV_PASSWORD);
	if (!passwordMatches) {
		let clientName = "unknown client";
		try {
			const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
			if (client?.clientName) clientName = client.clientName;
		} catch {
			// GET 側と同じくベストエフォート。
		}
		const query = new URL(c.req.url).search.replace(/^\?/, "");
		return c.html(authorizeFormHtml({ query, clientName, error: "パスワードが違います。もう一度お試しください。" }), 401);
	}

	// パスワード一致 = 同意成立。grant を確定し、provider が生成する redirect 先
	// (authorization code 付きの client redirect_uri)へ 302 で返す。
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		// userId は grant の列挙・失効キー(listUserGrants/revokeGrant で使う)。単一ユーザー
		// 運用なので CALDAV_USERNAME をそのまま使う。
		userId: c.env.CALDAV_USERNAME,
		// metadata は any 型(.d.ts 上必須フィールドだが用途は呼び出し側自由)。将来 grant 一覧
		// UI を作るときに「いつ許可したか」を出せるよう、付与日時だけ最小限に残しておく。
		// Date は presentation 層での使用実績あり(xml.ts / mcp/server.ts 等)なので問題ない。
		metadata: { grantedAt: new Date().toISOString() },
		// スコープは要求どおり許可する(現状は claudedav:read のみを広告しているので
		// 細分化した同意 UI にする必要はまだ無い。将来 write スコープを足したら要見直し)。
		scope: oauthReqInfo.scope,
		// 第2スライスとの契約: OAuthPropsAuth(infrastructure/auth/oauth-props-auth.ts)が
		// 復号後に読む形は { username } 固定(OAuthPrincipalProps)。ここを外すと
		// /mcp への全呼び出しが 401 になる(このスライスのタスク仕様に明記の既知の落とし穴)。
		props: { username: c.env.CALDAV_USERNAME } satisfies OAuthPrincipalProps,
	});
	return c.redirect(redirectTo, 302);
});

// =============================================================================
// G-5 → OAuth-for-MCP 第2スライス: /mcp は honoApp ではなく OAuthProvider の apiRoute に移した
// =============================================================================
// 【なぜ /mcp のマウントをここから削除したか(2026-07-12)】
// 以前はここで `app.route("/mcp", createMcpApp(...))` して DAV 用 Hono アプリに /mcp を
// 同居させ、認証は StaticBearerAuth(Bearer 静的トークンの手書き検証)だけで済ませていた。
// OAuth 化(docs/modeling/11・07 §5、方向性 A/E)により /mcp は
// @cloudflare/workers-oauth-provider の OAuthProvider が横取りする構成に変える
// (src/index.ts の `export default new OAuthProvider({...})` 参照)。
// provider は apiRoute にマッチしたリクエストだけを apiHandler(下の mcpApiApp)へ、
// それ以外(DAV・health・.well-known)を defaultHandler(= このファイルの `app`)へ振り分ける。
// よってこの `app`(DAV 用 Hono)に /mcp をマウントしたままだと、provider の後ろでは
// 二度と呼ばれないデッドコードになる — ここで削除し、配線は src/index.ts の
// OAuthProvider 構築側に一本化した。
// DAV の Basic 認証(authenticateBasic)とは元々別の認証 seam(AuthenticationPort)であり、
// その構図自体は変わらない。差し替わったのは「seam の実装が StaticBearerAuth → OAuthPropsAuth」
// になった点と「トークン検証の主体が provider に移った」点。
// 【Cloud Run プロキシは /mcp を経由しない(据え置き)】iOS の正式入口(CLAUDE.md 参照)は
// MKCALENDAR を通すための書き換えプロキシだが、MCP はエージェント/ツール入口であり
// iOS クライアントの CalDAV トラフィックとは無関係。この事情は OAuth 化後も変わらない。

app.all("*", async (c) => {
	try {
		const request = c.req.raw;
		const url = new URL(request.url);
		let method = request.method.toUpperCase();

		// Cloud Run等の外部プロキシだけが MKCALENDAR をPOSTへ変換できる。共有secretを照合し、
		// 一般クライアントが任意のPOSTをMKCALENDARとして偽装することを防ぐ。
		if (method === "POST" && request.headers.get("x-caldav-method")?.toUpperCase() === "MKCALENDAR") {
			const supplied = request.headers.get("x-caldav-proxy-secret") ?? "";
			if (!c.env.PROXY_SHARED_SECRET || !await secureStringEqual(supplied, c.env.PROXY_SHARED_SECRET)) {
				return c.text("Forbidden", 403);
			}
			method = "MKCALENDAR";
		}

		if (method === "OPTIONS") return new Response(null, { status: 204, headers: DAV_HEADERS });

		if (!await authenticateBasic(request.headers.get("authorization") ?? undefined, {
			username: c.env.CALDAV_USERNAME,
			password: c.env.CALDAV_PASSWORD,
		})) {
			return new Response("Unauthorized", { status: 401, headers: UNAUTHORIZED_HEADERS });
		}

		const encodedUser = encodeURIComponent(c.env.CALDAV_USERNAME);
		const principalPathValue = principalPath(principalHref(c.env.CALDAV_USERNAME));
		const home = homeHref(c.env.CALDAV_USERNAME);
		const repos = repositoriesFactory(c.env);

		const path = url.pathname;
		const publicOrigin = externalOrigin(request, url);
		const entryPaths = new Set(["/", "/dav", "/dav/", "/principals", "/principals/"]);
		const principalPathsSet = new Set([
			`/dav/principals/${encodedUser}`,
			`/dav/principals/${encodedUser}/`,
		]);
		const homeNoSlash = home.slice(0, -1);

		// 2026-07-10 レビュー P1-1: 以前は認証済み全リクエストで principals.save + Provision を
		// 実行しており、GET/PUT/REPORT のホットパスに D1 往復 3〜5 回が毎回乗っていた。
		// これらの冪等プロビジョニングが本当に必要なのは iOS の「探索フェーズ」— entry / principal /
		// calendar-home-set への PROPFIND — で、初回に Principal と既定コレクションが見えればよい。
		// なので discovery な PROPFIND に限定してホットパスから除外する。
		// (WorkersでMKCALENDARを受信できない制約に対する本番の主回避策なので機能自体は残す。)
		const isDiscoveryPropfind =
			method === "PROPFIND" &&
			(entryPaths.has(path) ||
				principalPathsSet.has(path) ||
				path === home ||
				path === homeNoSlash);
		if (isDiscoveryPropfind) {
			await repos.principals.save(Principal.create(principalPathValue, home));
			await new ProvisionDefaultCollections(repos.collections, repos.principals).execute({ owner: principalPathValue });
		}

		if (method === "PROPFIND" && entryPaths.has(path)) {
			const body = await readBody(request);
			return xml(multistatus(responseXml(requestHref(url), entryProps(principalHref(c.env.CALDAV_USERNAME)), parsePropFilter(body))));
		}

		if (method === "PROPFIND" && principalPathsSet.has(path)) {
			const body = await readBody(request);
			return xml(multistatus(responseXml(requestHref(url), principalProps(c.env.CALDAV_USERNAME, principalHref(c.env.CALDAV_USERNAME), home), parsePropFilter(body))));
		}

		if (method === "PROPFIND" && (path === home || path === homeNoSlash)) {
			const body = await readBody(request);
			const filter = parsePropFilter(body);
			const depth = request.headers.get("depth") === "1" ? "1" : "0";
			const result = await new ListCollections(repos.collections).execute({ owner: principalPathValue });
			let responses = responseXml(requestHref(url), homeProps(c.env.CALDAV_USERNAME), filter);
			if (depth === "1") {
				for (const collection of result.collections) {
					const href = normalizeCollectionHref(c.env.CALDAV_USERNAME, collection.id);
					responses += responseXml(href, collectionProps(collection, collection.syncToken.toUri(new URL(href, publicOrigin).href)), filter);
				}
			}
			return xml(multistatus(responses));
		}

		const prefix = `${homeHref(c.env.CALDAV_USERNAME)}`;
		if (!path.startsWith(prefix)) return new Response("Not Found", { status: 404 });
		const segments = path.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
		const collectionName = segments[0];
		const resourceName = segments[1];

		if ((method === "MKCOL" || method === "MKCALENDAR") && collectionName && !resourceName) {
			const body = await readBody(request);
			const props = parseCollectionProperties(body);
			// J-2: journal(agentic 日誌)コレクションは自動 provision しない(除去可能性優先の
			// 設計。2026-07-11 判断)。「欲しい人だけ」ここで MKCALENDAR に
			// <C:comp name="VJOURNAL"/> を含めて明示リクエストすればオプトインで作れる。
			// props.components は parseCollectionProperties が既に ComponentKind[] | undefined を
			// 返すのでそのまま渡すだけでよい(未指定 = RFC 4791 §5.2.3 の「全コンポーネント accept」)。
			const result = await new CreateCollection(repos.collections).execute({
				owner: principalPathValue,
				collectionId: collectionName,
				displayName: props.displayName ?? collectionName,
				supportedComponents: props.components,
			});
			return new Response(null, {
				status: 201,
				headers: { ...DAV_HEADERS, Location: normalizeCollectionHref(c.env.CALDAV_USERNAME, result.collection.id) },
			});
		}

		if (!collectionName) return new Response("Not Found", { status: 404 });
		const id = collectionId(collectionName);
		const collection = await repos.collections.findById(principalPathValue, id);
		if (!collection) return new Response("Not Found", { status: 404 });
		const collectionHref = normalizeCollectionHref(c.env.CALDAV_USERNAME, collectionName);

		if (method === "PROPFIND" && !resourceName) {
			const body = await readBody(request);
			const filter = parsePropFilter(body);
			let responses = responseXml(requestHref(url), collectionProps(collection, collection.syncToken.toUri(new URL(collectionHref, publicOrigin).href)), filter);
			if (request.headers.get("depth") === "1") {
				const resources = await repos.resources.findAllInCollection(principalPathValue, id);
				responses += resources.map((resource) => responseXml(`${collectionHref}${encodeURIComponent(resource.uri)}`, objectProps(resource, false), filter)).join("");
			}
			return xml(multistatus(responses));
		}

		if (method === "PROPPATCH" && !resourceName) {
			const props = parseCollectionProperties(await readBody(request));
			await new UpdateCollectionProperties(repos.collections).execute({
				owner: principalPathValue, collectionId: id,
				displayName: props.displayName, color: props.color, order: props.order,
			});
			// PROPPATCH は変更対象プロパティごとの成功 propstat を返す。空の response は
			// iOSが更新失敗と解釈するため、受理した要素を明示する。
			const applied: Record<string, string> = {};
			if (props.displayName !== undefined) applied.displayname = `<d:displayname/>`;
			if (props.color !== undefined) applied["calendar-color"] = `<ical:calendar-color/>`;
			if (props.order !== undefined) applied["calendar-order"] = `<ical:calendar-order/>`;
			return xml(multistatus(responseXml(requestHref(url), applied, new Set(Object.keys(applied)))));
		}

		if (method === "DELETE" && !resourceName) {
			// CalendarCollectionRepository の契約どおり、D1の外部キーCASCADEで配下リソースと
			// syncログも同時に削除する。iOSでリストを削除したとき孤児を残さない。
			await repos.collections.delete(principalPathValue, id);
			return new Response(null, { status: 204, headers: DAV_HEADERS });
		}

		if (method === "REPORT" && !resourceName) {
			const body = await readBody(request);
			if (/<(?:[^:>]+:)?sync-collection\b/i.test(body)) {
				const result = await new SyncCollection(repos.collections, repos.resources).execute({
					owner: principalPathValue, collectionId: id, syncToken: parseSyncToken(body),
					syncTokenBase: new URL(collectionHref, publicOrigin).href,
				});
				// 2026-07-10 レビュー P1-2: 以前は changed 応答を "allprop" 固定にしていたが、
				// これはクライアントの <prop> 要求を無視していた。multiget と同様に parsePropFilter で
				// 要求プロパティを厳密に照合する(iOS は sync-collection では getetag のみ要求する —
				// docs/modeling/06 教訓「要求プロパティの厳密照合」)。includeData=false なので
				// calendar-data は返さず、要求されても objectProps に無ければ 404 propstat になる。
				const filter = parsePropFilter(body);
				const responses = result.diffs.map((diff) => diff.kind === "changed"
					? responseXml(`${collectionHref}${encodeURIComponent(diff.resource.uri)}`, objectProps(diff.resource, false), filter)
					: statusResponseXml(`${collectionHref}${encodeURIComponent(diff.uri)}`, "404 Not Found")).join("");
				return xml(multistatus(responses, result.newSyncToken.toUri(new URL(collectionHref, publicOrigin).href)));
			}
			if (/<(?:[^:>]+:)?calendar-multiget\b/i.test(body)) {
				// 2026-07-10 レビュー P1-3: 以前は全 href について「最後のパスセグメント」だけを拾って
				// resourceUri にしていた。これだと (a) コレクション自身の href(末尾 / なので空文字 URI)や
				// (b) 別コレクション配下の href まで「当コレクション内」として問い合わせてしまう。
				// RFC 4791 §7.9: 見つからない href には 404 の <response> を返す。よって「href のパスが
				// 当該コレクションの href 配下(collectionHref + 1セグメント)であること」を検証し、
				// 外れる href は問い合わせに回さず直接 404 応答にする。
				const uris: string[] = [];
				const outOfScopeHrefs: string[] = [];
				for (const href of parseHrefs(body)) {
					const hrefPath = new URL(href, url.origin).pathname;
					// collectionHref 配下かどうか。collectionHref は末尾 / 付き。
					if (!hrefPath.startsWith(collectionHref)) {
						outOfScopeHrefs.push(hrefPath);
						continue;
					}
					// collectionHref の下の残りを取り出す。ちょうど 1 セグメント(リソース名)であること。
					// 空("コレクション自身")や、さらに / を含む(深いパス)は当コレクションのリソースでない。
					const rest = hrefPath.slice(collectionHref.length).split("/").filter(Boolean);
					if (rest.length !== 1) {
						outOfScopeHrefs.push(hrefPath);
						continue;
					}
					uris.push(decodeURIComponent(rest[0]));
				}
				const result = await new MultigetObjects(repos.resources).execute({ owner: principalPathValue, collectionId: id, uris });
				const filter = parsePropFilter(body);
				const responses = result.found.map((resource) => responseXml(`${collectionHref}${encodeURIComponent(resource.uri)}`, objectProps(resource, true), filter)).join("")
					+ result.notFound.map((uri) => statusResponseXml(`${collectionHref}${encodeURIComponent(uri)}`, "404 Not Found")).join("")
					// スコープ外 href は、クライアントが送ってきたパスをそのまま 404 で返す(§7.9)。
					+ outOfScopeHrefs.map((hrefPath) => statusResponseXml(hrefPath, "404 Not Found")).join("");
				return xml(multistatus(responses));
			}
			if (/<(?:[^:>]+:)?free-busy-query\b/i.test(body)) {
				// free-busy-query REPORT(RFC 4791 §7.10。G-4)。collection に対してのみ実行可
				// (object に対する 403 は resourceName ありのブランチ側で先に弾く。下記参照)。
				// §9.11: free-busy-query は time-range をちょうど1個含む MUST。壊れている/
				// 無い場合は「解析失敗」として扱う。§7.10 自体には free-busy-query 用の
				// precondition 名が定義されていないため、calendar-query の
				// CALDAV:supported-filter のような専用エラー要素は無い。安全側に倒して
				// 空区間(=常に 0〜OCCURRENCE_INDEX_MAX)にはせず、明確に 400 で拒否する
				// (「requested-time-range」がクライアントの不備だと分かるよう Bad Request とする)。
				const range = parseFreeBusyQuery(body);
				if (range === null) {
					return new Response("Bad Request: free-busy-query requires exactly one time-range", { status: 400, headers: DAV_HEADERS });
				}
				const fbResult = await new ComputeFreeBusy(repos.resources, recurrenceIterator).execute({
					owner: principalPathValue,
					collectionId: id,
					rangeStartMillis: range.startMillis,
					rangeEndMillis: range.endMillis,
				});
				// 応答は multistatus ではなく text/calendar 本文そのもの(§7.10 Marshalling)。
				return new Response(serializeFreeBusyResponse(fbResult.intervals, range.startMillis, range.endMillis), {
					status: 200,
					headers: { ...DAV_HEADERS, "Content-Type": "text/calendar; charset=utf-8" },
				});
			}
			// calendar-query REPORT(RFC 4791 §7.8。G-3 で「全件返す」仮実装から差し替え)。
			// 未対応の filter 要素(prop-filter 等)を検出したら §7.8 precondition の
			// CALDAV:supported-filter で 403 を返す(davError の流儀を踏襲)。
			const queryFilter = parseCalendarQueryFilter(body);
			if (queryFilter.unsupported) {
				return xml(davError("supported-filter"), 403);
			}
			const queryResult = await new CalendarQuery(repos.resources, recurrenceIterator).execute({
				owner: principalPathValue,
				collectionId: id,
				componentKind: queryFilter.componentName,
				range: queryFilter.timeRange,
				floatingTimeZone: queryFilter.floatingTimeZone,
			});
			const filter = parsePropFilter(body);
			return xml(multistatus(queryResult.resources.map((resource) => responseXml(`${collectionHref}${encodeURIComponent(resource.uri)}`, objectProps(resource, true), filter)).join("")));
		}

		if (!resourceName) return new Response("Method Not Allowed", { status: 405, headers: DAV_HEADERS });

		if (method === "REPORT" && /<(?:[^:>]+:)?free-busy-query\b/i.test(await readBody(request))) {
			// RFC 4791 §7.10 Marshalling: "The CALDAV:free-busy-query REPORT request can only
			// be run against a collection ... An attempt to run the report on a calendar object
			// resource MUST fail and return a 403 (Forbidden) status value." resourceName が
			// あるここは「オブジェクトリソースに対する REPORT」なので、free-busy-query だけを
			// 明示的に 403 で弾く(他の REPORT 種別を object に対して送ってきた場合は、
			// この分岐を素通りして下の最終 405 フォールバックに落ちる — その扱いは元々の
			// 挙動を変えない、今回のスコープ外の話)。
			return new Response("Forbidden: free-busy-query REPORT can only be run against a collection", { status: 403, headers: DAV_HEADERS });
		}

		if (method === "GET" || method === "HEAD") {
			const result = await new GetCalendarObject(repos.resources).execute({ owner: principalPathValue, collectionId: id, resourceUri: resourceName });
			if (request.headers.get("if-none-match") === result.resource.etag.toHeader()) return new Response(null, { status: 304 });
			return new Response(method === "HEAD" ? null : result.resource.rawIcs, {
				status: 200,
				headers: { ...DAV_HEADERS, ETag: result.resource.etag.toHeader(), "Content-Type": "text/calendar; charset=utf-8" },
			});
		}

		if (method === "PROPFIND") {
			const result = await new GetCalendarObject(repos.resources).execute({ owner: principalPathValue, collectionId: id, resourceUri: resourceName });
			return xml(multistatus(responseXml(requestHref(url), objectProps(result.resource, false), parsePropFilter(await readBody(request)))));
		}

		if (method === "PUT") {
			const result = await new PutCalendarObject(repos.collections, repos.resources, repos.uow, recurrenceIterator).execute({
				owner: principalPathValue, collectionId: id, resourceUri: resourceName,
				ics: await readBody(request), condition: rawEtagCondition(request),
			});
			return new Response(null, { status: result.created ? 201 : 204, headers: { ...DAV_HEADERS, ETag: result.etag.toHeader() } });
		}

		if (method === "DELETE") {
			await new DeleteCalendarObject(repos.collections, repos.resources, repos.uow).execute({
				owner: principalPathValue, collectionId: id, resourceUri: resourceName,
				ifMatchEtag: request.headers.get("if-match"),
			});
			return new Response(null, { status: 204, headers: DAV_HEADERS });
		}

		return new Response("Method Not Allowed", { status: 405, headers: DAV_HEADERS });
	} catch (error) {
		return errorResponse(error);
	}
});

// =============================================================================
// MCP 用 apiHandler(OAuthProvider の apiRoute: "/mcp" にマッチしたリクエストの委譲先)
// =============================================================================
// 【なぜ new Hono().route("/mcp", createMcpApp(...)) でフルパス受けにするのか】
// createMcpApp は内部で `app.all("/")`(ルートパス)としてハンドラを組んである
// (server.ts 参照。DAV 側の `app.route("/mcp", createMcpApp(...))` でマウントされる前提の
// 設計だった)。OAuthProvider の apiHandler は URL を書き換えず「/mcp」込みのフル URL の
// まま Request を渡してくる(provider は apiRoute プレフィックスの有無で振り分けるだけで
// パスの rewrite はしない)。よって apiHandler 側でも同じ `/mcp` マウントを再現し、
// createMcpApp の `app.all("/")` にフルパスの "/mcp" が届くようにする。
//
// 【なぜここ(app.ts)に置くのか(2026-07-12 物理分離)】mcpApiApp 自体は
// @cloudflare/workers-oauth-provider を import していない(OAuthPropsAuth は
// infrastructure の port 実装であって provider の値そのものではない)ので、
// provider 非依存というこのファイルの制約を破らない。src/index.ts が
// `apiHandler: { fetch: (req, env, ctx) => mcpApiApp.fetch(req, env, ctx) } ` として
// これを配線する。bun test からは provider を経由せず mcpApiApp を直接 fetch でき、
// これが SHOULD-1 の新規テスト(mcp-api-wiring.test.ts)の前提になっている。
export const mcpApiApp = new Hono<{ Bindings: CloudflareBindings }>().route(
	"/mcp",
	createMcpApp((env, ctx) => {
		const repos = repositoriesFactory(env);
		// ctx.props は provider が検証済みトークン(内部 KV トークン or resolveExternalToken の
		// 戻り値)から復号して ExecutionContext に載せる(OAuthProvider.d.ts のコメント参照)。
		// Hono の ExecutionContext 型には props フィールドが無い(provider の実行時拡張)ため、
		// ここで局所的に型を拡張して吸収する(server.ts はこの型を知らない = 層分離を保つ)。
		// ctx は server.ts の型(hono の ExecutionContext)で来るが、実行時に provider が
		// 注入する props は hono 型にも @cloudflare/workers-types のグローバル ExecutionContext
		// にも存在しない独自拡張。二つの型は構造的に重ならない(tracing 等のフィールド差)ため
		// 直接 `as` できず、一旦 unknown を経由して局所的に narrow する。
		const props = (ctx as unknown as { props?: OAuthPrincipalProps } | undefined)?.props;
		return {
			auth: new OAuthPropsAuth(props),
			collectionRepo: repos.collections,
			resourceRepo: repos.resources,
			iterator: recurrenceIterator,
		};
	}),
);

// =============================================================================
// resolveExternalToken(MCP_TOKEN 静的トークンとの共存口)— 純関数として named export
// =============================================================================
// 【なぜ index.ts の options インラインではなくここに純関数として切り出すのか(2026-07-12)】
// このロジック自体は @cloudflare/workers-oauth-provider の型・値に一切依存しない
// (token 文字列と env を受け取り、props か null を返すだけ)。provider 非依存の
// このファイルに置くことで、provider を一切 import せずに bun test でユニットテスト
// できる(mcp-api-wiring.test.ts 参照)。index.ts 側は `resolveExternalToken:
// resolveExternalTokenForMcp` として ResolveExternalTokenOptions 契約に渡すだけの
// 薄い配線になる。
//
// 【なぜ resolveExternalToken が要るのか】既存の StaticBearerAuth 運用(Wrangler secret
// MCP_TOKEN を Bearer で渡す、CLI/スクリプト等の「人間が対話的に OAuth フローを踏めない」
// クライアント向け)を OAuth 導入後も生かすための脱出口。provider の内部 KV トークンで
// 見つからないトークンはこのコールバックに回ってくる。
// 【audience(aud)を検証しない理由】ResolveExternalTokenResult.audience は RFC 8707 の
// aud クレームを提供する場所だが、MCP_TOKEN は単なる共有シークレット文字列であり
// トークン自体に aud という概念を持たない(StaticBearerAuth が resourceUri を no-op に
// していたのと同じ判断 — infrastructure/auth/static-bearer-auth.ts のコメント参照)。
// よってここでは audience を返さず、provider 側の audience 検証をスキップする。
export async function resolveExternalTokenForMcp(input: {
	token: string;
	env: CloudflareBindings;
}): Promise<{ props: OAuthPrincipalProps } | null> {
	// MCP_TOKEN 未設定(空文字)なら「秘密鍵が空文字で誰でも通る」事故を避けるため、
	// どんなトークンが来ても常に不一致として扱う(StaticBearerAuth と同じガード)。
	if (!input.env.MCP_TOKEN) return null;
	const matches = await secureStringEqual(input.token, input.env.MCP_TOKEN);
	if (!matches) return null;
	// props は OAuthPropsAuth が読む形(OAuthPrincipalProps)に合わせる。
	const props: OAuthPrincipalProps = { username: input.env.CALDAV_USERNAME };
	return { props };
}
