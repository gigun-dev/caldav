// =============================================================================
// timezone/effective-period — RFC 4791 §9.9 の実効 start/end 算出(VEVENT)
// =============================================================================
//
// 【この層の責務(§9.9 L5026 付近、原文照合済み docs/rfc/rfc4791.txt)】
// time-range フィルタは「全 recurrence instance の実効 DTSTART/DTEND/DURATION を推論して」
// 判定する MUST。ここはその「1 インスタンス(あるいは非反復イベント)の実効 [start, end)」を
// エポックミリ秒で算出する純関数。end は **非包含**(§9.9 の time-range の end と同じ半開区間)。
//
// 【ここでやらないこと】
// §9.9 の表にあるオーバーラップ条件式(例 "(start < DTEND AND end > DTSTART)")そのものは
// time-range フィルタ(G-3)の責務。ここは条件式に代入する DTSTART/DTEND の「実効値」を出すだけ。
// RRULE 展開(各インスタンスの DTSTART 列挙)も別(RecurrenceExpansion。03 §1-4)。ここは
// 「与えられた 1 件の dtstart/dtend/duration」から [start, end) を作ることに徹する。
//
// 【DURATION の加算規則(nominal vs exact。RFC 5545 §3.3.6 の意味論)】
// weeks/days は「壁時計で N 日進めてからゾーンで UTC 化」(nominal)。DST を跨ぐと実経過時間は
// 23h/25h になるが壁時計の時刻は維持される(「毎日 9:00 開始」の直感)。
// hours/minutes/seconds は UTC ミリ秒への正確加算(exact)。DST 跨ぎでも実経過時間どおり。
// これを混ぜないのが肝(先に UTC 化して日数を足すと壁時計がズレる。08 §3 展開順序の注意)。
// =============================================================================

