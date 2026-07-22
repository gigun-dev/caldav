// =============================================================================
// expand-owner-occurrences — owner 横断の候補リソースを反復展開する共通ヘルパー
// =============================================================================
//
// 【なぜこのヘルパーを切り出すか(2026-07-22 レイテンシ案2)】
// ListOccurrencesAcrossOwner / ComputeFreeBusyAcrossOwner は、どちらも
// 「findByOwnerTimeRange が返した候補(collectionId 付き)を1件ずつ expandRecurrenceSet で
// 精密展開し、range と重なる occurrence を得る」という同じループを持つ。このループは
// 既存の単一コレクション UC(list-occurrences.ts / compute-free-busy.ts)にもあり、
// 4 箇所で「master 抽出 → uid チェック → overrides 抽出 → zoneOf → expand → truncated 畳み」
// が重複していた。新 UC 2 本のあいだで挙動をズラさない(片方だけ壊れた RRULE の握り方が違う等)
// ために、展開ループはここへ一本化して共有する。
//
// 【スコープ: 既存 UC は不変のまま】
// 既存 ListOccurrences / ComputeFreeBusy(単一コレクション専用)は、リファクタのリスク
// (挙動が1文字でも変わると G-3/G-4 の REPORT テストに波及)を避けて**この抽出の対象外**とし、
// 従来のインラインループのまま残す。共有はあくまで「全横断の新 UC 2 本のあいだ」で行う
// (親裁定: 抽出は採用するが挙動不変を最優先。単一 UC まで巻き込む広い置換はしない)。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import {
	expandRecurrenceSet,
	zoneResolverFor,
	type Occurrence,
	type RecurrenceIterator,
} from "../../domain/ical/recurrence";
import type { CalendarObjectResourceRepository, OwnerTimeRangeMatch } from "../ports";

// CalendarQuery / ListOccurrences / ComputeFreeBusy の同名定数と同じ理由・同じ値
// (「呼び出し側が意識して決める」expandRecurrenceSet の設計方針)。全横断でも「同じ入力なら
// 同じだけ見える」という直感を壊さないため、既存 UC と値を揃える(3000)。
export const ACROSS_OWNER_MAX_OCCURRENCES = 3000;

// CalendarQuery 等の TIME_RANGE_TZ_SLACK_MS と全く同じ理由(floating の別ゾーン解釈が SQL の
// UTC 前提索引からこぼれ落ちる事故を防ぐ)。値も揃える(24h)。スラック加算は application 層の
// 責務で、repository は TZ 知識を持たない(既存 UC のコメントと同じ方針)。
export const TIME_RANGE_TZ_SLACK_MS = 24 * 60 * 60 * 1000;

/** 展開された occurrence 1件 + それがどのコレクション/UID 由来かの文脈。 */
export interface OwnerOccurrence {
	readonly collectionId: CollectionId;
	readonly uid: string;
	readonly occurrence: Occurrence;
}

/**
 * findByOwnerTimeRange で候補を1クエリ取得し、各候補を expandRecurrenceSet で展開して
 * range と重なる occurrence を visit コールバックへ流す共通処理。
 *
 * ソートや coalesce・maxEvents クリップといった「出力の整形」は呼び出し側 UC の責務
 * (ListOccurrences は startMillis 昇順ソート、ComputeFreeBusy は BusyInterval 化 + coalesce)。
 * ここは「候補集合 → occurrence の列」への平坦化だけを担う。
 *
 * @returns truncated — いずれかの候補で expandRecurrenceSet が maxOccurrences に到達(limitHit)
 *   したら true(呼び出し側の truncated 元。limitHit の OR 畳み込み)。
 */
export async function expandOwnerOccurrences(
	resourceRepo: CalendarObjectResourceRepository,
	iterator: RecurrenceIterator,
	params: {
		owner: PrincipalRef;
		componentKind: "VEVENT" | "VTODO";
		range: { startMillis: number; endMillis: number };
		floatingTimeZone: string;
		/** undefined = 全横断 / 集合指定 = その集合に限定(ports の findByOwnerTimeRange 契約)。 */
		collectionIds?: readonly CollectionId[];
	},
	visit: (occ: OwnerOccurrence) => void,
): Promise<{ truncated: boolean }> {
	const { owner, componentKind, range, floatingTimeZone, collectionIds } = params;

	// --- SQL 側の粗い絞り込み(1クエリ)。スラック加算はここ(application 層)で行う ------------
	const candidates: OwnerTimeRangeMatch[] = await resourceRepo.findByOwnerTimeRange(
		owner,
		componentKind,
		range.startMillis - TIME_RANGE_TZ_SLACK_MS,
		range.endMillis + TIME_RANGE_TZ_SLACK_MS,
		collectionIds,
	);

	let truncated = false;
	for (const candidate of candidates) {
		// candidate.resource.payload は fromIcs 時点で parse 済み(二重 parse 回避。既存 UC と同じ)。
		const obj = candidate.resource.payload;
		const events = obj.events();
		const master = events.find((e) => e.recurrenceId === undefined);
		if (master === undefined) continue; // マスターが無い壊れたリソースは判定不能 = 除外。

		// UID が無いリソースは壊れているとみなし skip(uid は出力の必須文脈。list-occurrences.ts と同じ)。
		const uid = master.uid;
		if (uid === undefined) continue;

		const overrides = events.filter((e) => e.recurrenceId !== undefined);
		const zoneOf = zoneResolverFor(obj);
		try {
			const result = expandRecurrenceSet(
				iterator,
				{ master, overrides, range },
				{ zoneOf, floatingTimeZone, maxOccurrences: ACROSS_OWNER_MAX_OCCURRENCES },
			);
			if (result.limitHit) truncated = true;
			for (const occurrence of result.occurrences) {
				visit({ collectionId: candidate.collectionId, uid, occurrence });
			}
		} catch {
			// 壊れた RRULE 等で展開が例外を投げても、その1件を無視して他候補の判定を続ける
			// (既存 UC と同じ「索引/フィルタの失敗で UC 全体を壊さない」方針)。
			continue;
		}
	}
	return { truncated };
}
