// =============================================================================
// mcp/todos-view-model — todos 系ツールの structuredContent 契約(E-2 スライス②)
// =============================================================================
//
// 【この型が担うもの(差分レンズ付きの確定一覧)】
// list-todos / refresh-todos(参照系)と create/complete/update/delete-todo(mutate 系)が
// 共通で返す structuredContent の形。UI(src/presentation/mcp/ui/、別実装)はこの構造を
// 受け取り、前回描画とのあいだで「becoming 差分」(追加が入ってくる・完了が抜けていく・
// 編集でフィールドが変わる)を描く。
//
// 【なぜ presentation 層に置くか】
// これは「MCP ツールが返す structuredContent の形」=プロトコル表現そのもの。CLAUDE.md の
// 「プロトコル知識は presentation に閉じ込める」方針どおり、application 層の Task DTO(意味的な
// タスク表現)とは別レイヤーの「UI 契約」としてここに置く。application 層は affected/removed の
// ような「MCP UI がどう差分を描くか」を知らない(複数入口方針: DAV/REST は差分レンズを使わない)。
//
// 【affected/removed が任意な理由】
// 参照系(list-todos/refresh-todos)は「今の確定状態」を返すだけで差分の発生源を持たないので
// affected/removed を付けない。mutate 系だけが「この操作で何が起きたか」を affected/removed に
// 載せる。UI は両方 optional として扱い、無ければ差分演出をせず素の一覧描画に degrade する。
// =============================================================================

import type { Task } from "../../application/usecases";

/**
 * 差分レンズ用の自己完結スナップショット(案X・2026-07-13 改修)。
 *
 * 【なぜこの型を導入したか(becoming-done が描けなかった不具合)】
 * mutate 系(complete/update/delete-todo)が返す確定一覧 tasks は
 * includeCompleted:false(未完了ビュー)固定 — buildTodosViewModel コメント参照。よって
 * 「いま完了した」タスクは completed 後 tasks から抜け、UI(todos-entry.ts)は sectionize の
 * inPlaceDone 判定(`t.completed && affectedById.get(t.id)?.kind === "completed"`)対象の行を
 * tasks の中に見つけられず、becoming-done(その場で取消線+凍結リング)を描けなかった。
 * 解決策(案X): affected/removed に「その行を tasks を見ずに描き切れる」だけの表示用
 * スナップショットを添える。旧 RemovedTask の ghost(title/due だけを添えて擬似行化する)発想を
 * AffectedTask にも広げ、両者を同じ TaskSnapshot 型に統一して対称にする。
 */
export interface TaskSnapshot {
	id: string;
	title: string;
	/** formatDueDisplay 済みの表示用短文("YYYY-MM-DD" or "YYYY-MM-DD HH:MM")。生 ISO ではない。無ければ省略。 */
	due?: string;
	/** formatPriorityDisplay 済みの表示語("高"/"中"/"低")。未設定(0)は省略。 */
	priority?: string;
	isAllDay?: boolean;
}

/**
 * mutate によって影響を受けた 1 タスクの差分メタ。
 * - added    : 新規作成された(create-todo / 反復完了スナップショットの新 UID)。
 * - completed: 完了した(単発 STATUS:COMPLETED、または反復 D4 の完了スナップショット)。
 * - reopened : 未完了に戻した(NEEDS-ACTION)。
 * - edited   : フィールドを編集した(changes に個別の before/after を載せる)。
 */
export interface AffectedTask {
	/** 対象タスクの id(VTODO UID)。UI は確定一覧 tasks 側の同 id 行と突き合わせて演出する。 */
	id: string;
	kind: "added" | "completed" | "reopened" | "edited";
	/**
	 * 確定一覧 tasks から抜けるケース(completed=未完了ビューから消える)でも UI が
	 * tasks を参照せず自己完結で becoming 行を描けるよう、対象タスクの表示用スナップショットを添える。
	 * tasks に実在する kind(added/reopened/edited)でも一貫性のため常に添える。
	 */
	task?: TaskSnapshot;
	/**
	 * kind:"edited" のときのフィールド単位の差分。
	 * before/after は「表示用の短い正規化文字列」であって生 ISO/RRULE ではない(build-diff.ts の
	 * 正規化ヘルパを参照)。長い値(notes/recurrence 等)は before/after を省き field だけ載せる
	 * ことがある(UI は「編集済みバッジ」に degrade する)。
	 */
	changes?: Array<{ field: string; before?: string; after?: string }>;
}

/**
 * todos 系ツールの structuredContent。tasks は「操作後のサーバー確定 一覧」で、
 * mutate 系は同じ ListTodos ユースケースを同 principal で再実行して得る(楽観的 UI ではなく
 * 確定値を返す = サーバーが真実)。
 */
export interface TodosViewModel {
	tasks: Task[];
	calendarId: string;
	timeZone: string;
	/** mutate 系のみ。参照系(list-todos/refresh-todos)は付けない。 */
	affected?: AffectedTask[];
	/** delete のみ。TaskSnapshot に統一(旧 RemovedTask を廃止・案X)。 */
	removed?: TaskSnapshot[];
}
