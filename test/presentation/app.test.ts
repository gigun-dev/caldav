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
import { ConcurrencyConflictError, type CollectionUnitOfWork } from "../../src/application/ports";
import { CalendarCollection, CalendarObjectResource, collectionId, principalPath, resourceUri } from "../../src/domain/caldav";
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
	// R-7: ConcurrencyConflictError → 412 マッピング
	// -------------------------------------------------------------------------
	//
	// 【D1 の実 CAS 競合検知ではなく「投げられたら 412 になる」ことだけを検証する理由】
	// D1CollectionUnitOfWork の CAS 本体(baseline が古いときに実際に検知する挙動)は
	// test/worker/cas-concurrency.test.ts が実 D1 で決定的に検証している(bun test には D1 が
	// 無いため再現できない — 同ファイル冒頭コメント参照)。ここで確認したいのはそれとは別の
	// 関心事: 「ConcurrencyConflictError という型が throw されたとき、presentation 層
	// (app.ts の errorResponse)が正しく 412 Precondition Failed を返すか」という、D1 の実挙動
	// に依存しない純粋なマッピングロジックの話。そのため「常に ConcurrencyConflictError を
	// throw する UoW」を注入し、決定的に(D1 の実タイミングに一切依存せず)検証する
	// (この2ファイルで「検知」と「マッピング」の関心事を分離した設計判断は
	// cas-concurrency.test.ts のコメントにも書いた)。
	describe("R-7: ConcurrencyConflictError → 412 マッピング", () => {
		beforeEach(async () => {
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
			// DELETE は「削除対象が実在すること」を uow に到達する前に findByUri で確認する
			// (delete-calendar-object.ts の existing チェック — 見つからなければ 404 になり、
			// 今回検証したい 412 マッピングまで到達しない)。UoW を差し替える前にリソースを直接
			// resources ストアへ置いておく(uow を経由すると差し替え後の常時 throw に引っかかる
			// ため、resources.seed で直接置く)。
			await harness.repos.resources.seed(
				OWNER,
				CALENDAR,
				await CalendarObjectResource.fromIcs(resourceUri("conflict.ics"), makeVEventIcs("uid-conflict")),
			);
			// このブロックだけ、常に ConcurrencyConflictError を throw する UoW に差し替える
			// (フェイクの CAS 実装〈FakeCollectionUnitOfWork〉ではなく、あえて
			// 呼び出しがあったことを確認するためのミニマルな実装を直書きする — このテストの
			// 関心は「UoW が競合を検知するロジック」ではなく「投げられた後のマッピング」のみ
			// なので、fakes.ts の CAS 実装を再利用せず単純化する)。
			const alwaysConflictingUow: CollectionUnitOfWork = {
				saveResource: async () => {
					throw new ConcurrencyConflictError(OWNER, CALENDAR);
				},
				deleteResource: async () => {
					throw new ConcurrencyConflictError(OWNER, CALENDAR);
				},
			};
			// harness.repos.uow の静的型は makeRepos() の推論結果(具象 FakeCollectionUnitOfWork)
			// になっているため、ポート型(CollectionUnitOfWork)の別実装をそのまま代入すると
			// 「具象クラス固有のプロパティが無い」という的外れな型エラーになる。テストの意図は
			// 「呼び出し側(app.ts)はポート型にしか依存しない」ことの確認そのものなので、
			// ここではポート型として narrow して代入する(型を偽るのではなく、
			// 本来の依存境界〈presentation はポートにしか依存しない〉に沿わせるための cast)。
			(harness.repos as { uow: CollectionUnitOfWork }).uow = alwaysConflictingUow;
		});

		const RES = `/dav/calendars/${USERNAME}/calendar/conflict.ics`;

		it("PUT(unconditional)でも UoW が競合を検知すれば 412 になる(If-Match 無しでも競合検知は効く)", async () => {
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-conflict"),
			});
			// 【unconditional でも 412 にする設計を固定する】タスク仕様の「素の 412 で実装する」
			// (If-Match を送らない unconditional PUT にも競合時 412)判断をここで固定する。
			// ETagConditionError 系の 412(既存テスト)は「クライアントの申告と現在の ETag が
			// 食い違う」場合だが、ConcurrencyConflictError は「クライアントの申告に関わらず、
			// サーバー側で検知した書き込み競合」なので、条件節の有無を問わず常に 412 になるのが
			// 正しい(put-preconditions R1〜R7 とも同じ 412 マッピング先に揃える)。
			expect(res.status).toBe(412);
		});

		it("DELETE でも UoW が競合を検知すれば 412 になる", async () => {
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: { authorization: authHeader() },
			});
			expect(res.status).toBe(412);
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

	// -------------------------------------------------------------------------
	// R-3: RFC 6578 §5 MUST — `If` ヘッダ内の DAV:sync-token を PUT/DELETE の
	// precondition として評価する。
	// -------------------------------------------------------------------------
	// 検証根拠: docs/rfc/rfc6578.txt §5 「Servers MUST support use of DAV:sync-token
	// values in If request headers」。§5.1/§5.2 の例(`If: </collection/> (<token-uri>)`)を
	// PUT/DELETE の両方で再現する。トークンは実装内部の URI 形式(SyncToken.toUri。
	// {base}/ns/sync/{n})を「クライアントが sync-collection REPORT で受け取った不透明値を
	// そのまま送り返す」体で使う — REPORT で実際に発行された値を使うことで、presentation 層の
	// base 組み立て(`new URL(collectionHref, publicOrigin).href`)が sync-collection REPORT
	// 側と一致していることも合わせて検証できる。
	describe("R-3 If ヘッダの DAV:sync-token precondition(RFC 6578 §5)", () => {
		const COLLECTION_PATH = `/dav/calendars/${USERNAME}/calendar/`;
		const RES = `${COLLECTION_PATH}r3.ics`;

		beforeEach(() => {
			harness.repos.collections.seed(
				new CalendarCollection({ id: CALENDAR, owner: OWNER, displayName: "Calendar" }),
			);
		});

		/** sync-collection REPORT(初回同期)を叩いて現在の DAV:sync-token URI を取得する。 */
		async function currentSyncToken(): Promise<string> {
			const res = await fetchApp(COLLECTION_PATH, {
				method: "REPORT",
				headers: { authorization: authHeader(), depth: "0" },
				body: `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>`,
			});
			expect(res.status).toBe(207);
			const xml = await res.text();
			const match = xml.match(/<d:sync-token>([^<]+)<\/d:sync-token>/);
			expect(match).not.toBeNull();
			return (match as RegExpMatchArray)[1];
		}

		it("(a) 現在の sync-token を If ヘッダに付けた PUT は成功する", async () => {
			const token = await currentSyncToken();
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					// RFC 6578 §5.1 の Resource_Tag 構文: コレクション href を Resource-Tag とし、
					// State-token に sync-token URI を入れる。
					if: `<${COLLECTION_PATH}> (<${token}>)`,
				},
				body: makeVEventIcs("uid-r3-a"),
			});
			expect(res.status).toBe(201);
		});

		it("(b) 古い sync-token(コレクションに別の変更が入った後)を If ヘッダに付けた PUT は 412", async () => {
			const staleToken = await currentSyncToken();
			// staleToken 取得後にコレクションへ別の変更を1件入れ、sync-token を進める
			// (RFC 6578 §5.2 の例と同じ「間に他の変更が起きた」ケース)。
			await fetchApp(`${COLLECTION_PATH}other.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-other"),
			});

			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					if: `<${COLLECTION_PATH}> (<${staleToken}>)`,
				},
				body: makeVEventIcs("uid-r3-b"),
			});
			expect(res.status).toBe(412);
		});

		it("(c) Not 構文 — 古い(現在ではない)token を Not で否定すれば通る", async () => {
			const staleToken = await currentSyncToken();
			await fetchApp(`${COLLECTION_PATH}other2.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-other2"),
			});
			// staleToken はもう現在の token ではない。"Not <staleToken>" は
			// 「staleToken に一致しないこと」が条件になり、現在は一致しないので条件は真。
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					if: `<${COLLECTION_PATH}> (Not <${staleToken}>)`,
				},
				body: makeVEventIcs("uid-r3-c"),
			});
			expect(res.status).toBe(201);
		});

		it("(c') Not 構文 — 現在の token を Not で否定すると 412", async () => {
			const token = await currentSyncToken();
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					if: `<${COLLECTION_PATH}> (Not <${token}>)`,
				},
				body: makeVEventIcs("uid-r3-cprime"),
			});
			expect(res.status).toBe(412);
		});

		it("(d) If ヘッダ無しの PUT は従来どおり無条件で成功する", async () => {
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-d"),
			});
			expect(res.status).toBe(201);
		});

		it("古い sync-token を If ヘッダに付けた DELETE も同様に 412", async () => {
			await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-delete"),
			});
			const staleToken = await currentSyncToken();
			await fetchApp(`${COLLECTION_PATH}other3.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-other3"),
			});

			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: {
					authorization: authHeader(),
					if: `<${COLLECTION_PATH}> (<${staleToken}>)`,
				},
			});
			expect(res.status).toBe(412);
		});

		it("現在の sync-token を If ヘッダに付けた DELETE は成功する", async () => {
			await fetchApp(RES, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-delete-ok"),
			});
			const token = await currentSyncToken();
			const res = await fetchApp(RES, {
				method: "DELETE",
				headers: {
					authorization: authHeader(),
					if: `<${COLLECTION_PATH}> (<${token}>)`,
				},
			});
			expect(res.status).toBe(204);
		});

		it("未対応構文(entity-tag 混在)の If ヘッダは黙殺され、無条件で処理が進む", async () => {
			// 冒頭コメント(if-header.ts)の「未対応構文の扱い」判断の回帰確認。
			// このヘッダは古い sync-token を含むが entity-tag が混在しており解釈できないため、
			// sync-token precondition は評価されず(412 にならず)処理が進む。
			const staleToken = await currentSyncToken();
			await fetchApp(`${COLLECTION_PATH}other4.ics`, {
				method: "PUT",
				headers: { authorization: authHeader(), "content-type": "text/calendar" },
				body: makeVEventIcs("uid-r3-other4"),
			});
			const res = await fetchApp(RES, {
				method: "PUT",
				headers: {
					authorization: authHeader(),
					"content-type": "text/calendar",
					if: `<${COLLECTION_PATH}> (<${staleToken}> ["some-etag"])`,
				},
				body: makeVEventIcs("uid-r3-unsupported"),
			});
			expect(res.status).toBe(201);
		});
	});
});
