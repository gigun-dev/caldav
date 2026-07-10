// =============================================================================
// ListObjects ユースケース — PROPFIND Depth:1 on a calendar collection
// =============================================================================
//
// カレンダーコレクション配下のリソース一覧を返す。
// iOS が PROPFIND Depth:1 でコレクション内のメンバーリストを得るときに使う。
// calendar-query / calendar-multiget REPORT とは異なり、フィルタなし全件返す。
//
// 【用途の違い】
// - ListObjects: PROPFIND Depth:1。コレクション内の全 URI と ETag を返す(大量件数を想定)。
// - MultigetObjects: calendar-multiget。指定 URI のフルデータ(ICS)を返す。
// - SyncCollection: sync-collection REPORT。差分のみを返す(最効率の同期)。
// iOS は初回同期で ListObjects → MultigetObjects の2段階を踏み、以後は SyncCollection を使う。
// =============================================================================

import type { CalendarObjectResource } from "../../domain/caldav";
import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface ListObjectsInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
}

// --- 出力 DTO ---

export interface ListObjectsOutput {
	/** コレクション内の全リソース。 */
	resources: CalendarObjectResource[];
}

// --- ユースケース ---

export class ListObjects {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: ListObjectsInput): Promise<ListObjectsOutput> {
		const resources = await this.resourceRepo.findAllInCollection(input.owner, input.collectionId);
		return { resources };
	}
}
