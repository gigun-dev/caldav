// =============================================================================
// mcp/server — MCP ツールサーバー(G-5 照会3ツール + E-1 スライス① create-todo/list-todos)
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
// Hono 独自の ExecutionContext 型(hono/types)を明示 import する。global ambient な
// ExecutionContext(@cloudflare/workers-types。OAuthProvider の.d.ts が使う方)は `tracing`
// フィールドを要求するなど形が異なり、c.executionCtx(Hono 側の型)をそのまま代入すると
// tsc が構造的に弾く。depsFactory の ctx 引数は「Hono が実際に渡してくる値の型」と
// 一致させるべきなので、意図的に hono 側の型を使う(index.ts の mcpApiApp 配線側で
// OAuthProvider の ExecutionContext 型との橋渡し=局所キャストを行う)。
import type { ExecutionContext } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";

import type { AuthenticationPort, CollectionUnitOfWork } from "../../application/ports";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../../application/ports";
import {
	CompleteTodo,
	ComputeFreeBusy,
	CreateTodo,
	DeleteCalendarObject,
	DeleteETagMismatchError,
	DeleteTargetNotFoundError,
	DeleteTodo,
	InvalidDueError,
	ListOccurrences,
	ListTodos,
	PutCalendarObject,
	RecurringCompletionNotSupportedError,
	TodoNotFoundError,
	UpdateTodo,
} from "../../application/usecases";
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
	// E-1 スライス①: create-todo が PutCalendarObject(collectionRepo/resourceRepo/uow/iterator の
	// 4依存)を合成するために必要。既存3ツールは uow を使わない(読み取り専用)ため、
	// この依存追加は create-todo/list-todos の追加に伴う最小限の拡張。
	readonly uow: CollectionUnitOfWork;
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

// --- create-todo / list-todos(方向性 E-1 スライス①)---------------------------

const createTodoInputShape = {
	title: z.string().describe("SUMMARY(タイトル)。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。"),
	due: z.string().optional().describe(
		'期日。"YYYY-MM-DD"(終日)のみサポート。時刻付き due(VTIMEZONE 合成が必要)はこのスライスでは未対応 — 指定すると invalid_input エラーになる。',
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。iOS 準拠: 1=高、5=中、9=低(「緊急」段階は無い)。省略時は未設定。",
	),
	calendarId: z.string().optional().describe('保存先コレクション ID。省略時は "tasks"。'),
};

// --- update-todo / complete-todo / delete-todo(方向性 E-1 スライス②-b)-------------

const updateTodoInputShape = {
	id: z.string().describe("更新対象の VTODO UID(create-todo/list-todos が返す id)。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	title: z.string().optional().describe("SUMMARY(タイトル)。省略時は変更しない。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。省略時は変更しない。"),
	due: z.string().optional().describe('期日。"YYYY-MM-DD"(終日)のみサポート。省略時は変更しない。'),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。0 を渡すと未設定に戻る。省略時は変更しない。",
	),
	status: z.enum(["COMPLETED", "NEEDS-ACTION"]).optional().describe(
		"STATUS の遷移。COMPLETED で完了・NEEDS-ACTION で未完了に戻す。省略時は変更しない。" +
			"反復 VTODO(RRULE あり)への COMPLETED 指定は complete-todo と異なりガードしない点に注意。",
	),
};

