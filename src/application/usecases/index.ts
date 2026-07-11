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
