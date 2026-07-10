// =============================================================================
// ListCollections ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { ListCollections } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	TEST_OWNER,
	makeTestCollection,
} from "./fakes";
import { principalPath, collectionId } from "../../src/domain/caldav";

describe("ListCollections", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let usecase: ListCollections;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		usecase = new ListCollections(collectionRepo);
	});

	it("コレクションが0件の場合は空配列を返す", async () => {
		const result = await usecase.execute({ owner: TEST_OWNER });
		expect(result.collections).toHaveLength(0);
	});

	it("オーナー配下の全コレクションを返す", async () => {
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar"));
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks"));

		const result = await usecase.execute({ owner: TEST_OWNER });
		expect(result.collections).toHaveLength(2);
	});

	it("別オーナーのコレクションは返さない", async () => {
		const otherOwner = principalPath("/principals/users/other/") as any;
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar"));
		collectionRepo.seed(makeTestCollection(otherOwner, "calendar"));

		const result = await usecase.execute({ owner: TEST_OWNER });
		expect(result.collections).toHaveLength(1);
		expect(result.collections[0]?.owner).toBe(TEST_OWNER);
	});
});