const completeTodoInputShape = {
	id: z.string().describe("完了対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
};

const deleteTodoInputShape = {
	id: z.string().describe("削除対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
};

const listTodosInputShape = {
	includeCompleted: z.boolean().optional().describe("完了済み(STATUS:COMPLETED)を含めるか。既定は未完了のみ(false)。"),
	dueBefore: z.string().optional().describe("DUE がこの offset 付き ISO8601 より前の TODO だけに絞る(due 無しは除外)。"),
	dueAfter: z.string().optional().describe("DUE がこの offset 付き ISO8601 より後の TODO だけに絞る(due 無しは除外)。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	timeZone: z.string().optional().describe("due の表示 + floating/DATE の解釈に使う IANA タイムゾーン。省略時は UTC。"),
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
 * リクエストごとに McpServer + StreamableHTTPTransport を新規生成し、5ツール
 * (get-current-time / list-events-expanded / get-freebusy / create-todo / list-todos)を登録する
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

	// --- create-todo(E-1 スライス①)---------------------------------------------
	server.registerTool(
		"create-todo",
		{
			title: "Create todo",
			description:
				"新規 VTODO(リマインダー)を作成する。UID/DTSTAMP はサーバーが生成する。priority は 1=高/5=中/9=低(iOS 準拠、「緊急」段階は無い)。due は \"YYYY-MM-DD\"(終日)のみ対応 — 時刻付き期日は未対応。",
			inputSchema: createTodoInputShape,
		},
		async ({ title, notes, due, priority, calendarId }) => {
			try {
				// PutCalendarObject は4依存(collectionRepo/resourceRepo/uow/iterator)を合成する
				// 既存ユースケース。CreateTodo はそれをさらに1段合成する(create-todo.ts 冒頭コメント)。
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createTodo = new CreateTodo(putCalendarObject);
				const { task } = await createTodo.execute({
					owner: principal,
					title,
					notes,
					due,
					priority,
					calendarId,
				});
				const result = { task };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				// InvalidDueError(時刻付き due 未対応)/ ETagConditionError(UID 衝突。実質起きない
				// はずだが防御的に)/ CalDAVPreconditionError / CollectionNotFoundError(calendarId 指定
				// 誤り)いずれも「入力起因のエラー」としてメッセージをそのまま返す(toolError は
				// isError:true にするだけで HTTP ステータスの区別は持たない — MCP のエラー表現に
				// HTTP 相当のコード分類は無いため、既存3ツールと同じ扱いに揃える)。
				if (error instanceof InvalidDueError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- list-todos(E-1 スライス①)-----------------------------------------------
	server.registerTool(
		"list-todos",
		{
			title: "List todos",
			description: "VTODO(リマインダー)を一覧する。既定は未完了のみ(includeCompleted:false)。反復 VTODO も master 1件として一覧する(展開はしない)。",
			inputSchema: listTodosInputShape,
		},
		async ({ includeCompleted, dueBefore, dueAfter, calendarId, timeZone }) => {
			try {
				const zone = resolveTimeZone(timeZone);
				const listTodos = new ListTodos(deps.resourceRepo);
				const { tasks } = await listTodos.execute({
					owner: principal,
					includeCompleted,
					dueBefore,
					dueAfter,
					calendarId,
					timeZone: zone,
				});
				const result = { tasks, calendarId: calendarId ?? "tasks", timeZone: zone };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- update-todo(E-1 スライス②-b)---------------------------------------------
	server.registerTool(
		"update-todo",
		{
			title: "Update todo",
			description:
				"既存 VTODO(リマインダー)の一部フィールドを更新する。指定したフィールドのみ変更し、他は維持する。" +
				"status:\"COMPLETED\"/\"NEEDS-ACTION\" でフィールド更新と同時に完了/再開もできる" +
				"(status:\"COMPLETED\" は complete-todo と同じ理由で定期タスク(RRULE あり)には未対応)。",
			inputSchema: updateTodoInputShape,
		},
		async ({ id, calendarId, title, notes, due, priority, status }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const updateTodo = new UpdateTodo(putCalendarObject, deps.resourceRepo);
				const { task } = await updateTodo.execute({
					owner: principal,
					todoId: id,
					calendarId,
					title,
					notes,
					due,
					priority,
					status,
				});
				const result = { task };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				// TodoNotFoundError / InvalidDueError / ETagConditionError / CalDAVPreconditionError /
				// CollectionNotFoundError いずれも「入力起因のエラー」としてメッセージをそのまま返す
				// (create-todo と同じ扱い。instanceof で特別分岐する意味的な差が無いため catch-all で足りる)。
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- complete-todo(E-1 スライス②-b、単発のみ)-----------------------------------
	server.registerTool(
		"complete-todo",
		{
			title: "Complete todo",
			description:
				"VTODO(リマインダー)を完了する(STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100 の三点セット)。" +
				"定期タスク(RRULE あり)は未対応(②-c で対応予定 — docs/modeling/06 §D4 の新 UID スナップショット方式が必要なため)。",
			inputSchema: completeTodoInputShape,
		},
		async ({ id, calendarId }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const completeTodo = new CompleteTodo(putCalendarObject, deps.resourceRepo);
				const { task } = await completeTodo.execute({ owner: principal, todoId: id, calendarId });
				const result = { task };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				if (error instanceof RecurringCompletionNotSupportedError) return toolError(error.message);
				if (error instanceof TodoNotFoundError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- delete-todo(E-1 スライス②-b)---------------------------------------------
	server.registerTool(
		"delete-todo",
		{
			title: "Delete todo",
			description: "VTODO(リマインダー)を削除する。常に無条件削除(ETag 条件なし — delete-todo.ts 冒頭コメント参照)。",
			inputSchema: deleteTodoInputShape,
		},
		async ({ id, calendarId }) => {
			try {
				const deleteCalendarObject = new DeleteCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow);
				const deleteTodo = new DeleteTodo(deleteCalendarObject, deps.resourceRepo);
				await deleteTodo.execute({ owner: principal, todoId: id, calendarId });
				const result = { deleted: true, id };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				if (error instanceof TodoNotFoundError) return toolError(error.message);
				if (error instanceof DeleteTargetNotFoundError) return toolError(error.message);
				if (error instanceof DeleteETagMismatchError) return toolError(error.message);
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
 *
 * 【2026-07-12 OAuth-for-MCP 第2スライス: ctx 引数を追加した理由】
 * OAuth 経由の認証(OAuthPropsAuth)は「トークン検証済みの props」を必要とするが、props は
 * Hono の c.env には乗らず ExecutionContext(c.executionCtx)に @cloudflare/workers-oauth-provider
 * が実行時に注入する(index.ts の mcpApiApp 配線参照)。よって depsFactory に env に加えて
 * ExecutionContext も渡せるようにする。
 * 【型の壁】Hono の ExecutionContext 型定義に `props` フィールドは無い(provider が実行時に
 * 生やす独自拡張のため)。この server.ts では ExecutionContext をそのまま横流しするだけにして、
 * props を読んで narrow するのは呼び出し側(index.ts)の責務にする — ここで型をこじ開けると
 * 「MCP サーバー層が OAuthProvider の実装詳細を知っている」ことになり、CLAUDE.md の層分離
 * (プロトコル知識は presentation に閉じ込めるが、外部ライブラリの実行時拡張はさらに外側=
 * コンポジションルートに閉じ込めたい)に反するため。
 * 【後方互換】ctx はオプショナル(`c.executionCtx` は Hono の型上 `ExecutionContext` で必須では
 * なく存在しうる)。ctx を使わない depsFactory(StaticBearerAuth を使うテスト等)も無変更で動く。
 */
export function createMcpApp(depsFactory: (env: CloudflareBindings, ctx?: ExecutionContext) => McpAppDeps) {
	const app = new Hono<{ Bindings: CloudflareBindings }>();

	app.all("/", async (c) => {
		// c.executionCtx は「呼び出し元が Request と一緒に ExecutionContext も渡したか」で
		// 中身が決まる getter で、渡されていないと例外を投げる実装(hono/dist/context.js
		// executionCtx()。bun test の `.fetch(request, env)`(第3引数省略)がまさにこのケース。
		// depsFactory の ctx はもとから optional(server.ts コメント「後方互換」参照)なので、
		// 例外を握りつぶして undefined にフォールバックする — StaticBearerAuth はそもそも ctx を
		// 使わないため、この経路でも認証は問題なく動く。
		let executionCtx: ExecutionContext | undefined;
		try {
			executionCtx = c.executionCtx;
		} catch {
			executionCtx = undefined;
		}
		const deps = depsFactory(c.env, executionCtx);

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
