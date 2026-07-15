// =============================================================================
// OAuthPropsAuth — OAuth-for-MCP 第2スライス: OAuthProvider が検証済みの ctx.props を
// AuthenticationPort に橋渡しするだけのアダプタ
// =============================================================================
//
// 【位置づけ】
// application/ports/authentication.ts の AuthenticationPort を実装する infrastructure
// アダプタ。StaticBearerAuth(static-bearer-auth.ts)の「OAuth 化時に丸ごと差し替える」
// という宣言どおりの差し替え先がこのクラス。
//
// 【なぜ authenticate() の中身がほぼ no-op なのか(重要)】
// 通常の AuthenticationPort 実装(StaticBearerAuth)は Authorization ヘッダを自分で
// パースしてトークンを検証する。しかしこのアダプタは @cloudflare/workers-oauth-provider の
// OAuthProvider を **手前に立てた** 構成(src/index.ts の apiHandler 配線参照)で使う前提。
// OAuthProvider.fetch() は apiRoute(/mcp)宛のリクエストに対して:
//   1. Authorization: Bearer <token> を自分で読み、KV 内の発行済みトークンかどうかを検証する。
//   2. 見つからなければ resolveExternalToken コールバック(index.ts で実装)に委譲する。
//   3. どちらかで検証が通れば、確定した props を ExecutionContext.props に載せて
//      apiHandler(= mcpApiApp 経由でこのクラスまで)に渡す。
// つまり「トークンを検証する」「audience(resource)を検証する」という認証の実体は
// **すべて OAuthProvider 側で完了済み**。このクラスに来る時点で「認証済みかどうか」は
// props の有無だけで判定できる(props が無ければ、そもそも OAuthProvider が 401 を返して
// このクラスまで到達しない設計だが、防御的に undefined も 401 として扱っておく)。
//
// 【authorization / resourceUri を見ない理由】
// AuthContext.authorization(生 Authorization ヘッダ)と AuthContext.resourceUri
// (RFC 8707 audience 検証用の口)は StaticBearerAuth 用に authentication.ts が開けた
// seam だが、このアダプタでは両方とも意図的に無視する:
//   - authorization: OAuthProvider が既にこのヘッダを検証済み(上記1〜2)。二重検証は不要。
//   - resourceUri: audience 検証も OAuthProvider.handleApiRequest 内部(apiRoute マッチ +
//     resolveExternalToken が返す audience との照合)で完了している。index.ts の
//     resolveExternalToken 実装コメントも参照。
// 【将来 provider 非経由構成に戻すとき】
// もし OAuthProvider を経由しない構成(例: 別の Workers から props を直接注入するテスト、
// または OAuth をやめて元の StaticBearerAuth に戻す)に変えるなら、このクラスではなく
// authenticate() の呼び出し元(server.ts の deps 組み立て)を差し替えるのが筋。
// もしこのクラス自身で resourceUri を検証したくなった場合は、ctx.resourceUri と
// props に埋め込んだ audience を比較するロジックをここに足す(現状は provider が
// 済ませているので出番が無い)。
// =============================================================================

import type { AuthContext, AuthenticationPort, AuthResult } from "../../application/ports";
import { PrincipalRef, principalPath } from "../../domain/caldav";

// StaticBearerAuth と同じ principal 生成規則(必ず一致させる — MCP と DAV で同じ principal を
// 指すため。static-bearer-auth.ts の principalHrefFor と意図的に同一実装)。
function principalHrefFor(username: string): string {
	return `/dav/principals/${encodeURIComponent(username)}/`;
}

/**
 * OAuthProvider が resolveExternalToken / 内部トークン検証を経て ExecutionContext に
 * 載せる props の型。index.ts の resolveExternalToken 実装が返す形(現状は username のみ)と
 * 一致させる。OAuthProvider 側の props 型は `any` なので、ここで局所的に narrow する。
 */
export interface OAuthPrincipalProps {
	readonly username?: string;
	// R-6(2026-07-15): OAuth scope 分離(read/write)。completeAuthorization({props}) で同意された
	// scope を props に載せて運び、ここで principal と一緒に AuthResult.scopes へ透過する。
	// 【additive で {username} の暗黙契約を壊さない】既存 grant(scope 情報を持たない props)は
	// scopes が undefined のまま到達する。その場合は下の authenticate() で「旧 grant = full access
	// (grandfather)」として扱う(現運用の単一ユーザー接続を再接続まで生かす — R-6 裁定)。
	// 静的 Bearer(MCP_TOKEN)経路は resolveExternalTokenForMcp(src/app.ts)が full scope 配列を
	// 明示的に載せる(管理者自身のトークン = full access。旧 grant の警告とは区別する)。
	readonly scopes?: readonly string[];
}

export class OAuthPropsAuth implements AuthenticationPort {
	// props は「provider が検証済みトークンから復号した値」をコンストラクタで受け取るだけ
	// (index.ts の mcpApiApp 配線で ctx.props を読んで渡す)。ここでは props を生成・検証しない。
	constructor(private readonly props: OAuthPrincipalProps | undefined) {}

	authenticate(_ctx: AuthContext): AuthResult {
		// authorization/resourceUri はクラスコメントのとおり no-op(OAuthProvider が済ませている)。
		// 未使用引数だが AuthenticationPort のシグネチャを満たすために受け取る。
		if (!this.props?.username) {
			// props が無い = OAuthProvider の検証を通っていない(通常は起きないはずだが、
			// apiHandler へ直接到達するテスト/将来の配線変更に対する防御的フォールバック)。
			return { ok: false, wwwAuthenticate: 'Bearer realm="caldav-mcp"' };
		}
		const principal: PrincipalRef = principalPath(principalHrefFor(this.props.username));

		// --- R-6: scope の解決(grandfather 込み)-------------------------------------
		// このアダプタは scope 文字列リテラル(claudedav:read/write)を一切知らない
		// (層境界: infrastructure → presentation を import しない。強制は presentation/mcp の
		// scopes.ts が担う)。ここは「props.scopes を透過する / 旧 grant は undefined で素通し」
		// だけに徹する。AuthResult.scopes の契約(authentication.ts): undefined = full access。
		if (this.props.scopes === undefined) {
			// 旧 grant(scope 情報を持たない既存 OAuth トークン)。単一ユーザーの現運用を壊さないため
			// full access(grandfather)として扱い、undefined を素通しする。再接続すれば新 grant として
			// scopes 付きで発行され、以降は厳密強制に移行する。
			// 【なぜ warning を出すか】grandfather はあくまで移行期間の互換措置。「まだ scope 情報を
			// 持たない古いトークンが使われている」ことを運用者が気づけるよう console.log で警告する
			// (個人データは載せない。再接続を促す判断材料)。静的 Bearer 経路はここに来ない
			// (resolveExternalTokenForMcp が scopes を明示的に載せるため props.scopes !== undefined)。
			console.log(JSON.stringify({
				event: "oauth_grant_without_scopes",
				note: "legacy grant (no scope info) — granted full access as grandfather; reconnect to enforce read/write scopes",
			}));
			return { ok: true, principal };
		}
		// 新 grant(または静的 Bearer)。同意された scope 配列をそのまま運ぶ(厳密強制対象)。
		return { ok: true, principal, scopes: this.props.scopes };
	}
}
