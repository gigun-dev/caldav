// =============================================================================
// RestoreDeleted ユースケース — R2 ソフトデリートの復元(docs/modeling/15 §A-3 R2)
// =============================================================================
//
// soft-delete 済みリソース(tombstone)を生存行へ戻す。可逆性の提供(§A-2)がサーバー責務で
// あり、これがその実装。sync_changes には 'created' を記録する(RFC 6578 §3.5.1: 再マップは
// changed として報告・removed と報告してはならない。既存 changesSince の後勝ち fold が自動で
// 準拠 — docs/next-directions.md「R2 RFC 検証完了」)。
//
// 【前提条件: URI 空き かつ UID 空き(RFC 検証報告の修正必須1点)】
//   - UID 空き: soft-delete 後の同 UID 再作成は合法(partial unique index)なので、ゴミ箱の
//     ゴーストと同じ UID の生存リソースが既に在りうる。そのまま復元すると可視空間で UID が
//     重複する(4791 の UID 一意性違反)。よって **生存側に同 UID が居たら復元を拒否**し、
//     衝突相手 uri を示すエラーにする(no-uid-conflict の流儀)。
//   - URI 空き: 元 uri が生存リソースに再利用されていたら、復元先として **新 uri を採番**する
//     (元 uri を奪わない)。ゴースト rename(saveResource)により実際にはゴーストの現在 uri は
//     常に空いているが、防御的に生存衝突を確認し、埋まっていれば別 uri に逃がす。
// =============================================================================

import { collectionId as mkCollectionId, resourceUri as mkResourceUri } from "../../domain/caldav";
import type { CalendarObjectResource, PrincipalRef, ResourceUri } from "../../domain/caldav";
import { CollectionNotFoundError } from "./put-calendar-object";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository, CollectionUnitOfWork } from "../ports";

// --- 入力 DTO ---

export interface RestoreDeletedInput {
	owner: PrincipalRef;
	/** 復元対象の uri(list-deleted が返した現在の uri)。 */
	resourceUri: string;
	/** 所属コレクション ID。省略時は "tasks"(todos 中心の運用に合わせた既定)。 */
	calendarId?: string;
}

// --- 出力 DTO ---

export interface RestoreDeletedOutput {
	/** 復元後に生存行が使う uri(元 uri が埋まっていれば新採番された uri)。 */
	uri: string;
	/** 復元されたリソースの UID。 */
	uid: string;
	/** タイトル(SUMMARY)。 */
	summary?: string;
	/** 所属コレクション ID。 */
	calendarId: string;
}

// --- エラー型 ---

/**
 * 復元対象がゴミ箱に無い(uri が soft-delete 済み行として存在しない)。
 * - HTTP/MCP: 404 相当(存在しないものは復元できない)。
 */
export class RestoreTargetNotFoundError extends Error {
	readonly kind = "RestoreTargetNotFoundError" as const;
	constructor(readonly uri: string) {
		super(`No deleted resource to restore at uri: ${uri}`);
		this.name = "RestoreTargetNotFoundError";
	}
}

/**
 * 復元しようとした UID が既に生存リソースに使われている(可視空間の UID 重複を避けるため拒否)。
 * conflictUri に衝突相手(現に生きているリソース)の uri を載せる(no-uid-conflict の流儀)。
 */
export class RestoreUidConflictError extends Error {
	readonly kind = "RestoreUidConflictError" as const;
	constructor(
		readonly uid: string,
		readonly conflictUri: ResourceUri,
	) {
		super(`Cannot restore: UID "${uid}" is already in use by a live resource (${conflictUri})`);
		this.name = "RestoreUidConflictError";
	}
}

export class RestoreDeleted {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly uow: CollectionUnitOfWork,
	) {}

	async execute(input: RestoreDeletedInput): Promise<RestoreDeletedOutput> {
		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const currentUri = mkResourceUri(input.resourceUri);

		// コレクション存在確認(syncCounter を進めるため集約が必要)。
		const collection = await this.collectionRepo.findById(input.owner, collectionId);
		if (!collection) {
			throw new CollectionNotFoundError(collectionId);
		}

		// 復元対象(ゴースト)を「削除済み行のみ」から引く。生存行/不在はここで弾く。
		const ghost = await this.resourceRepo.findDeletedByUri(input.owner, collectionId, currentUri);
		if (!ghost) {
			throw new RestoreTargetNotFoundError(input.resourceUri);
		}

		// 前提条件1: UID 空き。生存側に同 UID が居たら復元を拒否(findUriByUid は生存行のみを見る)。
		const liveUidOwner = await this.resourceRepo.findUriByUid(input.owner, collectionId, ghost.uid);
		if (liveUidOwner !== null) {
			throw new RestoreUidConflictError(ghost.uid, liveUidOwner);
		}

		// 前提条件2: URI 空き。元 uri が生存リソースに再利用されていたら新 uri を採番する。
		// (ゴースト rename により通常は空いているが、防御的に確認する — restore-deleted.ts 冒頭)。
		const liveAtUri = await this.resourceRepo.findByUri(input.owner, collectionId, currentUri);
		const newUri = liveAtUri === null ? currentUri : freshRestoreUri(currentUri);

		// 変更ログ 'created' + 原子的復元(deleted_at を外し、uri を newUri へ)。
		collection.recordChange(newUri, "created");
		await this.uow.restoreResource(input.owner, collectionId, currentUri, newUri, collection);

		return {
			uri: newUri,
			uid: ghost.uid,
			summary: summaryOf(ghost),
			calendarId: collectionId,
		};
	}
}

/** 元 uri が埋まっていた場合の復元先 uri を採番する(元 uri を奪わない)。 */
function freshRestoreUri(uri: ResourceUri): ResourceUri {
	const rand = Math.random().toString(36).slice(2, 8);
	return mkResourceUri(`${uri}.restored-${Date.now()}-${rand}`);
}

/** ゴースト resource から SUMMARY を取り出す(list-deleted.ts の summaryOf と同じ判断)。 */
function summaryOf(resource: CalendarObjectResource): string | undefined {
	switch (resource.componentKind) {
		case "VEVENT":
			return resource.payload.events()[0]?.summary;
		case "VTODO":
			return resource.payload.todos()[0]?.summary;
		case "VJOURNAL":
			return resource.payload.journals()[0]?.summary;
		default:
			return undefined;
	}
}
