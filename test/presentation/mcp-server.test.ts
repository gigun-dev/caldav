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
import { StaticBearerAuth, IcaljsRRuleIterator } from "../../src/infrastructure";
import { AppleColor, CalendarCollection, CalendarObjectResource, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
} from "../application/fakes";

const USERNAME = "test";
const MCP_TOKEN = "mcp-secret-token";
const OWNER = principalPath(`/dav/principals/${USERNAME}/`);
const CALENDAR = collectionId("calendar");

const ENV = {
	DB: {} as unknown,
	CALDAV_USERNAME: USERNAME,
	CALDAV_PASSWORD: "secret",
	PROXY_SHARED_SECRET: "",
	MCP_TOKEN,
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
	it("正しい Bearer で tools/list に20ツールが並ぶ(C5 list-known-locations 追加分)", async () => {
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
			"get-current-time",
			"get-freebusy",
			"list-calendars",
			"list-events-expanded",
			"list-known-locations",
			"list-todos",
			"move-todo",
			"refresh-events",
			"refresh-todos",
			"update-event",
			"update-todo",
		]);
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
			// 通した結果なので tasks は空配列ハードコードではない)。
			expect(rpc.result.structuredContent).toEqual({ tasks: [], calendarId: "personal", timeZone: "UTC" });
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
			// マッチしないため、生成 id は crypto.randomUUID() フォールバック(UUID 形式)になる。
			expect(textResult.id).toMatch(/^[0-9a-f-]{36}$/);
			// structuredContent.calendarId は content 側の id(自動生成 slug/UUID)と一致する。
			expect(rpc.result.structuredContent).toEqual({ tasks: [], calendarId: textResult.id, timeZone: "UTC" });
		});

		it("create-calendar: 既存 id との衝突は isError(CollectionAlreadyExistsError)", async () => {
			repos.collections.seed(new CalendarCollection({ id: collectionId("dup"), owner: OWNER, displayName: "Dup" }));
			const res = await fetchMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-calendar", arguments: { id: "dup", displayName: "Dup2" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
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
				params: { name: "delete-calendar", arguments: { id: "empty" } },
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
				params: { name: "delete-calendar", arguments: { id: CALENDAR } },
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
				params: { name: "delete-calendar", arguments: { id: CALENDAR, force: true } },
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
				params: { name: "delete-calendar", arguments: { id: "no-such-calendar" } },
			});
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBe(true);
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
			expect(sc.calendarId).toBe("tasks");
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
				params: { name: "delete-todo", arguments: { id } },
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
			expect(sc.calendarId).toBe("tasks");
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
		async function completeTodo(id: string): Promise<void> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "complete-todo", arguments: { id } } });
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
	});

	// 2026-07-16 silent drop 対策(D 案): calendarId 省略の list-todos が「tasks 以外にも VTODO
	// コレクションがある」ことを otherTodoCollections で構造化的に伝えるかのサーバー契約テスト。
	// 【背景】実アカウントに tasks/reading-list のように VTODO コレクションが複数あるとき、
	// モデルが calendarId 省略で「これで全部」と誤認して reading-list を静かに取りこぼす事故が
	// あった。VTODO 判定は list-calendars と同じ accepts("VTODO") 基準(CalendarCollection の
	// 既存ドメインヘルパー)を使う。
	describe("list-todos: otherTodoCollections(calendarId 省略時の silent drop 対策)", () => {
		const TASKS = collectionId("tasks");
		const READING_LIST = collectionId("reading-list");
		async function call(name: string, args: Record<string, unknown>): Promise<any> {
			const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
			const rpc = await jsonRpcResult(res);
			expect(rpc.result.isError).toBeFalsy();
			return rpc.result.structuredContent;
		}

		it("calendarId 省略 + 複数 VTODO コレクションがあるとき otherTodoCollections が載る", async () => {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(
				new CalendarCollection({ id: READING_LIST, owner: OWNER, displayName: "Reading List", supportedComponents: ["VTODO"] }),
			);
			const sc = await call("list-todos", {});
			expect(sc.otherTodoCollections).toEqual([{ id: "reading-list", displayName: "Reading List" }]);
		});

		it("calendarId を明示指定すると otherTodoCollections は載らない(スコープ明示済み)", async () => {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(
				new CalendarCollection({ id: READING_LIST, owner: OWNER, displayName: "Reading List", supportedComponents: ["VTODO"] }),
			);
			const sc = await call("list-todos", { calendarId: "tasks" });
			expect("otherTodoCollections" in sc).toBe(false);
		});

		it("VTODO コレクションが tasks 1件だけなら otherTodoCollections は載らない", async () => {
			repos.collections.seed(new CalendarCollection({ id: TASKS, owner: OWNER, displayName: "Tasks" }));
			repos.collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar", supportedComponents: ["VEVENT"] }));
			const sc = await call("list-todos", {});
			expect("otherTodoCollections" in sc).toBe(false);
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
			const sc = await callEvent("delete-event", { id });
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

});
