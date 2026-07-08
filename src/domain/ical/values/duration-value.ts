// =============================================================================
// DurationValue — RFC 5545 §3.3.6 DURATION 値型(例 P1DT12H, -PT30M, P2W)
// =============================================================================
//
// 【構文(§3.3.6 の ABNF を噛み砕く)】
//   dur-value  = (["+"] / "-") "P" (dur-date / dur-time / dur-week)
//   dur-date   = dur-day [dur-time]
//   dur-time   = "T" (dur-hour / dur-minute / dur-second)
//   dur-week   = 1*DIGIT "W"
//   dur-hour   = 1*DIGIT "H" [dur-minute]
//   dur-minute = 1*DIGIT "M" [dur-second]
//   dur-second = 1*DIGIT "S"
//   dur-day    = 1*DIGIT "D"
//
// 要点:
//  - 符号あり(先頭 + / -)。省略時は正。
//  - 「P」は必須のプレフィックス(period designator)。
//  - 【不変条件】週(W)指定は日時分秒指定と排他。P2W か PnDTnHnMnS のどちらか一方のみ。
//    ABNF が dur-week を独立の選択肢にしているのがその表現(P2W1D は非合法)。
//  - ISO 8601 の年(Y)・月(M-in-date)は RFC 5545 が非サポート。P1Y や P1M(月)は不可。
//    ※注意: 分の M は dur-time 内(T の後)にのみ現れる。日付部の M(月)は存在しない。
//  - T の後には少なくとも1つの時分秒が必要(T 単独は不可)。
// =============================================================================

import { InvalidValueError } from "./errors";

/**
 * DURATION 値(§3.3.6)。イミュータブル。
 *
 * 週指定と日時指定の排他を「型」で表現するのが理想だが、共通フィールド(positive)が
 * あるため判別ユニオンにするとやや冗長。ここでは全フィールドを optional に持ち、
 * ファクトリで排他を強制する方式にした(コメントで不変条件を明示)。
 * weeks が定義されていれば days/hours/minutes/seconds は必ず undefined、という約束。
 *
 * - positive: true=正 / false=負。符号は「時間の向き」であり各成分は非負。
 *   (RFC は各成分を 1*DIGIT = 非負整数とし、符号は全体に1つだけ付く。)
 */
export interface DurationValue {
	readonly positive: boolean;
	readonly weeks?: number; // W 指定時のみ。他成分と排他。
	readonly days?: number;
	readonly hours?: number;
	readonly minutes?: number;
	readonly seconds?: number;
}

/**
 * ファクトリ。排他・非負・空でないことの不変条件を強制する。
 */
export function durationValue(v: DurationValue): DurationValue {
	const { positive, weeks, days, hours, minutes, seconds } = v;
	const hasWeek = weeks !== undefined;
	const hasTimeOrDay = days !== undefined || hours !== undefined || minutes !== undefined || seconds !== undefined;

	// 不変条件: 週と(日/時/分/秒)は同時に持てない(§3.3.6 の dur-week 排他)。
	if (hasWeek && hasTimeOrDay) {
		throw new InvalidValueError("DURATION", JSON.stringify(v), "week (W) form cannot be combined with day/time components");
	}
	// 全成分が無い DURATION(符号だけ)は無意味なので拒否。P 単独・PT 単独に相当。
	if (!hasWeek && !hasTimeOrDay) {
		throw new InvalidValueError("DURATION", JSON.stringify(v), "duration must have at least one component");
	}
	// 各成分は非負整数(符号は positive に集約)。負値が紛れ込むのは呼び出しバグ。
	for (const [k, n] of Object.entries({ weeks, days, hours, minutes, seconds })) {
		if (n !== undefined && (!Number.isInteger(n) || n < 0)) {
			throw new InvalidValueError("DURATION", JSON.stringify(v), `${k} must be a non-negative integer, got ${n}`);
		}
	}
	return v;
}

// 全体構造: 符号 + P + (週 or 日付[時刻]) 。まず外枠を取り、中身は個別に検証する。
// 週形態と非週形態で分岐したいので、ここでは緩めに全体を1つの正規表現で受け、
// キャプチャの有無で判定する方針。
//   sign    = m[1]  ("+"|"-"|"")
//   week    = m[2]  ("2W" の数字部)  ※週形態のときのみ
//   day     = m[3]  ("1D" の数字部)
//   hour    = m[4]
//   minute  = m[5]
//   second  = m[6]
// T の後は少なくとも1成分、という制約は正規表現だけだと表しづらいので、
// パース後に「T があったのに時分秒が全部無い」ケースを別途弾く。
const DURATION_RE =
	/^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/;

/**
 * 生の値文字列 → DurationValue(§3.3.6)。
 */
export function parseDurationValue(raw: string): DurationValue {
	const m = DURATION_RE.exec(raw);
	if (m === null) {
		throw new InvalidValueError("DURATION", raw, "does not match DURATION syntax (e.g. P1DT12H, -PT30M, P2W)");
	}
	const positive = m[1] !== "-"; // "+" も undefined(符号なし)も正。

	// 週形態。
	if (m[2] !== undefined) {
		return durationValue({ positive, weeks: Number(m[2]) });
	}

	// 非週形態(日・時・分・秒)。undefined のものは持たない(ロスレス往復のため
	// 「元々無かった成分」を 0 として捏造しない)。
	const days = m[3] !== undefined ? Number(m[3]) : undefined;
	const hours = m[4] !== undefined ? Number(m[4]) : undefined;
	const minutes = m[5] !== undefined ? Number(m[5]) : undefined;
	const seconds = m[6] !== undefined ? Number(m[6]) : undefined;

	// 「T」が書かれていたのに時分秒が1つも無い(例 "PT" や "P1DT")のは §3.3.6 違反。
	// 正規表現の T グループは全部 optional なので、ここで文字列の "T" 有無と突き合わせる。
	const hasT = raw.includes("T");
	const hasTimeComponent = hours !== undefined || minutes !== undefined || seconds !== undefined;
	if (hasT && !hasTimeComponent) {
		throw new InvalidValueError("DURATION", raw, "'T' present but no time component (H/M/S) follows");
	}

	return durationValue({ positive, days, hours, minutes, seconds });
}

/**
 * DurationValue → 生の値文字列(§3.3.6)。
 * ロスレス: parse で保持しなかった成分は出さない(P1D は P1DT0H0M0S に膨らませない)。
 */
export function formatDurationValue(d: DurationValue): string {
	const sign = d.positive ? "" : "-"; // 正は符号省略が慣行(P1D)。負は "-" 必須。

	if (d.weeks !== undefined) {
		return `${sign}P${d.weeks}W`;
	}

	// 日付部と時刻部を組み立てる。
	let out = `${sign}P`;
	if (d.days !== undefined) out += `${d.days}D`;

	const hasTime = d.hours !== undefined || d.minutes !== undefined || d.seconds !== undefined;
	if (hasTime) {
		out += "T";
		if (d.hours !== undefined) out += `${d.hours}H`;
		if (d.minutes !== undefined) out += `${d.minutes}M`;
		if (d.seconds !== undefined) out += `${d.seconds}S`;
	}
	return out;
}
