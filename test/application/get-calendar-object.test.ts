// =============================================================================
// GetCalendarObject ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { GetCalendarObject, ResourceNotFoundError, PutCalendarObject } from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	makeVEventIcs,
	makeTestCollection,
} from "./fakes";

describe("GetCalendarObject", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let get: GetCalendarObject;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow);
		get = new GetCalendarObject(resourceRepo);
		collectionRepo.seed(makeTestCollection());
	});

	it("存在するリソースを取得できる", async () => {
		const ics = makeVEventIcs("uid-get");
		await put.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-get.ics",
			ics,
		});

		const result = await get.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			resourceUri: "uid-get.ics",
		});

		expect(result.resource).toBeDefined();
		expect(result.resource.uid).toBe("uid-get");
		expect(result.resource.rawIcs).toBe(ics);
	});

	it("存在しないリソースは ResourceNotFoundError", async () => {
		await expect(
			get.execute({
				owner: TEST_OWNER,
				collectionId: TEST_COLLECTION_ID,
				resourceUri: "nonexistent.ics",
			})
		).rejects.toBeInstanceOf(ResourceNotFoundError);
	});
});
