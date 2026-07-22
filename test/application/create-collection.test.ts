// =============================================================================
// CreateCollection ユースケース テスト
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import {
	CreateCollection,
	CollectionAlreadyExistsError,
	CollectionDisplayNameConflictError,
} from "../../src/application/usecases";
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

	// K1: id が別でも displayName が同じなら複製を拒否する(2026-07-23 追記、同日レビューで opt-in 化)。
	// 本番で「非 ASCII displayName の slug 縮退 → 毎回 crypto.randomUUID() フォールバック →
	// id 一致チェックをすり抜けて同名コレクションが複製される」実害が観測されたため、UC 層に
	// displayName 単位のガードを追加した(create-collection.ts の【K1】コメント参照)。
	// ただしこのガードは rejectDuplicateDisplayName:true(MCP 入口のみが渡す)のときだけ発動する
	// — iOS/iCloud は同名リマインダーリスト・カレンダーを正当に許すため、DAV 経路相当
	// (フラグ無し = 既定 false)では従来どおり作成できる必要がある(下の別テスト参照)。
	it("rejectDuplicateDisplayName:true かつ id が別でも同じ displayName が既存の場合は CollectionDisplayNameConflictError", async () => {
		collectionRepo.seed(
			makeTestCollection(TEST_OWNER, "list-aaaa1111", { displayName: "読書リスト" })
		);

		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				// 非 ASCII displayName の slugify 縮退バグ再現: id は毎回別の UUID/hash になり得るが
				// displayName は同じ「読書リスト」を渡す。id 一致チェックはすり抜けるはずなので、
				// displayName ガードだけが唯一の防衛線になっていることを確認する。
				collectionId: "list-bbbb2222",
				displayName: "読書リスト",
				rejectDuplicateDisplayName: true,
			})
		).rejects.toBeInstanceOf(CollectionDisplayNameConflictError);
	});

	// 比較の正規化(NFC + trim + 大文字小文字を無視)が効いていることを確認する(rejectDuplicateDisplayName:true 時)。
	it("rejectDuplicateDisplayName:true では displayName の前後空白・大文字小文字・NFC/NFD の差異があっても重複とみなす", async () => {
		// "が" を NFC(結合済み1文字)で登録しておき、NFD(基底文字+濁点の2文字)で問い合わせる。
		const nfcName = "しごと".normalize("NFC");
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "work-nfc", { displayName: nfcName }));

		await expect(
			usecase.execute({
				owner: TEST_OWNER,
				collectionId: "work-nfd",
				displayName: `  ${nfcName.normalize("NFD")}  `.toUpperCase(),
				rejectDuplicateDisplayName: true,
			})
		).rejects.toBeInstanceOf(CollectionDisplayNameConflictError);
	});

	it("rejectDuplicateDisplayName:true でも displayName が異なれば従来どおり作成できる", async () => {
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "work", { displayName: "Work" }));

		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: "personal",
			displayName: "Personal",
			rejectDuplicateDisplayName: true,
		});

		expect(result.collection.id as string).toBe("personal");
	});

	// DAV(MKCALENDAR)経路相当: rejectDuplicateDisplayName を渡さない(既定 false)場合は
	// 同じ displayName でも id さえ異なれば作成できる(iOS/iCloud の正当な同名作成を壊さない)。
	// このテストが green であることが「DAV 経路は無改修 = 挙動不変」の証跡になる。
	it("rejectDuplicateDisplayName 省略時(DAV 経路相当)は同じ displayName でも作成できる", async () => {
		collectionRepo.seed(
			makeTestCollection(TEST_OWNER, "reminders-1", { displayName: "買い物リスト" })
		);

		const result = await usecase.execute({
			owner: TEST_OWNER,
			collectionId: "reminders-2",
			displayName: "買い物リスト",
			// rejectDuplicateDisplayName を意図的に渡さない。
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
