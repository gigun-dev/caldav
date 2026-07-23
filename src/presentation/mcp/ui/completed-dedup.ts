// =============================================================================
// presentation/mcp/ui/completed-dedup.ts — completedSummary の重複排除(所属判定・純関数コア)
// =============================================================================
// 【背景(2026-07-23 (d′) 裁定・C0-a′ 撤回)】完了行の3秒退場(C0-a′)を撤回し、docs/modeling/12
// §7.8 v2.2 item 3 の「done はその場で取消線・クリーン再セクショニングはインスタンス境界のみ」を正に
// 戻した(todos-entry.ts 冒頭 C0-a′ 撤回コメント参照)。その際、completedSummary.recent の重複排除を
// 「退場タイマーがまだ生きているか(旧 done-exit.ts の isDoneRowStillInPlace)」から「positionMemory で
// この id は本体セクションに所属しているか(=時間非依存の純粋な所属判定)」へ置き換えた。
//
// server はミューテーション確定と同時に completedSummary を加算済みで返す契約なので、「このカード
// インスタンスの生存中に done してその場に残っている行」は本体側(due セクション)と completedSummary
// 側の両方に現れうる。二重表示を避けるため、本体に所属している(=positionMemory に非 completed
// セクションで実在する)id は completedSummary 側でスキップする。
//
// toggle-coalesce.ts / render-gate.ts と同じ「DOM/タイマー/ネットワークに依存しない決定だけを抽出して
// テストで固定する」規律に従い、判定を1関数へ切り出す(消費者は todos-entry.ts の renderAll・
// sec-completed 構築部)。
// =============================================================================

/**
 * completedSummary.recent の行 id が「本体セクション側に所属している(=completedSummary 側では
 * 出さない)」かを判定する。入力は positionMemory.get(id)?.section(そのカードインスタンスで記憶した
 * 表示セクション。id が positionMemory に無ければ undefined)。
 *
 * - `undefined`(positionMemory に無い): 本体に居ない → **false**(completedSummary が唯一の表示
 *   チャンネル。born-completed で一度も本体に現れていない/クリーン再セクショニング後の行など)。
 * - `"completed"`(インスタンス誕生時に既に完了だった born-completed 行): 本体の completed バケツは
 *   renderAll がもう描画に使わない死の経路なので、これも本体に「見える形で」は居ない → **false**
 *   (completedSummary が表示チャンネル。§7.8 v2.2 item 3 ⑥ の completed <details> の受け皿)。
 * - それ以外の due セクション("overdue"/"today"/"upcoming"/"noDue"): このインスタンス生存中に done して
 *   その場に取消線で残っている行 → **true**(本体側に見えているので completedSummary 側は隠す)。
 *
 * 次の fresh render / リスト切替の resetPositionMemory で positionMemory がクリアされると、この id は
 * undefined 側へ倒れ(false)、completedSummary 側だけに現れる(=完了済みへ「移動」して見える)。
 */
export function completedRowIsInBody(memSection: string | undefined): boolean {
	return memSection !== undefined && memSection !== "completed";
}
