// =============================================================================
// /mcp エンドポイントの統合テスト(G-5)
// =============================================================================
// 【2026-07-12 OAuth-for-MCP 第2スライス: OAuth を経由しない直叩きに付け替えた経緯】
// 以前は src/index.ts の default export(生 Hono アプリ)に /mcp が同居しており、
// app.fetch を丸ごと exercise して MCP_TOKEN Bearer 経由でツールを叩いていた。
// 第2スライスで /mcp は OAuthProvider(@cloudflare/workers-oauth-provider)の apiRoute に
// 移り、default export は OAuthProvider インスタンスになった(KV バインディング前提)。
// bun test には workerd/KV が無く OAuth フローそのものを単体テストで再現するのは大掛かり
// なので、「MCP ツールの振る舞い」と「認証機構(OAuth vs 静的 Bearer)」を分離する:
// このテストは createMcpApp を直接叩き、認証は元の StaticBearerAuth を注入して行う
// (OAuthPropsAuth に差し替えても認証が通った後のツール挙動は変わらないため、ツールの
// 振る舞いテストとしてはこれで十分。OAuth フロー自体の検証は手動/実機で行う想定)。
//
// StreamableHTTPTransport はデフォルト(sessionIdGenerator 未指定)で stateless モードに
// なる(SDK の streamableHttp.d.ts コメント参照。実測でも initialize なしに tools/list や
// tools/call を単発で送って応答が返ることを確認済み)。createMcpApp が「リクエストごとに
// McpServer/Transport を新規生成する」設計(server.ts のコメント参照)とも整合する
// (セッションを isolate 間で共有する必要がない)。
//
// レスポンスは Accept: text/event-stream 込みだと `event: message\ndata: {...}\n\n`
// という SSE 1行として返る(実測)。テストでは `data: ` 行を抜き出して JSON.parse する。
// =============================================================================

import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createMcpApp } from "../../src/presentation/mcp/server";
// S1(docs/modeling/14): delete-* はトークン必須化されたので、既存の delete 挙動テストは免除トークン
// (kind:"card")を confirmToken に添えて実行する(確認フロー自体の e2e は下の describe「S1 確認カード」で別途検証)。
import { signConfirmToken } from "../../src/presentation/mcp/confirm-token";
import { StaticBearerAuth, IcaljsRRuleIterator, NoopTelemetryAdapter } from "../../src/infrastructure";
import { AppleColor, CalendarCollection, CalendarObjectResource, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
} from "../application/fakes";

const USERNAME = "test";
const MCP_TOKEN = "mcp-secret-token";
// S1(docs/modeling/14 確認カード): 確認トークン HMAC 署名鍵(テスト固定値)。
const CONFIRM_SECRET = "test-confirm-secret";
// 免除トークン(カード発の削除相当)。CONFIRM_SECRET で署名すれば server 側の同じ鍵で検証が通る。
async function cardToken(): Promise<string> {
	return signConfirmToken(CONFIRM_SECRET, { kind: "card" });
}
const OWNER = principalPath(`/dav/principals/${USERNAME}/`);
const CALENDAR = collectionId("calendar");

const ENV = {
	DB: {} as unknown,
	CALDAV_USERNAME: USERNAME,
	CALDAV_PASSWORD: "secret",
	PROXY_SHARED_SECRET: "",
	MCP_TOKEN,
	CONFIRM_SECRET,
} as unknown as CloudflareBindings;

// 反復無しの単発 VEVENT(2026-07-15 10:00〜11:00 UTC)。
function vevent(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		"DTSTART:20260715T100000Z",
		"DTEND:20260715T110000Z",
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

let repos: {
	principals: FakePrincipalRepository;
	collections: FakeCalendarCollectionRepository;
	resources: FakeCalendarObjectResourceRepository;
	uow: FakeCollectionUnitOfWork;
};
// 反復 port。src/index.ts の recurrenceIterator と同じく状態を持たないので使い回して良い。
const recurrenceIterator = new IcaljsRRuleIterator();
// mcpApp: createMcpApp を直接組んだテスト専用サブアプリ。OAuthProvider を経由せず、
// 認証は元の StaticBearerAuth のまま(このテストの目的はツールの振る舞い検証であって
// OAuth フローの検証ではない — ファイル冒頭コメント参照)。
let mcpApp: Hono<{ Bindings: CloudflareBindings }>;

beforeEach(() => {
	const principals = new FakePrincipalRepository();
	const collections = new FakeCalendarCollectionRepository();
	const resources = new FakeCalendarObjectResourceRepository();
	const uow = new FakeCollectionUnitOfWork(resources, collections);
	repos = { principals, collections, resources, uow };
	mcpApp = new Hono<{ Bindings: CloudflareBindings }>().route(
		"/mcp",
		createMcpApp(() => ({
			auth: new StaticBearerAuth({ mcpToken: MCP_TOKEN, username: USERNAME }),
			collectionRepo: repos.collections,
			resourceRepo: repos.resources,
			iterator: recurrenceIterator,
			uow: repos.uow,
			// S1(docs/modeling/14): カード発の免除トークン(getCardToken)の署名鍵。テストは固定値で
			// 十分(cardToken() ヘルパーがこの鍵で署名したトークンを取得する用途のみ — #47 で
			// propose-delete-* を撤去した後は検証には一切使われないので、値そのものは何でもよい)。
			confirmSecret: CONFIRM_SECRET,
			// 観測基盤 v1: ツール振る舞いテストなので計測は no-op(AE マッピングの検証は
			// analytics-engine-telemetry.test.ts がフェイク dataset を注入して単体で行う)。
			telemetry: new NoopTelemetryAdapter(),
			// #45 場所モデル: この汎用ハーネスでは geocoding は使わない(search-location 専用の検証は
			// 下の describe が専用 createMcpApp + フェイク GeocodingPort を組んで行う)。空候補スタブ。
			geocoding: { searchLocation: async () => [] },
		})),
	);
});

async function fetchMcp(body: unknown): Promise<Response> {
	return mcpApp.fetch(
		new Request("https://example.com/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${MCP_TOKEN}`,
			},
			body: JSON.stringify(body),
		}),
		ENV,
	);
}

/** SSE(`event: message\ndata: {...}\n\n`)またはプレーン JSON、どちらでも JSON-RPC 応答を取り出す。 */
async function jsonRpcResult(res: Response): Promise<any> {
	const text = await res.text();
	const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
	const payload = dataLine !== undefined ? dataLine.slice("data: ".length) : text;
	return JSON.parse(payload);
}

async function seedEvent(uid: string, summary: string): Promise<void> {
	repos.collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }));
	const resource = await CalendarObjectResource.fromIcs(resourceUri(`${uid}.ics`), vevent(uid, summary));
	repos.resources.seed(OWNER, CALENDAR, resource);
}

