// =============================================================================
// Worker エントリポイント(src/index.ts)の統合テスト
// =============================================================================
// app.fetch を丸ごと exercise する。bun test 環境には workerd/D1 が無いため、
// __setRepositoriesFactoryForTest でインメモリ Fake を注入して DB を差し替える。
//
// 2026-07-10 レビュー対応で追加:
//   - P1-1: 探索フェーズ以外(GET など)のホットパスで provision が呼ばれないこと
//   - P1-3: multiget にコレクション外 href を混ぜると 404 <response> になること
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app, { __setRepositoriesFactoryForTest } from "../../src/index";
import { CalendarCollection, collectionId, principalPath } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
	makeVEventIcs,
} from "../application/fakes";

const USERNAME = "test";
const PASSWORD = "secret";
// app が使うオーナー = principalPath(principalHref(username))。
const OWNER = principalPath(`/dav/principals/${USERNAME}/`);
const CALENDAR = collectionId("calendar");

// テスト用の env。DB は Fake を注入するので実体は使わないが、型を満たすためにダミーを置く。
const ENV = {
	DB: {} as unknown,
	CALDAV_USERNAME: USERNAME,
	CALDAV_PASSWORD: PASSWORD,
	PROXY_SHARED_SECRET: "",
} as unknown as CloudflareBindings;

function authHeader(): string {
	return `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`;
}

/**
 * provision(collections.save)の呼び出し回数を数えられる Fake セット。
 * save をラップしてカウンタを増やす。
 */
function makeRepos() {
	const principals = new FakePrincipalRepository();
	const collections = new FakeCalendarCollectionRepository();
	const resources = new FakeCalendarObjectResourceRepository();
	const uow = new FakeCollectionUnitOfWork(resources, collections);

	let collectionSaveCount = 0;
	const originalSave = collections.save.bind(collections);
	collections.save = async (collection: CalendarCollection) => {
		collectionSaveCount += 1;
		return originalSave(collection);
	};

	return {
		repos: { principals, collections, resources, uow },
		getCollectionSaveCount: () => collectionSaveCount,
	};
}

describe("Worker app", () => {
	let restore: () => void;
	let harness: ReturnType<typeof makeRepos>;

	beforeEach(() => {
		harness = makeRepos();
		restore = __setRepositoriesFactoryForTest(() => harness.repos);
	});

	afterEach(() => {
		restore();
	});

	async function fetchApp(path: string, init: RequestInit): Promise<Response> {
		return app.fetch(
			new Request(`https://example.com${path}`, init),
			ENV,
		);
	}

	// -------------------------------------------------------------------------
	// P1-1: provision は探索フェーズの PROPFIND だけ。ホットパスでは呼ばれない。
	// -------------------------------------------------------------------------
	describe("P1-1 provision はホットパスから除外", () => {
		it("エントリ /dav/ への PROPFIND では既定コレクションを provision する", async () => {
			const res = await fetchApp("/dav/", {
				method: "PROPFIND",
				headers: { authorization: authHeader() },
			});
			expect(res.status).toBe(207);
			// Calendar + Tasks の 2 コレクションが save される。
			expect(harness.getCollectionSaveCount()).toBe(2);
		});

		it("calendar-home-set への PROPFIND でも provision する", async () => {
			const res = await fetchApp(`/dav/calendars/${USERNAME}/`, {
				method: "PROPFIND",
				headers: { authorization: authHeader(), depth: "1" },
			});
			expect(res.status).toBe(207);
			expect(harness.getCollectionSaveCount()).toBe(2);
		});

		it("GET(ホットパス)では provision が呼ばれない", async () => {
			// 先にリソースを 1 件用意しておく。
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
			await fetchApp(`/dav/calendars/${USERNAME}/calendar/a.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-a"),
			});
			const beforeGet = harness.getCollectionSaveCount();

			const res = await fetchApp(`/dav/calendars/${USERNAME}/calendar/a.ics`, {
				method: "GET",
				headers: { authorization: authHeader() },
			});
			expect(res.status).toBe(200);
			// GET は provision の save を 1 回も追加していない。
			expect(harness.getCollectionSaveCount()).toBe(beforeGet);
		});
	});

	// -------------------------------------------------------------------------
	// P1-3: multiget のコレクション外 href は 404 <response> にする。
	// -------------------------------------------------------------------------
	describe("P1-3 multiget のコレクション外 href", () => {
		beforeEach(async () => {
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
			await fetchApp(`/dav/calendars/${USERNAME}/calendar/a.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-a"),
			});
		});

		it("コレクション外 href を混ぜると当該 href が 404 になり、正当な href は 200 になる", async () => {
			const body = `<?xml version="1.0"?>
			<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
				<d:prop><d:getetag/><c:calendar-data/></d:prop>
				<d:href>/dav/calendars/${USERNAME}/calendar/a.ics</d:href>
				<d:href>/dav/calendars/${USERNAME}/other/b.ics</d:href>
				<d:href>/dav/calendars/${USERNAME}/calendar/</d:href>
			</c:calendar-multiget>`;
			const res = await fetchApp(`/dav/calendars/${USERNAME}/calendar/`, {
				method: "REPORT",
				headers: { authorization: authHeader() },
				body,
			});
			expect(res.status).toBe(207);
			const xml = await res.text();

			// 正当な a.ics は 200(calendar-data 入り)。
			expect(xml).toContain(`/dav/calendars/${USERNAME}/calendar/a.ics`);
			expect(xml).toContain("uid-a");
			// 別コレクション配下の href はそのまま 404 <response> で返る。
			expect(xml).toContain(`<d:href>/dav/calendars/${USERNAME}/other/b.ics</d:href>`);
			// コレクション自身の href(末尾 /)も 404 になる(空文字 URI で誤ヒットしない)。
			expect(xml).toContain(`<d:href>/dav/calendars/${USERNAME}/calendar/</d:href>`);
			// 404 <response> が 2 件ある。
			const notFoundCount = (xml.match(/404 Not Found/g) ?? []).length;
			expect(notFoundCount).toBe(2);
		});
	});
});
