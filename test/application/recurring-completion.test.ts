// =============================================================================
// completeRecurringTodo テスト(D4 モデルの2 PUT オーケストレーション。E-1 スライス②-c)
// =============================================================================
// CompleteTodo/UpdateTodo からの統合的な確認は complete-todo.test.ts / update-todo.test.ts
// で行う。ここでは completeRecurringTodo 自身が担う「PUT の回数・順序・条件・失敗伝播」に
// 焦点を絞る(PutCalendarObject を継承した RecordingPutCalendarObject で呼び出しを記録する)。
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	PutCalendarObject,
	completeRecurringTodo,
	lookupTodo,
	nowStampFromDate,
	ETagConditionError,
	type PutCalendarObjectInput,
	type PutCalendarObjectOutput,
} from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";
import { collectionId as mkCollectionId, CalendarObjectResource, resourceUri as mkResourceUri } from "../../src/domain/caldav";

const RECURRING_MASTER_ICS = readFileSync(
	join(__dirname, "../domain/ical/fixtures/real-ios/vtodo-recurring-master.ics"),
	"utf-8",
);

/** PUT 呼び出しを記録するテスト専用サブクラス。実際の保存は super.execute() に委譲する。 */
class RecordingPutCalendarObject extends PutCalendarObject {
	readonly calls: PutCalendarObjectInput[] = [];
	override async execute(input: PutCalendarObjectInput): Promise<PutCalendarObjectOutput> {
		this.calls.push(input);
		return super.execute(input);
	}
}

const COLLECTION_ID = mkCollectionId("tasks");

