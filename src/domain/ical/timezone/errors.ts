// =============================================================================
// timezone/errors — TZ 解決層の失敗を表す例外
// =============================================================================
//
// 【設計方針(docs/modeling/08 §3・§6)】
// TZ 解決チェーン(IANA 直引き → Windows 名マップ → VTIMEZONE 推測)が全て外れたときは
// 「明示エラー」にする。暗黙のフォールバック(勝手に UTC 扱い等)は Home Assistant の
// 「終日イベントが EST で前日 20 時開始」型の事故(08 §3 落とし穴リスト)を生むため禁止。
// values/errors.ts の InvalidValueError と別型にするのは、あちらが「値の構文が壊れている」
// のに対し、こちらは「値は構文上正しいが解釈に必要な外部知識(tzdb)で解決できない」
// という失敗の種類が違うため。呼び出し側(application 層)はこの型で catch して
// CalDAV precondition エラー等へ写像する。
// =============================================================================

/** TZID をタイムゾーンとして解決できなかったことを表す例外。 */
export class TimezoneResolutionError extends Error {
	constructor(
		/** 解決を試みた TZID の原文(例 "Customized Time Zone")。 */
		readonly tzid: string,
		/** 人間向けの理由(どのステップまで試したか)。 */
		readonly reason: string,
	) {
		super(`cannot resolve TZID "${tzid}": ${reason}`);
		this.name = "TimezoneResolutionError";
	}
}

/**
 * VTIMEZONE 生成(vtimezone-write.ts の buildVTimezone)が、DST(夏時間)遷移を持つゾーンに
 * 対して呼ばれたことを表す例外。
 *
 * 【TimezoneResolutionError と型を分ける理由】
 * あちらは「TZID 文字列から IANA 名を決定できない」失敗(パース段階)。こちらは
 * 「IANA 名は確定しているが、正しい VTIMEZONE を組み立てられない」失敗(生成段階)。
 * 失敗の種類が違う(名前解決 vs 構造生成)ので、呼び出し側(application 層)が
 * instanceof で区別して別の CalDAV エラーメッセージへ写像できるよう型を分けた。
 *
 * 【Phase 1 は固定オフセットゾーンのみ、という判断をここに明記】
 * buildVTimezone は STANDARD 1本だけの最小 VTIMEZONE(§3.6.5)を返す実装であり、
 * DST ゾーン(America/New_York 等、年内にオフセットが変わるゾーン)の STANDARD+DAYLIGHT
 * ペア + RRULE/RDATE による遷移規則の生成には対応しない(Phase 2 でスコープ外。
 * 実装すると「観測窓の外で誤ったオフセットを返す VTIMEZONE」を黙って生成してしまう
 * リスクの方が、機能が無いことより有害と判断した — CLAUDE.md ロスレス優先・
 * 08 §3「暗黙フォールバック禁止」と同じ考え方をここでも適用)。
 */
export class UnsupportedTimeZoneError extends Error {
	constructor(
		/** 生成を試みた IANA ゾーン名(例 "America/New_York")。 */
		readonly ianaId: string,
	) {
		super(
			`cannot generate VTIMEZONE for "${ianaId}": zone has offset transitions in the requested window. ` +
				"Phase 1 VTIMEZONE generation supports fixed-offset zones only " +
				"(DST zones such as America/New_York are not yet supported).",
		);
		this.name = "UnsupportedTimeZoneError";
	}
}
