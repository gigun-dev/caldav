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
// E-2 スライス①: MCP Apps(ui://)の登録ヘルパー。registerAppResource は素の
// registerResource のラッパーで mimeType を RESOURCE_MIME_TYPE("text/html;profile=mcp-app")に
// 既定化する。registerAppTool は registerTool のラッパーで _meta.ui.resourceUri から
// 後方互換キー _meta["ui/resourceUri"] を自動補完する(型は registerTool と互換なので、
// 既存の title/description/inputSchema/handler をそのまま渡せる)。d.ts で 1.7.4 の
// シグネチャを確認済み(RESOURCE_MIME_TYPE は値 "text/html;profile=mcp-app")。
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";

// E-2 スライス①: list-todos が描画する ui:// リソースの URI と HTML 本体。
// todos-app.ts → todos-bundle.ts(自動生成)の依存を経由する。ここ(server.ts)から
// ui/ 配下への import は許可される(.dependency-cruiser.cjs の mcp-ui-is-terminal は
// 「ui/ から他 src への import」だけを禁止する末端ルールで、ui/ へ入る import は対象外)。
import { TODOS_APP_HTML, TODOS_UI_URI } from "./ui/todos-app";

import type { AuthenticationPort, CollectionUnitOfWork } from "../../application/ports";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../../application/ports";
import type { CreateTodoRecurrenceInput } from "../../application/usecases";
import {
	CompleteTodo,
	ComputeFreeBusy,
	CreateTodo,
	DeleteCalendarObject,
	DeleteETagMismatchError,
	DeleteTargetNotFoundError,
	DeleteTodo,
	DueTimeZoneRequiredError,
	InvalidDueError,
	InvalidTimeZoneError,
	ListOccurrences,
	ListTodos,
	PutCalendarObject,
	RecurrenceCountUntilConflictError,
	RecurrenceRequiresDueError,
	RecurrenceWeekdaysRequireWeeklyError,
	TodoNotFoundError,
	UnsupportedTimeZoneError,
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

// recurrence(タスク③: 反復付き create-todo)。iOS リマインダーの繰り返し UI に語彙を合わせる。
// z.object にしたのは createTodoInputShape 直下に平坦展開せず「反復指定」というまとまりを
// スキーマ上も保つため(due 等と混ざらず MCP クライアント側の入力補完でも塊として見える)。
//
// 【Why not: 平坦化(recurrenceFrequency 等の prefix フィールド)を採らない — ネスト維持が正
//  2026-07-13 判断・Fable 一次調査】
// 症状: MCP Inspector の手動フォームは、ユーザーが触っていない optional な recurrence でも
// `{"frequency": ""}` を送ってくる(inspector の client/src/utils/schemaUtils.ts generateDefaultValue
// L120-136 が「optional object でも中の required サブフィールドを "" で埋めて」初期化し、
// cleanParams[paramUtils.ts] は top-level しか掃除しない=shallow なので残る。ソースで裏取り済み)。
// zod は frequency:"" を enum 外で弾くため、繰り返し無し todo すら作れない噛み合わせが起きる。
// 対策として recurrence を top-level 平坦フィールド(recurrenceFrequency 等)に分解する案も検討したが
// **不採用**。理由:
//  (1) ネスト optional object は MCP のイディオムとして正 — Anthropic 公式コネクタ(Google Calendar
//      create_event)や modelcontextprotocol/servers も採用。prefix 平坦化のパターンは公式例に無い。
//      平坦化はクライアント(Inspector)のバグに公開語彙を歪めることになる(かつ公開語彙は一度
//      使われると戻しにくい=不可逆性が高い)。
//  (2) この Inspector 挙動は upstream 自身が認めるバグクラス(closed #771 / PR #772 が
//      「optional の空 array/object を省く」を修正済み。required サブフィールド持ち object の分岐が
//      取り残された残件)。バグに API を合わせるべきでない。将来 upstream issue に起こす候補
//      (#771/#772 参照 + 最小再現 {recurrence?:{frequency:enum}})だが、今は起票しない。
// 回避: 開発時に Inspector で create-todo を叩くときは **JSON モード**で送れば正しいペイロードになる。
// 実運用の主入口(Claude コネクタ=LLM)は未使用 optional を省くので無問題。
//
// 【2026-07-13 Case E 採用: frequency に "none"(繰り返さない)を追加】
// 上の Why-not で「平坦化は不採用、JSON モードで回避すればよい」としたが、それでも
// Inspector の **手動フォーム**(JSON モードを使わない一般的な操作)では recurrence を
// 一切触っていなくても `{frequency:""}` が送られ、繰り返さない todo すら作れない実害が残る
// (JSON モード回避は「知っている開発者向けの workaround」であって、フォーム操作そのものを
// 直しはしない)。generateDefaultValue(client/src/utils/schemaUtils.ts L94-96)は
// **明示的な .default(...) を先に見て尊重する**分岐を持つため、frequency enum に "none" を足し
// `.default("none")` を付けると、Inspector は `{frequency:"none"}`(サブフィールド無し)を
// 送るようになり、これは zod 的に valid になる — 「未初期化 required フィールド」問題を
// スキーマ側の値レベルで無害化する。
// iOS リマインダーの繰り返し UI にも「繰り返ししない」の選択肢があり、"none" は語彙としても
// 自然(iOS 対応を品質基準とする CLAUDE.md の方針にも合う)。
// 【application 層に "none" を漏らさない理由】CreateTodoRecurrenceInput(create-todo.ts)の
// frequency は既存の4値("daily"|"weekly"|"monthly"|"yearly")のまま変更しない契約にする。
// "none" は「MCP Inspector のクライアントバグを吸収するための presentation 層限定の語彙」であり、
// ドメイン/アプリケーション層には存在しない概念(RRULE 自体を出さない=recurrence undefined と
// 同義)。application まで4値+"none" の5値にすると、DAV 経由など他の入口(将来の REST 等)にも
// "none" という MCP 固有の都合が波及しかねない。CLAUDE.md の「application 層は DAV 専用にせず
// 複数入口から呼べる形を保つ」方針に沿って、MCP 固有の吸収は presentation に閉じ込める。
// 【"none" + サブフィールド併用をエラーにする理由(黙って無視しない)】
// 例えば `{frequency:"none", count:5}` のような矛盾した入力をサイレントに count を捨てて
// 受理すると、ユーザー(または LLM)が意図した反復設定が黙って失われる。CalDAV/RFC 5545 の
// 「曖昧な入力は拒否する」姿勢(他の recurrence 系エラー: RecurrenceCountUntilConflictError 等)
// と同じく、ここでも明示的にエラーを返して気づかせる。
const createTodoRecurrenceInputShape = z
	.object({
		frequency: z
			.enum(["none", "daily", "weekly", "monthly", "yearly"])
			.default("none")
			.describe('反復頻度。RRULE の FREQ に対応。"none"=繰り返さない(既定)。'),
		interval: z.number().int().min(1).optional().describe(
			"間隔(例: 2 なら「2日/2週間ごと」)。省略時は RRULE に INTERVAL を出さない(既定 1 と等価)。",
		),
		weekdays: z
			.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]))
			.optional()
			.describe(
				'曜日指定(BYDAY、序数無し)。frequency:"weekly" のときのみ有効 — それ以外に指定するとエラーになる' +
					"(monthly/yearly の曜日指定は序数付き BYDAY が必要で意味が異なるため、このスライスでは未対応)。",
			),
		count: z.number().int().min(1).optional().describe("回数指定(COUNT)。until と排他。"),
		until: z.string().optional().describe('終了日("YYYY-MM-DD")。UNTIL に対応。count と排他。'),
	})
	.describe(
		'反復指定。指定する場合 due が必須(RRULE は DTSTART をアンカーにするため)。' +
			"count と until は同時指定不可(RFC 5545 の UNTIL/COUNT 排他規則)。",
	);

