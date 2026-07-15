// =============================================================================
// AuthenticationPort — 「認証済み principal をくれ」とだけ要求する認証ポート(G-5)
// =============================================================================
//
// 【なぜ application 層にこのポートを置くのか】
// application 層のユースケース(ListOccurrences / ComputeFreeBusy ...)は
// CLAUDE.md 長期ビジョン1のとおり「MCP / REST / メール等の複数入口から呼べる」形を保つ。
// その入口ごとに「誰からのリクエストか(= どの principal か)」を解決する必要があるが、
// **どうやって解決するか(Basic / 静的 Bearer / OAuth / mTLS ...)は application/domain の
// 関心事ではない**。そこでこのポートは「認証方式を一切知らず、解決済みの PrincipalRef を
// くれ」という最小の契約だけを型で表す(ports/index.ts のリポジトリポートと同じ思想)。
//
// 【OAuth-ready seam(2026-07-11 G-5 の確定方針)】
// docs/modeling/11「2026-07-11 grounded 更新」/ 07 §5 のとおり、G-5 の認証は静的 Bearer で
// 始めるが、OAuth 化(方向性 A のマルチユーザー / E のコネクタ正規登録)が近い将来の高優先。
// よってこのポートは「使い捨てスタブ」ではなく「OAuth アダプタにそのまま差し替えられる本気の
// seam」として設計する:
//   - authenticate() は Authorization ヘッダの生文字列を受け取り、方式(Bearer/OAuth)を隠蔽する。
//   - AuthContext.resourceUri を今から開けてある = OAuth 化時の **audience 検証(RFC 8707
//     Resource Indicators)の口**。静的 Bearer では no-op だが、workers-oauth-provider 等の
//     アダプタに差し替えたとき「このトークンはこの MCP リソース(audience)向けに発行されたか」を
//     検証する材料になる。今 port の口を開けておくことで、後で presentation/配線を触らずに
//     アダプタ実装だけ差し替えられる。
//
// 【DAV の Basic 認証との関係(今回のスコープ)】
// これは MCP 入口用の seam。DAV 側の Basic 認証(src/index.ts の authenticateBasic)は今回は
// 触らない。将来 DAV もこのポートに寄せられる(authenticate に Basic アダプタを差せば同型)が、
// それは別タスク(iOS の実挙動に影響するため慎重に分ける)。
// =============================================================================

import type { PrincipalRef } from "../../domain/caldav";

/**
 * 認証を解決するために必要な入力。トランスポート非依存にするため、HTTP の Request そのものは
 * 渡さず「認証に必要な素材」だけを抽出して渡す(presentation 層が Hono Context から詰める)。
 */
export interface AuthContext {
	/** Authorization ヘッダの生値(例 "Bearer xxxxx")。無ければ null。方式の解釈はアダプタの責務。 */
	readonly authorization: string | null;
	/**
	 * このリクエストが叩いている MCP リソースの URI(例 "https://caldav.example.com/mcp")。
	 * 静的 Bearer では使わない(no-op)。OAuth 化時に **audience 検証(RFC 8707)** の口として使う:
	 * 「アクセストークンの aud がこの resourceUri を含むか」をアダプタが検証する。
	 */
	readonly resourceUri: string;
}

/**
 * 認証結果。成功なら解決済みの PrincipalRef、失敗なら 401 応答に添える WWW-Authenticate 値
 * (RFC 6750 の Bearer チャレンジ等)を任意で返す。判別可能ユニオンにして、呼び出し側が
 * ok の分岐で principal を型安全に取り出せるようにする。
 *
 * 【scopes を「運ぶ」だけの seam(R-6。2026-07-15 追加)】
 * OAuth の read/write scope 分離のため、認証アダプタ(OAuthPropsAuth)が解決した scope 集合を
 * ここに載せて presentation/mcp まで運ぶ。**application/domain はこの値の意味を一切解釈しない**
 * (どのツールが write かの判断・強制は presentation/mcp の scopes.ts が担う。ここは純粋に
 * 「アダプタ → 入口」の受け渡し口)。string[] にしているのは domain の値オブジェクトに
 * 昇格させないため — scope はあくまで OAuth/MCP プロトコル層の関心事で、ドメインモデルではない。
 *
 * scopes の契約(presentation 側の解釈): **undefined は「full access(grandfather)」を意味する**。
 *   - 旧 grant(scope 情報を props に持たない既存 OAuth トークン)→ undefined(現運用を壊さない)。
 *   - 静的 Bearer(MCP_TOKEN)→ アダプタが full scope 配列を載せる(サーバー管理者自身のトークン)。
 *   - 新 grant → 同意された scope の配列(厳密強制)。
 * 詳細は infrastructure/auth/oauth-props-auth.ts と presentation/mcp/scopes.ts の allowsWrite。
 */
export type AuthResult =
	| { readonly ok: true; readonly principal: PrincipalRef; readonly scopes?: readonly string[] }
	| { readonly ok: false; readonly wwwAuthenticate?: string };

/**
 * 認証ポート。「認証済み principal をくれ」とだけ要求する。
 * 同期・非同期どちらの実装も許容する(静的 Bearer は同期、OAuth の JWKS 検証等は非同期に
 * なりうるため、返り値は `Promise<AuthResult> | AuthResult` を許す)。
 */
export interface AuthenticationPort {
	authenticate(ctx: AuthContext): Promise<AuthResult> | AuthResult;
}
