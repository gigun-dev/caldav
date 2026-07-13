// =============================================================================
// RecurrenceExpansion — RFC 5545 の反復イベントを [range) に収まる occurrence 列へ展開する
// =============================================================================
//
// 【この service の位置づけ(docs/modeling/03 §1-4 / 08 §5-6)】
// RRULE(§3.3.10)・RDATE(§3.8.5.2)・EXDATE(§3.8.5.1)・RECURRENCE-ID オーバーライド
// (§3.8.4.4)を総合し、RFC 4791 §9.9 の実効 [start, end) を各 occurrence に付与して
// range フィルタ済みの列を返す。RRULE の「反復」だけは port(iterator-port.ts)経由で
// 注入された RecurrenceIterator(実装は infrastructure/recurrence の ical.js アダプタ)に
// 委譲し、それ以外(UNTIL の epoch 厳密判定・UTC 化順序・EXDATE/RDATE/オーバーライド解決・
// 実効期間の nominal/exact 使い分け・range フィルタ・上限)はすべてこの純粋関数が担う。
//
// 【展開順序の鉄則(08 §3 の落とし穴)】
// RRULE 反復は必ず「ローカル壁時計のまま」列挙し、UTC 化は occurrence ごとに個別に行う
// (先に dtstart を UTC 化してから日数を足すと、DST を跨いだときに壁時計がズレる)。
// =============================================================================

