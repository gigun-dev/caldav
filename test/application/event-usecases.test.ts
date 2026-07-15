// =============================================================================
// CreateEvent / UpdateEvent / DeleteEvent ユースケース テスト(E-3 スライス S1)
// =============================================================================
// create-todo/update-todo/delete-todo のテスト群と対称。start/end 遷移(終日⇄時刻付き)・
// recurrence 全置換/除去・location/url・end 除去・start>end 入力エラー・削除を確認する。
import { describe, it, expect, beforeEach } from "bun:test";
import {
	CreateEvent,
	UpdateEvent,
	DeleteEvent,
	PutCalendarObject,
	DeleteCalendarObject,
	StartAfterEndError,
	StartEndTypeMismatchError,
	EventTimeZoneRequiredError,
	EventNotFoundError,
	InvalidAlarmsError,
	InvalidTravelMinutesError,
} from "../../src/application/usecases";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	TEST_OWNER,
	TEST_RECURRENCE_ITERATOR,
	makeTestCollection,
} from "./fakes";
import { collectionId as mkCollectionId } from "../../src/domain/caldav";

describe("event usecases", () => {
	let collectionRepo: FakeCalendarCollectionRepository;
	let resourceRepo: FakeCalendarObjectResourceRepository;
	let uow: FakeCollectionUnitOfWork;
	let createEvent: CreateEvent;
	let updateEvent: UpdateEvent;
	let deleteEvent: DeleteEvent;

	beforeEach(() => {
		collectionRepo = new FakeCalendarCollectionRepository();
		resourceRepo = new FakeCalendarObjectResourceRepository();
		uow = new FakeCollectionUnitOfWork(resourceRepo, collectionRepo);
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		const deleteCalendarObject = new DeleteCalendarObject(collectionRepo, resourceRepo, uow);
		createEvent = new CreateEvent(putCalendarObject);
		updateEvent = new UpdateEvent(putCalendarObject, resourceRepo);
		deleteEvent = new DeleteEvent(deleteCalendarObject, resourceRepo);
		// 既定 "calendar" コレクション(VEVENT 専用)を用意する。
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar", { supportedComponents: ["VEVENT"] }));
	});

	// --- CreateEvent -----------------------------------------------------------

	it("終日イベントを作成し Event DTO を返す(isAllDay・end 排他的終端)", async () => {
		const { event } = await createEvent.execute({ owner: TEST_OWNER, title: "旅行", start: "2026-07-15", end: "2026-07-18" });
		expect(event.title).toBe("旅行");
		expect(event.start).toBe("2026-07-15");
		expect(event.end).toBe("2026-07-18");
		expect(event.isAllDay).toBe(true);
		expect(event.recurrenceId).toBeNull();
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored).toHaveLength(1);
	});

	it("時刻付きイベントを作成する(自ゾーン offset ISO・VTIMEZONE 同梱)", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "会議",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T11:00:00",
			timeZone: "Asia/Tokyo",
		});
		expect(event.start).toBe("2026-07-15T10:00:00+09:00");
		expect(event.end).toBe("2026-07-15T11:00:00+09:00");
		expect(event.isAllDay).toBe(false);
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).toContain("BEGIN:VTIMEZONE");
	});

	it("end 省略で開始のみのイベントを作成できる(DTEND 無し=end:null)", async () => {
		const { event } = await createEvent.execute({ owner: TEST_OWNER, title: "終日1日", start: "2026-07-15" });
		expect(event.end).toBeNull();
	});

	it("location / url を設定できる(url は URI 値型でエスケープしない)", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "打合せ",
			start: "2026-07-15",
			location: "本社",
			url: "https://example.com/meet?a=1&b=2",
		});
		expect(event.location).toBe("本社");
		expect(event.url).toBe("https://example.com/meet?a=1&b=2");
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		// URI は TEXT エスケープしない(; や , をバックスラッシュで escape しない)。
		expect(stored[0]!.rawIcs).toContain("URL:https://example.com/meet?a=1&b=2");
	});

	it("反復イベント(RRULE)を作成できる", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "定例",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T11:00:00",
			timeZone: "Asia/Tokyo",
			recurrence: { frequency: "weekly", weekdays: ["WE"] },
		});
		expect(event.recurrence).toEqual({ frequency: "weekly", interval: 1, weekdays: ["WE"], count: null, until: null });
	});

	it("end <= start は StartAfterEndError", async () => {
		await expect(
			createEvent.execute({ owner: TEST_OWNER, title: "逆転", start: "2026-07-18", end: "2026-07-15" }),
		).rejects.toBeInstanceOf(StartAfterEndError);
	});

	it("start と end の値型不一致(終日 vs 時刻付き)は StartEndTypeMismatchError", async () => {
		await expect(
			createEvent.execute({ owner: TEST_OWNER, title: "混在", start: "2026-07-15", end: "2026-07-15T11:00:00", timeZone: "Asia/Tokyo" }),
		).rejects.toBeInstanceOf(StartEndTypeMismatchError);
	});

	it("時刻付き start で timeZone 省略は EventTimeZoneRequiredError", async () => {
		await expect(
			createEvent.execute({ owner: TEST_OWNER, title: "tz無し", start: "2026-07-15T10:00:00" }),
		).rejects.toBeInstanceOf(EventTimeZoneRequiredError);
	});

	it("通知(alarms)を設定でき、DTO は minutesBefore を昇順で返す + 移動時間", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "通院",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T11:00:00",
			timeZone: "Asia/Tokyo",
			alarms: [30, 0], // 入力順は逆でも DTO は昇順。
			travelMinutes: 45,
		});
		expect(event.alarms).toEqual([0, 30]);
		expect(event.travelMinutes).toBe(45);
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).toContain("TRIGGER:-PT30M");
		expect(stored[0]!.rawIcs).toContain("X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT45M");
	});

	it("alarms は最大2件・負値・重複を拒否する / travelMinutes は正整数のみ", async () => {
		const base = { owner: TEST_OWNER, title: "x", start: "2026-07-15" } as const;
		await expect(createEvent.execute({ ...base, alarms: [5, 10, 15] })).rejects.toBeInstanceOf(InvalidAlarmsError);
		await expect(createEvent.execute({ ...base, alarms: [-5] })).rejects.toBeInstanceOf(InvalidAlarmsError);
		await expect(createEvent.execute({ ...base, alarms: [10, 10] })).rejects.toBeInstanceOf(InvalidAlarmsError);
		await expect(createEvent.execute({ ...base, travelMinutes: 0 })).rejects.toBeInstanceOf(InvalidTravelMinutesError);
		await expect(createEvent.execute({ ...base, travelMinutes: -3 })).rejects.toBeInstanceOf(InvalidTravelMinutesError);
	});

	// --- UpdateEvent -----------------------------------------------------------

	async function seedEvent(args: Parameters<CreateEvent["execute"]>[0]): Promise<string> {
		const { event } = await createEvent.execute(args);
		return event.id;
	}

	it("タイトル・location を更新し before/after を返す", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "旧", start: "2026-07-15", location: "旧地" });
		const { event, before } = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, title: "新", location: "新地" });
		expect(before?.title).toBe("旧");
		expect(event.title).toBe("新");
		expect(event.location).toBe("新地");
	});

	it("終日 → 時刻付きへの start/end 遷移(VTIMEZONE 同梱)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "遷移", start: "2026-07-15", end: "2026-07-16" });
		const { event } = await updateEvent.execute({
			owner: TEST_OWNER,
			eventId: id,
			start: "2026-07-15T09:00:00",
			end: "2026-07-15T10:00:00",
			timeZone: "Asia/Tokyo",
		});
		expect(event.isAllDay).toBe(false);
		expect(event.start).toBe("2026-07-15T09:00:00+09:00");
		expect(event.end).toBe("2026-07-15T10:00:00+09:00");
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).toContain("BEGIN:VTIMEZONE");
	});

	it("end:null で終了を除去できる(開始のみのイベントになる)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "終了外し", start: "2026-07-15", end: "2026-07-16" });
		const { event } = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, end: null });
		expect(event.end).toBeNull();
	});

	it("recurrence 全置換 → 除去(none)ができる", async () => {
		const id = await seedEvent({
			owner: TEST_OWNER,
			title: "反復",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T11:00:00",
			timeZone: "Asia/Tokyo",
			recurrence: { frequency: "daily" },
		});
		// 全置換: weekly へ。
		const replaced = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, recurrence: { frequency: "weekly" } });
		expect(replaced.event.recurrence?.frequency).toBe("weekly");
		// 除去。
		const removed = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, recurrence: null });
		expect(removed.event.recurrence).toBeNull();
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).not.toContain("RRULE");
	});

	it("url を三値で更新できる(設定→除去)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "URL", start: "2026-07-15" });
		const set = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, url: "https://a.example/x" });
		expect(set.event.url).toBe("https://a.example/x");
		const cleared = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, url: null });
		expect(cleared.event.url).toBeNull();
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).not.toContain("URL:");
	});

	it("start だけ変更しても既存 end との整合が検証される(逆転は StartAfterEndError)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "整合", start: "2026-07-15", end: "2026-07-16" });
		// 新 start を既存 end より後にする → 逆転。
		await expect(
			updateEvent.execute({ owner: TEST_OWNER, eventId: id, start: "2026-07-20" }),
		).rejects.toBeInstanceOf(StartAfterEndError);
	});

	it("alarms を全置換→全除去でき、start 変更では相対トリガーが自動追従する(VALARM を触らない)", async () => {
		const id = await seedEvent({
			owner: TEST_OWNER,
			title: "通知",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T11:00:00",
			timeZone: "Asia/Tokyo",
			alarms: [15],
		});
		// 全置換: [10, 60] へ。
		const replaced = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, alarms: [10, 60] });
		expect(replaced.event.alarms).toEqual([10, 60]);

		// start だけ変更(既存 end 11:00 より前の 09:00)→ 相対トリガー(-PT10M/-PT60M)は文字列のまま
		// = 自動追従。alarms は据え置き(サーバーはトリガーを shift しない)。
		const moved = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, start: "2026-07-15T09:00:00", timeZone: "Asia/Tokyo" });
		expect(moved.event.alarms).toEqual([10, 60]);
		const stored1 = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored1[0]!.rawIcs).toContain("TRIGGER:-PT10M");
		expect(stored1[0]!.rawIcs).toContain("DTSTART;TZID=Asia/Tokyo:20260715T090000");

		// null で全除去。
		const cleared = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, alarms: null });
		expect(cleared.event.alarms).toEqual([]);
		const stored2 = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored2[0]!.rawIcs).not.toContain("BEGIN:VALARM");
	});

	it("travelMinutes を三値で更新できる(設定→除去)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "移動", start: "2026-07-15" });
		const set = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, travelMinutes: 20 });
		expect(set.event.travelMinutes).toBe(20);
		const cleared = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, travelMinutes: null });
		expect(cleared.event.travelMinutes).toBeNull();
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored[0]!.rawIcs).not.toContain("X-APPLE-TRAVEL-DURATION");
	});

	it("存在しない id は EventNotFoundError", async () => {
		await expect(
			updateEvent.execute({ owner: TEST_OWNER, eventId: "no-such", title: "x" }),
		).rejects.toBeInstanceOf(EventNotFoundError);
	});

	// --- DeleteEvent -----------------------------------------------------------

	it("削除して removed(削除直前スナップショット)を返す", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "消す", start: "2026-07-15", location: "会場" });
		const { removed } = await deleteEvent.execute({ owner: TEST_OWNER, eventId: id });
		expect(removed.title).toBe("消す");
		expect(removed.location).toBe("会場");
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		expect(stored).toHaveLength(0);
	});

	it("存在しない id の削除は EventNotFoundError", async () => {
		await expect(deleteEvent.execute({ owner: TEST_OWNER, eventId: "no-such" })).rejects.toBeInstanceOf(EventNotFoundError);
	});
});
