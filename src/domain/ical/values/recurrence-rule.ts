// =============================================================================
// RecurrenceRule — RFC 5545 §3.3.10 RECUR 値型(RRULE の値)。この層の最難関。
// =============================================================================
//
// 【スコープの限定 — この層は「RRULE の構造の型付けと不変条件」だけ】
// occurrence の列挙(展開)は絶対にここでやらない。展開は DTSTART・RDATE・EXDATE・
// RECURRENCE-ID オーバーライドや VTIMEZONE を総合する重いロジックで、モデル図 §1-4 の
// ドメインサービス RecurrenceExpansion の責務。ここは「FREQ=MONTHLY;BYDAY=2MO」という
// 生値を、型付きの RecurrenceRule に相互変換し、RFC の構文・相互作用不変条件を検証する
// だけに徹する。
//
// 【構文(§3.3.10 の recur ABNF の骨子)】
//   recur = recur-rule-part *( ";" recur-rule-part )
//   rule-part: FREQ / UNTIL / COUNT / INTERVAL / BYSECOND / BYMINUTE / BYHOUR /
//              BYDAY / BYMONTHDAY / BYYEARDAY / BYWEEKNO / BYMONTH / BYSETPOS / WKST
//   - FREQ は必須。
//   - パースは順不同で受理 MUST。生成(format)は FREQ を先頭に置く MUST(§3.3.10)。
//   - 同一 rule-part の重複は不正(RFC は各 part を高々1回とする)。
//
// 【主要な相互作用不変条件】
//   I5 : UNTIL と COUNT は同時指定不可。
//   I6 : UNTIL が DATE-TIME なら UTC 形式(末尾 Z)MUST。TZID 付き UNTIL は存在しない
//        (§05 訂正4)。DATE か DATE-TIME(UTC)のみ。
//   序数付き BYDAY(例 2MO, -1SU)は FREQ=MONTHLY か YEARLY のときのみ有効。さらに
//        FREQ=YEARLY で BYWEEKNO を併用する場合は序数付き BYDAY 不可(§3.3.10 の注記)。
// =============================================================================

import { InvalidValueError } from "./errors";
import { type CalDate, parseCalDate, formatCalDate } from "./cal-date";
import { type CalDateTimeUtc, parseCalDateTime, formatCalDateTime } from "./cal-date-time";

// FREQ の取りうる値(§3.3.10)。頻度は下から上へ。
export const FREQUENCIES = ["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

// 曜日(§3.3.10 の weekday)。BYDAY と WKST で使う。
export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * BYDAY の1要素。曜日 + 任意の序数(例 "2MO"=第2月曜, "-1SU"=最終日曜)。
 * ordinal が undefined なら序数なし("MO"=毎週の月曜)。
 */
export interface WeekdayNum {
	readonly ordinal?: number; // 正/負の整数。0 は不可。序数の意味は §3.3.10。
	readonly weekday: Weekday;
}

/**
 * UNTIL の値。DATE か DATE-TIME(UTC のみ)。I6 のため2形態を明示的にタグ付けする。
 * (CalDate と CalDateTimeUtc を裸で union にすると判別しづらいのでラップ。)
 */
export type RecurUntil =
	| { readonly type: "date"; readonly date: CalDate }
	| { readonly type: "date-time"; readonly dateTime: CalDateTimeUtc };

/**
 * RECUR 値(§3.3.10)。イミュータブル。
 * BYxxx 群は「指定されたら配列・されなければ undefined」でロスレスに保持する
 * (空配列と未指定を区別する必要はないので、未指定は undefined に統一)。
 */
export interface RecurrenceRule {
	readonly freq: Frequency; // 必須。
	readonly until?: RecurUntil; // COUNT と排他(I5)。
	readonly count?: number; // 正整数。UNTIL と排他(I5)。
	readonly interval?: number; // 正整数。未指定時の既定は 1(§3.3.10)。ロスレスのため既定は補完しない。
	readonly bySecond?: readonly number[]; // 0-60
	readonly byMinute?: readonly number[]; // 0-59
	readonly byHour?: readonly number[]; // 0-23
	readonly byDay?: readonly WeekdayNum[];
	readonly byMonthDay?: readonly number[]; // 1..31 / -1..-31(0 不可)
	readonly byYearDay?: readonly number[]; // 1..366 / -1..-366(0 不可)
	readonly byWeekNo?: readonly number[]; // 1..53 / -1..-53(0 不可)
	readonly byMonth?: readonly number[]; // 1..12
	readonly bySetPos?: readonly number[]; // 1..366 / -1..-366(0 不可)
	readonly weekStart?: Weekday; // WKST。既定は MO(§3.3.10)。ロスレスのため既定は補完しない。
}

// ---------------------------------------------------------------------------
// パース補助
// ---------------------------------------------------------------------------

// 正整数(1以上)。COUNT / INTERVAL 用。
function parsePositiveInt(raw: string, part: string, whole: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new InvalidValueError("RECUR", whole, `${part} must be a non-negative integer, got "${raw}"`);
	}
	const n = Number(raw);
	if (n < 1) {
		throw new InvalidValueError("RECUR", whole, `${part} must be >= 1, got ${n}`);
	}
	return n;
}

