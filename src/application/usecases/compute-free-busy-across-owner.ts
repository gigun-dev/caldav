// =============================================================================
// ComputeFreeBusyAcrossOwner — owner 配下の free/busy を「コレクション横断1クエリ」で計算(レイテンシ案2)
// =============================================================================
//
// 【この UC の立ち位置】
// get-freebusy MCP ツールの「calendarId 省略=全横断 / calendarId=単一」を、コレクション列挙 SQL
// なしの **1 D1 往復**で満たす。既存 ComputeFreeBusy(compute-free-busy.ts)は RFC 4791 §7.10
// free-busy-query REPORT(G-4)の単一コレクション UC として**不変**に残す。
//
// 【末尾 coalesce をこの UC が内包する理由(旧 server.ts の手動 coalesce を吸収)】
// 旧 get-freebusy は ComputeFreeBusy を N 並列で叩き、各コレクションの intervals(各々コレクション内
// では coalesce 済み)を集めてから server.ts 側でもう一度 coalesceBusyIntervals していた
// (コレクションをまたいだ重複/連続は集約後にしか解消できないため)。全横断を1クエリにする本 UC では
// 全 occurrence が最初から混ざって入ってくるので、UC の末尾で1回 coalesce すれば足りる。
// server.ts に coalesce 知識を残さない(意味計算を application 層へ寄せる)。
//
// 【スコープ外】VEVENT のみ。VFREEBUSY コンポーネント取り込み・availability(RFC 7953)・
// read-free-busy 権限は既存 ComputeFreeBusy と同じく対象外。出力は epoch ms のまま
// (VFREEBUSY 化・ISO 整形は呼び出し側)。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import type { RecurrenceIterator } from "../../domain/ical/recurrence";
import { coalesceBusyIntervals, deriveFreeBusyType, type BusyInterval } from "../../domain/ical/freebusy";
import type { CalendarObjectResourceRepository } from "../ports";
import { expandOwnerOccurrences } from "./expand-owner-occurrences";

export interface ComputeFreeBusyAcrossOwnerInput {
	owner: PrincipalRef;
	/** free-busy-query の必須 time-range。半開区間 [rangeStartMillis, rangeEndMillis)。 */
	rangeStartMillis: number;
	rangeEndMillis: number;
	/** floating な DTSTART/DTEND を解釈するゾーン。省略時は UTC。 */
	floatingTimeZone?: string;
	/** 対象コレクション。undefined = 全横断 / 集合指定 = その集合に限定。 */
	collectionIds?: readonly CollectionId[];
}

export interface ComputeFreeBusyAcrossOwnerOutput {
	/** range にクリップ・全コレクション横断で coalesce 済みの busy 区間(開始時刻昇順)。 */
	intervals: BusyInterval[];
}

/**
 * ComputeFreeBusyAcrossOwner ユースケース(レイテンシ案2)。
 *
 * findByOwnerTimeRange で owner 配下の VEVENT 候補を1クエリ取得し、各 occurrence を BusyInterval へ
 * 変換して range にクリップ、最後に横断 coalesce して返す。
 */
export class ComputeFreeBusyAcrossOwner {
	constructor(
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly iterator: RecurrenceIterator,
	) {}

	async execute(input: ComputeFreeBusyAcrossOwnerInput): Promise<ComputeFreeBusyAcrossOwnerOutput> {
		const range = { startMillis: input.rangeStartMillis, endMillis: input.rangeEndMillis };
		const floatingTimeZone = input.floatingTimeZone ?? "UTC";

		const busy: BusyInterval[] = [];
		await expandOwnerOccurrences(
			this.resourceRepo,
			this.iterator,
			{ owner: input.owner, componentKind: "VEVENT", range, floatingTimeZone, collectionIds: input.collectionIds },
			({ occurrence: occ }) => {
				// occurrence ごとの TRANSP/STATUS は、それを生成した component(override 優先)から読む
				// (マスター一律適用だと「この回だけ TENTATIVE」を取りこぼす。既存 ComputeFreeBusy と同じ)。
				const fbType = deriveFreeBusyType(occ.component);
				if (fbType === null) return; // FREE(TRANSPARENT / CANCELLED)は寄与しない。

				// range へクリップ([max(occ.start, rangeStart), min(occ.end, rangeEnd)))。
				// expandRecurrenceSet は range と「重なる」occurrence を返すだけで、occurrence 自体は
				// range をはみ出しうるためここで切り詰める(既存 ComputeFreeBusy と同一処理)。
				const startMillis = Math.max(occ.startMillis, range.startMillis);
				const endMillis = Math.min(occ.endMillis, range.endMillis);
				if (endMillis <= startMillis) return; // クリップで潰れた分は捨てる。

				busy.push({ startMillis, endMillis, type: fbType });
			},
		);

		// 全コレクション横断で1回 coalesce(旧 server.ts の手動 coalesce をここへ内包)。
		return { intervals: coalesceBusyIntervals(busy) };
	}
}
