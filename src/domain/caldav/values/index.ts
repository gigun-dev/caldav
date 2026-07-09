// =============================================================================
// CalDAV リソースコンテキスト values/ 層の公開 API 集約(re-export)
// =============================================================================
//
// ETag / SyncToken / CTag / ComponentKind / 識別子 / AppleColor をまとめて公開する。
// 集約(CalendarCollection 等)や put-preconditions、上位の application/presentation 層は
// 個別ファイルではなくこの index、あるいは caldav/index.ts 経由で import する
// (将来 @caldav/core パッケージに切り出す際の公開 API 面をここに集約しておく。CLAUDE.md)。
// =============================================================================

export { ETag, computeETag } from "./etag";
export { SyncToken, type SyncTokenParse } from "./sync-token";
export { CTag } from "./ctag";
export { COMPONENT_KINDS, type ComponentKind, isComponentKind, parseComponentKind } from "./component-kind";
export {
	type CollectionId,
	collectionId,
	type ResourceUri,
	resourceUri,
	type PrincipalPath,
	principalPath,
	type PrincipalRef,
	InvalidIdentifierError,
} from "./identifiers";
export { AppleColor } from "./apple-color";
