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
	/** delete / move のみ。TaskSnapshot に統一(旧 RemovedTask を廃止・案X)。 */
	removed?: TaskSnapshot[];
	/**
	 * move-todo のみ。移動先コレクション ID。
	 *
	 * 【なぜ必要か(delete と move のゴースト区別)】move-todo は「移動元から見れば削除」なので
	 * removed の中身(TaskSnapshot)自体は delete-todo と同じ形で足りるが、UI(todos-entry.ts 側)は
	 * 「消えた」ゴーストと「よそへ移った」ゴーストでラベル/演出を変えたい(親タスク仕様)。
	 * movedTo が存在するかどうかだけを判別材料にする — removed 配列の各要素にフラグを持たせる
	 * より、応答全体で「これは move 操作の結果である」ことを1箇所で表現する方が単純
	 * (1回の move-todo 呼び出しは常に1件しか動かさないため、配列要素ごとの区別は不要)。
	 */
	movedTo?: string;
	/**
	 * 【E-2 view 状態非保持バグ修正・2026-07-14】この一覧を生成した「ビュー引数」の echo。
	 *
	 * 【なぜ必要か(このフィールドが無いと起きていた不具合)】
	 * MCP Apps はステートレス設計で、UI(todos-entry.ts)は自分が今どんなビュー(includeCompleted 等)
	 * で一覧を開いたのかを保持していなかった。そのため list-todos includeCompleted:true で開いた後、
	 * focus refetch(refresh-todos)や mutation 後の再取得が「引数なし=既定(未完了のみ)」で走り、
	 * 完了済みタスクが UI から全部消える(reopen したら消える等)。サーバーが「今の一覧はどのビューか」を
	 * echo し、UI がそれを currentView として保持することで、後続の再取得に同じビューを引き継げる。
	 *
	 * 【additive・後方互換】buildTodosViewModel は「非 undefined の引数があるときだけ」view を載せる。
	 * 全部 undefined(既定ビュー)なら view キー自体を省く — 旧 UI/旧テストは view 不在でも壊れない
	 * (mutate 系は現状 view 引数を取らないので view 無し=既定ビューのまま。仕様3の判断)。
	 * dueBefore/dueAfter も echo するが、mutate 系は指定しないため実質 list/refresh でのみ載る。
	 */
	view?: {
		includeCompleted?: boolean;
		dueBefore?: string;
		dueAfter?: string;
	};
}
