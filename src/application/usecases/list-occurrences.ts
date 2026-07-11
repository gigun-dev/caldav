// =============================================================================
// ListOccurrences ユースケース — 展開済み occurrence の列挙(G-5: MCP list-events-expanded の共通 UC)
// =============================================================================
//
// 【この UC が担う範囲】
// docs/modeling/09 §2 が第一級ユースケースとして名指し: MCP の `list-events-expanded` ツールが
// 呼ぶ想定だが、CalDAV の各種 REPORT からも将来使えるよう application 層に置く
// (CLAUDE.md 長期ビジョン1「MCP / REST / メールハンドラなど複数の入口から呼べる形を保つ」)。
// **MCP/認証/トランスポートには一切依存しない。** 入出力は構造化データ(epoch ms のまま)に
// 徹し、ISO 化・TZ 整形・XML/JSON シリアライズは呼び出し側(presentation/MCP アダプタ)の
// 責務とする(09 §1「応答 TZ 分離」の方針。compute-free-busy.ts のコメントと同じ考え方)。
//
// 【CalendarQuery(G-3)/ComputeFreeBusy(G-4)との違い】
// 「SQL の粗い絞り込み(スラック込み)→ expandRecurrenceSet で精密展開」という2段構えの
// パターンは両者と完全に同じ(TIME_RANGE_TZ_SLACK_MS のコメント参照。calendar-query.ts /
// compute-free-busy.ts からそのまま踏襲)。相違点は出力の形:
//   - CalendarQuery: time-range にマッチした「リソースそのもの」(展開はマッチ判定にしか使わない)。
//   - ComputeFreeBusy: 展開結果を busy 区間(BusyInterval)に変換して coalesce。
//   - ListOccurrences(この UC): 展開結果の occurrence を「個々の平坦な列」としてそのまま返す
//     (uid/calendarId を添えるだけで、TRANSP/STATUS のような意味づけは行わない)。
// 将来の CALDAV:expand(limit-recurrence-set)REPORT が同じ「展開済み occurrence 列挙」を
// 必要とするようになれば、この UC をそのまま流用できる想定。
//
// 【スコープ外(このコメントで明示。実装を漏れなく追えるように)】
// - VEVENT のみ。VTODO/VJOURNAL の展開・ツール露出はスコープ外(反復 VTODO は
//   CalendarQuery と同じ理由で展開しない設計だが、そもそもこの UC には候補として来ない
//   — findInCollectionByTimeRange の componentKind 引数を "VEVENT" 固定で呼ぶため)。
// - 単一コレクションのみ。複数コレクション(calendar-home 集約)をまたぐ列挙は、
//   MCP アダプタ側でこの UC を複数コレクション分呼んでマージする話であり、この UC 自身の
//   責務ではない(CalendarObjectResourceRepository のポート定義自体が単一コレクション単位)。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import { expandRecurrenceSet, zoneResolverFor, type Occurrence, type RecurrenceIterator } from "../../domain/ical/recurrence";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface ListOccurrencesInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/** 展開対象の期間。半開区間 [rangeStartMillis, rangeEndMillis)。RFC 4791 §9.9 と同じ規約
	 *  (calendar-query.ts / compute-free-busy.ts と同じ規約に揃える)。 */
	rangeStartMillis: number;
	rangeEndMillis: number;
	/** floating な DTSTART/DTEND を解釈するゾーン(CalendarQuery の CALDAV:timezone と同じ役割)。
	 *  省略時は UTC(§7.3 の既定)。 */
	floatingTimeZone?: string;
}

// --- 出力 DTO ---

/** occurrence 1件分。uid はマスターの UID(見つからない壊れたリソースはそもそも skip されるので
 *  ここでは常に取得できるが、型として素朴に string を使い、防御的に master.uid が undefined の
 *  ケースは execute() 側の skip 分岐で吸収する)。 */
export interface ListOccurrencesEntry {
	readonly uid: string;
	readonly calendarId: CollectionId;
	/** domain の Occurrence をそのまま返す。epoch ms のまま(ISO 化は呼び出し側の責務)。 */
	readonly occurrence: Occurrence;
}

