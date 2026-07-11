// =============================================================================
// freebusy/ 層の公開 API 集約(re-export)
// =============================================================================
//
// RFC 4791 §7.10 free-busy-query REPORT のための FBTYPE 導出 + coalesce
// (busy-periods.ts)を1箇所から取り出せるようにする。上位(application 層の
// ComputeFreeBusy ユースケース)はここからのみ import する想定
// (recurrence/index.ts と同じ「公開 API 集約」パターン)。
// =============================================================================

export {
	deriveFreeBusyType,
	coalesceBusyIntervals,
	type FreeBusyType,
	type BusyInterval,
} from "./busy-periods";
