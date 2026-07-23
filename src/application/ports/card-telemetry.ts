// =============================================================================
// CardTelemetryPort — MCP Apps カード(todos/agenda の HTML/JS)からの計測イベントを1件記録するだけのポート
// =============================================================================
//
// 【なぜ TelemetryPort(1 tool call = 1 イベント)と別ポートに分けるか】
// TelemetryPort(application/ports/telemetry.ts)はサーバー側の registerTool ラッパーが計測点で、
// 「呼ばれた MCP ツール名 / 所要 ms / principal」というサーバー内部の語彙を持つ。対してこちらは
// カード側 JS(presentation/mcp/ui 配下・ui/ トップレベルのビルド成果物)が report-card-telemetry
// ツールを callServerTool で叩いた"結果"を記録するもので、語彙が「カードの描画/操作イベント」で
// まったく別物(cardType/uiHash/instanceId/displayMode 等)。無理に1ポートへ寄せると
// TelemetryEvent の判別共用体が肥大化し、AE アダプタのマッピング表(96B 予算の按分)も
// ツール計測とカード計測で競合してしまうため、最初から別ポート・別 AE dataset に分離した。
//
// 【PII 境界(必読・telemetry.ts の argsDigest 規律と同じ思想をカード計測にも適用する)】
// カードは iOS/claude.ai 上で動く UI なので、ここに流れてくる値は「ユーザーが今画面で何をしていたか」
// に近い。既存 TelemetryEvent.argsDigest コメント(application/ports/telemetry.ts 冒頭)の規律を
// そのまま踏襲し、このポートに流してよい情報を明文化する:
//   - 許可: kind(判別用の固定語彙)/ JS の Error.name のようなクラス名 / frame(コード座標。
//     例 "todos-entry.ts:123")/ msgDigest(メッセージ本文そのものではなく要約・ハッシュ化した値)/
//     DOM の id 属性(activeElementId — id は開発者が付けた固定文字列であり自由記述ではない)/
//     count のような数値 / safe-area の inset 数値。
//   - 禁止: エラーメッセージの本文そのもの・入力フィールドの値・タスクのタイトルや notes 等の
//     自由記述文字列。呼び出し側(server.ts の report-card-telemetry zod スキーマ)がそもそも
//     自由記述フィールドを定義しない形にすることで、型レベルでもこの禁止を強制する
//     (「送れる形が無い」= 送信側の実装ミスでも漏れようがない、が一番強い防御)。
//
// 【record は fire-and-forget】TelemetryPort と同じ契約(戻り値なし・例外を投げない)。カードからの
// 計測は「UI 内部の観測データが取れなくても本来の CalDAV 操作は絶対に壊れてはならない」の要請が
// TelemetryPort よりさらに強い(呼び出し元がユーザー操作に対する即時フィードバックを担うカード UI
// そのものなので、計測失敗でカード操作自体がエラー扱いになるのは論外)。実装アダプタ側
// (analytics-engine-card-telemetry.ts)の try/catch に加え、呼び出し側(server.ts の
// report-card-telemetry handler)でも try/catch する二重防御は telemetry.ts の TelemetryPort
// コメントにある「二重の防御」の設計をそのまま踏襲する。
// =============================================================================

/** カードが動いている画面(todos カード / agenda カード)。tools/list の resourceUri と対応する。 */
export type CardTelemetryCardType = "todos" | "agenda";

/** カードの表示モード(inline=会話内に埋め込み表示 / fullscreen=昇格表示 / unknown=判定不能)。 */
export type CardTelemetryDisplayMode = "inline" | "fullscreen" | "unknown";

/**
 * カード計測イベントの種別ごとのペイロード(判別共用体)。dt(イベント発生からの相対ミリ秒。カード側の
 * バッチ内でのタイムライン復元用)は3種に共通なのでここでは持たせず、CardTelemetryEvent 側の
 * 交差型で1回だけ書く(presentation/mcp/server.ts の report-card-telemetry zod スキーマと対称)。
 */
