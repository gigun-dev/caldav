// =============================================================================
// DeleteCalendarObject ユースケース — RFC 4918 §9.6 DELETE (on a calendar object)
// =============================================================================
//
// カレンダーオブジェクトリソースを削除する。
//
// 【If-Match 条件】
// RFC 4918 §9.6 は DELETE でも If-Match による ETag 条件付き削除を許す。
// iOS はリソース削除時に If-Match を送ることが多い(前作観測)。
// 条件不一致は 412 Precondition Failed。
//
// 【変更ログ】
// 削除後にコレクションの syncCounter を進め SyncChange(kind="deleted")を記録する。
// sync-collection REPORT でクライアントが「削除を知る」唯一の方法が変更ログ。
// RFC 6578 §3.2 は削除リソースを 404 で応答するよう要求(前作の 410 は誤り — 05 参照)。
// =============================================================================

import { resourceUri } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type { ETag } from "../../domain/caldav";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
} from "../ports";
import { CollectionNotFoundError } from "./put-calendar-object";

// --- 入力 DTO ---

export interface DeleteCalendarObjectInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	resourceUri: string;
	/**
	 * If-Match ヘッダの ETag 値(引用符なしの hex 文字列)。
	 * null = If-Match なし(無条件削除)。
	 */
	ifMatchEtag?: string | null;
}

// --- エラー型 ---

/**
 * リソースが存在しないエラー。DELETE 対象が無かった場合。
 * - HTTP: 404 Not Found
 * (RFC 4918 §9.6: DELETE 対象が存在しない場合 404 を返す SHOULD。
 *  一部の実装は 204 で成功扱いにするが、RFC に従い 404 とする)
 */
export class DeleteTargetNotFoundError extends Error {
	readonly kind = "DeleteTargetNotFoundError" as const;
	constructor(readonly uri: ResourceUri) {
		super(`Delete target not found: ${uri}`);
		this.name = "DeleteTargetNotFoundError";
	}
}

/**
 * If-Match ETag 条件不一致エラー。
 * - HTTP: 412 Precondition Failed
 */
export class DeleteETagMismatchError extends Error {
	readonly kind = "DeleteETagMismatchError" as const;
	constructor(
		readonly uri: ResourceUri,
		readonly expected: string,
		readonly actual: ETag,
	) {
		super(`ETag mismatch on delete: expected "${expected}", actual "${actual.toHeader()}"`);
		this.name = "DeleteETagMismatchError";
	}
}

// --- ユースケース ---

export class DeleteCalendarObject {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly uow: CollectionUnitOfWork,
	) {}

	async execute(input: DeleteCalendarObjectInput): Promise<void> {
		const uri = resourceUri(input.resourceUri);

		// コレクション存在確認(syncCounter 更新のため集約が必要)。
		const collection = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!collection) {
			throw new CollectionNotFoundError(input.collectionId);
		}

		// リソース存在確認 + ETag 取得。
		const existing = await this.resourceRepo.findByUri(input.owner, input.collectionId, uri);
		if (!existing) {
			throw new DeleteTargetNotFoundError(uri);
		}

		// If-Match ETag 条件チェック。
		if (input.ifMatchEtag != null) {
			// HTTP ヘッダは引用符付き('"hex"')または引用符なし("hex")で来る可能性がある。
			// presentation 層で除去しておくことが望ましいが、ここでも strip する。
			const rawHex = input.ifMatchEtag.replace(/^"|"$/g, "");
			// 不正な hex 形式は ETag.fromHex が例外を投げる。その場合は ETag 不一致と同義。
			let expectedEtag: ETag;
			try {
				const { ETag } = await import("../../domain/caldav");
				expectedEtag = ETag.fromHex(rawHex);
			} catch {
				throw new DeleteETagMismatchError(uri, input.ifMatchEtag, existing.etag);
			}
			if (!existing.etag.equals(expectedEtag)) {
				throw new DeleteETagMismatchError(uri, input.ifMatchEtag, existing.etag);
			}
		}

		// 変更ログ更新 + 原子的削除。
		collection.recordChange(uri, "deleted");
		await this.uow.deleteResource(input.owner, input.collectionId, uri, collection);
	}
}