import type { CalDate } from "../values/cal-date";
import { parseCalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";
import { parseCalDateTime, toEpochMillis } from "../values/cal-date-time";
import type { RecurrenceRule, RecurUntil } from "../values/recurrence-rule";
import { durationValue } from "../values/duration-value";
import { parsePeriodValue } from "../values/period-value";
import type { Property } from "../structure/types";
import type { VEvent } from "../semantics/vevent";
import { isCalDateTime, paramFirst } from "../semantics/helpers";
import { type EffectivePeriod, effectiveEventPeriod, calDateStartEpochMillis, calDateTimeToEpochMillis } from "../timezone";
import type { RecurrenceIterator, RecurrenceWallClockFields } from "./iterator-port";
import type { Occurrence } from "./occurrence";

/** expandRecurrenceSet への入力。 */
export interface RecurrenceExpansionInput {
	/** 反復の元になるマスター VEVENT(RECURRENCE-ID を持たない本体)。 */
	readonly master: VEvent;
	/** RECURRENCE-ID オーバーライド VEVENT 群(マスターと同じ UID・RECURRENCE-ID 付き)。 */
	readonly overrides: readonly VEvent[];
	/** 展開対象の期間。半開区間 [startMillis, endMillis)。RFC 4791 §9.9 の time-range と同じ規約。 */
	readonly range: { readonly startMillis: number; readonly endMillis: number };
}

/** expandRecurrenceSet のオプション。 */
export interface RecurrenceExpansionOptions {
	/** zoned の TZID → IANA 名(resolver 経由を注入。timezone/instant.ts と同じ契約)。 */
	readonly zoneOf: (tzid: string) => string;
	/** floating / DATE を解釈するゾーン。既定 "UTC"(§7.3 の「サーバー任意」を暗黙にしない)。 */
	readonly floatingTimeZone?: string;
	/**
	 * 展開する occurrence 数の上限(必須)。08 §6-3 の DoS 対策: 無限 RRULE
	 * (COUNT も UNTIL も無い)を range だけに頼って打ち切ると、range が極端に広い/遠い未来だと
	 * 大量展開になりうるため、呼び出し側が明示的に予算を渡す設計にする(暗黙の既定値を
	 * ここでは持たない — 「呼び出し側が意識して決める」ことを型で強制する)。
	 */
	readonly maxOccurrences: number;
}

export interface RecurrenceExpansionResult {
	/** range と重なる occurrence(開始時刻昇順)。 */
	readonly occurrences: Occurrence[];
	/** maxOccurrences に達して打ち切ったら true。呼び出し側(application 層)が
	 *  「結果が不完全かもしれない」ことを利用者に伝える判断材料にする。 */
	readonly limitHit: boolean;
}

// ---------------------------------------------------------------------------
// 内部表現: 「まだ EXDATE/オーバーライド解決前」の生候補。
// RRULE 由来 / RDATE(DATE, DATE-TIME)由来は localValue の kind から実効期間を
// マスターの DTEND/DURATION 規則(item7)で算出する。RDATE;VALUE=PERIOD 由来は
// 明示的な終了時刻を持つので period に格納し、そちらをそのまま使う(item4)。
// ---------------------------------------------------------------------------
interface RawCandidate {
	readonly localValue: CalDate | CalDateTime;
	readonly startMillis: number;
	/** RDATE;VALUE=PERIOD のときだけ設定される明示的な終了(ミリ秒)。 */
	readonly explicitEndMillis?: number;
}

/**
 * RRULE / RDATE / EXDATE / RECURRENCE-ID オーバーライドを総合して occurrence 列を作る。
 *
 * @param iterator RRULE 反復の port 実装(DI。infrastructure/recurrence の ical.js アダプタを注入する想定)。
 * @param input    master / overrides / range。
 * @param opts     zoneOf / floatingTimeZone / maxOccurrences。
 */
export function expandRecurrenceSet(
	iterator: RecurrenceIterator,
	input: RecurrenceExpansionInput,
	opts: RecurrenceExpansionOptions,
): RecurrenceExpansionResult {
	const { master, overrides, range } = input;
	const floatingTimeZone = opts.floatingTimeZone ?? "UTC";
	const instantOpts = { zoneOf: opts.zoneOf, floatingTimeZone };

	const dtstart = master.dtstart;
	if (dtstart === undefined) {
		// DTSTART は VEVENT の必須プロパティ(I2 の隣接不変条件)。展開以前の壊れたデータなので
		// InvariantViolation とせず単純に throw する(呼び出し側が validate() 済みである前提)。
		throw new Error("RecurrenceExpansion: master VEVENT has no DTSTART");
	}

	const rrule = master.rrule;
	const rdateProps = master.rdate;

	// --- item10: RRULE も RDATE も無い単発イベント -----------------------------------
	// 呼び出し側の分岐を減らすため、expand 対象外でも呼ばれたらマスター1件を返す。
	// range との重なりは他の occurrence と同じ規則(item8)で判定する。
	if (rrule === undefined && rdateProps.length === 0) {
		const period = effectiveEventPeriod({ dtstart, dtend: master.dtend, duration: master.duration }, instantOpts);
		const occ: Occurrence = {
			recurrenceId: dtstart,
			startMillis: period.startMillis,
			endMillis: period.endMillis,
			source: "master",
			component: master,
		};
		return { occurrences: overlapsRange(occ, range) ? [occ] : [], limitHit: false };
	}

	// --- EXDATE epoch 集合(item5)------------------------------------------------------
	const exdateEpochs = exdateEpochsOf(master.exdate, instantOpts);

	// --- RECURRENCE-ID オーバーライドの epoch マップ(item6)---------------------------
	// キーは「マスター時刻のまま」の recurrenceId の epoch。オーバーライドの dtstart 自体は
	// 使わない(それは「移動後」の時刻で、突合キーにはならない。§3.8.4.4)。
	const overrideByEpoch = new Map<number, VEvent>();
	for (const ov of overrides) {
		const rid = ov.recurrenceId;
		if (rid === undefined) {
			// RECURRENCE-ID 無しの override は契約違反(呼び出し側が誤って渡した)。
			// 展開全体を止めるほどではないので黙って読み飛ばす(iOS 実データ耐性優先の方針を
			// 過度に緩めない — 契約違反は呼び出し側のバグなので application 層で弾くべき)。
			continue;
		}
		overrideByEpoch.set(instantOfDateValue(rid, instantOpts), ov);
	}

	// --- 生候補の列挙(RRULE → RDATE の順。maxOccurrences 予算を共有する)---------------
	const candidates: RawCandidate[] = [];
	let limitHit = false;

	// RRULE が無く RDATE だけがある場合、マスター自身の DTSTART は「反復の起点」ではなく
	// RRULE 反復に含まれないため、ここで明示的に候補へ加える必要がある
	// (RRULE がある場合は iterator.iterate() が dtstart 自身を先頭に含めて返すので不要)。
	if (rrule === undefined) {
		candidates.push({ localValue: dtstart, startMillis: instantOfDateValue(dtstart, instantOpts) });
	}

	if (rrule !== undefined) {
		const masterIsDate = !isCalDateTime(dtstart);
		// UNTIL は iterator に渡さず自前で epoch 厳密判定する(item2)。BYSECOND/BYMINUTE/BYHOUR も
		// DATE dtstart なら iterator に渡す前に落とす(item3, I9「無視 MUST」。vevent.ts の
		// validateRRule コメント参照: values/semantics 層は BYxxx の存在自体を違反にしない方針で、
		// ここ展開層が実際に「無視」を実装する)。
		const ruleForIterator = ruleWithoutUntilForIterator(rrule, masterIsDate);
		const untilEpoch = rrule.until !== undefined ? untilEpochOf(rrule.until, instantOpts) : undefined;
		const dtstartFields = wallFieldsOf(dtstart);

		for (const wf of iterator.iterate(ruleForIterator, dtstartFields, masterIsDate)) {
			const localValue = masterIsDate
				? { year: wf.year, month: wf.month, day: wf.day }
				: reconstructCalDateTime(dtstart, wf);
			const startMillis = instantOfDateValue(localValue, instantOpts);

			// UNTIL 厳密判定(inclusive: occurrence == UNTIL は含む。§3.3.10)。
			if (untilEpoch !== undefined && startMillis > untilEpoch) break;
			// item9: これ以上未来の occurrence は range に絶対入らない → 打ち切り。
			// (range 開始前から続く長時間 occurrence を拾うため、開始側の下限では打ち切らない。
			//  overlap 判定[overlapsRange]が実際の重なりをあとで絞り込む。)
			if (startMillis >= range.endMillis) break;

			if (candidates.length >= opts.maxOccurrences) {
				limitHit = true;
				break;
			}
			candidates.push({ localValue, startMillis });
		}
	}

	if (!limitHit) {
		outer: for (const p of rdateProps) {
			const valueType = paramFirst(p, "VALUE")?.toUpperCase();
			const tzid = paramFirst(p, "TZID");
			// §3.8.5.2: RDATE は1プロパティ内にカンマ区切りで複数値を持てる(item4)。
			for (const item of p.value.split(",")) {
				if (candidates.length >= opts.maxOccurrences) {
					limitHit = true;
					break outer;
				}
				if (valueType === "PERIOD") {
					// PERIOD は明示 start/end(または start+duration)を持つのでそのまま使う(item4)。
					// start+duration 形態の end 計算は effectiveEventPeriod の addDuration(nominal/exact
					// 使い分け)をそのまま再利用する — item7 の DURATION ケースと同じ規則で正しい。
					const period = parsePeriodValue(item, tzid);
					if (period.kind === "explicit") {
						candidates.push({
							localValue: period.start,
							startMillis: instantOfDateValue(period.start, instantOpts),
							explicitEndMillis: instantOfDateValue(period.end, instantOpts),
						});
					} else {
						const resolved = effectiveEventPeriod({ dtstart: period.start, duration: period.duration }, instantOpts);
						candidates.push({
							localValue: period.start,
							startMillis: resolved.startMillis,
							explicitEndMillis: resolved.endMillis,
						});
					}
				} else if (valueType === "DATE") {
					const cd = parseCalDate(item);
					candidates.push({ localValue: cd, startMillis: instantOfDateValue(cd, instantOpts) });
				} else {
					// 既定(VALUE 未指定)は DATE-TIME(§3.8.5.2)。
					const dt = parseCalDateTime(item, tzid);
					candidates.push({ localValue: dt, startMillis: instantOfDateValue(dt, instantOpts) });
				}
			}
		}
	}

	// RRULE と RDATE を混在させたので、開始時刻昇順に整列し直す。
	candidates.sort((a, b) => a.startMillis - b.startMillis);

	// --- EXDATE 除外 → オーバーライド解決 → 実効期間算出(item5〜7)-------------------
	const occurrences: Occurrence[] = [];
	const matchedOverrideEpochs = new Set<number>();
	for (const cand of candidates) {
		if (exdateEpochs.has(cand.startMillis)) continue; // EXDATE は epoch 一致で除外(item5)。

		const override = overrideByEpoch.get(cand.startMillis);
		if (override !== undefined) {
			matchedOverrideEpochs.add(cand.startMillis);
			const ovDtstart = override.dtstart;
			if (ovDtstart === undefined) continue; // 壊れたオーバーライド(DTSTART 欠落)は飛ばす。
			const period = effectiveEventPeriod({ dtstart: ovDtstart, dtend: override.dtend, duration: override.duration }, instantOpts);
			occurrences.push({
				recurrenceId: cand.localValue, // recurrenceId は master 時刻のまま(item6)。
				startMillis: period.startMillis,
				endMillis: period.endMillis,
				source: "override",
				component: override,
			});
			continue;
		}

		if (cand.explicitEndMillis !== undefined) {
			// RDATE;VALUE=PERIOD 由来。
			occurrences.push({
				recurrenceId: cand.localValue,
				startMillis: cand.startMillis,
				endMillis: cand.explicitEndMillis,
				source: "master",
				component: master,
			});
			continue;
		}

		const period = effectivePeriodForOccurrence(cand.localValue, master, instantOpts);
		occurrences.push({
			recurrenceId: cand.localValue,
			startMillis: period.startMillis,
			endMillis: period.endMillis,
			source: "master",
			component: master,
		});
	}

	// --- detached オーバーライド(一致する RRULE/RDATE occurrence が無いもの)も含める(item6)---
	// iOS 実データ耐性: サーバーが EXDATE を打ち忘れた、あるいはクライアントが
	// RECURRENCE-ID を本来の反復時刻からズラして送ってきた等、素直に一致しないケースが
	// 実際にある。一致しないからと言って黙って捨てると、そのオーバーライドが
	// クライアント側に一切見えなくなる事故になるため、そのまま1件として含める。
	for (const [ridEpoch, ov] of overrideByEpoch) {
		if (matchedOverrideEpochs.has(ridEpoch)) continue;
		const rid = ov.recurrenceId;
		const ovDtstart = ov.dtstart;
		if (rid === undefined || ovDtstart === undefined) continue;
		const period = effectiveEventPeriod({ dtstart: ovDtstart, dtend: ov.dtend, duration: ov.duration }, instantOpts);
		occurrences.push({
			recurrenceId: rid,
			startMillis: period.startMillis,
			endMillis: period.endMillis,
			source: "override",
			component: ov,
		});
	}

	// detached オーバーライドは candidates の並びに乗っていないので、最後にもう一度整列する。
	occurrences.sort((a, b) => a.startMillis - b.startMillis);

	// --- range フィルタ(item8)---------------------------------------------------------
	const filtered = occurrences.filter((o) => overlapsRange(o, range));

	return { occurrences: filtered, limitHit };
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * CalDate | CalDateTime → UTC エポックミリ秒。dtstart/RDATE/EXDATE/RECURRENCE-ID 共通の変換窓口。
 *
 * J-4(2026-07-14): VJOURNAL の RRULE 展開(vjournal-expansion.ts)からも同じ変換規約が要る
 * ため export する。VEVENT 専用ロジック(effectivePeriodForOccurrence 等、DTEND/DURATION を
 * 見るもの)は export しない — VJOURNAL には無い概念なので、export 範囲を「VEVENT/VJOURNAL
 * 共通の壁時計⇔epoch 変換」だけに絞ることで「VJOURNAL 展開が誤って VEVENT 専用ロジックに
 * 依存する」事故を型で防ぐ(export しなければ import できない)。
 */
export function instantOfDateValue(v: CalDate | CalDateTime, opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string }): number {
	if (isCalDateTime(v)) {
		return calDateTimeToEpochMillis(v, opts);
	}
	return calDateStartEpochMillis(v, opts.floatingTimeZone);
}

/**
 * RecurrenceIterator に渡す壁時計フィールドへ変換する。DATE 値は時分秒 0。
 * うるう秒(秒=60)は instant.ts / effective-period.ts と同じ方針で計算時のみ 59 にクランプする
 * (iterator に 60 を渡すと ical.js 側の Date 相当処理で繰り上がる可能性があるための保険)。
 */
export function wallFieldsOf(v: CalDate | CalDateTime): RecurrenceWallClockFields {
	if (isCalDateTime(v)) {
		return { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second === 60 ? 59 : v.second };
	}
	return { year: v.year, month: v.month, day: v.day, hour: 0, minute: 0, second: 0 };
}

/**
 * iterator が返した壁時計フィールドを、dtstart と同じ kind(floating/utc/zoned)の
 * CalDateTime へ組み戻す。tzid は dtstart のものをそのまま引き継ぐ(反復中に変わらない)。
 */
export function reconstructCalDateTime(dtstart: CalDateTime, wf: RecurrenceWallClockFields): CalDateTime {
	const base = { year: wf.year, month: wf.month, day: wf.day, hour: wf.hour, minute: wf.minute, second: wf.second };
	switch (dtstart.kind) {
		case "utc":
			return { kind: "utc", ...base };
		case "floating":
			return { kind: "floating", ...base };
		case "zoned":
			return { kind: "zoned", tzid: dtstart.tzid, ...base };
	}
}

/**
 * RRULE から UNTIL を除いた(かつ DATE dtstart なら BYSECOND/BYMINUTE/BYHOUR も除いた)コピーを作る。
 * iterator port の契約(iterator-port.ts 冒頭)どおり、UNTIL の epoch 厳密判定は呼び出し側
 * (このファイル)の責務であって port には渡さない。
 */
export function ruleWithoutUntilForIterator(rule: RecurrenceRule, isDate: boolean): RecurrenceRule {
	const { until: _until, bySecond, byMinute, byHour, ...rest } = rule;
	if (!isDate) {
		return { ...rest, bySecond, byMinute, byHour };
	}
	// I9(§3.3.10 の「無視 MUST」): DATE dtstart のとき BYSECOND/BYMINUTE/BYHOUR は無視する。
	// values/semantics 層はこれを違反として報告しない方針(vevent.ts validateRRule コメント)
	// なので、展開層であるここが実際に「無視」を実装する最終地点になる。
	return { ...rest };
}

/**
 * RRULE UNTIL の epoch(item2)。
 *   - type "date"(DTSTART=DATE のケース) → floatingTimeZone での現地 00:00。
 *   - type "date-time" kind "utc"        → toEpochMillis(絶対時刻そのまま)。
 *   - type "date-time" kind "floating"   → floatingTimeZone で解釈。
 * zoned は values 層の構文上あり得ない(RecurUntil 型に含まれない)ので分岐不要。
 */
export function untilEpochOf(until: RecurUntil, opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string }): number {
	if (until.type === "date") {
		return calDateStartEpochMillis(until.date, opts.floatingTimeZone);
	}
	if (until.dateTime.kind === "utc") {
		return toEpochMillis(until.dateTime);
	}
	return calDateTimeToEpochMillis(until.dateTime, opts);
}