// 符号付き整数リスト(BYMONTHDAY 等)を範囲チェック付きでパースする共通関数。
// allowNegative=false のもの(BYSECOND 等)は非負のみ。min/max は絶対値の範囲。
function parseIntList(
	raw: string,
	part: string,
	whole: string,
	opts: { min: number; max: number; allowNegative: boolean },
): number[] {
	// カンマ区切り(§3.3.10 は BYxxx を COMMA 区切りの複数値とする)。
	const items = raw.split(",");
	return items.map((item) => {
		const signed = /^[+-]?\d+$/.test(item);
		if (!signed) {
			throw new InvalidValueError("RECUR", whole, `${part} contains a non-integer: "${item}"`);
		}
		const n = Number(item);
		if (!opts.allowNegative && n < 0) {
			throw new InvalidValueError("RECUR", whole, `${part} does not allow negative values: ${n}`);
		}
		// 0 は BYMONTHDAY/BYYEARDAY/BYWEEKNO/BYSETPOS で無効。allowNegative 系は 0 を弾く
		// (これらの序数は「N番目/後ろからN番目」で 0番目が存在しない)。
		if (opts.allowNegative && n === 0) {
			throw new InvalidValueError("RECUR", whole, `${part} does not allow 0`);
		}
		const abs = Math.abs(n);
		if (abs < opts.min || abs > opts.max) {
			throw new InvalidValueError("RECUR", whole, `${part} value out of range: ${n}`);
		}
		return n;
	});
}

// BYDAY の1要素をパース。序数(任意)+ 曜日2文字。
const BYDAY_ITEM_RE = /^([+-]?\d{1,3})?(SU|MO|TU|WE|TH|FR|SA)$/;
function parseByDay(raw: string, whole: string): WeekdayNum[] {
	return raw.split(",").map((item) => {
		const m = BYDAY_ITEM_RE.exec(item);
		if (m === null) {
			throw new InvalidValueError("RECUR", whole, `BYDAY item is invalid: "${item}"`);
		}
		const weekday = m[2] as Weekday;
		if (m[1] === undefined) {
			return { weekday };
		}
		const ordinal = Number(m[1]);
		// 序数 0(0MO / +0MO)は無意味なので拒否。
		if (ordinal === 0) {
			throw new InvalidValueError("RECUR", whole, `BYDAY ordinal must not be 0: "${item}"`);
		}
		return { ordinal, weekday };
	});
}

// UNTIL をパース。DATE(8桁)か DATE-TIME(UTC, 末尾 Z)のみ許可(I6)。
function parseUntil(raw: string, whole: string): RecurUntil {
	// "T" を含めば DATE-TIME、含まなければ DATE、で振り分ける。
	if (raw.includes("T")) {
		// DATE-TIME は UTC 形式 MUST(§3.3.10 / §05 訂正4)。末尾 Z が無ければ違反。
		if (!raw.endsWith("Z")) {
			throw new InvalidValueError("RECUR", whole, `UNTIL date-time must be in UTC form (trailing 'Z'): "${raw}"`);
		}
		// tzid は渡さない(TZID 付き UNTIL は存在しない)。parseCalDateTime は Z 付きを utc として返す。
		const dt = parseCalDateTime(raw);
		// 型上は CalDateTime だが、Z 付きなので必ず kind:"utc"。念のため絞り込み。
		if (dt.kind !== "utc") {
			// 実際にはここには来ない(Z 判定済み)。防御的に。
			throw new InvalidValueError("RECUR", whole, "UNTIL date-time must be UTC");
		}
		return { type: "date-time", dateTime: dt };
	}
	return { type: "date", date: parseCalDate(raw) };
}

/**
 * ファクトリ。FREQ 存在・UNTIL/COUNT 排他・序数 BYDAY の相互作用など、
 * 構文を超えた不変条件をここで一括強制する。parse も外部からの直接構築もここを通す。
 */
