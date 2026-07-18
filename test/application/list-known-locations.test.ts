// =============================================================================
// ListKnownLocations ユースケース テスト(C5・設計 05 §3・§5・§6)
// =============================================================================
// 実データ形(設計 05 §1-a/§1-b)の VEVENT(LOCATION の structured-location)/ VTODO(proximity
// VALARM の structured-location)を種として、distinct 集約 + recency 順を検証する。
// CreateEvent/CreateTodo(structuredLocation を書く API を持たない create-todo 側)は使わず、
// C1 の read テストと同じく生 ICS を直接フェイクへ seed する(proximity VALARM の write は
// このタスクのスコープ外 — 設計 05 §6 C8 コメント参照)。
import { describe, expect, it } from "bun:test";
import { CalendarObjectResource, collectionId as mkCollectionId, resourceUri as mkResourceUri } from "../../src/domain/caldav";
import { ListKnownLocations } from "../../src/application/usecases";
import { FakeCalendarCollectionRepository, FakeCalendarObjectResourceRepository, TEST_OWNER, makeTestCollection } from "./fakes";

// VCALENDAR 1枚 + 単一コンポーネントの生 ICS を組む(structured-location.test.ts の firstChild と
// 同じ発想だが、ここでは CalendarObjectResource.fromIcs に渡すフル ICS 文字列が要る)。
function ics(kind: "VEVENT" | "VTODO", lines: string[]): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", `BEGIN:${kind}`, ...lines, `END:${kind}`, "END:VCALENDAR"].join(
		"\r\n",
	);
}

async function seedEvent(
	resourceRepo: FakeCalendarObjectResourceRepository,
	collectionId: string,
	uid: string,
	lastModified: string,
	locationLines: string[],
): Promise<void> {
	const resource = await CalendarObjectResource.fromIcs(
		mkResourceUri(`${uid}.ics`),
		ics("VEVENT", [
			`UID:${uid}`,
			`DTSTAMP:${lastModified}`,
			`LAST-MODIFIED:${lastModified}`,
			"DTSTART:20260718T010000Z",
			`SUMMARY:${uid}`,
			...locationLines,
		]),
	);
	resourceRepo.seed(TEST_OWNER, mkCollectionId(collectionId), resource);
}

async function seedProximityTodo(
	resourceRepo: FakeCalendarObjectResourceRepository,
	collectionId: string,
	uid: string,
	lastModified: string,
	proximityLines: string[],
): Promise<void> {
	const resource = await CalendarObjectResource.fromIcs(
		mkResourceUri(`${uid}.ics`),
		ics("VTODO", [
			`UID:${uid}`,
			`DTSTAMP:${lastModified}`,
			`LAST-MODIFIED:${lastModified}`,
			`SUMMARY:${uid}`,
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
			...proximityLines,
			"END:VALARM",
		]),
	);
	resourceRepo.seed(TEST_OWNER, mkCollectionId(collectionId), resource);
}