/** EXDATE Property 群 → epoch の集合(item5)。RDATE と違い PERIOD 形態は §3.8.5.1 の構文に存在しない。 */
function exdateEpochsOf(
	props: readonly Property[],
	opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string },
): Set<number> {
	const epochs = new Set<number>();
	for (const p of props) {
		const valueType = paramFirst(p, "VALUE")?.toUpperCase();
		const tzid = paramFirst(p, "TZID");
		for (const item of p.value.split(",")) {
			const value = valueType === "DATE" ? parseCalDate(item) : parseCalDateTime(item, tzid);
			epochs.add(instantOfDateValue(value, opts));
		}
	}
	return epochs;
}

/**
 * item7: RRULE/RDATE(DATE・DATE-TIME 形態)由来の occurrence 1件の実効期間を、
 * マスターの DTEND/DURATION 規則から算出する。
 *
 * 使い分け(effective-period.ts の nominal/exact 方針をそのまま踏襲):
 *   - master.duration あり           → effectiveEventPeriod の addDuration に委譲
 *                                       (weeks/days=nominal, h/m/s=exact を occStart 基準で計算)。
 *   - master.dtend が DATE-TIME       → master の (DTEND-DTSTART) を **exact ミリ秒差**として
 *                                       occurrence の epoch に加算(時刻付きイベントは絶対時間差)。
 *   - master.dtend が DATE            → 日数差を **nominal** に加算。DurationValue{days} を
 *                                       合成して effectiveEventPeriod の addDuration に委譲する
 *                                       ことで、DST 跨ぎでも壁時計の日数が保たれる(終日イベントの
 *                                       直感「同じ日数だけ続く」を壊さない)。
 *   - どちらも無し                    → effectiveEventPeriod の §9.9 既定(DATE-TIME→0秒/DATE→+P1D)。
 */
