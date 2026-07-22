// =============================================================================
// ListOccurrencesAcrossOwner — owner 配下の VEVENT を「コレクション横断1クエリ」で列挙(レイテンシ案2)
// =============================================================================
//
// 【この UC の立ち位置】
// list-events-expanded MCP ツールの「calendarId 省略=全横断 / calendarIds=一部 / calendarId=単一」の
// 3 経路を、コレクション列挙 SQL(findAllByOwner)なしの **1 D1 往復**で満たす。
// 既存 ListOccurrences(list-occurrences.ts)は単一コレクション専用の第一級 UC として**不変**に残し
// (calendar-query 等の別入口が使いうる)、全横断のマージ責務をここへ引き上げる
// (旧: server.ts の runListEvents が ListOccurrences を N 並列で叩いてマージしていた)。
//
// 【なぜ MCP アダプタでなく application 層に置くか】
// 「複数コレクションの occurrence を集めて始点昇順にマージし truncated を OR 畳みする」ロジックは
// プロトコル語彙(XML/JSON)を含まない純粋な意味計算で、REST/メール等の別入口からも同形で
// 呼べる(CLAUDE.md 長期ビジョン1)。旧 server.ts のマージループはこの UC へ移す。
//
// 【スコープ外】VEVENT のみ(componentKind="VEVENT" 固定)。VTODO/VJOURNAL 展開は対象外
// (既存 ListOccurrences と同じ理由)。出力は epoch ms のまま(ISO 化・wire 整形は呼び出し側)。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import type { RecurrenceIterator } from "../../domain/ical/recurrence";
import type { CalendarObjectResourceRepository } from "../ports";
import { expandOwnerOccurrences, type OwnerOccurrence } from "./expand-owner-occurrences";

export interface ListOccurrencesAcrossOwnerInput {
	owner: PrincipalRef;
	/** 展開対象の期間。半開区間 [rangeStartMillis, rangeEndMillis)(RFC 4791 §9.9 と同規約)。 */
	rangeStartMillis: number;
	rangeEndMillis: number;
	/** floating な DTSTART/DTEND を解釈するゾーン。省略時は UTC(§7.3 の既定)。 */
	floatingTimeZone?: string;
	/** 対象コレクション。undefined = owner 配下の全横断 / 集合指定 = その集合に限定
	 *  (ports の findByOwnerTimeRange 契約。空配列 [] は空結果)。 */
	collectionIds?: readonly CollectionId[];
}

/** 単一コレクション UC(ListOccurrencesEntry)と同形だが、全横断なので calendarId が
 *  occurrence ごとに異なりうる(どのカレンダー由来かを per-event で運ぶ)。 */
export interface ListOccurrencesAcrossOwnerEntry {
	readonly uid: string;
	readonly calendarId: CollectionId;
	readonly occurrence: OwnerOccurrence["occurrence"];
}

export interface ListOccurrencesAcrossOwnerOutput {
	/** startMillis 昇順にソート済み(複数コレクションの occurrence が混ざるため、呼び出し側が
	 *  そのまま時系列表示できるよう UC の責務でソートする。並列/1クエリどちらでも順序不変)。 */
	occurrences: ListOccurrencesAcrossOwnerEntry[];
	/** いずれかの候補で expandRecurrenceSet が maxOccurrences に到達したら true(limitHit の OR)。 */
	truncated: boolean;
}

/**
 * ListOccurrencesAcrossOwner ユースケース(レイテンシ案2「コレクション横断1クエリ化」)。
 *
 * findByOwnerTimeRange で owner 配下の VEVENT 候補を1クエリ取得し、expandOwnerOccurrences で
 * 各候補を展開してマージ・整列する。旧 runListEvents(server.ts)の N 並列 + entries マージ +
 * truncated OR をこの UC 1 呼び出しに畳む。
 */
export class ListOccurrencesAcrossOwner {
	constructor(
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly iterator: RecurrenceIterator,
	) {}

	async execute(input: ListOccurrencesAcrossOwnerInput): Promise<ListOccurrencesAcrossOwnerOutput> {
		const range = { startMillis: input.rangeStartMillis, endMillis: input.rangeEndMillis };
		const floatingTimeZone = input.floatingTimeZone ?? "UTC";

		const entries: ListOccurrencesAcrossOwnerEntry[] = [];
		const { truncated } = await expandOwnerOccurrences(
			this.resourceRepo,
			this.iterator,
			{ owner: input.owner, componentKind: "VEVENT", range, floatingTimeZone, collectionIds: input.collectionIds },
			({ collectionId, uid, occurrence }) => {
				entries.push({ uid, calendarId: collectionId, occurrence });
			},
		);

		// 複数コレクションの occurrence が混ざるため、startMillis 昇順に整列してから返す
		// (旧 server.ts の entries.sort と同一。安定な時系列表示のための UC 責務)。
		entries.sort((a, b) => a.occurrence.startMillis - b.occurrence.startMillis);
		return { occurrences: entries, truncated };
	}
}