const createTodoInputShape = {
	title: z.string().describe("SUMMARY(タイトル)。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。"),
	due: z.string().optional().describe(
		'期日。2形態: "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組で指定)。' +
			"offset 付き ISO8601(例 \"...+09:00\"/\"...Z\")は不可(TZID を一意に導出できないため)。" +
			"recurrence を指定する場合は due が必須(RRULE の DTSTART アンカー)。" +
			"【2026-07-13 V6】時刻付き due には常にサーバーが VALARM(due 時刻の絶対 UTC 通知)を" +
			"生成する(独立 alarm 入力は廃止 — due に統合した。iOS 実機はサーバー発 VALARM でも通知する[V5 実機検証で確定])。",
	),
	timeZone: z.string().optional().describe(
		'due が時刻付き("YYYY-MM-DDTHH:MM:SS")のときの IANA タイムゾーン名(例 "Asia/Tokyo")。必須' +
			"(省略時はエラー・暗黙 UTC フォールバックはしない)。DST ゾーン(例 America/New_York)は" +
			"サーバー側 VTIMEZONE 生成が Phase 1 で未対応のためエラーになる — 固定オフセットゾーンのみ対応。" +
			"due が終日または省略のときは無視する。",
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。iOS 準拠: 1=高、5=中、9=低(「緊急」段階は無い)。省略時は未設定。",
	),
	calendarId: z.string().optional().describe('保存先コレクション ID。省略時は "tasks"。'),
	recurrence: createTodoRecurrenceInputShape.optional().describe(
		'「毎日/毎週〜」のようにゼロから反復リマインダーを作るときに指定する(タスク③)。' +
			"既存の反復マスターへの完了操作(complete-todo)とは別物 — こちらは新規作成時の RRULE 生成。",
	),
};

