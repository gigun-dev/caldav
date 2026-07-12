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
// 【戻り値を Promise<void> にする理由】
// DeleteCalendarObject.execute 自体が Promise<void> を返す既存慣行(delete-calendar-object.ts)。
// 削除後に返すべき意味のある DTO が無い(Task は「削除された」状態を表現できない)ため、
// この既存パターンにそのまま揃える(CreateTodo/UpdateTodo/CompleteTodo が { task: Task } を
// 返すのとは非対称になるが、「削除は返すものが無い」という意味では自然な非対称)。
// =============================================================================

import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { DeleteCalendarObject } from "./delete-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface DeleteTodoInput {
	owner: PrincipalRef;
	/** 削除対象の VTODO UID。 */
	todoId: string;
	/** 保存先コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
}

export class DeleteTodo {
	constructor(
		private readonly deleteCalendarObject: DeleteCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: DeleteTodoInput): Promise<void> {
		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		await this.deleteCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: looked.resourceUri,
			ifMatchEtag: null,
		});
	}
}
