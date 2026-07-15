// =============================================================================
// OAuthPropsAuth のテスト(OAuth-for-MCP 第2スライス)
// =============================================================================
// oauth-props-auth.ts のクラスコメントのとおり、このアダプタの authenticate() は
// トークン検証を一切しない(OAuthProvider が済ませている前提)。よってテストの主眼は
// 「props からどう principal を組み立てるか」「props 欠落時の 401 フォールバック」の2点。
// StaticBearerAuth と同じ principal 文字列になることも確認する(MCP/DAV で principal の
// 同一性を保つのが両クラス共通のルールのため — static-bearer-auth.test.ts と対で読む)。

import { describe, expect, it } from "bun:test";
import { OAuthPropsAuth } from "../../src/infrastructure/auth/oauth-props-auth";
import { StaticBearerAuth } from "../../src/infrastructure/auth/static-bearer-auth";
import { principalPath } from "../../src/domain/caldav";

// authorization/resourceUri は OAuthPropsAuth では no-op(クラスコメント参照)なので、
// テストでは中身を気にせずダミー値を渡す。
const CTX = { authorization: null, resourceUri: "https://example.com/mcp" };

describe("OAuthPropsAuth", () => {
	it("props.username があれば principal を解決する", async () => {
		const auth = new OAuthPropsAuth({ username: "admin" });
		const result = await auth.authenticate(CTX);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.principal).toBe(principalPath("/dav/principals/admin/"));
		}
	});

	// --- R-6: scope の透過 + grandfather ---------------------------------------------
	it("props.scopes があれば AuthResult.scopes にそのまま運ぶ(新 grant の厳密強制材料)", async () => {
		const auth = new OAuthPropsAuth({ username: "admin", scopes: ["claudedav:read"] });
		const result = await auth.authenticate(CTX);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.scopes).toEqual(["claudedav:read"]);
	});

	it("props.scopes が無い(旧 grant)場合は scopes を undefined で素通す(grandfather=full access)", async () => {
		// undefined = full access の契約(authentication.ts / scopes.ts の allowsWrite)。
		// oauth-props-auth は console.log 警告を出すが、認証自体は成功し scopes は undefined になる。
		const auth = new OAuthPropsAuth({ username: "admin" });
		const result = await auth.authenticate(CTX);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.scopes).toBeUndefined();
	});

	it("props が undefined なら 401 + WWW-Authenticate", async () => {
		const auth = new OAuthPropsAuth(undefined);
		const result = await auth.authenticate(CTX);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.wwwAuthenticate).toBe('Bearer realm="caldav-mcp"');
	});

	it("props.username が空文字なら 401(未設定と同じ扱い)", async () => {
		const auth = new OAuthPropsAuth({ username: "" });
		const result = await auth.authenticate(CTX);
		expect(result.ok).toBe(false);
	});

	it("StaticBearerAuth と同じ principal 文字列を組み立てる(MCP/DAV の principal 同一性)", async () => {
		const username = "admin";
		const oauthAuth = new OAuthPropsAuth({ username });
		const staticAuth = new StaticBearerAuth({ mcpToken: "secret-token", username });

		const oauthResult = await oauthAuth.authenticate(CTX);
		const staticResult = await staticAuth.authenticate({ authorization: "Bearer secret-token", resourceUri: CTX.resourceUri });

		expect(oauthResult.ok).toBe(true);
		expect(staticResult.ok).toBe(true);
		if (oauthResult.ok && staticResult.ok) {
			expect(oauthResult.principal).toBe(staticResult.principal);
		}
	});
});
