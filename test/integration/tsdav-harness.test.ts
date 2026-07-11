// =============================================================================
// tsdav 互換性ハーネス(タスク C)
// =============================================================================
//
// 【目的】
// tsdav(実運用されている JS の CalDAV クライアントライブラリ)を「本物のクライアント」
// として使い、探索 → コレクション作成 → オブジェクト作成 → calendar-query(RRULE 展開)
// → sync-collection(RFC 6578)→ 削除 → (可能なら)free-busy-query、という一連の
// CalDAV フローが破綻していないかを bun test / make check の中で自動検知する。
// iOS 実機が無いセッションでも「意味計算(time-range 展開・free-busy)+ 既存 DAV 面」の
// 回帰を早期に拾うためのセーフティネット。
//
// 【スコープ外(重要)】
// これは「アプリ/プロトコルロジックの回帰検知」であり、「workerd 実行時トランスポートの
// 癖」の検証ではない。本番の iOS 入口が Cloud Run 書き換えプロキシ経由である理由は
// 「workerd が MKCALENDAR という任意メソッドを受け付けられない」という workerd 固有の
// 制約であって(docs/modeling/07 §4)、アプリのロジック自体が MKCALENDAR を扱えないわけ
// ではない。このハーネスは Bun.serve(= Node/Bun の HTTP サーバー実装で、任意メソッドを
// 受け付けられる)で src/index.ts の Hono app をラップして立てるため、MKCALENDAR も含めて
// プロキシ無しで検証できる。つまり:
//   - workerd の MKCALENDAR 501(トランスポートの癖)→ このハーネスの対象外。
//     本番プロキシ + scripts/smoke-test.ts の責務。
//   - calendar-query の time-range 展開・free-busy 計算・sync-collection の差分計算
//     などの「ロジック」→ このハーネスの対象。
//
// 【なぜ Bun.serve か(カスタム fetch 注入ではなく)】
// tsdav の createDAVClient は `fetch` オプションでカスタム fetch 関数を注入できる
// (node_modules/tsdav/dist/client.d.ts で確認済み)。理屈の上では app.fetch を直接
// 渡せば HTTP サーバーを起動せずに済むが、tsdav 内部の各操作(login / fetchCalendars /
// createCalendarObject 等)がどこまで一貫して注入した fetch を使うか、リダイレクト
// (.well-known/caldav の 301)を injected fetch 越しに正しく辿れるかは .d.ts だけでは
// 保証できない。確実性を優先し、実際に Bun.serve でエフェメラルポートに立てた本物の
// HTTP サーバーへ tsdav を向ける(設計で明示的に指定された方式)。
//
// 【fake repo 注入】
// 実 D1/workerd 無しでハーメティックに回すため、既存の __setRepositoriesFactoryForTest
// (test/presentation/app.test.ts と同じ流儀)で test/application/fakes のインメモリ
// repo を注入する。
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDAVClient } from "tsdav";
import app, { __setRepositoriesFactoryForTest } from "../../src/index";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
} from "../application/fakes";

const USERNAME = "tsdav-user";
const PASSWORD = "tsdav-secret";

// テスト用 env。DB は Fake を注入するので実体は使わない(app.test.ts と同じダミー方針)。
const ENV = {
	DB: {} as unknown,
	CALDAV_USERNAME: USERNAME,
	CALDAV_PASSWORD: PASSWORD,
	PROXY_SHARED_SECRET: "",
} as unknown as CloudflareBindings;

