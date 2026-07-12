// =============================================================================
// semantics/ 層の公開 API 集約(re-export)
// =============================================================================
//
// RFC 5545 §3.6〜3.8 の「意味論レンズ」群を1箇所から取り出せるようにする。
// 各レンズは汎用構造 Component を包んで型付きアクセサと不変条件検証(I1〜I10 / VALARM 細則)を
// 提供する。独自データ構造への変換はしない(モデル図 §1-1)。上位(application/presentation)は
// このモジュール、あるいは ical/index.ts 経由でのみ import する。
// =============================================================================

// 不変条件違反(validate の返り値要素)と識別子。
export { InvariantViolation, type InvariantId } from "./errors";

// 集約ルート(VCALENDAR)。ここから events()/todos()/journals()/timezones() で子レンズへ辿る。
export { ICalendarObject } from "./icalendar-object";

// 各コンポーネントのレンズ。
export { VEvent } from "./vevent";
export { VTodo } from "./vtodo";
export { VJournal } from "./vjournal";
export { VTimezone } from "./vtimezone";
export { VAlarm } from "./valarm";

// E-1 スライス①: VTODO 新規組み立て(CreateTodo 専用。vtodo.ts の読み取りレンズとは別ファイル
// — vtodo-write.ts 冒頭コメントの「CreateTodo 以外で使わない」方針を参照)。
export { buildVTodoCalendar, type VTodoFields } from "./vtodo-write";

// E-1 スライス②-a: サーバー発 VTODO の生成プロパティ(単一情報源)。CreateTodo(stampCreate)に
// 加え、将来の UpdateTodo/CompleteTodo(②-b/②-c)が stampUpdate を再利用する想定で公開する。
export { CF_ABSOLUTE_EPOCH_OFFSET_SECONDS, stampCreate, stampUpdate, type NowStamp } from "./vtodo-stamp";

// E-1 スライス②-b: 既存 VTODO の部分更新プリミティブ(UpdateTodo/CompleteTodo/DeleteTodo が使う
// patch 方式。vtodo-write.ts の buildVTodoCalendar とは対称的に「既存 Component の一部だけ書き
// 換える」ロスレス編集を担う)。
export {
	applyCompletion,
	applyReopen,
	patchVTodoFields,
	type VTodoPatchFields,
} from "./vtodo-patch";

// E-1 スライス②-c: 反復 VTODO の完了(D4 モデル)。CompleteTodo/UpdateTodo が
// application/usecases/recurring-completion.ts 経由でこの2関数を使う。
export {
	buildCompletionSnapshot,
	advanceMasterToNextOccurrence,
	type CompletionSnapshotIds,
	type AdvanceResult,
} from "./vtodo-recurrence";
