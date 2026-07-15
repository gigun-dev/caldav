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

import { ETag, resourceUri } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
	ResourceWritePrecondition,
} from "../ports";
// 2026-07-14 R-2: splitEtagList を put-calendar-object.ts から共有する
// (両 usecase で「If-Match ヘッダのカンマ区切り分解」ロジックが同一のため)。
// 2026-07-14 R-3: evaluateSyncTokenIfPrecondition / SyncTokenIfConditionError も同様に
// put-calendar-object.ts から共有する(RFC 6578 §5 の If ヘッダ sync-token precondition
// 評価は PUT/DELETE で全く同じロジック。新規ファイルを立てるほどの分量でもないため
// splitEtagList と同じ「小さな語彙をここに集約する」判断を踏襲する)。
import {
	CollectionNotFoundError,
	evaluateSyncTokenIfPrecondition,
	splitEtagList,
	SyncTokenIfConditionError,
	type SyncTokenIfPrecondition,
} from "./put-calendar-object";

// --- 入力 DTO ---

export interface DeleteCalendarObjectInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	resourceUri: string;
	/**
	 * If-Match ヘッダの生の値(presentation 層でヘッダをそのまま渡す。引用符付き
	 * `"hex"`・`*`・カンマ区切りの複数値 `"a", "b"` のいずれの形でも来うる — RFC 7232 §3.1
	 * ABNF `If-Match = "*" / 1#entity-tag`)。
	 * null/undefined = If-Match なし(無条件削除)。
	 *
	 * 【2026-07-14 R-2】以前はコメントで「引用符なしの hex 文字列」を要求していたが、実際には
	 * PUT 側と非対称に app.ts から引用符付きのまま渡っていた(app.test.ts の
	 * `"if-match": etag` — etag は toHeader() の引用符付き値)ため実態と乖離していた。
	 * 実装側(execute 内)で "*" とカンマ区切りリストの両方を正しく扱うようにしたので、
	 * このコメントも「生のヘッダ値をそのまま渡す」契約として書き直した。
	 */
	ifMatchEtag?: string | null;
	/**
	 * `If` ヘッダの DAV:sync-token precondition(RFC 6578 §5)。省略 or groups 空配列で
	 * unconditional。put-calendar-object.ts の同名フィールドと同じ契約
	 * (presentation 層〈if-header.ts〉が対象コレクションの List だけに絞り込んで渡す)。
	 */
	ifSyncToken?: SyncTokenIfPrecondition;
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

		// `If` ヘッダの sync-token precondition チェック(RFC 6578 §5)。put-calendar-object.ts の
		// Step 1b と同じロジック・同じ判断(collection 集約はここで既に取得済みなので追加の
		// D1 読みは発生しない)。
		if (input.ifSyncToken && !evaluateSyncTokenIfPrecondition(input.ifSyncToken, collection.syncToken)) {
			throw new SyncTokenIfConditionError(input.ifSyncToken);
		}

		// リソース存在確認 + ETag 取得。
		const existing = await this.resourceRepo.findByUri(input.owner, input.collectionId, uri);
		if (!existing) {
			throw new DeleteTargetNotFoundError(uri);
		}

		// If-Match ETag 条件チェック(RFC 7232 §3.1)。
		if (input.ifMatchEtag != null) {
			const raw = input.ifMatchEtag.trim();
			if (raw === "*") {
				// 2026-07-14 R-2 修正: 以前は If-Match: * が「"*" を hex として fromHex に渡す」
				// 経路に丸め込まれ、必ず不正 hex 例外 → DeleteETagMismatchError(412)になっていた
				// (existing が既に見つかっている = §3.1 の「存在すること」条件は本来満たされて
				// いるのに、誤って 412 を返す不具合。500 ではなく 412 だったので発見が遅れやすい
				// バグだった)。
				// §3.1「If the field-value is "*", the condition is false if the origin server
				// does not have a current representation for the target resource」— このスコープに
				// 来た時点で existing は非 null(直前の findByUri チェックで 404 を弾き済み)なので、
				// If-Match: * の条件は常に真。ETag 値の比較は不要で何もしない。
			} else if (!splitEtagList(raw).some((candidate) => {
				// 弱い比較子(W/ 接頭辞)は RFC 7232 §3.1「MUST use the strong comparison function」
				// により If-Match では絶対に一致しない扱いとする(put-calendar-object.ts の
				// evaluateMustMatch と同じ判断)。
				if (candidate.startsWith("W/")) return false;
				const hex = candidate.replace(/^"|"$/g, "");
				try {
					return existing.etag.equals(ETag.fromHex(hex));
				} catch {
					// 不正な hex 形式は「一致しない」として扱う(412 に倒す。500 にしない)。
					return false;
				}
			})) {
				throw new DeleteETagMismatchError(uri, input.ifMatchEtag, existing.etag);
			}
		}

		// 変更ログ更新 + 原子的削除。
		collection.recordChange(uri, "deleted");

		// S-B (2026-07-16): DB 側 ETag CAS の粒度。If-Match で具体的な etag が指定されていた場合
		// (raw !== "*")は、その値と DB の現在 etag が一致するときだけ削除する(lookup〜削除の
		// TOCTOU を閉じる)。expected は「上で一致を確認した etag」= existing.etag.hex。
		// If-Match 無し / If-Match:* は「存在すれば消す」意味なので overwrite(無条件削除)。
		const hasSpecificIfMatch = input.ifMatchEtag != null && input.ifMatchEtag.trim() !== "*";
		const writePrecondition: ResourceWritePrecondition = hasSpecificIfMatch
			? { kind: "match", expectedEtag: existing.etag.hex }
			: { kind: "overwrite" };
		await this.uow.deleteResource(input.owner, input.collectionId, uri, collection, writePrecondition);
	}
}