// --- update-todo / complete-todo / delete-todo(方向性 E-1 スライス②-b)-------------

const updateTodoInputShape = {
	id: z.string().describe("更新対象の VTODO UID(create-todo/list-todos が返す id)。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	title: z.string().optional().describe("SUMMARY(タイトル)。省略時は変更しない。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。省略時は変更しない。"),
	due: z.string().optional().describe(
		'期日。"YYYY-MM-DD"(終日)のみサポート。省略時は変更しない。' +
			"時刻付き due の変更(create-todo が V6 で対応した \"YYYY-MM-DDTHH:MM:SS\" 形)は" +
			"未対応(V6 フォローアップ — vtodo-patch.ts が VALUE=DATE 限定のまま)。",
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。0 を渡すと未設定に戻る。省略時は変更しない。",
	),
	status: z.enum(["COMPLETED", "NEEDS-ACTION"]).optional().describe(
		"STATUS の遷移。COMPLETED で完了・NEEDS-ACTION で未完了に戻す。省略時は変更しない。" +
			"反復 VTODO(RRULE あり)への COMPLETED 指定は complete-todo と同じ D4 モデル" +
			"(新 UID の完了スナップショットを作り、マスターを次回 occurrence へ前進させる)で処理する。",
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

	// --- todos ui:// リソース(E-2 スライス①)------------------------------------
	// list-todos が _meta.ui.resourceUri で参照する MCP Apps の HTML 本体を登録する。
	// config._meta.ui はリソース一覧(resources/list)時点でホストが参照する既定値、
	// read 時の content item._meta.ui はそれを上書きする(ext-apps の仕様どおり後者が優先)。
	// このスパイクでは特別な CSP/描画設定は不要なので prefersBorder のみ最小指定にする
	// (自己完結バンドルで外部 import が無いため resourceDomains 等の CSP 許可は要らない)。
	// resource 登録も buildMcpServer 内で毎回行う(server はリクエストごとに new する既存方針
	// どおり — クラス冒頭コメント参照。ステートを持たないので毎回登録で問題ない)。
	registerAppResource(
		server,
		"Todos View",
		TODOS_UI_URI,
		{
			title: "リマインダー一覧 UI",
			description: "list-todos の結果をモバイルで崩れないリマインダー一覧として描画するプロトタイプ UI",
			mimeType: RESOURCE_MIME_TYPE,
			_meta: {
				ui: {
					prefersBorder: false,
				},
			},
		},
		async () => ({
			contents: [
				{
					uri: TODOS_UI_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: TODOS_APP_HTML,
					_meta: {
						ui: {
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

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
				"新規 VTODO(リマインダー)を作成する。UID/DTSTAMP はサーバーが生成する。priority は 1=高/5=中/9=低(iOS 準拠、「緊急」段階は無い)。" +
				'due は "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone 必須)。時刻付き due には自動で VALARM(due 時刻の通知)が付く。',
			inputSchema: createTodoInputShape,
		},
		async ({ title, notes, due, timeZone, priority, calendarId, recurrence }) => {
			try {
				// recurrence 正規化(Case E): frequency:"none" は presentation 限定の語彙なので、
				// application 層に渡す前にここで吸収する(上の createTodoRecurrenceInputShape
				// コメント「Case E 採用」参照)。"none" + サブフィールド併用は黙殺せずエラーにする
				// (ユーザー/LLM が意図した反復設定が静かに消えるのを防ぐ)。
				let normalizedRecurrence: CreateTodoRecurrenceInput | undefined;
				if (recurrence === undefined) {
					normalizedRecurrence = undefined;
				} else if (recurrence.frequency === "none") {
					const hasSubfields =
						recurrence.interval !== undefined ||
						recurrence.weekdays !== undefined ||
						recurrence.count !== undefined ||
						recurrence.until !== undefined;
					if (hasSubfields) {
						return toolError(
							'recurrence.frequency:"none"(繰り返さない)は interval/weekdays/count/until と併用できません。' +
								"繰り返しを設定する場合は frequency に daily/weekly/monthly/yearly のいずれかを指定してください。",
						);
					}
					normalizedRecurrence = undefined;
				} else {
					// ここに来る時点で recurrence.frequency は "none" ではないと TypeScript 上も
					// 確定している(直前の else-if で絞り込み済み)ので、application 層の
					// CreateTodoRecurrenceInput["frequency"](4値のみ)にそのまま代入できる。
					normalizedRecurrence = { ...recurrence, frequency: recurrence.frequency };
				}

				// PutCalendarObject は4依存(collectionRepo/resourceRepo/uow/iterator)を合成する
				// 既存ユースケース。CreateTodo はそれをさらに1段合成する(create-todo.ts 冒頭コメント)。
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createTodo = new CreateTodo(putCalendarObject);
				const { task } = await createTodo.execute({
					owner: principal,
					title,
					notes,
					due,
					timeZone,
					priority,
					calendarId,
					recurrence: normalizedRecurrence,
				});
				const result = { task };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				// InvalidDueError(due の形式不正・offset ISO8601 拒否)/ DueTimeZoneRequiredError
				// (時刻付き due に timeZone 無し)/ InvalidTimeZoneError(不正な IANA 名)/
				// UnsupportedTimeZoneError(DST ゾーンで VTIMEZONE 生成 Phase 1 対応不可)/
				// ETagConditionError(UID 衝突。実質起きないはずだが防御的に)/
				// CalDAVPreconditionError / CollectionNotFoundError(calendarId 指定誤り)いずれも
				// 「入力起因のエラー」としてメッセージをそのまま返す(toolError は isError:true に
				// するだけで HTTP ステータスの区別は持たない — MCP のエラー表現に HTTP 相当の
				// コード分類は無いため、既存3ツールと同じ扱いに揃える)。
				// recurrence 関連の3エラー(due 不在/count・until 排他/weekdays は weekly 限定)も
				// メッセージが自己説明的なのでそのまま返す(タスク③で追加)。
				if (
					error instanceof InvalidDueError ||
					error instanceof DueTimeZoneRequiredError ||
					error instanceof InvalidTimeZoneError ||
					error instanceof UnsupportedTimeZoneError ||
					error instanceof RecurrenceRequiresDueError ||
					error instanceof RecurrenceCountUntilConflictError ||
					error instanceof RecurrenceWeekdaysRequireWeeklyError
				) {
					return toolError(error.message);
				}
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- list-todos(E-1 スライス① / E-2 スライス①で ui:// を紐付け)-----------------
	// 【なぜ新ツールを足さず registerAppTool 置換にするか(可逆・非破壊)】
	//   E-2 の UI 紐付けは「既存 list-todos に _meta を1つ足すだけ」で済む。新たに
	//   list-todos-ui のような別ツールを増やすと、ホスト LLM が同じ「一覧して」で2ツールの
	//   どちらを呼ぶか迷う誤選択事故を招く(tdr で park_waits / attraction_wait の守備範囲が
	//   交差して踏んだ問題と同種)。registerAppTool は registerTool の薄いラッパーで、
	//   handler・inputSchema・structuredContent・戻り値は一切変えず _meta を追加するだけ。
	//   UI 対応ホスト(claude.ai/iOS)は ui:// を描画し、非対応ホストは _meta を無視して
	//   従来どおり structuredContent のテキストを使う——つまり退化しても壊れないし、
	//   registerAppTool を registerTool に戻せば完全に元へ戻せる(可逆)。
	// 【_meta の2キー併記】_meta.ui.resourceUri は SEP-1865(Claude 側)の正キー、
	//   "openai/outputTemplate" は ChatGPT(Apps SDK)が同じ ui:// を認識する別ベンダーキーで、
	//   独立に併記してよい(どちらのホストでも同じ HTML を再利用するための実務上の配線。
	//   tdr の park_waits と同じ)。
	// list-todos と refresh-todos(E-2 スライス②)は「同じ ListTodos ユースケースを同じ
	// principal クロージャで呼び、同じ structuredContent 契約 {tasks, calendarId, timeZone} を
	// 返す」ことが要件。ハンドラ本体を複製せず、この共通クロージャに括り出して両方から呼ぶ。
	// 【なぜ共通化するか】E-2 スライス②の検証目的は「UI からの callServerTool でも
	// 通常ツールと同じ AuthenticationPort→principal 経路で認可が効くか」であり、それを
	// 保証する最短の形は「認可コンテキスト(principal)を含む実行経路を完全に共有する」こと。
	// コピーだと将来どちらかだけ直して契約がズレる事故(list-todos と refresh-todos で
	// 見えるタスクが違う)を招くため、経路そのものを1本にする。
	// 【引数を listTodosInputShape と同じ形にする理由】refresh-todos は引数なし(空 object)で
	// 呼ぶが、共通クロージャは list-todos のフルパラメータも受けられるようにしておき、
	// refresh-todos 側は全 undefined(= 既定: 未完了のみ・tasks コレクション)で呼ぶ。
	const runListTodos = async (args: {
		includeCompleted?: boolean;
		dueBefore?: string;
		dueAfter?: string;
		calendarId?: string;
		timeZone?: string;
	}) => {
		try {
			const zone = resolveTimeZone(args.timeZone);
			const listTodos = new ListTodos(deps.resourceRepo);
			const { tasks } = await listTodos.execute({
				owner: principal,
				includeCompleted: args.includeCompleted,
				dueBefore: args.dueBefore,
				dueAfter: args.dueAfter,
				calendarId: args.calendarId,
				timeZone: zone,
			});
			const result = { tasks, calendarId: args.calendarId ?? "tasks", timeZone: zone };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				structuredContent: result,
			};
		} catch (error) {
			return toolError(error instanceof Error ? error.message : String(error));
		}
	};

	registerAppTool(
		server,
		"list-todos",
		{
			title: "List todos",
			description: "VTODO(リマインダー)を一覧する。既定は未完了のみ(includeCompleted:false)。反復 VTODO も master 1件として一覧する(展開はしない)。",
			inputSchema: listTodosInputShape,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ includeCompleted, dueBefore, dueAfter, calendarId, timeZone }) =>
			runListTodos({ includeCompleted, dueBefore, dueAfter, calendarId, timeZone }),
	);

	// --- refresh-todos(E-2 スライス②: UI 専用の再読み込みツール)---------------------
	// 【なぜ app 専用ツール(visibility:["app"])にするか】
	//   このツールは「UI(todos.html)の再読み込みボタンから App.callServerTool で叩く」
	//   ためだけに存在する。モデル(LLM)のツール一覧に出す必要はなく、むしろ出すと
	//   list-todos と役割が重なってモデルがどちらを呼ぶか迷う誤選択事故を招く(list-todos の
	//   registerAppTool コメント「同じ『一覧して』で2ツールを迷う」と同型の懸念)。
	//   ext-apps の _meta.ui.visibility は "model"(=モデルに見せて呼ばせる)/"app"(=この
	//   サーバーの UI からのみ呼べる)の2値配列で、既定は ["model","app"]。ここを ["app"] に
	//   絞ることで「モデルには見せず UI からの callServerTool 専用」を宣言する
	//   (spec.types.d.ts McpUiToolVisibility / server/index.d.ts の appOnlyVisibility 例で確認)。
	// 【認可はどう通るか = このスライスで検証したい当のもの】
	//   visibility を絞っても handler の実行経路は list-todos と同一(runListTodos 共通クロージャ)
	//   で、principal は buildMcpServer に束縛された「認証済みユーザー」そのもの。つまり UI から
	//   callServerTool 経由で呼ばれても、通常の tools/call と同じ AuthenticationPort→principal
	//   経路を通り、呼び出したユーザーの tasks だけが返る「はず」。この「はず」を実機
	//   (claude.ai Web / iOS)で潰すのが E-2 スライス②の目的。
	// 【なぜ tools/list には出てしまうか(既存テストへの影響)】
	//   registerAppTool は registerTool の薄いラッパーで、_meta.ui.visibility を付けるだけ。
	//   visibility は「ホストがモデルに見せるか」という描画/提示ヒントであって、MCP プロトコル
	//   レベルの tools/list からツールを消す機構ではない。よって refresh-todos は tools/list に
	//   出る(=既存の本数 assert が 8→9 に変わる)。テスト側の期待値はこの事実に合わせて更新した。
	// 【inputSchema を空 object にする理由】スパイクなので引数は取らず、既定(未完了のみ・
	//   tasks コレクション・UTC)で一覧を返す。listTodosInputShape を流用してもよいが、UI の
	//   ボタンは常に「今の既定ビューを最新化する」用途しか無いため、余計な引数面を持たせない。
	registerAppTool(
		server,
		"refresh-todos",
		{
			title: "Refresh todos",
			description:
				"UI(リマインダー一覧 App)専用の再読み込みツール。引数なしで既定ビュー(未完了のみ)を返す。" +
				"モデルからは呼べない(visibility:[\"app\"])— UI の再読み込みボタンが callServerTool で叩く用。",
			inputSchema: {},
			_meta: {
				ui: { resourceUri: TODOS_UI_URI, visibility: ["app"] },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async () => runListTodos({}),
	);

	// --- update-todo(E-1 スライス②-b)---------------------------------------------
	server.registerTool(
		"update-todo",
		{
			title: "Update todo",
			description:
				"既存 VTODO(リマインダー)の一部フィールドを更新する。指定したフィールドのみ変更し、他は維持する。" +
				"status:\"COMPLETED\"/\"NEEDS-ACTION\" でフィールド更新と同時に完了/再開もできる" +
				"(status:\"COMPLETED\" は complete-todo と同じ D4 モデルで定期タスク(RRULE あり)にも対応)。",
			inputSchema: updateTodoInputShape,
		},
		async ({ id, calendarId, title, notes, due, priority, status }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const updateTodo = new UpdateTodo(putCalendarObject, deps.resourceRepo, deps.iterator);
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
				"定期タスク(RRULE あり)は docs/modeling/06 §D4 の D4 モデル(新 UID の完了スナップショットを作り、" +
				"マスターを次回 occurrence へ前進させる)で処理する。",
			inputSchema: completeTodoInputShape,
		},
		async ({ id, calendarId }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const completeTodo = new CompleteTodo(putCalendarObject, deps.resourceRepo, deps.iterator);
				const { task } = await completeTodo.execute({ owner: principal, todoId: id, calendarId });
				const result = { task };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
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