function effectivePeriodForOccurrence(
	occStart: CalDate | CalDateTime,
	master: VEvent,
	opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string },
): EffectivePeriod {
	const masterDtstart = master.dtstart;
	if (masterDtstart === undefined) {
		throw new Error("RecurrenceExpansion: master VEVENT has no DTSTART");
	}

	if (master.duration !== undefined) {
		return effectiveEventPeriod({ dtstart: occStart, duration: master.duration }, opts);
	}

	const dtend = master.dtend;
	if (dtend !== undefined) {
		if (isCalDateTime(dtend)) {
			// DATE-TIME DTEND: exact ミリ秒差(occStart の値型は I6 により DTSTART と一致するので
			// occStart も DATE-TIME のはず)。
			const masterStart = instantOfDateValue(masterDtstart, opts);
			const masterEnd = instantOfDateValue(dtend, opts);
			const startMillis = instantOfDateValue(occStart, opts);
			return { startMillis, endMillis: startMillis + (masterEnd - masterStart) };
		}
		// DATE DTEND: nominal 日数差。occStart も CalDate のはず(I6)。
		if (isCalDateTime(occStart)) {
			throw new Error("RecurrenceExpansion: DATE DTEND on a DATE-TIME occurrence (I6 violation)");
		}
		if (isCalDateTime(masterDtstart)) {
			throw new Error("RecurrenceExpansion: DATE DTEND on a DATE-TIME master DTSTART (I6 violation)");
		}
		const dayDiff = calendarDaysBetween(masterDtstart, dtend);
		// 日数差を DurationValue{days} として合成し、addDuration(nominal)へ委譲する。
		// 0 日差(本来 I3 で DTEND>DTSTART が強制されるので通常起きないが、壊れたデータへの
		// 保険として符号 0 も durationValue が受理する)。
		const duration = durationValue({ positive: dayDiff >= 0, days: Math.abs(dayDiff) });
		return effectiveEventPeriod({ dtstart: occStart, duration }, opts);
	}

	// どちらも無し: §9.9 の既定(DATE-TIME→0秒 / DATE→+P1D)を再利用。
	return effectiveEventPeriod({ dtstart: occStart }, opts);
}

