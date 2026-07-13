// =============================================================================
// DAV アプリ本体(src/app.ts)の統合テスト
// =============================================================================
// 2026-07-12 OAuth-for-MCP 第2スライス・物理分離: 以前は src/index.ts から
// honoApp を import していたが、honoApp(および周辺の helper・mcpApiApp・
// resolveExternalTokenForMcp)は provider 非依存の src/app.ts に切り出した。
// src/index.ts は OAuthProvider を静的 import して default export するだけの
// 薄いファイルになったため、DAV の挙動だけを見たいこのテストは src/app.ts を
// 直接 import する(provider の KV 依存を bun test に持ち込まないため)。
// app.fetch を丸ごと exercise する。bun test 環境には workerd/D1 が無いため、
// __setRepositoriesFactoryForTest でインメモリ Fake を注入して DB を差し替える。
//
// 2026-07-10 レビュー対応で追加:
//   - P1-1: 探索フェーズ以外(GET など)のホットパスで provision が呼ばれないこと
//   - P1-3: multiget にコレクション外 href を混ぜると 404 <response> になること
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app, __setRepositoriesFactoryForTest } from "../../src/app";
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

	// -------------------------------------------------------------------------
	// M1: ETag 条件不一致は HTTP 412 で返す(403 では返さない)。
	// -------------------------------------------------------------------------
	// 【なぜ HTTP 層で担保するのか】
	// application 層のテスト(put/delete-calendar-object.test.ts)は
	// ETagConditionError / DeleteETagMismatchError という「エラー型」までは検証済み。
	// だが M1 の教訓の核心は "エラー型 → HTTP ステータスへのマッピング" にある:
	//   前作は ETag 不一致を 403 Forbidden で返していた。iOS は 412 なら
	//   「サーバーの最新 ETag を取り直して再 PUT」で自動回復するが、403 だと
	//   恒久的拒否と解釈して同期が固まり、ユーザーが手動でしか復旧できなかった
	//   (docs/modeling/06 の教訓)。
	// よって errorResponse(src/index.ts:112)の 412 マッピングが将来 403 等に
	// 退行しないことを app.fetch 経由の end-to-end で固定する。
	// 各ケースで status === 412 を確認し、かつ status !== 403 を明示アサートして
	// 「前作の退行」をピンポイントで検知する。
	describe("M1 ETag 条件不一致は 412(403 ではない)", () => {
		beforeEach(() => {
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
		});

		const RES = `/dav/calendars/${USERNAME}/calendar/e.ics`;

		// 既存リソースを作り、その ETag ヘッダ(引用符付き)を返すヘルパ。
		async function seedResource(): Promise<string> {
			const put = await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-e"),
			});
			expect(put.status).toBe(201);
			const etag = put.headers.get("etag");
			expect(etag).not.toBeNull();
			return etag as string;
		}

		it("PUT If-None-Match:* — 既存リソースには 412(403 でない)", async () => {
			await seedResource();
			// 同一 URI に If-None-Match:* で再 PUT → 既に存在するので 412。
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-none-match": "*",
				},
				body: makeVEventIcs("uid-e"),
			});
			expect(res.status).toBe(412);
			expect(res.status).not.toBe(403);
		});

		it("PUT If-Match — ETag 不一致は 412(403 でない)", async () => {
			await seedResource();
			// 現在の ETag と絶対に一致しないダミー ETag(64桁ゼロ = 引用符付き)。
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-match": `"${"0".repeat(64)}"`,
				},
				body: makeVEventIcs("uid-e"),
			});
			expect(res.status).toBe(412);
			expect(res.status).not.toBe(403);
		});

		it("PUT If-Match — ETag 一致なら 204 で更新できる(回復ルートの成立確認)", async () => {
			const etag = await seedResource();
			// 412 を受けたクライアントが最新 ETag を取り直して再 PUT する回復シナリオ。
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-match": etag,
				},
				body: makeVEventIcs("uid-e"),
			});
			expect(res.status).toBe(204);
		});

		it("DELETE If-Match — ETag 不一致は 412(403 でない)", async () => {
			await seedResource();
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: {
					authorization: authHeader(),
					"if-match": `"${"0".repeat(64)}"`,
				},
			});
			expect(res.status).toBe(412);
			expect(res.status).not.toBe(403);
		});

		it("DELETE If-Match — ETag 一致なら 204 で削除できる", async () => {
			const etag = await seedResource();
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: { authorization: authHeader(), "if-match": etag },
			});
			expect(res.status).toBe(204);
		});
	});

	// -------------------------------------------------------------------------
	// R-2: RFC 7232 §3.1 の条件付きリクエスト是正
	//   - If-Match: * は「存在すること」だけが条件(ETag 値比較ではない)。
	//     以前は "*" を hex として ETag.fromHex に渡していたため:
	//       PUT: 例外が catch されず 500(errorResponse の未捕捉 → Internal Server Error)。
	//       DELETE: 不正 hex として catch され誤って 412(existing が既にある = 本来は通るべき)。
	//     どちらも RFC 7232 §3.1 の「リソースが存在すれば通す」に反する退行だった。
	//   - If-Match のカンマ区切り複数 ETag(§3.1 ABNF 1#entity-tag)対応。
	// -------------------------------------------------------------------------
	describe("R-2 If-Match: * とカンマ区切り複数 ETag(RFC 7232 §3.1)", () => {
		beforeEach(() => {
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
		});

		const RES = `/dav/calendars/${USERNAME}/calendar/r2.ics`;

		async function seedResource(): Promise<string> {
			const put = await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r2"),
			});
			expect(put.status).toBe(201);
			const etag = put.headers.get("etag");
			expect(etag).not.toBeNull();
			return etag as string;
		}

		it("PUT If-Match: * — リソースが存在すれば 500 にならず 204 で成立する", async () => {
			await seedResource();
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-match": "*",
				},
				body: makeVEventIcs("uid-r2"),
			});
			expect(res.status).toBe(204);
		});

		it("PUT If-Match: * — リソースが存在しなければ 412(500 でも 404 でもない)", async () => {
			// r2.ics はまだ作っていない状態で If-Match: * を送る。
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-match": "*",
				},
				body: makeVEventIcs("uid-r2"),
			});
			expect(res.status).toBe(412);
		});

		it("DELETE If-Match: * — リソースが存在すれば 204(412 に誤爆しない)", async () => {
			await seedResource();
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: { authorization: authHeader(), "if-match": "*" },
			});
			expect(res.status).toBe(204);
		});

		it("PUT If-Match のカンマ区切りリスト — 現在の ETag を含んでいれば一致成立(204)", async () => {
			const etag = await seedResource();
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					// 現在の ETag をリストの2番目に混ぜる。RFC 7232 §3.1「いずれか一致すれば成立」。
					"if-match": `"${"0".repeat(64)}", ${etag}`,
				},
				body: makeVEventIcs("uid-r2"),
			});
			expect(res.status).toBe(204);
		});

		it("PUT If-Match のカンマ区切りリスト — どれとも一致しなければ 412", async () => {
			await seedResource();
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					"if-match": `"${"0".repeat(64)}", "${"1".repeat(64)}"`,
				},
				body: makeVEventIcs("uid-r2"),
			});
			expect(res.status).toBe(412);
		});

		it("DELETE If-Match のカンマ区切りリスト — 現在の ETag を含んでいれば一致成立(204)", async () => {
			const etag = await seedResource();
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: {
					authorization: authHeader(),
					"if-match": `"${"0".repeat(64)}", ${etag}`,
				},
			});
			expect(res.status).toBe(204);
		});
	});
});
