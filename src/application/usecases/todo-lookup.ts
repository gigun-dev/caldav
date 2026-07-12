// =============================================================================
// todo-lookup — UpdateTodo/CompleteTodo/DeleteTodo 共通の「todoId → リソース」解決(②-b)
// =============================================================================
//
// 【なぜ `${todoId}.ics` 決め打ちで findByUri しないのか】
// CreateTodo はリソース URI を自分で `${uid}.ics` として採番するが(create-todo.ts)、
// iOS 自身が作成した VTODO のファイル名は UID と一致しないことがある(iOS の PUT リクエストは
// 独自の命名規則でリソース URI を選ぶ場合がある — 前作 hono-caldav でも観測済みの挙動)。
// よって「todoId(= UID)からリソースを特定する」処理は必ず findUriByUid 経由にし、
// URI を決め打ちしない。
//
// 【3 UC(Update/Complete/Delete)で共有する理由】
// 「lookup → 見つからなければ TodoNotFoundError」という手順は3 UC で完全に同一。
// 個別に書くと「lookup の失敗時に別のエラーメッセージを返してしまう」等の事故が起きやすいため
// 1箇所にまとめる。
// =============================================================================

import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type { CalendarObjectResource, ETag } from "../../domain/caldav";
import type { VTodo } from "../../domain/ical/semantics";
import type { CalendarObjectResourceRepository } from "../ports";

/** lookupTodo の戻り値。見つかったリソースとその VTODO レンズ・ETag をまとめて返す。 */
export interface LookedUpTodo {
	resource: CalendarObjectResource;
	resourceUri: ResourceUri;
	etag: ETag;
	vtodo: VTodo;
}

/**
 * リソースが見つからないエラー(todoId に一致する VTODO が存在しない)。
 * - UpdateTodo/CompleteTodo/DeleteTodo が共通で throw する。
 * - HTTP 相当: 404(ただしこの UC 群は DAV 経由ではなく MCP 経由が主眼のため、HTTP ステータスへの
 *   マッピングはこのエラー型自体には持たせない — put-calendar-object.ts の各エラー型と同じ方針)。
 */
export class TodoNotFoundError extends Error {
	readonly kind = "TodoNotFoundError" as const;
	constructor(readonly todoId: string) {
		super(`Todo not found: ${todoId}`);
		this.name = "TodoNotFoundError";
	}
}

/**
 * todoId(VTODO の UID)からリソース一式を解決する。
 * - findUriByUid で UID → URI(iOS 由来のファイル名でも解決できる。冒頭コメント参照)。
 * - 見つからなければ null(TodoNotFoundError を投げるかどうかは呼び出し側 UC に委ねる —
 *   このヘルパー自体はエラー型を1つに決め打ちしたくない将来の呼び出し側の自由度のため)。
 * - findByUri が理論上 null を返すことは無いはず(findUriByUid が返した URI は直前まで存在した
 *   はずのため)だが、並行削除等のレースを考慮して防御的に null を返す。
 * - resource.payload.todos()[0] が undefined(VTODO を含まないリソース)のケースも同様に防御的に
 *   null を返す(通常は起きない — CalendarObjectResource.fromIcs が componentKind を導出できる
 *   時点で該当コンポーネントは存在するはずだが、型上 undefined を否定できないため)。
 */
export async function lookupTodo(
	resourceRepo: CalendarObjectResourceRepository,
	owner: PrincipalRef,
	collectionId: CollectionId,
	todoId: string,
): Promise<LookedUpTodo | null> {
	const uri = await resourceRepo.findUriByUid(owner, collectionId, todoId);
	if (uri === null) return null;

	const resource = await resourceRepo.findByUri(owner, collectionId, uri);
	if (resource === null) return null;

	const vtodo = resource.payload.todos()[0];
	if (vtodo === undefined) return null;

	return { resource, resourceUri: uri, etag: resource.etag, vtodo };
}
