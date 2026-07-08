// =============================================================================
// semantics/ 層 不変条件違反(InvariantViolation)
// =============================================================================
//
// 【なぜ「throw 一発」ではなく「全違反を配列で集める」方式なのか — 最重要の設計決定】
// docs/modeling/03 §1-3 の不変条件 I1〜I10 は「1個見つけたら即例外」で実装すると、
// CalDAV の PUT precondition 応答(RFC 4791 §5.3.2.1)で困る。あの応答は
// DAV:error の直下に「何がダメだったか」を要素で列挙してクライアントへ返す設計で、
// 「最初の1個」ではなく「見つかった違反すべて」を提示できたほうが親切だからだ。
// したがって semantics 層の各レンズは `validate(): InvariantViolation[]` を返し、
// 違反を throw せず値として積み上げる。空配列 = 妥当。
//
// 【値コーデックの throw との棲み分け】
// values/ 層(parseCalDateTime など)は「壊れた値」を InvalidValueError で throw する。
// レンズの「型付きアクセサ」(dtstart など)はその throw をそのまま伝播させてよい
// (壊れた値に型付きアクセスはそもそも不可能なので、握り潰す意味がない)。
// 一方 validate() の中では、値コーデックの throw を catch して InvariantViolation に
// 変換し「違反」として集める。アクセサと validate で throw/収集の方針が異なるのは、
// 用途(前者=正常データへの型付き読み取り / 後者=データ健全性の網羅診断)が違うため。
// =============================================================================

/**
 * 違反した不変条件の識別子。
 *
 * I1〜I10 は docs/modeling/03 の不変条件表(RFC 原文照合済み)にそのまま対応する。
 * `VALARM` だけは番号を持たない: VALARM の必須プロパティ規則(ACTION+TRIGGER、
 * DISPLAY→DESCRIPTION 等)は 03 の I 表ではなく 05-rfc-verification.md の「細則」に
 * 列挙されているため、番号ではなくコンポーネント名でタグ付けする。番号体系を歪めて
 * 無理に I11 等を新設するより、「表にある不変条件」と「細則」を型で区別できるほうが
 * 追跡しやすい、という判断。
 */
export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8" | "I9" | "I10" | "VALARM";

/**
 * 不変条件違反。例外ではなく「値」(validate が配列で返す要素)。
 *
 * - invariant: どの不変条件に違反したか(I1〜I10 / VALARM)。
 *   presentation 層が precondition 要素へマッピングする際のキーになる。
 * - component: 違反が見つかったコンポーネント名(VEVENT / VTODO / VCALENDAR …)。
 *   同一 VCALENDAR に複数 VEVENT があるとき「どのコンポーネントの話か」を絞るため。
 * - message: 人間可読の理由(RFC 節番号を添えておくとデバッグとレビューが速い)。
 *
 * Error を継承しない理由: これは投げるものではなく集めるもの。Error にすると
 * スタックトレース生成コストが違反1件ごとに乗るうえ、「throw されうる」誤解を招く。
 */
export class InvariantViolation {
	constructor(
		readonly invariant: InvariantId,
		readonly component: string,
		readonly message: string,
	) {}

	/** ログ・テスト表示用の1行表現。 */
	toString(): string {
		return `[${this.invariant}] ${this.component}: ${this.message}`;
	}
}
