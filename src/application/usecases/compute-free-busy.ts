// =============================================================================
// ComputeFreeBusy ユースケース — RFC 4791 §7.10 free-busy-query REPORT(G-4)
// =============================================================================
//
// 【この G-4 の実装が担う範囲(確定設計メモ「スコープ」)】
// Yes: VEVENT の反復展開 + FBTYPE 導出(domain/ical/freebusy)+ range へのクリップ + coalesce。
// No: 複数コレクション/calendar-home 集約(Depth>0 相当)/ VFREEBUSY コンポーネントの取り込み /
//     CALDAV:read-free-busy 権限(A-1/D 前提。単一ユーザーの今は常に許可)/ availability
//     (RFC 7953)。いずれも後続タスク。
//
// 【MCP / DAV 共通の第一級ユースケース(08 §6 Tier2、09 §1)】
// このユースケースは DAV の free-busy-query REPORT だけでなく、将来の MCP free-busy ツール
// (G-5)からも同じ形で呼べるよう、CalDAV/WebDAV の語彙(XML 要素名等)を一切知らない。
// 出力も構造化 BusyInterval[](TZ 非依存の epoch ms)に留め、iCalendar(VFREEBUSY)化は
// 呼び出し側(DAV なら presentation/dav/xml.ts の serializeFreeBusyResponse)に委ねる
// (「応答 TZ 分離」= 出力表現をユースケースから追い出す。09 §1 の方針)。
//
// 【CalendarQuery(G-3)との類似点・相違点】
// 「SQL の粗い絞り込み → expandRecurrenceSet で精密判定」という2段構えは CalendarQuery と
// 完全に同じ(TIME_RANGE_TZ_SLACK_MS のコメント参照)。相違点は、CalendarQuery が
// 「マッチしたリソースそのもの」を返すのに対し、ここでは各 occurrence を実際に
// busy 区間(BusyInterval)へ変換し、range にクリップしたうえで全件 coalesce する。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import { expandRecurrenceSet, zoneResolverFor, type RecurrenceIterator } from "../../domain/ical/recurrence";
import { deriveFreeBusyType, coalesceBusyIntervals, type BusyInterval } from "../../domain/ical/freebusy";
import type { CalendarObjectResourceRepository } from "../ports";

export interface ComputeFreeBusyInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/** free-busy-query の必須 time-range(§9.11: free-busy-query は time-range を必ず1個含む)。
	 *  RFC 4791 §9.9 と同じ半開区間 [rangeStartMillis, rangeEndMillis) の規約。 */
	rangeStartMillis: number;
	rangeEndMillis: number;
	/** floating な DTSTART/DTEND を解釈するゾーン(CalendarQuery の CALDAV:timezone と同じ役割)。
	 *  省略時は UTC(§7.3 の既定)。 */
	floatingTimeZone?: string;
}

export interface ComputeFreeBusyOutput {
	/** range にクリップ・coalesce 済みの busy 区間(開始時刻昇順)。 */
	intervals: BusyInterval[];
}

// CalendarQuery(calendar-query.ts)の CALENDAR_QUERY_MAX_OCCURRENCES と同じ理由・同じ値。
// 「呼び出し側が意識して決める」という expandRecurrenceSet の設計方針(maxOccurrences
// コメント参照)に従い、ここでも明示定数を持つ。値を揃えるのは「同じ入力なら同じだけ見える」
// という直感を壊さないため(calendar-query.ts のコメントをそのまま踏襲)。
const FREE_BUSY_MAX_OCCURRENCES = 3000;

// CalendarQuery の TIME_RANGE_TZ_SLACK_MS と全く同じ理由(floating の別ゾーン解釈が SQL の
// UTC 前提索引からこぼれ落ちる事故を防ぐ)。値も揃える。
const TIME_RANGE_TZ_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * ComputeFreeBusy ユースケース(RFC 4791 §7.10)。
 *
 * 単一コレクション内の VEVENT を展開し、busy な occurrence を BusyInterval へ変換する。
 * TRANSPARENT/CANCELLED は FREE として除外(deriveFreeBusyType が null を返す)。
 */
export class ComputeFreeBusy {
	constructor(
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: ComputeFreeBusyInput): Promise<ComputeFreeBusyOutput> {
		const range = { startMillis: input.rangeStartMillis, endMillis: input.rangeEndMillis };
		const floatingTimeZone = input.floatingTimeZone ?? "UTC";

		// --- SQL 側の粗い絞り込み(CalendarQuery と同じスラック加算)------------------------
		// スラック加算はこの application 層の責務。repository は TZ 知識を持たない
		// (calendar-query.ts の同名コメントを参照。ここでも方針は同一)。
		const candidates = await this.resourceRepo.findInCollectionByTimeRange(
			input.owner,
			input.collectionId,
			"VEVENT",
			range.startMillis - TIME_RANGE_TZ_SLACK_MS,
			range.endMillis + TIME_RANGE_TZ_SLACK_MS,
		);

		const busy: BusyInterval[] = [];
		for (const candidate of candidates) {
			// candidate.payload は CalendarObjectResource.fromIcs 時点で parse 済み(二重 parse 回避)。
			const obj = candidate.payload;
			const events = obj.events();
			const master = events.find((e) => e.recurrenceId === undefined);
			if (master === undefined) continue; // マスターが無い壊れたリソースは判定不能 = 除外。

			const overrides = events.filter((e) => e.recurrenceId !== undefined);
			const zoneOf = zoneResolverFor(obj);

			try {
				const result = expandRecurrenceSet(
					this.recurrenceIterator,
					{ master, overrides, range },
					{ zoneOf, floatingTimeZone, maxOccurrences: FREE_BUSY_MAX_OCCURRENCES },
				);
				for (const occ of result.occurrences) {
					// occurrence ごとの TRANSP/STATUS は、その occurrence を実際に生成した
					// component(オーバーライドがあればオーバーライド VEvent、無ければマスター)
					// から読む。マスターの TRANSP/STATUS を全 occurrence に一律適用すると、
					// 「この回だけ TENTATIVE にオーバーライドした」ケースを取りこぼす。
					const fbType = deriveFreeBusyType(occ.component);
					if (fbType === null) continue; // FREE(TRANSPARENT または CANCELLED)は寄与しない。

					// range へクリップ(確定設計メモのとおり: [max(occ.start, rangeStart),
					// min(occ.end, rangeEnd)))。expandRecurrenceSet は range と「重なる」
					// occurrence を返すだけで、occurrence 自体が range をはみ出しうる
					// (例: 長時間イベントが range の前後にまたがる)ため、ここで切り詰める。
					const startMillis = Math.max(occ.startMillis, range.startMillis);
					const endMillis = Math.min(occ.endMillis, range.endMillis);
					if (endMillis <= startMillis) continue; // クリップで潰れた(0 長以下)分は捨てる。

					busy.push({ startMillis, endMillis, type: fbType });
				}
			} catch {
				// 壊れた RRULE 等で展開が例外を投げても、その1件を無視して他の候補の判定は続ける
				// (calendar-query.ts と同じ「索引/フィルタの失敗で REPORT 全体を壊さない」方針)。
				continue;
			}
		}

		return { intervals: coalesceBusyIntervals(busy) };
	}
}
