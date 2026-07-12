// =============================================================================
// application/usecases — ユースケース公開 API
// =============================================================================

// PUT
export {
	PutCalendarObject,
	ETagConditionError,
	CalDAVPreconditionError,
	CollectionNotFoundError,
	type PutCalendarObjectInput,
	type PutCalendarObjectOutput,
	type PutCalendarObjectError,
	type ETagCondition,
} from "./put-calendar-object";

// GET
export {
	GetCalendarObject,
	ResourceNotFoundError,
	type GetCalendarObjectInput,
	type GetCalendarObjectOutput,
} from "./get-calendar-object";

// DELETE
export {
	DeleteCalendarObject,
	DeleteTargetNotFoundError,
	DeleteETagMismatchError,
	type DeleteCalendarObjectInput,
} from "./delete-calendar-object";

// PROPFIND Depth:1 — コレクション一覧
export {
	ListCollections,
	type ListCollectionsInput,
	type ListCollectionsOutput,
} from "./list-collections";

// PROPFIND Depth:1 — リソース一覧
export {
	ListObjects,
	type ListObjectsInput,
	type ListObjectsOutput,
} from "./list-objects";

// MKCALENDAR
export {
	CreateCollection,
	CollectionAlreadyExistsError,
	type CreateCollectionInput,
	type CreateCollectionOutput,
} from "./create-collection";

// calendar-multiget REPORT
export {
	MultigetObjects,
	type MultigetObjectsInput,
	type MultigetObjectsOutput,
} from "./multiget-objects";

// sync-collection REPORT
export {
	SyncCollection,
	InvalidSyncTokenError,
	type SyncCollectionInput,
	type SyncCollectionOutput,
	type SyncDiff,
} from "./sync-collection";

// calendar-query REPORT(G-3)
export {
	CalendarQuery,
	type CalendarQueryInput,
	type CalendarQueryOutput,
	type CalendarQueryTimeRange,
} from "./calendar-query";

// free-busy-query REPORT(G-4)
export {
	ComputeFreeBusy,
	type ComputeFreeBusyInput,
	type ComputeFreeBusyOutput,
} from "./compute-free-busy";

// 展開済み occurrence 列挙(G-5: MCP list-events-expanded の共通 UC。09 §2)
export {
	ListOccurrences,
	type ListOccurrencesInput,
	type ListOccurrencesOutput,
	type ListOccurrencesEntry,
} from "./list-occurrences";

// 初期プロビジョニング
export {
	ProvisionDefaultCollections,
	DEFAULT_COLLECTION_SPECS,
	type ProvisionDefaultCollectionsInput,
	type ProvisionDefaultCollectionsOutput,
	type DefaultCollectionSpec,
} from "./provision-default-collections";

// PROPPATCH / MCP 等からのコレクション表示属性更新
export {
	UpdateCollectionProperties,
	type UpdateCollectionPropertiesInput,
} from "./update-collection-properties";

// Task DTO(E-2 UI-ready。CreateTodo/ListTodos 共通)
export { taskFromVTodo, type Task } from "./task-dto";

// MCP create-todo(方向性 E-1 スライス①)
export {
	CreateTodo,
	InvalidDueError,
	RecurrenceRequiresDueError,
	RecurrenceCountUntilConflictError,
	RecurrenceWeekdaysRequireWeeklyError,
	type CreateTodoInput,
	type CreateTodoOutput,
	type CreateTodoError,
	type CreateTodoRecurrenceInput,
} from "./create-todo";

// MCP list-todos(方向性 E-1 スライス①)
export {
	ListTodos,
	type ListTodosInput,
	type ListTodosOutput,
} from "./list-todos";

// todoId(UID) → リソース解決の共有ヘルパー(E-1 スライス②-b。Update/Complete/DeleteTodo 共通)
export { lookupTodo, TodoNotFoundError, type LookedUpTodo } from "./todo-lookup";

// Date → NowStamp 共有ヘルパー(E-1 スライス②-b。CreateTodo からも抽出して共用)
export { nowStampFromDate } from "./now-stamp";

// MCP update-todo(方向性 E-1 スライス②-b)
export {
	UpdateTodo,
	type UpdateTodoInput,
	type UpdateTodoOutput,
	type UpdateTodoError,
} from "./update-todo";

// MCP complete-todo(方向性 E-1 スライス②-b 単発 → ②-c 反復対応)
export {
	CompleteTodo,
	type CompleteTodoInput,
	type CompleteTodoOutput,
	type CompleteTodoError,
} from "./complete-todo";

// 反復 VTODO 完了オーケストレーション(D4 モデル。E-1 スライス②-c。CompleteTodo/UpdateTodo 共通)
export {
	completeRecurringTodo,
	type CompleteRecurringTodoDeps,
	type CompleteRecurringTodoArgs,
	type CompleteRecurringTodoResult,
} from "./recurring-completion";

// MCP delete-todo(方向性 E-1 スライス②-b)
export {
	DeleteTodo,
	type DeleteTodoInput,
} from "./delete-todo";
