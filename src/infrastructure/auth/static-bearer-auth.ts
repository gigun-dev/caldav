// =============================================================================
// StaticBearerAuth — G-5 MCP 入口向けの AuthenticationPort 実装(静的 Bearer トークン)
// =============================================================================
//
// 【位置づけ】
// application/ports/authentication.ts の AuthenticationPort を実装する infrastructure
// アダプタ。DAV 側の Basic 認証(presentation/auth/basic-auth.ts)とは別入口
// (authentication.ts のコメント「DAV の Basic 認証との関係」参照)。
//
// 【なぜ静的 Bearer から始めるか / OAuth への差し替え口】
// docs/modeling/11・07 §5 のとおり、M2 で OAuth 化する前提の「本気の seam」として
// AuthenticationPort を設計済み。このアダプタは「Authorization: Bearer <MCP_TOKEN> を
// secureStringEqual で定数時間比較する」だけの最小実装で、OAuth 化時はこのクラスを
// 丸ごと別実装(例 OAuthBearerAuth)に差し替えるだけで presentation/mcp/server.ts 側の
// 配線(auth: AuthenticationPort を渡すだけ)は変えずに済む。
//
// 【audience(ctx.resourceUri)は今は使わない】
// AuthContext.resourceUri は OAuth 化時の RFC 8707 audience 検証の口として authentication.ts
// で開けてある。静的 Bearer にはトークンへ aud を埋め込む仕組みが無いため、ここでは意図的に
// no-op(使わない)。OAuth アダプタに差し替えたとき、そちらの実装で
// 「トークンの aud が ctx.resourceUri と一致するか」を検証することになる。
// =============================================================================

import type { AuthContext, AuthenticationPort, AuthResult } from "../../application/ports";
import { PrincipalRef, principalPath } from "../../domain/caldav";
import { secureStringEqual } from "../../presentation/auth/basic-auth";

// DAV 側の principalHref(username) と同じ生成規則(src/index.ts)。MCP と DAV で同じ
// principal を指すために、principal path の作り方を意図的に揃える(将来 DAV もこのポートへ
// 寄せる可能性を見据えたときに principal の同一性が崩れないように)。
function principalHrefFor(username: string): string {
	return `/dav/principals/${encodeURIComponent(username)}/`;
}

export interface StaticBearerAuthConfig {
	/** 期待する Bearer トークン(Wrangler secret MCP_TOKEN)。空文字は「未設定」= 常に拒否。 */
	readonly mcpToken: string;
	/** 認証成功時に構築する principal のユーザー名(DAV の CALDAV_USERNAME と同じ値を渡す想定)。 */
	readonly username: string;
}

export class StaticBearerAuth implements AuthenticationPort {
	constructor(private readonly config: StaticBearerAuthConfig) {}

	async authenticate(ctx: AuthContext): Promise<AuthResult> {
		// ctx.resourceUri は現状 no-op(クラスコメント参照)。将来 OAuth 化したときに使う。
		void ctx.resourceUri;

		// MCP_TOKEN 未設定(空文字)なら、どんなトークンが来ても常に拒否する。
		// 「秘密鍵が空文字なら誰でも通る」事故を避けるための明示ガード
		// (secureStringEqual は空同士だと true を返してしまうため、ここで先に弾く)。
		if (this.config.mcpToken.length === 0) {
			return { ok: false, wwwAuthenticate: 'Bearer realm="caldav-mcp"' };
		}

		const header = ctx.authorization;
		if (!header || !header.toLowerCase().startsWith("bearer ")) {
			return { ok: false, wwwAuthenticate: 'Bearer realm="caldav-mcp"' };
		}
		const supplied = header.slice("bearer ".length).trim();

		// タイミング攻撃対策の定数時間比較(basic-auth.ts の secureStringEqual を再利用)。
		const matches = await secureStringEqual(supplied, this.config.mcpToken);
		if (!matches) {
			return { ok: false, wwwAuthenticate: 'Bearer realm="caldav-mcp"' };
		}

		// DAV 側と同じ principal を指すよう、principalHref(username) から principalPath を組む
		// (src/index.ts の principalPathValue と同じ構築方法)。
		const principal: PrincipalRef = principalPath(principalHrefFor(this.config.username));
		return { ok: true, principal };
	}
}
