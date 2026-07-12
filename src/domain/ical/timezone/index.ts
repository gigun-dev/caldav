// =============================================================================
// timezone/ 層の公開 API 集約(re-export)
// =============================================================================
//
// TZ 解決層(docs/modeling/08 §6)を1箇所から取り出せるようにする。責務は
// 「TZID(生文字列)→ IANA 名の解決」と「IANA ゾーンでの壁時計 ⇄ UTC エポック変換」、
// および RFC 4791 §9.9 の実効 [start, end) 算出。VTIMEZONE の逐語評価はしない(IANA 正)。
// 上位(将来の RecurrenceExpansion / time-range フィルタ / application 層)はここ、
// あるいは ical/index.ts 経由でのみ import する。
//
// 公開するもの:
//   - errors:  TimezoneResolutionError(解決不能を表す明示例外。暗黙フォールバック禁止)
//   - resolver: TimezoneResolution 型 / isValidIanaZone / resolveTimeZoneId(4段チェーン)
//   - windows-zones: windowsToIana(Windows 名 → IANA 名)
//   - instant: getZoneOffsetMillis / localFieldsToEpochMillis / calDateTimeToEpochMillis /
//              calDateStartEpochMillis(Intl/ICU による壁時計 ⇄ UTC)+ LocalFields 型
//   - effective-period: EffectivePeriod 型 / effectiveEventPeriod(§9.9)
//   - vtimezone-write: buildVTimezone / zoneHasOffsetTransitions(V6・TZID→VTIMEZONE 生成。
//     Phase 1 固定オフセットゾーン限定 — DST は UnsupportedTimeZoneError)
// =============================================================================

export { TimezoneResolutionError, UnsupportedTimeZoneError } from "./errors";
export { windowsToIana } from "./windows-zones";
export { type TimezoneResolution, isValidIanaZone, resolveTimeZoneId } from "./resolver";
export {
	type LocalFields,
	getZoneOffsetMillis,
	localFieldsToEpochMillis,
	calDateTimeToEpochMillis,
	calDateStartEpochMillis,
} from "./instant";
export { type EffectivePeriod, effectiveEventPeriod } from "./effective-period";
export { type VTimezoneWindow, buildVTimezone, zoneHasOffsetTransitions } from "./vtimezone-write";
