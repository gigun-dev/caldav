// =============================================================================
// CreateCollection ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { CreateCollection, CollectionAlreadyExistsError } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	TEST_OWNER,
	makeTestCollection,
} from "./fakes";
import { collectionId } from "../../src/domain/caldav";

describe("CreateCollection", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let usecase: CreateCollection;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		usecase = new CreateCollection(collectionRepo);
	});

	it("コレクションを新規作成できる", async () => {
		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: "work",
			displayName: "Work Calendar",
			supportedComponents: ["VEVENT"],
		});

		// collectionId() は branded type を返すため、toBe で直接比較するには同じ型が必要。
		// ここでは文字列として比較する(branded string の実体は string なので as string でキャスト)。
		expect(result.collection.id as string).toBe("work");
		expect(result.collection.displayName).toBe("Work Calendar");
		expect(result.collection.supportedComponents).toContain("VEVENT");
	});

	it("同じ ID が既存の場合は CollectionAlreadyExistsError", async () => {
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar"));

		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: "calendar",
				displayName: "Calendar",
			})
		).rejects.toBeInstanceOf(CollectionAlreadyExistsError);
	});

	it("初期 syncCounter は 0", async () => {
		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: "fresh",
			displayName: "Fresh",
		});
		expect(result.collection.syncToken.counter).toBe(0);
	});
});
