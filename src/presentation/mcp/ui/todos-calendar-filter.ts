// =============================================================================
// presentation/mcp/ui/todos-calendar-filter.ts — K3(2026-07-23): todos カードのリスト切替を
//   「初回に全 VTODO コレクション横断取得 → 切替はクライアント側フィルタ」にするための純関数コア
// =============================================================================
// 【なぜ切り出すか】todos-entry.ts はブラウザ専用エントリで bun test から直接 import できない
// (DOM 前提・ファイル冒頭コメント参照)。toggle-coalesce.ts / done-exit.ts と同じ規律で、
// 「状態合成のルール」だけを DOM・ネットワーク・module state から切り離した純関数として
// ここに置き、todos-entry.ts はこれを import して module state(tasks/confirmedTasks/
// currentCalendarId)へ適用するだけにする。
//
// 【この2関数が担う設計(概要。詳細は各関数の JSDoc)】
//   - mergeTasksByCalendar: サーバー応答(横断 or 単一コレクション)を「保持中の横断キャッシュ」へ
//     合成する。1回の mutate(単一コレクション応答)で他リストのキャッシュを消さないための要。
//   - filterTasksByCalendar: 横断キャッシュから「今表示中のリスト」だけを取り出す。renderAll の
//     セクション計算はこの絞り込み後の配列だけを見る。
// =============================================================================

/** mergeTasksByCalendar/filterTasksByCalendar が要求する最小構造。TodoItem を直接 import せず
 *  構造的部分型で受ける(todos-entry.ts の TodoItem はこれに自然に適合する — toggle-coalesce.ts の
 *  mergeCompletedBase と同じ「ui は末端」の設計)。 */
export interface CalendarTaggedItem {
	id: string;
	calendarId?: string;
}

/**
 * K3: 応答 tasks を「保持中の横断キャッシュ」へ合成する。
 *
 * 【設計】
 *   - incomingCalendarId === null(owner 横断応答: calendarId 省略の list-todos/refresh-todos、
 *     または calendarId フィールド自体が無い旧応答/フィクスチャ)→ nextTasks は owner 配下の
 *     全 VTODO を含む完全な最新値として扱い、丸ごと置き換える。
 *   - incomingCalendarId が非 null(単一コレクション応答: 明示 calendarId 指定の list-todos、
 *     または mutate 系の確定一覧)→ そのコレクション由来の行だけを新データへ差し替え、
 *     他コレクションの行(prev のうち calendarId が一致しないもの)は保持する
 *     (merge-by-calendarId)。1回の mutate(例: create-todo を calendarId:"tasks" で実行)で
 *     他リスト(例 "reading-list")のキャッシュを消してしまうと、直後に switchCalendar で
 *     そちらへ切り替えたときネットワーク往復ゼロの前提が崩れて空表示になる — それを防ぐ。
 *   - prev の行で calendarId が undefined(旧応答/テストフィクスチャ由来)は「所属不明」として
 *     誤って消さない安全側で常に保持する。
 *
 * 【なぜ diff(computeSyncDiff)より前にこの合成を行う必要があるか(呼び出し側の責務)】
 * サーバー確定一覧の「見た目の差分」(sync 由来の追加/削除)は、この関数が返す **合成後** の値を
 * 次の confirmedTasks として比較しないと、単一コレクション応答(他コレクションの行を含まない)を
 * そのまま次値にした場合に「他コレクションの行が全部消えた」という偽の削除を検出してしまう
 * (呼び出し側 todos-entry.ts の applyStructuredContent 参照)。
 */
export function mergeTasksByCalendar<T extends CalendarTaggedItem>(
	prev: readonly T[] | null,
	incomingCalendarId: string | null,
	nextTasks: readonly T[],
): T[] {
	if (incomingCalendarId === null) return nextTasks.slice();
	// calendarId !== incomingCalendarId で十分(undefined も自然に「不一致」= 保持される)。
	// 明示的に `t.calendarId !== undefined &&` を足さない: 足すと不明行まで「一致扱い」で除去されてしまい、
	// 「所属不明行は誤って消さない」という契約(このファイル冒頭の JSDoc)に反する(実装時に一度踏んだ誤り)。
	const kept = (prev ?? []).filter((t) => t.calendarId !== incomingCalendarId);
	return kept.concat(nextTasks);
}

/**
 * K3: renderAll のセクション計算に渡す直前で「今表示中のリスト」だけへ絞り込む。
 * calendarId が null(未選択。横断応答をまだ1件も受けていない・VTODO コレクションが無い等)の
 * ときは絞り込まず全件を返す(空表示より「とりあえず何か見せる」degrade を優先)。
 * calendarId が undefined の行(旧応答/フィクスチャ由来)は除外しない(取りこぼしより過剰表示の
 * 方が実害が小さい判断)。
 */
export function filterTasksByCalendar<T extends CalendarTaggedItem>(
	items: readonly T[],
	calendarId: string | null,
): T[] {
	if (calendarId === null) return items.slice();
	return items.filter((t) => t.calendarId === undefined || t.calendarId === calendarId);
}