describe("completeRecurringTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let recordingPut: RecordingPutCalendarObject;

	beforeEach(async () => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		recordingPut = new RecordingPutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	async function seedRecurringMaster(): Promise<void> {
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, COLLECTION_ID, resource);
	}

	it("次回 occurrence がある場合: PUT がちょうど2回、(a) must-not-exist(新UID)→(b) must-match(元URI/元ETag)の順", async () => {
		await seedRecurringMaster();
		const looked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
		if (looked === null) throw new Error("setup failed");

		const { task } = await completeRecurringTodo(
			{ putCalendarObject: recordingPut, recurrenceIterator: TEST_RECURRENCE_ITERATOR },
			{ owner: TEST_OWNER, collectionId: COLLECTION_ID, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
		);

		expect(recordingPut.calls).toHaveLength(2);
		expect(recordingPut.calls[0]!.condition).toEqual({ kind: "must-not-exist" });
		expect(recordingPut.calls[0]!.resourceUri).not.toBe(looked.resourceUri);
		expect(recordingPut.calls[1]!.condition).toEqual({ kind: "must-match", etag: looked.etag.hex });
		expect(recordingPut.calls[1]!.resourceUri).toBe(looked.resourceUri);

		// 返る Task = 完了スナップショット。
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");
	});

	// 2026-07-13 V8 本番実機実測: 最終 occurrence 完了時も iOS は「スナップショット作成 +
	// マスターを UNTIL 越えの次の生ステップへ前進 + STATUS:COMPLETED」を行う(旧仕様の
	// 「前進先が無いので1 PUTのみ・マスターへ直接完了」という想定は誤りだった)。均一化した
	// 2 PUT モデルに合わせてこのテストを差し替える。
	it("最終 occurrence(UNTIL 越え)の場合: PUT は2回(スナップショット + 前進したマスター)、マスターは STATUS:COMPLETED", async () => {
		// UNTIL の直前(7/26)まで進めた状態を作り、そこから完了させると「次の生ステップ(8/1)へ
		// 前進しつつ最終回扱い」になる状況を作る(セットアップ自体は旧テストのものを流用できる)。
		await seedRecurringMaster();
		let looked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
		if (looked === null) throw new Error("setup failed");

		// 4回前進(7/18→7/19→7/25→7/26)させて「次は UNTIL 越え」の状態のマスターを作り、
		// それを resourceRepo に上書き保存してから最後の完了を試みる。
		const plainPut = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		for (let i = 0; i < 4; i++) {
			const { task } = await completeRecurringTodo(
				{ putCalendarObject: plainPut, recurrenceIterator: TEST_RECURRENCE_ITERATOR },
				{ owner: TEST_OWNER, collectionId: COLLECTION_ID, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
			);
			void task;
			looked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
			if (looked === null) throw new Error("re-lookup failed");
		}

		const before = await resourceRepo.findAllInCollection(TEST_OWNER, COLLECTION_ID);
		recordingPut.calls.length = 0;
		const { task } = await completeRecurringTodo(
			{ putCalendarObject: recordingPut, recurrenceIterator: TEST_RECURRENCE_ITERATOR },
			{ owner: TEST_OWNER, collectionId: COLLECTION_ID, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
		);
		const after = await resourceRepo.findAllInCollection(TEST_OWNER, COLLECTION_ID);

		// 常に2 PUT(スナップショット must-not-exist → 前進マスター must-match)。
		expect(recordingPut.calls).toHaveLength(2);
		expect(recordingPut.calls[0]!.condition).toEqual({ kind: "must-not-exist" });
		expect(recordingPut.calls[0]!.resourceUri).not.toBe(looked.resourceUri);
		expect(recordingPut.calls[1]!.condition).toEqual({ kind: "must-match", etag: looked.etag.hex });
		expect(recordingPut.calls[1]!.resourceUri).toBe(looked.resourceUri);
		expect(after.length).toBe(before.length + 1); // 完了スナップショットが1件増える。

		// 返る Task はスナップショット(完了済み)。
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");

		// マスター自身(元 UID)も STATUS:COMPLETED になり、DTSTART/DUE は UNTIL 越えの
		// 次の生ステップ(8/1)へ前進している。
		const masterLooked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
		if (masterLooked === null) throw new Error("master re-lookup failed");
		expect(masterLooked.vtodo.status).toBe("COMPLETED");
		expect(masterLooked.vtodo.raw.properties.find((p) => p.name === "DUE")?.value).toBe("20260801T211000");
	});

	it("PUT(b) が ETagConditionError を投げる場合: (a) は実行済みでエラーが伝播する(握りつぶさない)", async () => {
		await seedRecurringMaster();
		const looked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
		if (looked === null) throw new Error("setup failed");

		// looked.etag をわざと古い値のまま使い回しつつ、事前にマスターへ別の PUT を1回通しておくことで
		// completeRecurringTodo 内の PUT(b)(must-match: looked.etag)を確実に不一致にする。
		const staleEtag = looked.etag;
		const plainPut = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		await plainPut.execute({
			owner: TEST_OWNER,
			collectionId: COLLECTION_ID,
			resourceUri: looked.resourceUri,
			ics: RECURRING_MASTER_ICS.replace("CAP-RRULE2", "CAP-RRULE2-changed"),
			condition: { kind: "must-match", etag: staleEtag.hex },
		});

		await expect(
			completeRecurringTodo(
				{ putCalendarObject: recordingPut, recurrenceIterator: TEST_RECURRENCE_ITERATOR },
				{ owner: TEST_OWNER, collectionId: COLLECTION_ID, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
			),
		).rejects.toBeInstanceOf(ETagConditionError);

		// (a) は実行され、スナップショットは残っている(良性の余剰・冒頭コメントの失敗モード分析どおり)。
		expect(recordingPut.calls).toHaveLength(2);
		expect(recordingPut.calls[0]!.condition).toEqual({ kind: "must-not-exist" });
		const all = await resourceRepo.findAllInCollection(TEST_OWNER, COLLECTION_ID);
		expect(all.length).toBeGreaterThanOrEqual(2); // 変更後マスター + 完了スナップショット。
	});

	it("スナップショット VCALENDAR に VTIMEZONE が含まれる(TZID 付き DTSTART の解決に必須)", async () => {
		await seedRecurringMaster();
		const looked = await lookupTodo(resourceRepo, TEST_OWNER, COLLECTION_ID, "64F062E0-AF06-411E-8AC2-ABDFC8576159");
		if (looked === null) throw new Error("setup failed");

		await completeRecurringTodo(
			{ putCalendarObject: recordingPut, recurrenceIterator: TEST_RECURRENCE_ITERATOR },
			{ owner: TEST_OWNER, collectionId: COLLECTION_ID, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
		);

		const snapshotCall = recordingPut.calls[0]!;
		expect(snapshotCall.ics).toContain("BEGIN:VTIMEZONE");
		expect(snapshotCall.ics).toContain("TZID:Asia/Tokyo");
	});
});
