// =============================================================================
// iCalendar 汎用構造層(RFC 5545 §3.1〜3.2)の型定義
// =============================================================================
//
// 【この層の責務】docs/modeling/03-domain-model.md §1-1 のとおり、RFC 5545 は
// 「汎用構造 + 意味論」の二層構造。この層は前者で、**ロスレス往復(round-trip)の
// 担保だけ**を責務とする。VEVENT の不変条件などの意味論は semantics/ 層(レンズ)が担う。
//
// 【最重要の設計決定: value は「生テキスト」のまま保持する】
// モデル図では Property.value は PropertyValue(代数的データ型)とあるが、
// 実装では汎用構造層の value を string(エスケープ解除もしない生の値部分)とし、
// 型付き値への解釈は values/ 層のコーデックが「必要になったときに」行う。
// 理由:
//   - RFC 4791 §5.3.3: X- 拡張の格納は MUST サポート。§5.3.4: サーバーがデータを
//     書き換えると PUT 応答で ETag を返せなくなる(MUST NOT)。
//     → 「解釈できた値だけ ADT に持ち上げる」方式は、解釈のバグ = データ改変になる。
//     生テキスト保持なら parse→serialize が構造的に恒等写像になり、往復が壊れようがない。
//   - iOS は X-APPLE-STRUCTURED-LOCATION 等、値の構文が公開されていないプロパティを
//     大量に送ってくる。全値型を先回りで ADT 化するのは不可能。
// これはモデル図の意図(「汎用構造の層が可逆性を担保する」)の忠実な実装であり、
// 乖離ではない。※図の PropertyValue ADT は values/ 層の型として実現する。
//
// 【エンティティ/値オブジェクトの扱い】
// モデル図では Component は entity、Property/Parameter は value object。
// TypeScript では全て readonly なプレーンオブジェクト(interface)で表現し、
// 同一性の議論は集約(CalendarObjectResource)側に任せる。
// クラスにしない理由: 構造層は「ただのデータ」であり、振る舞いは parse/serialize/
// semantics の各モジュールに関数として置くほうが層の分離が明確になるため。
// =============================================================================

/**
 * プロパティパラメータ(RFC 5545 §3.2)。例: `DTSTART;TZID=Asia/Tokyo:...` の `TZID=Asia/Tokyo`。
 *
 * - name: パラメータ名。**大文字に正規化して保持する**(§3.1: 名前は case-insensitive。
 *   正規化は「意味を保存する変換」なので、ロスレス往復の約束(意味論的等価)を壊さない。
 *   オクテット完全一致の往復ではなく意味保存の往復を狙う理由: iOS は小文字パラメータを
 *   送ってこないため実害がなく、正規化しておくと semantics 層の検索が単純になる)。
 * - values: パラメータ値のリスト。§3.2 で `PARAM=v1,v2` と複数値が許される
 *   (例: MEMBER, DELEGATED-TO)。単一値でも要素1のリストで統一する。
 *   値は DQUOTE を剥がした後の文字列を保持する(quoted か否かはシリアライズ時に
 *   値の内容 [COLON/SEMICOLON/COMMA を含むか] から機械的に再決定できるため、保持しない)。
 */
export interface Parameter {
	readonly name: string;
	readonly values: readonly string[];
}

/**
 * プロパティ(RFC 5545 §3.5)。コンテンツ行1行(unfold 後)に対応する。
 * 例: `SUMMARY;LANGUAGE=ja:会議` → { name: "SUMMARY", parameters: [LANGUAGE=ja], value: "会議" }
 *
 * - name: プロパティ名。Parameter.name と同じ理由で大文字に正規化して保持する。
 * - value: コロン以降の**生の値テキスト**。TEXT のエスケープ(\n \, \; \\)も
 *   解除しない。解釈は values/ 層のコーデックに委ねる(ファイル冒頭の設計決定を参照)。
 *   折り畳み(§3.1 の CRLF+WSP)だけは parse 時に解除済み。
 */
export interface Property {
	readonly name: string;
	readonly parameters: readonly Parameter[];
	readonly value: string;
}

/**
 * コンポーネント(RFC 5545 §3.6)。BEGIN:name 〜 END:name のブロック。
 * VCALENDAR も VEVENT も VALARM も、未知の X- コンポーネントも、すべてこの一つの型。
 *
 * - name: コンポーネント名(大文字正規化)。例: "VCALENDAR", "VEVENT", "X-MYCOMP"。
 * - properties: 出現順を保持したプロパティ列。順序を保持する理由: RFC 上プロパティの
 *   順序に意味はない(§3.6)が、並べ替えは「オクテット等価」を壊し PUT 応答の ETag 返却
 *   (RFC 4791 §5.3.4)に不利なため、受け取った順のまま持つ。
 * - components: サブコンポーネント列(VEVENT 内の VALARM 等)。同じく出現順を保持。
 *   RFC 5545 §3.6 はプロパティとサブコンポーネントの相対順も自由としているが、
 *   実データ(iOS/Google)は常に「プロパティ→サブコンポーネント」の順で送ってくるため、
 *   properties / components を分離して持つ(シリアライズもこの順で出す)。
 *   ※万一「プロパティの間にサブコンポーネント」が来てもパースは成功し、
 *     シリアライズで順序が変わるだけ(意味は保存される)。
 */
export interface Component {
	readonly name: string;
	readonly properties: readonly Property[];
	readonly components: readonly Component[];
}
