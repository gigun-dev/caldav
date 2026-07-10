// =============================================================================
// SyncCollection ユースケース — RFC 6578 §3 sync-collection REPORT
// =============================================================================
//
// クライアントが前回取得した sync-token 以降の差分を返す。
//
// 【RFC 6578 §3.2 の2ケース】
// (A) 初回同期(クライアントが DAV:sync-token を送らない): 全リソースを "changed" として返す。
//     RFC §3.4: 空の DAV:sync-token 要素で初回同期を示す。
// (B) 差分同期(クライアントが以前の sync-token を送る):
//     - 有効なトークン → token 以降の変更だけ返す。
//     - 無効なトークン → valid-sync-token precondition 失敗 → クライアントに full resync を促す。
//
// 【変更ログの限界】
// CalendarCollection._changeLog は「記録が存在する範囲」だけを差分として出せる。
// ログが剪定された場合は invalid 扱いになりうる(現状ログは剪定しない)。
//
// 【SyncReport と MultigetObjects の分担】
// このユースケースは「何が変わったか」だけを返す(uri + changed/removed + newToken)。
// "changed" なリソースの本体(ICS)は presentation 層が必要なら別途 MultigetObjects で取る
// か、DB 実装がまとめて返す最適化をする。現状の simple 実装では changed の本体も含めて返す。
// =============================================================================

import type { CalendarObjectResource, SyncReport, SyncToken } from "../../domain/caldav";
import { SyncToken as SyncTokenClass } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
} from "../ports";
import { CollectionNotFoundError } from "./put-calendar-object";

// --- 入力 DTO ---

export interface SyncCollectionInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/**
	 * クライアントが持つ sync-token の URI 文字列。
	 * null / 空文字列 = 初回同期(RFC 6578 §3.4)。
	 */
	syncToken: string | null | undefined;
	/**
	 * 公開したコレクションURL。presentation 層が外部URLを知る場合に渡す。
	 * 未指定時は従来どおり collectionId を使い、HTTP 非依存な単体テストを保つ。
	 */
	syncTokenBase?: string;
}

// --- 出力 DTO ---

/**
 * 差分1件。
 * - kind="changed": 追加 or 更新されたリソース。resource にフルデータを含む。
 * - kind="removed": 削除されたリソース。uri だけを含む(本体は存在しない)。
 */
export type SyncDiff =
	| { kind: "changed"; resource: CalendarObjectResource }
	| { kind: "removed"; uri: ResourceUri };

export interface SyncCollectionOutput {
	/** 差分一覧。presentation 層が 207 を組み立てる素材。 */
	diffs: SyncDiff[];
	/** 今回の同期後の新しい sync-token URI。DAV:sync-token 要素として返す。 */
	newSyncTokenUri: string;
	/**
	 * 現在のコレクションの base URL(sync-token URI 生成に必要)。
	 * presentation 層がコレクションの絶対 URL を知っているため、token.toUri(base) の
	 * base はここでは "." を渡し、presentation 層が絶対 URL に組み立てる。
	 * 実際には presentaion 層が base を知っているので、ここでは内部カウンタを返す形も
	 * 考えたが、「URI のまま渡す」ことで presentation の変換を不要にする。
	 *
	 * 【現在の設計】
	 * ユースケースはコレクション URL を知らない(HTTP 非依存)。そこで syncToken の
	 * toUri に渡す base をポートに "." で固定し、presentation 層が絶対 URL に差し替える。
	 * 将来 collection.url のようなフィールドをドメインに追加する場合は見直す。
	 */
	newSyncToken: SyncToken;
}

// --- エラー型 ---

/**
 * sync-token が無効(解釈不能 / 他サーバー由来)なエラー。
 * - HTTP: 403 / DAV:error の valid-sync-token precondition
 * - RFC 6578 §3.1: 無効なトークンを受けたら valid-sync-token 失敗を返し、
 *   クライアントに full resync を促す MUST。
 */
