// =============================================================================
// presentation/mcp/ui/completed-summary-view.ts — ① completedSummary をカードの
//   「今表示中のリスト」スコープへ絞る純関数コア(2026-07-24)
// =============================================================================
// 【背景】server は completedSummary を owner 全体で計算して返す({total, recent, byCalendar})。
// symptom B の治療原則「completedSummary はどんな view の push でも不変」を守るため、この値自体は
// due 窓・calendarId スコープから独立している(server.ts の buildTodosViewModel 参照)。しかし
// カードが単一リスト(例 reading list)を表示しているとき、owner 全体の total(実機で115件)を
// そのまま「完了済み(115件)」と出すと、そのリスト由来でない完了行までノイズになる。
//
// 【この関数の責務】completedSummary(不変)+ 現在の表示スコープ(currentCalendarId)→ 表示用の
// {total, recent} を導出する(byCalendar から総数を引き、recent を calendarId でフィルタ)。
// 「すべて」表示・未選択では owner 全体をそのまま返す(従来挙動)。DOM・module state・ネットワークに
// 触れない決定ロジックだけを toggle-coalesce.ts / completed-dedup.ts と同じ規律で切り出し、bun test
// から直接固定する(消費者は todos-entry.ts の renderAll・sec-completed 構築部)。
// =============================================================================

import { ALL_CALENDARS_ID } from "./todos-calendar-filter";

/** scopeCompletedSummary が要求する completedSummary.recent の最小構造(由来判別に calendarId が要る)。 */
export interface CompletedRecentItem {
	id: string;
	calendarId?: string;
}

/** scopeCompletedSummary の入力(server の TodosViewModel.completedSummary と同型の最小部分)。 */
export interface CompletedSummaryShape<R extends CompletedRecentItem> {
	total: number;
	recent: R[];
	// byCalendar は additive フィールド。旧応答(byCalendar 不在)でも壊れないよう optional で受け、
	// 単一リスト表示のときは `?? {}` 経由で「その内訳は 0 件」に degrade する(下記コメント)。
	byCalendar?: { [calendarId: string]: number };
}

/**
 * completedSummary を「今表示中のリスト」スコープへ絞る。
 *
 * @param summary server が返した owner 全体の completedSummary(null=未受領なら null を返す)。
 * @param currentCalendarId カードの表示スコープ。
 *   - 実在のコレクション ID(単一リスト表示)→ byCalendar[id] ?? 0 を総数にし、recent をその
 *     リスト出身(snap.calendarId === id)のみへフィルタする。total が 0(そのリストに完了行が
 *     無い)なら total:0 を返す — 呼び出し側はこれを見て完了済みセクションごと非表示にする。
 *   - ALL_CALENDARS_ID(「すべて」表示)/ null(未選択)→ owner 全体をそのまま返す(従来挙動)。
 * @returns 表示用の {total, recent}。summary が null なら null。
 *
 * 【なぜ recent も byCalendar 件数ではなくフィルタで絞るか】byCalendar[id] はそのリストの完了総数
 * (例 3 件)だが、recent は owner 横断の直近 COMPLETED_RECENT_MAX 件しか含まないため、そのリスト
 * 由来の行が recent に何件入っているかは byCalendar[id] とは無関係(recent には別リストの新しい完了が
 * 先に詰まっていて、当該リストの行が1件も入らないこともある)。よって「表示する行」は recent を
 * calendarId でフィルタした実体、「総数バッジ」は byCalendar[id] の件数、という2系統で正しく出す
 * (recent.length と total がズレるのは正常 — 総数の方が多ければ呼び出し側が「他 n件」を出す)。
 */
export function scopeCompletedSummary<R extends CompletedRecentItem>(
	summary: CompletedSummaryShape<R> | null,
	currentCalendarId: string | null,
): { total: number; recent: R[] } | null {
	if (summary === null) return null;
	// 「すべて」/未選択は owner 全体をそのまま(従来挙動)。recent は元の配列参照を返さず slice して
	// 呼び出し側の破壊的操作(sort 等)から元 state を守る(他の純関数と同じ防御規律)。
	if (currentCalendarId === null || currentCalendarId === ALL_CALENDARS_ID) {
		return { total: summary.total, recent: summary.recent.slice() };
	}
	// 単一リスト表示: 総数は byCalendar の内訳、recent はその出身のみ。
	const total = summary.byCalendar?.[currentCalendarId] ?? 0;
	const recent = summary.recent.filter((r) => r.calendarId === currentCalendarId);
	return { total, recent };
}
