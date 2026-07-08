// =============================================================================
// iCalendar コンテキスト(RFC 5545)汎用構造層の公開 API
// =============================================================================
//
// このモジュールが iCalendar 構造層の入口。CalDAV(presentation/application)側や
// 将来の semantics 層は、内部ファイルの相対パスではなくここ経由で import すること。
// 将来 `@caldav/ical` パッケージとして切り出す際の公開 API 面(CLAUDE.md「パッケージ構成」)
// を、いまからこの index に集約しておく。
//
// 公開するもの:
//   - 型: Component / Property / Parameter(汎用構造。ロスレス往復の担保だけを責務とする)
//   - parse: ICS 文字列 → Component(通常ルートは VCALENDAR)
//   - serialize: Component → ICS 文字列(CRLF・75 オクテット折り畳み)
//   - ParseError / SerializeError: それぞれの失敗を表す例外
//   - values/*: RFC 5545 §3.3 の「生値 ↔ 型付き値」コーデック群。
//     Property.value 自体はロスレス保持のため string のままだが、application/semantics 層が
//     DTSTART や RRULE を安全に扱うときはここから公開される値オブジェクトを使う。
//   - semantics/*: RFC 5545 §3.6〜3.8 の意味論レンズ群。ICalendarObject(VCALENDAR 集約ルート)
//     / VEvent / VTodo / VTimezone / VAlarm と、不変条件違反 InvariantViolation。
//     いずれも Component を包む「読み取り + validate」のレンズで、独自構造には変換しない
//     (ロスレス往復を壊さないため。モデル図 §1-1)。application 層(PUT/REPORT ユースケース)は
//     ここから型付きにカレンダーデータへアクセスし、validate() で precondition 診断を得る。
// =============================================================================

export type { Component, Parameter, Property } from "./structure/types";
export { parse, ParseError } from "./parse/parser";
export { serialize, SerializeError } from "./serialize/serializer";
export * from "./values";
export * from "./semantics";
