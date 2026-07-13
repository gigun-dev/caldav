// =============================================================================
// DeleteCollection ユースケース — MCP delete-calendar ツール専用の薄い削除 UC
// =============================================================================
//
// 【なぜ既存の DAV DELETE 経路(app.ts の `method === "DELETE" && !resourceName`)を
//  UC 化してここに寄せなかったか】
// タスク指示どおり、既存 DAV 経路の挙動を変えるリスクを避けるためあえて触らない判断。
// app.ts の DAV DELETE は `repos.collections.delete()` を直接呼ぶだけで無条件削除
// (中身の有無を見ない)。これを UC 化して置き換えると、DAV 経路にも「非空コレクションは
// 拒否」という新しい安全装置が意図せず混入し、iOS 等の既存クライアントの削除フローに対する
// 挙動変更(回帰リスク)になる。CLAUDE.md「既存 DAV 経路の挙動は変えない」制約に従い、
// MCP 専用の新規 UC として切り出す(DAV 側は将来 UC 化したくなったときに別タスクで判断する)。
//
// 【安全装置: 非空コレクションの既定拒否】
// D1 の外部キーは calendar_objects/sync_changes とも calendar_collections への
// ON DELETE CASCADE(migrations/0001_init.sql, 0003_vjournal.sql)。よって
// `collectionRepo.delete()` を呼べば配下のリソースは黙って一括削除される。MCP 経由の
// 誤操作(モデルが安易に delete-calendar を呼ぶ・ユーザーが取り違える)で予定/リマインダーが
// 巻き添えで消える事故を防ぐため、中身が1件以上あるコレクションは `force: true` を明示
// しない限り拒否する。DAV の RFC 4918 §9.6.1 の MUST NOT(非空コレクションの DELETE を
// 拒否できる、という規定は存在しない)には反しないよう、これは MCP 専用 UC のポリシーとして
// ここに閉じる(DAV 経路には波及させない)。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../ports";
import { CollectionNotFoundError } from "./put-calendar-object";

// --- 入力 DTO ---

export interface DeleteCollectionInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/**
	 * true を明示したときだけ非空コレクションの削除を許可する。省略時(既定 false 相当)は
	 * 中身が1件でもあれば CollectionNotEmptyError を throw する(安全装置)。
	 */
	force?: boolean;
}

// --- エラー型 ---

/**
 * 中身(calendar_objects)が1件以上あるコレクションを force なしで削除しようとしたエラー。
 * - MCP: toolError としてそのまま返す(件数と force の使い方をメッセージに含める)。
 */
export class CollectionNotEmptyError extends Error {
	readonly kind = "CollectionNotEmptyError" as const;
	constructor(
		readonly collectionId: CollectionId,
		readonly objectCount: number,
	) {
		super(
			`Calendar collection "${collectionId}" is not empty (${objectCount} object(s)). ` +
				`Pass force:true to delete it together with its contents.`,
		);
		this.name = "CollectionNotEmptyError";
	}
}

// --- ユースケース ---

export class DeleteCollection {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: DeleteCollectionInput): Promise<void> {
		// 存在確認(存在しない id は入力起因エラーとして扱う — 他 UC の CollectionNotFoundError と
		// 同じ語彙を再利用し、呼び出し側〈server.ts〉のエラー分岐を揃える)。
		const existing = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!existing) {
			throw new CollectionNotFoundError(input.collectionId);
		}

		// 安全装置: 非空チェック。findAllInCollection は全件を返す設計(ports/index.ts コメント
		// 「iOS のコレクションは通常数千件未満」)なので、ここでは件数が欲しいだけでも
		// 専用の COUNT クエリを新設せず既存メソッドを流用する(YAGNI。delete-calendar は
		// 頻繁に叩かれるホットパスではないため、全件取得のコストは許容する判断)。
		if (!input.force) {
			const objects = await this.resourceRepo.findAllInCollection(input.owner, input.collectionId);
			if (objects.length > 0) {
				throw new CollectionNotEmptyError(input.collectionId, objects.length);
			}
		}

		// D1 実装は FK の ON DELETE CASCADE で calendar_objects/sync_changes も一括削除する
		// (migrations/0001_init.sql, 0003_vjournal.sql。app.ts の DAV DELETE コメントと同じ理解)。
		await this.collectionRepo.delete(input.owner, input.collectionId);
	}
}
