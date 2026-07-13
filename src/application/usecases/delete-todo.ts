// =============================================================================
// DeleteTodo ユースケース — VTODO の削除(方向性 E-1 スライス②-b)
// =============================================================================
//
// 【DeleteCalendarObject を無条件(ifMatchEtag: null)で呼ぶ理由】
// DeleteCalendarObject 自体は If-Match による楽観ロック削除をサポートするが(delete-calendar-
// object.ts)、DeleteTodo(chat 駆動)はあえてこれを使わず常に無条件削除にする。
// 理由: chat 経由の削除フローには iOS の If-Match 前提(直前に GET/PROPFIND で取得した ETag を
// 使う)が無い — chat セッションは「id で削除して」と言うだけで、呼び出し元(MCP クライアント)
// が事前に ETag を保持している保証がない。もし DeleteTodo が lookupTodo で取得した ETag を
// If-Match に使うと、chat 中に他プロセス(iOS 本体)が同じ VTODO を編集しただけで
// DeleteETagMismatchError(412 相当)になり、ユーザーから見ると「消してと言ったのに消えない」
// という不可解な失敗になる。iOS 実機自身も DELETE では If-Match を送らず無条件削除を行う
// (docs/modeling/06 実測)。よって chat UX 優先で無条件削除にする。
//
// 【戻り値を { removed: Task } にする(旧 Promise<void> からの変更・2026-07-14)】
// ②-b 実装当初は「削除後に返すべき意味のある DTO が無い(Task は『削除された』状態を表現
// できない)」として Promise<void> にしていた。だが presentation(MCP delete-todo ツール)は
// 「消えた行を UI で ghost 表示する」ために削除直前の title/due を必要とし、それを別途
// ListTodos 全件読み(findTaskById)で拾っていた。本番計測で POST /mcp の p95≈1164ms の
// ボトルネックが D1 往復と判明したため、この UC が If-Match 解決も兼ねて既に読んでいる
// 更新前 VTODO(lookupTodo)を removed として返し、presentation の事前全件読みを1回省く。
// 「削除は返すものが無い」より「削除直前の状態こそ削除操作の唯一の記録なので返す価値がある」
// と判断を反転した(UpdateTodo が before を返すのと対称。update-todo.ts の JSDoc 参照)。
// removed は「削除された何か」なので kind 名も CreateTodo/UpdateTodo の task とは別名にする。
// =============================================================================

import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { DeleteCalendarObject } from "./delete-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import { taskFromVTodo, type Task } from "./task-dto";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface DeleteTodoInput {
	owner: PrincipalRef;
	/** 削除対象の VTODO UID。 */
	todoId: string;
	/** 保存先コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
}

// --- 出力 DTO ---

export interface DeleteTodoOutput {
	/**
	 * 削除された VTODO の「削除直前」スナップショット(ghost 表示用)。lookupTodo が If-Match 解決の
	 * ために読んだ更新前レンズから作る(追加の D1 往復は無い)。zoneOf/timeZone は既定
	 * (identity / UTC)— UpdateTodo.before と同じ理由(update-todo.ts の JSDoc)。
	 */
	removed: Task;
}

export class DeleteTodo {
	constructor(
		private readonly deleteCalendarObject: DeleteCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: DeleteTodoInput): Promise<DeleteTodoOutput> {
		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		// 削除直前スナップショット。DeleteCalendarObject を呼ぶと当然もう読めないので、必ず
		// 削除の前に作る(lookupTodo が読み済みの更新前レンズを整形するだけ = 追加往復無し)。
		const removed = taskFromVTodo(looked.vtodo);

		await this.deleteCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: looked.resourceUri,
			ifMatchEtag: null,
		});

		return { removed };
	}
}