export function recurrenceRule(r: RecurrenceRule): RecurrenceRule {
	const whole = "(constructed)"; // 直接構築時はソース文字列がないのでプレースホルダ。

	// I5: UNTIL と COUNT は同時指定不可。
	if (r.until !== undefined && r.count !== undefined) {
		throw new InvalidValueError("RECUR", whole, "UNTIL and COUNT must not both be present (RFC 5545 I5)");
	}

	// 序数付き BYDAY の相互作用検証(§3.3.10 の注記):
	//   - 序数付き BYDAY は FREQ=MONTHLY か YEARLY のときだけ意味を持つ。
	//   - FREQ=YEARLY で BYWEEKNO を併用する場合、BYDAY に序数を付けては「ならない」。
	//     (BYWEEKNO 併用時の BYDAY は「週内の曜日」を指す用法で、序数と両立しないため。)
	const hasOrdinalByDay = r.byDay?.some((d) => d.ordinal !== undefined) ?? false;
	if (hasOrdinalByDay) {
		if (r.freq !== "MONTHLY" && r.freq !== "YEARLY") {
			throw new InvalidValueError(
				"RECUR",
				JSON.stringify(r.byDay),
				`numeric (ordinal) BYDAY is only valid with FREQ=MONTHLY or YEARLY, not ${r.freq}`,
			);
		}
		if (r.freq === "YEARLY" && r.byWeekNo !== undefined) {
			throw new InvalidValueError(
				"RECUR",
				JSON.stringify(r.byDay),
				"ordinal BYDAY must not be used when FREQ=YEARLY and BYWEEKNO is present",
			);
		}
	}

	// interval / count の正整数性(パース経路では検証済みだが直接構築の保険)。
	if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1)) {
		throw new InvalidValueError("RECUR", whole, `INTERVAL must be a positive integer, got ${r.interval}`);
	}
	if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1)) {
		throw new InvalidValueError("RECUR", whole, `COUNT must be a positive integer, got ${r.count}`);
	}

	return r;
}

/**
 * 生の値文字列 → RecurrenceRule(§3.3.10)。順不同で受理(MUST)。
 * 同一 rule-part の重複はエラー。
 */
export function parseRecurrenceRule(raw: string): RecurrenceRule {
	if (raw.length === 0) {
		throw new InvalidValueError("RECUR", raw, "empty RECUR value");
	}

	// ";" 区切りで rule-part へ。各 part は "KEY=VALUE"。
	const parts = raw.split(";");
	const seen = new Set<string>(); // 重複検出用(大文字化したキー)。

	// 段階的に埋めていく可変オブジェクト(最後に recurrenceRule() で検証・凍結)。
	let freq: Frequency | undefined;
	const draft: {
		until?: RecurUntil;
		count?: number;
		interval?: number;
		bySecond?: number[];
		byMinute?: number[];
		byHour?: number[];
		byDay?: WeekdayNum[];
		byMonthDay?: number[];
		byYearDay?: number[];
		byWeekNo?: number[];
		byMonth?: number[];
		bySetPos?: number[];
		weekStart?: Weekday;
	} = {};

	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			throw new InvalidValueError("RECUR", raw, `rule-part missing '=': "${part}"`);
		}
		// キーは case-insensitive(§3.1 の名前規則)。大文字化して扱う。
		const key = part.slice(0, eq).toUpperCase();
		const val = part.slice(eq + 1);

		if (seen.has(key)) {
			throw new InvalidValueError("RECUR", raw, `duplicate rule-part: ${key}`);
		}
		seen.add(key);

		switch (key) {
			case "FREQ": {
				// 列挙値は case-insensitive(§3.1)。大文字化して照合。
				const up = val.toUpperCase();
				if (!(FREQUENCIES as readonly string[]).includes(up)) {
					throw new InvalidValueError("RECUR", raw, `invalid FREQ: "${val}"`);
				}
				freq = up as Frequency;
				break;
			}
			case "UNTIL":
				draft.until = parseUntil(val, raw);
				break;
			case "COUNT":
				draft.count = parsePositiveInt(val, "COUNT", raw);
				break;
			case "INTERVAL":
				draft.interval = parsePositiveInt(val, "INTERVAL", raw);
				break;
			case "BYSECOND":
				// 0-60(うるう秒 60 を許容。CalDateTime の秒レンジと揃える)。
				draft.bySecond = parseIntList(val, "BYSECOND", raw, { min: 0, max: 60, allowNegative: false });
				break;
			case "BYMINUTE":
				draft.byMinute = parseIntList(val, "BYMINUTE", raw, { min: 0, max: 59, allowNegative: false });
				break;
			case "BYHOUR":
				draft.byHour = parseIntList(val, "BYHOUR", raw, { min: 0, max: 23, allowNegative: false });
				break;
			case "BYDAY":
				draft.byDay = parseByDay(val, raw);
				break;
			case "BYMONTHDAY":
				// 1..31 と -1..-31。0 不可。
				draft.byMonthDay = parseIntList(val, "BYMONTHDAY", raw, { min: 1, max: 31, allowNegative: true });
				break;
			case "BYYEARDAY":
				// 1..366 と負。0 不可。
				draft.byYearDay = parseIntList(val, "BYYEARDAY", raw, { min: 1, max: 366, allowNegative: true });
				break;
			case "BYWEEKNO":
				// 1..53 と負。0 不可。
				draft.byWeekNo = parseIntList(val, "BYWEEKNO", raw, { min: 1, max: 53, allowNegative: true });
				break;
			case "BYMONTH":
				// 1..12。負は無い。
				draft.byMonth = parseIntList(val, "BYMONTH", raw, { min: 1, max: 12, allowNegative: false });
				break;
			case "BYSETPOS":
				// 1..366 と負。0 不可。
				draft.bySetPos = parseIntList(val, "BYSETPOS", raw, { min: 1, max: 366, allowNegative: true });
				break;
			case "WKST": {
				const up = val.toUpperCase();
				if (!(WEEKDAYS as readonly string[]).includes(up)) {
					throw new InvalidValueError("RECUR", raw, `invalid WKST: "${val}"`);
				}
				draft.weekStart = up as Weekday;
				break;
			}
			default:
				// 未知の rule-part。RFC は将来拡張の余地を残すが、既知の RECUR に無いキーは
				// エラーにする(X- 拡張は RECUR 値の中には定義されていない)。データ不整合として拒否。
				throw new InvalidValueError("RECUR", raw, `unknown rule-part: ${key}`);
		}
	}

	if (freq === undefined) {
		// FREQ 必須(§3.3.10)。
		throw new InvalidValueError("RECUR", raw, "FREQ is required");
	}

	return recurrenceRule({ freq, ...draft });
}

