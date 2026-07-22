// =============================================================================
// mcp-api-wiring — src/index.ts の本番配線を provider 抜きで exercise するテスト
// =============================================================================
// 2026-07-12 OAuth-for-MCP 第2スライス・物理分離リファクタ SHOULD-1: 今回の分離で
// mcpApiApp と resolveExternalTokenForMcp が src/app.ts の named export になり、
// @cloudflare/workers-oauth-provider を一切 import せずに単体テストできるようになった。
//
// これまでの mcp-server.test.ts は「createMcpApp を直接組んだテスト専用サブアプリ +
// StaticBearerAuth」を叩いており、MCP ツールの振る舞いは検証できるが「本番の
// src/index.ts が実際に組んでいる配線(mcpApiApp・OAuthPropsAuth・
// resolveExternalTokenForMcp)」そのものは exercise していなかった。
// このファイルはその隙間を埋める:
//   1. resolveExternalTokenForMcp 自体のユニットテスト(MCP_TOKEN 照合ロジック)。
//   2. mcpApiApp.fetch に ctx.props を手で注入し、本番で OAuthProvider が
//      ExecutionContext.props に検証済み principal を載せてから apiHandler(=
//      mcpApiApp)を呼ぶ、という経路を provider 抜きで再現する(OAuthPropsAuth が
//      その props を読んで principal を解決できることを確認する)。
// provider 自体(トークン発行・KV・authorize フロー)はここではテストしない —
// あくまで「index.ts が組んでいる mcpApiApp/props 配線」の健全性の確認。
// =============================================================================

import { beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionContext } from "hono";
import { mcpApiApp, resolveExternalTokenForMcp, __setRepositoriesFactoryForTest } from "../../src/app";
import { CalendarCollection, CalendarObjectResource, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
} from "../application/fakes";

const USERNAME = "admin";
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

// =============================================================================
// resolveExternalTokenForMcp: MCP_TOKEN との照合ロジックの単体テスト
// =============================================================================
describe("resolveExternalTokenForMcp", () => {
	it("正しい MCP_TOKEN なら { props: { username, scopes: 両scope } } を返す(R-6: 静的 Bearer=full access)", async () => {
		// R-6: 静的 Bearer は管理者自身のトークンなので full access(両 scope)を props に載せる。
		// これにより oauth-props-auth の grandfather 警告(旧 grant 用)には該当せず、write ツールも通る。
		const result = await resolveExternalTokenForMcp({ token: MCP_TOKEN, env: ENV });
		expect(result).toEqual({ props: { username: USERNAME, scopes: ["claudedav:read", "claudedav:write"] } });
	});

	it("不一致トークンは null", async () => {
		const result = await resolveExternalTokenForMcp({ token: "wrong-token", env: ENV });
		expect(result).toBeNull();
	});

	it("env.MCP_TOKEN が空文字なら、どんなトークンでも常に null(空ガード)", async () => {
		// 「秘密鍵が空文字で誰でも通る」事故を避けるガード(src/app.ts のコメント参照)。
		// トークン側を空文字にして「両方空なら一致してしまう」誤りを踏んでいないことも確認する。
		const emptyTokenEnv = { ...ENV, MCP_TOKEN: "" } as unknown as CloudflareBindings;
		expect(await resolveExternalTokenForMcp({ token: MCP_TOKEN, env: emptyTokenEnv })).toBeNull();
		expect(await resolveExternalTokenForMcp({ token: "", env: emptyTokenEnv })).toBeNull();
	});
});

