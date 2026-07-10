// =============================================================================
// ProvisionDefaultCollections ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { ProvisionDefaultCollections, DEFAULT_COLLECTION_SPECS } from "../../src/application/usecases";
import { collectionId } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakePrincipalRepository,
	TEST_OWNER,
	makeTestCollection,
} from "./fakes";

describe("ProvisionDefaultCollections", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let principalRepo: FakePrincipalRepository;
	let usecase: ProvisionDefaultCollections;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		principalRepo = new FakePrincipalRepository();
		usecase = new ProvisionDefaultCollections(collectionRepo, principalRepo);
	});

	it("初回実行: デフォルトコレクションが全件作成される", async () => {
		const result = await usecase.execute({ owner: TEST_OWNER });
		expect(result.created).toHaveLength(DEFAULT_COLLECTION_SPECS.length);
		expect(result.skipped).toHaveLength(0);
	});

	it("冪等性: 2回実行してもコレクション数が増えない", async () => {
		await usecase.execute({ owner: TEST_OWNER });
		const r2 = await usecase.execute({ owner: TEST_OWNER });

		// 2回目は全件スキップ。
		expect(r2.created).toHaveLength(0);
		expect(r2.skipped).toHaveLength(DEFAULT_COLLECTION_SPECS.length);

		// コレクション数は最初の実行分だけ。
		const all = await collectionRepo.findAllByOwner(TEST_OWNER);
		expect(all).toHaveLength(DEFAULT_COLLECTION_SPECS.length);
	});

	it("一部既存の場合は存在しないもののみ作成する", async () => {
		// calendar だけ先に作っておく。
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar"));

		const result = await usecase.execute({ owner: TEST_OWNER });
		// tasks は新規作成、calendar はスキップ。
		expect(result.created).toHaveLength(1);
		expect(result.created[0]?.id).toBe(collectionId("tasks"));
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toBe(collectionId("calendar"));
	});

	it("カスタム specs を使える", async () => {
		const customSpecs = [
			{ id: "work", displayName: "Work Events", supportedComponents: ["VEVENT" as const] },
		];
		const result = await usecase.execute({ owner: TEST_OWNER, specs: customSpecs });
		expect(result.created).toHaveLength(1);
		// branded string は toBe に直接 collectionId() を渡すと型エラーになる。
		// 実体は同じ文字列なので string にキャストして比較する。
		expect(result.created[0]?.id as string).toBe("work");
	});

	it("作成されたコレクションは適切な supportedComponents を持つ", async () => {
		const result = await usecase.execute({ owner: TEST_OWNER });

		// CollectionId はブランド付き string。比較には collectionId() で変換するか as string にキャストする。
		const calCol = result.created.find((c) => (c.id as string) === "calendar");
		const taskCol = result.created.find((c) => (c.id as string) === "tasks");

		expect(calCol?.supportedComponents).toContain("VEVENT");
		expect(taskCol?.supportedComponents).toContain("VTODO");
	});
});
