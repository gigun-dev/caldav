// 非公開引数を使わず、local と本番 tools/list の契約だけを保存する調査用。
// 本番への call は行わない。認証値は既存 ignored ファイルから読み、出力には含めない。
import { Hono } from "hono";
import { createMcpApp } from "../src/presentation/mcp/server";
import { StaticBearerAuth, IcaljsRRuleIterator, NoopTelemetryAdapter, NoopCardTelemetryAdapter } from "../src/infrastructure";
import { FakeCalendarCollectionRepository, FakeCalendarObjectResourceRepository, FakeCollectionUnitOfWork } from "../test/application/fakes";

const output = process.argv[2];
if (!output) throw new Error("usage: bun scripts/verify-range-schema.ts OUTPUT.json [--production]");
const collections = new FakeCalendarCollectionRepository();
const resources = new FakeCalendarObjectResourceRepository();
const app = new Hono().route("/mcp", createMcpApp(() => ({
	auth: new StaticBearerAuth({ mcpToken: "schema-fixture", username: "fixture" }),
	collectionRepo: collections, resourceRepo: resources, iterator: new IcaljsRRuleIterator(),
	uow: new FakeCollectionUnitOfWork(resources, collections), confirmSecret: "fixture",
	telemetry: new NoopTelemetryAdapter(), cardTelemetry: new NoopCardTelemetryAdapter(),
	geocoding: { searchLocation: async () => [] },
})));
const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
function request(url: string, token: string) {
	return new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}`,
		"content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(list) });
}
async function schema(res: Response) {
	if (!res.ok) throw new Error(`tools/list HTTP ${res.status}`);
	const body = await res.text();
	const data = body.startsWith("{") ? body : body.split("\n").find(line => line.startsWith("data: "))?.slice(6);
	const rpc = JSON.parse(data ?? "{}");
	if (!rpc.result?.tools) throw new Error("tools/list missing tools (response body is not logged)");
	return rpc.result.tools.filter((tool: { name: string }) => ["list-events-expanded", "refresh-events", "get-freebusy"].includes(tool.name))
		.map((tool: { name: string; inputSchema: unknown }) => ({ name: tool.name, inputSchema: tool.inputSchema }));
}
const local = await schema(await app.fetch(request("https://fixture/mcp", "schema-fixture")));
let production;
if (process.argv.includes("--production")) {
	const tokenFile = process.argv.indexOf("--token-file");
	// 本番控えが古い場合にも既存の認証元を明示できる。候補を無差別に試さない。
	const token = tokenFile >= 0
		? (await Bun.file(process.argv[tokenFile + 1]!).text()).match(/^MCP_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
		: process.env.CALDAV_MCP_TOKEN ?? JSON.parse(await Bun.file(".secrets.prod.json").text()).MCP_TOKEN;
	if (!token) throw new Error("MCP_TOKEN missing (value is not logged)");
	production = await schema(await fetch(request("https://caldav.gigun-dev.workers.dev/mcp", token)));
}
await Bun.write(output, JSON.stringify({ local, ...(production ? { production } : {}) }, null, 2) + "\n");
console.log(JSON.stringify({ output, localTools: local.length, productionTools: production?.length ?? 0 }));

const resultsIndex = process.argv.indexOf("--model-results");
if (resultsIndex >= 0) {
	const lines = (await Bun.file(process.argv[resultsIndex + 1]!).text()).trim().split("\n");
	const checks = [];
	for (const line of lines) {
		const result = JSON.parse(line);
		const call = new Request("https://fixture/mcp", { method: "POST", headers: {
			authorization: "Bearer schema-fixture", "content-type": "application/json", accept: "application/json, text/event-stream",
		}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
			name: "list-events-expanded", arguments: JSON.parse(result.arguments),
		} }) });
		const response = await app.fetch(call);
		const data = (await response.text()).split("\n").find(line => line.startsWith("data: "))?.slice(6);
		const rpc = JSON.parse(data ?? "{}");
		if (!rpc.result) throw new Error("fixture result missing");
		checks.push({ origin: result.origin, mode: result.mode, round: result.round, isError: rpc.result.isError === true });
	}
	await Bun.write(output + ".checks.json", JSON.stringify(checks, null, 2) + "\n");
	console.log(JSON.stringify({ modelChecks: checks.length, rejected: checks.filter(check => check.isError).length }));
}