export class InvalidSyncTokenError extends Error {
	readonly kind = "InvalidSyncTokenError" as const;
	constructor(readonly raw: string) {
		super(`Invalid or unrecognized sync-token: "${raw}"`);
		this.name = "InvalidSyncTokenError";
	}
}

// --- ユースケース ---

export class SyncCollection {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: SyncCollectionInput): Promise<SyncCollectionOutput> {
		// コレクション取得(存在確認 + syncToken / changeLog 参照)。
		const collection = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!collection) {
			throw new CollectionNotFoundError(input.collectionId);
		}

		// sync-token の解釈。
		// 空/null = 初回同期。それ以外 = SyncToken.fromUri で解釈試みる。
		// 「base」として collectionId を文字列で使う(相対的な識別子として十分。
		//  絶対 URL は presentation 層が知っているが、toUri/fromUri の一致が保たれれば良い)。
		const tokenBase = input.syncTokenBase ?? String(input.collectionId);
		let sinceToken: SyncToken | undefined;

		const rawToken = input.syncToken;
		if (rawToken && rawToken.trim().length > 0) {
			// 既存のトークンが送られてきた場合: parse して有効性を確認する。
			const parsed = SyncTokenClass.fromUri(tokenBase, rawToken);
			if (!parsed.valid) {
				throw new InvalidSyncTokenError(rawToken);
			}
			sinceToken = parsed.token;
		}
		// sinceToken === undefined のとき = 初回同期(全件を "changed" として返す)。

		// changesSince でドメインから差分を取得する。
		const result = collection.changesSince(sinceToken);

		// ドメインの changesSince 結果を処理する。
		let diffs: SyncDiff[];

		if (sinceToken === undefined) {
			// 初回同期: 全リソースを "changed" として返す。
			// 変更ログには頼らず、現在の全リソースを直接フェッチする。
			// (ログには過去の削除も含まれており、初回同期では「現存するリソース」だけを返すべき)
			const allResources = await this.resourceRepo.findAllInCollection(
				input.owner,
				input.collectionId,
			);
			diffs = allResources.map((r) => ({ kind: "changed" as const, resource: r }));
		} else if (!result.valid) {
			// トークンは URI 形式として有効だったが、コレクションのログ範囲外(古すぎる等)。
			// RFC 6578 §3.1 に従い valid-sync-token エラー。
			throw new InvalidSyncTokenError(rawToken ?? "");
		} else {
			// 差分同期: changed な URI は本体を取得、removed はそのまま。
			const changedUris = result.changes
				.filter((c): c is SyncReport & { change: "changed" } => c.change === "changed")
				.map((c) => c.uri);

			const removedUris = result.changes
				.filter((c): c is SyncReport & { change: "removed" } => c.change === "removed")
				.map((c) => c.uri);

			// changed なリソースを一括フェッチ。
			const changedResources =
				changedUris.length > 0
					? await this.resourceRepo.findManyByUri(
							input.owner,
							input.collectionId,
							changedUris,
						)
					: [];

			// フェッチできなかった URI(変更ログにあるが実際には削除済み等)は removed 扱いにする。
			// (ログと実データの一時的な不整合への防御。通常は発生しない)
			const fetchedUriSet = new Set(changedResources.map((r) => r.uri));
			const missedChanged = changedUris.filter((u) => !fetchedUriSet.has(u));

			diffs = [
				...changedResources.map((r) => ({ kind: "changed" as const, resource: r })),
				...removedUris.map((uri) => ({ kind: "removed" as const, uri })),
				...missedChanged.map((uri) => ({ kind: "removed" as const, uri })),
			];
		}

		// 新しい sync-token は現在のコレクションの syncToken。
		const newSyncToken = collection.syncToken;

		return {
			diffs,
			newSyncTokenUri: newSyncToken.toUri(tokenBase),
			newSyncToken,
		};
	}
}
