// =============================================================================
// test/worker/auth-diagnostics.test.ts — 401/トークン発行の自己診断ログ検証。
// =============================================================================
// 【なぜ workerd レーンか】検証対象は src/index.ts の default export(fetch =
// fetchWithAuthDiagnostics)そのもの。provider(OAuthProvider)を経由する必要があり
// cloudflare:workers 依存のため oauth-e2e.test.ts と同じレーンに置く。
//
// 【何を保証するか(What = このファイルの役目)】
//  - 401 応答時に diag:"auth401" ログが1行出て、tokenFp が Authorization ヘッダの
//    生値を含まないこと(指紋のみ)。
//  - Authorization ヘッダが無い 401 では tokenFp:"none"。
//  - POST /oauth/token が 200 のとき diag:"tokenIssued" ログが出て、応答 body が
//    正常にそのまま呼び出し元へ返ること(clone で body を消費していないこと)。
//  - 401 でも token 発行でもない経路(例: 200 の /mcp)では診断ログを一切出さないこと。
//  - 診断ログの処理が例外を投げても(パース失敗相当)、本来のレスポンスが無事に
//    返ること(try/catch で本経路を守っている、という実装意図の検証)。
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_DUMMY_SECRETS } from "./test-secrets";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

async function callWorker(request: Request): Promise<Response> {
	return exports.default.fetch(request, env, ctx);
}

// SHA-256 先頭16 hex(src/index.ts の fingerprintToken と同じ方式)をテスト側でも
// 独立に計算し、ログの tokenFp が「生値ではなくこの指紋と一致する」ことを検証する
// (実装をそのまま import して使い回すと「実装が間違っていても一致してしまう」ため、
// 仕様どおりの方式でテスト側が独立に再計算する)。
async function expectedFingerprint(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const hex = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, 16);
}

/** console.log 呼び出しのうち diag ログ(JSON.parse できて diag フィールドを持つもの)だけを拾う。 */
function collectDiagLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
	const logs: Array<Record<string, unknown>> = [];
	for (const call of spy.mock.calls) {
		const arg = call[0];
		if (typeof arg !== "string") continue;
		try {
			const parsed = JSON.parse(arg);
			if (parsed && typeof parsed === "object" && "diag" in parsed) logs.push(parsed);
		} catch {
			// 診断ログ以外の console.log(DUMP_DAV_REQUESTS 等)は対象外。無視する。
		}
	}
	return logs;
}

describe("自己診断ログ(401 / トークン発行)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		// このファイル全体で1個の spy を張る(afterEach で呼び出し履歴だけ都度クリアする —
		// spy 自体を張り直すと console.log の元実装参照が壊れる懸念を避けるため)。
		logSpy = vi.spyOn(console, "log");
	});

	afterEach(() => {
		logSpy.mockClear();
	});

	it("(a) 無効な Bearer トークンで /mcp を叩くと 401 + diag:auth401 ログが出て、tokenFp は生トークンを含まない", async () => {
		const rawToken = "this-token-does-not-exist-anywhere-diag-test";
		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${rawToken}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"User-Agent": "diag-test-agent/1.0 " + "x".repeat(200),
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}),
		);
		expect(response.status).toBe(401);

		const diagLogs = collectDiagLogs(logSpy);
		const auth401Logs = diagLogs.filter((log) => log.diag === "auth401");
		expect(auth401Logs).toHaveLength(1);
		const logged = auth401Logs[0];
		expect(logged.path).toBe("/mcp");
		expect(logged.method).toBe("POST");
		expect(typeof logged.ua).toBe("string");
		expect((logged.ua as string).length).toBeLessThanOrEqual(80);
		expect(typeof logged.ts).toBe("number");

		// トークン生値がログのどこにも(文字列化しても)現れないこと。
		const serialized = JSON.stringify(logged);
		expect(serialized).not.toContain(rawToken);
		expect(logged.tokenFp).toBe(await expectedFingerprint(rawToken));
	});

	it("(b) Authorization ヘッダ無しで 401 になると tokenFp は \"none\"", async () => {
		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			}),
		);
		expect(response.status).toBe(401);

		const diagLogs = collectDiagLogs(logSpy).filter((log) => log.diag === "auth401");
		expect(diagLogs).toHaveLength(1);
		expect(diagLogs[0].tokenFp).toBe("none");
	});

	it("(c) POST /oauth/token が 200 のとき diag:tokenIssued ログが出て、応答 body(access_token)はそのまま返る", async () => {
		// PKCE 無しの静的トークン経路ではなく、実際に authorization_code グラントを
		// 一通り回して「provider 本物の 200 応答」を作る(診断ログが応答 body の
		// clone を正しく使えていること = 消費して壊していないことまで検証したいため、
		// 本物の grant フローを経由する必要がある)。
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const codeVerifier = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
		let challengeBinary = "";
		for (const byte of new Uint8Array(digest)) challengeBinary += String.fromCharCode(byte);
		const codeChallenge = btoa(challengeBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const redirectUri = "https://mcp-client.example.com/callback";

		const regRes = await callWorker(
			new Request("https://example.com/oauth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "diag-test-client", token_endpoint_auth_method: "none" }),
			}),
		);
		const clientId = ((await regRes.json()) as { client_id: string }).client_id;

		const authorizeUrl = new URL("https://example.com/authorize");
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", clientId);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("scope", "claudedav:read");
		authorizeUrl.searchParams.set("state", "diag-state");

		const postRes = await callWorker(
			new Request(authorizeUrl.toString(), {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password: TEST_DUMMY_SECRETS.CALDAV_PASSWORD }).toString(),
				redirect: "manual",
			}),
		);
		const code = new URL(postRes.headers.get("location") as string, redirectUri).searchParams.get("code") as string;

		// ここから診断ログの検証本体: token 交換前に spy をクリアし、この呼び出しだけを見る。
		logSpy.mockClear();

		const tokenRes = await callWorker(
			new Request("https://example.com/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					code_verifier: codeVerifier,
					client_id: clientId,
					redirect_uri: redirectUri,
				}).toString(),
			}),
		);
		expect(tokenRes.status).toBe(200);
		const body = (await tokenRes.json()) as { access_token: string; expires_in?: number };
		// clone を使わず response body を直接消費できている = 診断ログが本経路を壊していない証拠。
		expect(typeof body.access_token).toBe("string");

		const diagLogs = collectDiagLogs(logSpy).filter((log) => log.diag === "tokenIssued");
		expect(diagLogs).toHaveLength(1);
		const logged = diagLogs[0];
		expect(logged.grantType).toBe("authorization_code");
		expect(logged.tokenFp).toBe(await expectedFingerprint(body.access_token));
		expect(typeof logged.ts).toBe("number");
		if (body.expires_in !== undefined) expect(logged.expiresIn).toBe(body.expires_in);

		// 応答 body 生値がログに現れないこと(access_token 生値の非露出)。
		expect(JSON.stringify(logged)).not.toContain(body.access_token);
	});

	it("(d) 200 で完結する非対象経路(/mcp の静的トークン成功)では診断ログを一切出さない", async () => {
		const provisionRes = await callWorker(
			new Request("https://example.com/", {
				method: "PROPFIND",
				headers: { Authorization: `Basic ${btoa(`admin:${TEST_DUMMY_SECRETS.CALDAV_PASSWORD}`)}`, Depth: "0" },
			}),
		);
		expect(provisionRes.status).toBe(207);
		logSpy.mockClear();

		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${TEST_DUMMY_SECRETS.MCP_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
			}),
		);
		expect(response.status).toBe(200);
		expect(collectDiagLogs(logSpy)).toHaveLength(0);
	});
});
