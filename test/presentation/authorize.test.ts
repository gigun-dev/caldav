// =============================================================================
// GET/POST /authorize(同意 UI)のテスト — OAuth-for-MCP 第3スライス
// =============================================================================
// 2026-07-12 追加。src/app.ts の /authorize は @cloudflare/workers-oauth-provider の
// OAuthHelpers(c.env.OAUTH_PROVIDER)を呼ぶが、provider の実体(dist/oauth-provider.js)は
// "cloudflare:workers" を静的 import しており bun test には存在しない(src/app.ts 冒頭
// コメント参照)。そのためここでは provider の値を一切 import せず、OAuthHelpers の
// インターフェース(parseAuthRequest/lookupClient/completeAuthorization)だけを満たす
// Fake オブジェクトを env.OAUTH_PROVIDER に注入して app.fetch を叩く。
//
// 検証する観点:
//   - GET: 200 + フォーム HTML(password input を含む・clientName がエスケープされる)。
//   - POST 正パスワード: completeAuthorization が props:{username} 付きで呼ばれ 302。
//   - POST 誤パスワード: completeAuthorization が呼ばれず 401。
//   - XSS: 悪意あるクライアント名(<script>)が GET フォームでエスケープされること。
// =============================================================================

import { describe, expect, it } from "bun:test";
import { app } from "../../src/app";

const USERNAME = "admin";
const PASSWORD = "correct horse battery staple";

// provider が実際に authorize URL へ埋め込む代表的なクエリ(client_id/redirect_uri/state 等)。
// GET/POST どちらも「このクエリ文字列から parseAuthRequest できる」体で Fake を組む。
const QUERY = "client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz&response_type=code";

/** completeAuthorization の呼び出しを記録する Fake OAuthHelpers を組み立てる。 */
function makeFakeOAuthProvider(options: { clientName?: string } = {}) {
	const completeAuthorizationCalls: unknown[] = [];
	const fake = {
		async parseAuthRequest(request: Request) {
			// 本物は Request の URL クエリを見て AuthRequest を組み立てる。Fake でも同じ発想で
			// URL から最低限のフィールドを拾う(テストで使うのは clientId/scope/state 程度)。
			const url = new URL(request.url);
			return {
				responseType: url.searchParams.get("response_type") ?? "code",
				clientId: url.searchParams.get("client_id") ?? "",
				redirectUri: url.searchParams.get("redirect_uri") ?? "",
				scope: ["claudedav:read"],
				state: url.searchParams.get("state") ?? "",
			};
		},
		async lookupClient(_clientId: string) {
			if (options.clientName === undefined) return null;
			return {
				clientId: "test-client",
				redirectUris: ["https://client.example/cb"],
				clientName: options.clientName,
				tokenEndpointAuthMethod: "none",
			};
		},
		async completeAuthorization(completeOptions: unknown) {
			completeAuthorizationCalls.push(completeOptions);
			return { redirectTo: "https://client.example/cb?code=fake-code&state=xyz" };
		},
	};
	return { fake, completeAuthorizationCalls };
}

function makeEnv(fakeOAuthProvider: unknown) {
	return {
		DB: {} as unknown,
		CALDAV_USERNAME: USERNAME,
		CALDAV_PASSWORD: PASSWORD,
		PROXY_SHARED_SECRET: "",
		OAUTH_PROVIDER: fakeOAuthProvider,
	} as unknown as CloudflareBindings;
}

describe("GET /authorize", () => {
	it("200 + フォーム HTML(password input を含む・クライアント名を表示)", async () => {
		const { fake } = makeFakeOAuthProvider({ clientName: "My MCP Client" });
		const res = await app.fetch(new Request(`https://example.com/authorize?${QUERY}`), makeEnv(fake));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('type="password"');
		expect(html).toContain('name="password"');
		expect(html).toContain("My MCP Client");
		// action は元のクエリ文字列をそのまま持ち回る(hidden ではなくクエリで運ぶ設計)。
		expect(html).toContain(`action="/authorize?${QUERY}"`);
	});

	it("XSS: 悪意あるクライアント名がエスケープされる", async () => {
		const { fake } = makeFakeOAuthProvider({ clientName: "<script>alert(1)</script>" });
		const res = await app.fetch(new Request(`https://example.com/authorize?${QUERY}`), makeEnv(fake));
		const html = await res.text();
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("lookupClient が null を返しても致命的にならず「不明なクライアント」表示で続行できる", async () => {
		const { fake } = makeFakeOAuthProvider();
		const res = await app.fetch(new Request(`https://example.com/authorize?${QUERY}`), makeEnv(fake));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('type="password"');
	});
});

describe("POST /authorize", () => {
	it("正パスワード: completeAuthorization が props:{username} 付きで呼ばれ 302 redirect", async () => {
		const { fake, completeAuthorizationCalls } = makeFakeOAuthProvider({ clientName: "My MCP Client" });
		const form = new URLSearchParams({ password: PASSWORD });
		const res = await app.fetch(
			new Request(`https://example.com/authorize?${QUERY}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			}),
			makeEnv(fake),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://client.example/cb?code=fake-code&state=xyz");
		expect(completeAuthorizationCalls).toHaveLength(1);
		expect(completeAuthorizationCalls[0]).toMatchObject({
			userId: USERNAME,
			scope: ["claudedav:read"],
			props: { username: USERNAME },
		});
	});

	it("誤パスワード: completeAuthorization は呼ばれず 401", async () => {
		const { fake, completeAuthorizationCalls } = makeFakeOAuthProvider({ clientName: "My MCP Client" });
		const form = new URLSearchParams({ password: "wrong-password" });
		const res = await app.fetch(
			new Request(`https://example.com/authorize?${QUERY}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			}),
			makeEnv(fake),
		);
		expect(res.status).toBe(401);
		expect(completeAuthorizationCalls).toHaveLength(0);
		const html = await res.text();
		expect(html).toContain('type="password"');
		expect(html).toContain("パスワードが違います");
	});
});
