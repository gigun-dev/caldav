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
