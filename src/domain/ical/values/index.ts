// =============================================================================
// values/ 層の公開 API 集約(re-export)
// =============================================================================
//
// RFC 5545 §3.3 の値型コーデック群を1箇所から取り出せるようにする。
// 上位(将来の parse/ semantics/ ical/index.ts)はこの index からのみ import する想定。
// 「生の値文字列 ↔ 型付き値オブジェクト」の純関数ペア(parseXxx / formatXxx)と
// 型・ファクトリ・共通エラーを公開する。展開(occurrence 列挙)はこの層の責務外
// (recurrence-rule.ts 冒頭のスコープ注記を参照)。
// =============================================================================

// 共通エラー。
export { InvalidValueError } from "./errors";

// §3.3.4 DATE
export {
	type CalDate,
	calDate,
	parseCalDate,
	formatCalDate,
	daysInMonth,
	validateYmd,
} from "./cal-date";

// §3.3.5 DATE-TIME(3形態の判別ユニオン)
export {
	type CalDateTime,
	type CalDateTimeUtc,
	parseCalDateTime,
	formatCalDateTime,
	toEpochMillis,
	compareUtc,
} from "./cal-date-time";

// §3.3.6 DURATION
export {
	type DurationValue,
	durationValue,
	parseDurationValue,
	formatDurationValue,
} from "./duration-value";

// §3.3.9 PERIOD
export {
	type PeriodValue,
	parsePeriodValue,
	formatPeriodValue,
} from "./period-value";

// §3.3.10 RECUR(RRULE)
export {
	type RecurrenceRule,
	type Frequency,
	type Weekday,
	type WeekdayNum,
	type RecurUntil,
	FREQUENCIES,
	WEEKDAYS,
	recurrenceRule,
	parseRecurrenceRule,
	formatRecurrenceRule,
} from "./recurrence-rule";

// §3.3.14 UTC-OFFSET
export {
	type UtcOffset,
	utcOffset,
	parseUtcOffset,
	formatUtcOffset,
} from "./utc-offset";

// §3.3.11 TEXT(エスケープ規則)
export {
	type TextValue,
	parseTextValue,
	formatTextValue,
	encodeText,
	decodeText,
} from "./text-value";

// §3.3.3 CAL-ADDRESS
export {
	type CalAddress,
	parseCalAddress,
	formatCalAddress,
} from "./cal-address";
