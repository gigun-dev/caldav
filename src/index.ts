// =============================================================================
// CalDAV Worker entrypoint
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
import { createD1Repositories, IcaljsRRuleIterator } from "./infrastructure";
import { authenticateBasic, secureStringEqual, UNAUTHORIZED_HEADERS } from "./presentation/auth/basic-auth";
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
interface Repositories {
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

const app = new Hono<{ Bindings: CloudflareBindings }>();

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

export default app;
