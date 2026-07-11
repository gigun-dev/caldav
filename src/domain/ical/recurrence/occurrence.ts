// =============================================================================
// Occurrence — RecurrenceExpansion が返す「反復イベントの1インスタンス」の値オブジェクト
// =============================================================================
//
// 【なぜ recurrenceId と start/end を分けて持つか】
// RECURRENCE-ID オーバーライド(§3.8.4.4)は「時刻を移動した1回」を表現できる
// (例: 毎週の会議のうち1回だけ 10:00→11:00 に変更)。このとき:
//   - recurrenceId は「マスターの RRULE が本来生成した時刻」のまま(オーバーライドを
//     探すためのキー。iOS/CalDAV クライアントもこれで一致判定する。RFC 4791 §5.3.2 等)。
//   - startMillis/endMillis は「実際にクライアントへ返すべき実効時刻」(オーバーライドで
//     置き換わっていればその値)。
// この2つを同じフィールドに潰すと、オーバーライド後は「元々どの回だったか」が
// 失われ、以後の EXDATE 突合や再展開で事故る。
// =============================================================================

import type { VEvent } from "../semantics/vevent";
import type { CalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";

/**
 * 反復展開1件分。recurrenceId は「壁時計の開始」を masterのdtstartと同形態
 * (CalDate | CalDateTime。DATE なら CalDate、DATE-TIME なら CalDateTime)で保持する。
 * これは EXDATE/RDATE/RECURRENCE-ID との突合を「同じ形態同士の比較」に保つため
 * (values 層の設計方針: floating/zoned は VTIMEZONE 解決なしに絶対時刻へ落とさない、
 * を expansion.ts 内部の epoch 判定と混同しないよう、recurrenceId 自体は壁時計のまま持つ)。
 *
 * startMillis/endMillis は実効期間(UTC エポックミリ秒。effectiveEventPeriod や
 * addDuration で算出済みの絶対時刻)。range フィルタ・iOS への応答はこちらを使う。
 */
export interface Occurrence {
	/** マスターの RRULE/RDATE が生成した「本来の」開始時刻(壁時計。オーバーライドされても不変)。 */
	readonly recurrenceId: CalDate | CalDateTime;
	/** 実効開始(UTC エポックミリ秒)。オーバーライドがあればオーバーライド側の値。 */
	readonly startMillis: number;
	/** 実効終了(UTC エポックミリ秒、非包含)。 */
	readonly endMillis: number;
	/** この occurrence がマスターそのものから生成されたか、RECURRENCE-ID オーバーライドで置き換わったか。 */
	readonly source: "master" | "override";
	/** 応答シリアライズに使う VEvent 本体(source="override" ならオーバーライド VEvent、"master" ならマスター VEvent)。 */
	readonly component: VEvent;
}
