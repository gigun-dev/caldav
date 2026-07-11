// =============================================================================
// mcp/server — G-5 MCP 照会ツールサーバー(get-current-time / list-events-expanded / get-freebusy)
// =============================================================================
//
// 【この層の責務】
// application 層のユースケース(ListOccurrences / ComputeFreeBusy)を MCP のツールとして
// 露出する。MCP のプロトコル知識(JSON-RPC / ツールスキーマ / structuredContent)は
// ここに閉じ込め、application 層には一切漏らさない(CLAUDE.md「XML・プロトコル知識のハンドラ
// 漏れ」の反省を presentation/mcp でも同様に守る。DAV が presentation/dav/xml.ts に
// プロトコル知識を隔離するのと対称)。
//
// 【リクエストごとに McpServer/StreamableHTTPTransport を new する理由】
// Workers はリクエストごとに(コールドスタート時以外は)同一 isolate を使い回すが、
// グローバル変数へ「接続済みサーバー」を溜め込むのは Workers のベストプラクティスに反する
// (リクエスト間の状態リークの温床。@hono/mcp README のサンプルはモジュールスコープで
// mcpServer/transport を作り isConnected() で使い回しているが、それは Node 常駐サーバー
// 向けの書き方であり、Workers では「1リクエスト = 1 isolate インスタンスとは限らない」
// 前提に反する。ここでは意図的にサンプルから外れ、createMcpApp のハンドラ内で
// 毎回 new する)。認証で解決した principal をクロージャで各ツールへ束縛できる利点もある
// (グローバル化すると principal をリクエストごとに安全に切り替えられない)。
// =============================================================================

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";

import type { AuthenticationPort } from "../../application/ports";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../../application/ports";
import { ComputeFreeBusy, ListOccurrences } from "../../application/usecases";
import type { Occurrence, RecurrenceIterator } from "../../domain/ical/recurrence";
import { coalesceBusyIntervals, type BusyInterval } from "../../domain/ical/freebusy";
import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import { collectionId as mkCollectionId } from "../../domain/caldav";
import { epochToIso, formatDateOnly, isValidIanaZone, parseIsoToEpoch } from "./format";

export interface McpAppDeps {
	readonly auth: AuthenticationPort;
	readonly collectionRepo: CalendarCollectionRepository;
	readonly resourceRepo: CalendarObjectResourceRepository;
	readonly iterator: RecurrenceIterator;
}

// --- get-current-time -------------------------------------------------------

const getCurrentTimeInputShape = {
	timeZone: z.string().optional().describe('IANA タイムゾーン名(例 "Asia/Tokyo")。省略時は UTC。'),
};

// --- list-events-expanded ----------------------------------------------------

const listEventsExpandedInputShape = {
	timeMin: z.string().describe("展開範囲の開始(offset 付き ISO8601。例 2026-07-11T00:00:00+09:00 または ...Z)。"),
	timeMax: z.string().describe("展開範囲の終了(offset 付き ISO8601。必須)。"),
	timeZone: z.string().optional().describe("応答時刻の表示 + floating 値の解釈に使う IANA タイムゾーン。省略時は UTC。"),
	calendarId: z.string().optional().describe("対象コレクション ID。省略時は全コレクションを横断して列挙する。"),
	maxEvents: z.number().int().positive().optional().describe("返す occurrence の上限。既定 250。"),
};

const DEFAULT_MAX_EVENTS = 250;

// --- get-freebusy -------------------------------------------------------------

const getFreeBusyInputShape = {
	timeMin: z.string().describe("free/busy 集計範囲の開始(offset 付き ISO8601)。"),
	timeMax: z.string().describe("free/busy 集計範囲の終了(offset 付き ISO8601。必須)。"),
	timeZone: z.string().optional().describe("応答時刻の表示に使う IANA タイムゾーン。省略時は UTC。"),
	calendarId: z.string().optional().describe("対象コレクション ID。省略時は全コレクションを横断して集計する。"),
};

/**
 * timeZone 入力を検証して確定させる共通ヘルパー。未指定なら "UTC"、指定されていて
 * 不正な IANA 名なら例外を投げる(呼び出し側の isError 変換に委ねる)。
 */
function resolveTimeZone(timeZone: string | undefined): string {
	const zone = timeZone ?? "UTC";
	if (!isValidIanaZone(zone)) {
		throw new RangeError(`invalid IANA time zone: "${zone}"`);
	}
	return zone;
}

/**
 * 対象コレクション ID の一覧を解決する。calendarId 指定ありならその1件、無ければ
 * collectionRepo.findAllByOwner で owner 配下の全コレクションを列挙する
 * (list-events-expanded / get-freebusy 共通のロジック)。
 */
async function resolveCollectionIds(
	deps: McpAppDeps,
	owner: PrincipalRef,
	calendarId: string | undefined,
): Promise<CollectionId[]> {
	if (calendarId !== undefined) return [mkCollectionId(calendarId)];
	const collections = await deps.collectionRepo.findAllByOwner(owner);
	return collections.map((c) => c.id);
}

