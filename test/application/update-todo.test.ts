// =============================================================================
// UpdateTodo ユースケース テスト(E-1 スライス②-b)
// =============================================================================
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CreateTodo,
	PutCalendarObject,
	TodoNotFoundError,
	UpdateTodo,
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

// CompleteTodo テストと同じ実機フィクスチャ(RRULE:FREQ=WEEKLY;... を持つ VTODO)。
// UpdateTodo.status:"COMPLETED" にも同じ反復ガードが効くことを検証する(2026-07-12 レビューで
// 追加した不変条件 — update-todo.ts の入力コメント参照)。
const RECURRING_MASTER_ICS = readFileSync(
	join(__dirname, "../domain/ical/fixtures/real-ios/vtodo-recurring-master.ics"),
	"utf-8",
);

describe("UpdateTodo", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let createTodo: CreateTodo;
	let updateTodo: UpdateTodo;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		createTodo = new CreateTodo(putCalendarObject);
		updateTodo = new UpdateTodo(putCalendarObject, resourceRepo, TEST_RECURRENCE_ITERATOR);

		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
	});

	it("title を更新すると SUMMARY が変わり、他フィールドは維持される", async () => {
		const { task: created } = await createTodo.execute({
			owner: TEST_OWNER,
			title: "旧タイトル",
			notes: "メモ",
			priority: 5,
		});

		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, title: "新タイトル" });
		expect(task.title).toBe("新タイトル");
		expect(task.notes).toBe("メモ");
		expect(task.priority).toBe(5);
	});

	it("due を更新すると VALUE=DATE の DTSTART/DUE が同値で書き換わる", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "提出物" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, due: "2026-08-01" });
		expect(task.due).toBe("2026-08-01");
		expect(task.isAllDay).toBe(true);
	});

	it("priority:0 を渡すと PRIORITY が未設定に戻る", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "優先度あり", priority: 1 });
		expect(created.priority).toBe(1);
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, priority: 0 });
		expect(task.priority).toBe(0);
	});

	it("status:'COMPLETED' で完了状態になる(三点セット)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "完了テスト" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "COMPLETED" });
		expect(task.completed).toBe(true);
		expect(task.status).toBe("COMPLETED");
		expect(task.percentComplete).toBe(100);
		expect(task.completedAt).not.toBeNull();
	});

	it("status:'NEEDS-ACTION' で再開できる(COMPLETED/PERCENT-COMPLETE が消える)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "再開テスト" });
		await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "COMPLETED" });
		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, status: "NEEDS-ACTION" });
		expect(task.completed).toBe(false);
		expect(task.status).toBe("NEEDS-ACTION");
		expect(task.percentComplete).toBeNull();
		expect(task.completedAt).toBeNull();
	});

	it("status:'COMPLETED' + title 変更(反復 VTODO): スナップショットとマスター両方に新 title が反映される", async () => {
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: masterUid,
			title: "新タイトル(反復)",
			status: "COMPLETED",
		});
		// 返る Task = 完了スナップショット。
		expect(task.title).toBe("新タイトル(反復)");
		expect(task.completed).toBe(true);

		const masterUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), masterUid);
		const masterResource = masterUri === null ? null : await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), masterUri);
		const masterVtodo = masterResource!.payload.todos()[0]!;
		expect(masterVtodo.summary).toBe("新タイトル(反復)");
		expect(masterVtodo.status).toBe("NEEDS-ACTION"); // マスターは前進するが完了扱いにはならない。
	});

	it("status:'NEEDS-ACTION'(反復 VTODO): reopen のみ行われる(前進しない)", async () => {
		const uri = mkResourceUri("recurring-master.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: masterUid, status: "NEEDS-ACTION" });
		expect(task.status).toBe("NEEDS-ACTION");
		expect(task.completed).toBe(false);
		// reopen は反復性に関係なくガードしない = completeRecurringTodo を経由しないので
		// リソース件数は1件のまま(スナップショットは作られない)。
		const all = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(all).toHaveLength(1);
	});

	it("存在しない todoId は TodoNotFoundError", async () => {
		await expect(
			updateTodo.execute({ owner: TEST_OWNER, todoId: "no-such-uid", title: "x" }),
		).rejects.toBeInstanceOf(TodoNotFoundError);
	});

	// -----------------------------------------------------------------------
	// due 変更時の VALARM 絶対トリガー追随(2026-07-13 追加。V2 実機で判明した欠落)
	// -----------------------------------------------------------------------
	// CreateTodo は時刻付き due を生成できない(InvalidDueError — create-todo.ts 冒頭コメント)ため、
	// 「時刻付き VALARM を持つ単発 VTODO」の fixture は CalendarObjectResource.fromIcs で直接
	// 作って resourceRepo に seed する(反復系テストと同じパターン)。
	const SINGLE_SHOT_WITH_ALARMS_ICS = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTIMEZONE",
		"TZID:Asia/Tokyo",
		"BEGIN:STANDARD",
		"DTSTART:19510909T010000",
		"TZNAME:JST",
		"TZOFFSETFROM:+1000",
		"TZOFFSETTO:+0900",
		"END:STANDARD",
		"END:VTIMEZONE",
		"BEGIN:VTODO",
		"UID:single-shot-alarm-test",
		"DTSTAMP:20260712T000000Z",
		"DTSTART;TZID=Asia/Tokyo:20260712T210000",
		"DUE;TZID=Asia/Tokyo:20260712T210000",
		"STATUS:NEEDS-ACTION",
		"SUMMARY:締め切りリマインダー",
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"DESCRIPTION:Reminder",
		"TRIGGER;VALUE=DATE-TIME:20260712T120000Z",
		"END:VALARM",
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"DESCRIPTION:Reminder",
		"TRIGGER;RELATED=START:-PT15M",
		"END:VALARM",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");

	function alarmTriggers(component: import("../../src/domain/ical").Component): (string | undefined)[] {
		return component.components
			.filter((c) => c.name === "VALARM")
			.map((c) => c.properties.find((p) => p.name === "TRIGGER")?.value);
	}

	it("due を別日に更新すると絶対トリガーが (新due-旧due) ぶん動き、相対トリガーは不変", async () => {
		const uri = mkResourceUri("single-shot-alarm.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, SINGLE_SHOT_WITH_ALARMS_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);

		// 旧 DUE: 20260712T210000+09:00 = 20260712T120000Z。新 due: 2026-08-01(終日 = UTC 00:00 起点)。
		// shiftMs = calDateStartEpochMillis(20260801, "UTC") - 20260712T120000Z
		//         = Date.UTC(2026,7,1) - Date.UTC(2026,6,12,12,0,0)
		// 絶対トリガー 20260712T120000Z も同じだけ動くので、新トリガーは
		// 20260712T120000Z + shiftMs = 20260801T000000Z になる(旧トリガーが旧 due と同時刻だったため
		// 差分がちょうど打ち消し合い、新 due の start-of-day と一致する — たまたまではなく
		// 「アラームは常に due と同じだけ動く」オフセット保存規則の帰結)。
		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: "single-shot-alarm-test",
			due: "2026-08-01",
		});
		expect(task.due).toBe("2026-08-01");

		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), "single-shot-alarm-test");
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const vtodoComponent = saved!.payload.todos()[0]!.raw;
		const triggers = alarmTriggers(vtodoComponent);

		expect(triggers).toContain("20260801T000000Z"); // 絶対トリガー: due と同じだけ前進。
		expect(triggers).toContain("-PT15M"); // 相対トリガー: 不変。
	});

	it("title のみの更新では VALARM に触れない(due 不変)", async () => {
		const uri = mkResourceUri("single-shot-alarm-2.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, SINGLE_SHOT_WITH_ALARMS_ICS.replace("single-shot-alarm-test", "single-shot-alarm-test-2"));
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);

		await updateTodo.execute({ owner: TEST_OWNER, todoId: "single-shot-alarm-test-2", title: "新タイトルのみ" });

		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), "single-shot-alarm-test-2");
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const triggers = alarmTriggers(saved!.payload.todos()[0]!.raw);

		expect(triggers).toContain("20260712T120000Z"); // 絶対トリガー: due を変えていないので不変。
		expect(triggers).toContain("-PT15M"); // 相対トリガー: 不変。
	});

	it("反復 VTODO で due 変更 + status:'COMPLETED': スナップショット/前進後マスター双方の VALARM が due 変更ぶん動く", async () => {
		// 【RECURRING_MASTER_ICS を使わない理由(2026-07-13 追記: 現在は A-2 で解消済みの制約)】
		// このテストを書いた時点では、RECURRING_MASTER_ICS(DTSTART;TZID=...(DATE-TIME)+
		// RRULE UNTIL=...Z(DATE-TIME))へ UpdateTodo.due(=VALUE=DATE 固定。vtodo-patch.ts の制約)を
		// patch すると DTSTART が DATE-TIME→DATE に変わるのに RRULE の UNTIL は DATE-TIME のまま
		// 残り、I6(§3.3.10 UNTIL 値型一致 MUST)違反になっていた。vtodo-patch.ts の
		// patchVTodoFields に untilToDateIfNeeded を足し、due を DATE に patch する際 UNTIL も
		// 追従して DATE 化するよう直したので、現在は RECURRING_MASTER_ICS でも due 変更は通る
		// (下の「A-2」テストで検証)。このテスト自体は元々「VALARM shift が反復前進に正しく
		// 引き継がれるか」の検証が主眼で UNTIL の値型とは無関係なので、既存の COUNT ベース
		// fixture のままにして関心を混ぜない。
		const uri = mkResourceUri("recurring-master-due-shift.ics");
		const countBasedIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:recurring-due-shift-test",
			"DTSTAMP:20260712T000000Z",
			"DTSTART;VALUE=DATE:20260712",
			"DUE;VALUE=DATE:20260712",
			"RRULE:FREQ=DAILY;COUNT=5",
			"STATUS:NEEDS-ACTION",
			"SUMMARY:反復due変更テスト",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:Reminder",
			"TRIGGER;VALUE=DATE-TIME:20260712T121000Z",
			"END:VALARM",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const resource = await CalendarObjectResource.fromIcs(uri, countBasedIcs);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		// 旧 DUE: 20260712(終日=UTC 00:00 起点)。VALARM は 20260712T121000Z(due の正午+12:10)。
		// 新 due: 2026-07-20(終日)。
		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: masterUid,
			due: "2026-07-20",
			status: "COMPLETED",
		});
		// 返り値は完了スナップショット。スナップショットの VALARM は「due 変更ぶんの shift」を
		// 受けた patched を経由して buildCompletionSnapshot に渡っているので、絶対トリガーは
		// 新 due(start-of-day UTC)と一致する(fixture は旧 DUE==旧 TRIGGER だったため)。
		expect(task.due).toBe("2026-07-20");
		expect(task.completed).toBe(true);

		const snapshotUri = mkResourceUri(`${task.id}.ics`);
		const snapshotResource = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), snapshotUri);
		const snapshotTriggers = alarmTriggers(snapshotResource!.payload.todos()[0]!.raw);
		// shiftMs = (2026-07-20 start-of-day UTC) - (2026-07-12 start-of-day UTC) = 8日。
		// VALARM 20260712T121000Z + 8日 = 20260720T121000Z。
		expect(snapshotTriggers).toContain("20260720T121000Z");

		// マスターは次 occurrence(反復の前進)へ進んでいるので、VALARM はさらに
		// advanceMasterToNextOccurrence 側の「occurrence 絶対時間差」ぶん動く(このテストでは
		// due 変更由来の shift が前進処理にも正しく引き継がれていること = マスターの VALARM が
		// 「未定義」や「due 変更前の値のまま」になっていないことだけを確認する)。
		const masterUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), masterUid);
		const masterResource = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), masterUri!);
		const masterTriggers = alarmTriggers(masterResource!.payload.todos()[0]!.raw);
		expect(masterTriggers[0]).not.toBe("20260712T121000Z"); // 旧値のまま取り残されていない。
		expect(masterTriggers[0]).not.toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// A-2: RRULE:UNTIL(DATE-TIME) を持つ反復 VTODO の due 変更が I6 違反にならない
	// -----------------------------------------------------------------------
	it("RRULE:UNTIL(DATE-TIME) を持つ反復 VTODO の due 変更は I6 違反にならず、UNTIL が DATE に追従する", async () => {
		const uri = mkResourceUri("recurring-master-until-datetime.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);
		const masterUid = resource.uid;

		// PutCalendarObject の precondition I6 に引っかかって throw すればこの await 自体が
		// reject する(patchVTodoFields が UNTIL を追従させていなければここで失敗する)。
		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: masterUid,
			due: "2026-08-01",
		});
		expect(task.due).toBe("2026-08-01");
		expect(task.isAllDay).toBe(true);

		const masterUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), masterUid);
		const masterResource = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), masterUri!);
		const masterVtodo = masterResource!.payload.todos()[0]!;
		const rruleRaw = masterVtodo.raw.properties.find((p) => p.name === "RRULE")?.value;
		// 元は UNTIL=20260731T111300Z(DATE-TIME)。日付部分だけ残して DATE 化されているはず。
		expect(rruleRaw).toBe("FREQ=WEEKLY;UNTIL=20260731;BYDAY=SU,SA");
	});

	// -----------------------------------------------------------------------
	// V6 フォローアップ: 時刻付き due / due 除去(create-todo との対称化。2026-07-14)
	// -----------------------------------------------------------------------
	it("終日 due を時刻付きに変更すると DTSTART;TZID/DUE;TZID + VTIMEZONE が同梱される", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "時刻付き化", due: "2026-08-01" });
		const { task } = await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: created.id,
			due: "2026-08-01T09:00:00",
			timeZone: "Asia/Tokyo",
		});
		expect(task.isAllDay).toBe(false);
		// due は自ゾーンの offset ISO で返る(taskFromVTodo が zoneResolverFor で整形)。
		expect(task.due).toBe("2026-08-01T09:00:00+09:00");

		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), created.id);
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const vcal = saved!.payload.raw;
		// VTIMEZONE(Asia/Tokyo)が VCALENDAR に同梱されている。
		const vtz = vcal.components.filter((c) => c.name === "VTIMEZONE");
		expect(vtz).toHaveLength(1);
		expect(vtz[0]!.properties.find((p) => p.name === "TZID")?.value).toBe("Asia/Tokyo");
		// DTSTART/DUE は TZID 付き。
		const vtodo = saved!.payload.todos()[0]!.raw;
		const dtstart = vtodo.properties.find((p) => p.name === "DTSTART");
		expect(dtstart?.value).toBe("20260801T090000");
		expect(dtstart?.parameters).toEqual([{ name: "TZID", values: ["Asia/Tokyo"] }]);
	});

	it("同一ゾーン内での時刻付き→時刻付き変更で VTIMEZONE が重複しない", async () => {
		const { task: created } = await createTodo.execute({
			owner: TEST_OWNER,
			title: "ゾーン内変更",
			due: "2026-08-01T09:00:00",
			timeZone: "Asia/Tokyo",
		});
		await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, due: "2026-08-02T10:00:00", timeZone: "Asia/Tokyo" });

		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), created.id);
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const vtz = saved!.payload.raw.components.filter((c) => c.name === "VTIMEZONE");
		expect(vtz).toHaveLength(1); // 重複追加していない。
	});

	it("時刻付き due に timeZone を付けないと DueTimeZoneRequiredError", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "tz無し", due: "2026-08-01" });
		await expect(
			updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, due: "2026-08-01T09:00:00" }),
		).rejects.toMatchObject({ kind: "DueTimeZoneRequiredError" });
	});

	it("DST ゾーンは UnsupportedTimeZoneError(Phase 1 は固定オフセットのみ)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "DST", due: "2026-08-01" });
		await expect(
			updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, due: "2026-08-01T09:00:00", timeZone: "America/New_York" }),
		).rejects.toMatchObject({ kind: "UnsupportedTimeZoneError" });
	});

	it("due:null で期日が外れ、期日依存 VALARM(絶対 + 相対)は除去され位置アラームは残る", async () => {
		const uri = mkResourceUri("remove-due.ics");
		const resource = await CalendarObjectResource.fromIcs(
			uri,
			SINGLE_SHOT_WITH_ALARMS_ICS.replace("single-shot-alarm-test", "remove-due-test"),
		);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);

		const { task } = await updateTodo.execute({ owner: TEST_OWNER, todoId: "remove-due-test", due: null });
		expect(task.due).toBeNull();

		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), "remove-due-test");
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const vtodo = saved!.payload.todos()[0]!.raw;
		expect(vtodo.properties.find((p) => p.name === "DTSTART")).toBeUndefined();
		expect(vtodo.properties.find((p) => p.name === "DUE")).toBeUndefined();
		// SINGLE_SHOT_WITH_ALARMS_ICS の2つの VALARM(絶対 + 相対)はどちらも位置でないので除去される。
		expect(vtodo.components.filter((c) => c.name === "VALARM")).toHaveLength(0);
	});

	it("反復 VTODO(RRULE あり)の due 除去は RecurringDueRemovalError で拒否する", async () => {
		const uri = mkResourceUri("recurring-remove-due.ics");
		const resource = await CalendarObjectResource.fromIcs(uri, RECURRING_MASTER_ICS);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);

		await expect(
			updateTodo.execute({ owner: TEST_OWNER, todoId: resource.uid, due: null }),
		).rejects.toMatchObject({ kind: "RecurringDueRemovalError" });
	});

	it("時刻付き due 変更でも絶対 VALARM トリガーが (新due-旧due) ぶん動く", async () => {
		const uri = mkResourceUri("timed-shift.ics");
		const resource = await CalendarObjectResource.fromIcs(
			uri,
			SINGLE_SHOT_WITH_ALARMS_ICS.replace("single-shot-alarm-test", "timed-shift-test"),
		);
		resourceRepo.seed(TEST_OWNER, mkCollectionId("tasks"), resource);

		// 旧 DUE 20260712T210000+09:00 = 20260712T120000Z(= 旧絶対トリガーと同時刻)。
		// 新 due 20260713T210000 JST = 20260713T120000Z。差 = 24h。絶対トリガーも 24h 動く。
		await updateTodo.execute({
			owner: TEST_OWNER,
			todoId: "timed-shift-test",
			due: "2026-07-13T21:00:00",
			timeZone: "Asia/Tokyo",
		});
		const savedUri = await resourceRepo.findUriByUid(TEST_OWNER, mkCollectionId("tasks"), "timed-shift-test");
		const saved = await resourceRepo.findByUri(TEST_OWNER, mkCollectionId("tasks"), savedUri!);
		const triggers = alarmTriggers(saved!.payload.todos()[0]!.raw);
		expect(triggers).toContain("20260713T120000Z"); // 絶対トリガー: due と同じだけ前進。
		expect(triggers).toContain("-PT15M"); // 相対トリガー: 不変。
	});

	it("更新後は resourceRepo 上の ETag も変わっている(must-match PUT が発行された証跡)", async () => {
		const { task: created } = await createTodo.execute({ owner: TEST_OWNER, title: "etag確認" });
		const before = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		const etagBefore = before[0]!.etag.hex;
		await updateTodo.execute({ owner: TEST_OWNER, todoId: created.id, title: "etag確認・更新後" });
		const after = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("tasks"));
		expect(after[0]!.etag.hex).not.toBe(etagBefore);
	});
});
