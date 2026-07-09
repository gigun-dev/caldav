// =============================================================================
// CalDAV リソースコンテキスト(RFC 4918/4791/6578)の公開 API
// =============================================================================
//
// このモジュールが CalDAV ドメイン層の入口。application/presentation 層や将来の
// @caldav/core パッケージ利用側は、内部ファイルの相対パスではなくここ経由で import する
// (CLAUDE.md「パッケージ構成」= 公開 API 面をここに集約)。
//
// このコンテキストは iCalendar コンテキスト(../ical)を「順応者」として利用する:
//   - CalendarObjectResource.payload は ICalendarObject(../ical の集約)
//   - put-preconditions は ../ical の parse / validate を使って R1/R3/R7 + I1〜I10 を判定
// DAV の都合(uri/etag/sync)は一切 iCalendar 側へ持ち込まない(境界の向き。03 §2)。
//
// 公開するもの:
//   - values/*: ETag / SyncToken / CTag / ComponentKind / 識別子 / AppleColor
//   - 集約: Principal / CalendarCollection(+ SyncChange)/ CalendarObjectResource
//   - ドメインサービス: put-preconditions(PUT precondition 判定)
// =============================================================================

// 値オブジェクト群。
export * from "./values";

// 集約ルート。
export { Principal } from "./principal";
export {
	CalendarCollection,
	SyncChange,
	type ChangeKind,
	type SyncReport,
	type ChangesSinceResult,
	type CalendarCollectionInit,
} from "./calendar-collection";
export { CalendarObjectResource, InvalidResourceError } from "./calendar-object-resource";

// ドメインサービス: PUT precondition 検証。
export {
	checkPutPreconditions,
	checkResourceStructure,
	checkValidCalendarObjectResource,
	checkSupportedComponent,
	checkNoUidConflict,
	PreconditionViolation,
	UNLIMITED_POLICY,
	type PreconditionName,
	type ResourceRule,
	type ServerPolicy,
	type PutPreconditionInput,
} from "./put-preconditions";