export type CardTelemetryPayload =
	// error: カード内で捕捉した JS 例外の要約。message 本文ではなく name(クラス名)と msgDigest
	// (要約・ハッシュ化済み)のみ。frame はスタックトレース全体ではなく発生箇所1行程度のコード座標。
	// count は同一エラーの再発回数(バッチ内で重複を1件に丸めた集約値)。
	| { readonly kind: "error"; readonly name: string; readonly msgDigest: string; readonly frame?: string; readonly count: number }
	// focus-probe: fullscreen 昇格直後のドラフト入力欄フォーカス問題(過去のセッション引き継ぎで
	// 何度も踏んだ不具合)を実機で追跡するためのプローブ。phase は昇格前/後のどちらの計測かを表す。
	// activeElementId は document.activeElement.id(自由記述ではなく DOM 側が持つ固定 id 属性)。
	| {
			readonly kind: "focus-probe";
			readonly phase: "before" | "after";
			readonly activeElementId?: string;
			readonly sheetInputConnected: boolean;
			readonly sheetInputActive: boolean;
	  }
	// safe-area: iOS の safe-area-inset-* が期待どおり適用されているかの実測値。fallback*Applied は
	// CSS env() が取れず固定値へフォールバックしたかどうか(iOS 実機の safe-area 検証課題の追跡用)。
	| {
			readonly kind: "safe-area";
			readonly top: number;
			readonly right: number;
			readonly bottom: number;
			readonly left: number;
			readonly fallbackTopApplied: boolean;
			readonly fallbackBottomApplied: boolean;
	  };

/**
 * 1件のカード計測イベント(サーバー到達後の完成形)。カード側が送ってくる生の events[] 要素
 * (dt + CardTelemetryPayload)に、report-card-telemetry ハンドラ(server.ts)が
 * バッチ共通のメタデータ(cardType/uiHash/instanceId/displayMode)と、サーバー側で解決した
 * host/sessionId/receivedAt を合成してこの完成形にする。AE アダプタ
 * (infrastructure/telemetry/analytics-engine-card-telemetry.ts)はこの完成形をそのまま
 * index1/blobs/doubles へ写像する契約なので、フィールドを増減したらそちらのマッピング表も
 * 合わせて更新すること(telemetry.ts の TelemetryEvent コメントと同じ規律)。
 */
export type CardTelemetryEvent = CardTelemetryPayload & {
	/** バッチ内でのイベント発生タイミング(カード側が計測開始からの相対ミリ秒で採番)。 */
	readonly dt: number;
	/** どのカードからの計測か。 */
	readonly cardType: CardTelemetryCardType;
	/** カード HTML のハッシュ(todos-app.ts の TODOS_UI_HASH 等。8桁。どのビルドのカードかを特定する)。 */
	readonly uiHash: string;
	/** カードの描画インスタンス ID(8桁。同一カードの複数インスタンスを束ねずに区別する)。 */
	readonly instanceId: string;
	/** カードの表示モード。 */
	readonly displayMode: CardTelemetryDisplayMode;
	/**
	 * User-Agent からの粗い分類。TelemetryEvent.host と同じ判定関数(presentation/mcp/telemetry-support.ts
	 * の classifyHost)を report-card-telemetry ハンドラが呼んで埋める。
	 */
	readonly host: string;
	/** 相関 ID(TelemetryEvent.sessionId と同じ readSessionId 由来)。無ければ undefined。 */
	readonly sessionId?: string;
	/** サーバーがこのバッチを受け取った時刻(epoch ミリ秒。Date.now())。 */
	readonly receivedAt: number;
};

/**
 * カード計測イベントを記録するポート。TelemetryPort と同じく fire-and-forget(戻り値なし)。
 * 呼び出し側(server.ts の report-card-telemetry handler)は events[] の各要素についてこれを
 * 呼ぶだけで、await もしないし record が投げても tool call を壊さないよう try/catch で包む
 * (二重防御の設計は本ファイル冒頭コメント参照)。
 */
export interface CardTelemetryPort {
	record(event: CardTelemetryEvent): void;
}
