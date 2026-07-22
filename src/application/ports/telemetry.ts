// =============================================================================
// TelemetryPort — MCP ツール呼び出しの計測イベントを1件記録するだけのポート(観測基盤 v1)
// =============================================================================
//
// 【なぜ application 層にこのポートを置くのか】
// AuthenticationPort と同じ思想(authentication.ts 冒頭コメント参照): 「何を記録するか」は
// application/presentation の関心事だが、「どこへ送るか(Workers Analytics Engine / 構造化
// ログ / 何もしない)」は外部技術の詳細であり infrastructure に隠す。record() は
// fire-and-forget(戻り値なし・await 不要)にして、計測が本処理(ツール実行)の成否や
// レイテンシに影響しないことを型でも示す。
//
// 【1 tool call = 1 イベントという粒度】
// presentation/mcp/server.ts の registerTool monkeypatch(ツール別レイテンシ計測、
// 2026-07-14 追加のコメント参照)が計測点。今回の観測基盤 v1 はこの計測点を
// 「console.log 1行 JSON だけ」から「console.log + TelemetryPort.record()」へ拡張する
// (両方が同一イベントを流す — 構造化ログは従来どおり Workers observability の
// $metadata.message から拾える即応性を保ち、AE は SQL で集計・相関できる永続化を担う)。
//
// 【argsDigest に内容データを絶対に載せない規律(明文化)】
// 既存の計測ログ(mcpTool/ms/colo のみ)は「タスク内容等の個人データは決して載せない」
// というコメントで規律を守ってきた(buildMcpServer 冒頭)。引数まで記録範囲を広げる今回は
// この規律を型ではなく運用コメントでしか強制できないため、ここに明文化する:
//   - 許可: 引数のキー名の列挙・配列は「件数」・calendarId / collectionId / uid のような
//     不透明な識別子の"値"(これ自体は内容ではなくルーティング先を表す)。
//   - 禁止: タイトル・メモ・SUMMARY・DESCRIPTION 等、人間が書いた自由記述文字列の値そのもの。
//   要約ロジックは presentation/mcp/telemetry-support.ts の summarizeArgsDigest に1関数へ
//   集約する(計測点に散らばせない — 「何を要約してよいか」の判断を1箇所に閉じ込め、
//   将来ツールが増えてもレビュー箇所を固定する)。
// =============================================================================

/**
 * 1 tool call ぶんの計測イベント。フィールドは AE アダプタ(infrastructure/telemetry/
 * analytics-engine-telemetry.ts)がそのまま index1/blobs/doubles へ写像する契約になっている
 * ため、フィールドを増減したら AE アダプタのマッピングコメントも合わせて更新すること。
 */
export interface TelemetryEvent {
	/** サーバー自前採番のリクエスト相関 ID(crypto.randomUUID()。tool call ごとに新規発行)。 */
	readonly requestId: string;
	/** 認証で解決した principal(PrincipalRef を string 化したもの。誰からの呼び出しか)。 */
	readonly principal: string;
	/**
	 * User-Agent からの粗い分類("claude.ai" / "swift" / "inspector" / "unknown")。
	 * 判定は presentation/mcp/telemetry-support.ts の classifyHost に1関数へ隔離する
	 * (UA 文字列のパターンは変わりやすく、判定ロジックを複数箇所に持たせると乖離する)。
	 */
	readonly host: string;
	/** MCP ツール名(例 "create-todo")。 */
	readonly mcpTool: string;
	/** ツール呼び出しが成功したか(isError レスポンス/例外なら false)。 */
	readonly ok: boolean;
	/**
	 * 失敗時のエラー種別(例外クラス名、またはツールエラーの種別文字列)。ok=true のときは
	 * undefined。スタックトレースや例外メッセージ本文は載せない(引数値と同じ理由 — メッセージに
	 * ユーザー入力の一部がエコーされうる。種別だけなら安全に集計できる)。
	 */
	readonly errKind?: string;
	/** 所要時間(ミリ秒)。既存ログの ms と同じ計測窓(cb 呼び出しの try/finally)。 */
	readonly ms: number;
	/** 実行された Cloudflare colo(request.cf.colo)。既存の requestColo 引き回しと同じ。 */
	readonly colo?: string;
	/**
	 * 引数の要約のみ(内容データ禁止の規律は本ファイル冒頭コメント参照)。undefined は
	 * 「このツールには要約すべき引数が無かった(get-current-time 等)」を表す。
	 */
	readonly argsDigest?: Record<string, unknown>;
	/**
	 * 相関 ID(params._meta["gigun.dev/session"])。MCP ホストが会話/セッション単位で
	 * 発行するキーで、同一ホスト内の複数 tool call を束ねて追跡するのに使う。読み取りは
	 * presentation/mcp/telemetry-support.ts の readSessionId に集約する(2026-07-28 RC の
	 * W3C traceparent 案に将来キーを差し替えるときもこの1関数だけ直せばよいようにする —
	 * 詳細は同ファイルの readSessionId コメント参照)。
	 */
	readonly sessionId?: string;
}

/**
 * 計測イベントを記録するポート。fire-and-forget(戻り値なし)であることを型で示す —
 * 呼び出し側(server.ts の registerTool ラッパー)は await しない。record() 内部での失敗
 * (AE 書き込み例外等)がツール呼び出し自体を壊してはならない契約はアダプタ側の第一の責務にする
 * (infrastructure/telemetry/analytics-engine-telemetry.ts の try/catch 参照)。
 *
 * 【二重の防御(2026-07-23 追記): 呼び出し側でも try/catch する】
 * アダプタが規律を守っていることに依存せず、server.ts の registerTool ラッパーは
 * deps.telemetry.record(...) 呼び出し自体も try/catch する。finally ブロック内で record が
 * 万一 throw すると、try ブロックの正常終了(return 値)を JS の仕様上 finally 側の例外が
 * 上書きしてしまい、成功したはずの tool call のレスポンスごと握りつぶされる(「計測失敗が
 * 本処理を壊してはならない」という本ポートの存在理由そのものを裏切る落とし穴)。アダプタ内の
 * try/catch と呼び出し側の try/catch は互いのバグを補完する二重の安全網として意図的に重ねている
 * (どちらか片方が壊れても tool call は守られる)。
 */
export interface TelemetryPort {
	record(event: TelemetryEvent): void;
}
