// =============================================================================
// GetCalendarObject ユースケース — RFC 4791 §5.3.1 GET
// =============================================================================
//
// カレンダーオブジェクトリソースを取得する。
// HTTP の If-None-Match ETag 条件は presentation 層が判断するので、ここでは
// 「リソースを返す or 存在しない」という最小結果を返すだけにする。
// 304 Not Modified の判定は「取得した ETag が If-None-Match と一致するか」であり、
// これは presentation 層が比較すれば十分(ユースケースが実施する必要はない)。
// =============================================================================

import type { CalendarObjectResource } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import { resourceUri } from "../../domain/caldav";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface GetCalendarObjectInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/** 取得するリソースの URI 文字列。 */
	resourceUri: string;
}

// --- 出力 DTO ---

/** リソースが見つかった場合の結果。 */
export interface GetCalendarObjectOutput {
	/** 取得したリソース(rawIcs / etag / componentKind 等を含む)。 */
	resource: CalendarObjectResource;
}

// --- エラー型 ---

/**
 * リソースが存在しないエラー。
 * - HTTP: 404 Not Found
 */
export class ResourceNotFoundError extends Error {
	readonly kind = "ResourceNotFoundError" as const;
	constructor(readonly uri: ResourceUri) {
		super(`Calendar object resource not found: ${uri}`);
		this.name = "ResourceNotFoundError";
	}
}

// --- ユースケース ---

export class GetCalendarObject {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: GetCalendarObjectInput): Promise<GetCalendarObjectOutput> {
		const uri = resourceUri(input.resourceUri);
		const resource = await this.resourceRepo.findByUri(input.owner, input.collectionId, uri);
		if (!resource) {
			throw new ResourceNotFoundError(uri);
		}
		return { resource };
	}
}
