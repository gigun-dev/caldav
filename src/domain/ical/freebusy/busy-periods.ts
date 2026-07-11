// =============================================================================
// FreeBusy — RFC 4791 §7.10 free-busy-query REPORT のための busy 区間ドメインロジック
// =============================================================================
//
// 【この service の位置づけ(G-4 確定設計メモ)】
// free-busy-query REPORT は VEVENT の集合から「busy な時間区間」を導出する。
// この導出は RFC 4791 §7.10 のテーブル(TRANSP/STATUS → FBTYPE)そのものなので、
// CalDAV 語彙(WebDAV XML 等)を一切知らない純粋なドメインロジックとして domain 層に置く
// (application 層は「反復展開して各回に適用する」オーケストレーションに徹する。CLAUDE.md
// のオニオン方針どおり、意味論は domain、orchestration は application)。
//
// 【スコープ(G-4 の Yes/No)】
// Yes: VEVENT のみを対象にした FBTYPE 導出と、同一 FBTYPE 内の coalesce。
// No: VFREEBUSY コンポーネントの取り込み(既存の VFREEBUSY をそのまま返す機能)は
//     このタスクのスコープ外(後続タスクで対応)。CALDAV:read-free-busy 権限も対象外
//     (単一ユーザーの現状は常に許可。A-1/D の権限モデル整備を前提とする後続課題)。
// =============================================================================

import type { VEvent } from "../semantics/vevent";

/**
 * §7.10 のテーブルで「x-name STATUS も当面 BUSY にまとめる」の簡略化のとおり、
 * このタスクでは FBTYPE を BUSY / BUSY-TENTATIVE の2値に絞る
 * (BUSY-UNAVAILABLE 等は VFREEBUSY 取り込みが実装されたときに検討する後続課題)。
 */
export type FreeBusyType = "BUSY" | "BUSY-TENTATIVE";

/**
 * busy 区間1件。VFREEBUSY の FREEBUSY プロパティ1行に対応する構造化データ
 * (§3.8.2.6)。TZ 非依存の絶対時刻(UTC エポックミリ秒)で持つ — 応答の iCalendar 化
 * (UTC の YYYYMMDDTHHMMSSZ への整形)は presentation 層の責務(09 §1「応答 TZ 分離」)。
 */
export interface BusyInterval {
	readonly startMillis: number;
	readonly endMillis: number;
	readonly type: FreeBusyType;
}

/**
 * VEVENT 1件から FBTYPE を導出する(RFC 4791 §7.10 のテーブル、原文で確認済み)。
 *
 * 【テーブルの読み方】
 *   TRANSP=TRANSPARENT                     → 常に FREE(除外。null を返す)。
 *   TRANSP=OPAQUE または未指定(既定 OPAQUE):
 *     STATUS=CANCELLED                     → FREE(除外)。
 *     STATUS=TENTATIVE                     → BUSY-TENTATIVE。
 *     STATUS=CONFIRMED / 未指定(既定) / x-name → BUSY。
 *       (x-name STATUS も当面 BUSY にまとめる。RFC の表は「BUSY or x-name」だが
 *        VFREEBUSY 側の FBTYPE に任意の x-name を新設する機能は今回のスコープ外なので、
 *        安全側 = BUSY に倒す。G-4 確定設計メモのとおり)
 *
 * null は「FREE として扱う(busy 区間に寄与しない)」を意味する。§7.10 「This report
 * only returns busy time information」のとおり、free 側は呼び出し側で単に skip すればよい。
 */
export function deriveFreeBusyType(event: VEvent): FreeBusyType | null {
	// TRANSP は VEvent アクセサが大文字化済み(vevent.ts の transp getter)。既定 OPAQUE(§3.8.2.7)。
	const transp = event.transp ?? "OPAQUE";
	if (transp === "TRANSPARENT") return null;

	// STATUS も VEvent アクセサが大文字化済み(§3.8.1.11)。未指定時の既定は「CONFIRMED 相当」= BUSY。
	const status = event.status;
	if (status === "CANCELLED") return null;
	if (status === "TENTATIVE") return "BUSY-TENTATIVE";
	// CONFIRMED / 未指定 / その他 x-name はすべて BUSY にまとめる(上のコメント参照)。
	return "BUSY";
}

/**
 * 同一 FBTYPE の連続・重複区間をマージする(§7.10 "Servers SHOULD coalesce consecutive
 * or overlapping busy time periods of the same type")。
 *
 * 【なぜ type ごとに独立にマージするか】
 * §7.10 は続けて "Busy time periods with different FBTYPE parameter values MAY overlap"
 * と言っている。つまり BUSY と BUSY-TENTATIVE が同じ時間帯に重なっていても、それは
 * 別々の情報(例: 元の予定は確定 BUSY だが、同時刻に仮予定 BUSY-TENTATIVE も入っている)
 * として両方残すのが正しい。type をまたいでマージすると、この情報が失われてしまう。
 *
 * 【アルゴリズム】
 * type ごとに開始時刻昇順ソート → 隣接区間が「連続または重複」(次の開始 <= 現在の終了)なら
 * 結合(終了を max に更新)。§7.10 は "consecutive or overlapping" と言っており、
 * 「連続」(end == 次の start、隙間ゼロ)も対象に含めるため `>=` ではなく `<` で「重ならない」
 * 側を判定する(= 隙間ゼロも結合対象)。
 * 最終的に全 type の結果をまとめ、開始時刻昇順で返す(型ごとに独立処理した結果を
 * もう一度時系列順に並べ直すことで、呼び出し側は type を意識せず出力できる)。
 */
export function coalesceBusyIntervals(intervals: BusyInterval[]): BusyInterval[] {
	// type ごとにグループ化。
	const byType = new Map<FreeBusyType, BusyInterval[]>();
	for (const iv of intervals) {
		const list = byType.get(iv.type);
		if (list) {
			list.push(iv);
		} else {
			byType.set(iv.type, [iv]);
		}
	}

	const result: BusyInterval[] = [];
	for (const [type, list] of byType) {
		// 開始時刻昇順にソート(同じ開始なら終了が長い方を先に見ても結合結果は同じなので、
		// タイブレークは気にしない)。
		const sorted = [...list].sort((a, b) => a.startMillis - b.startMillis);
		let current: { start: number; end: number } | undefined;
		for (const iv of sorted) {
			if (current === undefined) {
				current = { start: iv.startMillis, end: iv.endMillis };
				continue;
			}
			if (iv.startMillis <= current.end) {
				// 連続(==)または重複(<)。終了を伸ばす(iv.endMillis の方が短い可能性もあるので max)。
				current.end = Math.max(current.end, iv.endMillis);
			} else {
				// 隙間がある → 直前の区間を確定し、新しい区間を開始。
				result.push({ startMillis: current.start, endMillis: current.end, type });
				current = { start: iv.startMillis, end: iv.endMillis };
			}
		}
		if (current !== undefined) {
			result.push({ startMillis: current.start, endMillis: current.end, type });
		}
	}

	result.sort((a, b) => a.startMillis - b.startMillis);
	return result;
}
