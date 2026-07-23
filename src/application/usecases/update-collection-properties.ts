// =============================================================================
// UpdateCollectionProperties — PROPPATCH 以外の入口からも使えるメタデータ更新
// =============================================================================

import { AppleColor } from "../../domain/caldav";
import type { CalendarCollection, CollectionId, PrincipalRef } from "../../domain/caldav";
import type { CalendarCollectionRepository } from "../ports";
import { CollectionNotFoundError } from "./put-calendar-object";

export interface UpdateCollectionPropertiesInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	displayName?: string;
	color?: string;
	order?: number;
}

// K2(update-calendar MCP ツール): execute の戻り値を Promise<void> → Promise<{collection}> に
// 変更した。既存の DAV PROPPATCH 呼び出し側(app.ts)は戻り値を使わず await するだけなので
// この変更は非破壊(戻り値を無視するコードは追加フィールドの有無に影響されない)。
// update-calendar ツールは更新後の displayName/color をレスポンスに含める必要があり、
// UC 実行後に再度 findById するのは冗長(save に渡した `updated` を最初から知っている)ため、
// UC がそのまま返す形にした(呼び出し側での二重フェッチを避ける)。
export interface UpdateCollectionPropertiesOutput {
	collection: CalendarCollection;
}

export class UpdateCollectionProperties {
	constructor(private readonly collectionRepo: CalendarCollectionRepository) {}

	async execute(input: UpdateCollectionPropertiesInput): Promise<UpdateCollectionPropertiesOutput> {
		const current = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!current) throw new CollectionNotFoundError(input.collectionId);

		const color = input.color === undefined ? undefined : AppleColor.parse(input.color);
		const updated = current.withMetadata({
			displayName: input.displayName,
			color,
			order: input.order,
		});
		await this.collectionRepo.save(updated);
		return { collection: updated };
	}
}
