// =============================================================================
// UtcOffset — RFC 5545 §3.3.14 UTC-OFFSET 値型(VTIMEZONE の TZOFFSETTO/FROM)
// =============================================================================
//
// 【構文(§3.3.14)】
//   utc-offset = time-numzone
//   time-numzone = ("+" / "-") time-hour time-minute [time-second]
//   → 符号(必須)+ HH + MM + 任意の SS。例: +0900, -0800, +053000。
//
// 用途: VTIMEZONE(§3.6.5)の STANDARD/DAYLIGHT サブコンポーネントで、そのタイム
// ゾーンの UTC からのオフセットを表す。TZID 付き日時の絶対時刻解決に使う。
//
// 【不変条件(RFC 明記)】
//  - 符号は必須。"0900"(符号なし)は不正。
//  - **"-0000" は不正**(§3.3.14: "The mandatory sign ... -0000 and -000000 are not allowed")。
//    負のゼロオフセットは「未知のオフセット」を意味する別文脈(RFC 5322 のメール)由来で、
//    iCalendar では意味を持たないため禁止。プラスのゼロ("+0000")は UTC を表し合法。
// =============================================================================

import { InvalidValueError } from "./errors";

/**
 * UTC-OFFSET 値(§3.3.14)。イミュータブル。
 *
 * - positive: 符号。true=+ / false=-。
 * - hours/minutes: 必須。seconds: 任意(存在しなければ undefined でロスレス保持)。
 *   ※ +0900 と +090000 は「秒フィールドの有無」で往復上区別したい(前者は seconds=undefined、
 *     後者は seconds=0)。0 を捏造補完すると format で桁が変わり往復が壊れる。
 */
export interface UtcOffset {
	readonly positive: boolean;
	readonly hours: number; // 0-23 相当(現実のタイムゾーンは ±14h 以内だが RFC は上限を明示しないので緩め)
	readonly minutes: number; // 0-59
	readonly seconds?: number; // 0-59 or undefined(未指定)
}

// 符号 + HH + MM + 任意 SS。
const UTC_OFFSET_RE = /^([+-])(\d{2})(\d{2})(\d{2})?$/;

/**
 * ファクトリ。範囲と "-0000" 禁止の不変条件を強制。
 */
export function utcOffset(v: UtcOffset): UtcOffset {
	const { positive, hours, minutes, seconds } = v;
	if (minutes < 0 || minutes > 59) {
		throw new InvalidValueError("UTC-OFFSET", JSON.stringify(v), `minute out of range: ${minutes}`);
	}
	if (seconds !== undefined && (seconds < 0 || seconds > 59)) {
		throw new InvalidValueError("UTC-OFFSET", JSON.stringify(v), `second out of range: ${seconds}`);
	}
	if (hours < 0) {
		throw new InvalidValueError("UTC-OFFSET", JSON.stringify(v), `hour out of range: ${hours}`);
	}
	// "-0000"(および "-000000")の禁止(§3.3.14)。負符号かつ全成分ゼロを弾く。
	if (!positive && hours === 0 && minutes === 0 && (seconds === undefined || seconds === 0)) {
		throw new InvalidValueError("UTC-OFFSET", JSON.stringify(v), "negative zero offset (-0000) is not allowed");
	}
	return v;
}

/**
 * 生の値文字列 → UtcOffset(§3.3.14)。
 */
export function parseUtcOffset(raw: string): UtcOffset {
	const m = UTC_OFFSET_RE.exec(raw);
	if (m === null) {
		throw new InvalidValueError("UTC-OFFSET", raw, "must be (+/-)HHMM or (+/-)HHMMSS");
	}
	return utcOffset({
		positive: m[1] === "+",
		hours: Number(m[2]),
		minutes: Number(m[3]),
		seconds: m[4] !== undefined ? Number(m[4]) : undefined,
	});
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/**
 * UtcOffset → 生の値文字列(§3.3.14)。
 * seconds が undefined なら出さない(+0900)、0 でも定義されていれば出す(+090000)。
 */
export function formatUtcOffset(o: UtcOffset): string {
	const sign = o.positive ? "+" : "-";
	const sec = o.seconds !== undefined ? pad2(o.seconds) : "";
	return `${sign}${pad2(o.hours)}${pad2(o.minutes)}${sec}`;
}
