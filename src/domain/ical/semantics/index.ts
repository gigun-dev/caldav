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

// 集約ルート(VCALENDAR)。ここから events()/todos()/timezones() で子レンズへ辿る。
export { ICalendarObject } from "./icalendar-object";

// 各コンポーネントのレンズ。
export { VEvent } from "./vevent";
export { VTodo } from "./vtodo";
export { VTimezone } from "./vtimezone";
export { VAlarm } from "./valarm";
