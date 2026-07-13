// =============================================================================
// VJournal 反復展開 — RFC 4791 §9.9 の VJOURNAL time-range 実効値表を、反復 VJOURNAL
// (RRULE 付き)にも適用する(J-4)。
// =============================================================================
//
// 【なぜ expandRecurrenceSet(expansion.ts)を素直に共用しないか】
// expandRecurrenceSet は VEVENT 専用に組まれている(型が VEvent 固定、実効期間の算出が
// DTEND/DURATION の有無で分岐する effectivePeriodForOccurrence に依存)。VJOURNAL には
// DTEND/DURATION が無く(§3.6.3 jourprop に無い)、実効期間は §9.9 の表どおり
// 「DATE-TIME なら 0 秒、DATE なら +P1D」で常に一定(occurrence-bounds.ts の
// computeVJournalBounds と同じ規則)。VEvent 型を無理に共用すると DTEND 分岐の意味が
// VJOURNAL には無いのに型だけ VEvent を要求する歪な API になるため、別関数として素直に書く。
// 一方「RRULE 反復そのものの列挙」(UNTIL epoch 判定・壁時計⇔epoch 変換・上限)は VEVENT/
// VJOURNAL で完全に共通なので、expansion.ts から該当ヘルパーを export してもらって再利用する
// (instantOfDateValue / wallFieldsOf / reconstructCalDateTime / untilEpochOf /
// ruleWithoutUntilForIterator / overlapsRange)。
//
// 【スコープ: RDATE/EXDATE は対象外(このタスクの意図的な割り切り)】
// domain/ical/semantics/vjournal.ts の VJournal レンズは現状 RDATE/EXDATE のアクセサを
// 持たない(VTodo/VEvent と違い J-1/J-3 でも追加されなかった)。§9.9 の一般規則
// (「すべての recurrence instance を time-range と照合する」)は RRULE 由来の instance にも
// RDATE 由来の instance にも同じ適用対象だが、この J-4 タスクの手がかりが明示するのは
// 「RRULE 付き VJOURNAL」のみで、VJournal レンズに無いプロパティを新設する作業は別スコープ
// (レンズ拡張 + validate() 見直しが伴う)。ここでは RRULE + RECURRENCE-ID オーバーライドの
// 展開のみを行い、RDATE/EXDATE 対応はレンズ拡張と合わせて別タスクに送る
// (EXDATE を見ずに展開すると「本来除外すべき回」を誤って一致判定してしまう false positive の
// リスクはあるが、VJOURNAL は元々 time-range フィルタの主要ユースケースではなく実害は小さいと
// 判断。将来 RDATE/EXDATE をレンズに追加したら、この関数にも同じ対応を足す)。
// =============================================================================

import { effectiveEventPeriod } from "../timezone";
import { isCalDateTime } from "../semantics/helpers";
import type { VJournal } from "../semantics/vjournal";
import type { RecurrenceIterator } from "./iterator-port";
import {
	instantOfDateValue,
	wallFieldsOf,
	reconstructCalDateTime,
	untilEpochOf,
	ruleWithoutUntilForIterator,
	overlapsRange,
} from "./expansion";

export interface VJournalOverlapInput {
	/** 反復の元になるマスター VJOURNAL(RECURRENCE-ID を持たない本体)。 */
	readonly master: VJournal;
	/** RECURRENCE-ID オーバーライド VJOURNAL 群(マスターと同じ UID・RECURRENCE-ID 付き)。 */
	readonly overrides: readonly VJournal[];
	/** 判定対象の期間。半開区間 [startMillis, endMillis)。RFC 4791 §9.9 の time-range と同じ規約。 */
	readonly range: { readonly startMillis: number; readonly endMillis: number };
}

export interface VJournalOverlapOptions {
	readonly zoneOf: (tzid: string) => string;
	readonly floatingTimeZone?: string;
	/** 展開する occurrence 数の上限。expansion.ts の maxOccurrences と同じ「呼び出し側が
	 *  意識して決める」設計(DoS 対策)を踏襲する。calendar-query.ts が
	 *  CALENDAR_QUERY_MAX_OCCURRENCES を渡す想定。 */
	readonly maxOccurrences: number;
}