describe("tsdav 互換性ハーネス", () => {
	let server: ReturnType<typeof Bun.serve>;
	let serverUrl: string;
	let restoreRepos: () => void;

	beforeAll(() => {
		// fake repo を注入(app.test.ts と同じ流儀)。このスイート全体で共有する
		// 1組のインメモリストアに対して、探索 → 作成 → クエリ → 同期 → 削除を通しで行う。
		const principals = new FakePrincipalRepository();
		const collections = new FakeCalendarCollectionRepository();
		const resources = new FakeCalendarObjectResourceRepository();
		const uow = new FakeCollectionUnitOfWork(resources, collections);
		restoreRepos = __setRepositoriesFactoryForTest(() => ({ principals, collections, resources, uow }));

		// Bun.serve で app.fetch をラップしたエフェメラルポートのサーバーを立てる。
		// port: 0 で OS に空きポートを選ばせる(CI 環境でのポート衝突を避ける)。
		// 第2引数の env は Hono の Bindings。ctx(executionCtx)は今回のフローでは
		// 使われない(waitUntil を要する処理が無い)ので省略している。
		server = Bun.serve({
			port: 0,
			fetch: (request) => app.fetch(request, ENV),
		});
		serverUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		// テスト後に必ず stop する(設計指定)。他スイートへポート/プロセスを残さない。
		server.stop(true);
		restoreRepos();
	});

	// -------------------------------------------------------------------------
	// 1. 探索: ログイン → principal / calendar-home / カレンダー一覧取得。
	//    app は探索時(entry / principal / calendar-home-set への PROPFIND)に
	//    既定コレクション(calendar[VEVENT] / tasks[VTODO])を provision するので、
	//    それらが fetchCalendars で見えるはず。
	// -------------------------------------------------------------------------
	it("探索: ログインして既定の calendar / tasks コレクションが見える", async () => {
		const client = await createDAVClient({
			serverUrl,
			credentials: { username: USERNAME, password: PASSWORD },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});
		// createDAVClient に defaultAccountType を渡すと、内部の createAccount が
		// serviceDiscovery(.well-known/caldav)→ principal → calendar-home-set の
		// 順に辿ってアカウントを初期化する(tsdav.js の createDAVClient 実装で確認済み。
		// DAVClient には別途 login() インスタンスメソッドもあるが、createDAVClient
		// ファクトリ関数の戻り値には login は無く、生成時点で探索が完了している)。
		// app 側は .well-known/caldav を /dav/ へ 301 リダイレクトするので、
		// fetch のリダイレクト追従が効いていることも同時に確認できる。
		const calendars = await client.fetchCalendars();
		const displayNames = calendars.map((c) => c.displayName);
		expect(displayNames).toContain("Calendar");
		expect(displayNames).toContain("Tasks");
	});

	// -------------------------------------------------------------------------
	// 2〜5 は 1 個のクライアント/カレンダーを使い回して通しで検証する
	// (探索 → 作成 → calendar-query → sync → 削除の順序に意味があるため)。
	// -------------------------------------------------------------------------
	it("作成・calendar-query(RRULE 展開)・sync-collection・削除の一連のフロー", async () => {
		const client = await createDAVClient({
			serverUrl,
			credentials: { username: USERNAME, password: PASSWORD },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});

		const calendars = await client.fetchCalendars();
		const calendar = calendars.find((c) => c.displayName === "Calendar");
		expect(calendar).toBeDefined();
		if (!calendar) throw new Error("unreachable: asserted above");

		// --- 2. オブジェクト作成 + 取得 ---
		const uid = "tsdav-harness-single-001";
		const singleEventIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260710T100000Z",
			"DTEND:20260710T110000Z",
			"SUMMARY:tsdav harness single event",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const createRes = await client.createCalendarObject({
			calendar,
			iCalString: singleEventIcs,
			filename: `${uid}.ics`,
		});
		expect(createRes.ok).toBe(true);
		// ETag が返ること(PUT の応答ヘッダ。RFC 4791 §5.3.4 相当)。
		expect(createRes.headers.get("etag")).toBeTruthy();

		const afterCreate = await client.fetchCalendarObjects({ calendar });
		expect(afterCreate.some((o) => o.url.endsWith(`${uid}.ics`))).toBe(true);
		// fetchCalendarObjects 経由でも ETag が乗っていること。
		const createdObject = afterCreate.find((o) => o.url.endsWith(`${uid}.ics`));
		expect(createdObject?.etag).toBeTruthy();

		// --- 3. calendar-query(G-3 の要): RRULE 付き VEVENT の time-range 展開 ---
		// 毎週金曜 10:00-11:00(JST 相当は考えず UTC 固定。展開ロジックの確認が目的なので
		// タイムゾーン処理そのものは別テストの責務)。COUNT=4 で 2026-07-10, 17, 24, 31 の
		// 4回発生する。
		const rruleUid = "tsdav-harness-rrule-001";
		const rruleEventIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VEVENT",
			`UID:${rruleUid}`,
			"DTSTAMP:20260101T000000Z",
			"DTSTART:20260710T100000Z",
			"DTEND:20260710T110000Z",
			"RRULE:FREQ=WEEKLY;COUNT=4",
			"SUMMARY:tsdav harness rrule event",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const rruleCreateRes = await client.createCalendarObject({
			calendar,
			iCalString: rruleEventIcs,
			filename: `${rruleUid}.ics`,
		});
		expect(rruleCreateRes.ok).toBe(true);

		// 窓内(2回目の発生 2026-07-17 を含む区間)。展開が効いていればヒットする。
		const withinWindow = await client.fetchCalendarObjects({
			calendar,
			timeRange: { start: "2026-07-16T00:00:00Z", end: "2026-07-18T00:00:00Z" },
		});
		expect(withinWindow.some((o) => o.url.endsWith(`${rruleUid}.ics`))).toBe(true);

		// 範囲外(RRULE の最終発生 2026-07-31 より後の窓)。展開されていれば
		// ヒットしないはず — ここがヒットしてしまうと「全件返し」の仮実装に
		// 戻っている回帰を示す。
		const outsideWindow = await client.fetchCalendarObjects({
			calendar,
			timeRange: { start: "2026-08-10T00:00:00Z", end: "2026-08-17T00:00:00Z" },
		});
		expect(outsideWindow.some((o) => o.url.endsWith(`${rruleUid}.ics`))).toBe(false);

		// --- 4. 同期(RFC 6578): sync-token → オブジェクト追加後に差分が取れること ---
		const initialSync = await client.syncCollection({
			url: calendar.url,
			props: { "d:getetag": {} },
			syncLevel: 1,
		});
		// tsdav の syncCollection は DAVResponse[] を返す(multistatus の <response> 単位)。
		// sync-token はどこかの DAVResponse に載っているはずなので、多階層のプロパティ
		// パースに依存せず davRequest の生 XML から拾うのは冗長になるため、ここでは
		// 「1回目の同期が成功して sync-token 込みの応答が返る」ところまでを検証し、
		// 2回目の差分検知は davRequest で直接 REPORT を送って確定的に見る。
		expect(initialSync.length).toBeGreaterThan(0);

		// sync-token を直接取り出すため、davRequest で生の sync-collection REPORT を送る
		// (tsdav の syncCollection ラッパーは応答本文から sync-token を自動で拾わないため、
		// ここは「低レベル API で確実に見る」方針に倒す)。
		const syncBody =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<D:sync-collection xmlns:D="DAV:">' +
			"<D:sync-token></D:sync-token>" +
			"<D:sync-level>1</D:sync-level>" +
			"<D:prop><D:getetag/></D:prop>" +
			"</D:sync-collection>";
		const syncRes1 = await fetch(`${serverUrl}${new URL(calendar.url).pathname}`, {
			method: "REPORT",
			headers: {
				authorization: `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`,
				"Content-Type": "application/xml; charset=utf-8",
			},
			body: syncBody,
		});
		expect(syncRes1.status).toBe(207);
		const syncXml1 = await syncRes1.text();
		// レスポンスの XML 名前空間プレフィックスは presentation/dav/xml.ts の multistatus() が
		// 決め打ちしている "d:"(小文字)。tsdav が送るリクエストの "D:" とは独立している。
		const tokenMatch = syncXml1.match(/<d:sync-token>([^<]+)<\/d:sync-token>/);
		expect(tokenMatch).toBeTruthy();
		const syncToken = tokenMatch ? tokenMatch[1] : "";

		// 新規オブジェクトを1件追加してから同じ sync-token で差分を取ると、
		// 追加分だけが <response> に載るはず。
		const syncUid = "tsdav-harness-sync-001";
		await client.createCalendarObject({
			calendar,
			iCalString: [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VEVENT",
				`UID:${syncUid}`,
				"DTSTAMP:20260101T000000Z",
				"DTSTART:20260720T100000Z",
				"DTEND:20260720T110000Z",
				"SUMMARY:tsdav harness sync event",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			filename: `${syncUid}.ics`,
		});
		const syncBody2 =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<D:sync-collection xmlns:D="DAV:">' +
			`<D:sync-token>${syncToken}</D:sync-token>` +
			"<D:sync-level>1</D:sync-level>" +
			"<D:prop><D:getetag/></D:prop>" +
			"</D:sync-collection>";
		const syncRes2 = await fetch(`${serverUrl}${new URL(calendar.url).pathname}`, {
			method: "REPORT",
			headers: {
				authorization: `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`,
				"Content-Type": "application/xml; charset=utf-8",
			},
			body: syncBody2,
		});
		expect(syncRes2.status).toBe(207);
		const syncXml2 = await syncRes2.text();
		expect(syncXml2).toContain(syncUid);
		// 差分同期なので、今回追加していない単発イベント(uid)は載らないはず。
		expect(syncXml2).not.toContain(uid);

		// --- 5. 削除: deleteCalendarObject → 以後 fetch で消えていること ---
		expect(createdObject).toBeDefined();
		if (!createdObject) throw new Error("unreachable: asserted above");
		const deleteRes = await client.deleteCalendarObject({ calendarObject: createdObject });
		expect(deleteRes.ok).toBe(true);
		const afterDelete = await client.fetchCalendarObjects({ calendar });
		expect(afterDelete.some((o) => o.url.endsWith(`${uid}.ics`))).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 6. free-busy-query(可能であれば)。
	// tsdav には free-busy-query 専用のヘルパが無い(client.d.ts に
	// free-busy 関連のメソッドが存在しないことを確認済み)。davRequest は
	// multistatus のパースを前提にしており、free-busy-query の応答は
	// multistatus ではなく text/calendar 本文そのもの(RFC 4791 §7.10
	// Marshalling。src/index.ts のコメント参照)なので davRequest には
	// 向かない。よって素の fetch で REPORT を直接送って検証する。
	// -------------------------------------------------------------------------
	it("free-busy-query REPORT: VFREEBUSY が返る(低レベル fetch で直接検証)", async () => {
		const client = await createDAVClient({
			serverUrl,
			credentials: { username: USERNAME, password: PASSWORD },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});
		const calendars = await client.fetchCalendars();
		const calendar = calendars.find((c) => c.displayName === "Calendar");
		expect(calendar).toBeDefined();
        if (!calendar) throw new Error("unreachable: asserted above");

		// free-busy 計算対象になる VEVENT を1件作る。
		const fbUid = "tsdav-harness-freebusy-001";
		await client.createCalendarObject({
			calendar,
			iCalString: [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VEVENT",
				`UID:${fbUid}`,
				"DTSTAMP:20260101T000000Z",
				"DTSTART:20260901T090000Z",
				"DTEND:20260901T100000Z",
				"SUMMARY:tsdav harness free-busy source event",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			filename: `${fbUid}.ics`,
		});

		const freeBusyBody =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">' +
			'<C:time-range start="20260901T000000Z" end="20260902T000000Z"/>' +
			"</C:free-busy-query>";
		const fbRes = await fetch(`${serverUrl}${new URL(calendar.url).pathname}`, {
			method: "REPORT",
			headers: {
				authorization: `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`,
				"Content-Type": "application/xml; charset=utf-8",
			},
			body: freeBusyBody,
		});
		expect(fbRes.status).toBe(200);
		expect(fbRes.headers.get("content-type")).toContain("text/calendar");
		const fbBody = await fbRes.text();
		expect(fbBody).toContain("BEGIN:VFREEBUSY");
		expect(fbBody).toContain("FREEBUSY;FBTYPE=BUSY:20260901T090000Z/20260901T100000Z");
	});
});
