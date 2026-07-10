// =============================================================================
// CreateCollection ユースケース — RFC 4791 §5.3.1 MKCALENDAR
// =============================================================================
//
// カレンダーコレクションを新規作成する。
//
// 【iOS での呼ばれ方】
// iOS/macOS はアカウント追加時に MKCALENDAR を送るとは限らない(前作観測: iOS は
// 既存コレクションを PROPFIND で発見するだけで、自分からは MKCALENDAR を送らないことが多い)。
// しかし CalDAV クライアントライブラリ(tsdav 等)や MCP ツールから呼ばれうるため、
// このユースケースは実装しておく(CLAUDE.md 長期ビジョン: 複数入口から呼べる)。
//
// 【MKCALENDAR の workerd での問題】
// docs/modeling/06-ios-behavior-verification.md C1: workerd は MKCALENDAR の HTTP メソッドを
// 501 で弾く。presentation 層で MKCALENDAR を MKCOL の拡張として受ける、または
// 開発環境でプロキシが書き換える必要がある。このユースケース自体は HTTP 非依存なので無関係。
//
// 【冪等性】
// 同じ ID のコレクションが既存の場合は CollectionAlreadyExistsError を throw する。
// (CalDAV の MKCALENDAR は「新規作成」専用で、既存への上書きは 405 Method Not Allowed)
// =============================================================================

import {
	CalendarCollection,
	collectionId as mkCollectionId,
	principalPath,
	type AppleColor,
} from "../../domain/caldav";
import type {
	CollectionId,
	ComponentKind,
	PrincipalRef,
	CalendarCollectionInit,
} from "../../domain/caldav";
import type { CalendarCollectionRepository } from "../ports";

// --- 入力 DTO ---

export interface CreateCollectionInput {
	owner: PrincipalRef;
	/** コレクション ID(URL パスセグメント)。例 "work" / "personal"。 */
	collectionId: string;
	/** 表示名(displayName プロパティ)。 */
	displayName: string;
	/**
	 * 受け入れるコンポーネント種別(supported-calendar-component-set)。
	 * 未指定 = 全種別受理(RFC 4791 §5.2.3)。
	 */
	supportedComponents?: readonly ComponentKind[];
	/** Apple 独自: カレンダーの色(calendar-color)。 */
	color?: AppleColor;
	/** Apple 独自: カレンダーの表示順(calendar-order)。 */
	order?: number;
}

// --- 出力 DTO ---

export interface CreateCollectionOutput {
	/** 作成されたコレクション。 */
	collection: CalendarCollection;
}

// --- エラー型 ---

/**
 * 既に同じ ID のコレクションが存在するエラー。
 * - HTTP: 405 Method Not Allowed (RFC 4791: MKCALENDAR は既存コレクションに対して 405)
 *   または 409 Conflict。presentation 層がマッピングを決める。
 */
export class CollectionAlreadyExistsError extends Error {
	readonly kind = "CollectionAlreadyExistsError" as const;
	constructor(readonly collectionId: CollectionId) {
		super(`Calendar collection already exists: ${collectionId}`);
		this.name = "CollectionAlreadyExistsError";
	}
}

// --- ユースケース ---

export class CreateCollection {
	constructor(private readonly collectionRepo: CalendarCollectionRepository) {}

	async execute(input: CreateCollectionInput): Promise<CreateCollectionOutput> {
		// 識別子 VO 化(不正な ID 文字列は InvalidIdentifierError を throw)。
		const id = mkCollectionId(input.collectionId);

		// 既存チェック。
		const existing = await this.collectionRepo.findById(input.owner, id);
		if (existing) {
			throw new CollectionAlreadyExistsError(id);
		}

		// CalendarCollection を構築して保存する。
		const init: CalendarCollectionInit = {
			id,
			owner: input.owner,
			displayName: input.displayName,
			supportedComponents: input.supportedComponents,
			color: input.color,
			order: input.order,
		};
		const collection = new CalendarCollection(init);
		await this.collectionRepo.save(collection);

		return { collection };
	}
}
