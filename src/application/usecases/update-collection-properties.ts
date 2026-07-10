// =============================================================================
// UpdateCollectionProperties — PROPPATCH 以外の入口からも使えるメタデータ更新
// =============================================================================

import { AppleColor } from "../../domain/caldav";
import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import type { CalendarCollectionRepository } from "../ports";
import { CollectionNotFoundError } from "./put-calendar-object";

export interface UpdateCollectionPropertiesInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	displayName?: string;
	color?: string;
	order?: number;
}

export class UpdateCollectionProperties {
	constructor(private readonly collectionRepo: CalendarCollectionRepository) {}

	async execute(input: UpdateCollectionPropertiesInput): Promise<void> {
		const current = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!current) throw new CollectionNotFoundError(input.collectionId);

		const color = input.color === undefined ? undefined : AppleColor.parse(input.color);
		const updated = current.withMetadata({
			displayName: input.displayName,
			color,
			order: input.order,
		});
		await this.collectionRepo.save(updated);
	}
}
