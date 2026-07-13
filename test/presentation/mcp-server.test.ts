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
import { CalendarCollection, CalendarObjectResource, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";
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
	// ホスト(claude.ai/iOS)側の描画時フィルタとして効く。よって本テストは 9 本を assert する。
	it("正しい Bearer で tools/list に9ツールが並ぶ(E-2 スライス②で refresh-todos を追加。visibility:[\"app\"] でも tools/list には出る)", async () => {
		const res = await fetchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(res.status).toBe(200);
		const rpc = await jsonRpcResult(res);
		const names = rpc.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual([
			"complete-todo",
			"create-todo",
			"delete-todo",
			"get-current-time",
			"get-freebusy",
			"list-events-expanded",
			"list-todos",
			"refresh-todos",
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
});
