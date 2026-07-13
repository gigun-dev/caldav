// =============================================================================
// test/worker/todo-e2e.test.ts — E-1 スライス①(create-todo/list-todos)の E2E テスト。
// =============================================================================
//
// 【なぜ workerd レーンか】
// oauth-e2e.test.ts と同じ理由(冒頭コメント参照)。static Bearer(MCP_TOKEN)経路で
// /mcp を叩く一本に絞る(OAuth フロー自体は oauth-e2e.test.ts が既に検証済みで、
// このテストの関心は「create-todo → list-todos が実 D1 上で一気通貫に動くこと」)。
//
// 【tasks コレクションの provisioning】
// ProvisionDefaultCollections は DAV の discovery PROPFIND(app.ts の isDiscoveryPropfind)
// でしか走らない(MCP 経路は素通り — app.ts コメント参照)。よってこのテストでは先に
// Basic 認証で PROPFIND "/" を1回叩いて "tasks" コレクションを作らせてから、MCP の
// create-todo/list-todos を呼ぶ(実運用でも iOS の初回探索が同じ役割を果たす)。
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_DUMMY_SECRETS } from "./test-secrets";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

async function callWorker(request: Request): Promise<Response> {
	return exports.default.fetch(request, env, ctx);
}

/** SSE(text/event-stream)/単発 JSON のどちらでも JSON-RPC 応答を取り出す(oauth-e2e.test.ts と同じ実装)。 */
async function parseJsonRpcResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();
	if (!contentType.includes("text/event-stream")) return JSON.parse(body);
	const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
	if (!dataLine) throw new Error(`SSE response had no data line: ${body}`);
	return JSON.parse(dataLine.slice("data: ".length));
}

interface JsonRpcToolCallResult {
	result?: {
		structuredContent?: unknown;
		isError?: boolean;
		content?: Array<{ type: string; text: string }>;
	};
}

async function callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcToolCallResult> {
	const response = await callWorker(
		new Request("https://example.com/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TEST_DUMMY_SECRETS.MCP_TOKEN}`,
				"Content-Type": "application/json",
				// StreamableHTTPTransport は両方の Accept を要求する(oauth-e2e.test.ts と同じ実測)。
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		}),
	);
	expect(response.status).toBe(200);
	return (await parseJsonRpcResponse(response)) as JsonRpcToolCallResult;
}

describe("todo E2E(E-1 スライス①: create-todo → list-todos)", () => {
	beforeAll(async () => {
		// "admin" は wrangler.jsonc の CALDAV_USERNAME(vars)。CALDAV_PASSWORD は
		// TEST_DUMMY_SECRETS(vitest.config.ts の miniflare.bindings で注入済み)。
		// discovery PROPFIND(Depth 不問。app.ts の isDiscoveryPropfind は entryPaths に "/" を
		// 含む)を1回叩くと principal + デフォルトコレクション("calendar"/"tasks")が
		// 冪等に作られる(provision-default-collections.ts)。
		const auth = `Basic ${btoa(`admin:${TEST_DUMMY_SECRETS.CALDAV_PASSWORD}`)}`;
		const response = await callWorker(
			new Request("https://example.com/", {
				method: "PROPFIND",
				headers: { Authorization: auth, Depth: "0" },
			}),
		);
		expect(response.status).toBe(207);
	});

	it("create-todo で VTODO を作成できる(due あり・priority あり)", async () => {
		const rpc = await callTool("create-todo", {
			title: "牛乳を買う",
			notes: "低脂肪で",
			due: "2026-07-20",
			priority: 1,
		});
		expect(rpc.result?.isError).not.toBe(true);
		// 2026-07-13 E-2 スライス②: create-todo は { task } ではなく差分レンズ付き確定一覧
		// (TodosViewModel: tasks/calendarId/timeZone/affected)を返す。作成した1件は tasks に
		// 実在し、affected に added として載る(id は tasks 側と一致)。
		// 2026-07-13 案X: affected[].task に自己完結描画用スナップショットが添うため、
		// 型を広げて task?.id も検証する(UI が tasks を見ずに描ける、の契約確認)。
		const structured = rpc.result?.structuredContent as {
			tasks?: Array<{ id: string; title?: string; due?: string; isAllDay?: boolean; priority?: number }>;
			affected?: Array<{ id: string; kind: string; task?: { id: string; title: string } }>;
		};
		const created = structured.tasks?.find((t) => t.title === "牛乳を買う");
		expect(created?.due).toBe("2026-07-20");
		expect(created?.isAllDay).toBe(true);
		expect(created?.priority).toBe(1);
		expect(typeof created?.id).toBe("string");
		expect(structured.affected).toHaveLength(1);
		expect(structured.affected?.[0]).toMatchObject({ id: created?.id, kind: "added" });
		expect(structured.affected?.[0]?.task?.id).toBe(created?.id);
	});

	it("list-todos で作成した TODO が1件返る(既定は未完了のみ)", async () => {
		const rpc = await callTool("list-todos", {});
		expect(rpc.result?.isError).not.toBe(true);
		const structured = rpc.result?.structuredContent as { tasks?: Array<{ title: string }> };
		expect(structured.tasks).toHaveLength(1);
		expect(structured.tasks?.[0]?.title).toBe("牛乳を買う");
	});

	it("create-todo に時刻付き due を渡すと invalid_input 相当のエラーになる(スライス①未対応)", async () => {
		const rpc = await callTool("create-todo", {
			title: "未対応ケース",
			due: "2026-07-20T09:00:00",
		});
		expect(rpc.result?.isError).toBe(true);
	});
});
