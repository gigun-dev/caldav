// =============================================================================
// mcp/scopes — OAuth scope 語彙 + MCP ツールの read/write 区分(R-6)
// =============================================================================
//
// 【なぜ presentation/mcp に置くのか】
// scope の「強制」は presentation/mcp の責務(R-6 の裁定。ドメイン/アプリケーション層には
// scope の概念を漏らさない — application/ports/authentication.ts の AuthResult は seam として
// scopes を「運ぶ」だけで、どのツールが write かを判断する語彙は presentation にある)。
// ツールの read/write 区分(READ_ONLY_TOOLS)は「MCP ツールという presentation の語彙」に
// 密着した知識なので、ここに置くのが自然。
//
// 【なぜ infrastructure(oauth-props-auth)はこのファイルを import しないのか】
// dependency-cruiser の presentation-not-infrastructure / (裏返しの)層境界により、
// infrastructure から presentation を import できない/すべきでない。oauth-props-auth は
// scope 文字列リテラルを一切知らず、props.scopes を「そのまま透過」+「旧 grant は undefined の
// まま素通し(grandfather)」するだけに徹する。scope 文字列を知るのは:
//   - src/index.ts(scopesSupported の広告 — コンポジションルート)
//   - src/app.ts(authorize 同意画面の既定 scope・静的 Bearer の full access props)
//   - このファイル経由の server.ts(write ツール強制)
// の3箇所で、いずれも presentation 以内 or コンポジションルート。
// =============================================================================

// scope 語彙。read 名は既存の広告(旧 index.ts の scopesSupported: ["claudedav:read"])から
// 変えない — 既に発行済みの grant(scope=claudedav:read で同意済み)との整合を壊さないため。
export const SCOPE_READ = "claudedav:read";
export const SCOPE_WRITE = "claudedav:write";

// authorization server metadata の scopes_supported 等に出す全 scope。
// DCR クライアントが scope を要求しなかった場合の既定にもこれを使う(現 UX 維持 — R-6 裁定)。
export const ALL_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

// 照会系(read)ツールの名前集合。R-6 の区分:
//   照会 = get-current-time / list-* / refresh-* / get-freebusy → read
//   それ以外(create/update/delete/complete/move 等の mutation) → write
// 【なぜ read を allowlist にして「それ以外は write」にするか(safe default)】
// 新しいツールを足したとき、区分の更新を忘れても「未分類 = write 扱い(=より強い権限を要求)」に
// 倒れる方が安全。read を allowlist にしておけば、うっかり mutation ツールが read 扱いで
// read-only トークンに実行されてしまう事故を構造的に防げる。
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"get-current-time",
	"list-events-expanded",
	"refresh-events",
	"get-freebusy",
	"list-calendars",
	"list-todos",
	"refresh-todos",
	// C5(設計 05): 既知の場所ツールも list-* の照会系(read)。
	"list-known-locations",
	// #45 場所モデル: geocoding(文字列 → 座標候補)は読み取り専用の照会系(書き込みは伴わない)。
	"search-location",
	// R2(docs/modeling/15 §A-3): ゴミ箱一覧は読み取り専用。復元(restore-deleted)は mutation
	// なので safe default で write 扱いになる(ここには入れない)。
	"list-deleted",
]);

/** ツール名が write(mutation)系かどうか。READ_ONLY_TOOLS に無いものは全て write 扱い(safe default)。 */
export function isWriteTool(toolName: string): boolean {
	return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * この呼び出しが write ツールを実行してよいかを判定する。
 *
 * @param scopes 解決済みの scope 集合。**undefined は「旧 grant / 静的 Bearer 相当の full access
 *   (grandfather)」を意味する**(AuthResult.scopes の契約 — application/ports/authentication.ts と
 *   oauth-props-auth.ts のコメント参照)。配列なら厳密強制。
 */
export function allowsWrite(scopes: readonly string[] | undefined): boolean {
	// undefined = grandfather(full access)。旧 grant / 静的 Bearer 経路(oauth-props-auth が
	// props.scopes 無しのとき undefined を素通しする)を壊さないため、write を許す。
	if (scopes === undefined) return true;
	return scopes.includes(SCOPE_WRITE);
}
