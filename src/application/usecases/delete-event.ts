// =============================================================================
// DeleteEvent ユースケース — VEVENT の削除(E-3 スライス S1)
// =============================================================================
//
// 【DeleteTodo と対称】無条件削除(ifMatchEtag: null)。chat 経由の削除は If-Match 前提が無い
// (delete-todo.ts 冒頭コメントの理由がそのまま当てはまる — chat は「id で消して」と言うだけで
// ETag を保持していない)。iOS 実機も DELETE では If-Match を送らず無条件削除する。
//
// 【戻り値 { removed: Event } の理由】削除直前の Event を返す(ghost 表示用)。lookupEvent が
// 内部 read した更新前レンズを整形するだけで追加往復は無い(delete-todo.ts と同じレイテンシ判断)。
// =============================================================================

import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { zoneResolverFor } from "../../domain/ical";
import { DeleteCalendarObject } from "./delete-calendar-object";
import { lookupEvent, EventNotFoundError } from "./event-lookup";
import { eventFromVEvent, type Event } from "./event-dto";
import type { CalendarObjectResourceRepository } from "../ports";

export interface DeleteEventInput {
	owner: PrincipalRef;
	/** 削除対象の VEVENT UID。 */
	eventId: string;
	/** 保存先コレクション ID。省略時は "calendar"。 */
	calendarId?: string;
}

export interface DeleteEventOutput {
	/** 削除された VEVENT の「削除直前」スナップショット(ghost 表示用)。 */
	removed: Event;
}

export class DeleteEvent {
	constructor(
		private readonly deleteCalendarObject: DeleteCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: DeleteEventInput): Promise<DeleteEventOutput> {
		const collectionId = mkCollectionId(input.calendarId ?? "calendar");
		const looked = await lookupEvent(this.resourceRepo, input.owner, collectionId, input.eventId);
		if (looked === null) {
			throw new EventNotFoundError(input.eventId);
		}

		// 削除直前スナップショット(削除後はもう読めないので必ず先に作る)。zoneOf は resource の
		// VCALENDAR レンズから作る(VTIMEZONE を含むので zoned な DTSTART を正しく整形できる)。
		const removed = eventFromVEvent(looked.vevent, zoneResolverFor(looked.resource.payload), "UTC");

		await this.deleteCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: looked.resourceUri,
			ifMatchEtag: null,
		});

		return { removed };
	}
}
