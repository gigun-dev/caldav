// =============================================================================
// StaticBearerAuth のテスト(G-5)
// =============================================================================

import { describe, expect, it } from "bun:test";
import { StaticBearerAuth } from "../../src/infrastructure/auth/static-bearer-auth";
import { principalPath } from "../../src/domain/caldav";

const RESOURCE_URI = "https://example.com/mcp";

describe("StaticBearerAuth", () => {
	it("正しい Bearer トークンで principal を解決する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "secret-token", username: "admin" });
		const result = await auth.authenticate({ authorization: "Bearer secret-token", resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(true);
		if (result.ok) {
			// DAV 側(principalHref)と同じ組み立て方(/dav/principals/{username}/)。
			expect(result.principal).toBe(principalPath("/dav/principals/admin/"));
		}
	});

	it("大文字小文字を問わず Bearer スキームを受理する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "secret-token", username: "admin" });
		const result = await auth.authenticate({ authorization: "bearer secret-token", resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(true);
	});

	it("誤ったトークンは拒否する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "secret-token", username: "admin" });
		const result = await auth.authenticate({ authorization: "Bearer wrong-token", resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.wwwAuthenticate).toBe('Bearer realm="caldav-mcp"');
	});

	it("Authorization ヘッダが無ければ拒否する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "secret-token", username: "admin" });
		const result = await auth.authenticate({ authorization: null, resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(false);
	});

	it("Basic 等 Bearer 以外のスキームは拒否する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "secret-token", username: "admin" });
		const result = await auth.authenticate({ authorization: "Basic dXNlcjpwYXNz", resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(false);
	});

	it("MCP_TOKEN が未設定(空文字)なら常に拒否する", async () => {
		const auth = new StaticBearerAuth({ mcpToken: "", username: "admin" });
		const result = await auth.authenticate({ authorization: "Bearer ", resourceUri: RESOURCE_URI });
		expect(result.ok).toBe(false);
	});
});
