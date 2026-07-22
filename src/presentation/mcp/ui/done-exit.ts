// =============================================================================
// presentation/mcp/ui/done-exit.ts — 完了退場(iOS リマインダー準拠)の判定(純関数コア)
// =============================================================================
// 【背景(C0-a′・2026-07-23 再導入)】todos-entry.ts 冒頭の C0-a′ コメント参照。旧 C0-a(約3秒後に
// 行を「消す」退場機構)は「完了済み(1件)」を展開して見ている最中に唯一のメンバーが消えて
// <details> ごと消滅する実機バグ(症状A)を生み、いったん丸ごと撤去した(2026-07-23)。今回は
// completedSummary(server 常時計算の有界サマリ)が退場先を常時可視にしたことを受け、「消す」では
// なく「完了済みセクションへ移す」設計として退場を再導入する(ユーザー裁定)。
//
// 退場は2フェーズ(猶予 → 退場アニメ)の状態機械で、todos-entry.ts が setTimeout/DOM/Map の読み書きを
// 担う。ここには「ネットワーク/タイマー/DOM に依存しない決定」だけを抽出する(toggle-coalesce.ts /
// render-gate.ts と同じ切り出しの規律 = 決定ロジックを競合ケースごとテストで固定する)。
// =============================================================================

/** ある id の退場が今どのフェーズにあるかを表す最小の状態(todos-entry.ts の
 *  retiringDoneIds.has(id) / exitingDoneIds.has(id) をそのまま渡す想定)。 */
export interface DoneExitPending {
	/** 猶予フェーズ中(タイマー未発火・undo すればキャンセルできる)か。 */
	retiring: boolean;
	/** 退場アニメ再生中(猶予満了〜アニメが尽きるまで。実データはまだ本体セクションに残っている)か。 */
	exiting: boolean;
}

/**
 * completedSummary 側の重複排除判定(仕様1)。本体行がまだ画面上に実在する間(猶予中 or アニメ中)は
 * completedSummary.recent 側の同 id 行を出してはいけない — 出すと「本体に残ったまま + 完了済み
 * セクションにも同じ行」の二重表示になる(server はミューテーション確定と同時に completedSummary を
 * 加算済みで返してくる契約なので、フィルタしないと確定直後から二重表示が始まる)。
 */
export function isDoneRowStillInPlace(pending: DoneExitPending): boolean {
	return pending.retiring || pending.exiting;
}

/**
 * 退場猶予の新規スケジュールを許可すべきか(二重スケジュール防止)。同じ id へ2回目の
 * kind:"completed" affected が届いても(例: 往復のたびに server が同じ affected を運ぶ場合)、
 * 既に猶予中/アニメ中なら再スケジュール(猶予の延長)はしない — 1回の完了に対して退場は1回だけ、
 * という不変条件を保つ。
 */
export function shouldScheduleDoneExit(pending: DoneExitPending): boolean {
	return !pending.retiring && !pending.exiting;
}
