// =============================================================================
// RecurrenceIterator port — RRULE の「反復」だけを domain の外へ委譲する境界
// =============================================================================
//
// 【なぜ port & adapter で ical.js を隠すか(docs/modeling/08 §5 の決着)】
// ical.js は TZ 解決(VTIMEZONE 評価)も RRULE 反復もできるが、本リポジトリは TZ 解決を
// 「IANA tzdb を正とする」独自方針(timezone/resolver.ts, timezone/instant.ts)で既に実装済み。
// ical.js の TZ 機能(ICAL.Timezone / ICAL.TimezoneService)を混ぜて使うと解決経路が二重化し、
// 「どちらの解決結果が正か」が曖昧になる事故の元(08 §5)。よって ical.js への依存は
// 「RRULE の反復アルゴリズムだけ」に絞り、かつ domain 層が ical.js の型を一切知らずに済む
// ように port(このファイルの interface)で境界を切る。domain-is-pure の CI ルール
// (.dependency-cruiser.cjs)は「domain → application/infrastructure/presentation」の import を
// 検出するもので npm パッケージへの依存は対象外だが、意図としては domain はここでも
// ical.js を import しない(実装は infrastructure/recurrence/icaljs-rrule-iterator.ts に置く)。
//
// 【この port の責務(狭く保つ)】
// 「dtstart の壁時計フィールド + RecurrenceRule(UNTIL を除いた反復定義)を受け取り、
// “ローカル壁時計” の occurrence 開始時刻を昇順で列挙する」。タイムゾーンの概念を
// 持たない純粋な壁時計列挙器。UTC 化・UNTIL 判定・EXDATE/RDATE 反映・オーバーライド解決は
// すべて expansion.ts(domain サービス側)の責務で、ここではやらない。
// =============================================================================

import type { RecurrenceRule } from "../values/recurrence-rule";

/**
 * iterate() に渡す dtstart の壁時計フィールド。CalDate | CalDateTime のどちらから来ても
 * 「年月日時分秒」に潰して渡す(タイムゾーンの概念を持たないのが port の設計)。
 * DATE 値(終日)の場合は呼び出し側が hour/minute/second=0 を渡す。
 */
export interface RecurrenceWallClockFields {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

/**
 * RRULE 反復の port。実装(adapter)は infrastructure 層に置き、domain サービスへ DI で注入する。
 *
 * @param rule          RecurrenceRule。**呼び出し側が UNTIL を除いてから渡す**(expansion.ts の
 *                       責務。UNTIL の epoch 厳密判定は UTC 化後でないと正しくできないため、
 *                       ここでは「無限 or COUNT 打ち切り」の列挙だけをアダプタに担わせる)。
 * @param dtstartFields dtstart の壁時計フィールド(タイムゾーン非依存)。
 * @param isDate        true なら DATE(終日)値としての反復(時刻成分は無視される想定)。
 *                       adapter 側で ical.js の Time.isDate に反映する。
 * @returns 昇順の壁時計フィールド列。無限反復(COUNT も UNTIL も無い)の場合は
 *          呼び出し側が必要な分だけ消費してから止める前提の Iterable(遅延評価)。
 */
export interface RecurrenceIterator {
	iterate(rule: RecurrenceRule, dtstartFields: RecurrenceWallClockFields, isDate: boolean): Iterable<RecurrenceWallClockFields>;
}
