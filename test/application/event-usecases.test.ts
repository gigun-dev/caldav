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
	InvalidUrlError,
	InvalidStructuredLocationError,
	InvalidConferenceUrlError,
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

	// 2026-07-24: 時刻付き start で end 省略時のデフォルト補完(create-event.ts 冒頭の
	// DEFAULT_TIMED_EVENT_DURATION_MINUTES コメント参照)。iOS で終了時刻が表示されない
	// 「ゼロ長」イベント問題への対処。all-day は対象外(直上のテストで確認済み・現状維持)。
	it("時刻付き start で end 省略時は start+1h を DTEND に補完する(iOS ゼロ長イベント対策)", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "岐阜大学ランチ",
			start: "2026-07-25T12:00:00",
			timeZone: "Asia/Tokyo",
		});
		expect(event.start).toBe("2026-07-25T12:00:00+09:00");
		expect(event.end).toBe("2026-07-25T13:00:00+09:00");
		expect(event.isAllDay).toBe(false);
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		// DTEND の raw が TZID 付きで書かれ、DTSTART からちょうど1時間後の壁時計になっていること
		// (epoch を直に UTC raw にすると TZID と矛盾するため、ローカル壁時計として書き戻す実装)。
		expect(stored[0]!.rawIcs).toContain("DTSTART;TZID=Asia/Tokyo:20260725T120000");
		expect(stored[0]!.rawIcs).toContain("DTEND;TZID=Asia/Tokyo:20260725T130000");
	});

	it("時刻付き start でも end を明示すればそれが優先される(デフォルト補完は上書きしない)", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "会議",
			start: "2026-07-15T10:00:00",
			end: "2026-07-15T10:30:00",
			timeZone: "Asia/Tokyo",
		});
		expect(event.end).toBe("2026-07-15T10:30:00+09:00");
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

	// S-C(docs/modeling/12 §7.6): url はスキーム付き絶対 URI を要求する(§3.8.4.6 は URI の form を
	// 標準化しないので http/https に限定しない — tel:/webex: 等の非 http スキームは許容する)。
	it("url はスキーム付き絶対 URI のみ許可する(スキーム無しは InvalidUrlError・非 http スキームは許可)", async () => {
		const base = { owner: TEST_OWNER, title: "x", start: "2026-07-15" } as const;
		await expect(createEvent.execute({ ...base, url: "x.com" })).rejects.toBeInstanceOf(InvalidUrlError);
		await expect(createEvent.execute({ ...base, url: "example.com/path" })).rejects.toBeInstanceOf(InvalidUrlError);
		await expect(createEvent.execute({ ...base, url: "" })).rejects.toBeInstanceOf(InvalidUrlError);
		// http/https 限定ではない(§3.8.4.6 原文が form を標準化しないため tel:/webex: も通す)。
		const { event: telEvent } = await createEvent.execute({ ...base, url: "tel:+81-3-1234-5678" });
		expect(telEvent.url).toBe("tel:+81-3-1234-5678");
		const { event: webexEvent } = await createEvent.execute({ ...base, url: "webex:meeting-id" });
		expect(webexEvent.url).toBe("webex:meeting-id");
	});

	// --- CreateEvent: structuredLocation / conference(C8・設計 05)-----------------

	it("structuredLocation を指定すると LOCATION が title になり読み戻せる(round-trip)", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "岐阜大学で会議",
			start: "2026-07-15",
			structuredLocation: { title: "岐阜大学", address: "岐阜県岐阜市柳戸1-1", lat: 35.463012, lon: 136.737202, radius: 100 },
		});
		expect(event.location).toBe("岐阜大学");
		expect(event.structuredLocation).toEqual({
			title: "岐阜大学",
			address: "岐阜県岐阜市柳戸1-1",
			geo: { lat: 35.463012, lon: 136.737202 },
			radiusMeters: 100,
		});
	});

	it("conference を指定すると DESCRIPTION に会議ブロックが追記され、conference/notes 両方が読み戻せる", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "面談",
			start: "2026-07-15",
			notes: "面談のお知らせです。",
			conference: { url: "https://meet.google.com/xpk-yooe-eev" },
		});
		expect(event.notes).toBe("面談のお知らせです。\n\n----( ビデオ通話 )----\nhttps://meet.google.com/xpk-yooe-eev\n---===---");
		expect(event.conference).toEqual({ url: "https://meet.google.com/xpk-yooe-eev", source: "description" });
	});

	it("conference.url は http(s) 以外だと InvalidConferenceUrlError", async () => {
		await expect(
			createEvent.execute({ owner: TEST_OWNER, title: "壊れた会議", start: "2026-07-15", conference: { url: "message:abc" } }),
		).rejects.toBeInstanceOf(InvalidConferenceUrlError);
	});

	it("structuredLocation の座標範囲外は InvalidStructuredLocationError", async () => {
		await expect(
			createEvent.execute({
				owner: TEST_OWNER,
				title: "壊れた場所",
				start: "2026-07-15",
				structuredLocation: { title: "どこか", lat: 999, lon: 0 },
			}),
		).rejects.toBeInstanceOf(InvalidStructuredLocationError);
	});

	// #45 スライス B: geo(lat/lon)無しの structuredLocation は degrade で受理する(住所のみ登録)。
	it("structuredLocation を geo 無し(title/address のみ)で指定すると LOCATION に degrade して読み戻せる", async () => {
		const { event } = await createEvent.execute({
			owner: TEST_OWNER,
			title: "座標なしの予定",
			start: "2026-07-15",
			structuredLocation: { title: "叙々苑 品川店", address: "東京都港区高輪4-10-30" },
		});
		// LOCATION は title + 住所を改行併記(degrade)。X-APPLE-STRUCTURED-LOCATION は書かれない。
		expect(event.location).toBe("叙々苑 品川店\n東京都港区高輪4-10-30");
		expect(event.structuredLocation).toBeNull();
	});

	// #45 スライス B: 片方だけの geo(lat だけ / lon だけ)は部分入力として弾く。
	it("structuredLocation の lat だけ(lon 欠落)は InvalidStructuredLocationError(geo-partial)", async () => {
		await expect(
			createEvent.execute({
				owner: TEST_OWNER,
				title: "部分 geo",
				start: "2026-07-15",
				structuredLocation: { title: "どこか", lat: 35 },
			}),
		).rejects.toBeInstanceOf(InvalidStructuredLocationError);
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

	it("recurrence:null は EXDATE と override(RECURRENCE-ID)も掃除する", async () => {
		// 【2026-07-22 本番実データ由来の回帰テスト】iPhone 純正カレンダーが単発編集した繰り返し予定は
		// master(RRULE+EXDATE)と override(RECURRENCE-ID 付き VEVENT)が1ファイルに同居する。
		// この状態で MCP から「繰り返しなし」に変更したとき、RRULE だけ消して EXDATE/override を
		// 残すと、本アプリの展開(非反復 master は override を捨てる)では見えないのに Apple
		// クライアントには孤児 override が表示され続ける、というクライアント間の見え方割れが起きる
		// (update-event.ts / vevent-patch.ts の対コメント参照)。
		const putCalendarObject = new PutCalendarObject(collectionRepo, resourceRepo, uow, TEST_RECURRENCE_ITERATOR);
		const uid = "apple-edited-recurring-001";
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//JP",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260721T000000Z",
			"DTSTART:20260716T060000Z",
			"DTEND:20260716T070000Z",
			"RRULE:FREQ=DAILY;UNTIL=20260718T145959Z",
			"EXDATE:20260717T060000Z",
			"SUMMARY:反復(Apple 単発編集済み)",
			"END:VEVENT",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260721T000000Z",
			"RECURRENCE-ID:20260716T060000Z",
			"DTSTART:20260721T060000Z",
			"DTEND:20260721T070000Z",
			"SUMMARY:反復(Apple 単発編集済み)",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		await putCalendarObject.execute({
			owner: TEST_OWNER,
			collectionId: mkCollectionId("calendar"),
			resourceUri: `${uid}.ics`,
			ics,
			condition: { kind: "must-not-exist" },
		});

		const { event } = await updateEvent.execute({ owner: TEST_OWNER, eventId: uid, recurrence: null });
		expect(event.recurrence).toBeNull();
		const stored = await resourceRepo.findAllInCollection(TEST_OWNER, mkCollectionId("calendar"));
		const raw = stored[0]!.rawIcs;
		expect(raw).not.toContain("RRULE");
		expect(raw).not.toContain("EXDATE");
		expect(raw).not.toContain("RECURRENCE-ID"); // 孤児 override が削除されている
		// master 自体は残っている(VEVENT が1つだけになる)。
		expect(raw.split("BEGIN:VEVENT").length - 1).toBe(1);
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

	it("update-event の url もスキーム付き絶対 URI を要求する(create-event と対称)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "URL検証", start: "2026-07-15" });
		await expect(updateEvent.execute({ owner: TEST_OWNER, eventId: id, url: "x.com" })).rejects.toBeInstanceOf(InvalidUrlError);
		// null(除去)は検証をスキップする(値を書かないので絶対 URI 制約は無関係)。
		await expect(updateEvent.execute({ owner: TEST_OWNER, eventId: id, url: null })).resolves.toBeDefined();
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

	// --- UpdateEvent: structuredLocation / conference(C8・設計 05)------------------

	it("structuredLocation を三値で更新できる(設定→除去。LOCATION テキストは除去時も温存)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "場所更新", start: "2026-07-15" });
		const set = await updateEvent.execute({
			owner: TEST_OWNER,
			eventId: id,
			structuredLocation: { title: "岐阜大学", lat: 35.463012, lon: 136.737202 },
		});
		expect(set.event.location).toBe("岐阜大学");
		expect(set.event.structuredLocation?.title).toBe("岐阜大学");

		const cleared = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, structuredLocation: null });
		expect(cleared.event.structuredLocation).toBeNull();
		// null は「構造化データのみ除去」— LOCATION テキストは温存する契約(vevent-patch.ts コメント)。
		expect(cleared.event.location).toBe("岐阜大学");
	});

	it("conference を三値で更新できる(設定→除去。notes 本文は独立して温存される)", async () => {
		const id = await seedEvent({ owner: TEST_OWNER, title: "会議更新", start: "2026-07-15", notes: "本文です。" });
		const set = await updateEvent.execute({
			owner: TEST_OWNER,
			eventId: id,
			conference: { url: "https://meet.google.com/abc" },
		});
		expect(set.event.conference).toEqual({ url: "https://meet.google.com/abc", source: "description" });
		expect(set.event.notes).toBe("本文です。\n\n----( ビデオ通話 )----\nhttps://meet.google.com/abc\n---===---");

		// conference だけ除去 → notes 本文は既存 split から復元されて温存される(蓄積した空行も無い)。
		const cleared = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, conference: null });
		expect(cleared.event.conference).toBeNull();
		expect(cleared.event.notes).toBe("本文です。");
	});

	it("notes だけ更新しても既存の conference は温存される(独立 patch)", async () => {
		const id = await seedEvent({
			owner: TEST_OWNER,
			title: "混在更新",
			start: "2026-07-15",
			notes: "旧本文",
			conference: { url: "https://meet.google.com/abc" },
		});
		const updated = await updateEvent.execute({ owner: TEST_OWNER, eventId: id, notes: "新本文" });
		expect(updated.event.conference).toEqual({ url: "https://meet.google.com/abc", source: "description" });
		expect(updated.event.notes).toBe("新本文\n\n----( ビデオ通話 )----\nhttps://meet.google.com/abc\n---===---");
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