export interface ListOccurrencesOutput {
	/** startMillis 昇順にソート済み(複数リソースの occurrence が混ざるため、呼び出し側が
	 *  そのまま時系列表示できるようにこの UC の責務でソートしておく)。 */
	occurrences: ListOccurrencesEntry[];
	/** いずれかの候補で expandRecurrenceSet が maxOccurrences に到達(limitHit)した場合 true。
	 *  MCP 応答の truncated フラグの元になる(呼び出し側がユーザーに「結果が不完全かもしれない」
	 *  ことを伝えるための判断材料)。 */
	truncated: boolean;
}

// CalendarQuery の CALENDAR_QUERY_MAX_OCCURRENCES と同じ理由・同じ値。
// 「呼び出し側が意識して決める」という expandRecurrenceSet の設計方針(maxOccurrences
// コメント参照)に従い、ここでも明示定数を持つ。値を揃えるのは「同じ入力なら同じだけ見える」
// という直感を壊さないため(calendar-query.ts / compute-free-busy.ts のコメントをそのまま踏襲)。
const LIST_OCCURRENCES_MAX_OCCURRENCES = 3000;

// CalendarQuery / ComputeFreeBusy の TIME_RANGE_TZ_SLACK_MS と全く同じ理由(floating の
// 別ゾーン解釈が SQL の UTC 前提索引からこぼれ落ちる事故を防ぐ)。値も揃える。
const TIME_RANGE_TZ_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * ListOccurrences ユースケース(docs/modeling/09 §2、G-5 の list-events-expanded MCP ツールが
 * 呼ぶ共通 UC)。
 *
 * 単一コレクション内の VEVENT を反復展開し、range と重なる occurrence を平坦な列として返す。
 * CalendarQuery と違い「マッチしたリソース」ではなく「マッチした occurrence 1件1件」を返す点に注意。
 */
export class ListOccurrences {
	constructor(
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: ListOccurrencesInput): Promise<ListOccurrencesOutput> {
		const range = { startMillis: input.rangeStartMillis, endMillis: input.rangeEndMillis };
		const floatingTimeZone = input.floatingTimeZone ?? "UTC";

		// --- SQL 側の粗い絞り込み(CalendarQuery / ComputeFreeBusy と同じスラック加算)-------
		// スラック加算はこの application 層の責務。repository は TZ 知識を持たない
		// (calendar-query.ts の同名コメントを参照。ここでも方針は同一)。
		const candidates = await this.resourceRepo.findInCollectionByTimeRange(
			input.owner,
			input.collectionId,
			"VEVENT",
			range.startMillis - TIME_RANGE_TZ_SLACK_MS,
			range.endMillis + TIME_RANGE_TZ_SLACK_MS,
		);

		const entries: ListOccurrencesEntry[] = [];
		let truncated = false;

		for (const candidate of candidates) {
			// candidate.payload は CalendarObjectResource.fromIcs 時点で parse 済み(二重 parse 回避)。
			const obj = candidate.payload;
			const events = obj.events();
			const master = events.find((e) => e.recurrenceId === undefined);
			if (master === undefined) continue; // マスターが無い壊れたリソースは判定不能 = 除外。

			// UID が無いリソースも同様に壊れているとみなし skip する(uid は出力 DTO の必須フィールド
			// なので undefined を持ち込まない。CalendarQuery/ComputeFreeBusy には無い分岐だが、
			// 両者は uid を出力しないので露見していなかっただけで、リソースとして壊れているのは同じ)。
			const uid = master.uid;
			if (uid === undefined) continue;

			const overrides = events.filter((e) => e.recurrenceId !== undefined);
			const zoneOf = zoneResolverFor(obj);
			try {
				const result = expandRecurrenceSet(
					this.recurrenceIterator,
					{ master, overrides, range },
					{ zoneOf, floatingTimeZone, maxOccurrences: LIST_OCCURRENCES_MAX_OCCURRENCES },
				);
				if (result.limitHit) truncated = true;
				for (const occurrence of result.occurrences) {
					entries.push({ uid, calendarId: input.collectionId, occurrence });
				}
			} catch {
				// 壊れた RRULE 等で展開が例外を投げても、その1件を無視して他の候補の判定は続ける
				// (calendar-query.ts / compute-free-busy.ts と同じ「索引/フィルタの失敗で
				// REPORT/UC 全体を壊さない」方針)。
				continue;
			}
		}

		// 複数リソースの occurrence が混ざるため、startMillis 昇順に整列してから返す。
		entries.sort((a, b) => a.occurrence.startMillis - b.occurrence.startMillis);

		return { occurrences: entries, truncated };
	}
}
