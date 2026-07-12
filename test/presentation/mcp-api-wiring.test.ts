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
	it("正しい MCP_TOKEN なら { props: { username } } を返す", async () => {
		const result = await resolveExternalTokenForMcp({ token: MCP_TOKEN, env: ENV });
		expect(result).toEqual({ props: { username: USERNAME } });
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
	function fakeExecutionContextWithProps(props: { username?: string } | undefined) {
		return {
			props,
			waitUntil() {},
			passThroughOnException() {},
		} as unknown as ExecutionContext;
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
		expect(names).toEqual([
			"complete-todo",
			"create-todo",
			"delete-todo",
			"get-current-time",
			"get-freebusy",
			"list-events-expanded",
			"list-todos",
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
});
