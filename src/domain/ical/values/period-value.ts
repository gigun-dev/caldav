// =============================================================================
// PeriodValue — RFC 5545 §3.3.9 PERIOD 値型(時間の区間)
// =============================================================================
//
// 【構文(§3.3.9)】
//   period          = period-explicit / period-start
//   period-explicit = date-time "/" date-time   ; 開始/終了(終了は開始より後 MUST)
//   period-start    = date-time "/" dur-value    ; 開始/期間(dur は正 MUST)
//
// 用途: VFREEBUSY の FREEBUSY プロパティ、RDATE;VALUE=PERIOD(インスタンスの
// 期間つき追加。§05 の細則参照)。iOS カレンダーでは主に FREEBUSY 応答で登場する。
//
// 【2形態を判別ユニオンにする理由】
// explicit(終了時刻を持つ)と start(期間を持つ)は「区間の終わりの決め方」が
// 別物。start 形態の実効終了時刻は start+duration だが、その計算は floating/zoned の
// 場合タイムゾーン解決を要する(この層ではやらない)。よって形態を型で区別し、
// 終了時刻の計算は上位に委ねる。
// =============================================================================

import { InvalidValueError } from "./errors";
import { type CalDateTime, parseCalDateTime, formatCalDateTime, compareUtc } from "./cal-date-time";
import { type DurationValue, parseDurationValue, formatDurationValue } from "./duration-value";

/**
 * PERIOD 値(§3.3.9)。kind で2形態を判別。イミュータブル。
 *
 * - explicit: 開始と終了(両方 date-time)。
 * - start: 開始(date-time)+ 期間(duration)。
 *
 * start/end の CalDateTime 形態(floating/utc/zoned)は parse 時に決まる。
 * PERIOD の start と end は同じ形態であるべき(§3.3.9 の例は UTC)だが、
 * RFC は明示的な MUST を置いていないので、ここでは形態一致の強制はしない
 * (実データ追従優先。矛盾検出は上位のドメインサービスに委ねる)。
 */
export type PeriodValue =
	| { readonly kind: "explicit"; readonly start: CalDateTime; readonly end: CalDateTime }
	| { readonly kind: "start"; readonly start: CalDateTime; readonly duration: DurationValue };

// DATE-TIME のフィールドだけをローカル時刻として比較する。floating と、同じ TZID の
// zoned は「同じ時計の上の前後関係」として比較できる。UTC は compareUtc を使う。
// 異なる形態(floating vs utc 等)は絶対時刻が定まらないため、この層では比較しない。
function compareLocalFields(a: CalDateTime, b: CalDateTime): -1 | 0 | 1 {
	const av = [a.year, a.month, a.day, a.hour, a.minute, a.second];
	const bv = [b.year, b.month, b.day, b.hour, b.minute, b.second];
	for (let i = 0; i < av.length; i++) {
		const left = av[i]!;
		const right = bv[i]!;
		if (left < right) return -1;
		if (left > right) return 1;
	}
	return 0;
}

// period-explicit は「start より end が後 MUST」(§3.3.9)。ただし DATE-TIME には
// floating / utc / zoned の3形態があり、全組み合わせをこの値型単体で絶対時刻比較
// できるわけではない。よってここでは比較可能な形だけを厳格に拒否する:
//   - utc 同士: 絶対時刻として比較
//   - floating 同士: ローカル時計のフィールド順で比較
//   - zoned 同士かつ同じ TZID: 同じタイムゾーン内のローカル時計として比較
// mixed form や異なる TZID は、VTIMEZONE 解決を伴う上位ドメインサービスで検証する。
function assertExplicitEndAfterStart(start: CalDateTime, end: CalDateTime, raw: string): void {
	let cmp: -1 | 0 | 1 | undefined;
	if (start.kind === "utc" && end.kind === "utc") {
		cmp = compareUtc(start, end);
	} else if (start.kind === "floating" && end.kind === "floating") {
		cmp = compareLocalFields(start, end);
	} else if (start.kind === "zoned" && end.kind === "zoned" && start.tzid === end.tzid) {
		cmp = compareLocalFields(start, end);
	}

	if (cmp !== undefined && cmp >= 0) {
		throw new InvalidValueError("PERIOD", raw, "period explicit end MUST be after start");
	}
}

/**
 * 生の値文字列 → PeriodValue(§3.3.9)。
 *
 * @param raw  "start/end" もしくは "start/duration"
 * @param tzid PERIOD 全体に効く TZID パラメータ(RDATE;TZID=... 等)。
 *             start / end 両方の date-time に同じ TZID を適用する。
 *             ※ UTC 形態(末尾 Z)なら CalDateTime 側で TZID 併用エラーになる。
 *
 * 形態判定: "/" の右側が DURATION 構文(先頭 [+-]P …)なら start 形態、
 * そうでなければ explicit 形態、として振り分ける。
 */
export function parsePeriodValue(raw: string, tzid?: string): PeriodValue {
	// "/" は1個だけのはず。分割して2要素にならなければ構文エラー。
	const slash = raw.indexOf("/");
	if (slash === -1) {
		throw new InvalidValueError("PERIOD", raw, "missing '/' separator");
	}
	const left = raw.slice(0, slash);
	const right = raw.slice(slash + 1);
	if (right.includes("/")) {
		throw new InvalidValueError("PERIOD", raw, "must contain exactly one '/' separator");
	}

	const start = parseCalDateTime(left, tzid);

	// 右辺が DURATION か DATE-TIME か。DURATION は "P" を含む(符号付きも P 必須)。
	// DATE-TIME は必ず "T" の前が8桁数字。判定は「P を含むか」で十分に分かれる
	// (DATE-TIME の値に文字 P は出現しない)。
	const isDuration = /^[+-]?P/.test(right);
	if (isDuration) {
		const duration = parseDurationValue(right);
		// period-start の duration は正である MUST(§3.3.9)。負の期間は区間として不正。
		if (!duration.positive) {
			throw new InvalidValueError("PERIOD", raw, "duration in a period MUST be positive");
		}
		return { kind: "start", start, duration };
	}

	// explicit 形態。終了時刻をパース。
	const end = parseCalDateTime(right, tzid);
	assertExplicitEndAfterStart(start, end, raw);
	return { kind: "explicit", start, end };
}

/**
 * PeriodValue → 生の値文字列(§3.3.9)。
 * start/end/duration それぞれの format に委譲(TZID はパラメータ側なので値には出さない)。
 */
export function formatPeriodValue(p: PeriodValue): string {
	if (p.kind === "explicit") {
		return `${formatCalDateTime(p.start)}/${formatCalDateTime(p.end)}`;
	}
	return `${formatCalDateTime(p.start)}/${formatDurationValue(p.duration)}`;
}
