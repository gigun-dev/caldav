// =============================================================================
// ListCollections ユースケース — PROPFIND Depth:1 on calendar-home-set
// =============================================================================
//
// ユーザーのカレンダーホーム配下のコレクション一覧を返す。
// iOS が最初にこのリクエストを送り、自分のカレンダー一覧を得る
// (RFC 4791 §6.2.1: calendar-home-set を PROPFIND Depth:1 で列挙)。
//
// 【返す情報】
// 集約 CalendarCollection をそのまま返す(プロパティ選択は presentation 層の仕事)。
// 将来 PROPFIND の prop 要素で要求されたプロパティだけを返す最適化が必要になる場合、
// ユースケースに filter/projection を追加するより、集約の「ビュー DTO」を presentation が
// 選ぶ方式にする(ここでは全フィールドを返す)。
// =============================================================================

import type { CalendarCollection } from "../../domain/caldav";
import type { PrincipalRef } from "../../domain/caldav";
import type { CalendarCollectionRepository } from "../ports";

// --- 入力 DTO ---

export interface ListCollectionsInput {
	owner: PrincipalRef;
}

// --- 出力 DTO ---

export interface ListCollectionsOutput {
	/** オーナー配下の全カレンダーコレクション。 */
	collections: CalendarCollection[];
}

// --- ユースケース ---

export class ListCollections {
	constructor(private readonly collectionRepo: CalendarCollectionRepository) {}

	async execute(input: ListCollectionsInput): Promise<ListCollectionsOutput> {
		const collections = await this.collectionRepo.findAllByOwner(input.owner);
		return { collections };
	}
}