describe("/mcp", () => {
	// 2026-07-12 OAuth-for-MCP 第2スライス SHOULD-2: このテストが叩いているのは
	// StaticBearerAuth(このファイルが直接組んだ mcpApp)の防御フォールバック 401 であって、
	// 本番の /mcp 401 の主経路ではない。本番では /mcp は OAuthProvider の apiRoute で
	// 保護されており、認証していない/不正なリクエストへの 401 は provider 自身が
	// `WWW-Authenticate: Bearer realm="OAuth", resource_metadata=...` という形で返す
	// (OAuthPropsAuth まで到達する前に provider 側で弾かれる)。ここでの
	// `realm="caldav-mcp"` は StaticBearerAuth 実装(infrastructure/auth/static-bearer-auth.ts)
	// 固有の文字列であり、OAuth 経路の実際のレスポンスとは異なる。このテストの目的は
	// あくまで「認証機構を差し替えても MCP ツールの振る舞いは変わらない」ことの検証
	// (ファイル冒頭コメント参照)であって、本番の 401 レスポンス形を保証するものではない。
	it("Authorization ヘッダ無しは 401 + WWW-Authenticate(StaticBearerAuth 経由。本番の主経路ではない)", async () => {
		const res = await mcpApp.fetch(new Request("https://example.com/mcp", { method: "POST" }), ENV);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="caldav-mcp"');
	});

	it("誤った Bearer トークンは 401", async () => {
		const res = await mcpApp.fetch(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}),
			ENV,
		);
		expect(res.status).toBe(401);
	});

	// 2026-07-13 E-2 スライス②: refresh-todos(UI 専用 app ツール)を追加したため 8→9 に更新。
	// 【なぜ 9(据え置きでない)か】refresh-todos は _meta.ui.visibility:["app"] を持つが、
	// これは「ホストがモデルに見せるか」という提示ヒントであって、MCP プロトコルの tools/list
	// からツールを消す機構ではない(registerAppTool は registerTool の薄いラッパーで、
	// tools/list には従来どおり出る。ext-apps server d.ts で確認)。つまりサーバー実装レベルの
	// tools/list には refresh-todos も並ぶのが正しい挙動で、visibility による「モデルへの非提示」は
	// ホスト(claude.ai/iOS)側の描画時フィルタとして効く。
	// 2026-07-14: list-calendars/create-calendar(ListCollections/CreateCollection UC を MCP から
	// 露出)を追加したため 9→11 に更新。
	// 2026-07-14 追記: delete-calendar(list-calendars/create-calendar の対。DeleteCollection UC を
	// MCP から露出)を追加したため 11→12 に更新。
	// 2026-07-14 追記2: create-todos(複数件バッチ追加。create-todo を N 回呼ぶとホスト UI に
	// カードが N 枚積まれる語彙の穴を塞ぐ)を追加したため 12→13 に更新。
	// 2026-07-15 追記: move-todo(UI 詳細シート「リスト ›」からの VTODO コレクション間移動。
	// move-todo.ts 冒頭コメント参照)を追加したため 13→14 に更新。
	// 2026-07-15 E-3 S1 追記: create-event/create-events/update-event/delete-event(VEVENT の MCP
	// 書き込みツール一式。docs/modeling/12)を追加したため 14→18 に更新。
	// 2026-07-15 E-3 S2 追記: refresh-events(アジェンダカード専用の再読み込み app ツール。refresh-todos と
	// 対称。visibility:["app"] でも tools/list には出る)を追加したため 18→19 に更新。
	// 2026-07-18 C5 追記: list-known-locations(既知の場所ツール。設計 05 §3・§5・§6)を追加したため
	// 19→20 に更新。
	// 2026-07-22 S1 追記: propose-delete-todo/propose-delete-event/propose-delete-calendar(確認カードの
	// 入り口。docs/modeling/14)を追加したため 20→23 に更新。
	// 2026-07-23 R2 追記: list-deleted/restore-deleted(ソフトデリートのゴミ箱一覧 + 復元。
	// docs/modeling/15 §A-3 R2)を追加したため 23→25 に更新。
	// 2026-07-23 K2 追記: update-calendar(list-calendars/create-calendar/delete-calendar の対を
	// 埋める。MCP から表示名/色を変更できるようにした)を追加したため 25→26 に更新。
	// 2026-07-23 #45 追記: search-location(geocoding。文字列 → 座標候補)を追加したため 26→27 に更新。
	// 2026-07-23 #47 撤去: propose-delete-todo/event/calendar(確認 UI はホスト責務へ移行済みで
	// 確認カードの入口が不要になった。撤去理由は server.ts の buildMcpServer 冒頭近くのコメント参照)を
	// 削除したため 27→24 に更新。
	// 2026-07-23 iOS 描画切り分け追記: diag-card(最小診断カードを出す一時ツール。iOS で todos/agenda
	// カードだけ描画失敗する原因を認証 vs バンドルサイズで切り分ける用。切り分け完了後に撤去予定)を
	// 追加したため 24→25 に更新。
	it("正しい Bearer で tools/list に25ツールが並ぶ(diag-card 追加後)", async () => {
		const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(res.status).toBe(200);
		const rpc = await jsonRpcResult(res);
		const names = rpc.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual([
			"complete-todo",
			"create-calendar",
			"create-event",
			"create-events",
			"create-todo",
			"create-todos",
			"delete-calendar",
			"delete-event",
			"delete-todo",
			"diag-card",
			"get-current-time",
			"get-freebusy",
			"list-calendars",
			"list-deleted",
			"list-events-expanded",
			"list-known-locations",
			"list-todos",
			"move-todo",
			"refresh-events",
			"refresh-todos",
			"restore-deleted",
			"search-location",
			"update-calendar",
			"update-event",
			"update-todo",
		]);
	});

	// R1(docs/modeling/15 §A-2): tool annotations の代表サンプル検証。全23ツール分を1件ずつ
	// 突き合わせると変更のたびにこのテストを保守するコストが高いので、read/create/update/delete
	// それぞれの代表1〜2ツールで annotations の形が正しく付いていることだけを固定する
	// (annotations 自体は untrusted hint なので、値の正しさより「未申告のツールが無い」ことが本質)。
	it("tools/list の annotations が read/create/update/delete で申告される", async () => {
		const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const rpc = await jsonRpcResult(res);
		const byName = new Map<string, { annotations?: Record<string, unknown> }>(
			rpc.result.tools.map((t: { name: string; annotations?: Record<string, unknown> }) => [t.name, t]),
		);
		// read 系: readOnlyHint:true・openWorldHint:false。
		expect(byName.get("list-todos")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
		expect(byName.get("get-current-time")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
		// create 系: readOnlyHint:false・destructiveHint:false・idempotentHint:false・openWorldHint:false。
		expect(byName.get("create-todo")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		// update/complete/move 系: destructiveHint:true(R3 の revert 導入まで「戻せない」と正直に申告)。
		expect(byName.get("update-todo")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
		// delete 系: destructiveHint:true・idempotentHint:true。
		expect(byName.get("delete-todo")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		// update-calendar(K2): destructiveHint:true・idempotentHint:true(値は delete 系と同じだが
		// 意味付けは独立に決めている — server.ts UPDATE_CALENDAR_ANNOTATIONS コメント参照)。
		expect(byName.get("update-calendar")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		// create-calendar だけ他の create 系と異なり idempotentHint:true(2026-07-23 ユーザー裁定:
		// 同名 displayName の2回目呼び出しは拒否ではなく既存を成功として返す真の冪等に再設計した
		// ため。server.ts CREATE_CALENDAR_ANNOTATIONS コメント参照)。
		expect(byName.get("create-calendar")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	// ②③(2026-07-24)カード紐付けは tools/list の _meta.ui.resourceUri(ext-apps の outputTemplate)で
	// ホストへ宣言される(registerAppTool が config._meta.ui を tools/list に載せる)。event の mutate
	// 一式(③)がアジェンダカードを、list-deleted/restore-deleted(②)が todos カードを紐付けることを固定する。
	it("tools/list の _meta.ui が event mutate=agenda・trash=todos カードを紐付ける(②③)", async () => {
		const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const rpc = await jsonRpcResult(res);
		const byName = new Map<string, { _meta?: { ui?: { resourceUri?: string } } }>(
			rpc.result.tools.map((t: { name: string }) => [t.name, t]),
		);
		// ③ event mutate 一式 → アジェンダカード(実機 swift ホストで mutate 応答にカードが出なかった穴を塞ぐ)。
		for (const name of ["create-event", "create-events", "update-event", "delete-event"]) {
			expect(byName.get(name)?._meta?.ui?.resourceUri).toContain("ui://caldav/agenda.");
		}
		// ② ゴミ箱系 → todos カード。
		for (const name of ["list-deleted", "restore-deleted"]) {
			expect(byName.get(name)?._meta?.ui?.resourceUri).toContain("ui://caldav/todos.");
		}
	});

	// 2026-07-23 iOS 描画切り分けスパイク: diag-card ツールと ui://caldav/diag.html リソースの検証。
	// このスパイクの本質は「todos/agenda と同じ登録経路を通しつつ、中身だけ極小(外部依存ゼロ・< 2KB)に
	// する」こと。よってテストで固定するのは (1) tool が _meta.ui で diag リソースを紐付ける、
	// (2) resources/read が HTML を返す、(3) HTML が 2KB 以下で外部 URL 参照ゼロ、の3点。
	// 中身が肥大化/外部依存混入すると切り分けの意味(サイズ/内容説の対照)が崩れるので機械的に固定する。
	describe("diag-card(iOS 描画切り分け用・最小カード)", () => {
		it("tools/list の diag-card が _meta.ui.resourceUri で diag リソースを紐付ける", async () => {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
			const rpc = await jsonRpcResult(res);
			const byName = new Map<string, { _meta?: { ui?: { resourceUri?: string } }; annotations?: Record<string, unknown> }>(
				rpc.result.tools.map((t: { name: string }) => [t.name, t]),
			);
			const diag = byName.get("diag-card");
			expect(diag).toBeDefined();
			expect(diag?._meta?.ui?.resourceUri).toBe("ui://caldav/diag.html");
			// 照会系(副作用なし)なので read-only 申告(todos の list-todos 等と同じ形)。
			expect(diag?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
		});

		it("resources/read が diag HTML を text/html;profile=mcp-app で返す", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: { uri: "ui://caldav/diag.html" },
			});
			expect(res.status).toBe(200);
			const rpc = await jsonRpcResult(res);
			const content = rpc.result.contents[0];
			expect(content.uri).toBe("ui://caldav/diag.html");
			expect(content.mimeType).toBe("text/html;profile=mcp-app");
			expect(content.text).toContain("診断カード");
		});

		it("diag HTML は 2KB 以下・外部 URL 参照ゼロ(切り分けの対照条件を機械的に固定)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: { uri: "ui://caldav/diag.html" },
			});
			const rpc = await jsonRpcResult(res);
			const html: string = rpc.result.contents[0].text;
			// サイズ上限 2048 バイト(仮説 (b) モバイル上限説を切り分ける「小さいカード」の定義)。
			expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(2048);
			// 外部依存ゼロ: http(s):// や //cdn 等のプロトコル/プロトコル相対 URL を含まない
			// (App SDK・CDN・フォント等を一切引かないので、SDK 読込やネットワークが失敗要因から排除される)。
			expect(html).not.toMatch(/https?:\/\//i);
			expect(html).not.toMatch(/src\s*=\s*["']\/\//i);
		});

		it("diag-card 呼び出しが structuredContent { ok, generatedAt } を返す", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "diag-card", arguments: {} },
			});
			expect(res.status).toBe(200);
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.structuredContent.ok).toBe(true);
			expect(typeof rpc.result.structuredContent.generatedAt).toBe("number");
		});
	});

	it("initialize が単発でも成功する(stateless transport)", async () => {
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
		});
		expect(res.status).toBe(200);
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.serverInfo.name).toBe("caldav-mcp");
	});

	it("get-current-time: 構造化応答を返す", async () => {
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get-current-time", arguments: { timeZone: "Asia/Tokyo" } },
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBeFalsy();
		expect(rpc.result.structuredContent.timeZone).toBe("Asia/Tokyo");
		expect(typeof rpc.result.structuredContent.currentTime).toBe("string");
		expect(typeof rpc.result.structuredContent.dayOfWeek).toBe("string");
	});

	it("get-current-time: 不正な IANA ゾーンは isError", async () => {
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get-current-time", arguments: { timeZone: "Not/AZone" } },
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBe(true);
	});

	it("list-events-expanded: 単発 VEVENT を1件返す(calendarId 指定)", async () => {
		await seedEvent("uid-mcp-1", "MCP Test Event");
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "list-events-expanded",
				arguments: {
					timeMin: "2026-07-01T00:00:00Z",
					timeMax: "2026-08-01T00:00:00Z",
					calendarId: "calendar",
				},
			},
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBeFalsy();
		const { events, truncated } = rpc.result.structuredContent;
		expect(truncated).toBe(false);
		expect(events).toHaveLength(1);
		expect(events[0].uid).toBe("uid-mcp-1");
		expect(events[0].summary).toBe("MCP Test Event");
		expect(events[0].isAllDay).toBe(false);
		expect(events[0].start).toBe("2026-07-15T10:00:00Z");
		// echo 契約(2026-07-22 agenda echo pin バグ修正): calendarId を単数指定した場合はその値をそのまま echo する。
		expect(rpc.result.structuredContent.calendarId).toBe("calendar");
	});

	it("list-events-expanded: calendarId 省略で全コレクション横断", async () => {
		await seedEvent("uid-mcp-2", "Cross Collection Event");
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "list-events-expanded",
				arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z" },
			},
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.structuredContent.events).toHaveLength(1);
		// echo 契約: 全コレクション横断(calendarId/calendarIds どちらも未指定)のときは、旧実装のような
		// 架空の "calendar" 固定 echo をやめて正直に null を返す(agenda echo pin バグの根本原因だった —
		// これを "calendar" と偽装すると agenda-entry.ts の currentCalendarId に保存され、以降の
		// focus refetch が全横断のつもりが単一コレクション "calendar" だけへ collapse していた)。
		expect(rpc.result.structuredContent.calendarId).toBeNull();
		expect(rpc.result.structuredContent.calendarIds).toBeUndefined();
	});

	// calendarIds(2026-07-22 agenda カード表示フィルタ): 複数コレクションを明示指定して、その集合だけを
	// 横断合成する経路。2コレクションに1件ずつ seed し、両方/片方指定で件数が変わることを確認する
	// (アジェンダカードが「一部だけ表示 ON」を calendarIds で表現する挙動の裏取り)。
	it("list-events-expanded: calendarIds で指定した集合だけを合成する(件数が変わる)", async () => {
		// seedEvent は既定の "calendar" コレクションへ入れる。もう1つ "work" コレクションを足して1件 seed。
		await seedEvent("uid-cids-1", "In Calendar");
		repos.collections.seed(new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work" }));
		const workResource = await CalendarObjectResource.fromIcs(resourceUri("uid-cids-2.ics"), vevent("uid-cids-2", "In Work"));
		repos.resources.seed(OWNER, collectionId("work"), workResource);

		const call = async (args: Record<string, unknown>) => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "list-events-expanded",
					arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", ...args },
				},
			});
			return (await jsonRpcResult(res)).result.structuredContent;
		};

		// 両方指定 → 2件。各 event に由来コレクション(calendarId)が入っていることも確認(色ドット用)。
		const both = await call({ calendarIds: ["calendar", "work"] });
		expect(both.events).toHaveLength(2);
		expect(new Set(both.events.map((e: { calendarId: string }) => e.calendarId))).toEqual(new Set(["calendar", "work"]));
		// echo 契約: calendarIds 指定時は指定した集合をそのまま additive に echo する(単数 calendarId の
		// echo とは別枠。calendarId 側は複数横断を表す単一 ID が無いので null のまま)。
		expect(both.calendarIds).toEqual(["calendar", "work"]);
		expect(both.calendarId).toBeNull();

		// 片方だけ指定 → 1件(その集合だけに絞られる)。
		const onlyWork = await call({ calendarIds: ["work"] });
		expect(onlyWork.events).toHaveLength(1);
		expect(onlyWork.events[0].calendarId).toBe("work");

		// calendarIds が calendarId(単数)より優先される: 単数で "calendar" を指定しても calendarIds が勝つ。
		const priority = await call({ calendarId: "calendar", calendarIds: ["work"] });
		expect(priority.events).toHaveLength(1);
		expect(priority.events[0].calendarId).toBe("work");
	});

	it("list-events-expanded: floating(offset無し)入力は isError", async () => {
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "list-events-expanded",
				arguments: { timeMin: "2026-07-01T00:00:00", timeMax: "2026-08-01T00:00:00Z" },
			},
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBe(true);
	});

	it("get-freebusy: busy 区間を返す(calendarId 指定)", async () => {
		await seedEvent("uid-mcp-3", "Busy Event");
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get-freebusy",
				arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", calendarId: "calendar" },
			},
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBeFalsy();
		const { busy } = rpc.result.structuredContent;
		expect(busy).toHaveLength(1);
		expect(busy[0].type).toBe("BUSY");
		expect(busy[0].start).toBe("2026-07-15T10:00:00Z");
		expect(busy[0].end).toBe("2026-07-15T11:00:00Z");
	});

	it("get-freebusy: calendarId 省略で全コレクション横断・再 coalesce", async () => {
		await seedEvent("uid-mcp-4", "Busy Event 2");
		const res = await fetchMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get-freebusy",
				arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z" },
			},
		});
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.structuredContent.busy).toHaveLength(1);
	});

	// 2026-07-16: 時刻グラウンディングの相対レンジ enum(range)+ resolvedRange エコー。
	// 【now を固定注入できない制約】ハンドラは Date.now() を直読みするため統合テストでは now を固定できない。
	// そこで「now 依存の絶対値」は検証せず、(a) 境界が現地0時になる形(resolvedRange.timeMin/timeMax の
	// 壁時計パターン)(b) serverNow が範囲内にあること (c) XOR/TZ 必須の検証エラー を確認する。
	// now を固定した境界の厳密検証は test/application/relative-range.test.ts(純関数側)が担う。
	describe("相対レンジ(range)+ resolvedRange エコー", () => {
		it("range:today(timeZone 指定)で範囲を導出し resolvedRange を返す(境界は現地0時・serverNow は範囲内)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list-events-expanded", arguments: { range: "today", timeZone: "UTC" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const rr = rpc.result.structuredContent.resolvedRange;
			// today の両端は UTC の現地0時(終端排他)。now 依存だが「現地0時」の形は固定。
			expect(rr.timeMin).toMatch(/T00:00:00Z$/);
			expect(rr.timeMax).toMatch(/T00:00:00Z$/);
			expect(rr.timeZone).toBe("UTC");
			// serverNow は [timeMin, timeMax) の中にある(サーバー権威の now で境界を計算した証拠)。
			expect(Date.parse(rr.timeMin)).toBeLessThanOrEqual(Date.parse(rr.serverNow));
			expect(Date.parse(rr.serverNow)).toBeLessThan(Date.parse(rr.timeMax));
			// range echo(range.from/to)は resolvedRange と一致する(実際に使った範囲)。
			expect(rpc.result.structuredContent.range.from).toBe(rr.timeMin);
			expect(rpc.result.structuredContent.range.to).toBe(rr.timeMax);
		});

		it("range と timeMin/timeMax の併記は isError(排他違反)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "list-events-expanded",
					arguments: { range: "today", timeMin: "2026-07-01T00:00:00Z", timeZone: "UTC" },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		it("range 指定で timeZone 欠落は isError(暗黙 UTC 禁止)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list-events-expanded", arguments: { range: "today" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		it("range も timeMin/timeMax も無いと isError(どちらか一方は必須)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list-events-expanded", arguments: { timeZone: "UTC" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		it("絶対指定(timeMin/timeMax)は従来どおり動き resolvedRange も載る", async () => {
			await seedEvent("uid-mcp-rr-1", "Absolute Range Event");
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "list-events-expanded",
					arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", calendarId: "calendar" },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent.events).toHaveLength(1);
			const rr = rpc.result.structuredContent.resolvedRange;
			expect(rr.timeMin).toBe("2026-07-01T00:00:00Z");
			expect(rr.timeMax).toBe("2026-08-01T00:00:00Z");
		});

		it("get-freebusy でも range:today が効き resolvedRange を返す", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get-freebusy", arguments: { range: "today", timeZone: "Asia/Tokyo" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const rr = rpc.result.structuredContent.resolvedRange;
			expect(rr.timeMin).toMatch(/T00:00:00\+09:00$/);
			expect(rr.timeMax).toMatch(/T00:00:00\+09:00$/);
			expect(rr.timeZone).toBe("Asia/Tokyo");
		});

		it("get-freebusy で range 指定 timeZone 欠落は isError", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get-freebusy", arguments: { range: "today" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});
	});

	// 2026-07-14: list-calendars/create-calendar(ListCollections/CreateCollection UC を MCP から
	// 露出。DAV MKCALENDAR と同じ UC を別入口から呼ぶ)の e2e。
	describe("list-calendars / create-calendar", () => {
		it("list-calendars: 認証ユーザーのコレクション一覧を返す(components/color を含む)", async () => {
			repos.collections.seed(
				new CalendarCollection({
					id: collectionId("work"),
					owner: OWNER,
					displayName: "Work",
					supportedComponents: ["VEVENT"],
					color: AppleColor.parse("#FF0000"),
				}),
			);
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list-calendars", arguments: {} },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent.calendars).toEqual([
				{ id: "work", displayName: "Work", components: ["VEVENT"], color: "#FF0000" },
			]);
		});

		it("list-calendars: supportedComponents 未設定(全種別受理)は3種を明示展開して返す", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("all"), owner: OWNER, displayName: "All" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list-calendars", arguments: {} },
			});
			const rpc = await jsonRpcResult(res);
			const cal = rpc.result.structuredContent.calendars[0];
			expect(cal.components.sort()).toEqual(["VEVENT", "VJOURNAL", "VTODO"]);
			expect(cal.color).toBeUndefined();
		});

		// 2026-07-14 追記: create-calendar を registerAppTool 化(空のリストカードを出す)したため、
		// structuredContent はカレンダーのメタ情報オブジェクトではなく TodosViewModel 契約
		// ({tasks, calendarId, timeZone})に変わった。カレンダーのメタ情報(displayName/components/
		// color)は content(text)側に引き続き JSON で残るので、そちらで検証する
		// (UI 契約(structuredContent)には calendarId しか要らない — todos-entry.ts が
		// vm.calendarId をヘッダ・quick-add の作成先に使う設計のため)。
		it("create-calendar: id/components を明示指定して作成できる", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-calendar",
					arguments: { id: "personal", displayName: "Personal", components: ["VEVENT"], color: "#00FF00" },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			// structuredContent: 作成直後の空のリストカード(実在確認を兼ねて実際に ListTodos を
			// 通した結果なので tasks は空配列ハードコードではない)。completedSummary は
			// buildTodosViewModel が常に付ける(2026-07-23 症状B対策)ので空でも {total:0,recent:[]} が載る。
			// generatedAt(2026-07-23 SWR 完全形): 応答直前の Date.now() が additive に載るため、
			// 値そのものはテスト実行時刻依存で固定できない。「数値であること」だけ確認し、残りは
			// toEqual の厳密比較から除く(freshness.ts / TodosViewModel.generatedAt JSDoc 参照)。
			expect(typeof rpc.result.structuredContent.generatedAt).toBe("number");
			// uiHash(2026-07-23 カード版不整合の可視化)も配信 HTML から決まる値なので、
			// 固定文字列にはせず「現行版を識別できる非空文字列」である契約だけをここで保証する。
			expect(typeof rpc.result.structuredContent.uiHash).toBe("string");
			expect(rpc.result.structuredContent.uiHash.length).toBeGreaterThan(0);
			const {
				generatedAt: _personalGeneratedAt,
				uiHash: _personalUiHash,
				...personalStructuredContent
			} = rpc.result.structuredContent;
			expect(personalStructuredContent).toEqual({
				tasks: [],
				calendarId: "personal",
				timeZone: "UTC",
				completedSummary: { total: 0, recent: [], byCalendar: {} },
			});
			// content(text)側にカレンダーのメタ情報が残る(従来の応答契約を維持)。
			const textResult = JSON.parse(rpc.result.content[0].text);
			expect(textResult).toEqual({
				id: "personal",
				displayName: "Personal",
				components: ["VEVENT"],
				color: "#00FF00",
			});
			const saved = await repos.collections.findById(OWNER, collectionId("personal"));
			expect(saved?.displayName).toBe("Personal");
		});

		it("create-calendar: id/components 省略時は displayName から slug 生成 + 既定 VTODO", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-calendar", arguments: { displayName: "買い物リスト" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const textResult = JSON.parse(rpc.result.content[0].text);
			expect(textResult.components).toEqual(["VTODO"]);
			// 日本語 displayName は slugifyForCollectionId の許容文字([a-z0-9])に1文字も
			// マッチしないため、生成 id は安定 hash slug フォールバック("list-" + 8桁 hex)になる
			// (2026-07-23 K1: 同じ displayName なら同じ id 候補になるよう randomUUID から変更した。
			// server.ts slugifyForCollectionId コメント参照)。
			expect(textResult.id).toMatch(/^list-[0-9a-f]{8}$/);
			// structuredContent.calendarId は content 側の id(自動生成 slug/UUID)と一致する。
			// completedSummary は常時付与(2026-07-23 症状B対策)。generatedAt は上のテストと同じ理由
			// (SWR 完全形・実行時刻依存)で厳密比較から除く。
			expect(typeof rpc.result.structuredContent.generatedAt).toBe("number");
			// 上の明示 id ケースと同じく、create-calendar が返す初期 todos カードにも
			// 現行 UI 版が載ることを保証しつつ、バンドル変更で変わる hash 値そのものは固定しない。
			expect(typeof rpc.result.structuredContent.uiHash).toBe("string");
			expect(rpc.result.structuredContent.uiHash.length).toBeGreaterThan(0);
			const {
				generatedAt: _slugGeneratedAt,
				uiHash: _slugUiHash,
				...slugStructuredContent
			} = rpc.result.structuredContent;
			expect(slugStructuredContent).toEqual({
				tasks: [],
				calendarId: textResult.id,
				timeZone: "UTC",
				completedSummary: { total: 0, recent: [], byCalendar: {} },
			});
		});

		// 2026-07-23 ユーザー裁定(最終形): id を明示指定した場合の衝突は displayName の一致に
		// 関わらず常に isError(CollectionAlreadyExistsError)。id 明示は「この URL セグメントに
		// 作りたい」という具体的な意図の表明であり、黙って既存を返すと呼び手の意図に反するため
		// (server.ts create-calendar ハンドラの idWasExplicit 分岐コメント参照)。
		it("create-calendar: id を明示指定して既存 id と衝突した場合は isError(displayName が一致していても)", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("dup"), owner: OWNER, displayName: "Dup" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-calendar", arguments: { id: "dup", displayName: "Dup" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		// 2026-07-23 ユーザー裁定(本タスクの主眼・最終形): displayName 単位の重複検出/矯正は撤回。
		// 冪等性は「id 省略時、同じ displayName なら同じ id に安定して解決される」ことだけで実現する。
		// id 省略時の自動生成 id が既存と衝突し、かつ displayName も一致するなら「同一リクエストの
		// 再送」とみなし、新規作成せず既存を成功として返す(真の no-op)。
		describe("id 省略時: 同じ displayName で2回叩いたときの真の冪等(安定 id への収束)", () => {
			it("2回目は isError にならず既存の id をそのまま返す(新規作成されない)", async () => {
				const first = await fetchMcp({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "テストコレクション" } },
				});
				const firstRpc = await jsonRpcResult(first);
				expect(firstRpc.result.isError).toBeFalsy();
				const firstResult = JSON.parse(firstRpc.result.content[0].text);

				const beforeSecond = await repos.collections.findAllByOwner(OWNER);
				const second = await fetchMcp({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "テストコレクション" } },
				});
				const secondRpc = await jsonRpcResult(second);
				expect(secondRpc.result.isError).toBeFalsy();
				const secondResult = JSON.parse(secondRpc.result.content[0].text);
				expect(secondResult.id).toBe(firstResult.id);
				expect(secondRpc.result.content[1].text).toContain("既存のコレクションを返しました");

				// 新規作成されていない(総数不変) — 実害だった「テストコレクションが2件できる」の
				// 再発防止を直接検証する。
				const afterSecond = await repos.collections.findAllByOwner(OWNER);
				expect(afterSecond.length).toBe(beforeSecond.length);
			});

			// 日本語 displayName でも同じ id(安定 hash slug fallback)に解決されることを確認する。
			// K1 の実害(非 ASCII displayName が毎回 randomUUID にフォールバックしていたバグ)が
			// 治っていることの直接的な証跡。
			it("日本語 displayName でも安定 hash slug に解決され、2回目は既存を返す", async () => {
				const first = await fetchMcp({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "読書リスト" } },
				});
				const firstRpc = await jsonRpcResult(first);
				const firstResult = JSON.parse(firstRpc.result.content[0].text);
				expect(firstResult.id).toMatch(/^list-[0-9a-f]{8}$/);

				const second = await fetchMcp({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "読書リスト" } },
				});
				const secondRpc = await jsonRpcResult(second);
				const secondResult = JSON.parse(secondRpc.result.content[0].text);
				expect(secondResult.id).toBe(firstResult.id);
			});

			// 意図的に同名のリストをもう1つ作りたい場合は id を明示すれば作成できる(displayName の
			// 一意性を強制しない、というユーザー裁定を直接検証する)。
			it("同じ displayName でも id を明示指定すれば別コレクションとして新規作成できる", async () => {
				const first = await fetchMcp({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "買い物リスト" } },
				});
				const firstRpc = await jsonRpcResult(first);
				const firstResult = JSON.parse(firstRpc.result.content[0].text);

				const second = await fetchMcp({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "create-calendar",
						arguments: { id: "shopping-2", displayName: "買い物リスト" },
					},
				});
				const secondRpc = await jsonRpcResult(second);
				expect(secondRpc.result.isError).toBeFalsy();
				const secondResult = JSON.parse(secondRpc.result.content[0].text);
				expect(secondResult.id).not.toBe(firstResult.id);
				expect(secondResult.id).toBe("shopping-2");

				const after = await repos.collections.findAllByOwner(OWNER);
				expect(after.filter((c) => c.displayName === "買い物リスト").length).toBe(2);
			});

			// displayName が異なる自動生成 id が偶然衝突した(slug/hash 衝突)場合は、既存を横取り
			// せず接尾辞付きの別 id で新規作成する(同一リクエストの再送ではないため)。
			it("displayName が異なるのに自動生成 id が衝突した場合は接尾辞付きの別 id で新規作成する", async () => {
				// slugifyForCollectionId は ASCII 以外を "-" に畳むため、記号違いの2つの displayName
				// (どちらも [a-z0-9] の位置は同じ)は同じ slug "work" に収束する。
				const first = await fetchMcp({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "Work!!!" } },
				});
				const firstRpc = await jsonRpcResult(first);
				const firstResult = JSON.parse(firstRpc.result.content[0].text);
				expect(firstResult.id).toBe("work");

				const second = await fetchMcp({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "create-calendar", arguments: { displayName: "Work???" } },
				});
				const secondRpc = await jsonRpcResult(second);
				expect(secondRpc.result.isError).toBeFalsy();
				const secondResult = JSON.parse(secondRpc.result.content[0].text);
				expect(secondResult.id).not.toBe("work");
				expect(secondResult.id).toBe("work-2");
				expect(secondResult.displayName).toBe("Work???");

				const after = await repos.collections.findAllByOwner(OWNER);
				expect(after.length).toBe(2);
			});
		});

		it("create-calendar: 不正な color は isError", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-calendar", arguments: { id: "badcolor", displayName: "Bad", color: "not-a-color" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});
	});

	// 2026-07-14: delete-calendar(list-calendars/create-calendar の対。DeleteCollection UC を
	// MCP から露出。検証運用で「作ったリストを消すツールが無く D1 直で消した」ことが動機)の e2e。
	describe("delete-calendar", () => {
		it("空コレクションは force なしで削除できる", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("empty"), owner: OWNER, displayName: "Empty" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "delete-calendar", arguments: { id: "empty", confirmToken: await cardToken() } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent).toEqual({ id: "empty", deleted: true });
			expect(await repos.collections.findById(OWNER, collectionId("empty"))).toBeNull();
		});

		it("中身が1件以上あるコレクションは force なしで拒否される(安全装置)", async () => {
			await seedEvent("uid-mcp-delete-1", "Non-empty guard");
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "delete-calendar", arguments: { id: CALENDAR, confirmToken: await cardToken() } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			expect(rpc.result.content[0].text).toContain("force");
			// 拒否された場合はコレクションが残っていること(誤って消えていないこと)を確認する。
			expect(await repos.collections.findById(OWNER, CALENDAR)).not.toBeNull();
		});

		it("force:true を指定すると中身ごと削除できる", async () => {
			await seedEvent("uid-mcp-delete-2", "Non-empty forced");
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "delete-calendar", arguments: { id: CALENDAR, force: true, confirmToken: await cardToken() } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(await repos.collections.findById(OWNER, CALENDAR)).toBeNull();
		});

		it("存在しない id は入力起因エラー(isError)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "delete-calendar", arguments: { id: "no-such-calendar", confirmToken: await cardToken() } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});
	});

	// 2026-07-23 K2: update-calendar(list-calendars/create-calendar/delete-calendar の対を埋める。
	// UpdateCollectionProperties UC を MCP から露出。DAV PROPPATCH(app.ts)と同じ UC を別入口から呼ぶ)。
	describe("update-calendar", () => {
		it("displayName のみ変更できる", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "work", displayName: "Job" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent).toEqual({
				id: "work",
				displayName: "Job",
				components: ["VEVENT", "VTODO", "VJOURNAL"],
			});
			expect((await repos.collections.findById(OWNER, collectionId("work")))?.displayName).toBe("Job");
		});

		it("color のみ変更できる", async () => {
			repos.collections.seed(
				new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work", color: AppleColor.parse("#111111") }),
			);
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "work", color: "#00FF00" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent).toEqual({
				id: "work",
				displayName: "Work",
				components: ["VEVENT", "VTODO", "VJOURNAL"],
				color: "#00FF00",
			});
		});

		it("displayName/color を両方変更できる", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "work", displayName: "Job", color: "#0000FF" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect(rpc.result.structuredContent).toEqual({
				id: "work",
				displayName: "Job",
				components: ["VEVENT", "VTODO", "VJOURNAL"],
				color: "#0000FF",
			});
		});

		it("不正な color は isError(AppleColor.parse のバリデーション)", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "work", color: "not-a-color" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		it("存在しない calendarId は isError(CollectionNotFoundError)", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "no-such-calendar", displayName: "X" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		it("displayName/color 両方省略は no-op エラー", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("work"), owner: OWNER, displayName: "Work" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "update-calendar", arguments: { id: "work" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			expect(rpc.result.content[0].text).toContain("変更する項目");
		});
	});

	// 2026-07-13 Case E(server.ts のコメント参照): recurrence.frequency:"none" は
	// MCP Inspector の手動フォームが optional な recurrence を触っていなくても
	// `{frequency:""}` を送ってくる不具合を presentation 層で吸収するための正規化。
	// application(CreateTodoRecurrenceInput)には存在しない語彙なので、ここで
	// 「正規化後に正しく無反復/エラーになるか」を確認する(application のテストでは検証できない)。
	describe("create-todo: recurrence.frequency:\"none\" 正規化(Case E)", () => {
		// create-todo の既定保存先は collectionId "tasks"。calendarId を明示しないので
		// fake の collectionRepo に "tasks" コレクションを OWNER 所有で撒いておかないと
		// CollectionNotFoundError で PUT が落ちる(既存 seedEvent は "calendar" 用のため流用不可)。
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}

		it("frequency:\"none\"(サブフィールド無し)は成功し、RRULE を持たない VTODO が作られる", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todo",
					arguments: { title: "非反復", due: "2026-07-15", recurrence: { frequency: "none" } },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			// 2026-07-13 E-2 スライス②: create-todo は { task } ではなく差分レンズ付き確定一覧
			// (TodosViewModel: tasks/calendarId/timeZone/affected)を返すようになった。
			// 2026-07-13 案X: affected[].task に自己完結描画用スナップショットが常に添う。
			expect(rpc.result.structuredContent.tasks).toBeDefined();
			expect(rpc.result.structuredContent.affected).toMatchObject([
				{ id: expect.any(String), kind: "added", task: { title: "非反復" } },
			]);

			// 正規化で recurrence が undefined として application に渡ったことを、保存された
			// 生 ICS に RRULE プロパティが無いことで確認する(task DTO 上の反復有無フィールドより
			// rawIcs を直接見る方が「本当に RRULE を生成しなかった」ことの確実な証拠になる)。
			const saved = await repos.resources.findAllInCollection(OWNER, TASKS);
			expect(saved).toHaveLength(1);
			expect(saved[0].rawIcs).not.toContain("RRULE");
		});

		it("frequency:\"none\" + サブフィールド(count 等)併用は isError", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todo",
					arguments: { title: "矛盾", due: "2026-07-15", recurrence: { frequency: "none", count: 5 } },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});

		// 2026-07-15 strict 化(既知バグの是正): recurrence に誤キー(byDay 等)を渡すと、旧実装は
		// zod が黙って strip し frequency=default("none") のまま非反復で作ってしまった(反復するつもりが
		// 黙って反復しない事故)。.strict() で未知キーを入力エラーへ格上げしたことを検証する。
		it("recurrence に未知キー(byDay 等の誤キー)を渡すと isError(黙殺せず弾く)", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todo",
					// 正しくは weekdays だが誤って byDay を渡す典型ミス。frequency:weekly なのに未知キーで弾かれる。
					arguments: { title: "誤キー", due: "2026-07-18", recurrence: { frequency: "weekly", byDay: ["SA"] } },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			// 黙って非反復 todo が作られていない(strip されて保存された、が起きていない)ことも確認。
			const saved = await repos.resources.findAllInCollection(OWNER, TASKS);
			expect(saved).toHaveLength(0);
		});

		it("frequency:\"weekly\" は従来どおり RRULE を生成する(回帰確認)", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todo",
					arguments: { title: "毎週", due: "2026-07-18", recurrence: { frequency: "weekly", weekdays: ["SA"] } },
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();

			const saved = await repos.resources.findAllInCollection(OWNER, TASKS);
			expect(saved).toHaveLength(1);
			expect(saved[0].rawIcs).toContain("FREQ=WEEKLY");
		});
	});

	// 2026-07-13 E-2 スライス②: mutate 系ツールが「差分レンズ付き確定一覧」(TodosViewModel)を
	// 返すことの presentation テスト。application UC の挙動(D4 等)は application 層のテストで
	// 担保済みなので、ここでは「structuredContent に tasks/affected/removed が contract どおりの
	// 形で載るか」だけを最小に確認する(差分メタの組み立ては server.ts の責務)。
	describe("mutate 系の差分レンズ(affected/removed)", () => {
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}

		// create-todo で1件作り、その id を返すヘルパー(complete/update/delete の前提づくり)。
		async function createTodo(args: Record<string, unknown>): Promise<string> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-todo", arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent.tasks.find((t: { title: string }) => t.title === args.title).id;
		}

		it("create-todo: affected=[{kind:'added'}] + 確定一覧 tasks を返す", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-todo", arguments: { title: "牛乳を買う", due: "2026-07-15" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const sc = rpc.result.structuredContent;
			// K3(2026-07-23): calendarId 省略時は buildTodosViewModel が owner 横断で確定一覧を返す
			// ように意味を変えた(56cbb73 の agenda echo pin 修正と同じ「単一 ID を偽装しない」規律)。
			// create-todo 自体の保存先(CreateTodo UC の既定 "tasks")とは独立の話 — 確定一覧の echo は
			// 「今回の一覧がどんなスコープで組まれたか」を正直に返す。
			expect(sc.calendarId).toBeNull();
			expect(Array.isArray(sc.tasks)).toBe(true);
			expect(sc.affected).toHaveLength(1);
			expect(sc.affected[0].kind).toBe("added");
			// added の id は確定一覧に実在する(UI が突き合わせられる)。
			expect(sc.tasks.some((t: { id: string }) => t.id === sc.affected[0].id)).toBe(true);
			// 2026-07-13 案X: task に自己完結描画用スナップショットが添う(added は tasks に
			// 実在するので UI 側では合成不要だが、契約上の一貫性として常に載る)。
			expect(sc.affected[0].task).toMatchObject({ id: sc.affected[0].id, title: "牛乳を買う" });
			expect(sc.removed).toBeUndefined();
		});

		it("complete-todo: affected=[{kind:'completed'}]。完了タスクは確定一覧(未完了ビュー)から抜ける", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "ゴミ出し", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "complete-todo", arguments: { id } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const sc = rpc.result.structuredContent;
			// 2026-07-13 案X: completed は tasks(未完了ビュー)から抜けるため、UI が becoming-done を
			// 自己完結で描けるよう task にスナップショットが添う(becoming-done の核心の契約)。
			expect(sc.affected).toMatchObject([{ id, kind: "completed", task: { id, title: "ゴミ出し" } }]);
			// 未完了ビューが既定なので、完了した id は tasks から消える(becoming は affected が伝える)。
			expect(sc.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
		});

		it("update-todo(フィールド): affected=[{kind:'edited', changes:[...]}]。before/after は表示用短文", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "書類提出", due: "2026-07-15", priority: 5 });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, due: "2026-07-20", priority: 1 } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const affected = rpc.result.structuredContent.affected;
			expect(affected).toHaveLength(1);
			expect(affected[0].kind).toBe("edited");
			// due は "YYYY-MM-DD"(終日)の表示用短文、priority は iOS 段階語("中"→"高")。
			expect(affected[0].changes).toEqual(
				expect.arrayContaining([
					{ field: "due", before: "2026-07-15", after: "2026-07-20" },
					{ field: "priority", before: "中", after: "高" },
				]),
			);
			// 2026-07-13 案X: edited でも task に自己完結描画用スナップショットが添う
			// (tasks に実在するので UI 側の合成には使わないが、契約上の一貫性)。
			expect(affected[0].task).toMatchObject({ id, title: "書類提出" });
		});

		// 2026-07-14 MCP レイテンシ改善: update の before は UpdateTodo UC が返す更新前スナップショット
		// (以前は presentation が findTaskById で別途 ListTodos 全件を読んでいた)。UC 由来の before が
		// changes.before に正しく反映される(=更新前の値が保存されている)ことを title で固定する。
		// due/priority を検証する上のテストと合わせ、「UC の before 起点で edited の before/after が
		// 正しく組まれる」ことの回帰ガードにする。
		it("update-todo(title): changes.before は UC が返す更新前 title(旧 findTaskById 廃止後も before が正しい)", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "旧タイトル", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, title: "新タイトル" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const affected = rpc.result.structuredContent.affected;
			expect(affected).toHaveLength(1);
			expect(affected[0].kind).toBe("edited");
			// before は更新前("旧タイトル")、after は更新後("新タイトル")。before が UC 由来で
			// 正しく取れていないとここが空/新値になって落ちる(before 経路の回帰ガードの核心)。
			expect(affected[0].changes).toEqual([{ field: "title", before: "旧タイトル", after: "新タイトル" }]);
			// 確定一覧側にも新タイトルで実在する。
			expect(rpc.result.structuredContent.tasks.some((t: { id: string; title: string }) => t.id === id && t.title === "新タイトル")).toBe(true);
		});

		it("update-todo(status:COMPLETED): affected=[{kind:'completed'}](edited と併記しない)", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "支払い", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, status: "COMPLETED" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			// 2026-07-13 案X: status:COMPLETED も completed 同様、task にスナップショットが添う。
			expect(rpc.result.structuredContent.affected).toMatchObject([{ id, kind: "completed", task: { id, title: "支払い" } }]);
		});

		// V6 フォローアップ(2026-07-14): update-todo が create-todo と対称に(時刻付き due / due:null 除去)。
		it("update-todo(時刻付き due): timeZone 付きで時刻付きに変更でき、確定 task の isAllDay=false", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "会議", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 20,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, due: "2026-07-20T14:30:00", timeZone: "Asia/Tokyo" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const task = rpc.result.structuredContent.tasks.find((t: { id: string }) => t.id === id);
			expect(task.isAllDay).toBe(false);
			expect(task.due).toBe("2026-07-20T14:30:00+09:00");
		});

		it("update-todo(due:null): 期日を外すと確定 task の due が null になる", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "期日付き", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 21,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, due: null } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const task = rpc.result.structuredContent.tasks.find((t: { id: string }) => t.id === id);
			expect(task.due).toBeNull();
			// affected は edited(due を渡している = 変更フィールドに含まれる)。
			expect(rpc.result.structuredContent.affected[0].kind).toBe("edited");
		});

		it("update-todo(時刻付き due・timeZone 無し): isError で DueTimeZoneRequiredError のメッセージ", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "tz無し", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 22,
				method: "tools/call",
				params: { name: "update-todo", arguments: { id, due: "2026-07-20T14:30:00" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			expect(rpc.result.content[0].text).toContain("timeZone");
		});

		it("delete-todo: removed=[TaskSnapshot](削除直前に読んだ表示情報)+ affected は付かない", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "返却する本", due: "2026-07-15" });
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "delete-todo", arguments: { id, confirmToken: await cardToken() } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const sc = rpc.result.structuredContent;
			// 2026-07-13 案X: removed は affected[].task と同じ TaskSnapshot に統一され、
			// isAllDay 等のフィールドが増えたため toEqual ではなく toMatchObject で緩める。
			expect(sc.removed).toMatchObject([{ id, title: "返却する本", due: "2026-07-15" }]);
			expect(sc.affected).toBeUndefined();
			// 確定一覧からも消えている。
			expect(sc.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
		});
	});

	// 2026-07-14: create-todos(複数件バッチ追加ツール)。1呼び出し=1カード仕様のホスト UI に
	// 対して「5冊追加して」のような複数件依頼で create-todo が N 回呼ばれ N 枚のカードが積まれる
	// 語彙の穴を塞ぐ。ここでは「N 件全成功」「途中失敗の部分成功(ロールバックしない)」
	// 「items の件数上限(1〜25)を外れた入力は zod スキーマレベルで弾かれる」を最小に確認する。
	describe("create-todos(複数件バッチ追加)", () => {
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}

		it("3件とも成功: affected に3件の kind:'added'、確定一覧 tasks にも3件とも実在する", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todos",
					arguments: {
						items: [{ title: "牛乳" }, { title: "卵" }, { title: "パン" }],
					},
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const sc = rpc.result.structuredContent;
			// K3: create-todos も calendarId 省略なので確定一覧は owner 横断(null echo)。上の
			// create-todo 単発テストと同じ理由(56cbb73 の規律をそのまま踏襲)。
			expect(sc.calendarId).toBeNull();
			expect(sc.affected).toHaveLength(3);
			expect(sc.affected.map((a: { kind: string }) => a.kind)).toEqual(["added", "added", "added"]);
			const titles = sc.affected.map((a: { task: { title: string } }) => a.task.title).sort();
			expect(titles).toEqual(["パン", "卵", "牛乳"]);
			// 確定一覧にも3件とも実在する(affected の id と突き合わせられる)。
			for (const a of sc.affected) {
				expect(sc.tasks.some((t: { id: string }) => t.id === a.id)).toBe(true);
			}
			// content(text)側にも成功件数のサマリが載る(部分成功を隠さない仕様の全成功ケース)。
			expect(rpc.result.content[0].text).toContain("3/3 件のリマインダーを作成しました。");
		});

		it("途中失敗の部分成功: 不正な due を持つ item だけ失敗し、他は作成される(ロールバックしない)", async () => {
			seedTasksCollection();
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create-todos",
					arguments: {
						items: [
							{ title: "有効1" },
							// offset 付き ISO8601 は due として不正(InvalidDueError)。
							{ title: "不正な期日", due: "2026-07-15T10:00:00+09:00" },
							{ title: "有効2" },
						],
					},
				},
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			const sc = rpc.result.structuredContent;
			// 成功2件分だけ affected/tasks に載る(失敗した1件はどちらにも出ない)。
			expect(sc.affected).toHaveLength(2);
			const titles = sc.affected.map((a: { task: { title: string } }) => a.task.title).sort();
			expect(titles).toEqual(["有効1", "有効2"]);
			expect(sc.tasks.some((t: { title: string }) => t.title === "不正な期日")).toBe(false);
			// text 側に成功2件・失敗タイトルと理由が明記される。
			const text = rpc.result.content[0].text as string;
			expect(text).toContain("2/3 件のリマインダーを作成しました。");
			expect(text).toContain("失敗した項目:");
			expect(text).toContain("不正な期日");
		});

		// 【isError:true(JSON-RPC error ではない)になる理由】zod スキーマ違反は SDK 内部の
		// validateToolInput が McpError(InvalidParams)を投げるが、この SDK バージョンは
		// tools/call ハンドラの catch でそれを CallToolResult(content+isError:true)に変換して
		// 返す実装になっている(mcp.js の catch ブロック参照。実測で確認済み — rpc.error では
		// なく rpc.result.isError に出る)。よって他の入力エラー(toolError 経由)と同じ形で
		// 検証する。
		it("items 空配列は入力エラー(zod min(1))", async () => {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-todos", arguments: { items: [] } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			expect(rpc.result.content[0].text).toContain("create-todos");
		});

		it("items 26件は入力エラー(zod max(25))", async () => {
			const items = Array.from({ length: 26 }, (_, i) => ({ title: `item-${i}` }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-todos", arguments: { items } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
			expect(rpc.result.content[0].text).toContain("create-todos");
		});
	});

	// 2026-07-14 E-2 view 状態非保持バグ修正: list-todos/refresh-todos が「この一覧はどのビューか」を
	// vm.view として echo し、refresh-todos が list-todos と同じ listTodosInputShape を受け取ることの
	// presentation テスト。症状は「list-todos includeCompleted:true で開いた後 reopen すると完了済みが
	// UI から全部消える」で、根因は refresh-todos が引数なし(既定=未完了のみ)固定だった点。
	// ここでは「view 引数が確定一覧と view echo に正しく反映されるか」「既定呼び出しでは view キーが
	// 付かない(後方互換)か」をサーバー契約として固定する。
	describe("view 状態非保持バグ修正(view echo / refresh-todos の引数引き継ぎ)", () => {
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}
		async function createTodo(args: Record<string, unknown>): Promise<string> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-todo", arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent.tasks.find((t: { title: string }) => t.title === args.title).id;
		}
		async function completeTodo(id: string, calendarId?: string): Promise<void> {
			const args: Record<string, unknown> = calendarId !== undefined ? { id, calendarId } : { id };
			const res = await fetchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "complete-todo", arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
		}
		async function call(name: string, args: Record<string, unknown>): Promise<any> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent;
		}

		it("refresh-todos includeCompleted:true は完了済みを含む tasks + view echo を返す", async () => {
			seedTasksCollection();
			const activeId = await createTodo({ title: "未完了タスク", due: "2026-07-15" });
			const doneId = await createTodo({ title: "完了タスク", due: "2026-07-16" });
			await completeTodo(doneId);

			const sc = await call("refresh-todos", { includeCompleted: true });
			// 完了済み(doneId)も未完了(activeId)も両方 tasks に含まれる(これが直っていなかった核心)。
			expect(sc.tasks.some((t: { id: string }) => t.id === activeId)).toBe(true);
			expect(sc.tasks.some((t: { id: string }) => t.id === doneId)).toBe(true);
			// view echo: includeCompleted:true が返る(UI が currentView として保持する値)。
			expect(sc.view).toEqual({ includeCompleted: true });
		});

		it("list-todos は指定した view 引数(includeCompleted/dueBefore/dueAfter)を echo する", async () => {
			seedTasksCollection();
			const sc = await call("list-todos", {
				includeCompleted: true,
				dueBefore: "2026-08-01T00:00:00Z",
				dueAfter: "2026-07-01T00:00:00Z",
			});
			expect(sc.view).toEqual({
				includeCompleted: true,
				dueBefore: "2026-08-01T00:00:00Z",
				dueAfter: "2026-07-01T00:00:00Z",
			});
		});

		it("既定呼び出し(引数なし)では view キー自体が付かない(後方互換)", async () => {
			seedTasksCollection();
			const listSc = await call("list-todos", {});
			expect("view" in listSc).toBe(false);
			const refreshSc = await call("refresh-todos", {});
			expect("view" in refreshSc).toBe(false);
		});

		it("includeCompleted:false を明示すると view.includeCompleted:false を echo する(既定省略との区別)", async () => {
			// 【なぜこのケースを固定するか】buildTodosViewModel は「非 undefined の引数」を echo する。
			// includeCompleted:false は「明示的な false」なので echo される(引数なし=undefined で
			// view キーごと省くのとは別物)。UI が明示 false を保持しても既定と同じ挙動になるが、
			// サーバー契約としては「渡した非 undefined 値をそのまま返す」を守ることを固定する。
			seedTasksCollection();
			const sc = await call("refresh-todos", { includeCompleted: false });
			expect(sc.view).toEqual({ includeCompleted: false });
		});

		it("mutate 系(complete-todo)の応答には view キーが付かない(既定ビュー固定=仕様3)", async () => {
			seedTasksCollection();
			const id = await createTodo({ title: "支払い", due: "2026-07-15" });
			const res = await fetchMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "complete-todo", arguments: { id } } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			expect("view" in rpc.result.structuredContent).toBe(false);
		});

		// 2026-07-23 症状B再発対策(コーディネーター指摘): completedSummary は「どんな view の push
		// でも不変」がここでの治療原則。当初の実装は buildTodosViewModel が ListTodos を
		// dueBefore/dueAfter 込みで1回読んでいたため、due 窓を指定した list-todos 呼び出しの
		// completedSummary.total が due 窓で痩せる再発があった(list-todos.ts の
		// filterTasksByWindow JSDoc に経緯を集約)。ここでは「完了済みタスクの due が due 窓の
		// 外にあっても、completedSummary.total は due 窓の有無に関係なく同じ値になる」ことを固定する。
		it("completedSummary は dueBefore/dueAfter を指定した list-todos でも痩せない(症状B再発対策)", async () => {
			seedTasksCollection();
			// due 窓(2026-08-01 未満)の外側に due を持つ完了済みタスクを作る — この行が due 窓
			// フィルタで tasks から漏れても、completedSummary.total には数えられるべき。
			const outsideWindowDoneId = await createTodo({ title: "窓外の完了タスク", due: "2026-12-31" });
			await completeTodo(outsideWindowDoneId);
			// due 窓の内側に due を持つ未完了タスクも1件混ぜ、tasks 側の絞り込み自体は生きていることを
			// 併せて確認する(due フィルタそのものを壊していないことの回帰防止)。
			await createTodo({ title: "窓内の未完了タスク", due: "2026-07-20" });

			// due 窓なし(既定)での completedSummary.total を基準値にする。
			const baseline = await call("list-todos", { includeCompleted: true });
			expect(baseline.completedSummary.total).toBeGreaterThanOrEqual(1);

			// due 窓付き(窓外の完了タスクの due 2026-12-31 を弾く範囲)で呼んでも、
			// completedSummary.total は基準値と同じでなければならない(due 窓で痩せない)。
			const windowed = await call("list-todos", {
				includeCompleted: true,
				dueBefore: "2026-08-01T00:00:00Z",
				dueAfter: "2026-07-01T00:00:00Z",
			});
			expect(windowed.completedSummary.total).toBe(baseline.completedSummary.total);
			// tasks 側の due 窓フィルタ自体は生きている(窓外の完了タスクは tasks から漏れる)ことも
			// 併せて確認する — completedSummary だけを別チャンネルにした設計が「tasks の due フィルタを
			// 壊さず completedSummary だけ不変にする」という要求どおりであることの回帰防止。
			expect(windowed.tasks.some((t: { id: string }) => t.id === outsideWindowDoneId)).toBe(false);
		});

		// K3 直後の追加修正(コーディネーター指摘): completedSummary は due 窓だけでなく calendarId
		// スコープからも独立でなければならない(症状Bの治療原則の拡張。todos-view-model.ts の
		// completedSummary JSDoc 参照)。K3 で todos カードは常に owner 横断取得だが、モデル発の
		// list-todos/create-todo 等は calendarId を明示指定して呼べる(単一コレクション scoped)。
		// この push がカードへ届いたとき total が「owner 全体」と「単一コレクションだけ」の間で
		// 揺れないことを固定する。
		it("completedSummary は calendarId を明示指定した list-todos でも owner 全体の値のまま揺れない(K3 後の症状B再発対策)", async () => {
			const READING_LIST = collectionId("reading-list");
			seedTasksCollection();
			repos.collections.seed(
				new CalendarCollection({ id: READING_LIST, owner: OWNER, displayName: "Reading List", supportedComponents: ["VTODO"] }),
			);
			// "tasks" に完了済み1件、"reading-list" にも完了済み1件(別コレクションの完了済みが
			// 単一 scoped 応答で数え漏れないことも併せて確認する)。
			const tasksDoneId = await createTodo({ title: "牛乳を買う", calendarId: "tasks" });
			await completeTodo(tasksDoneId);
			const readingDoneId = await createTodo({ title: "本を返す", calendarId: "reading-list" });
			await completeTodo(readingDoneId, "reading-list");

			// calendarId 省略(owner 横断)での completedSummary.total を基準値にする。
			const crossScope = await call("list-todos", { includeCompleted: true });
			expect(crossScope.completedSummary.total).toBeGreaterThanOrEqual(2);

			// calendarId を "tasks" に明示指定した単一コレクション scoped 呼び出しでも、
			// completedSummary.total は owner 横断の基準値と同じでなければならない(揺れない)。
			const tasksScoped = await call("list-todos", { includeCompleted: true, calendarId: "tasks" });
			expect(tasksScoped.completedSummary.total).toBe(crossScope.completedSummary.total);

			// "reading-list" に明示指定した場合も同様(どちらの単一コレクションを指定しても
			// completedSummary は owner 全体のまま=不変条件)。
			const readingScoped = await call("list-todos", { includeCompleted: true, calendarId: "reading-list" });
			expect(readingScoped.completedSummary.total).toBe(crossScope.completedSummary.total);

			// tasks 側のコレクション絞り自体は生きている(reading-list の完了済みは "tasks" scoped の
			// tasks には出てこない)ことも併せて確認する — completedSummary だけを別チャンネルにした
			// 設計が「tasks の calendarId 絞りを壊さず completedSummary だけ不変にする」という
			// 要求どおりであることの回帰防止。
			expect(tasksScoped.tasks.some((t: { id: string }) => t.id === readingDoneId)).toBe(false);
			expect(readingScoped.tasks.some((t: { id: string }) => t.id === tasksDoneId)).toBe(false);
		});
	});

	// K3(2026-07-23): todos カードのリスト切替「初回に全 VTODO コレクション横断取得 → 切替は
	// クライアント側フィルタ」向けのサーバー契約テスト。旧 D 案(otherTodoCollections)は
	// calendarId 省略時も単一コレクション("tasks")しか見せず「他にもある」ことを構造化
	// フィールドで伝えるだけの部分対策だったが、K3 は calendarId 省略を「本当に owner 配下の
	// 全 VTODO コレクションを1クエリで横断する」よう変えた(list-todos.ts の ListTodosInput
	// JSDoc・server.ts の resolveOtherTodoCollections 撤去コメント参照)。
	describe("list-todos: calendarId 省略時の owner 横断(K3)", () => {
		const TASKS = collectionId("tasks");
		const READING_LIST = collectionId("reading-list");
		async function call(name: string, args: Record<string, unknown>): Promise<any> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent;
		}
		function seedTwoLists(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(
				new CalendarCollection({ id: READING_LIST, owner: OWNER, displayName: "Reading List", supportedComponents: ["VTODO"] }),
			);
		}

		it("calendarId 省略 + 複数 VTODO コレクションがあるとき、両方の task が calendarId 付きで1応答に混ざる", async () => {
			seedTwoLists();
			await call("create-todo", { title: "牛乳を買う", calendarId: "tasks" });
			await call("create-todo", { title: "本を返す", calendarId: "reading-list" });

			const sc = await call("list-todos", {});
			// 横断応答は架空の単一 ID を echo しない(56cbb73 の agenda echo pin 規律と同じ)。
			expect(sc.calendarId).toBeNull();
			const byId = new Map(sc.tasks.map((t: { title: string; calendarId?: string }) => [t.title, t.calendarId]));
			expect(byId.get("牛乳を買う")).toBe("tasks");
			expect(byId.get("本を返す")).toBe("reading-list");
		});

		it("calendarId を明示指定すると、そのコレクションだけを返し calendarId をそのまま echo する(単一照会は互換のまま)", async () => {
			seedTwoLists();
			await call("create-todo", { title: "牛乳を買う", calendarId: "tasks" });
			await call("create-todo", { title: "本を返す", calendarId: "reading-list" });

			const sc = await call("list-todos", { calendarId: "tasks" });
			expect(sc.calendarId).toBe("tasks");
			expect(sc.tasks.map((t: { title: string }) => t.title)).toEqual(["牛乳を買う"]);
		});

		it("calendarId 省略 + VTODO コレクションが tasks 1件だけでも横断応答(calendarId:null)になる", async () => {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar", supportedComponents: ["VEVENT"] }));
			const sc = await call("list-todos", {});
			expect(sc.calendarId).toBeNull();
		});

		// 2026-07-23(#47) センチネル統一: calendarId:"all" は「省略」と同じ横断表示を意味する入力語彙
		// (ListTodosInput.calendarId JSDoc)だが、**echo** はどちらも null に揃える。以前は
		// opts.calendarId ?? null がそのまま "all" を素通ししていたため、UI(todos-entry.ts)側の
		// rawIncomingCalendarId==="all" → ALL_CALENDARS_ID 正規化コードに依存していた。ここでは
		// サーバー側の契約そのものを固定し、入力の受理語彙("all")は変えないことも合わせて確認する。
		it('calendarId:"all" を明示指定しても横断応答になり、calendarId echo は null(省略と同じ)', async () => {
			seedTwoLists();
			await call("create-todo", { title: "牛乳を買う", calendarId: "tasks" });
			await call("create-todo", { title: "本を返す", calendarId: "reading-list" });

			const sc = await call("list-todos", { calendarId: "all" });
			expect(sc.calendarId).toBeNull();
			const byId = new Map(sc.tasks.map((t: { title: string; calendarId?: string }) => [t.title, t.calendarId]));
			expect(byId.get("牛乳を買う")).toBe("tasks");
			expect(byId.get("本を返す")).toBe("reading-list");
		});
	});

	// =============================================================================
	// E-3 スライス S1: event 系ツール(create/create-events/update/delete-event)の presentation テスト。
	// application UC の挙動は event-usecases.test.ts が担保済みなので、ここでは structuredContent が
	// EventsViewModel 契約(events/calendarId/timeZone/affected/removed/range)どおりに載るかを最小に確認する。
	// =============================================================================
	describe("event 系ツールの EventsViewModel", () => {
		function seedCalendarCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }));
		}
		async function callEvent(name: string, args: Record<string, unknown>): Promise<any> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent;
		}

		it("create-event: events + affected(added)を返し range は名乗らない(mutate 判別シグナル)", async () => {
			seedCalendarCollection();
			const sc = await callEvent("create-event", { title: "会議", start: "2026-07-15T10:00:00", end: "2026-07-15T11:00:00", timeZone: "Asia/Tokyo" });
			expect(sc.events).toHaveLength(1);
			// Event DTO(id/title)+ legacy 別名(uid/summary)が additive に載る。
			expect(sc.events[0].id).toBe(sc.affected[0].id);
			expect(sc.events[0].uid).toBe(sc.events[0].id);
			expect(sc.events[0].title).toBe("会議");
			expect(sc.events[0].summary).toBe("会議");
			expect(sc.events[0].start).toBe("2026-07-15T10:00:00+09:00");
			expect(sc.affected).toMatchObject([{ kind: "added", event: { title: "会議" } }]);
			expect("range" in sc).toBe(false);
		});

		it("create-event: URL(URI 値型)が Event.url に載りエスケープされない", async () => {
			seedCalendarCollection();
			const sc = await callEvent("create-event", { title: "リンク付き", start: "2026-07-15", url: "https://example.com/x?a=1&b=2" });
			expect(sc.events[0].url).toBe("https://example.com/x?a=1&b=2");
		});

		it("create-events: 複数件を1応答にまとめ affected に N 件の added を積む", async () => {
			seedCalendarCollection();
			const sc = await callEvent("create-events", { items: [{ title: "A", start: "2026-07-15" }, { title: "B", start: "2026-07-16" }] });
			expect(sc.affected).toHaveLength(2);
			expect(sc.events).toHaveLength(2);
		});

		it("list-events-expanded: range を echo し events は Event DTO(id/title)+ legacy(uid/summary)", async () => {
			await seedEvent("uid-agenda-1", "予定X");
			const sc = await callEvent("list-events-expanded", { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", calendarId: "calendar" });
			expect(sc.range).toEqual({ from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" });
			expect(sc.calendarId).toBe("calendar");
			expect(sc.events[0].id).toBe("uid-agenda-1");
			expect(sc.events[0].uid).toBe("uid-agenda-1");
			expect(sc.events[0].title).toBe("予定X");
			expect(sc.events[0].summary).toBe("予定X");
			// 非反復イベントの recurrenceId は null(旧「常に ISO」から §3 契約へ変更)。
			expect(sc.events[0].recurrenceId).toBeNull();
		});

		it("update-event: affected=edited + changes(start/location は provided フィールドとして載る)", async () => {
			seedCalendarCollection();
			const created = await callEvent("create-event", { title: "旧", start: "2026-07-15", location: "旧地" });
			const id = created.events[0].id;
			const sc = await callEvent("update-event", { id, title: "新", location: "新地" });
			expect(sc.affected[0].kind).toBe("edited");
			const fields = sc.affected[0].changes.map((c: { field: string }) => c.field).sort();
			expect(fields).toEqual(["location", "title"]);
			expect(sc.events[0].title).toBe("新");
		});

		it("delete-event: events 空 + removed(ghost)を返す", async () => {
			seedCalendarCollection();
			const created = await callEvent("create-event", { title: "消す", start: "2026-07-15" });
			const id = created.events[0].id;
			const sc = await callEvent("delete-event", { id, confirmToken: await cardToken() });
			expect(sc.events).toHaveLength(0);
			expect(sc.removed).toMatchObject([{ title: "消す" }]);
		});

		it("create-event: end <= start は isError", async () => {
			seedCalendarCollection();
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-event", arguments: { title: "逆転", start: "2026-07-18", end: "2026-07-15" } } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
		});
	});

	// =============================================================================
	// R1(docs/modeling/15 §A): delete-* のサーバー側 confirmToken 強制を撤去した後の契約
	// =============================================================================
	// 【意図の反転(旧 S1 からの契約変更)】旧テストは「トークン無しの delete-* は拒否される」
	// 「別対象向けトークンの流用は拒否される」ことを固定していたが、R1(docs/modeling/15 §A)で
	// サーバー側のトークン強制そのものを撤去した(確認プロンプトの提示はホスト責務・§A-1)。
	// 新契約はその裏返し: delete-* はトークンの有無・中身に関わらず常に成功する
	// (confirmToken は受け取っても無視する後方互換フィールド)。
	// 何を保証するか(What):
	//   - トークン無しの delete-todo は成功する(旧: 拒否されていた)。
	//   - 任意の confirmToken 文字列(中身が何であれ)を添えても delete-todo は成功する
	//     (検証自体が無くなったのでトークンの中身は一切見ない)。
	// 2026-07-23(#47): propose-delete-todo/-event/-calendar は撤去済み(確認 UI はホスト責務へ移行
	// 済みで確認カードの入口が不要になった。撤去理由は server.ts の撤去コメント参照)。以下のテストは
	// propose-delete-todo が発行するトークンで確認していた「トークンの中身を見ない」契約を、
	// getCardToken(todos/agenda カードの swipe 削除が使う免除トークン発行)由来のトークンで代替する
	// (cardToken() ヘルパーは describe ブロック外の共通ヘルパー。update-event 系テストの
	// confirmToken: await cardToken() と同じ道具)。
	describe("R1(delete-* の confirmToken 強制撤去)", () => {
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}
		/** create-todo を1件作り、その VTODO の id(affected[0].id)を返す。 */
		async function createTodo(title: string): Promise<string> {
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-todo", arguments: { title } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent.affected[0].id as string;
		}

		it("トークン無しの delete-todo は成功する(R1: サーバー側強制を撤去)", async () => {
			seedTasksCollection();
			const id = await createTodo("消される予定のもの");
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "delete-todo", arguments: { id } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			// 実際に消えている(確認要否の判断はホストに委ね、サーバーはブロックしない)。
			const stillThere = await repos.resources.findUriByUid(OWNER, TASKS, id);
			expect(stillThere).toBeNull();
		});

		it("別対象向け(実体は無関係)のカードトークンを添えても delete-todo は成功する(R1: 中身を検証しない)", async () => {
			seedTasksCollection();
			const idA = await createTodo("A");
			const idB = await createTodo("B");
			// カード発の免除トークン(getCardToken 由来。対象を特定しない汎用トークン)を取得する。
			const tokenForCard = await cardToken();
			// A ではなく B を消す → confirmToken の中身(対象特定情報)は元々持たないトークンだが、
			// R1 以降 confirmToken は無視されるのでどのみち成功する。
			const delRes = await fetchMcp({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "delete-todo", arguments: { id: idB, confirmToken: tokenForCard } },
			});
			const delRpc = await jsonRpcResult(delRes);
			expect(delRpc.result.isError).toBeFalsy();
			// B は消えている。A は無関係なので残る。
			expect(await repos.resources.findUriByUid(OWNER, TASKS, idB)).toBeNull();
			expect(await repos.resources.findUriByUid(OWNER, TASKS, idA)).not.toBeNull();
		});
	});

	// ②(2026-07-24)削除/復元/ゴミ箱のカード化。list-deleted/restore-deleted の view model 契約を固定する。
	// 【What】(1) list-deleted 応答は todos カードを紐付け(_meta.ui)、structuredContent に deletedItems を
	// ゴミ箱ビューとして載せる。(2) content(モデル向けテキスト)には URI を素で晒さない。(3) restore-deleted は
	// 復元後の通常 todos vm(affected に復元行=added)を返し、deletedItems は載せない。
	describe("② 削除/復元/ゴミ箱のカード化(list-deleted / restore-deleted)", () => {
		const TASKS = collectionId("tasks");
		function seedTasksCollection(): void {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
		}
		async function createTodo(title: string): Promise<string> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-todo", arguments: { title } } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent.affected[0].id as string;
		}
		async function deleteTodo(id: string): Promise<void> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete-todo", arguments: { id } } });
			expect((await jsonRpcResult(res)).result.isError).toBeFalsy();
		}
		async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
			return (await jsonRpcResult(res)).result;
		}

		it("list-deleted は todos カードを紐付け、structuredContent.deletedItems にゴミ箱ビューを載せる", async () => {
			seedTasksCollection();
			const id = await createTodo("捨てるもの");
			await deleteTodo(id);

			const result = await callTool("list-deleted", {});
			expect(result.isError).toBeFalsy();
			// deletedItems: uri(復元キー)・calendarId・title(summary)・deletedAtMillis を持つ1行。
			const items = result.structuredContent.deletedItems;
			expect(items).toHaveLength(1);
			expect(items[0].calendarId).toBe("tasks");
			expect(items[0].title).toBe("捨てるもの");
			expect(typeof items[0].uri).toBe("string");
			expect(typeof items[0].deletedAtMillis).toBe("number");
			// 下敷きの通常一覧も一緒に返す(deletedItems だけの vm でカードの tasks キャッシュを空にしないため)。
			expect(Array.isArray(result.structuredContent.tasks)).toBe(true);
		});

		it("list-deleted の content(モデル向けテキスト)には URI を素で晒さない", async () => {
			seedTasksCollection();
			const id = await createTodo("URI を晒さない");
			await deleteTodo(id);

			const result = await callTool("list-deleted", {});
			const uri = result.structuredContent.deletedItems[0].uri as string;
			const contentText = result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
			// 実機で「URI: a4de4fc2-….ics」がユーザーに見えた症状の回帰防止 — content には uri が出ない。
			expect(contentText).not.toContain(uri);
			// 代わりに人間可読の要約(タイトル)が出る。
			expect(contentText).toContain("URI を晒さない");
		});

		it("restore-deleted は復元後の通常 todos vm(affected=added)を返し deletedItems は載せない", async () => {
			seedTasksCollection();
			const id = await createTodo("戻すもの");
			await deleteTodo(id);
			const uri = (await callTool("list-deleted", {})).structuredContent.deletedItems[0].uri as string;

			const result = await callTool("restore-deleted", { uri, calendarId: "tasks" });
			expect(result.isError).toBeFalsy();
			// 通常 todos vm: 復元行が affected に "added" として載る(どれが戻ったか分かる)。
			const sc = result.structuredContent;
			expect(sc.affected.some((a: { id: string; kind: string }) => a.id === id && a.kind === "added")).toBe(true);
			// 確定一覧 tasks にも復元行が生存で現れる。
			expect(sc.tasks.some((t: { id: string }) => t.id === id)).toBe(true);
			// ゴミ箱ビューは載せない(このツールはゴミ箱ページを開く合図を出さない)。
			expect("deletedItems" in sc).toBe(false);
		});
	});

	// ①(2026-07-24)completedSummary のコレクション別内訳。list-todos 応答の byCalendar 契約を固定する
	// (計算そのものの純関数テストは mcp-todos-diff.test.ts。ここは server 応答に byCalendar が載ることの固定)。
	describe("① completedSummary.byCalendar(コレクション別内訳の echo)", () => {
		function seedTwoLists(): void {
			repos.collections.seed(new CalendarCollection({ id: collectionId("tasks"), owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(new CalendarCollection({ id: collectionId("reading"), owner: OWNER, displayName: "Reading" }));
		}
		async function createTodoIn(title: string, calendarId: string): Promise<string> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-todo", arguments: { title, calendarId } } });
			return (await jsonRpcResult(res)).result.structuredContent.affected[0].id as string;
		}
		async function completeTodo(id: string, calendarId: string): Promise<void> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "complete-todo", arguments: { id, calendarId } } });
			expect((await jsonRpcResult(res)).result.isError).toBeFalsy();
		}

		it("owner 横断の list-todos は byCalendar にコレクション別の完了件数を載せる", async () => {
			seedTwoLists();
			const t1 = await createTodoIn("tasks の完了", "tasks");
			await completeTodo(t1, "tasks");
			const r1 = await createTodoIn("reading の完了", "reading");
			await completeTodo(r1, "reading");

			const res = await fetchMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list-todos", arguments: { includeCompleted: true } } });
			const sc = (await jsonRpcResult(res)).result.structuredContent;
			// total は owner 全体(2件)、byCalendar はリスト別内訳。
			expect(sc.completedSummary.total).toBe(2);
			expect(sc.completedSummary.byCalendar).toEqual({ tasks: 1, reading: 1 });
			// recent の各要素に由来 calendarId が載る(カードの単一リストフィルタ用)。
			expect(sc.completedSummary.recent.every((r: { calendarId?: string }) => typeof r.calendarId === "string")).toBe(true);
		});
	});
});