/**
 * VJOURNAL(反復含む)が range と1回でも重なるかを判定する(RFC 4791 §9.9「いずれか1つの
 * instance がマッチすればコンポーネント全体がマッチする」)。
 *
 * calendar-query.ts の用途では「1件でも一致するか」の bool だけあれば十分なので、
 * expandRecurrenceSet のような occurrence 配列は返さず bool を直接返す
 * (VEvent 用の Occurrence 型は component: VEvent 固定で VJournal を保持できないため、
 * 型を素直に保つ意味でも配列を返す設計にしない)。
 */
export function vjournalOverlapsRange(
	iterator: RecurrenceIterator,
	input: VJournalOverlapInput,
	opts: VJournalOverlapOptions,
): boolean {
	const { master, overrides, range } = input;
	const floatingTimeZone = opts.floatingTimeZone ?? "UTC";
	const instantOpts = { zoneOf: opts.zoneOf, floatingTimeZone };

	const dtstart = master.dtstart;
	if (dtstart === undefined) {
		// §9.9 の VJOURNAL 表: 「DTSTART 無し → FALSE」(常に不一致)。occurrence-bounds.ts の
		// computeVJournalBounds は索引を安全側(null/null=常に候補)に倒すが、ここは索引ではなく
		// 最終判定そのものなので RFC の表どおり厳密に FALSE を返す。
		return false;
	}

	const rrule = master.rrule;

	// --- RRULE 無し: 単発(occurrence-bounds.ts の computeVJournalBounds と同じ実効期間規則)---
	if (rrule === undefined) {
		const period = effectiveEventPeriod({ dtstart }, instantOpts);
		return overlapsRange(period, range);
	}

	// --- オーバーライド epoch マップ(§3.8.4.4。expansion.ts の overrideByEpoch と同じ規約: キーは
	//     「マスター時刻のまま」の recurrenceId の epoch) ------------------------------------------
	const overrideByEpoch = new Map<number, VJournal>();
	for (const ov of overrides) {
		const rid = ov.recurrenceId;
		if (rid === undefined) continue; // RECURRENCE-ID 無しの override は契約違反。黙って読み飛ばす(expansion.ts と同じ方針)。
		overrideByEpoch.set(instantOfDateValue(rid, instantOpts), ov);
	}

	// --- RRULE 反復列挙(expansion.ts と同じ UNTIL/上限規約) ---------------------------------
	const masterIsDate = !isCalDateTime(dtstart);
	const ruleForIterator = ruleWithoutUntilForIterator(rrule, masterIsDate);
	const untilEpoch = rrule.until !== undefined ? untilEpochOf(rrule.until, instantOpts) : undefined;
	const dtstartFields = wallFieldsOf(dtstart);

	let seen = 0;
	// detached オーバーライド(RRULE 由来の instance と epoch が一致しないもの)も §9.9 上は
	// 「その回のコンポーネントが実在する」ので、まず先に全件チェックしてしまう
	// (iOS 実データ耐性: EXDATE 打ち忘れ等で一致しないオーバーライドを取りこぼさない。
	// expansion.ts の detached オーバーライド処理と同じ配慮)。
	for (const ov of overrides) {
		const ovDtstart = ov.dtstart;
		if (ovDtstart === undefined) continue;
		const period = effectiveEventPeriod({ dtstart: ovDtstart }, instantOpts);
		if (overlapsRange(period, range)) return true;
	}

	for (const wf of iterator.iterate(ruleForIterator, dtstartFields, masterIsDate)) {
		const localValue = masterIsDate
			? { year: wf.year, month: wf.month, day: wf.day }
			: reconstructCalDateTime(dtstart, wf);
		const startMillis = instantOfDateValue(localValue, instantOpts);

		if (untilEpoch !== undefined && startMillis > untilEpoch) break; // UNTIL 厳密判定(inclusive)。
		if (startMillis >= range.endMillis) break; // これ以上未来は絶対に range に入らない(item9 と同じ枝刈り)。

		if (seen >= opts.maxOccurrences) break; // DoS 対策の上限(RDATE 無しなので limitHit フラグは持たず単純に打ち切る)。
		seen++;

		// このマスター由来 instance が既にオーバーライドで置き換わっているなら、上のループで
		// 判定済み(重複判定を避ける)。
		if (overrideByEpoch.has(startMillis)) continue;

		const period = effectiveEventPeriod({ dtstart: localValue }, instantOpts);
		if (overlapsRange(period, range)) return true;
	}

	return false;
}
