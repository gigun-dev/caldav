// =============================================================================
// event-lookup — UpdateEvent/DeleteEvent 共通の「eventId → リソース」解決(E-3 S1)
// =============================================================================
//
// 【todo-lookup.ts と対称】
// findUriByUid で UID → URI を解決する(iOS 発リソースのファイル名は UID と一致しないことが
// あるため決め打ちしない — todo-lookup.ts 冒頭コメント参照)。VTODO ではなく VEVENT のマスター
// (RECURRENCE-ID を持たない本体)を取り出す。occurrence 単位の編集はスコープ外(docs/modeling/12 §1)
// なので、override VEVENT ではなく必ずマスターを対象にする。
// =============================================================================

import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type { CalendarObjectResource, ETag } from "../../domain/caldav";
import type { VEvent } from "../../domain/ical/semantics";
import type { CalendarObjectResourceRepository } from "../ports";

/** lookupEvent の戻り値。見つかったリソースとそのマスター VEVENT レンズ・ETag をまとめて返す。 */
export interface LookedUpEvent {
	resource: CalendarObjectResource;
	resourceUri: ResourceUri;
	etag: ETag;
	vevent: VEvent;
}

/**
 * イベントが見つからないエラー(eventId に一致する VEVENT が存在しない)。
 * 【TodoNotFoundError と分ける理由】メッセージ・catch 分岐で「イベント」と「リマインダー」を
 * 区別できるようにする(todo-lookup.ts の TodoNotFoundError と対称の別型)。
 */
export class EventNotFoundError extends Error {
	readonly kind = "EventNotFoundError" as const;
	constructor(readonly eventId: string) {
		super(`Event not found: ${eventId}`);
		this.name = "EventNotFoundError";
	}
}

/**
 * eventId(VEVENT の UID)からリソース一式を解決する(todo-lookup.ts の lookupTodo と対称)。
 * マスター(RECURRENCE-ID 無し)を返す。見つからなければ null(エラー化は呼び出し側 UC に委ねる)。
 */
export async function lookupEvent(
	resourceRepo: CalendarObjectResourceRepository,
	owner: PrincipalRef,
	collectionId: CollectionId,
	eventId: string,
): Promise<LookedUpEvent | null> {
	const uri = await resourceRepo.findUriByUid(owner, collectionId, eventId);
	if (uri === null) return null;

	const resource = await resourceRepo.findByUri(owner, collectionId, uri);
	if (resource === null) return null;

	// マスター(RECURRENCE-ID 無し)を選ぶ。override VEVENT は occurrence 単位編集用でスコープ外。
	const vevent = resource.payload.events().find((e) => e.recurrenceId === undefined);
	if (vevent === undefined) return null;

	return { resource, resourceUri: uri, etag: resource.etag, vevent };
}
