// =============================================================================
// ProvisionDefaultCollections ユースケース — 初期コレクション作成
// =============================================================================
//
// 新規ユーザーが初めてログインしたとき(または管理者が手動で呼んだとき)に、
// デフォルトのカレンダーコレクションを作成する。
//
// 【冪等性が最重要】
// このユースケースは「すでに存在するコレクションはスキップし、無いものだけ作る」
// 冪等な操作でなければならない。理由:
// - 認証ミドルウェアがリクエストごとに呼び出す可能性があるため
// - 再起動後・マイグレーション後に再実行することがあるため
// 冪等にすることで「べき等化 = 安全に何度でも呼べる」設計にする。
//
// 【呼ばれるタイミング】
// 典型的には「初回 PROPFIND calendar-home-set のとき、コレクションが0件だったら」
// presentation 層が呼び出す。または起動時マイグレーションフックから呼ぶ。
//
// 【デフォルトコレクションの種類】
// iOSカレンダーアプリは VEVENT と VTODO を別コレクションで管理することが多い。
// 最低限2コレクションを用意する。実体は下の DEFAULT_COLLECTION_SPECS の通り
// id "calendar"(displayName "Calendar", VEVENT 用)と id "tasks"(displayName "Tasks", VTODO 用)。
// (2026-07-10 レビュー P2-4: 旧コメントは「Events と Tasks」だったが実体と乖離していたため訂正。)
// 将来的に外から設定を注入できるよう、デフォルト定義を input で受け取る設計にする。
// =============================================================================

import {
	CalendarCollection,
	collectionId as mkCollectionId,
} from "../../domain/caldav";
import type {
	CollectionId,
	ComponentKind,
	PrincipalRef,
	CalendarCollectionInit,
} from "../../domain/caldav";
import type { CalendarCollectionRepository, PrincipalRepository } from "../ports";

// --- デフォルトコレクション定義 ---

export interface DefaultCollectionSpec {
	/** コレクション ID(URL セグメント)。 */
	id: string;
	/** 表示名。 */
	displayName: string;
	/** 受け入れるコンポーネント種別(未指定 = 全種別)。 */
	supportedComponents?: readonly ComponentKind[];
}

/** 標準的なデフォルトコレクション定義(Calendar + Tasks)。ユースケースやテストからも参照できるよう export。 */
export const DEFAULT_COLLECTION_SPECS: readonly DefaultCollectionSpec[] = [
	{
		id: "calendar",
		displayName: "Calendar",
		// VEVENT のみ受け入れる。iOS カレンダーアプリが使う。
		supportedComponents: ["VEVENT"],
	},
	{
		id: "tasks",
		displayName: "Tasks",
		// VTODO のみ受け入れる。iOS リマインダーアプリが使う。
		supportedComponents: ["VTODO"],
	},
];

// --- 入力 DTO ---

export interface ProvisionDefaultCollectionsInput {
	owner: PrincipalRef;
	/**
	 * 作成するデフォルトコレクション一覧。
	 * 未指定 = DEFAULT_COLLECTION_SPECS を使う(標準的な Calendar + Tasks)。
	 */
	specs?: readonly DefaultCollectionSpec[];
}

// --- 出力 DTO ---

export interface ProvisionDefaultCollectionsOutput {
	/** 新規に作成したコレクション。 */
	created: CalendarCollection[];
	/** すでに存在したためスキップしたコレクション ID。 */
	skipped: CollectionId[];
}

// --- ユースケース ---

export class ProvisionDefaultCollections {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly principalRepo: PrincipalRepository,
	) {}

	async execute(
		input: ProvisionDefaultCollectionsInput,
	): Promise<ProvisionDefaultCollectionsOutput> {
		const specs = input.specs ?? DEFAULT_COLLECTION_SPECS;
		const created: CalendarCollection[] = [];
		const skipped: CollectionId[] = [];

		for (const spec of specs) {
			const id = mkCollectionId(spec.id);

			// 存在確認 → 冪等性の核心。存在すればスキップ、無ければ作成。
			const existing = await this.collectionRepo.findById(input.owner, id);
			if (existing) {
				skipped.push(id);
				continue;
			}

			const init: CalendarCollectionInit = {
				id,
				owner: input.owner,
				displayName: spec.displayName,
				supportedComponents: spec.supportedComponents,
			};
			const collection = new CalendarCollection(init);
			await this.collectionRepo.save(collection);
			created.push(collection);
		}

		return { created, skipped };
	}
}