// =============================================================================
// mcpApiApp: 本番の provider→ctx.props→OAuthPropsAuth 経路を provider 抜きで再現
// =============================================================================
describe("mcpApiApp(ctx.props 注入)", () => {
	let repos: {
		principals: FakePrincipalRepository;
		collections: FakeCalendarCollectionRepository;
		resources: FakeCalendarObjectResourceRepository;
		uow: FakeCollectionUnitOfWork;
	};
	let restoreFactory: () => void;

	beforeEach(() => {
		const principals = new FakePrincipalRepository();
		const collections = new FakeCalendarCollectionRepository();
		const resources = new FakeCalendarObjectResourceRepository();
		const uow = new FakeCollectionUnitOfWork(resources, collections);
		repos = { principals, collections, resources, uow };
		// src/app.ts の mcpApiApp は internal な repositoriesFactory(モジュールスコープの
		// let)を経由してリポジトリを取るため、DAV 側テストと同じ __setRepositoriesFactoryForTest
		// で差し替える(bun test には D1/workerd が無い)。
		restoreFactory = __setRepositoriesFactoryForTest(() => repos);
	});

	// provider が本番で ExecutionContext に載せる形を模した最小限のダミー。実際の
	// @cloudflare/workers-types の ExecutionContext は tracing 等も持つが、mcpApiApp 側の
	// 局所キャスト(unknown 経由の narrow)は props フィールドしか見ないため、
	// waitUntil/passThroughOnException だけ生やしたダミーで十分再現できる。
	function fakeExecutionContextWithProps(props: { username?: string; scopes?: readonly string[] } | undefined) {
		return {
			props,
			waitUntil() {},
			passThroughOnException() {},
		} as unknown as ExecutionContext;
	}

	// R-6: props に scopes を注入して write ツール(create-todo)を叩くヘルパ。
	// scopes を undefined にすれば旧 grant(grandfather)経路も再現できる — 本番の
	// OAuthProvider を介さず OAuthPropsAuth → server の read/write 強制まで一気通貫で exercise する。
	async function callCreateTodo(scopes: readonly string[] | undefined) {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create-todo", arguments: { title: "R-6 scope test", calendarId: "tasks" } },
			}),
		});
		const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME, scopes }));
		expect(res.status).toBe(200); // scope 拒否は JSON-RPC の isError であって HTTP 401 ではない。
		const text = await res.text();
		const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
		return JSON.parse(dataLine !== undefined ? dataLine.slice("data: ".length) : text) as {
			result?: { isError?: boolean; content?: Array<{ text?: string }> };
		};
	}

	it("ctx.props に正しい username があれば OAuthPropsAuth 経由で principal が解決され tools/list が通る", async () => {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				// OAuthPropsAuth は authorization ヘッダを読まない(provider が既に検証済みという
				// 前提のアダプタ。src/infrastructure/auth/oauth-props-auth.ts のコメント参照)ので
				// ここでは付けない — props 注入だけで principal が解決されることの確認が狙い。
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME }));
		expect(res.status).toBe(200);
		const text = await res.text();
		const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
		const rpc = JSON.parse(dataLine !== undefined ? dataLine.slice("data: ".length) : text);
		const names = rpc.result.tools.map((t: { name: string }) => t.name).sort();
		// 2026-07-13 E-2 スライス②: refresh-todos(UI 専用 app ツール)を追加。
		// visibility:["app"] でも tools/list には出る(mcp-server.test.ts の同種コメント参照)。
		// 2026-07-14: list-calendars / create-calendar(コレクション操作の MCP 露出)を追加。
		// 2026-07-14 追記: delete-calendar(list-calendars/create-calendar の対)を追加。
		// 2026-07-14 追記2: create-todos(複数件バッチ追加ツール)を追加。
		// 2026-07-15 追記: move-todo(VTODO のコレクション間移動)を追加。
		// 2026-07-15 E-3 S1/S2 追記: create/update/delete-event + refresh-events(アジェンダ app ツール)を追加。
		// 2026-07-18 C5 追記: list-known-locations(既知の場所ツール・設計 05)を追加。
		// 2026-07-22 S1 追記: propose-delete-todo/event/calendar(確認カードの入り口・docs/modeling/14)を追加。
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
			"propose-delete-calendar",
			"propose-delete-event",
			"propose-delete-todo",
			"refresh-events",
			"refresh-todos",
			"update-event",
			"update-todo",
		]);
	});

	it("ctx.props 無し(provider 未検証相当)は 401(OAuthPropsAuth の防御フォールバック)", async () => {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps(undefined));
		expect(res.status).toBe(401);
	});

	it("tools/call(get-freebusy)まで通り、FakeRepositories 経由でイベントを拾える", async () => {
		repos.collections.seed(new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }));
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			"UID:uid-wiring-1",
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260715T100000Z",
			"DTEND:20260715T110000Z",
			"SUMMARY:Wiring Test Event",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const resource = await CalendarObjectResource.fromIcs(resourceUri("uid-wiring-1.ics"), ics);
		repos.resources.seed(OWNER, CALENDAR, resource);

		const req = new Request("https://example.com/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "get-freebusy",
					arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", calendarId: "calendar" },
				},
			}),
		});
		const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME }));
		expect(res.status).toBe(200);
		const text = await res.text();
		const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
		const rpc = JSON.parse(dataLine !== undefined ? dataLine.slice("data: ".length) : text);
		expect(rpc.result.isError).toBeFalsy();
		expect(rpc.result.structuredContent.busy).toHaveLength(1);
	});

	// --- R-6: ツール別 read/write scope 強制(本番の OAuthPropsAuth → server 経路を exercise)-----
	describe("R-6 scope 強制", () => {
		beforeEach(() => {
			// create-todo の保存先 "tasks" を用意しておく(scope を通過した後に UC まで到達して
			// 成功することを確認するため。scope 拒否ケースはここへ到達せず弾かれる)。
			repos.collections.seed(new CalendarCollection({ id: collectionId("tasks"), owner: OWNER, displayName: "Tasks" }));
		});

		it("read-only scope(claudedav:read のみ)では write ツール(create-todo)が明示 isError で拒否される", async () => {
			const rpc = await callCreateTodo(["claudedav:read"]);
			expect(rpc.result?.isError).toBe(true);
			// 文言に「読み取り専用」「再接続」を含む(server.ts の toolError メッセージ)。
			expect(rpc.result?.content?.[0]?.text).toContain("読み取り専用");
			expect(rpc.result?.content?.[0]?.text).toContain("再接続");
		});

		it("read-only scope でも read ツール(get-freebusy)は成功する", async () => {
			const req = new Request("https://example.com/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "get-freebusy", arguments: { timeMin: "2026-07-01T00:00:00Z", timeMax: "2026-08-01T00:00:00Z", calendarId: "tasks" } },
				}),
			});
			const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME, scopes: ["claudedav:read"] }));
			expect(res.status).toBe(200);
			const text = await res.text();
			const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
			const rpc = JSON.parse(dataLine !== undefined ? dataLine.slice("data: ".length) : text);
			expect(rpc.result.isError).toBeFalsy();
		});

		it("両 scope(claudedav:read + claudedav:write)では write ツール(create-todo)が成功する", async () => {
			const rpc = await callCreateTodo(["claudedav:read", "claudedav:write"]);
			expect(rpc.result?.isError).toBeFalsy();
		});

		it("旧 grant(props に scopes 無し)は grandfather で write ツールが成功する(現運用を壊さない)", async () => {
			// scopes:undefined = 旧 grant / grandfather。OAuthPropsAuth が undefined を素通しし、
			// server の allowsWrite(undefined) が true を返すため write が通る(再接続まで従来どおり動く)。
			const rpc = await callCreateTodo(undefined);
			expect(rpc.result?.isError).toBeFalsy();
		});
	});

	// --- S2: エンドポイント URL の版管理(2026-07-17 キャッシュバスティング)-----------------
	// `/mcp/:version` は「意味を持たない純粋なキャッシュバスト用パスセグメント」(server.ts の
	// createMcpApp コメント参照)。ここでは実際に `/mcp/v2` 経由でも `/mcp` と同じ最新サーバーの
	// 応答が返ることだけを検証する(バージョン文字列そのものへの分岐が無いことの間接的な保証)。
	describe("/mcp/:version(S2 版管理エンドポイント)", () => {
		it("/mcp/v2 でも initialize が通る", async () => {
			const req = new Request("https://example.com/mcp/v2", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
				}),
			});
			const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME }));
			expect(res.status).toBe(200);
		});

		it("/mcp/v2 の tools/list は /mcp(旧 URL)と同じツール一覧を返す", async () => {
			async function toolNames(path: string) {
				const req = new Request(`https://example.com${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
				});
				const res = await mcpApiApp.fetch(req, ENV, fakeExecutionContextWithProps({ username: USERNAME }));
				expect(res.status).toBe(200);
				const text = await res.text();
				const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
				const rpc = JSON.parse(dataLine !== undefined ? dataLine.slice("data: ".length) : text);
				return (rpc.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
			}
			expect(await toolNames("/mcp/v2")).toEqual(await toolNames("/mcp"));
		});
	});
});
