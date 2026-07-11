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
//   - timezone/*: TZ 解決層(docs/modeling/08 §6)。TZID(生文字列)→ IANA 名の解決チェーンと、
//     Intl/ICU による壁時計 ⇄ UTC エポック変換、RFC 4791 §9.9 の実効 [start, end) 算出。
//     VTIMEZONE の逐語評価はしない(IANA tzdb を正とする決着)。将来の RecurrenceExpansion /
//     time-range フィルタが土台に使う。zoned の TZID 解決関数(zoneOf)は resolver から注入する。
//   - semantics/*: RFC 5545 §3.6〜3.8 の意味論レンズ群。ICalendarObject(VCALENDAR 集約ルート)
//     / VEvent / VTodo / VJournal / VTimezone / VAlarm と、不変条件違反 InvariantViolation。
//     いずれも Component を包む「読み取り + validate」のレンズで、独自構造には変換しない
//     (ロスレス往復を壊さないため。モデル図 §1-1)。application 層(PUT/REPORT ユースケース)は
//     ここから型付きにカレンダーデータへアクセスし、validate() で precondition 診断を得る。
//   - recurrence/*: RRULE/RDATE/EXDATE/RECURRENCE-ID オーバーライドの総合展開
//     (RecurrenceExpansion ドメインサービス。モデル図 §1-4)。RRULE 反復だけは port
//     (RecurrenceIterator)で外部委譲し、domain 自体は ical.js を import しない
//     (実装は infrastructure/recurrence の ical.js アダプタ。docs/modeling/08 §5)。
//   - freebusy/*: RFC 4791 §7.10 free-busy-query REPORT のための FBTYPE 導出
//     (TRANSP/STATUS → BUSY/BUSY-TENTATIVE/FREE)+ 同一 FBTYPE の coalesce(G-4)。
// =============================================================================

export type { Component, Parameter, Property } from "./structure/types";
export { parse, ParseError } from "./parse/parser";
export { serialize, SerializeError } from "./serialize/serializer";
export * from "./values";
export * from "./semantics";
export * from "./timezone";
export * from "./recurrence";
export * from "./freebusy";