/**
 * 2つの CalDate の暦日差(b - a、日数)。Date.UTC を「TZ 非依存の暦カウンタ」として使う
 * (effective-period.ts の addDays と同じ考え方。あちらは非公開関数で G-1 の完成物を変更しない
 * 方針のためここで独立に実装する。閏年・月またぎは Date.UTC が正しく面倒を見る)。
 */
function calendarDaysBetween(a: CalDate, b: CalDate): number {
	const aMillis = Date.UTC(a.year, a.month - 1, a.day);
	const bMillis = Date.UTC(b.year, b.month - 1, b.day);
	return Math.round((bMillis - aMillis) / 86_400_000);
}

/**
 * occurrence の実効 [start, end) が range と重なるかを判定する(item8)。
 * RFC 4791 §9.9: overlap = "(start < DTEND AND end > DTSTART)"。ゼロ長(end==start)は
 * 同じ §9.9 の別行 "(start <= DTSTART AND end > DTSTART)" に合わせる。
 */
export function overlapsRange(o: { startMillis: number; endMillis: number }, range: { startMillis: number; endMillis: number }): boolean {
	if (o.startMillis === o.endMillis) {
		return range.startMillis <= o.startMillis && range.endMillis > o.startMillis;
	}
	return o.startMillis < range.endMillis && o.endMillis > range.startMillis;
}
