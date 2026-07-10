// =============================================================================
// MultigetObjects ユースケース — RFC 4791 §7.9 calendar-multiget REPORT
// =============================================================================
//
// 指定した URI リストのリソースを一括取得する。
//
// 【iOS での典型的な使われ方】
// 1. PROPFIND Depth:1 で全 URI + ETag 一覧を取得(ListObjects)
// 2. キャッシュにない URI だけを calendar-multiget で一括フェッチ(このユースケース)
// この2段階で「初回フルダウンロード」を実現する。以後の差分は SyncCollection。
//
// 【存在しない URI の扱い】
// RFC 4791 §7.9 の応答は MULTI-STATUS(207)で、存在しない URI は 404 として個別に返す。
// ユースケースは「見つかったリソース」と「見つからなかった URI」の両方を返し、
// presentation 層が 207 を組み立てる。
// =============================================================================

import type { CalendarObjectResource } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import { resourceUri } from "../../domain/caldav";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface MultigetObjectsInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/** 取得するリソースの URI 文字列リスト。 */
	uris: string[];
}

// --- 出力 DTO ---

export interface MultigetObjectsOutput {
	/** 見つかったリソース。 */
	found: CalendarObjectResource[];
	/** 見つからなかった URI(presentation 層が 404 で返す)。 */
	notFound: ResourceUri[];
}

// --- ユースケース ---

export class MultigetObjects {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: MultigetObjectsInput): Promise<MultigetObjectsOutput> {
		// 文字列 → ResourceUri VO 変換(不正な URI は InvalidIdentifierError)。
		const requestedUris = input.uris.map((u) => resourceUri(u));

		// 一括取得。findManyByUri は存在しない URI を省いて返す(ポートの仕様)。
		const found = await this.resourceRepo.findManyByUri(
			input.owner,
			input.collectionId,
			requestedUris,
		);

		// 「見つかった URI の集合」と「要求した URI の全量」の差分 = 見つからなかった URI。
		const foundUriSet = new Set(found.map((r) => r.uri));
		const notFound = requestedUris.filter((u) => !foundUriSet.has(u));

		return { found, notFound };
	}
}