describe("ListKnownLocations", () => {
	function setup() {
		const collectionRepo = new FakeCalendarCollectionRepository();
		const resourceRepo = new FakeCalendarObjectResourceRepository();
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "calendar", { supportedComponents: ["VEVENT"] }));
		collectionRepo.seed(makeTestCollection(TEST_OWNER, "tasks", { supportedComponents: ["VTODO"] }));
		const uc = new ListKnownLocations(collectionRepo, resourceRepo);
		return { collectionRepo, resourceRepo, uc };
	}

	it("VEVENT の structured-location(§1-b)を集約する", async () => {
		const { resourceRepo, uc } = setup();
		await seedEvent(resourceRepo, "calendar", "e-gifu", "20260717T000000Z", [
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE=岐阜大学:geo:35.463012,136.737202",
		]);
		const { locations } = await uc.execute({ owner: TEST_OWNER });
		expect(locations).toEqual([{ title: "岐阜大学", address: null, lat: 35.463012, lon: 136.737202, radius: 100 }]);
	});

	it("VTODO の proximity VALARM(自宅到着・§1-a)から場所を集約する(全コレクション横断が既定)", async () => {
		const { resourceRepo, uc } = setup();
		await seedProximityTodo(resourceRepo, "tasks", "t-home", "20260717T000000Z", [
			"X-APPLE-PROXIMITY:ARRIVE",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE=福登の自宅:geo:35.017639,136.954547",
		]);
		const { locations } = await uc.execute({ owner: TEST_OWNER });
		expect(locations).toEqual([{ title: "福登の自宅", address: null, lat: 35.017639, lon: 136.954547, radius: 100 }]);
	});

	it("同じ title+座標は1件に dedup し、最近使った順(recency)で並ぶ", async () => {
		const { resourceRepo, uc } = setup();
		// 岐阜大学を2回使用(古い方が先。新しい方の LAST-MODIFIED が勝つ)。福登の自宅は1回のみで
		// より新しい recencyKey を持たせ、先頭に来ることを確認する。
		await seedEvent(resourceRepo, "calendar", "e1", "20260701T000000Z", [
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=岐阜大学:geo:35.463012,136.737202",
		]);
		await seedProximityTodo(resourceRepo, "tasks", "t1", "20260717T120000Z", [
			"X-APPLE-PROXIMITY:ARRIVE",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=福登の自宅:geo:35.017639,136.954547",
		]);
		await seedEvent(resourceRepo, "calendar", "e2", "20260710T000000Z", [
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=岐阜大学:geo:35.463012,136.737202",
		]);

		const { locations } = await uc.execute({ owner: TEST_OWNER });
		expect(locations.map((l) => l.title)).toEqual(["福登の自宅", "岐阜大学"]);
		expect(locations).toHaveLength(2); // 岐阜大学は1件に畳まれる。
	});

	it("calendarId 指定時はそのコレクションだけを走査する", async () => {
		const { resourceRepo, uc } = setup();
		await seedEvent(resourceRepo, "calendar", "e1", "20260717T000000Z", [
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=岐阜大学:geo:35.463012,136.737202",
		]);
		await seedProximityTodo(resourceRepo, "tasks", "t1", "20260717T000000Z", [
			"X-APPLE-PROXIMITY:ARRIVE",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=福登の自宅:geo:35.017639,136.954547",
		]);
		const { locations } = await uc.execute({ owner: TEST_OWNER, calendarId: "calendar" });
		expect(locations.map((l) => l.title)).toEqual(["岐阜大学"]);
	});

	it("座標無し(geo:null)やタイトル無しの structured-location は候補にしない(壊れ値は選べない)", async () => {
		const { resourceRepo, uc } = setup();
		await seedEvent(resourceRepo, "calendar", "e-broken", "20260717T000000Z", [
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=どこか:not-a-geo-uri",
		]);
		const { locations } = await uc.execute({ owner: TEST_OWNER });
		expect(locations).toEqual([]);
	});

	it("recencyKey が両方欠落(LAST-MODIFIED/DTSTAMP 無し)で同点でも uid tie-break で決定的に並ぶ(F)", async () => {
		// RFC 5545 上 DTSTAMP は必須プロパティなので実データではほぼ起こらないが、非準拠データで
		// recencyKey が空文字同士になっても dedup/並びが走査順に依存して不定にならないことを保証する。
		const { resourceRepo, uc } = setup();
		const withoutTimestamp = async (uid: string, lines: string[]) => {
			const resource = await CalendarObjectResource.fromIcs(
				mkResourceUri(`${uid}.ics`),
				ics("VEVENT", [`UID:${uid}`, "DTSTART:20260718T010000Z", `SUMMARY:${uid}`, ...lines]),
			);
			resourceRepo.seed(TEST_OWNER, mkCollectionId("calendar"), resource);
		};
		// uid の辞書式順序をあえて登録順と逆にして、recencyKey ではなく uid で決着している
		// (単なる走査順の偶然ではない)ことを確認する。
		await withoutTimestamp("z-later-uid", ["X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=名古屋駅:geo:35.170915,136.881537"]);
		await withoutTimestamp("a-earlier-uid", ["X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=岐阜駅:geo:35.412221,136.756215"]);

		const { locations } = await uc.execute({ owner: TEST_OWNER, calendarId: "calendar" });
		// compareCandidate は同点(recencyKey="")時に uid 昇順を「先」とするので、"a-earlier-uid" 由来の
		// 岐阜駅が先頭に来る。実行を複数回しても常に同じ順序になる(=決定的)ことが本テストの主眼。
		expect(locations.map((l) => l.title)).toEqual(["岐阜駅", "名古屋駅"]);
	});

	it("構造化場所が無いイベント/タスクだけの場合は空配列", async () => {
		const { resourceRepo, uc } = setup();
		await seedEvent(resourceRepo, "calendar", "e-plain", "20260717T000000Z", ["LOCATION:ただのテキスト場所"]);
		const { locations } = await uc.execute({ owner: TEST_OWNER });
		expect(locations).toEqual([]);
	});
});
