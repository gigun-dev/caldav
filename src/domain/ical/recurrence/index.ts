// =============================================================================
// recurrence/ 層の公開 API 集約(re-export)
// =============================================================================
//
// RRULE/RDATE/EXDATE/RECURRENCE-ID オーバーライドの総合展開(docs/modeling/03 §1-4、
// 08 §5-6)を1箇所から取り出せるようにする。上位(application 層の REPORT/expand-property
// ユースケース、あるいは ical/index.ts 経由)はここからのみ import する想定。
//
// 公開するもの:
//   - iterator-port: RecurrenceIterator(RRULE 反復だけを domain の外へ委譲する port)。
//     実装(adapter)は infrastructure/recurrence/icaljs-rrule-iterator.ts。
//   - occurrence: Occurrence 値オブジェクト(展開結果1件分)。
//   - expansion: expandRecurrenceSet(展開の本体)+ 入出力型。
//   - occurrence-bounds: computeOccurrenceBounds(G-3: PUT 時の first/last occurrence 索引計算)+
//     OCCURRENCE_INDEX_MAX(無限反復の last キャップ)+ zoneResolverFor(zoneOf 組み立て共通ヘルパー)。
// =============================================================================

export type { RecurrenceIterator, RecurrenceWallClockFields } from "./iterator-port";
export type { Occurrence } from "./occurrence";
export {
	expandRecurrenceSet,
	type RecurrenceExpansionInput,
	type RecurrenceExpansionOptions,
	type RecurrenceExpansionResult,
} from "./expansion";
export {
	computeOccurrenceBounds,
	zoneResolverFor,
	OCCURRENCE_INDEX_MAX,
	type OccurrenceBounds,
	type ComputeOccurrenceBoundsInput,
	type ComputeOccurrenceBoundsOptions,
} from "./occurrence-bounds";
// J-4: VJOURNAL の time-range calendar-query 判定(RRULE 展開込み)。expandRecurrenceSet と
// 違い occurrence 配列ではなく bool を返す(vjournal-expansion.ts 冒頭コメント参照)。
export {
	vjournalOverlapsRange,
	type VJournalOverlapInput,
	type VJournalOverlapOptions,
} from "./vjournal-expansion";
