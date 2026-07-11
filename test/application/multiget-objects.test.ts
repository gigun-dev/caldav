// =============================================================================
// MultigetObjects ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { PutCalendarObject, MultigetObjects } from "../../src/application/usecases";
import { resourceUri } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_COLLECTION_ID,
	makeVEventIcs,
	makeTestCollection,
	TEST_RECURRENCE_ITERATOR,
} from "./fakes";

describe("MultigetObjects", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let put: PutCalendarObject;
	let multiget: MultigetObjects;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		put = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		multiget = new MultigetObjects(resourceRepo);
		collectionRepo.seed(makeTestCollection());
	});

	it("指定した URI のリソースを一括取得できる", async () => {
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "a.ics", ics: makeVEventIcs("uid-a") });
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "b.ics", ics: makeVEventIcs("uid-b") });
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "c.ics", ics: makeVEventIcs("uid-c") });

		const result = await multiget.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			uris: ["a.ics", "c.ics"],
		});

		expect(result.found).toHaveLength(2);
		expect(result.notFound).toHaveLength(0);
		const foundUris = result.found.map((r) => r.uri);
		expect(foundUris).toContain(resourceUri("a.ics"));
		expect(foundUris).toContain(resourceUri("c.ics"));
	});

	it("存在しない URI は notFound に含まれる", async () => {
		await put.execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID, resourceUri: "a.ics", ics: makeVEventIcs("uid-a") });

		const result = await multiget.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			uris: ["a.ics", "ghost.ics"],
		});

		expect(result.found).toHaveLength(1);
		expect(result.notFound).toHaveLength(1);
		expect(result.notFound[0]).toBe(resourceUri("ghost.ics"));
	});

	it("全 URI が存在しない場合は found が空で notFound が全件", async () => {
		const result = await multiget.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			uris: ["x.ics", "y.ics"],
		});

		expect(result.found).toHaveLength(0);
		expect(result.notFound).toHaveLength(2);
	});

	it("URI リストが空の場合は両方空", async () => {
		const result = await multiget.execute({
			owner: TEST_OWNER,
			collectionId: TEST_COLLECTION_ID,
			uris: [],
		});

		expect(result.found).toHaveLength(0);
		expect(result.notFound).toHaveLength(0);
	});
});
