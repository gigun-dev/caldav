// =============================================================================
// telemetry-support — MCP 計測イベント(TelemetryEvent)の各フィールドを組み立てる純関数群
// =============================================================================
//
// 【なぜ server.ts の計測点(registerTool ラッパー)から切り出すか】
// classifyHost / summarizeArgsDigest / readSessionId はいずれも「入力から判定・要約する
// だけ」の純関数で、単体テストで固定したい振る舞い(host 推定の分類基準・argsDigest の
// 要約規則・_meta キーの読み取りキー)を持つ。server.ts(1テストごとに MCP プロトコル全体を
// 組み立てる統合テストが主)に埋め込むより、ここに切り出して telemetry-support.test.ts から
// 直接叩けるようにする。application/ports/telemetry.ts の TelemetryEvent 冒頭コメントが
// 「判定は1関数に隔離する」と明言している箇所の実体がこのファイル。
// =============================================================================

// ext-apps/SDK の RequestMeta は index signature 付きの緩い型(unknown 値)なので、ここでは
// server.ts から型を引っ張らず「_meta の中身として来うる最小の形」だけをローカルに定義する
// (このファイルは MCP SDK の型に依存しない — 純粋な文字列/オブジェクト処理に留める判断)。
type UnknownMeta = Record<string, unknown> | undefined;

/**
 * User-Agent 文字列から接続元ホストを粗く分類する。
 * 【なぜこの3分類+unknown か】観測基盤 v1 の目的は「claude.ai 経由の呼び出しが多いのか、
 * iOS(swift/CFNetwork)からの直接呼び出しか、開発者が MCP Inspector で叩いているのか」を
 * 大づかみに切り分けることであって、ブラウザ/OS のバージョンまで解析する精密な UA パースは
 * 過剰(不要なメンテコストを生む)。判定は小文字化した部分一致でよい:
 *   - "claude" を含む → claude.ai(claude.ai の Web/デスクトップアプリの UA、および
 *     Anthropic 側のバックエンドが MCP へ接続する際の UA を両方拾う想定)。
 *   - "cfnetwork" または "swift" を含む → swift(iOS/macOS ネイティブクライアントの UA は
 *     CFNetwork/Darwin ベースが一般的。将来 Swift 製の自作クライアントが名乗る "swift" も拾う)。
 *   - "inspector" を含む → inspector(@modelcontextprotocol/inspector の既定 UA に含まれる)。
 *   - それ以外 / UA 無し → unknown。
 * 判定順序は上から評価する(重複マッチ時は claude.ai 優先 — claude.ai のデスクトップアプリが
 * 内部で CFNetwork を使っていても "claude" の方を先に見る)。
 */
export function classifyHost(userAgent: string | null | undefined): "claude.ai" | "swift" | "inspector" | "unknown" {
	if (userAgent === null || userAgent === undefined || userAgent === "") return "unknown";
	const ua = userAgent.toLowerCase();
	if (ua.includes("claude")) return "claude.ai";
	if (ua.includes("cfnetwork") || ua.includes("swift")) return "swift";
	if (ua.includes("inspector")) return "inspector";
	return "unknown";
}

// 【識別子キーの許可リスト(内容データ禁止の運用ルールの実体)】
// application/ports/telemetry.ts 冒頭の規律「calendarId のような識別子系は値可」をコードで
// 固定する。ここに無いキーは(文字列/配列問わず)値そのものを載せず typeof だけを記録する。
// 新しいツールが識別子引数を増やしたら、ここに追記するのがレビューポイントになる(要約規則を
// 1箇所に集約する狙いどおり — 計測点を触らずここだけ見ればよい)。
const IDENTIFIER_KEYS = new Set(["calendarId", "collectionId", "id", "uid", "todoId", "eventId"]);

/**
 * ツール引数の要約(argsDigest)を作る。TelemetryEvent.argsDigest の契約
 * (「キー名の列挙・配列は件数・識別子系は値可・内容データ禁止」)をここに実装として集約する。
 *
 * 【なぜキーごとに1エントリを残すか(キー名の列挙だけでも捨てないか)】
 * 「どの引数が渡されたか(undefined だったか)」自体がデバッグ・利用状況分析に有用
 * (例: create-todo の呼び出しで due が渡らないケースの割合)。キー名だけを配列で残す案も
 * あったが、配列件数の情報(calendarIds が何件だったか等)も同時に欲しいため、
 * key → digest値 のオブジェクトに統一した(1構造で両方の要望を満たす)。
 *
 * 【args が undefined/null/非オブジェクトのとき】
 * get-current-time のように引数を取らないツールでは args が {}(zod スキーマなしツール)か
 * undefined で来る。要約すべきキーが無ければ undefined を返し、TelemetryEvent.argsDigest の
 * 「undefined = 要約すべき引数が無かった」契約と一致させる。
 */
export function summarizeArgsDigest(args: unknown): Record<string, unknown> | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return undefined;

	const digest: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (Array.isArray(value)) {
			// 配列は中身を見ず件数のみ(例: calendarIds: ["a","b"] → { count: 2 })。
			// 識別子の配列であっても中身は載せない(仕様どおり「配列は件数」が識別子許可より優先)。
			digest[key] = { count: value.length };
		} else if (IDENTIFIER_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
			// 識別子系は値そのものを載せてよい(ルーティング先の特定に要る・内容データではない)。
			digest[key] = value;
		} else {
			// それ以外は型名だけ(例: "string" / "boolean" / "undefined" / "object")。
			// SUMMARY・notes のような自由記述文字列は "string" としか記録されず、値は絶対に漏れない。
			digest[key] = typeof value;
		}
	}
	return digest;
}

// 相関 ID の読み取りキー。MCP Apps 側の慣習(ドメイン名を名前空間にした _meta キー)に倣う。
// 【将来の差し替え(コメントで予告)】MCP 2026-07-28 RC で W3C traceparent 相当のキーが
// 標準化される見込み(architect 裁定のタスク仕様に明記)。標準化されたらこの定数を新キーへ
// 差し替えるだけで済むよう、呼び出し元(server.ts)には「readSessionId(meta) が sessionId を
// 返す」という契約だけを見せ、キー文字列自体はこの関数の外に漏らさない。
const SESSION_META_KEY = "gigun.dev/session";

/**
 * ツール呼び出しリクエストの _meta から相関 ID(sessionId)を読む。存在しない/文字列でない
 * 場合は undefined(TelemetryEvent.sessionId が optional な理由 — 大半のホストはこの独自
 * キーを送ってこない)。
 */
export function readSessionId(meta: UnknownMeta): string | undefined {
	if (meta === undefined) return undefined;
	const value = meta[SESSION_META_KEY];
	return typeof value === "string" && value !== "" ? value : undefined;
}
