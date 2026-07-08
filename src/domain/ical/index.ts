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
// =============================================================================

export type { Component, Parameter, Property } from "./structure/types";
export { parse, ParseError } from "./parse/parser";
export { serialize, SerializeError } from "./serialize/serializer";
