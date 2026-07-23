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

	// 2026-07-23: K1 で導入した displayName 単位の重複ガード(rejectDuplicateDisplayName フラグ /
	// CollectionDisplayNameConflictError)は同日中にユーザー裁定で全面撤回された(誤った問題定義
	// だったため — create-collection.ts 冒頭コメント参照)。この UC は id 一致以外では重複を検出
	// しないので、id さえ異なれば同じ displayName でも常に作成できる(iOS/iCloud が同名の複数
	// リストを許すのと同じ)。冪等性は「id 側を安定化させて自然に id 一致にぶつける」方式で
	// presentation 層(server.ts create-calendar ハンドラ)が実現する。
	it("id が別なら同じ displayName でも常に作成できる(displayName の一意性は UC 層では強制しない)", async () => {
		collectionRepo.seed(
			makeTestCollection(TEST_OWNER, "reminders-1", { displayName: "買い物リスト" })
		);

		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: "reminders-2",
			displayName: "買い物リスト",
		});

		expect(result.collection.id as string).toBe("reminders-2");
		expect(result.collection.displayName).toBe("買い物リスト");
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
