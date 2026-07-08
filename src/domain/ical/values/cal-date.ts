// =============================================================================
// CalDate — RFC 5545 §3.3.4 DATE 値型(VALUE=DATE。終日イベントの日付)
// =============================================================================
//
// 【この値型の位置づけ】
// 「時刻を持たない日付」。iOS の終日イベント(all-day)や、RRULE の UNTIL が
// DATE 形態のときに使う。DTSTART;VALUE=DATE:20260708 のように、時刻・タイムゾーンの
// 概念が一切ない。ここを DATE-TIME と混ぜると time-range フィルタ(RFC 4791 §7.8)で
// 意味がずれる(§03 の I6/I9 参照)ので独立した型にする。
//
// 構文(§3.3.4): date = date-fullyear date-month date-mday = YYYYMMDD(区切りなし)
// =============================================================================

import { InvalidValueError } from "./errors";

/**
 * DATE 値(§3.3.4)。年月日のみ。イミュータブル。
 * フィールドは数値で保持する(文字列のまま持つと 07 と 7 の比較などで事故るため)。
 */
export interface CalDate {
	readonly year: number; // 4桁(0000-9999)。RFC は 4DIGIT 固定。
	readonly month: number; // 1-12
	readonly day: number; // 1-31(実在日のみ。後述の検証で 2/30 等を弾く)
}

// YYYYMMDD の厳密マッチ。区切り文字なし・8桁固定(§3.3.4)。
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * 各月の日数を返す(閏年考慮)。実在日検証の共通ロジック。
 * cal-date-time.ts からも使うので export する(同じ values/ 層内の共有はレイヤー違反にならない)。
 *
 * グレゴリオ暦の閏年規則: 4で割れる年は閏。ただし100で割れる年は平年、400で割れる年は閏。
 * RFC 5545 はグレゴリオ暦前提(§3.3.4 は ISO 8601 に準拠)。
 */
export function daysInMonth(year: number, month: number): number {
	const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	// 添字 = 月(1-12)。0番目はダミー。2月だけ閏で 28/29 を切り替える。
	const table = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return table[month];
}

/**
 * 年月日が実在するかを検証し、しなければ理由文字列を返す(実在すれば null)。
 * cal-date-time.ts と共有するため export。
 */
export function validateYmd(year: number, month: number, day: number): string | null {
	// month は 1-12。0 や 13 は即アウト。
	if (month < 1 || month > 12) return `month out of range: ${month}`;
	// day は 1 〜 その月の日数。2月30日・4月31日などをここで弾く(要件の「2月30日等は拒否」)。
	if (day < 1 || day > daysInMonth(year, month)) return `day out of range: ${day} for ${year}-${month}`;
	return null;
}

/**
 * ファクトリ。実在日の不変条件を強制する。直接オブジェクトリテラルを作らせず
 * これを通すことで「不正な CalDate は存在し得ない」を保証する。
 */
export function calDate(year: number, month: number, day: number): CalDate {
	const err = validateYmd(year, month, day);
	if (err !== null) {
		// input には復元した文字列を入れておく(どの日付が不正かログで分かるように)。
		throw new InvalidValueError("DATE", `${year}-${month}-${day}`, err);
	}
	return { year, month, day };
}

/**
 * 生の値文字列 → CalDate(§3.3.4)。
 */
export function parseCalDate(raw: string): CalDate {
	const m = DATE_RE.exec(raw);
	if (m === null) {
		throw new InvalidValueError("DATE", raw, "must be 8 digits YYYYMMDD");
	}
	// 正規表現で桁数は保証済みなので parseInt は必ず成功する。
	return calDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

// 2桁ゼロ埋め。月日の整形用。
function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/**
 * CalDate → 生の値文字列(§3.3.4)。YYYYMMDD。
 * parse↔format はロスレス(往復で同一文字列に戻る)。
 */
export function formatCalDate(d: CalDate): string {
	// 年は4桁固定。西暦1万年問題は RFC の想定外なので padStart(4) で十分。
	return `${d.year.toString().padStart(4, "0")}${pad2(d.month)}${pad2(d.day)}`;
}
