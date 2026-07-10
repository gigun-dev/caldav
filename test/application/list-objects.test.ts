import { describe, expect, it } from "bun:test";
import { ListObjects } from "../../src/application";
import { FakeCalendarObjectResourceRepository, TEST_COLLECTION_ID, TEST_OWNER, makeVEventIcs } from "./fakes";
import { CalendarObjectResource, resourceUri } from "../../src/domain/caldav";

describe("ListObjects", () => {
	it("指定コレクションの全リソースだけを返す", async () => {
		const repo = new FakeCalendarObjectResourceRepository();
		const resource = await CalendarObjectResource.fromIcs(resourceUri("one.ics"), makeVEventIcs());
		await repo.seed(TEST_OWNER, TEST_COLLECTION_ID, resource);
		const result = await new ListObjects(repo).execute({ owner: TEST_OWNER, collectionId: TEST_COLLECTION_ID });
		expect(result.resources.map((item) => item.uri)).toEqual([resourceUri("one.ics")]);
	});
});