/** MCP ツールハンドラの共通エラー整形。isError:true + content にメッセージを詰める。 */
function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

/**
 * リクエストごとに McpServer + StreamableHTTPTransport を新規生成し、3ツールを登録する
 * ファクトリ。principal をクロージャで束縛するため、認証成功後(ミドルウェア内)で呼ぶ。
 */
function buildMcpServer(deps: McpAppDeps, principal: PrincipalRef): McpServer {
	const server = new McpServer({ name: "caldav-mcp", version: "1.0.0" });

	// --- get-current-time -----------------------------------------------------
	server.registerTool(
		"get-current-time",
		{
			title: "Get current time",
			description: "現在時刻を指定タイムゾーンの offset 付き ISO8601 で返す。エージェントが「今日/今」を基準に期間を組み立てるための基準時刻取得ツール。",
			inputSchema: getCurrentTimeInputShape,
		},
		async ({ timeZone }) => {
			try {
				const zone = resolveTimeZone(timeZone);
				const now = new Date();
				const nowMillis = now.getTime();
				const currentTime = epochToIso(nowMillis, zone);
				// dayOfWeek はゾーンでの曜日(UTC の曜日と一致しない可能性があるため、
				// Intl.DateTimeFormat で当該ゾーンの曜日を明示的に取り直す)。
				const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
				const result = {
					currentTime,
					timeZone: zone,
					utc: epochToIso(nowMillis, "UTC"),
					dayOfWeek,
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- list-events-expanded --------------------------------------------------
	server.registerTool(
		"list-events-expanded",
		{
			title: "List expanded events",
			description: "指定期間の VEVENT を反復展開済み(RRULE/RDATE を個々の occurrence に展開)の平坦な一覧として返す。calendarId 省略時は全カレンダーを横断する。",
			inputSchema: listEventsExpandedInputShape,
		},
		async ({ timeMin, timeMax, timeZone, calendarId, maxEvents }) => {
			try {
				const zone = resolveTimeZone(timeZone);
				const rangeStartMillis = parseIsoToEpoch(timeMin);
				const rangeEndMillis = parseIsoToEpoch(timeMax);
				const limit = maxEvents ?? DEFAULT_MAX_EVENTS;

				const collectionIds = await resolveCollectionIds(deps, principal, calendarId);
				const listOccurrences = new ListOccurrences(deps.resourceRepo, deps.iterator);

				// 複数コレクションをまたぐ場合はそれぞれ ListOccurrences を呼んでマージする
				// (ListOccurrences 自体は単一コレクション専用。list-occurrences.ts のスコープ外
				// コメントのとおり、複数コレクション横断はこの呼び出し側=MCP アダプタの責務)。
				const entries: { uid: string; calendarId: CollectionId; occurrence: Occurrence }[] = [];
				let truncated = false;
				for (const cid of collectionIds) {
					const out = await listOccurrences.execute({
						owner: principal,
						collectionId: cid,
						rangeStartMillis,
						rangeEndMillis,
						floatingTimeZone: zone,
					});
					if (out.truncated) truncated = true;
					entries.push(...out.occurrences);
				}
				entries.sort((a, b) => a.occurrence.startMillis - b.occurrence.startMillis);

				// maxEvents は MCP アダプタ側の露出制限(内部の LIST_OCCURRENCES_MAX_OCCURRENCES
				// とは別の口。09 の「内部 maxOccurrences は露出しない」方針どおり、ここでだけ切る)。
				if (entries.length > limit) truncated = true;
				const clipped = entries.slice(0, limit);

				const events = clipped.map(({ uid, calendarId: cid, occurrence }) => {
					// isAllDay: recurrenceId が CalDate(DATE 値)なら "kind" フィールドを持たない
					// (CalDateTime は kind: "floating"|"utc"|"zoned" を持つ判別可能ユニオン。
					// cal-date-time.ts のコメント参照)。よって kind の有無で判別できる。
					const isAllDay = !("kind" in occurrence.recurrenceId);
					const start = isAllDay ? formatDateOnly(occurrence.startMillis, zone) : epochToIso(occurrence.startMillis, zone);
					const end = isAllDay ? formatDateOnly(occurrence.endMillis, zone) : epochToIso(occurrence.endMillis, zone);
					const component = occurrence.component;
					// isRecurring は「master が rrule か rdate を持つか」で近似する(要件どおり)。
					// 本来は master 側のプロパティを見るべきだが、Occurrence.component は
					// source="override" なら上書き VEvent(rrule/rdate を持たない)になる。
					// ListOccurrences は master そのものを DTO として露出しないため、ここでは
					// 「override 由来 or マスター自身が rrule/rdate を持つ」で近似する
					// (override が存在する時点でマスターは反復イベントであるはずなので、
					// occurrence.source === "override" も real recurring の十分条件として使える)。
					const isRecurring = occurrence.source === "override" || component.rrule !== undefined || component.rdate.length > 0;
					return {
						uid,
						calendarId: cid,
						summary: component.summary,
						start,
						end,
						isAllDay,
						isRecurring,
						recurrenceId: isAllDay ? formatDateOnly(occurrence.startMillis, zone) : epochToIso(occurrence.startMillis, zone),
						status: component.status,
						location: component.location,
						description: component.description,
					};
				});

				const result = { timeZone: zone, events, truncated };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- get-freebusy -----------------------------------------------------------
	server.registerTool(
		"get-freebusy",
		{
			title: "Get free/busy",
			description: "指定期間の busy 区間(RFC 4791 §7.10 の FBTYPE 導出済み)を返す。calendarId 省略時は全カレンダーを横断して再 coalesce する。",
			inputSchema: getFreeBusyInputShape,
		},
		async ({ timeMin, timeMax, timeZone, calendarId }) => {
			try {
				const zone = resolveTimeZone(timeZone);
				const rangeStartMillis = parseIsoToEpoch(timeMin);
				const rangeEndMillis = parseIsoToEpoch(timeMax);

				const collectionIds = await resolveCollectionIds(deps, principal, calendarId);
				const computeFreeBusy = new ComputeFreeBusy(deps.resourceRepo, deps.iterator);

				const allIntervals: BusyInterval[] = [];
				for (const cid of collectionIds) {
					const out = await computeFreeBusy.execute({
						owner: principal,
						collectionId: cid,
						rangeStartMillis,
						rangeEndMillis,
						floatingTimeZone: zone,
					});
					allIntervals.push(...out.intervals);
				}
				// 複数コレクション分をマージしたら再度 coalesce する(単一コレクションの
				// ComputeFreeBusy が返す結果はコレクション内で既に coalesce 済みだが、
				// コレクションをまたいだ重複/連続はここで初めて解消できる)。
				const merged = coalesceBusyIntervals(allIntervals);

				const busy = merged.map((iv) => ({
					start: epochToIso(iv.startMillis, zone),
					end: epochToIso(iv.endMillis, zone),
					type: iv.type,
				}));

				const result = { timeZone: zone, busy };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	return server;
}

/**
 * MCP サブアプリを組み立てる。src/index.ts から `app.route("/mcp", createMcpApp(depsFactory))` で
 * マウントする想定。Cloud Run の書き換えプロキシはこのパスを経由しない(iOS の CalDAV
 * トラフィックとは独立した入口。src/index.ts の配線コメント参照)。
 *
 * 【なぜ静的な deps ではなく env → deps のファクトリ関数を受け取るのか】
 * D1 バインディング(collectionRepo/resourceRepo の実体)は Worker の env(リクエストごとに
 * Hono が渡す c.env)からしか得られない。DAV 側(src/index.ts の app.all("*", ...))が
 * `repositoriesFactory(c.env)` をリクエストごとに呼んでいるのと同じ理由で、MCP 側も
 * モジュールロード時の1回きりの静的 deps ではなく、リクエストごとに c.env から repos/auth を
 * 組み立てる。テスト(__setRepositoriesFactoryForTest 相当)でも同じ理由でファクトリの差し替えが
 * 必要になる。
 */
export function createMcpApp(depsFactory: (env: CloudflareBindings) => McpAppDeps) {
	const app = new Hono<{ Bindings: CloudflareBindings }>();

	app.all("/", async (c) => {
		const deps = depsFactory(c.env);

		// --- 認証: Authorization ヘッダ + resourceUri を AuthContext に詰めて解決する ---
		const url = new URL(c.req.url);
		const resourceUri = `${url.origin}/mcp`;
		const authResult = await deps.auth.authenticate({
			authorization: c.req.header("authorization") ?? null,
			resourceUri,
		});
		if (!authResult.ok) {
			const headers: Record<string, string> = {};
			if (authResult.wwwAuthenticate !== undefined) headers["WWW-Authenticate"] = authResult.wwwAuthenticate;
			return new Response("Unauthorized", { status: 401, headers });
		}

		// --- 1リクエスト1インスタンス(クラスコメント参照) ---
		const server = buildMcpServer(deps, authResult.principal);
		const transport = new StreamableHTTPTransport();
		await server.connect(transport);
		const response = await transport.handleRequest(c);
		// StreamableHTTPTransport.handleRequest は Response | undefined を返しうる型だが、
		// GET/POST/DELETE いずれのハンドラも必ず Response を返す実装(@hono/mcp のソース確認済み)。
		// undefined は型上の保険であり実運用では起きない想定だが、Hono のハンドラ契約を守るため
		// 保険で 500 に倒す。
		return response ?? new Response("MCP transport returned no response", { status: 500 });
	});

	return app;
}