// ---------------------------------------------------------------------------
// シリアライズ
// ---------------------------------------------------------------------------

// BYDAY 1要素の文字列化。
function formatWeekdayNum(d: WeekdayNum): string {
	return d.ordinal !== undefined ? `${d.ordinal}${d.weekday}` : d.weekday;
}

// UNTIL の文字列化(DATE か UTC DATE-TIME)。
function formatUntil(u: RecurUntil): string {
	return u.type === "date" ? formatCalDate(u.date) : formatCalDateTime(u.dateTime);
}

/**
 * RecurrenceRule → 生の値文字列(§3.3.10)。
 * FREQ を必ず先頭に出す(生成時 MUST)。以降の rule-part は RFC の記載順に寄せた
 * 決まった順序で出す(順序に意味はないが、決定的な出力にするとテスト・diff が安定する)。
 */
export function formatRecurrenceRule(r: RecurrenceRule): string {
	// FREQ 先頭 MUST。以降は固定順(可読性・決定性のため RFC の列挙順に合わせる)。
	const parts: string[] = [`FREQ=${r.freq}`];

	if (r.until !== undefined) parts.push(`UNTIL=${formatUntil(r.until)}`);
	if (r.count !== undefined) parts.push(`COUNT=${r.count}`);
	if (r.interval !== undefined) parts.push(`INTERVAL=${r.interval}`);
	if (r.bySecond !== undefined) parts.push(`BYSECOND=${r.bySecond.join(",")}`);
	if (r.byMinute !== undefined) parts.push(`BYMINUTE=${r.byMinute.join(",")}`);
	if (r.byHour !== undefined) parts.push(`BYHOUR=${r.byHour.join(",")}`);
	if (r.byDay !== undefined) parts.push(`BYDAY=${r.byDay.map(formatWeekdayNum).join(",")}`);
	if (r.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
	if (r.byYearDay !== undefined) parts.push(`BYYEARDAY=${r.byYearDay.join(",")}`);
	if (r.byWeekNo !== undefined) parts.push(`BYWEEKNO=${r.byWeekNo.join(",")}`);
	if (r.byMonth !== undefined) parts.push(`BYMONTH=${r.byMonth.join(",")}`);
	if (r.bySetPos !== undefined) parts.push(`BYSETPOS=${r.bySetPos.join(",")}`);
	if (r.weekStart !== undefined) parts.push(`WKST=${r.weekStart}`);

	return parts.join(";");
}