import type { CalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";
import type { DurationValue } from "../values/duration-value";
import { calDateStartEpochMillis, calDateTimeToEpochMillis, localFieldsToEpochMillis } from "./instant";

/** 実効期間。半開区間 [startMillis, endMillis)。endMillis は非包含。 */
export interface EffectivePeriod {
	startMillis: number;
	endMillis: number;
}

/** 解決に必要なオプション(instant.ts と同じ注入方式)。 */
interface ResolveOpts {
	/** zoned の TZID → IANA 名(resolver 経由を注入)。 */
	zoneOf: (tzid: string) => string;
	/** floating / DATE を解釈するゾーン。既定 "UTC"(§7.3 の「サーバー任意」を暗黙にしない)。 */
	floatingTimeZone?: string;
}

/** CalDate | CalDateTime の型ガード(CalDateTime だけが kind を持つ)。 */
function isDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/**
 * dtstart/dtend の値(DATE or DATE-TIME)を UTC エポックミリ秒(実効瞬間)へ。
 * - DATE       → 現地 00:00(floatingTimeZone のゾーンで)。
 * - DATE-TIME  → kind に応じて calDateTimeToEpochMillis(utc/zoned/floating)。
 */
function instantOf(v: CalDate | CalDateTime, opts: ResolveOpts): number {
	const floatingTimeZone = opts.floatingTimeZone ?? "UTC";
	if (isDateTime(v)) {
		return calDateTimeToEpochMillis(v, { zoneOf: opts.zoneOf, floatingTimeZone });
	}
	// DATE 値: そのゾーンでの現地 00:00。
	return calDateStartEpochMillis(v, floatingTimeZone);
}

/**
 * dtstart の「壁時計フィールド」と「解釈ゾーン(IANA)」を取り出す。
 * DURATION の nominal 加算(壁時計で日数を足す)に必要。
 * - DATE      → 時分秒 0、ゾーン=floatingTimeZone
 * - floating  → フィールドそのまま、ゾーン=floatingTimeZone
 * - zoned     → フィールドそのまま、ゾーン=zoneOf(tzid)
 * - utc       → フィールドそのまま、ゾーン="UTC"(UTC 上の壁時計をそのまま扱う)
 */
function wallClockOf(
	v: CalDate | CalDateTime,
	opts: ResolveOpts,
): { fields: { year: number; month: number; day: number; hour: number; minute: number; second: number }; zone: string } {
	const floatingTimeZone = opts.floatingTimeZone ?? "UTC";
	if (!isDateTime(v)) {
		return { fields: { year: v.year, month: v.month, day: v.day, hour: 0, minute: 0, second: 0 }, zone: floatingTimeZone };
	}
	// うるう秒 60 は計算時 59 にクランプ(instant.ts と同方針。ここでも保険で潰す)。
	const second = v.second === 60 ? 59 : v.second;
	const fields = { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second };
	switch (v.kind) {
		case "utc":
			return { fields, zone: "UTC" };
		case "zoned":
			return { fields, zone: opts.zoneOf(v.tzid) };
		case "floating":
			return { fields, zone: floatingTimeZone };
	}
}

/**
 * 暦日加算(壁時計ベース)。年月日に deltaDays を足した年月日を返す。
 * Date.UTC を「TZ 非依存の暦カウンタ」として使う(getUTC* だけを読むのでローカル TZ 非依存)。
 * 月跨ぎ・閏年・年跨ぎは Date が正しく面倒を見る。時分秒は呼び出し側が据え置く。
 */
function addDays(
	f: { year: number; month: number; day: number },
	deltaDays: number,
): { year: number; month: number; day: number } {
	const t = Date.UTC(f.year, f.month - 1, f.day) + deltaDays * 86_400_000;
	const d = new Date(t);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * start(dtstart)+ DURATION → end のエポックミリ秒。
 * nominal(weeks/days)は壁時計で日数を足してからゾーンで UTC 化、exact(h/m/s)は UTC ms 加算。
 * 負 duration は符号どおり(nominal 日数も exact も符号反転)。
 */
function addDuration(dtstart: CalDate | CalDateTime, duration: DurationValue, opts: ResolveOpts): number {
	const sign = duration.positive ? 1 : -1;
	const { fields, zone } = wallClockOf(dtstart, opts);

	// --- nominal 部: weeks*7 + days を壁時計の暦日に加算 ---------------------
	// week 形態は weeks のみ(§3.3.6 の排他)。day/time 形態は days(+ 下の exact)。
	const nominalDays = (duration.weeks ?? 0) * 7 + (duration.days ?? 0);
	const shifted = addDays(fields, sign * nominalDays);
	// 日数をずらした壁時計を、dtstart の解釈ゾーンで UTC 化(DST 跨ぎで壁時計時刻は維持される)。
	const nominalEndMillis = localFieldsToEpochMillis(
		{ year: shifted.year, month: shifted.month, day: shifted.day, hour: fields.hour, minute: fields.minute, second: fields.second },
		zone,
	);

	// --- exact 部: hours/minutes/seconds は実時間として UTC ms へ正確加算 ----
	const exactSeconds = (duration.hours ?? 0) * 3600 + (duration.minutes ?? 0) * 60 + (duration.seconds ?? 0);
	return nominalEndMillis + sign * exactSeconds * 1000;
}

/**
 * RFC 4791 §9.9 の実効 [start, end) 算出(VEVENT)。
 *
 * 規則(§9.9 表の直前の規範文):
 *  - DTEND あり           → end = DTEND の実効瞬間(DATE なら現地 00:00。非包含)。
 *  - DURATION あり        → end = start + duration(nominal/exact は addDuration 参照)。
 *  - どちらも無し + DATE-TIME → 0 秒(end = start)。
 *  - どちらも無し + DATE      → +P1D(壁時計で翌日 00:00)。
 *
 * DTEND と DURATION が両方あるのは §3.6.1 で MUST NOT だが、ここは値検証層ではないので
 * 片方を優先するに留める(DTEND を優先。表も DTEND を先に見る)。整合性違反の検出は semantics 層(I 系)。
 */
export function effectiveEventPeriod(
	input: { dtstart: CalDate | CalDateTime; dtend?: CalDate | CalDateTime; duration?: DurationValue },
	opts: ResolveOpts,
): EffectivePeriod {
	const startMillis = instantOf(input.dtstart, opts);

	// ① DTEND あり(表の DTEND=Y 行)。DATE 値は非包含の現地 00:00(instantOf が処理)。
	if (input.dtend !== undefined) {
		return { startMillis, endMillis: instantOf(input.dtend, opts) };
	}

	// ② DURATION あり(表の DURATION=Y 行)。
	if (input.duration !== undefined) {
		return { startMillis, endMillis: addDuration(input.dtstart, input.duration, opts) };
	}

	// ③ どちらも無し。DTSTART の値型で分岐(§9.9: DATE-TIME→0 秒 / DATE→+P1D)。
	if (isDateTime(input.dtstart)) {
		// DATE-TIME: 継続時間 0 秒。end = start。
		return { startMillis, endMillis: startMillis };
	}
	// DATE: +P1D を壁時計で(翌日の現地 00:00)。DST があっても「翌日 00:00」を維持する nominal。
	const floatingTimeZone = opts.floatingTimeZone ?? "UTC";
	const next = addDays(input.dtstart, 1);
	const endMillis = calDateStartEpochMillis({ year: next.year, month: next.month, day: next.day }, floatingTimeZone);
	return { startMillis, endMillis };
}