// 観測基盤 v1: TelemetryPort.record() が例外を投げても tool call 自体は成功すること
// (fire-and-forget 契約 — application/ports/telemetry.ts の TelemetryPort コメント参照)。
// 独自の throwing TelemetryPort を注入した createMcpApp インスタンスで確認する
// (上の describe("/mcp") の beforeEach とは独立させ、他テストへ影響しない専用アプリにする)。
describe("観測基盤 v1: telemetry 失敗が tool call を壊さない", () => {
	it("TelemetryPort.record が同期的に throw しても tool call は成功する", async () => {
		const collections = new FakeCalendarCollectionRepository();
		const resources = new FakeCalendarObjectResourceRepository();
		const uow = new FakeCollectionUnitOfWork(resources, collections);
		const throwingTelemetry = {
			record: () => {
				throw new Error("telemetry backend unavailable (simulated)");
			},
		};
		const app = new Hono<{ Bindings: CloudflareBindings }>().route(
			"/mcp",
			createMcpApp(() => ({
				auth: new StaticBearerAuth({ mcpToken: MCP_TOKEN, username: USERNAME }),
				collectionRepo: collections,
				resourceRepo: resources,
				iterator: recurrenceIterator,
				uow,
				confirmSecret: CONFIRM_SECRET,
				telemetry: throwingTelemetry,
				geocoding: { searchLocation: async () => [] },
			})),
		);
		const res = await app.fetch(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${MCP_TOKEN}`,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "get-current-time", arguments: {} },
				}),
			}),
			ENV,
		);
		const rpc = await jsonRpcResult(res);
		expect(rpc.result.isError).toBeFalsy();
	});
});

// =============================================================================
// #45 場所モデル: search-location(geocoding)ツール
// =============================================================================
// 汎用ハーネス(先頭 beforeEach)は空候補スタブを注入しているので、ここは専用 createMcpApp に
// 制御可能なフェイク GeocodingPort を差し込み、①候補写像 ②空クエリの早期エラー(quota 非消費)
// ③quota 超過の人間可読メッセージ ④キー未設定の縮退メッセージ を固定する。
describe("search-location(geocoding)", () => {
	// フェイク GeocodingPort: searchLocation の挙動を差し替え可能にする(候補返却/例外送出)。
	let behavior: (query: string) => Promise<import("../../src/application/ports").LocationCandidate[]>;
	let callCount = 0;
	// 計測イベントを捕捉して errKind を検証する(要件 #3: quota 超過を observability で区別できる)。
	let capturedEvents: import("../../src/application/ports").TelemetryEvent[] = [];
	function buildApp() {
		const collections = new FakeCalendarCollectionRepository();
		const resources = new FakeCalendarObjectResourceRepository();
		const uow = new FakeCollectionUnitOfWork(resources, collections);
		return new Hono<{ Bindings: CloudflareBindings }>().route(
			"/mcp",
			createMcpApp(() => ({
				auth: new StaticBearerAuth({ mcpToken: MCP_TOKEN, username: USERNAME }),
				collectionRepo: collections,
				resourceRepo: resources,
				iterator: recurrenceIterator,
				uow,
				confirmSecret: CONFIRM_SECRET,
				telemetry: { record: (e) => capturedEvents.push(e) },
				geocoding: {
					searchLocation: async (query: string) => {
						callCount++;
						return behavior(query);
					},
				},
			})),
		);
	}

	async function callSearch(app: ReturnType<typeof buildApp>, query: unknown): Promise<any> {
		const res = await app.fetch(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_TOKEN}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search-location", arguments: { query } } }),
			}),
			ENV,
		);
		return jsonRpcResult(res);
	}

	it("候補を structuredContent.candidates(title/address/geo)に載せる", async () => {
		callCount = 0;
		behavior = async () => [
			{ title: "東京駅", address: "東京都千代田区丸の内1丁目9", geo: { lat: 35.681, lon: 139.767 } },
		];
		const rpc = await callSearch(buildApp(), "東京駅");
		expect(rpc.result.isError).toBeFalsy();
		expect(rpc.result.structuredContent.candidates).toEqual([
			{ title: "東京駅", address: "東京都千代田区丸の内1丁目9", geo: { lat: 35.681, lon: 139.767 } },
		]);
		expect(callCount).toBe(1);
	});

	it("空白のみの query は geocoding を呼ばずに早期エラー(quota 非消費)", async () => {
		callCount = 0;
		behavior = async () => [];
		const rpc = await callSearch(buildApp(), "   ");
		expect(rpc.result.isError).toBe(true);
		expect(callCount).toBe(0); // searchLocation に到達しない = quota を消費しない。
	});

	it("quota 超過は住所のみ登録できる旨の人間可読メッセージ + telemetry errKind で区別できる(500 で落とさない)", async () => {
		const { GeocodingQuotaExceededError } = await import("../../src/application/ports");
		behavior = async () => {
			throw new GeocodingQuotaExceededError("2026-07", 1000);
		};
		capturedEvents = [];
		const rpc = await callSearch(buildApp(), "東京駅");
		expect(rpc.result.isError).toBe(true);
		expect(rpc.result.content[0].text).toContain("枠を使い切りました");
		// 要件 #3: errKind に quota 超過を区別できる値が載る("ToolError" 一律ではない)。
		const ev = capturedEvents.find((e) => e.mcpTool === "search-location");
		expect(ev?.ok).toBe(false);
		expect(ev?.errKind).toBe("GeocodingQuotaExceededError");
	});

	it("キー未設定は管理者への設定依頼メッセージに縮退する", async () => {
		const { GeocodingNotConfiguredError } = await import("../../src/application/ports");
		behavior = async () => {
			throw new GeocodingNotConfiguredError();
		};
		const rpc = await callSearch(buildApp(), "東京駅");
		expect(rpc.result.isError).toBe(true);
		expect(rpc.result.content[0].text).toContain("GOOGLE_MAPS_API_KEY");
	});
});

// =============================================================================
// #locationAutoResolve: create-event/create-events/update-event のサーバー側自動ジオコーディング
// =============================================================================
// 実機で確定した問題(claude.ai iOS(Haiku 4.5)が search-location を呼ばず create-event
// {location:"..."} を直に呼び、地図に出ないイベントができた事故)の対策。ここでは:
//   ① 明示的に structuredLocation を渡した場合は自動解決を試みない(上書きしない)
//   ② location だけを渡した場合、known-locations 優先 → geocoding フォールバックの順で解決する
//   ③ どちらも解決できなくても create-event 自体は失敗しない(best-effort)
//   ④ update-event は location 文字列が変わらない限り再解決しない(quota 節約)
// を search-location と同じ流儀(フェイク GeocodingPort + callCount)で固定する。
describe("location 自動解決(#locationAutoResolve)", () => {
	let behavior: (query: string) => Promise<import("../../src/application/ports").LocationCandidate[]>;
	let callCount = 0;

	function buildApp() {
		const collections = new FakeCalendarCollectionRepository();
		const resources = new FakeCalendarObjectResourceRepository();
		const uow = new FakeCollectionUnitOfWork(resources, collections);
		// create-event/create-events/update-event が書き込む既定コレクション("calendar")を
		// 事前に用意する(event 系ツールテストの seedCalendarCollection と同じ最小セット)。
		collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }));
		return new Hono<{ Bindings: CloudflareBindings }>().route(
			"/mcp",
			createMcpApp(() => ({
				auth: new StaticBearerAuth({ mcpToken: MCP_TOKEN, username: USERNAME }),
				collectionRepo: collections,
				resourceRepo: resources,
				iterator: recurrenceIterator,
				uow,
				confirmSecret: CONFIRM_SECRET,
				telemetry: new NoopTelemetryAdapter(),
				geocoding: {
					searchLocation: async (query: string) => {
						callCount++;
						return behavior(query);
					},
				},
			})),
		);
	}

	async function callTool(app: ReturnType<typeof buildApp>, name: string, args: Record<string, unknown>): Promise<any> {
		const res = await app.fetch(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_TOKEN}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			}),
			ENV,
		);
		return jsonRpcResult(res);
	}

	beforeEach(() => {
		callCount = 0;
		behavior = async () => [];
	});

	it("known-locations に部分一致があれば geocoding を呼ばずそちらを採用する", async () => {
		const app = buildApp();
		// 既知の場所を仕込む: structuredLocation を明示した create-event(要件① の経路そのもの)。
		const seed = await callTool(app, "create-event", {
			title: "既存の予定",
			start: "2026-07-20T10:00:00",
			timeZone: "Asia/Tokyo",
			structuredLocation: { title: "叙々苑", address: "東京都港区高輪3-13-1", lat: 35.63, lon: 139.74 },
		});
		expect(seed.result.isError).toBeFalsy();

		// geocoding が呼ばれたら known-locations とは違う候補を返すよう仕込む(採用元を区別するため)。
		behavior = async () => [{ title: "別の店", address: null, geo: { lat: 0, lon: 0 } }];

		const rpc = await callTool(app, "create-event", {
			title: "品川で会食",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
			location: "品川のホテルの叙々苑",
		});
		expect(rpc.result.isError).toBeFalsy();
		const vm = JSON.parse(rpc.result.content[0].text);
		expect(vm.events[0].structuredLocation).toMatchObject({ title: "叙々苑", geo: { lat: 35.63, lon: 139.74 } });
		expect(callCount).toBe(0); // known-locations だけで解決できたので geocoding には到達しない。
		expect(rpc.result.content[1].text).toContain("叙々苑");
	});

	it("known-locations に一致が無ければ geocoding の先頭候補を採用する", async () => {
		const app = buildApp();
		behavior = async () => [
			{ title: "東京タワー", address: "東京都港区芝公園4-2-8", geo: { lat: 35.6586, lon: 139.7454 } },
			{ title: "別候補", address: null, geo: { lat: 1, lon: 1 } },
		];
		const rpc = await callTool(app, "create-event", {
			title: "展望台",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
			location: "東京タワー",
		});
		expect(rpc.result.isError).toBeFalsy();
		const vm = JSON.parse(rpc.result.content[0].text);
		expect(vm.events[0].structuredLocation).toMatchObject({ title: "東京タワー", geo: { lat: 35.6586, lon: 139.7454 } });
		expect(callCount).toBe(1);
		expect(rpc.result.content[1].text).toContain("東京タワー");
	});

	it("known-locations も geocoding も解決できなくても create-event 自体は失敗しない(best-effort)", async () => {
		const app = buildApp();
		behavior = async () => []; // 0件
		const rpc = await callTool(app, "create-event", {
			title: "謎の場所で",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
			location: "どこか知らない場所",
		});
		expect(rpc.result.isError).toBeFalsy();
		const vm = JSON.parse(rpc.result.content[0].text);
		expect(vm.events[0].structuredLocation).toBeNull();
		expect(vm.events[0].location).toBe("どこか知らない場所"); // テキストのみで登録される。
		expect(rpc.result.content[1].text).toContain("テキストのみで登録");
	});

	it("geocoding が例外を投げても(quota 超過等)create-event は失敗しない(握りつぶす)", async () => {
		const { GeocodingQuotaExceededError } = await import("../../src/application/ports");
		const app = buildApp();
		behavior = async () => {
			throw new GeocodingQuotaExceededError("2026-07", 1000);
		};
		const rpc = await callTool(app, "create-event", {
			title: "枠切れ",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
			location: "枠切れの場所",
		});
		expect(rpc.result.isError).toBeFalsy();
		const vm = JSON.parse(rpc.result.content[0].text);
		expect(vm.events[0].structuredLocation).toBeNull();
	});

	it("structuredLocation を明示指定した場合は自動解決を試みない(上書きしない)", async () => {
		const app = buildApp();
		const rpc = await callTool(app, "create-event", {
			title: "明示指定",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
			location: "これはテキストのみのはず",
			structuredLocation: { title: "指定した場所", lat: 10, lon: 20 },
		});
		expect(rpc.result.isError).toBeFalsy();
		const vm = JSON.parse(rpc.result.content[0].text);
		expect(vm.events[0].structuredLocation).toMatchObject({ title: "指定した場所", geo: { lat: 10, lon: 20 } });
		expect(callCount).toBe(0); // geocoding は呼ばれない。
		// 自動解決の note は付かない(content は JSON のみ)。
		expect(rpc.result.content.length).toBe(1);
	});

	it("location が無ければ自動解決を試みない(従来どおり)", async () => {
		const app = buildApp();
		const rpc = await callTool(app, "create-event", {
			title: "場所無し",
			start: "2026-07-21T19:00:00",
			timeZone: "Asia/Tokyo",
		});
		expect(rpc.result.isError).toBeFalsy();
		expect(callCount).toBe(0);
		expect(rpc.result.content.length).toBe(1);
	});

	describe("update-event: location 文字列が変わらない場合は再解決しない", () => {
		it("同じ location 文字列での update は geocoding を呼ばない", async () => {
			const app = buildApp();
			behavior = async () => [{ title: "初回解決", address: null, geo: { lat: 1, lon: 1 } }];
			const created = await callTool(app, "create-event", {
				title: "予定",
				start: "2026-07-21T19:00:00",
				timeZone: "Asia/Tokyo",
				location: "同じ場所",
			});
			expect(created.result.isError).toBeFalsy();
			expect(callCount).toBe(1);
			const id = JSON.parse(created.result.content[0].text).events[0].id;

			// 【現在の LOCATION は "同じ場所" ではなく "初回解決" になっている点に注意】structuredLocation.title は
			// LOCATION 表示テキストを上書きする(vevent-write.ts の author 規約・structuredLocationInputSchema
			// describe 参照)ので、自動解決が起きた VEVENT の LOCATION は解決後の title に置き換わっている。
			// 「location 文字列が変わらない」の比較対象は create-event に渡した生テキストではなく「現在の
			// LOCATION」なので、再解決させずに済ませたい2回目の update はこの値をそのまま渡す(UI が現在の
			// LOCATION 表示を読み取って無変更のまま送り返すケースに対応する自然な比較)。
			behavior = async () => [{ title: "2回目の候補", address: null, geo: { lat: 2, lon: 2 } }];
			const updated = await callTool(app, "update-event", {
				id,
				title: "予定(改題)",
				location: "初回解決", // 現在の LOCATION(= 前回解決の title)と同じ値を渡す = 未変更。
			});
			expect(updated.result.isError).toBeFalsy();
			expect(callCount).toBe(1); // 再解決していない = geocoding 呼び出しは増えない。
			const vm = JSON.parse(updated.result.content[0].text);
			expect(vm.events[0].structuredLocation).toMatchObject({ title: "初回解決" }); // 前回の解決結果のまま。
		});

		it("location 文字列を変えた update は再解決する", async () => {
			const app = buildApp();
			behavior = async () => [{ title: "初回解決", address: null, geo: { lat: 1, lon: 1 } }];
			const created = await callTool(app, "create-event", {
				title: "予定",
				start: "2026-07-21T19:00:00",
				timeZone: "Asia/Tokyo",
				location: "元の場所",
			});
			expect(created.result.isError).toBeFalsy();
			expect(callCount).toBe(1);
			const id = JSON.parse(created.result.content[0].text).events[0].id;

			behavior = async () => [{ title: "新しい候補", address: null, geo: { lat: 3, lon: 3 } }];
			const updated = await callTool(app, "update-event", {
				id,
				location: "新しい場所",
			});
			expect(updated.result.isError).toBeFalsy();
			expect(callCount).toBe(2); // location が変わったので再解決した。
			const vm = JSON.parse(updated.result.content[0].text);
			expect(vm.events[0].structuredLocation).toMatchObject({ title: "新しい候補" });
		});
	});
});
