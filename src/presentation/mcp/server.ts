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
import type { Context } from "hono";
// Hono 独自の ExecutionContext 型(hono/types)を明示 import する。global ambient な
// ExecutionContext(@cloudflare/workers-types。OAuthProvider の.d.ts が使う方)は `tracing`
// フィールドを要求するなど形が異なり、c.executionCtx(Hono 側の型)をそのまま代入すると
// tsc が構造的に弾く。depsFactory の ctx 引数は「Hono が実際に渡してくる値の型」と
// 一致させるべきなので、意図的に hono 側の型を使う(index.ts の mcpApiApp 配線側で
// OAuthProvider の ExecutionContext 型との橋渡し=局所キャストを行う)。
import type { ExecutionContext } from "hono";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
// R1(docs/modeling/15 §A-2): ToolAnnotations の型。registerTool の config.annotations に渡す
// (SDK の mcp.d.ts で registerTool の第2引数が { ...; annotations?: ToolAnnotations } を受けることを確認済み)。
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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
import { TODOS_APP_HTML, TODOS_UI_HASH, TODOS_UI_URI } from "./ui/todos-app";
// E-3 スライス S2: list-events-expanded が描画するアジェンダカードの ui:// URI と HTML 本体
// (agenda-app.ts → agenda-bundle.ts 自動生成を経由)。todos と同じく server.ts から ui/ への import は許可。
import { AGENDA_APP_HTML, AGENDA_UI_HASH, AGENDA_UI_URI } from "./ui/agenda-app";
// 2026-07-23 iOS 描画切り分けスパイク: 最小診断カード(外部依存ゼロ・< 2KB)の URI + HTML。
// todos/agenda と同じ登録経路(registerAppResource / registerAppTool)・同じ OAuth 保護下を通しつつ
// 中身だけ極小にして「iOS で描画されるか」を切り分ける(仮説 (a) 認証 vs (b) サイズ)。詳細は diag-app.ts 冒頭。
import { DIAG_APP_HTML, DIAG_UI_URI } from "./ui/diag-app";
// S1: 確認トークンの生成(HMAC-SHA256・canonical JSON・TTL)。層は presentation/mcp に閉じる
// (application 層の UC シグネチャに confirmToken を持ち込まない — docs/modeling/14 §7)。
// R1(docs/modeling/15 §A-3): verifyConfirmToken(検証)はもう server.ts から使わない(delete-* の
// サーバー側トークン強制を撤去したため)。signConfirmToken(発行)は 2026-07-23(#47)に
// propose-delete-* ごと撤去した後もカード発の削除(swipe 等)の免除トークン発行(getCardToken)に
// 引き続き使うので残す(CONFIRM_APP_HTML/CONFIRM_UI_URI/PROPOSE_TOKEN_TTL_MS は propose-delete-*
// 専用だったのでこの import からも落とした — 撤去の根拠は buildMcpServer 冒頭近くの撤去コメント参照)。
import { CARD_TOKEN_TTL_MS, signConfirmToken } from "./confirm-token";

import type { AuthenticationPort, CollectionUnitOfWork, TelemetryPort, GeocodingPort } from "../../application/ports";
// #52 サーバー側テレメトリ受け: カード(todos/agenda)からの計測ポート。契約は
// application/ports/card-telemetry.ts 冒頭コメント(TelemetryPort との使い分け・PII 境界)参照。
import type { CardTelemetryPort } from "../../application/ports";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../../application/ports";
// #45 場所モデル: search-location が catch して人間可読メッセージ + errKind へ写す型付きエラー。
import { GeocodingNotConfiguredError, GeocodingQuotaExceededError } from "../../application/ports";
// 観測基盤 v1: host 推定 / argsDigest 要約 / _meta からの sessionId 読み取り(純関数群)。
// 判定ロジックを1関数ずつに隔離する狙いは telemetry-support.ts 冒頭コメント参照。
import { classifyHost, readSessionId, summarizeArgsDigest } from "./telemetry-support";
// Task 型は findTaskById 廃止(2026-07-14 レイテンシ改善)で presentation から直接参照しなくなった
// (before/removed は UC が返す。差分整形は todos-diff.ts が Task を受ける)。ここでは型 import しない。
import type { CreateTodoRecurrenceInput, Event } from "../../application/usecases";
// E-2 スライス②: mutate 系ツールが返す差分レンズ付き確定一覧の contract と、その表示用整形。
import type { AffectedTask, TaskSnapshot, TodosViewModel } from "./todos-view-model";
import { buildCompletedSummary, buildEditedChanges, snapshotFromTask } from "./todos-diff";
// E-3 スライス S1: event 系ツールの structuredContent 契約と表示用整形(todos 版と対称)。
import type { AffectedEvent, EventSnapshot } from "./events-view-model";
import { buildEventEditedChanges, snapshotFromEvent } from "./events-diff";
import {
	CompleteTodo,
	// レイテンシ案2(2026-07-22): 全横断/一部/単一を1 D1 往復で満たす across-owner 版へ移行。
	// 旧 ComputeFreeBusy / ListOccurrences(単一コレクション専用)は application 層に第一級 UC として
	// 残す(DAV REPORT 等の別入口が使う)が、MCP の list-events-expanded / get-freebusy はもう
	// N 並列で呼ばない(server 側のマージ/coalesce も UC へ吸収)。
	ComputeFreeBusyAcrossOwner,
	CreateTodo,
	DeleteCalendarObject,
	DeleteETagMismatchError,
	DeleteTargetNotFoundError,
	DeleteTodo,
	DueTimeZoneRequiredError,
	filterTasksByWindow,
	InvalidDueError,
	InvalidTimeZoneError,
	ListOccurrencesAcrossOwner,
	ListTodos,
	MoveTodo,
	MoveTodoSameCollectionError,
	PutCalendarObject,
	RecurrenceCountUntilConflictError,
	RecurrenceRequiresDueError,
	RecurrenceWeekdaysRequireWeeklyError,
	TodoNotFoundError,
	UnsupportedTimeZoneError,
	UpdateTodo,
	// E-3 スライス S1: event 系ユースケース(create/update/delete-event)+ エラー型。
	CreateEvent,
	UpdateEvent,
	DeleteEvent,
	EventNotFoundError,
	EventTimeZoneRequiredError,
	InvalidStartError,
	InvalidEndError,
	StartAfterEndError,
	StartEndTypeMismatchError,
	InvalidAlarmsError,
	InvalidTravelMinutesError,
	InvalidUrlError,
	// C8(設計 05): 場所(structuredLocation)/ 会議(conference)の write 検証エラー。
	InvalidStructuredLocationError,
	InvalidConferenceUrlError,
	eventFromOccurrence,
	// C5(設計 05): 既知の場所ツール。#locationAutoResolve(自動ジオコーディング)も同じ UC を再利用する。
	ListKnownLocations,
	type KnownLocation,
	// #locationAutoResolve: update-event が「location 文字列が変わったか」を判定するために現在の
	// VEVENT を1回だけ読む(UpdateEvent.execute 内部と同じ関数を再利用・二重実装しない)。
	lookupEvent,
	// R2(docs/modeling/15 §A-3): ソフトデリートのゴミ箱一覧 + 復元。
	ListDeleted,
	RestoreDeleted,
	RestoreTargetNotFoundError,
	RestoreUidConflictError,
} from "../../application/usecases";
import type { RecurrenceIterator } from "../../domain/ical/recurrence";
// #locationAutoResolve(自動ジオコーディング): create/update-event の structuredLocation 入力と
// application 層 UC が受け取る StructuredLocationInput は同一の shape(title/address?/lat?/lon?/radius?)。
// application/usecases バレルには re-export されていない(create-event.ts が domain から直接 import する
// 内部型のため)ので、ここでも同じ domain モジュールから直接引く。
import type { StructuredLocationInput, ProximityAlarmInput } from "../../domain/ical/semantics";
// #locationAutoResolve: update-event が「location 文字列が変わったか」を判定するために現在の
// VEVENT.location(生 TEXT)を decodeText した意味的文字列と比較する(event-dto.ts の readEventMeta と
// 同じ decodeText の使い方)。
import { decodeText } from "../../domain/ical/values";
import type { CalendarCollection, CollectionId, ComponentKind, PrincipalRef } from "../../domain/caldav";
import { AppleColor, InvalidIdentifierError, collectionId as mkCollectionId } from "../../domain/caldav";
// list-calendars / create-calendar(方向性直近タスク): DAV MKCALENDAR と同じ UC を MCP から
// 別入口で呼ぶ(CLAUDE.md 長期ビジョン「複数入口」の具体例)。
import {
	CollectionAlreadyExistsError,
	CreateCollection,
	ListCollections,
	normalizeDisplayNameForComparison,
} from "../../application/usecases";
// update-calendar(K2: MCP から表示名/色を変更する。DAV PROPPATCH(app.ts)と同じ
// UpdateCollectionProperties UC を別入口から呼ぶ — CLAUDE.md 長期ビジョン「複数入口」の具体例)。
import { UpdateCollectionProperties } from "../../application/usecases";
// delete-calendar(検証運用で「作ったリストを消すツールが無く D1 直で消した」ことが動機。
// DAV DELETE 経路とは別の薄い専用 UC — delete-collection.ts 冒頭コメント参照)。
import { CollectionNotEmptyError, CollectionNotFoundError, DeleteCollection } from "../../application/usecases";
// 時刻グラウンディング(2026-07-16): 相対レンジ enum → 絶対 epoch 範囲の純関数解決。
// list-events-expanded / get-freebusy が range 指定時にサーバー権威 now で境界を計算するのに使う
// (application/time/relative-range.ts。DAV 非依存の純関数なので複数入口ビジョンに沿う)。
import { resolveRelativeRange, type RelativeRangeKeyword } from "../../application/time/relative-range";
// formatDateOnly は list-events-expanded の応答整形を event-dto.eventFromOccurrence(application 層)へ
// 移したため presentation では不要になった(2026-07-15 E-3 S1)。epochToIso は get-freebusy 等で継続使用。
import { epochToIso, isValidIanaZone, parseIsoToEpoch } from "./format";
// R-6: OAuth scope 分離のツール別強制。read/write の区分(READ_ONLY_TOOLS)と write 許可判定
// (allowsWrite: undefined=grandfather/full access)を scopes.ts に集約する(scopes.ts 冒頭コメント参照)。
import { allowsWrite, isWriteTool } from "./scopes";

export interface McpAppDeps {
	readonly auth: AuthenticationPort;
	readonly collectionRepo: CalendarCollectionRepository;
	readonly resourceRepo: CalendarObjectResourceRepository;
	readonly iterator: RecurrenceIterator;
	// E-1 スライス①: create-todo が PutCalendarObject(collectionRepo/resourceRepo/uow/iterator の
	// 4依存)を合成するために必要。既存3ツールは uow を使わない(読み取り専用)ため、
	// この依存追加は create-todo/list-todos の追加に伴う最小限の拡張。
	readonly uow: CollectionUnitOfWork;
	// S1(docs/modeling/14 確認カード): 確認トークンを HMAC 署名する Workers secret(CONFIRM_SECRET)。
	// 2026-07-23(#47)に propose-delete-* とサーバー側検証(delete-* の実行前ガード)を撤去した後も、
	// カード発の削除(swipe 等)の免除トークン発行(getCardToken)がこの secret を使い続けるため
	// binding は残す。空文字は getCardToken が実行時に空トークンへ縮退させる(空鍵で誰でも通る事故を
	// 防ぐ。§ の MCP_TOKEN と同じガード思想)。
	readonly confirmSecret: string;
	// 観測基盤 v1: 1 tool call = 1 イベントの計測ポート。実装アダプタ(AE / no-op)の選択は
	// コンポジションルート(app.ts)が担う(env.TELEMETRY の有無で切り替え — app.ts コメント参照)。
	readonly telemetry: TelemetryPort;
	// #52 サーバー側テレメトリ受け: report-card-telemetry ツールが使うカード計測ポート。実装
	// アダプタ(AE / no-op)の選択は telemetry と同じくコンポジションルート(app.ts)が担う
	// (env.CARD_TELEMETRY の有無で切り替え — app.ts コメント参照)。
	readonly cardTelemetry: CardTelemetryPort;
	// #45 場所モデル: search-location ツールが使う geocoding ポート。app.ts は Google Places アダプタを
	// 月次 quota デコレータ(QuotaLimitedGeocoding)で包んだものを注入する。プロバイダ・quota の詳細は
	// server.ts からは見えない(GeocodingPort の語彙 title/address/geo と型付きエラーだけを扱う)。
	readonly geocoding: GeocodingPort;
}

// --- get-current-time -------------------------------------------------------

const getCurrentTimeInputShape = {
	timeZone: z.string().optional().describe('IANA タイムゾーン名(例 "Asia/Tokyo")。省略時は UTC。'),
};

// --- 相対レンジ enum(時刻グラウンディングの往復削減。list-events-expanded / get-freebusy 共通)---
// 【なぜ相対レンジ enum を足すか】絶対 ISO 範囲だけだと「今日の予定」を引くのに get-current-time で
// now を得てから境界を自前計算する 2 往復が要る。サーバー権威の now で境界を計算して返せば1発で済む
// (詳細は application/time/relative-range.ts 冒頭コメント)。
// 【range description に「事前 get-current-time 不要」を明記する理由】get-current-time は存置するが、
// モデルが相対レンジで足りる場面でも従来どおり2往復してしまわないよう、1発で済むことを語彙で伝える。
// 【2026-07-22 this-week/next-week/this-month 追加】「今週の予定」のような自然言語表現に対応する
// 語彙が無く、モデルが get-current-time を先行呼びする2往復が実運用で再発したため追加(週の起点は
// application/time/relative-range.ts 冒頭コメント参照。2026-07-23 に月曜始まりから日曜始まりへ変更
// — 単一ユーザーの iOS カレンダー設定に合わせた)。
const RANGE_DESCRIPTION =
	'相対レンジ。"today"/"tomorrow"/"next-7-days"/"next-30-days"/"this-week"/"next-week"/"this-month" のいずれか。' +
	"指定時は timeMin/timeMax 不要・timeZone 必須(当該 TZ のローカル午前0時起点・終端排他で境界を計算する。" +
	"this-week/next-week は日曜始まり)。「今週」「来週」「今月」などの相対表現も range で1発で引ける。" +
	"get-current-time の事前呼び出しは不要。";
const rangeEnumField = z
	.enum(["today", "tomorrow", "next-7-days", "next-30-days", "this-week", "next-week", "this-month"])
	.optional()
	.describe(RANGE_DESCRIPTION);

// --- list-events-expanded ----------------------------------------------------

const listEventsExpandedInputShape = {
	// timeMin/timeMax を optional 化した(range 指定時は不要)。range との XOR は runListEvents で実行時検証する
	// (zod の superRefine ではなくハンドラ側で検証するのは、range 解決に必要な now/timeZone がハンドラ文脈に
	// あるため。エラーは toolError で明示メッセージを返す)。
	timeMin: z.string().optional().describe("展開範囲の開始(offset 付き ISO8601。例 2026-07-11T00:00:00+09:00 または ...Z)。range 指定時は不要。"),
	timeMax: z.string().optional().describe("展開範囲の終了(offset 付き ISO8601)。range 指定時は不要。"),
	range: rangeEnumField,
	timeZone: z.string().optional().describe("応答時刻の表示 + floating 値の解釈に使う IANA タイムゾーン。省略時は UTC(ただし range 指定時は必須)。"),
	calendarId: z.string().optional().describe("対象コレクション ID。省略時は全コレクションを横断して列挙する。"),
	// calendarIds(2026-07-22 agenda カード表示フィルタ用): 複数コレクションを明示指定して、その集合
	// だけを横断合成する。単数 calendarId との併存で、両方指定されたら calendarIds を優先する(下記
	// resolveCollectionIds のコメント参照)。UI(アジェンダカードの表示フィルタシート)が「一部だけ
	// 表示 ON」の状態で refresh-events を叩くときに使う。全 ON のとき UI は calendarIds を送らない
	// (=省略 → 従来どおり全コレクション横断)ので、既定挙動は一切変わらない(additive)。
	calendarIds: z
		.array(z.string())
		.optional()
		.describe(
			"対象コレクション ID の集合。指定したコレクションだけを横断して列挙・合成する(開始時刻順)。" +
				"単数 calendarId と両方指定された場合は calendarIds を優先する。省略時は calendarId の挙動に従う。",
		),
	maxEvents: z.number().int().positive().optional().describe("返す occurrence の上限。既定 250。"),
};

const DEFAULT_MAX_EVENTS = 250;

// COMPLETED_RECENT_MAX: buildTodosViewModel が completedSummary.recent に載せる件数の上限
// (2026-07-23 症状B対策・ユーザー裁定)。カードの完了済みセクションは「今の操作の結果が見える」
// ことが目的(直後の undo とフィードバック)であり、履歴を遡る閲覧はエージェント経由
// (list-todos includeCompleted:true のテキスト/structuredContent.tasks)の役割に切り分ける。
// todos-entry.ts 側の COMPLETED_RECENT_MAX(UI 定数・同名で揃えている)と値を一致させること。
const COMPLETED_RECENT_MAX = 5;

/**
 * 【② 2026-07-24 ゴミ箱のカード化】list-deleted の content(モデル向けテキスト)用に、削除時刻を
 * 人間可読の相対表記へ整形する。カード側(ui/trash-view.ts の formatDeletedRelative)と同じ段階分けだが、
 * ui は末端で server から import できない(層境界。.dependency-cruiser の mcp-ui-is-terminal)ため、
 * この短いロジックだけを意図的に複製する(task-dto.ts が offset ISO 正規表現を複製するのと同じ判断)。
 * content はモデルが「何をいつ消したか」を人間可読に要約するためのもので、URI は晒さない(list-deleted
 * の description が「ユーザーに URI を見せない」を誘導する)。
 */
function formatDeletedAgoForContent(deletedAtMillis: number, nowMillis: number): string {
	const diff = nowMillis - deletedAtMillis;
	const MIN = 60_000;
	const HOUR = 60 * MIN;
	const DAY = 24 * HOUR;
	if (diff < 0) return new Date(deletedAtMillis).toISOString().slice(0, 10);
	if (diff < MIN) return "たった今";
	if (diff < HOUR) return `${Math.floor(diff / MIN)}分前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
	if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}日前`;
	return new Date(deletedAtMillis).toISOString().slice(0, 10);
}

// --- get-freebusy -------------------------------------------------------------

const getFreeBusyInputShape = {
	timeMin: z.string().optional().describe("free/busy 集計範囲の開始(offset 付き ISO8601)。range 指定時は不要。"),
	timeMax: z.string().optional().describe("free/busy 集計範囲の終了(offset 付き ISO8601)。range 指定時は不要。"),
	range: rangeEnumField,
	timeZone: z.string().optional().describe("応答時刻の表示に使う IANA タイムゾーン。省略時は UTC(ただし range 指定時は必須)。"),
	calendarId: z.string().optional().describe("対象コレクション ID。省略時は全コレクションを横断して集計する。"),
};

/**
 * range(相対レンジ)と timeMin/timeMax(絶対範囲)の XOR 検証 + 範囲解決の共通ヘルパー
 * (list-events-expanded / get-freebusy で同一ロジックを共有する)。
 *
 * 【検証ルール(XOR)】
 *   - range も timeMin/timeMax も無い → エラー(どちらか一方は必須)
 *   - range と timeMin/timeMax の併記 → エラー(排他)
 *   - range 指定で timeZone 欠落 → エラー(下記「range 時 TZ 必須」参照)
 *   - 絶対指定は従来どおり timeMin/timeMax の両方が必須(片方だけはエラー)
 *
 * 【なぜ range 指定時に timeZone を必須にするか】相対レンジの境界は「当該 TZ のローカル午前0時」で
 * 決まる。timeZone を省いて UTC 既定に倒すと「今日」が UTC 解釈になり、Asia/Tokyo なら最大9時間、
 * America/Los_Angeles なら最大8時間ズレて「今日の予定」が半日ぶんズレる事故になる。create-event の
 * 「時刻付きは timeZone 必須・暗黙 UTC 禁止」規律と同じ理由で、range 指定時は timeZone を必須にする。
 *
 * 返り値は解決済みの epoch 範囲 + 応答エコー用の zone/nowMillis。エラー時は例外を投げ、
 * 呼び出し側(runListEvents / get-freebusy handler)の catch が toolError に変換する。
 */
function resolveRequestRange(input: {
	timeMin?: string;
	timeMax?: string;
	range?: RelativeRangeKeyword;
	timeZone?: string;
	nowMillis: number;
}): { rangeStartMillis: number; rangeEndMillis: number; zone: string; nowMillis: number } {
	const { timeMin, timeMax, range, timeZone, nowMillis } = input;
	const hasAbsolute = timeMin !== undefined || timeMax !== undefined;

	if (range !== undefined) {
		// range 指定: 絶対範囲との併記は排他違反(黙って一方を無視せずエラーで気づかせる)。
		if (hasAbsolute) {
			throw new RangeError(
				"range(相対レンジ)と timeMin/timeMax(絶対範囲)は同時に指定できません。どちらか一方だけを指定してください。",
			);
		}
		// range 指定時は timeZone 必須(上記「range 時 TZ 必須」コメント参照。暗黙 UTC 禁止)。
		if (timeZone === undefined) {
			throw new RangeError(
				"range(相対レンジ)を指定する場合は timeZone(IANA タイムゾーン)が必須です。" +
					'"今日" が UTC 解釈になり最大数時間ズレるのを防ぐため、明示してください(例 "Asia/Tokyo")。',
			);
		}
		const zone = resolveTimeZone(timeZone); // 不正 IANA 名はここで RangeError。
		const resolved = resolveRelativeRange(range, zone, nowMillis);
		return { rangeStartMillis: resolved.timeMinMillis, rangeEndMillis: resolved.timeMaxMillis, zone, nowMillis };
	}

	// 絶対指定: timeMin/timeMax は両方必須(従来契約。片方欠落はエラー)。
	if (timeMin === undefined || timeMax === undefined) {
		throw new RangeError(
			"timeMin と timeMax(絶対範囲)の両方が必要です。または range(相対レンジ: today/tomorrow/next-7-days/next-30-days/this-week/next-week/this-month)を指定してください。",
		);
	}
	const zone = resolveTimeZone(timeZone);
	return { rangeStartMillis: parseIsoToEpoch(timeMin), rangeEndMillis: parseIsoToEpoch(timeMax), zone, nowMillis };
}

// --- list-calendars / create-calendar(直近タスク: DAV MKCALENDAR と同じ UC を MCP から露出)--
// 【なぜ registerTool(registerAppTool ではない)か】このタスクの要件どおり、todos UI とは
// 別関心(カレンダー/リマインダーリストそのものの一覧・作成は「一覧を表示するタスク」ではなく
// 「今後の操作対象を確定するための下ごしらえ」)。UI を持たせると list-todos/create-todo の
// TODOS_UI_URI と混同されるおそれがあるため、素の registerTool に留める。

// list-calendars は引数を取らない。inputSchema には空 shape を渡す(z.object({}) 相当。
// SDK は shape が空でも ZodRawShape として扱える — 他ツールと同じ「shape オブジェクトを直接渡す」
// 流儀を踏襲する)。
const listCalendarsInputShape = {};

// components: iOS のカレンダー(VEVENT)/リマインダーリスト(VTODO)の対応関係をモデルが理解できる
// よう description に明示する(list-todos の calendarId と紐付けられるように、という仕様要求)。
// 【既定 ["VTODO"] を選んだ理由】このリポジトリの MCP ツール群は現状 todos(VTODO)中心
// (create-todo/list-todos/update-todo/complete-todo/delete-todo の5ツートが VTODO 専用。
// list-events-expanded/get-freebusy は VEVENT を読むだけで作成系が無い)。create-calendar を
// 使う主な文脈は「新しいリマインダーリストを作りたい」であり、VEVENT 用カレンダーを作りたい
// 需要は今のところ無い。既定を VTODO にしておけば、モデルが components を省略しても
// 「リマインダーリストの新規作成」という最も起きやすい意図に自然に合致する。
const createCalendarInputShape = {
	id: z.string().optional().describe(
		"コレクション ID(URL パスセグメント)。空白/制御文字/\"/\" 不可。省略時は displayName から" +
			"自動生成する(生成できない場合は UUID にフォールバック)。",
	),
	displayName: z.string().describe("表示名(displayName プロパティ)。iOS のカレンダー/リマインダーリスト名に対応。"),
	components: z
		.array(z.enum(["VEVENT", "VTODO", "VJOURNAL"]))
		.optional()
		.describe(
			'受け入れるコンポーネント種別(supported-calendar-component-set)。"VEVENT"=カレンダー(予定)、' +
				'"VTODO"=リマインダーリスト、"VJOURNAL"=ジャーナル。省略時は ["VTODO"](リマインダーリスト作成が' +
				"主用途のため)。list-todos/create-todo の calendarId はこの components に VTODO を含む" +
				"コレクションの id を指すのが自然な対応関係。",
		),
	color: z.string().optional().describe('Apple 拡張のカレンダー色。"#RRGGBB" または "#RRGGBBAA"(8桁)。'),
	// 2026-07-17 TZ グラウンディング: create-calendar も作成直後に buildTodosViewModel で確定一覧
	// (実質空)を返すため、応答表示ゾーンに使う timeZone を additive に受ける。既定 UTC 不変。
	timeZone: z.string().optional().describe(
		"作成直後に返す一覧の due 表示に使う IANA タイムゾーン。省略時は UTC(新規リストは通常空なので実害は薄いが、UI 経路の一貫性のため受ける)。",
	),
};

/**
 * create-calendar の id 省略時に displayName から URL セグメントとして安全な slug を生成する。
 * 【なぜ完全な slugify ライブラリを足さないか】このタスクはドメイン層に触れない制約があり、
 * 依存追加も避けたい。CollectionId の禁止事項(空文字・空白/制御文字・"/")さえ満たせば足りるので、
 * 素朴な正規化(小文字化・許容文字以外を "-" に畳む・前後の "-" を削る)で十分。
 *
 * 【2026-07-15 本番検証で発覚したバグ修正: 非 ASCII displayName の縮退】
 * 元実装は `[^a-z0-9]+` にマッチした文字をまとめて "-" に畳んで前後の "-" だけ削っていたため、
 * 日本語など非 ASCII の displayName(例「読書リスト2」)を渡すと日本語部分が丸ごと "-" に
 * 潰れて "-2-" になり、trim 後に残る id が "2" という無意味な値になる事故を本番 D1 で確認した
 * (元 displayName の情報をほぼ失った id が実際に作られていた)。「空文字にフォールバック」
 * 条件だけでは、こういう「空ではないが情報量ゼロに近い」ケースを救えていなかったのが根本原因。
 *
 * 【フォールバック発火条件を「空」から「情報量が乏しい」へ拡張した判断】
 * 完全な非 ASCII 対応 slugify(transliteration 等)を持ち込むのは依存追加・複雑化のコストが
 * 見合わないと判断し、「素朴な正規化の結果が信頼できないほど乏しい」場合は潔く UUID
 * フォールバックに倒す方針にした。具体的な判定:
 *   - 空文字(元からの条件)
 *   - 数字のみ(上記の "2" のような事故ケースそのもの — 元の displayName の文字情報が
 *     一切残らず数字だけが偶然生き残った形跡)
 *   - 長さ 3 未満(1〜2 文字の slug は URL セグメントとしては合法だが、非 ASCII displayName の
 *     残骸である可能性が高く、視認性・衝突回避の両面で uuid の方が安全側に倒せる)
 * 閾値 3 はマジックナンバーだが、"ab" 程度の短い英数字 displayName(稀)を UUID に倒しても
 * 実害が薄い一方、"1","22" のような数字化けを確実に拾える下限として選んだ。
 *
 * 【2026-07-23 K1 追記: フォールバック先を crypto.randomUUID() → 安定 hash slug に変更】
 * 元実装は degenerate 判定時に毎回 crypto.randomUUID() を引いていたため、「同じ日本語
 * displayName で create-calendar を2回叩く」と id が毎回変わり、UC 層の id 一致チェック
 * (CollectionAlreadyExistsError)をすり抜けて同名コレクションが複製される実害があった
 * (create-collection.ts の displayName 重複ガード= K1 で UC 層は別途防いだが、id 側も
 * 「同じ displayName なら同じ id 候補になる」ようにして二重防御する)。
 *   - 採用: FNV-1a(32bit)で displayName(NFC 正規化後)をハッシュ化し、"list-" prefix +
 *     8桁 hex を id にする(例 "list-3a91f0c2")。FNV-1a を選んだ理由は依存追加なしで数行で
 *     実装できる決定的ハッシュだから(暗号学的な強度は不要 — 衝突耐性より「同じ入力→同じ出力」
 *     の再現性が目的)。prefix "list-" を付けるのは、hex 文字列だけだと slugifyForCollectionId
 *     が返す通常の英数字 slug と見分けが付きにくく、デバッグ時に「これは fallback 経由の id」と
 *     一目で分かるようにするため。
 *   - Why not 案1(displayName をそのまま非 ASCII 込みで id にする): CollectionId の禁止文字
 *     ("/" 等)や URL エンコードの扱いが CalDAV クライアント(特に iOS)側でどう解釈されるか
 *     不確実性が高く、iOS 対応を品質基準とする本リポジトリの方針(CLAUDE.md)と相性が悪いため
 *     見送った。ASCII のみの id に倒すほうが枯れている。
 *   - Why not 案2(transliteration ライブラリで日本語→ローマ字化): 依存追加のコストと、
 *     ライブラリの変換結果が言語によっては安定しない(将来ライブラリ更新で同じ displayName でも
 *     違う slug が出る)リスクがあり、「決定的で単純」を優先して見送った。
 * 【crypto.randomUUID() を最後の手段として残す理由】hash slug は原理的に displayName が
 * 空文字であっても "list-<hash>" という非 degenerate な文字列を返す(hash 関数はどんな入力でも
 * 32bit 値を返すため)ので、通常経路では到達しないはず。それでも「hash slug 生成自体が何らかの
 * 理由で空/不正になった」という将来の実装ミスに対する最終防波堤として randomUUID フォールバックを
 * 残す(CollectionId として不正な文字列を返してしまうより、衝突の心配がない UUID の方が安全)。
 */
// テスト(server.test.ts)から直接呼べるよう export する(この関数だけを取り出して境界値を
// 検証したいが、registerTool 経由だと McpServer 全体の配線が要るため単体テストが書きにくい)。
export function slugifyForCollectionId(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const isDegenerate = slug.length === 0 || /^[0-9]+$/.test(slug) || slug.length < 3;
	if (!isDegenerate) {
		return slug;
	}
	const hashSlug = `list-${fnv1aHex(displayName.normalize("NFC"))}`;
	// 上のコメントのとおり hashSlug は原理的に非 degenerate だが、将来の実装変更に対する
	// 最終防波堤として空/短小チェックだけは通しておく(万一を randomUUID で救う)。
	return hashSlug.length >= 3 ? hashSlug : crypto.randomUUID();
}

/**
 * FNV-1a(32bit)による決定的ハッシュ。8桁 hex 文字列を返す。
 * 【なぜ自前実装か】暗号学的ハッシュ(SHA-256 等)は Web Crypto 経由だと非同期 API
 * (crypto.subtle.digest)になり、slugifyForCollectionId を同期関数のまま保てなくなる
 * (呼び出し元 create-calendar ハンドラの構造を変えたくない)。FNV-1a は同期・依存ゼロ・
 * 数行で書ける決定的ハッシュとして「同じ displayName → 同じ id 候補」という目的に対して
 * 十分(id の衝突を完全排除する強度は求めていない — 衝突しても CollectionAlreadyExistsError を
 * create-calendar ハンドラが拾い、displayName まで一致すれば冪等返却・不一致なら接尾辞を振って
 * 再試行する設計なので実害は薄い。2026-07-23: displayName 単位の重複検出
 * (CollectionDisplayNameConflictError)は撤回済み — create-collection.ts 冒頭コメント参照)。
 */
function fnv1aHex(input: string): string {
	// FNV-1a 32bit の定数(FNV offset basis / FNV prime)。アルゴリズム仕様上の固定値。
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// 32bit 乗算は `* 0x01000193` だと JS の Number 精度で桁あふれするため、乗算を
		// シフト+加算に分解する慣用手法(FNV-1a JS 実装の定石)。Math.imul でも書けるが、
		// 追加の組み込み関数への依存を増やしたくないので素朴なビット演算のみで書いた。
		hash +=
			(hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	// 符号なし32bit に変換してから hex 化(charCodeAt がサロゲートペアを分割しても、
	// 決定的である限り本関数の目的には支障ない)。
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// =============================================================================
// R1(docs/modeling/15 §A-2): tool annotations の共通定義
// =============================================================================
// 【なぜ全ツールに annotations を付けるか(未履行の仕様義務)】
// annotations(destructiveHint/openWorldHint 等)は MCP spec 上 **untrusted hint** であり、
// ホストが自動的に確認を省略/強制することを保証しない(spec の NOTE: "Clients should never
// make tool use decisions based on ToolAnnotations")。それでも申告が要るのは、ToolAnnotations の
// デフォルトが性悪説側(destructiveHint 既定 true・openWorldHint 既定 true)だから — 申告を怠ると
// list-todos のような読み取り専用ツールすら「破壊的操作」としてホストに扱われ得る。申告するのは
// 「あれば親切」ではなく仕様義務として扱う(modeling/15 §A-2)。
// openWorldHint は全ツール共通で false(このサーバーは自前の D1 だけを操作し、Web 検索や外部
// API のような「未知の open world」とはやり取りしない)。
const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
// create 系: 新規リソースを作るだけで既存状態を破壊しない(destructiveHint:false)。
// idempotentHint:false — 冪等ではない。同じ内容の重複作成を「同じ結果」とはみなさない。
// 【2026-07-23 追記(K1)】create-todo 等は依然として同じ入力を2回叩けば2件できる(冪等でない
// ことに変わりない)。create-calendar だけは別扱いになったので、下の CREATE_CALENDAR_ANNOTATIONS
// 参照(この定数からは create-calendar を切り離した — 経緯はそちらのコメント)。
// annotations はツール横断の共通定数のままにして、ツールごとの詳細な差分は各ツールの
// description/コメントに書く方針を維持する。
const CREATE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};
// create-calendar 専用の annotations。
// 【経緯(すべて 2026-07-23 の1日の中で積層。最終形は末尾)】
//   1. K1(午前): 非 ASCII displayName の slug 縮退で自動生成 id が毎回 crypto.randomUUID() に
//      フォールバックし、同じ displayName で create-calendar を2回呼ぶと id 一致チェックを
//      すり抜けて同名コレクションが複製される実害(「テストコレクション」が2件・両方ランダム
//      UUID・空)が発覚。displayName の重複を UC 層で検出して拒否する
//      CollectionDisplayNameConflictError を追加。この時点では「エラーで弾かれる」は冪等の定義に
//      含まれないと判断し、CREATE_ANNOTATIONS のまま(idempotentHint:false)に留めた。
//   2. 中盤: 「2回目がエラーになる」のは真の冪等ではないと指摘され、拒否ではなく「既存
//      コレクションを成功として返す」方式に直し、idempotentHint:true 用の専用定数を切り出した。
//   3. 終盤(ユーザー裁定・最終形): 上記2段階とも問題定義そのものが誤りだったと判明。実害の
//      原因は「同じ名前で意図的に2つ作った」ことではなく「1回の依頼がランダム UUID のせいで
//      再送のたびに別コレクションになった」こと(トランスポート/エージェント側のリトライ)。
//      displayName の重複検出/矯正(拒否であれ既存への統合であれ)は iOS/iCloud が許す「同名の
//      複数リスト作成」という正当な操作を妨げる誤った治療だったため全面撤回し、id 側の治療
//      (K1 で既に入れていた安定 slug 化を土台に、id 省略時の自動生成 id を同じ displayName なら
//      同じ id に収束させる)だけで冪等性を実現する設計にした。id 省略時に自動 id が既存と衝突し、
//      かつ displayName も一致するなら「同一リクエストの再送」とみなして既存を成功で返す
//      (真の no-op)。id を明示指定した場合の衝突は常にエラー(呼び手の具体的な意図を尊重し、
//      黙って別物を返さない)。この最終形で create-calendar は idempotentHint:true と言える状態に
//      なったため、CREATE_ANNOTATIONS から分離した専用定数のままにする(他の create 系は依然
//      「2回叩くと2件できる」のままで idempotentHint:false — 変更しない)。
const CREATE_CALENDAR_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
// update/complete/move 系: destructiveHint:true とする。既存状態を不可逆に上書きする操作という
// 意味で「壊れたら戻せない」を正直に申告する(update は本来「置き換え」であって「破壊」ではないが、
// R2/R3 のソフトデリート・版履歴が入るまでは取り消し手段が無いため destructive 側に倒す)。
// 【Why not: update だけ readOnlyHint:false, destructiveHint:false にする案】却下。R3(revert-*)導入前は
// update の巻き戻し手段が一切無く、「元に戻せる」という誤ったシグナルをホストに渡すことになる。
// R3 で版履歴による取り消しが入ったら、update 系の destructiveHint は緩められる可能性がある
// (docs/modeling/15 §A-3 の R3 参照。ここが緩和の起点になるので、その時にこのコメントごと見直すこと)。
const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};
// delete 系: destructiveHint:true(不可逆な削除)+ idempotentHint:true(対象が既に無い状態への
// 同じ呼び出しを繰り返しても結果は同じ「無い」に収束する — delete-todo.ts 等が「常に無条件削除」の
// 方針を取っているのと同じ発想)。
const DELETE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
};
// restore-deleted(R2・docs/modeling/15 §A-3): 可逆性の提供そのもの。ゴミ箱の tombstone を
// 生存行に戻す「非破壊」操作(destructiveHint:false — 既存データを壊さず復活させるだけ)。
// idempotentHint:true(同じものを2回復元しても、2回目は「もう削除済み行が無い」で結果が変わらない
// = 同じ生存状態に収束する)。openWorldHint:false は全ツール共通(自前 D1 のみ)。
const RESTORE_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

// update-calendar(K2): destructiveHint:true・idempotentHint:true という組み合わせは
// DELETE_ANNOTATIONS と数値上は同じだが、意味付けは独立に決めている(仕様書の指示どおり)。
// destructiveHint:true にする理由 — displayName/color を上書きすると旧値は失われ、R3(版履歴に
// よる取り消し)が入るまで戻す手段が無い(DESTRUCTIVE_ANNOTATIONS の update/complete/move 系と
// 同じ理屈)。idempotentHint:true にする理由 — 「同じ displayName/color を指定して update-calendar
// を繰り返し呼ぶ」操作は、DELETE_ANNOTATIONS の delete-todo 等と同様に、常に同じ最終状態
// (指定した displayName/color が設定された状態)に収束する = 副作用が繰り返しても増えない
// (create 系の「2回叩くと2件できる」とは性質が異なる)。DESTRUCTIVE_ANNOTATIONS を流用しなかった
// のは、そちらが idempotentHint:false(update-todo 等は「反復操作が同じ状態に収束する」保証が
// 無い設計 — 例えば priority の相対変更のような将来拡張を想定した安全側の申告)であるのに対し、
// update-calendar は displayName/color の絶対値上書きのみで反復可能性が異なるため。
const UPDATE_CALENDAR_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
};

// S1(docs/modeling/14): confirmToken は元々「確認カードで承認済み」を証明するトークン(§4 Tier A)
// だった。delete-calendar / delete-todo / delete-event の3つの入力 shape で共有するため、最初に
// 使う delete-calendar より前に定義する(const の TDZ を避ける — 使用箇所より前に置く必要がある)。
// R1(docs/modeling/15 §A-3): サーバー側でのトークン検証(verifyDeleteConfirmation)は撤去した
// (§A 参照 — 確認 UI の提示はホスト責務であり、annotations(destructiveHint 等)を正しく申告して
// ホストの判断に委ねる。サーバー側の二重確認は claude.ai の per-tool 許可と重複するだけだった)。
// フィールド自体は後方互換のため optional のまま残し、渡されても無視する(既存の todos・agenda
// カードの swipe 削除がトークン付きで delete-* を呼ぶ実装は壊さない)。
// 2026-07-23(#47): propose-delete-* ツール自体とその確認カード(ui/confirm-app.ts)は撤去した
// (server.ts 冒頭近くの撤去理由コメント参照)。カード発の swipe 削除は propose を経由しない別経路
// (getCardToken の免除トークン)なので影響を受けない — confirmToken フィールドは今も両カードから
// 渡され得るが検証しないため無害。
const confirmTokenField = z
	.string()
	.optional()
	.describe(
		"非推奨・現在は無視される。以前は破壊的操作の承認証跡(propose-* が確認カードの _meta に" +
			"載せて発行するトークン)だったが、確認 UI の提示責務はホストへ移した(docs/modeling/15 §A)。" +
			"指定してもしなくても delete-* の実行結果は変わらない。",
	);

// --- delete-calendar(検証運用の動機: 作ったリストを消すツールが無く D1 直で消したことがあった。
// list-calendars/create-calendar の対を埋める) ---------------------------------------------
// 【非空コレクション既定拒否の安全装置】force を明示しない限り中身が1件でもあれば拒否する
// (DeleteCollection UC 側のポリシー。delete-collection.ts 冒頭コメント参照)。誤って
// force:true を渡させないよう、description で「中身も一緒に消える」ことを明示する。
const deleteCalendarInputShape = {
	id: z.string().describe("削除するコレクション ID(list-calendars/create-calendar が返す id)。"),
	force: z
		.boolean()
		.optional()
		.describe(
			"true を指定すると、中身(予定/リマインダー)が1件以上あるコレクションでも削除する" +
				"(配下のリソースも一緒に削除される)。省略時(既定 false)は非空コレクションを拒否する。",
		),
	// S1(docs/modeling/14): 確認トークン(§4 Tier A)。confirmTokenField 定義箇所コメント参照。
	confirmToken: confirmTokenField,
}

// --- update-calendar(K2: list-calendars/create-calendar/delete-calendar の対を埋める。
// PROPPATCH は iOS 側から表示名/色を変更できるが、MCP 経由(エージェント入口)には無かった) -----
// 【displayName/color 両方省略を拒否する理由】UpdateCollectionProperties UC は各フィールドが
// undefined なら「その属性は変更しない」という契約(withMetadata の各引数が undefined なら
// 現在値を保つ — calendar-collection.ts の withMetadata 参照)。両方省略で呼ぶと UC 自体は
// エラーにならず「何も変えない no-op 呼び出し」が成立してしまうが、それはツール呼び出しとして
// 意味が無い(モデルが誤って空呼び出しをしても気づけるよう、ここで明示的に拒否する)。
// 【order を MCP に出さない理由】仕様(タスク冒頭)が displayName/color のみを要求している。
// order(calendar-order)は iOS の並び順プロパティで PROPPATCH 経由の変更のみサポートを維持し、
// MCP からの need が今のところ無い(将来 need が出たら additive に足せる — UC 側は既に order を
// 受けられる形になっている)。
const updateCalendarInputShape = {
	id: z.string().describe("更新するコレクション ID(list-calendars/create-calendar が返す id)。"),
	displayName: z.string().optional().describe("新しい表示名(displayname)。省略時は変更しない。"),
	color: z
		.string()
		.optional()
		.describe(
			'新しいカレンダー色(Apple 拡張)。"#RRGGBB" または "#RRGGBBAA"(8桁)。省略時は変更しない。',
		),
}

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
// 【2026-07-15 strict 化(既知バグの是正)】本番検証で「create-todos に recurrence:{freq:...,
// byDay:...}(誤キー)を渡すと zod が未知キーを黙って捨て、frequency は default("none")のまま =
// 非反復で作られる」事故が起きた(反復するつもりが黙って反復しない todo になる)。z.object は
// 既定で未知キーを strip する(黙殺)ため、誤キーが検知できなかった。.strict() にして未知キーを
// **入力エラー**へ格上げし、誤った反復指定を静かに握りつぶさない。
// 【strict 化で Inspector の空 recurrence 送信問題が悪化しないことの確認】
// Inspector 手動フォームの問題は「optional object の未初期化 required サブフィールドを {frequency:""}
// で埋めて送る」こと(冒頭 Why-not 参照)。これは *既知キー frequency に空文字* を入れる問題で、
// enum バリデーションで既に弾かれる(strict の未知キー検査とは別レイヤー)。default("none") で
// {} を送れば none に倒れる回避も従来どおり生きる。よって strict 追加はこの問題を悪化させない
// (未知キー検査は「frequency 以外の余計なキー」だけに効くので、空 recurrence 経路には無関係)。
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
	.strict() // 未知キー(byDay/freq 等の誤キー)を黙殺せず入力エラーにする(上記コメント参照)。
	.describe(
		'反復指定。指定する場合 due が必須(RRULE は DTSTART をアンカーにするため)。' +
			"count と until は同時指定不可(RFC 5545 の UNTIL/COUNT 排他規則)。",
	);

// 【create-todo / create-todos の共通 item フィールド(2026-07-14 バッチツール追加)】
// title/notes/due/priority/recurrence は1件ずつの create-todo と、複数件をまとめて追加する
// create-todos の「1 item」で完全に同じ語彙・同じ validation(due の形式、recurrence の判別
// union 等)を使う。二重管理を避けるため shape オブジェクトをここに括り出し、両ツールの
// inputSchema から spread する(createTodoInputShape は timeZone/calendarId を単発用に追加、
// createTodosInputShape は items 配列の要素として使い、timeZone/calendarId はバッチ全体で
// 共有する top-level フィールドにする — 下の createTodosInputShape のコメント参照)。
const createTodoItemFieldsShape = {
	title: z.string().describe("SUMMARY(タイトル)。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。"),
	due: z.string().optional().describe(
		'期日。2形態: "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組で指定)。' +
			"offset 付き ISO8601(例 \"...+09:00\"/\"...Z\")は不可(TZID を一意に導出できないため)。" +
			"recurrence を指定する場合は due が必須(RRULE の DTSTART アンカー)。" +
			"【2026-07-13 V6】時刻付き due には常にサーバーが VALARM(due 時刻の絶対 UTC 通知)を" +
			"生成する(独立 alarm 入力は廃止 — due に統合した。iOS 実機はサーバー発 VALARM でも通知する[V5 実機検証で確定])。",
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。iOS 準拠: 1=高、5=中、9=低(「緊急」段階は無い)。省略時は未設定。",
	),
	// 【B(> 2026-07-17 実機 FB 第2ラウンド): VTODO の自由テキスト LOCATION 引数を全廃】
	// 旧実装は create-todo/create-todos に location(素の TEXT LOCATION)引数を持たせていたが、
	// ユーザー裁定で撤去した。撤去の重要な理由: **テキスト location が引数にあると、LLM が「自宅に着いたら
	// 通知して」のような依頼を LOCATION テキストの書き込みで済ませてしまい、あたかも geofence(位置情報)
	// 通知が設定されたかのように誤解させる罠になる**。iOS の「場所リマインダー」は LOCATION テキストでは
	// なく proximity VALARM(X-APPLE-PROXIMITY + structured-location)であり(設計 05 §1-a の実データ)、
	// その正しい書き込みは C8(author 規約)で VALARM の形として入る予定。それまでは「場所=位置通知」の
	// 意味を壊さないよう、自由テキスト LOCATION の書き込み口を LLM に一切見せない(引数から消す)。
	// VEVENT の location(会議/場所)は別物なので触らない(create-event/update-event の location は温存)。
	// 読み取り(task-dto.ts の Task.location)は既存 ICS 互換のため温存する — 消すのは書き込み引数だけ。
	recurrence: createTodoRecurrenceInputShape.optional().describe(
		'「毎日/毎週〜」のようにゼロから反復リマインダーを作るときに指定する(タスク③)。' +
			"既存の反復マスターへの完了操作(complete-todo)とは別物 — こちらは新規作成時の RRULE 生成。",
	),
};

// --- locationReminder(#51 Phase 1: VTODO の位置リマインダー = geofence 通知)-----------------
// 【なぜ create-todo/update-todo だけで create-todos(バッチ)には出さないか】
// 位置リマインダーは「1件ずつ丁寧に場所を確定する」性格の入力(解決不能ならエラーにする=下記)で、
// 「5件まとめて追加」のバッチ用途とは相性が悪い(1件の場所解決失敗が全体を止める/曖昧なまま量産する)。
// よって createTodoItemFieldsShape(create-todo/create-todos 共有)ではなく create-todo 専用の
// createTodoInputShape にだけ additive に足す(バッチ item には出さない)。
//
// 【structuredLocation 明示 vs location 自動解決の2経路】
// - structuredLocation を明示 → その座標をそのまま使う(autoResolve しない。create-event の
//   structuredLocation と同じ思想 = 呼び出し側が確定済みの座標を渡すのが最も確実)。lat/lon 必須
//   (proximity は geo が無いと geofence を定義できない — #51 の「中途半端な iOS 非互換を作らない」裁定)。
// - location(文字列)のみ → サーバーが autoResolveLocation(既知の場所 → geocoding)で座標へ解決。
//   解決できたら proximity VALARM を書き、解決不能ならツールをエラーにする(位置なし todo を作らない)。
//
// 【trigger enum が "arrive" のみの理由(G2 ゲート)】
// domain の buildProximityAlarm は ARRIVE/DEPART 両対応だが、DEPART(leave)の実機挙動は G2 ゲート
// (docs/modeling/06)通過まで未検証。未検証の値を MCP に公開して「離れたら通知」が実は鳴らない、
// という誤解を生まないよう、公開 enum は "arrive" のみに絞る(domain は対称なので G2 通過後に enum を
// 増やすだけで済む)。
const proximityStructuredLocationShape = z
	.object({
		// 【structuredLocationInputSchema(create-event 用)を再利用しない理由: 宣言順 + geo 必須の差】
		// structuredLocationInputSchema は下方(create-event 節)で定義され、かつ lat/lon が optional
		// (geo 無しは LOCATION へ degrade する VEVENT の仕様)。位置リマインダーは geo 必須なので shape が
		// そもそも異なる。前方参照も避けたいので、proximity 専用の小さな shape をここに独立して定義する。
		title: z.string().min(1).describe("場所の表示名(例「自宅」「オフィス」)。X-TITLE になる。"),
		address: z.string().optional().describe("住所(表示用の補足)。省略可。"),
		lat: z.number().describe("緯度(必須)。geofence の中心。"),
		lon: z.number().describe("経度(必須)。geofence の中心。"),
		radius: z.number().positive().optional().describe("geofence 半径(メートル)。省略可。"),
	})
	.describe("解決済みの座標付き場所を明示する(search-location/list-known-locations の結果を写す)。指定するとサーバー側の自動解決をスキップする。");

const locationReminderInputSchema = z
	.object({
		location: z.string().min(1).describe(
			'場所名または住所(例「自宅」「品川の叙々苑」)。structuredLocation を明示しない場合、サーバーが' +
				"既知の場所 → 地図検索の順で座標へ自動解決する。解決できないとツールはエラーを返す(位置なしでは登録しない)。",
		),
		trigger: z
			.enum(["arrive"])
			.default("arrive")
			.describe('通知の向き。"arrive"=その場所に着いたら通知(現状 arrive のみ対応)。'),
		radius: z.number().positive().optional().describe("geofence 半径(メートル)。省略可。"),
		structuredLocation: proximityStructuredLocationShape.optional(),
	})
	.describe(
		"位置(geofence)リマインダー。iOS の「指定した場所に着いたら通知」= proximity VALARM を書く。" +
			"座標は structuredLocation を明示するか、location 文字列からサーバーが自動解決する(解決不能ならエラー)。",
	);

const createTodoInputShape = {
	...createTodoItemFieldsShape,
	locationReminder: locationReminderInputSchema.optional().describe(
		"位置リマインダー(その場所に着いたら通知)。省略時は位置通知なし。",
	),
	timeZone: z.string().optional().describe(
		'due が時刻付き("YYYY-MM-DDTHH:MM:SS")のときの IANA タイムゾーン名(例 "Asia/Tokyo")。必須' +
			"(省略時はエラー・暗黙 UTC フォールバックはしない)。DST ゾーン(例 America/New_York)は" +
			"サーバー側 VTIMEZONE 生成が Phase 1 で未対応のためエラーになる — 固定オフセットゾーンのみ対応。" +
			"due が終日または省略のときは無視する。",
	),
	calendarId: z.string().optional().describe('保存先コレクション ID。省略時は "tasks"。'),
};

// --- create-todos(2026-07-14: 複数件を1呼び出しでまとめて追加するバッチツール)---------------
// 【動機】実運用で「5冊追加して」のような複数件依頼に対し、ホストモデルが create-todo を
// 5回呼び、1呼び出し=1カード仕様のホスト UI にフル一覧カードが5枚積まれる実害が発生した
// (E-2 の becoming UI は「1回の mutate = 1カードに N 行が becoming-in」を前提にしており、
// 複数件を複数呼び出しに分解すると前提が崩れる)。語彙の穴なのでバッチツールで塞ぐ。
// 【timeZone/calendarId を items 配列の外(バッチ共通)にした理由】仕様どおり「5冊追加して」の
// ような依頼は同一コレクション・同一タイムゾーンへの追加が大半で、item ごとに異なる
// calendarId/timeZone を許すと入力が複雑になるわりに実運用の需要が薄い。将来 item ごとに
// 分けたい要求が出たら、その時点で items 側にオーバーライド用の optional フィールドを足す
// (今は shape を素朴に保つ)。
const createTodosInputShape = {
	items: z
		.array(z.object(createTodoItemFieldsShape))
		.min(1)
		.max(25)
		.describe(
			"追加するリマインダーの配列(1〜25件)。各要素は create-todo と同じ語彙" +
				"(title 必須、notes/due/priority/recurrence は省略可)。25件を超える場合は入力エラーになる" +
				"(1回の呼び出しで大量投入して D1 書込みや sync token に負荷をかけないための上限)。",
		),
	calendarId: z.string().optional().describe('保存先コレクション ID(全 item 共通)。省略時は "tasks"。'),
	timeZone: z.string().optional().describe(
		"items[].due が時刻付き(\"YYYY-MM-DDTHH:MM:SS\")のときの IANA タイムゾーン名(全 item 共通)。" +
			"create-todo と同じ制約(省略時エラー・DST ゾーン未対応)。",
	),
};

/**
 * recurrence 入力(frequency:"none" を含む presentation 限定の5値)を application 層の
 * CreateTodoRecurrenceInput(4値のみ)へ正規化する共通ヘルパー。create-todo / create-todos の
 * 両方から呼ぶ(recurrence の判別ロジックを二重管理しないため、上の createTodoRecurrenceInputShape
 * コメント「Case E 採用」の吸収処理をここに1本化する)。
 *
 * 【エラーを戻り値ではなく throw にした理由】create-todo は1件だけなので早期 return で
 * toolError を返せたが、create-todos は「1 item の失敗は他の item を止めない」仕様
 * (下の create-todos handler 参照)。呼び出し側の item ループが try/catch で
 * 個別に失敗を拾えるよう、他の検証エラー(InvalidDueError 等)と同じ「例外を投げる」流儀に揃える。
 */
function normalizeCreateTodoRecurrenceInput(
	recurrence: z.infer<typeof createTodoRecurrenceInputShape> | undefined,
): CreateTodoRecurrenceInput | undefined {
	if (recurrence === undefined) return undefined;
	if (recurrence.frequency === "none") {
		const hasSubfields =
			recurrence.interval !== undefined ||
			recurrence.weekdays !== undefined ||
			recurrence.count !== undefined ||
			recurrence.until !== undefined;
		if (hasSubfields) {
			throw new RangeError(
				'recurrence.frequency:"none"(繰り返さない)は interval/weekdays/count/until と併用できません。' +
					"繰り返しを設定する場合は frequency に daily/weekly/monthly/yearly のいずれかを指定してください。",
			);
		}
		return undefined;
	}
	// ここに来る時点で recurrence.frequency は "none" ではないと絞り込み済みなので、
	// application 層の CreateTodoRecurrenceInput["frequency"](4値のみ)にそのまま代入できる。
	return { ...recurrence, frequency: recurrence.frequency };
}

// update-todo 用の recurrence 入力 shape(2026-07-15。create と語彙は完全対称)。
// 【create の shape をそのまま再利用し describe だけ差し替える理由】判別ロジック(頻度 enum・
// count/until 排他・weekdays weekly 限定・.strict() の未知キー拒否)を二重管理しないため、
// createTodoRecurrenceInputShape をベースに update 固有の意味(frequency:"none"=RRULE 除去)だけを
// describe で上書きする。.describe() は ZodObject を保つので .strict()/フィールド/default("none")は
// すべて引き継がれる。
const updateTodoRecurrenceInputShape = createTodoRecurrenceInputShape.describe(
	'反復の設定/変更/除去。frequency:"none"(または recurrence:{} の既定)=反復を除去(RRULE を消す)。' +
		"daily/weekly/monthly/yearly=その反復に全置換する(部分マージしない — 常に完全なプリセットを送ること)。" +
		"設定/変更時は due が必須(既存 due か、同時に指定する新 due をアンカーにする)。" +
		"count と until は同時指定不可(RFC 5545 の排他規則)。",
);

/**
 * update-todo の recurrence 入力(presentation 5値 + optional)を application の三値
 * (undefined=据え置き / null=除去 / CreateTodoRecurrenceInput=全置換)へ正規化する(2026-07-15)。
 *
 * 【create の normalize と分ける理由】create では frequency:"none" も「recurrence 省略」も
 * どちらも「RRULE を作らない」=undefined に畳めた。だが update では:
 *   - recurrence 省略(undefined) = 既存 RRULE を据え置く
 *   - frequency:"none"           = 既存 RRULE を**除去**する(null)
 * と意味が分岐するため、none を undefined ではなく null に写す専用の正規化が要る。
 * none + サブフィールド併用の拒否は create と同じ(黙って設定を捨てない)ので、その検査だけ共有する。
 */
function normalizeUpdateTodoRecurrenceInput(
	recurrence: z.infer<typeof updateTodoRecurrenceInputShape> | undefined,
): CreateTodoRecurrenceInput | null | undefined {
	if (recurrence === undefined) return undefined; // 据え置き(RRULE を触らない)。
	if (recurrence.frequency === "none") {
		// none + サブフィールド併用は矛盾なのでエラー(create と同一の検査。意図した設定を黙殺しない)。
		const hasSubfields =
			recurrence.interval !== undefined ||
			recurrence.weekdays !== undefined ||
			recurrence.count !== undefined ||
			recurrence.until !== undefined;
		if (hasSubfields) {
			throw new RangeError(
				'recurrence.frequency:"none"(反復の除去)は interval/weekdays/count/until と併用できません。' +
					"反復を設定する場合は frequency に daily/weekly/monthly/yearly のいずれかを指定してください。",
			);
		}
		return null; // 除去。
	}
	return { ...recurrence, frequency: recurrence.frequency }; // 全置換(4値へ絞り込み済み)。
}

// --- update-todo / complete-todo / delete-todo(方向性 E-1 スライス②-b)-------------

const updateTodoInputShape = {
	id: z.string().describe("更新対象の VTODO UID(create-todo/list-todos が返す id)。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	title: z.string().optional().describe("SUMMARY(タイトル)。省略時は変更しない。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ)。省略時は変更しない。"),
	due: z.string().nullable().optional().describe(
		'期日(create-todo と対称。2026-07-14 V6 フォローアップ)。三値 + 2形態:' +
			' 省略=変更しない / null=期日を外す / "YYYY-MM-DD"(終日)/ "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組で指定)。' +
			"offset 付き ISO8601(例 \"...+09:00\"/\"...Z\")は不可(TZID を一意に導出できないため)。" +
			"時刻付きに変更すると DTSTART;TZID/DUE;TZID を立て、必要なら VTIMEZONE をサーバーが同梱する。" +
			"反復 VTODO(RRULE あり)の期日除去は拒否する(DTSTART が反復アンカーのため — 先に繰り返しを解除すること)。",
	),
	// 2026-07-17 TZ グラウンディング: この timeZone は「due 解釈用」に加えて「応答一覧の due 表示ゾーン」も
	// 兼ねる(handler が buildTodosViewModel に流用)。due が時刻付きでない編集/完了/再開でも、UI カードは
	// 閲覧デバイスのゾーンを載せてくることで確定一覧の時刻付き DUE が UTC 落ちしなくなる。
	timeZone: z.string().optional().describe(
		'IANA タイムゾーン名(例 "Asia/Tokyo")。用途は2つ: (1)due を時刻付き("YYYY-MM-DDTHH:MM:SS")に' +
			"変更するときの解釈ゾーン(そのときは必須・省略時エラー・暗黙 UTC フォールバックなし)、" +
			"(2)応答で返す確定一覧の due 表示ゾーン(省略時は UTC)。DST ゾーン(例 America/New_York)は" +
			"サーバー側 VTIMEZONE 生成が Phase 1 で未対応のため time 付き due 指定時はエラー — 固定オフセットゾーンのみ対応。",
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。0 を渡すと未設定に戻る。省略時は変更しない。",
	),
	// 【B(> 2026-07-17 実機 FB 第2ラウンド): VTODO の自由テキスト LOCATION 引数を全廃】create-todo と同じ理由 —
	// テキスト location を引数に出すと、LLM が「◯◯に着いたら通知」を LOCATION 書き込みで済ませて geofence
	// 通知だと誤解させる罠になる(iOS の場所リマインダーは proximity VALARM。設計 05 §1-a)。proximity の
	// 書き込みは C8(author 規約)で正しい形(VALARM)として入る予定。それまで自由テキスト location の書き込み口は
	// LLM に見せない。VEVENT の location(会議/場所)は別物なので update-event 側は温存。読み取り(Task.location)も温存。
	// recurrence(2026-07-15 追加): 反復の設定/変更/除去。updateTodoRecurrenceInputShape 参照。
	recurrence: updateTodoRecurrenceInputShape.optional().describe(
		'反復リマインダーの設定/変更/除去。省略=変更しない / frequency:"none"=反復を除去 /' +
			"daily/weekly/... =その反復に全置換。設定/変更時は due(既存 or 同時指定)が必須。",
	),
	// locationReminder(#51 Phase 1): 位置リマインダーの設定/変更/除去。create-todo と同じ shape に
	// nullable を足して三値にする(省略=変更しない / null=除去 / オブジェクト=設定・差し替え)。
	locationReminder: locationReminderInputSchema.nullable().optional().describe(
		"位置(geofence)リマインダーの設定/変更/除去。省略=変更しない / null=位置通知を外す /" +
			"オブジェクト=設定・差し替え(structuredLocation 明示か location 文字列の自動解決。解決不能ならエラー)。",
	),
	status: z.enum(["COMPLETED", "NEEDS-ACTION"]).optional().describe(
		"STATUS の遷移。COMPLETED で完了・NEEDS-ACTION で未完了に戻す。省略時は変更しない。" +
			"反復 VTODO(RRULE あり)への COMPLETED 指定は complete-todo と同じ D4 モデル" +
			"(新 UID の完了スナップショットを作り、マスターを次回 occurrence へ前進させる)で処理する。",
	),
};

// timeZone を complete/delete/move にも additive に足す(2026-07-17 TZ グラウンディング)。
// これらの mutate は応答で確定一覧(TodosViewModel)を組み直すため、応答表示ゾーンに使う。
// optional・既定 UTC(resolveTimeZone)は不変なので LLM 経路の後方互換は保たれる — UI カードが
// 常に閲覧デバイスの IANA ゾーンを渡すことで、時刻付き DUE の一覧表示が UTC 落ちしなくなる。
const mutateTimeZoneField = z.string().optional().describe(
	"応答一覧の due 表示 + floating/DATE 解釈に使う IANA タイムゾーン。省略時は UTC。UI は閲覧デバイスの" +
		"ゾーンを渡す(このツールで完了/削除/移動しても対象タスクの ICS 自体は変えず、応答表示ゾーンにだけ影響)。",
);

const completeTodoInputShape = {
	id: z.string().describe("完了対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	timeZone: mutateTimeZoneField,
};

const deleteTodoInputShape = {
	id: z.string().describe("削除対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
	timeZone: mutateTimeZoneField,
	confirmToken: confirmTokenField,
};

// move-todo の入力(UI 詳細シート「リスト ›」からのコレクション間移動)。move-todo.ts 冒頭コメント
// のとおり DAV MOVE(RFC 4918 §9.9)実装はスコープ外の MCP 専用ツール。
const moveTodoInputShape = {
	id: z.string().describe("移動対象の VTODO UID。"),
	calendarId: z.string().optional().describe('移動元コレクション ID。省略時は "tasks"。'),
	toCalendarId: z.string().describe("移動先コレクション ID(list-calendars/create-calendar が返す id)。"),
	timeZone: mutateTimeZoneField,
};

// --- create-event / create-events / update-event / delete-event(E-3 スライス S1)--------------
// 【create-todo 系の shape 語彙を最大限踏襲する】recurrence は create/update それぞれ todos の
// shape(createTodoRecurrenceInputShape / updateTodoRecurrenceInputShape)をそのまま再利用する
// (判別ロジックの二重管理を避ける — normalizeCreateTodoRecurrenceInput 等も共有できる)。
// start/end の形式規約は create-todo の due と同じ("YYYY-MM-DD" 終日 / "...T..." 時刻付き)。
// C8(設計 05 §1-b・§2「場所」スロット): structuredLocation の shape(create/update 共通)。
// 【location との使い分け(LLM trap 回避)】todos の location 撤去(過去タスク)と同じ精神で、
// 「テキストの場所」(location・自由記述の LOCATION)と「構造化された場所」(structuredLocation・
// 座標付き)を describe で明確に書き分ける。LLM が両方同時に埋めがちな罠を避けるため、
// structuredLocation.describe に「location とは独立に扱われ、両方指定した場合は
// structuredLocation.title が表示テキストを上書きする」ことを明記する(vevent-write.ts の
// author 規約と同じ挙動を LLM 向けに説明)。
const structuredLocationInputSchema = z
	.object({
		title: z.string().min(1).describe("表示名(例「岐阜大学」「福登の自宅」)。LOCATION テキストにもこの値が使われる(location フィールドより優先)。"),
		address: z.string().optional().describe("住所(表示用の補足テキスト)。省略可。geo 無しのときはこの住所が LOCATION に併記される。"),
		// #45 スライス B: lat/lon を optional に緩和(住所のみでの登録 = degrade を許す)。
		lat: z.number().min(-90).max(90).optional().describe("緯度(WGS84)。lon とセットで指定(片方だけは不可)。省略すると座標無しの住所表現になる。"),
		lon: z.number().min(-180).max(180).optional().describe("経度(WGS84)。lat とセットで指定(片方だけは不可)。省略すると座標無しの住所表現になる。"),
		radius: z.number().positive().optional().describe("ジオフェンス半径(メートル)。省略可(半径なしの地点として扱う)。"),
	})
	// lat/lon は「両方あるか両方無いか」。片方だけの部分 geo は座標として成立しないので入力段で弾く
	// (application 層 validateStructuredLocation の geo-partial と同じ契約を presentation でも早期化)。
	.refine((v) => (v.lat === undefined) === (v.lon === undefined), {
		message: "lat と lon は両方指定するか、両方省略してください(片方だけは不可)。",
	})
	.describe(
		"構造化された場所。search-location(地図検索)で解決した候補や list-known-locations の既知の場所を写して使う。" +
			"lat/lon を付けると iOS の地図表示・経路案内が効く。search-location で解決できない(0件・枠切れ)場合は " +
			"lat/lon を省略し title と address だけでも登録できる(degrade: 地図ピンは付かないが場所名・住所は残る)。" +
			'自由記述のテキストだけを設定したい場合は location フィールドを使うこと(structuredLocation は "その場所そのもの" を表す)。',
	);

// =============================================================================
// #locationAutoResolve — create-event/create-events/update-event のサーバー側自動ジオコーディング
// =============================================================================
// 【背景・実機で確定した問題】claude.ai iOS(Haiku 4.5)が search-location を呼ばず
// create-event {location:"品川のホテルの叙々苑"} を直に呼び、素の LOCATION テキストだけの iOS で
// 地図に出ないイベントができた(D1 実測: 9681d4a0-… は X-APPLE-STRUCTURED-LOCATION 無し)。
// description でのツール誘導(search-location を先に呼べ)はモデル品質に依存し確実ではないため、
// structuredLocation が渡されず location(文字列)だけ渡されたときはサーバー側で自動的に
// structuredLocation へ昇格させる(モデルの協力に頼らない構造的な対策)。
//
// 【絶対に守る不変条件】場所解決は best-effort。known-locations 走査の失敗・geocoding の quota 超過/
// キー未設定/プロバイダ障害はすべてここで握りつぶし、例外を外へ投げない。イベント作成/更新自体を
// 場所解決の失敗で失敗させることは絶対にしない(下の autoResolveLocation が例外を投げない設計に
// なっているのはこのため — 呼び出し側の create-event/update-event ハンドラは try/catch すら不要)。
//
// 【優先順位: known-locations → geocoding】要件2-a/b。known-locations(ユーザー自身が過去に確定させた
// 構造化場所)の方が地図検索の先頭候補より信頼できる、という判断は search-location ツールの
// description(「まず list-known-locations を見る」)と同じ思想。geocoding は search-location と
// 同じ GeocodingPort インスタンス(app.ts で quota ガード済みのものが配線される)を使うので、
// 自動解決も月次 quota を消費する(quota 超過時は (c) の「失敗」に落ちてテキストのみ登録になる —
// quota を使い切っても create-event は落ちない)。
// =============================================================================

/** autoResolveLocation の結果種別(telemetry の locationAutoResolve 属性にもそのまま載せる)。 */
type LocationAutoResolveOutcome =
	| { kind: "known" | "geocoding"; structuredLocation: StructuredLocationInput; title: string; address: string | null }
	| { kind: "failed" };

/**
 * location 文字列が既知の場所(KnownLocation)の title/address と部分一致するか。
 * 【なぜ「部分一致」という素朴な基準か】ユーザーは「品川のホテルの叙々苑」のように、known の title
 * (例「叙々苑 品川店」)を含む/含まれる自由な言い回しで location を埋めてくる想定なので、完全一致は
 * 厳しすぎて何もヒットしない。逆に類似度スコアリング等の高度なマッチングは過剰(known-locations は
 * ユーザー本人の過去データなので偽陽性の実害が小さい上、誤マッチしても structuredLocation.title が
 * LOCATION 表示を上書きするだけなので気付きやすい — geocoding よりよほど安全側)。address 側にも
 * 同じ基準を適用する(「東京都千代田区」のような住所断片一致にも対応するため)。
 */
function matchesKnownLocation(locationText: string, known: KnownLocation): boolean {
	const loc = locationText.trim();
	if (loc === "") return false;
	const title = known.title.trim();
	if (title !== "" && (loc.includes(title) || title.includes(loc))) return true;
	const address = known.address?.trim();
	if (address !== undefined && address !== "" && (loc.includes(address) || address.includes(loc))) return true;
	return false;
}

/**
 * location(自由記述テキスト)から structuredLocation を自動解決する(ファイル冒頭コメント参照)。
 * 呼び出し側は「structuredLocation が明示されておらず、location だけが渡された」場合にのみ呼ぶこと
 * (明示的な structuredLocation を上書きしない・要件2)。
 */
async function autoResolveLocation(
	deps: McpAppDeps,
	principal: PrincipalRef,
	locationText: string,
): Promise<LocationAutoResolveOutcome> {
	const trimmed = locationText.trim();
	if (trimmed === "") return { kind: "failed" };

	// (a) known-locations 優先。calendarId を絞らず owner 配下全体を走査する(ListKnownLocations の
	// 既定 = list-known-locations ツールと同じ「場所は予定/リマインダーどちらにあるか事前に分からない」
	// 判断を踏襲)。D1 障害等で例外が飛んでも geocoding フォールバックへ続行する(不変条件: 例外を外に
	// 投げない)。
	try {
		const listKnownLocations = new ListKnownLocations(deps.collectionRepo, deps.resourceRepo);
		const { locations } = await listKnownLocations.execute({ owner: principal });
		const hit = locations.find((loc) => matchesKnownLocation(trimmed, loc));
		if (hit !== undefined) {
			return {
				kind: "known",
				structuredLocation: {
					title: hit.title,
					...(hit.address !== null ? { address: hit.address } : {}),
					lat: hit.lat,
					lon: hit.lon,
					...(hit.radius !== null ? { radius: hit.radius } : {}),
				},
				title: hit.title,
				address: hit.address,
			};
		}
	} catch {
		// known-locations 走査の失敗は無視して (b) へ続行(best-effort・上のファイル冒頭コメント参照)。
	}

	// (b) geocoding フォールバック。search-location ツールと同じ deps.geocoding インスタンス
	// (quota ガード込み)を使うため、自動解決も quota を消費する(ファイル冒頭コメント)。
	try {
		const candidates = await deps.geocoding.searchLocation(trimmed, { limit: 1 });
		const top = candidates[0];
		if (top !== undefined) {
			return {
				kind: "geocoding",
				structuredLocation: {
					title: top.title,
					...(top.address !== null ? { address: top.address } : {}),
					lat: top.geo.lat,
					lon: top.geo.lon,
				},
				title: top.title,
				address: top.address,
			};
		}
	} catch {
		// (c) quota 超過・キー未設定・プロバイダ障害いずれも握りつぶす。search-location と違い、
		// ここは create-event/update-event の付随処理なので isError にしてはいけない
		// (不変条件: 場所解決の失敗でイベント作成/更新自体を失敗させない)。
	}

	return { kind: "failed" };
}

/** autoResolveLocation の成功時、人間可読の一文を組み立てる(要件3)。 */
function describeAutoResolvedLocation(outcome: Extract<LocationAutoResolveOutcome, { kind: "known" | "geocoding" }>): string {
	const addressPart = outcome.address !== null ? `(${outcome.address})` : "";
	return `場所「${outcome.title}」を解決しました${addressPart}。`;
}

// 失敗時(0件・quota 超過・キー未設定・プロバイダ障害いずれも区別せず「解決できなかった」として
// 同一メッセージにまとめる — quota 超過等の詳細を create-event の応答で逐一説明すると本題(予定作成)
// から気を逸らすノイズになるため。詳細を知りたい場合は search-location を明示的に呼べば個別メッセージが
// 得られる(search-location の description に誘導文を残す理由 — 要件4)。
const LOCATION_AUTO_RESOLVE_FAILED_NOTE = "場所はテキストのみで登録しました(地図ピンなし)。";

// --- locationReminder の座標解決(#51 Phase 1)-------------------------------------------------
// create-todo/update-todo の locationReminder 入力を domain の ProximityAlarmInput(geo 必須)へ写す。
// structuredLocation 明示ならそれを、無ければ autoResolveLocation で location 文字列を座標へ解決する。
// 解決不能なら例外を投げる(呼び出し側 handler の catch-all が toolError に変換 = 位置なし todo を作らない)。

/** locationReminder が解決不能なとき投げるエラー(handler の catch-all がメッセージをそのまま返す)。 */
class LocationReminderUnresolvedError extends Error {
	constructor(locationText: string) {
		// 「search-location で候補確認 or 場所名を具体化」を必ずメッセージに含める(#51 の要件)。
		super(
			`位置リマインダーの場所「${locationText}」を解決できませんでした。search-location で候補を確認するか、` +
				"場所名をより具体的に指定してください(位置が確定できないリマインダーは作成しません)。",
		);
		this.name = "LocationReminderUnresolvedError";
	}
}

/** resolveLocationReminder の結果。proximity(ProximityAlarmInput)+ 応答 content 用の人間可読ノート。 */
interface ResolvedLocationReminder {
	proximity: ProximityAlarmInput;
	// 誤った場所で通知が鳴る実害を避けるため、解決した title/address を応答に明示する(#51 要件)。
	note: string;
}

async function resolveLocationReminder(
	deps: McpAppDeps,
	principal: PrincipalRef,
	// zod で検証済みの locationReminder(structuredLocation は lat/lon 必須・trigger は "arrive" のみ)。
	input: { location: string; trigger: "arrive"; radius?: number; structuredLocation?: { title: string; address?: string; lat: number; lon: number; radius?: number } },
): Promise<ResolvedLocationReminder> {
	// (1) structuredLocation 明示: autoResolve せずそのまま使う(create-event と同じ「明示を上書きしない」思想)。
	if (input.structuredLocation !== undefined) {
		const sl = input.structuredLocation;
		const proximity: ProximityAlarmInput = {
			title: sl.title,
			...(sl.address !== undefined ? { address: sl.address } : {}),
			lat: sl.lat,
			lon: sl.lon,
			trigger: input.trigger,
			// radius は reminder 直下の指定を優先し、無ければ structuredLocation 側の radius を使う。
			...(input.radius ?? sl.radius) !== undefined ? { radius: input.radius ?? sl.radius } : {},
		};
		const addressPart = sl.address !== undefined ? `(${sl.address})` : "";
		return { proximity, note: `位置リマインダーの場所「${sl.title}」${addressPart}を設定しました。` };
	}

	// (2) location 文字列を自動解決(既知の場所 → geocoding)。autoResolveLocation は例外を投げない設計
	// (create-event 用に「失敗は握りつぶす」)だが、位置リマインダーでは解決不能を許容しないので、
	// failed / geo 欠落のときはここで LocationReminderUnresolvedError を投げてツールをエラーにする。
	const outcome = await autoResolveLocation(deps, principal, input.location);
	if (outcome.kind === "failed") {
		throw new LocationReminderUnresolvedError(input.location);
	}
	const sl = outcome.structuredLocation;
	// autoResolveLocation の known/geocoding 経路は必ず lat/lon を埋める(StructuredLocationInput の
	// 型上は optional だが実装上は常に設定)。防御的に geo 欠落なら「解決不能」に倒す(geo 無し proximity は作らない)。
	if (sl.lat === undefined || sl.lon === undefined) {
		throw new LocationReminderUnresolvedError(input.location);
	}
	const proximity: ProximityAlarmInput = {
		title: sl.title,
		...(sl.address !== undefined ? { address: sl.address } : {}),
		lat: sl.lat,
		lon: sl.lon,
		trigger: input.trigger,
		...(input.radius ?? sl.radius) !== undefined ? { radius: input.radius ?? sl.radius } : {},
	};
	const addressPart = outcome.address !== null ? `(${outcome.address})` : "";
	return { proximity, note: `位置リマインダーの場所「${outcome.title}」${addressPart}を解決しました。` };
}

// C8(設計 05 §1-c・§2「会議」スロット): conference の shape(create/update 共通)。
const conferenceInputSchema = z
	.object({
		provider: z.string().optional().describe("表示用のラベル(例 \"Google Meet\"・\"Zoom\")。ICS には保存されない(ワイヤに載るのは url のみ)。"),
		url: z.string().describe(
			"参加(Join)リンク。http(s) URL のみ受け付ける(§1-c: 読み取り側が会議と認識できる形にする必要があるため)。",
		),
	})
	.describe(
		'会議(ビデオ通話の Join リンク)。既存の url フィールド(参照 URL・お知らせページ等)とは別物 — ' +
			"conference は DESCRIPTION に「ビデオ通話」ブロックとして書かれ、実機で「参加」ボタンとして解釈される。" +
			"参照リンクを会議として使い回したいときは、url とは別に conference.url にも同じ値を明示すること" +
			"(自動昇格はしない)。",
	);

const createEventItemFieldsShape = {
	title: z.string().describe("SUMMARY(タイトル)。"),
	notes: z.string().optional().describe("DESCRIPTION(メモ本文)。会議(conference)を指定すると、この本文の末尾に" + "「ビデオ通話」ブロックが自動追記される(本文自体は変更されない)。"),
	start: z.string().describe(
		'開始(DTSTART・必須)。2形態: "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組)。' +
			"offset 付き ISO8601 は不可(TZID を一意に導出できないため)。",
	),
	end: z.string().optional().describe(
		'終了(DTEND・省略可・排他的終端)。start と同じ2形態で、値型(終日/時刻付き)は start と一致させること。' +
			"start より後でなければならない。終日1日イベントや開始のみのイベントは end を省略してよい。",
	),
	location: z.string().optional().describe(
		"LOCATION(場所)。§3.8.1.7 の TEXT。空文字は未設定と同義。" +
			"structuredLocation を省略してこのフィールドだけ渡すと、サーバーが自動的に既知の場所/地図検索で" +
			"座標を解決して structuredLocation へ昇格させる(#locationAutoResolve・失敗時はテキストのまま登録され、" +
			"作成/更新自体が失敗することはない)。地図ピンを確実に付けたい・複数候補から選びたい場合は" +
			"search-location で事前に解決して structuredLocation を明示してもよい。",
	),
	url: z.string().optional().describe(
		"URL(§3.8.4.6・URI 値型)。予定に紐づく詳細ページ/ミーティングリンク等。空文字は未設定と同義。",
	),
	recurrence: createTodoRecurrenceInputShape.optional().describe(
		'反復指定(create-todo と同一語彙)。frequency:"none"=反復しない。DTSTART をアンカーにする。',
	),
	alarms: z
		.array(z.number().int().min(0))
		.max(2)
		.optional()
		.describe(
			"通知(開始相対アラーム)。開始の何分前に鳴らすかの列(0=開始時刻ちょうど)。最大2件・重複不可・負値不可。" +
				"iOS のプリセット語彙は 5/10/15/30/60/120/1440/2880/10080 分前。",
		),
	travelMinutes: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("移動時間(X-APPLE-TRAVEL-DURATION・分)。正整数。省略なら設定しない。"),
	// C8(設計 05): 場所(structuredLocation)/ 会議(conference)。既存 location/url とは additive
	// (両者を混同しないための describe は各 schema コメント参照)。proximity(到着/出発通知)の
	// write は本フォーム(vevent)のスコープ外 — VALARM 到着/出発は vtodo 用(設計 05 §6 C8 に
	// 含まれるが、create-todo 側の後続タスクへ送る。§1-a の X-APPLE-PROXIMITY VALARM 書き出しは
	// このリリースでは実装しない)。
	structuredLocation: structuredLocationInputSchema.optional(),
	conference: conferenceInputSchema.optional(),
};

const createEventInputShape = {
	...createEventItemFieldsShape,
	timeZone: z.string().optional().describe(
		'start/end が時刻付きのときの IANA タイムゾーン名(例 "Asia/Tokyo")。必須(省略時エラー・暗黙 UTC 禁止)。' +
			"DST ゾーンは VTIMEZONE 生成 Phase 1 未対応でエラー(固定オフセットゾーンのみ)。終日のときは無視する。",
	),
	calendarId: z.string().optional().describe('保存先コレクション ID。省略時は "calendar"。'),
};

// create-events(バッチ)。create-todos と同じ規律(≤25・timeZone/calendarId はバッチ共通)。
const createEventsInputShape = {
	items: z
		.array(z.object(createEventItemFieldsShape))
		.min(1)
		.max(25)
		.describe(
			"追加するイベントの配列(1〜25件)。各要素は create-event と同じ語彙(title/start 必須)。" +
				"25件を超える場合は入力エラー(D1 書込み/sync token への負荷を抑える上限)。",
		),
	calendarId: z.string().optional().describe('保存先コレクション ID(全 item 共通)。省略時は "calendar"。'),
	timeZone: z.string().optional().describe(
		'items[].start/end が時刻付きのときの IANA タイムゾーン名(全 item 共通)。create-event と同じ制約。',
	),
};

const updateEventInputShape = {
	id: z.string().describe("更新対象の VEVENT UID(create-event/list-events-expanded が返す id)。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "calendar"。'),
	title: z.string().optional().describe("SUMMARY。省略時は変更しない。"),
	notes: z.string().optional().describe("DESCRIPTION。省略時は変更しない。"),
	start: z.string().optional().describe(
		'開始(DTSTART)。省略=変更しない / "YYYY-MM-DD"(終日)/ "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組)。' +
			"開始は除去できない(イベントに開始は必須)。",
	),
	end: z.string().nullable().optional().describe(
		"終了(DTEND)。省略=変更しない / null=終了を外す(開始のみのイベントにする)/ 文字列=設定(start と同2形態)。",
	),
	timeZone: z.string().optional().describe(
		'start/end が時刻付きのときの IANA タイムゾーン名。create-event と同じ制約(省略時エラー・DST 未対応)。',
	),
	location: z.string().nullable().optional().describe(
		"LOCATION。省略=変更しない / null=場所を外す / 文字列=差し替え。" +
			"structuredLocation を省略してこのフィールドだけで場所を変えると、サーバーが自動的に structuredLocation へ" +
			"昇格を試みる(#locationAutoResolve・create-event と同じ挙動。ただし変更前と同じ文字列に差し替えたときは" +
			"再解決しない)。",
	),
	url: z.string().nullable().optional().describe(
		"URL(§3.8.4.6)。省略=変更しない / null=URL を外す / 文字列=差し替え。",
	),
	recurrence: updateTodoRecurrenceInputShape.optional().describe(
		'反復の設定/変更/除去。省略=変更しない / frequency:"none"=反復を除去 / daily/weekly/... =その反復に全置換。',
	),
	alarms: z
		.array(z.number().int().min(0))
		.max(2)
		.nullable()
		.optional()
		.describe(
			"通知(開始相対アラーム)。省略=変更しない / null=全て外す / 配列=全置換(開始の n 分前の列・最大2件)。" +
				"他クライアントが付けた絶対時刻/位置アラームは温存する。",
		),
	travelMinutes: z
		.number()
		.int()
		.positive()
		.nullable()
		.optional()
		.describe("移動時間(X-APPLE-TRAVEL-DURATION・分)。省略=変更しない / null=外す / 正整数=設定。"),
	// C8(設計 05): 場所(structuredLocation)/ 会議(conference)の三値 patch。
	structuredLocation: structuredLocationInputSchema
		.nullable()
		.optional()
		.describe(
			"構造化された場所。省略=変更しない / null=構造化データのみ除去(LOCATION テキストは温存。" +
				"表示テキストも外したい場合は location:null を併用)/ オブジェクト=設定・差し替え" +
				"(LOCATION も title で上書き)。",
		),
	conference: conferenceInputSchema
		.nullable()
		.optional()
		.describe(
			"会議(Join リンク)。省略=変更しない / null=DESCRIPTION から会議ブロックのみ除去(notes 本文は温存)/ " +
				"オブジェクト=設定・差し替え。",
		),
};

const deleteEventInputShape = {
	id: z.string().describe("削除対象の VEVENT UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "calendar"。'),
	// S1(docs/modeling/14): 確認トークン(§4 Tier A)。confirmTokenField 定義箇所コメント参照。
	confirmToken: confirmTokenField,
};

// #45 場所モデル: search-location の入力。query は内容データ(店名・施設名・住所の自由記述)。
// 【telemetry: query を argsDigest に載せない】query は IDENTIFIER_KEYS(telemetry-support.ts)に
// 入っていないので summarizeArgsDigest は "string" とだけ記録し値は漏らさない(内容データ禁止の規律)。
// 呼び出し回数と ok/errKind(quota 超過等)だけで効果測定できる、というタスク要件どおりの扱いになる。
const searchLocationInputShape = {
	query: z.string().min(1).describe(
		"解決したい場所の文字列(店名・施設名・住所)。例「東京駅」「品川の叙々苑」「岐阜市橋本町1丁目10-1」。" +
			"ユーザーが口にした表現をそのまま渡してよい(内部で地図検索プロバイダに問い合わせる)。",
	),
};

// C5(設計 05 §3・§5・§6): list-known-locations の入力。
const listKnownLocationsInputShape = {
	calendarId: z.string().optional().describe(
		"走査対象コレクション ID。省略時は認証ユーザー配下の全カレンダー/リマインダーリストを横断して集計する" +
			"(構造化場所がどのコレクションにあるか事前に分からないため。単一コレクションに絞りたい場合のみ指定)。",
	),
};

const listTodosInputShape = {
	includeCompleted: z.boolean().optional().describe("完了済み(STATUS:COMPLETED)を含めるか。既定は未完了のみ(false)。"),
	dueBefore: z.string().optional().describe("DUE がこの offset 付き ISO8601 より前の TODO だけに絞る(due 無しは除外)。"),
	dueAfter: z.string().optional().describe("DUE がこの offset 付き ISO8601 より後の TODO だけに絞る(due 無しは除外)。"),
	// 【K3(2026-07-23): D 案(otherTodoCollections)を横断既定化で置き換えた】
	// 旧文言(2026-07-16)は「省略時は "tasks" のみ」で、実アカウントに tasks/reading-list のように
	// VTODO コレクションが複数あるとモデルが silent drop する事故があった(親レビューで確認)。
	// 当時は「カードは単一コレクション前提」という UI 契約(todos-view-model.ts の calendarId:
	// string 必須)を理由に横断既定化を見送り、応答に otherTodoCollections を添える D 案で凌いだ。
	// 今回(K3)は UI 側を「初回に全 VTODO コレクション横断取得 → 切替はクライアント側フィルタ」へ
	// 作り替えたため、この制約が外れた。calendarId 省略は素直に owner 配下の全 VTODO コレクション
	// 横断に倒す(events 系 resolveCollectionIds/list-events-expanded と同じ既定)。D 案の
	// otherTodoCollections フィールドはもう構造的に取りこぼしが起きない(横断クエリが最初から
	// 全部拾う)ため撤去し、resolveOtherTodoCollections(findAllByOwner の追加 D1 往復)も削除した
	// ——「D1 クエリは1回」という K3 の要求と、D 案の追加往復は両立しないため。
	calendarId: z.string().optional().describe(
		'対象コレクション ID。省略(または "all")時は owner 配下の全 VTODO コレクションを横断して' +
			"一覧する(応答の calendarId は横断時 null・単一指定時はその ID を echo する)。特定のリスト" +
			"だけを見たいときだけ明示すること。",
	),
	timeZone: z.string().optional().describe(
		"due の表示 + floating/DATE の解釈に使う IANA タイムゾーン(例 \"Asia/Tokyo\")。" +
			"ユーザーのローカルゾーンを必ず渡すこと(省略時は UTC にフォールバックし、時刻付き DUE が" +
			"UTC のまま表示されて実際の時刻とズレる)。",
	),
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
 * 対象コレクション ID の一覧を解決する。優先順位は calendarIds(複数)→ calendarId(単数)→ 全横断。
 *   - calendarIds 指定あり(1件以上)→ その集合を CollectionId 化して返す(2026-07-22 追加。
 *     agenda カードの表示フィルタが「一部だけ表示 ON」の状態をこの複数指定で表現する)。
 *   - calendarId 指定あり → その1件(従来挙動)。
 *   - どちらも無し → collectionRepo.findAllByOwner で owner 配下の全コレクションを列挙する。
 * (list-events-expanded / get-freebusy 共通のロジック。get-freebusy は calendarIds を渡さないので
 *  従来どおり calendarId/全横断の2択で動く — シグネチャ後方互換のため calendarIds は optional 引数。)
 *
 * 【なぜ calendarIds を calendarId より優先するか】両方指定は本来 UI からは起きないが(アジェンダ
 * カードは calendarIds しか送らない)、モデルが両方載せてくる可能性はある。黙って一方を無視すると
 * 「なぜその件数になったか」が説明できないので、より具体的な指定(集合の明示列挙)である calendarIds を
 * 勝たせる方針を description にも明記した。空配列 [] は「指定なし」と区別できないと事故る(全横断に
 * 化ける)ので、length===0 は calendarIds 未指定として扱い calendarId/全横断へフォールバックする。 */
async function resolveCollectionIds(
	deps: McpAppDeps,
	owner: PrincipalRef,
	calendarId: string | undefined,
	calendarIds?: string[],
): Promise<CollectionId[]> {
	if (calendarIds !== undefined && calendarIds.length > 0) return calendarIds.map((id) => mkCollectionId(id));
	if (calendarId !== undefined) return [mkCollectionId(calendarId)];
	const collections = await deps.collectionRepo.findAllByOwner(owner);
	return collections.map((c) => c.id);
}

/**
 * レイテンシ案2(2026-07-22): events/free-busy の全横断経路が使う「D1 を呼ばない」引数組み立て。
 * resolveCollectionIds と同じ優先順位「calendarIds → calendarId → 全横断」だが、全横断を
 * findAllByOwner で列挙せず **undefined**(= ports の findByOwnerTimeRange に「全横断」を意味させる)へ
 * 畳む。これにより旧経路の①findAllByOwner + ②hydrate の sync_changes N+1 波を events/free-busy から
 * 消し、③の time-range 取得を 1 クエリ(owner スコープ)に一本化する。
 *
 * 【空配列 [] の扱い】resolveCollectionIds と同じく length===0 は「指定なし」と区別できず全横断に
 * 化けると事故る(表示フィルタが全 OFF のときに全部見えてしまう)ので、calendarIds は length>0 の
 * ときだけ勝たせる。空配列は calendarId/全横断へフォールバックする(挙動を旧 resolveCollectionIds に
 * 揃える — 回帰ガードの結果不変性を守る)。
 */
function collectionIdArg(
	calendarId: string | undefined,
	calendarIds?: string[],
): CollectionId[] | undefined {
	if (calendarIds !== undefined && calendarIds.length > 0) return calendarIds.map((id) => mkCollectionId(id));
	if (calendarId !== undefined) return [mkCollectionId(calendarId)];
	return undefined; // 全横断: findByOwnerTimeRange に collection_id 条件を付けさせない。
}

// 【K3(2026-07-23)で resolveOtherTodoCollections(D 案)を撤去した】
// 旧関数は「calendarId 省略呼び出しで実際に見せたコレクション以外に VTODO コレクションが
// まだ存在するか」を findAllByOwner の追加 D1 往復で調べ、otherTodoCollections フィールドで
// モデルに伝えていた(TodosViewModel.otherTodoCollections の旧 JSDoc・git log 56cbb73 の前段参照)。
// K3 で ListTodos/buildTodosViewModel の calendarId 省略が「本当に owner 配下の全 VTODO
// コレクションを1クエリで横断する」よう変わったため、「実は見せていないコレクションがある」
// という前提そのものが成立しなくなった(構造的に取りこぼしが起きない)。よって関数ごと削除し、
// 追加の findAllByOwner 往復も無くした(K3 の「D1 クエリは1回」要求と D 案の追加往復は両立しない)。

/**
 * Event DTO を list-events-expanded / event mutate ツールの wire 形へ整える(E-3 スライス S1)。
 * Event DTO(§3)に legacy 別名(uid=id / summary=title / description=notes)+ calendarId +
 * isRecurring を additive に併記する。legacy 別名は「旧 list-events-expanded 応答(uid/summary)を
 * 読む既存の非 UI 消費者/テスト」を壊さないための後方互換(server.ts の list-events-expanded 内
 * コメント参照)。アジェンダカード(S2)は Event DTO 側(id/title/notes/recurrence 等)を読む。
 */
function toWireEvent(event: Event, calendarId: string, isRecurring: boolean): Record<string, unknown> {
	return {
		...event,
		uid: event.id,
		summary: event.title,
		description: event.notes,
		calendarId,
		isRecurring,
	};
}

// 観測基盤: toolError が telemetry へ「エラー種別」を渡すための _meta キー(名前空間付き)。
// registerTool ラッパー(計測点)がこのキーを読み、isError 結果の errKind を "ToolError"(既定)より
// 具体的な値へ上書きする。_meta はモデルへの content ではないので、この分類値が会話に露出しない。
export const TELEMETRY_ERRKIND_META_KEY = "gigun.dev/errKind";

// #locationAutoResolve(自動ジオコーディング要件5): errKind と同じ _meta 経由の運搬パターンを転用した
// telemetry 属性キー。【なぜ errKind をそのまま使わないか】errKind は isError:true(または例外)の
// ときしか registerTool ラッパーの finally が読まない(下の「try { const result = await cb(...) }」
// 参照)。だが自動ジオコーディングは create-event/update-event 自体を絶対に失敗させない(この
// ファイルの create-event/update-event ハンドラ冒頭コメント参照)ので、成功応答(isError:false)でも
// 「known-locations で解決できた/geocoding で解決できた/失敗して素のテキストのまま」を観測したい。
// よって別キーを設け、ラッパー側で ok/errKind に関わらず常に読んで argsDigest へマージする
// (= 新しい mcpTool 名を増やさず、既存 argsDigest の属性として表現する要件5の裁定)。
export const TELEMETRY_LOCATION_META_KEY = "gigun.dev/locationAutoResolve";

/**
 * MCP ツールハンドラの共通エラー整形。isError:true + content にメッセージを詰める。
 *
 * 【errKind(第2引数・#45 で追加)】観測用のエラー種別を任意で受け取り、結果の _meta に載せる。
 * これを付けると registerTool ラッパーが telemetry の errKind をこの値にできる(付けなければ従来どおり
 * 一律 "ToolError")。search-location の quota 超過/キー未設定のように「isError で graceful に返しつつ、
 * どの原因で失敗したかを observability で区別したい」ケースのための additive な口。例外を throw する
 * (= errKind に例外クラス名が乗る)経路と違い、ツールを落とさずに種別だけ運べる。
 */
function toolError(message: string, errKind?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		// errKind 未指定時は _meta を付けない(既存の toolError 呼び出しの結果形を変えない)。
		...(errKind !== undefined ? { _meta: { [TELEMETRY_ERRKIND_META_KEY]: errKind } } : {}),
	};
}

// R1(docs/modeling/15 §A-3): delete-* 実行前のサーバー側トークン検証(旧 verifyDeleteConfirmation)は
// 撤去済み。撤去理由(Why not サーバー側強制を維持する案): MCP spec の User Interaction Model は
// 確認プロンプトの提示を Applications(ホスト)の責務と明記しており(§A-1)、claude.ai は既に per-tool
// 許可(Always allow / 毎回確認 / Block)を備える — サーバー側トークン強制はこれと二重に確認を課すだけで
// 仕様の責務分界にも反する(docs/modeling/15 §A-4)。サーバー側の残る責務は annotations の正しい申告
// (destructiveHint/idempotentHint — 下の DELETE_ANNOTATIONS)と可逆性の提供(R2 ソフトデリート予定)。
// confirmToken フィールド自体は後方互換のため残し無視する(confirmTokenField 定義箇所コメント参照)。
//
// 2026-07-23 撤去(#47): 上の撤去に伴い「確認 UI はホストの責務」(docs/modeling/15)への移行が
// 完了したので、propose-delete-{todo,event,calendar} ツール本体・その専用プレビュー生成
// (旧 icsPreview/decodeIcsText/formatIcsDate/deleteProposePayload/DeleteToolName)・確認カード
// (ui/confirm-app.ts 他)もここで撤去した。安全性の根拠: grep で洗った結果、これらのシンボルは
// propose-delete-* からしか参照されておらず(getCardToken が使う signConfirmToken/CARD_TOKEN_TTL_MS
// は todos/agenda カードの swipe 削除が独立に使う別経路なので存置)、他ツール・他カードとの共有は
// 無かった。CONFIRM_SECRET binding 自体は getCardToken(カード発の免除トークン発行)がまだ使うため
// wrangler.jsonc の secrets.required には残す。docs/modeling/14(確認カードの設計)は歴史として消さない。

/**
 * リクエストごとに McpServer + StreamableHTTPTransport を新規生成し、5ツール
 * (get-current-time / list-events-expanded / get-freebusy / create-todo / list-todos)を登録する
 * ファクトリ。principal をクロージャで束縛するため、認証成功後(ミドルウェア内)で呼ぶ。
 */
// requestColo: リクエストが処理されている Cloudflare colo(request.cf.colo)。2026-07-14 追加。
// 【なぜログに colo が要るか】console.log イベントには $workers.event.request.cf.colo が
// 乗らない(observability で groupBy したら空だった実測)ため、リクエストイベントと突合できず
// 「どの colo で実行されたツール呼び出しが遅いのか」を分解できなかった。D1 は APAC 固定なので
// 実行 colo が遠い(例: claude.ai バックエンド発 = IAD)ほど D1 直列往復のペナルティが線形に
// 効く仮説の検証と、Smart Placement(wrangler.jsonc)導入後に実行 colo が D1 側へ寄ったことの
// 確認は、このフィールドが唯一の計器になる。
// scopes: この呼び出しに許可された OAuth scope 集合(R-6。2026-07-15 追加)。
// **undefined = full access(grandfather / 静的 Bearer 相当)**(AuthResult.scopes の契約 —
// application/ports/authentication.ts)。write ツール実行時に allowsWrite(scopes) で強制する。
// requestUserAgent: 観測基盤 v1(2026-07-23 追加)。Authorization ヘッダと同じくリクエストの
// HTTP ヘッダなので、colo と同じ「呼び出し元(handleMcpRequest)で読んで束ねて渡す」形にする
// (buildMcpServer / registerTool ラッパーは Hono Context を知らない設計を保つ)。
function buildMcpServer(
	deps: McpAppDeps,
	principal: PrincipalRef,
	scopes: readonly string[] | undefined,
	requestColo?: string,
	requestUserAgent?: string,
): McpServer {
	const server = new McpServer({ name: "caldav-mcp", version: "1.0.0" });

	// --- ツール別レイテンシ計測(2026-07-14 追加。POST /mcp wall p95≈1164ms 対策の効果測定用)-----
	// 【なぜ registerTool を monkeypatch するか(各 handler を個別に try/finally で包まない理由)】
	// 9 ツールの handler を個別に包むと同じ計測コードが散らばる。かつ registerAppTool 経由の
	// handler は inline arrow の contextual typing(inputSchema から引数型を推論)に依存しており、
	// 汎用ジェネリックラッパー関数で包むと inline arrow に文脈型が付かず引数が implicit any になる
	// (ジェネリックは「引数から推論」と「引数へ文脈型を供給」を同時にできない — tsc strict 落ち)。
	// registerAppTool(ext-apps)は内部で server.registerTool を呼ぶだけの薄いラッパー
	// (dist/src/server/index.js の K3 が Z.registerTool を呼ぶことを確認済み)。よって
	// server.registerTool を1箇所差し替えれば、直接登録・registerAppTool 登録の両 handler を
	// 透過的に計測できる。handler は差し替え前に完全に型付けされて cb として渡ってくるので、
	// ラッパー内は型を気にせず cb を呼ぶだけでよい(型安全は登録側で既に確定している)。
	// 【ログ内容】個人データ(タスク内容)は載せず mcpTool 名と所要 ms のみ。Workers observability の
	// $metadata.message から JSON 1行として拾える(Date.now は Workers で使用可)。
	// registerTool はオーバーロードされたジェネリックなので、差し替え関数は緩い型で受けて
	// 元のシグネチャへキャストして被せる(handler の型はここで緩めても呼び出し側に影響しない)。
	const rawRegisterTool = server.registerTool.bind(server) as (
		name: string,
		config: unknown,
		cb: (...args: unknown[]) => unknown,
	) => unknown;
	server.registerTool = ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
		rawRegisterTool(name, config, async (...args: unknown[]) => {
			// --- R-6: ツール別 scope 強制 ------------------------------------------------
			// write(mutation)ツールは claudedav:write が無いと実行させない。read/write の区分は
			// scopes.ts の READ_ONLY_TOOLS(allowlist・未分類は write 扱いの safe default)に集約する。
			// 【なぜ計測 try/finally の「外」でここに置くか】権限エラーは即返しでよく、レイテンシ計測の
			// 対象(実際のユースケース実行)ではない。かつ isError レスポンスは正常な JSON-RPC 応答
			// (throw ではない)なので、ここで早期 return して cb を呼ばないのが最小挙動。
			// scopes === undefined(grandfather / 静的 Bearer)は allowsWrite が true を返すので
			// この分岐に入らず、既存接続は再接続まで従来どおり動く(R-6 裁定)。
			if (isWriteTool(name) && !allowsWrite(scopes)) {
				return toolError(
					"このトークンは読み取り専用です。コネクタを再接続して書き込み権限(claudedav:write)を許可してください。",
				);
			}
			// --- 観測基盤 v1(2026-07-23): 1 tool call = 1 イベント ------------------------
			// requestId はサーバー自前採番(crypto.randomUUID)。args[0] がツールの入力引数、
			// args[1] が SDK の RequestHandlerExtra(_meta/sessionId 等を運ぶ)という契約は
			// @modelcontextprotocol/sdk の registerTool ハンドラシグネチャに依る(protocol.d.ts の
			// RequestHandlerExtra 型定義で確認済み)。ここでは型を緩めて受けている(このラッパーの
			// クラス冒頭コメント参照)ので、args[1] も unknown から局所的に narrow する。
			const requestId = crypto.randomUUID();
			const toolArgs = args[0];
			const extra = args[1] as { _meta?: Record<string, unknown> } | undefined;
			const argsDigest = summarizeArgsDigest(toolArgs);
			const sessionId = readSessionId(extra?._meta);
			const host = classifyHost(requestUserAgent);
			const startedAtMs = Date.now();
			let ok = true;
			// errKind: 例外なら例外クラス名、cb が isError:true な結果を返しただけなら例外は
			// 飛ばないので固定マーカー "ToolError" にする(toolError() ヘルパーの返り値は
			// 判別可能なエラー型を持たないため、メッセージ文字列を解析して種別を作るのは
			// 過剰かつメッセージにユーザー入力がエコーされている可能性があり避けたい —
			// TelemetryEvent.errKind コメントの「メッセージ本文は載せない」規律と対称)。
			let errKind: string | undefined;
			// #locationAutoResolve(要件5): argsDigest へマージする追加属性。errKind と違い ok/isError に
			// 関わらず読む(TELEMETRY_LOCATION_META_KEY 定義コメント参照)。
			let locationAutoResolveDigest: Record<string, unknown> | undefined;
			try {
				const result = await cb(...args);
				if (typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true) {
					ok = false;
					// #45: toolError(message, errKind) が _meta にエラー種別を載せていればそれを採る
					// (search-location の quota 超過/キー未設定を区別可能にする)。無ければ従来どおり
					// 一律 "ToolError"(種別を分けたくない/分ける必要のない大多数のエラー)。
					const metaErrKind = (result as { _meta?: Record<string, unknown> })._meta?.[TELEMETRY_ERRKIND_META_KEY];
					errKind = typeof metaErrKind === "string" ? metaErrKind : "ToolError";
				}
				const metaLocation = (result as { _meta?: Record<string, unknown> } | null)?._meta?.[TELEMETRY_LOCATION_META_KEY];
				if (typeof metaLocation === "object" && metaLocation !== null) {
					locationAutoResolveDigest = metaLocation as Record<string, unknown>;
				}
				return result;
			} catch (error) {
				ok = false;
				errKind = error instanceof Error ? error.constructor.name : "UnknownError";
				throw error;
			} finally {
				const ms = Date.now() - startedAtMs;
				// #locationAutoResolve(要件5): 引数由来の argsDigest(summarizeArgsDigest)へ
				// locationAutoResolveDigest を additive にマージする(新しい mcpTool 名を増やさず
				// create-event/create-events/update-event の既存イベントの属性として表現する)。
				const mergedArgsDigest =
					locationAutoResolveDigest !== undefined ? { ...(argsDigest ?? {}), ...locationAutoResolveDigest } : argsDigest;
				// 1行 JSON(mcpTool 名 + ms + colo + ok/errKind + requestId)。タスク内容等の
				// 個人データは決して載せない(argsDigest は要約のみ・summarizeArgsDigest 参照)。
				// colo は「実行場所 × ツール別レイテンシ」の分解用(buildMcpServer 冒頭コメント参照)。
				console.log(
					JSON.stringify({
						mcpTool: name,
						ms,
						ok,
						...(errKind !== undefined ? { errKind } : {}),
						...(requestColo !== undefined ? { colo: requestColo } : {}),
						requestId,
						host,
						...(sessionId !== undefined ? { sessionId } : {}),
						...(mergedArgsDigest !== undefined ? { argsDigest: mergedArgsDigest } : {}),
					}),
				);
				// TelemetryPort.record は fire-and-forget(await しない・戻り値なし — ポートの
				// 契約どおり)。AE アダプタは内部で writeDataPoint の失敗を握りつぶす設計だが
				// (analytics-engine-telemetry.ts)、ここは「アダプタの実装がその規律を守っている」
				// ことに依存せず、呼び出し側(この finally ブロック)でも念のため try/catch する。
				// 【why】finally ブロック内で例外を投げると、try ブロックの return 値や catch で
				// 再送出した例外を**上書きしてしまう**(JS の仕様: finally の例外が優先される)。
				// つまり telemetry アダプタの実装が万一 throw する不具合を仕込むと、正常に完了した
				// はずの tool call のレスポンスが握りつぶされて 500/未処理例外に化ける
				// (「計測が本処理を壊してはならない」という仕様要件そのものの落とし穴)。
				// この try/catch はまさにその「もし record が投げたら」を吸収する最後の砦。
				try {
					deps.telemetry.record({
						requestId,
						principal: String(principal),
						host,
						mcpTool: name,
						ok,
						errKind,
						ms,
						colo: requestColo,
						argsDigest: mergedArgsDigest,
						sessionId,
					});
				} catch {
					// 意図的に無視。計測の計測をログに出し始めるとノイズが増えるだけで実害が薄い
					// (同一イベントは console.log 側の構造化ログに既に出ている)。
				}
			}
		})) as typeof server.registerTool;

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

	// --- todos ui:// 旧・静的 URI のエイリアス登録(2026-07-17 キャッシュバスティング S1)-----
	// TODOS_UI_URI は HTML から算出した hash 付き URI に切り替わった(todos-app.ts 参照)ので、
	// 新しく接続したホストは新 URI を掴む。しかし claude.ai は tools/list 自体も約1時間 TTL で
	// キャッシュする(層A)ため、切り替え直後は「旧 tools/list(旧 resourceUri 入り)を握ったまま」の
	// ホストが一定時間存在しうる。その間もカードが欠落しないよう、旧・静的 URI でも同じ最新
	// HTML を読めるようにここでエイリアス登録する(層Bの後方互換)。旧 URI 文字列はこの登録
	// 専用のローカル定数として持ち、todos-app.ts 側に「静的 URI」を export し直すことはしない
	// (todos-app.ts の輸出面を増やさず、後方互換の都合はこの登録箇所に閉じ込める)。
	const TODOS_UI_URI_LEGACY = "ui://caldav/todos.html";
	registerAppResource(
		server,
		"Todos View (legacy URI)",
		TODOS_UI_URI_LEGACY,
		{
			title: "リマインダー一覧 UI",
			description: "list-todos の結果をモバイルで崩れないリマインダー一覧として描画するプロトタイプ UI(旧 URI・後方互換)",
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
					uri: TODOS_UI_URI_LEGACY,
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

	// --- todos ui:// 「未知のハッシュ」への後方互換フォールバック(2026-07-23)-----------------
	// 【背景】ハッシュ URI(ui://caldav/todos.<8hex>.html)は claude.ai web の resources/read
	// キャッシュ(層Cとでも呼ぶべきもの — HTML 本体レベルのキャッシュ)を破るための唯一の手段なので
	// 維持する。だが tools/list 自体も別途キャッシュされる(冒頭 TODOS_UI_URI_LEGACY コメントの層A)
	// ため、「新→更に新」と HTML を2回更新すると、旧 tools/list を握ったままのホストは
	// 「もう存在しない中間世代のハッシュ URI」への resources/read を送ってくる。上の
	// TODOS_UI_URI_LEGACY エイリアスは"無ハッシュの静的 URI 1本"だけを救うので、この
	// 「任意の旧ハッシュ」には対応できない(swift-mcp-host 実機・本番で -32602 再現済み)。
	// 【対応】OpenAI Apps SDK が「発行済み URI を古いものも含めて生かし続ける」運用をしているのと
	// 同型に倣い、ResourceTemplate で `ui://caldav/todos.{hash}.html` の任意 read に最新 HTML を
	// 返す汎用フォールバックを足す。SEP-1865 は ui:// リソースの URI 安定性を規定していないので
	// 「古い URI が今日読めても壊れない」設計は仕様に反しない。
	// 【list には出さない】ResourceTemplate の第2引数 { list: undefined } は「このテンプレートを
	// resources/list に列挙しない」ことを明示する必須フィールド(list を省略すると SDK 側の
	// ドキュメントコメントいわく「うっかり忘れ」防止のため型上必須)。SEP-1865 は ui:// を
	// resources/list から省略してよい(MAY omit)としているので、今回のテンプレートを list に
	// 出さない判断は仕様適合。実際に列挙されるのは既存の「現行ハッシュ」「legacy 静的 URI」の
	// 2エントリのみで変わらない(このテンプレート追加はテスト test/presentation/ 側で確認)。
	// 【衝突しないことの確認(SDK 実装読み済み: node_modules/@modelcontextprotocol/sdk/dist/esm/
	// server/mcp.js の setResourceRequestHandlers)】resources/read は「まず _registeredResources
	// の完全一致 → 無ければ _registeredResourceTemplates を順に試す」という優先順位。現行ハッシュ・
	// legacy 静的 URI は両方とも registerAppResource(= registerResource の静的 URI 形)で登録して
	// いるので完全一致が先に当たり、このテンプレートには絶対に落ちてこない(=「現行ハッシュが
	// 意図せず旧扱いされる」ことは起きない)。
	// 【RFC 6570 マッチングの実挙動確認(同ファイル shared/uriTemplate.js)】単純展開 {hash} は
	// 正規表現 `([^/,]+)` にコンパイルされ、テンプレート全体は "^ui://caldav/todos\.([^/,]+)\.html$"
	// になる。JS 正規表現はデフォルトで貪欲だが後方一致のため自動バックトラックする ので、
	// "todos.deadbeef.html" のようにハッシュ自体にドットを含まない値なら額面どおり 1 箇所の
	// ".html" に噛み合って hash="deadbeef" が取れる(ハッシュは8hex固定でドットを含まないので
	// 曖昧マッチの心配はない)。旧・静的 URI "ui://caldav/todos.html" はこのパターンに
	// マッチしない(捕捉グループが最低1文字必要で、"todos." の直後に ".html" が続く形が
	// 作れないため)— 上記の優先順位確認と合わせ二重の安全策としてテストに固定する。
	// 【uiHash 表示との整合】カード側は structuredContent.uiHash(list-todos 等が返す "現在の
	// 最新ハッシュ")と、自分が読み込まれた HTML に焼き込まれた TODOS_UI_HASH を比較して
	// 不一致なら「再同期してください」バナーを出す(todos-app.ts 側の仕組み)。この後方互換は
	// 「どの URI で読まれても常に最新 HTML(=最新 TODOS_UI_HASH)を返す」ので、旧ハッシュ URI
	// 経由で読まれた場合も焼き込みハッシュは最新になり、tools/list からの structuredContent の
	// uiHash とも一致する。つまりこの後方互換とバナー機構は干渉せず、旧 URI 越しでも正常表示に
	// 収束する(バナーが誤って出ることはない)。
	server.registerResource(
		"Todos View (legacy hash fallback)",
		new ResourceTemplate("ui://caldav/todos.{hash}.html", { list: undefined }),
		{
			title: "リマインダー一覧 UI",
			description:
				"list-todos の結果をモバイルで崩れないリマインダー一覧として描画するプロトタイプ UI(旧ハッシュ URI・後方互換)",
			mimeType: RESOURCE_MIME_TYPE,
			_meta: {
				ui: {
					prefersBorder: false,
				},
			},
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.toString(),
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

	// --- agenda ui:// リソース(E-3 スライス S2)------------------------------------
	// list-events-expanded / refresh-events が _meta.ui.resourceUri で参照するアジェンダカードの
	// HTML 本体を登録する(todos の "Todos View" と対称)。自己完結バンドルなので CSP 許可は不要。
	registerAppResource(
		server,
		"Agenda View",
		AGENDA_UI_URI,
		{
			title: "アジェンダ(予定一覧)UI",
			description: "list-events-expanded の結果をモバイルで崩れないアジェンダ(日付見出し + 時刻列)として描画する UI",
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
					uri: AGENDA_UI_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: AGENDA_APP_HTML,
					_meta: {
						ui: {
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

	// --- agenda ui:// 旧・静的 URI のエイリアス登録(2026-07-17 キャッシュバスティング S1)-----
	// 理由・方針は上の TODOS_UI_URI_LEGACY と対称(todos と同じ TTL ウィンドウで旧 URI を
	// 掴んだままのホストが出うるため)。詳細コメントは重複させず TODOS_UI_URI_LEGACY 側を参照。
	const AGENDA_UI_URI_LEGACY = "ui://caldav/agenda.html";
	registerAppResource(
		server,
		"Agenda View (legacy URI)",
		AGENDA_UI_URI_LEGACY,
		{
			title: "アジェンダ(予定一覧)UI",
			description: "list-events-expanded の結果をモバイルで崩れないアジェンダ(日付見出し + 時刻列)として描画する UI(旧 URI・後方互換)",
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
					uri: AGENDA_UI_URI_LEGACY,
					mimeType: RESOURCE_MIME_TYPE,
					text: AGENDA_APP_HTML,
					_meta: {
						ui: {
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

	// --- agenda ui:// 「未知のハッシュ」への後方互換フォールバック(2026-07-23)-----------------
	// 理由・SDK 挙動確認・list 非掲載・uiHash 整合は上の todos 版フォールバックと完全に対称
	// (詳細コメントは重複させずそちら側を参照)。diag は対象外(裁定どおり・診断カードは
	// キャッシュバスティング対象そのものではなく撤去前提の一時カードなので後方互換は不要)。
	server.registerResource(
		"Agenda View (legacy hash fallback)",
		new ResourceTemplate("ui://caldav/agenda.{hash}.html", { list: undefined }),
		{
			title: "アジェンダ(予定一覧)UI",
			description:
				"list-events-expanded の結果をモバイルで崩れないアジェンダ(日付見出し + 時刻列)として描画する UI(旧ハッシュ URI・後方互換)",
			mimeType: RESOURCE_MIME_TYPE,
			_meta: {
				ui: {
					prefersBorder: false,
				},
			},
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.toString(),
					mimeType: RESOURCE_MIME_TYPE,
					text: AGENDA_APP_HTML,
					_meta: {
						ui: {
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

	// --- diag ui:// リソース(2026-07-23 iOS 描画切り分けスパイク)------------------------
	// diag-card ツールが _meta.ui.resourceUri で参照する最小診断カードの HTML 本体を登録する。
	// todos/agenda の "Todos View" / "Agenda View" と完全に対称の登録流儀(自己完結・外部依存ゼロ
	// なので CSP 許可は不要)。違いは中身が < 2KB という点だけ — これにより iOS で描画されれば
	// サイズ/内容説、失敗すれば認証説へ切り分けられる(diag-app.ts 冒頭コメント参照)。
	// 切り分けが済んだらこの resource + diag-card ツール + diag-app.ts を丸ごと撤去できるよう疎に保つ。
	registerAppResource(
		server,
		"Diag Card",
		DIAG_UI_URI,
		{
			title: "診断カード(iOS 描画切り分け用・一時的)",
			description: "iOS の MCP Apps 描画失敗を切り分ける最小カード(外部依存ゼロ・< 2KB)。切り分け完了後に撤去する。",
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
					uri: DIAG_UI_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: DIAG_APP_HTML,
					_meta: {
						ui: {
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

	// --- S1 免除トークン(カード発の削除)の遅延生成 ---------------------------------------
	// 【設計判断(docs/modeling/14 §6 項目5): カード発の削除に「免除トークン」を配る】
	// 既存の todos/agenda カードは、swipe / 詳細ページから delete-todo / delete-event を
	// callServerTool で直接叩く(propose を経ない)。これはユーザーがカード上で明示操作した結果なので
	// 確認カードを二重に挟むのは過剰。だが delete-* がトークン必須化されると、この直接経路が壊れる。
	// そこで list/refresh/mutate 応答の _meta.confirm.cardToken に「免除トークン」(payload.kind:"card")を
	// 載せ、カードは delete 時にそれを confirmToken として返す。
	// 【なぜ _meta 経由か(モデルに漏れない)】_meta は MCP Apps がカード iframe にだけ渡す UI 専用
	// チャネルで、モデルの content には入らない(§2)。ゆえに免除トークンをモデルは読めず、モデルが
	// delete-* を直接叩いても免除トークンを持てない = ハード強制は破れない。
	// 【なぜ「対象特定」しない緩いトークンか】カード操作(swipe 等)はユーザーの明示確認そのものなので、
	// 対象1件ごとに propose を挟ませる必要がない。免除トークンは「このカードがユーザーの手で操作されている」
	// ことだけを証明すれば十分(§6 項目5 の「最小・可逆・_meta 経由でモデルに漏れない」を満たす)。
	// 【ボツ案(Why not)】(a) カード自身にトークンを署名させる → ブラウザに secret を置けない(却下)。
	//   (b) delete-* に「カード由来」を示す平文フラグを足す → モデルも同じ引数を渡せてしまい強制が空洞化(却下)。
	//   (c) list 応答で対象ごとに個別トークンを配る → 件数分のトークンで重く、swipe 以外の経路(詳細ページで
	//       別 id を消す等)に追従しづらい(却下)。カード単位の1トークンが最小。
	// 【TTL】カードは開きっぱなしにされ得るので propose の5分では足りない。免除トークンの安全性は TTL では
	//   なく _meta 秘匿 + HMAC に依存する(モデルは読めない)ため、TTL は defense-in-depth に留めて 12h に
	//   する(CARD_TOKEN_TTL_MS)。カードは focus/mutation のたびに再取得し新トークンを受け取るので通常更新される。
	// 【遅延生成】1リクエストで複数のカード応答を返すことは無い(1 tools/call = 1 応答)が、署名は async なので
	//   Promise をメモ化して同一リクエスト内で1回だけ署名する。secret 未設定時は空文字を配る(カードは
	//   空トークンを送る → delete-* 側で「未設定」エラーになり、propose 経路と同じく安全側に倒れる)。
	let cardTokenPromise: Promise<string> | null = null;
	const getCardToken = (): Promise<string> => {
		if (cardTokenPromise === null) {
			cardTokenPromise =
				deps.confirmSecret === ""
					? Promise.resolve("")
					: signConfirmToken(deps.confirmSecret, { kind: "card" }, CARD_TOKEN_TTL_MS);
		}
		return cardTokenPromise;
	};

	// --- get-current-time -----------------------------------------------------
	server.registerTool(
		"get-current-time",
		{
			title: "Get current time",
			description: "現在時刻を指定タイムゾーンの offset 付き ISO8601 で返す。エージェントが「今日/今」を基準に期間を組み立てるための基準時刻取得ツール。",
			inputSchema: getCurrentTimeInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
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

	// --- diag-card(2026-07-23 iOS 描画切り分け用・一時的)-----------------------------
	// 【なぜ常時登録か(環境変数ゲートにしない)】既存に diag/debug 系の隔離パターン(env ゲート等)は
	// 無い。かつ切り分けの本題は「本番の claude.ai iOS で、他カードと同じ経路を通したとき最小カードが
	// 描画されるか」なので、本番 tools/list に出ないと検証できない。よって常時登録し、モデル/一覧に出る
	// ノイズは description の「iOS 描画切り分け用・一時的」明記で吸収する(切り分け後に丸ごと撤去する前提)。
	// 【なぜ registerAppTool + _meta.ui か】todos/agenda カードと「同じ紐付け経路・同じ resources/read
	// 経路・同じ Bearer」を通すことが切り分けの肝。差分を「中身の大きさ」だけに絞るため、_meta.ui は
	// list-events-expanded 等と同じ形(resourceUri + openai/outputTemplate 併記)にする。
	// structuredContent は最小 { ok, generatedAt } のみ(カードは structuredContent を読まず静的描画する
	// ので、中身は「ツールが成功応答を返した」ことの目印で足りる)。
	server.registerTool(
		"diag-card",
		{
			title: "Diag card",
			description:
				"iOS 描画切り分け用・一時的。最小の診断カード(ui://caldav/diag.html・外部依存ゼロ・< 2KB)を出すだけのツール。" +
				"caldav の todos/agenda カードが claude.ai iOS で描画失敗する原因(認証 vs バンドルサイズ)を切り分けるための一時ツールで、切り分け完了後に撤去する。",
			// 入力は取らない(診断カードを出すだけ)。空の ZodRawShape を渡す(get-current-time 等と同じく
			// registerTool は inputSchema に ZodRawShape を要求するので、空オブジェクトで「引数なし」を表す)。
			inputSchema: {},
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: DIAG_UI_URI },
				"openai/outputTemplate": DIAG_UI_URI,
			},
		},
		async () => {
			// 最小 structuredContent。ok は「ツールが成功した」目印、generatedAt はカードが描画された時刻と
			// ツール応答時刻のズレを後から突き合わせられるようにする診断メタ(カード側は読まない)。
			const result = { ok: true, generatedAt: Date.now() };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				structuredContent: result,
			};
		},
	);

	// --- list-events-expanded / refresh-events(E-3 スライス S2 で ui:// 紐付け + app 専用 refresh 追加)--
	// 【list-todos ↔ refresh-todos と同じ構造】照会系(list-events-expanded)と UI 専用の再読み込み
	// (refresh-events)は同一の展開ロジックを共有する。todos の runListTodos と同じく、handler 本体を
	// runListEvents クロージャに切り出し、両ツールから呼ぶ(コピペで契約がズレる事故を防ぐ)。
	const runListEvents = async (input: {
		// timeMin/timeMax は optional 化(range 指定時は不要)。range との XOR は resolveRequestRange で検証する。
		timeMin?: string;
		timeMax?: string;
		range?: RelativeRangeKeyword;
		timeZone?: string;
		calendarId?: string;
		calendarIds?: string[];
		maxEvents?: number;
	}) => {
		const { timeMin, timeMax, range, timeZone, calendarId, calendarIds, maxEvents } = input;
		try {
			// サーバー権威の now を1点で確定し(range 解決 + resolvedRange エコーで同じ now を使う)、
			// range/絶対の XOR 検証と範囲解決を共通ヘルパーに委ねる(get-freebusy と同一ロジックを共有)。
			const nowMillis = Date.now();
			const { rangeStartMillis, rangeEndMillis, zone } = resolveRequestRange({ timeMin, timeMax, range, timeZone, nowMillis });
				const limit = maxEvents ?? DEFAULT_MAX_EVENTS;

				// 【2026-07-22 レイテンシ案2: コレクション横断1クエリ化】
				// 旧実装は ①resolveCollectionIds(findAllByOwner + hydrate の sync_changes N+1)→
				// ②ListOccurrences を N 並列(各 1 D1 往復)、という 2 波の往復だった(2026-07-17 に②を
				// 直列→並列化したが往復回数自体は N のまま)。calendar_objects は owner 列を持つ
				// (migrations/0001)ので、全横断はコレクション列挙なしで 1 クエリに畳める。優先順位
				// 「calendarIds → calendarId → 全横断」は D1 を呼ばない薄い引数組み立て(collectionIdArg)へ
				// 退避し、全横断は undefined(= 全コレクション)として UC に渡す。マージ・始点昇順ソート・
				// truncated の OR 畳み込みは ListOccurrencesAcrossOwner に内包した(server から消えた)。
				const collectionIds = collectionIdArg(calendarId, calendarIds);
				const listOccurrences = new ListOccurrencesAcrossOwner(deps.resourceRepo, deps.iterator);
				const listed = await listOccurrences.execute({
					owner: principal,
					rangeStartMillis,
					rangeEndMillis,
					floatingTimeZone: zone,
					collectionIds,
				});
				const entries = listed.occurrences;
				let truncated = listed.truncated;

				// maxEvents は MCP アダプタ側の露出制限(内部の LIST_OCCURRENCES_MAX_OCCURRENCES
				// とは別の口。09 の「内部 maxOccurrences は露出しない」方針どおり、ここでだけ切る)。
				if (entries.length > limit) truncated = true;
				const clipped = entries.slice(0, limit);

				// 【E-3 スライス S1: 応答を EventsViewModel 形へ整える(additive・後方互換)】
				// 旧応答は各 event を {uid, summary, description, isRecurring, recurrenceId(常に ISO), ...} で
				// 返していた。E-3 でアジェンダカードが読む Event DTO(id/title/notes/recurrence/
				// recurrenceId=非反復は null)へ主軸を移すが、既存の非 UI 消費者(uid/summary を見るテスト等)を
				// 壊さないよう、Event DTO に legacy 別名(uid=id / summary=title / description=notes /
				// calendarId / isRecurring)を additive に併記する(toWireEvent)。recurrenceId の意味は
				// 「常に ISO」から §3 の「非反復は null / occurrence は開始 ISO」へ変える(既存 UI 無し[カードは S2]。
				// §3 契約に正しく合致する。旧「常に ISO」を見るテストは無いことを確認済み)。
				const events = clipped.map(({ uid, calendarId: cid, occurrence }) => {
					// eventFromOccurrence(application 層)が occurrence → Event DTO を組む。zoneOf は
					// occurrence が展開時点で tzid を失っているため identity(tzid=>tzid)で足りる
					// (表示ゾーンは応答基準 zone。§3「イベント自身のゾーン」との差は最終報告で親に返す)。
					const event = eventFromOccurrence(uid, occurrence, (tzid) => tzid, zone);
					// isRecurring は旧実装と同じ近似(override 由来 or マスターが rrule/rdate を持つ)。
					const isRecurring =
						occurrence.source === "override" ||
						occurrence.component.rrule !== undefined ||
						occurrence.component.rdate.length > 0;
					return toWireEvent(event, cid, isRecurring);
				});

				// range echo(EventsViewModel.range)。mutate 応答は range を名乗らない(判別シグナル)ので
				// range を載せるのは照会系のここだけ。
				// 【from/to を実際に使った範囲(解決後)にする】従来は入力の timeMin/timeMax をそのまま
				// エコーしていたが、range 指定時は入力に timeMin/timeMax が無い。常に「実際に展開した範囲」を
				// offset ISO で返すよう解決後の epoch から作る(絶対指定でも同じ値になり一貫する)。
				const resolvedMinIso = epochToIso(rangeStartMillis, zone);
				const resolvedMaxIso = epochToIso(rangeEndMillis, zone);
				// 【2026-07-22 echo pin バグ修正: calendarId 固定 echo をやめて正直にする】
				// 旧実装は calendarId 未指定(=全コレクション横断)でも `calendarId ?? "calendar"` で
				// "calendar" という架空の単一 ID を返していた。これを agenda-entry.ts の
				// applyStructuredContent が currentCalendarId に保存し、以降の focus refetch
				// (refreshArgs)が「currentCalendarId 非 null なら calendarId を送る」ため、
				// 初回は全横断だったはずの一覧が2回目以降 `calendarId:"calendar"` という単一
				// (存在しない)コレクションへ収束(collapse)してしまっていた(agenda echo pin 問題)。
				// 対処: 単一指定時のみその値を echo し、全横断時は正直に null を返す(架空 ID を
				// 作らない)。calendarIds(複数指定)は additive に指定時のみ echo する
				// (既存の calendarId 単一 echo と衝突しないよう両方 undefined/null 許容の後方互換形)。
				const result = {
					events,
					calendarId: calendarId ?? null,
					...(calendarIds !== undefined ? { calendarIds } : {}),
					timeZone: zone,
					range: { from: resolvedMinIso, to: resolvedMaxIso },
					// resolvedRange(2026-07-16 時刻グラウンディング): モデル/ユーザーが「サーバーが今を何時と
					// 解釈し、どの範囲を実際に使ったか」を検証できるよう additive に載せる。range 指定・絶対指定の
					// どちらでも常に「実際に使った範囲」を返すので一貫する(additive なので既存消費者は壊さない)。
					resolvedRange: {
						timeMin: resolvedMinIso,
						timeMax: resolvedMaxIso,
						serverNow: epochToIso(nowMillis, zone),
						timeZone: zone,
					},
					truncated,
					// 【2026-07-23 SWR 完全形】EventsViewModel.generatedAt JSDoc 参照。応答直前に取ることで
					// D1 往復(ListOccurrencesAcrossOwner)の待ち時間まで含めた「見せてよい起点」を刻む
					// (buildTodosViewModel と同じ判断・理由は todos 側コメント参照)。
					generatedAt: Date.now(),
					uiHash: AGENDA_UI_HASH, // ④ カードの版不整合可視化(EventsViewModel.uiHash JSDoc 参照)。
				};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				structuredContent: result,
			};
		} catch (error) {
			return toolError(error instanceof Error ? error.message : String(error));
		}
	};

	// list-events-expanded: モデルからも呼べる照会ツール。E-3 S2 でアジェンダカード(agenda.html)を紐付ける
	// (todos の list-todos が registerAppTool 化されたのと同じ流儀。_meta の2キー併記も同一)。
	registerAppTool(
		server,
		"list-events-expanded",
		{
			title: "List expanded events",
			description:
				"指定期間の VEVENT を反復展開済み(RRULE/RDATE を個々の occurrence に展開)の平坦な一覧として返す。" +
				"calendarId 省略時は全カレンダーを横断する。範囲は timeMin/timeMax(絶対 ISO)または range(相対レンジ: " +
				'today/tomorrow/next-7-days/next-30-days/this-week/next-week/this-month)で指定する。range を使えば「今日の予定」' +
					'「今週の予定」「来週」「今月」なども事前 get-current-time なしで1発で引ける。' +
				"応答の calendarId が null の場合は全コレクション横断の結果であることを示す(単一コレクション指定時のみその ID を echo する)。",
			inputSchema: listEventsExpandedInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({ timeMin, timeMax, range, timeZone, calendarId, calendarIds, maxEvents }) =>
			runListEvents({ timeMin, timeMax, range, timeZone, calendarId, calendarIds, maxEvents }),
	);

	// refresh-events(E-3 S2: UI 専用の再読み込みツール)。visibility:["app"] でモデルには見せず、
	// アジェンダカードの focus refetch / mutation 後の取り直しが callServerTool で叩く用
	// (refresh-todos と完全に対称。handler は runListEvents 共通クロージャ)。inputSchema は
	// list-events-expanded と同じ listEventsExpandedInputShape にして UI が保持した currentRange を渡せる。
	registerAppTool(
		server,
		"refresh-events",
		{
			title: "Refresh events",
			description:
				"UI(アジェンダ App)専用の再読み込みツール。UI が保持する現在の期間(timeMin/timeMax)を引数で受け取り、" +
				"その期間の最新の展開済み一覧を返す。モデルからは呼べない(visibility:[\"app\"])— UI の focus refetch / mutation 後の再取得用。",
			inputSchema: listEventsExpandedInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI, visibility: ["app"] },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({ timeMin, timeMax, range, timeZone, calendarId, calendarIds, maxEvents }) =>
			runListEvents({ timeMin, timeMax, range, timeZone, calendarId, calendarIds, maxEvents }),
	);

	// --- get-freebusy -----------------------------------------------------------
	server.registerTool(
		"get-freebusy",
		{
			title: "Get free/busy",
			description:
				"指定期間の busy 区間(RFC 4791 §7.10 の FBTYPE 導出済み)を返す。calendarId 省略時は全カレンダーを横断して再 coalesce する。" +
				"範囲は timeMin/timeMax(絶対 ISO)または range(相対レンジ: today/tomorrow/next-7-days/next-30-days/" +
				"this-week/next-week/this-month)で指定する。「今週」「来週」「今月」も range で1発で引ける。" +
				"range を使えば事前 get-current-time なしで「今日の空き時間」を1発で引ける。",
			inputSchema: getFreeBusyInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ timeMin, timeMax, range, timeZone, calendarId }) => {
			try {
				// list-events-expanded と同一の XOR 検証 + 範囲解決を共有する(resolveRequestRange)。
				const nowMillis = Date.now();
				const { rangeStartMillis, rangeEndMillis, zone } = resolveRequestRange({ timeMin, timeMax, range, timeZone, nowMillis });

				// 【2026-07-22 レイテンシ案2: list-events-expanded と同じくコレクション横断1クエリ化】
				// 旧実装は resolveCollectionIds(findAllByOwner + N+1 hydrate)+ ComputeFreeBusy を N 並列 +
				// server 側でもう一度 coalesceBusyIntervals、という構成だった。ComputeFreeBusyAcrossOwner が
				// owner スコープの候補を 1 クエリで取り、横断 coalesce まで内包するので、server から
				// マージ/coalesce の知識が消える(get-freebusy は calendarIds を受けないので calendarId/
				// 全横断の 2 択。collectionIdArg に calendarIds を渡さず undefined フォールバックさせる)。
				const collectionIds = collectionIdArg(calendarId);
				const computeFreeBusy = new ComputeFreeBusyAcrossOwner(deps.resourceRepo, deps.iterator);
				const fb = await computeFreeBusy.execute({
					owner: principal,
					rangeStartMillis,
					rangeEndMillis,
					floatingTimeZone: zone,
					collectionIds,
				});

				const busy = fb.intervals.map((iv) => ({
					start: epochToIso(iv.startMillis, zone),
					end: epochToIso(iv.endMillis, zone),
					type: iv.type,
				}));

				// resolvedRange(2026-07-16 時刻グラウンディング): list-events-expanded と対称に
				// 「実際に使った範囲 + サーバー now」を additive に載せる(range/絶対どちらでも常に載せて一貫)。
				const result = {
					timeZone: zone,
					busy,
					resolvedRange: {
						timeMin: epochToIso(rangeStartMillis, zone),
						timeMax: epochToIso(rangeEndMillis, zone),
						serverNow: epochToIso(nowMillis, zone),
						timeZone: zone,
					},
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

	// --- list-calendars(直近タスク: ListCollections UC を MCP から露出)-------------------
	server.registerTool(
		"list-calendars",
		{
			title: "List calendars",
			description:
				'認証ユーザーが持つカレンダー/リマインダーリストの一覧を返す。各項目の "id" が' +
				"list-todos/create-todo 等の calendarId、components に含まれる \"VTODO\" がリマインダーリスト・" +
				'"VEVENT" がカレンダー(予定)であることを示す。',
			inputSchema: listCalendarsInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => {
			try {
				const listCollections = new ListCollections(deps.collectionRepo);
				const { collections } = await listCollections.execute({ owner: principal });
				const calendars = collections.map((c) => ({
					id: c.id,
					displayName: c.displayName,
					// supportedComponents undefined = 全種別受理(R2)。モデルへの応答では「実際に
					// 何が入れられるか」を具体的に示したいので、undefined のときは COMPONENT_KINDS
					// 全種を明示展開する(calendar-collection.ts accepts() の undefined=全受理という
					// ドメインの約束を presentation 層でここだけ具体化する。domain 層自体は
					// undefined のまま保つ判断を尊重し、ここでの展開は表示専用)。
					components: c.supportedComponents ?? (["VEVENT", "VTODO", "VJOURNAL"] as const),
					...(c.color !== undefined ? { color: c.color.toString() } : {}),
				}));
				const result = { calendars };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- create-calendar(直近タスク: CreateCollection UC を MCP から露出。DAV MKCALENDAR と同じ UC)--
	// 【なぜ registerAppTool 化したか(2026-07-14 追記・ユーザーフィードバック「操作には UI が
	// 伴うべき。空でも表示したほうがよい」)】新規リスト作成直後は当然タスクが0件だが、
	// list-todos と同じ TODOS_UI_URI(空のリストカード=ヘッダに新リスト名+quick-add)を出せば、
	// その場でタスクを追加する導線がカード内で完結する。todos-entry.ts は vm.calendarId を
	// ヘッダ表示と quick-add の作成先(currentCalendarId)に使う設計なので、structuredContent を
	// TodosViewModel 形にするだけで「新リストのカード」が成立する — UI 側(ui/)を触る必要はない。
	registerAppTool(
		server,
		"create-calendar",
		{
			title: "Create calendar",
			description:
				"新規カレンダー/リマインダーリストを作成する(RFC 4791 MKCALENDAR と同じユースケース)。" +
				'components を省略すると VTODO 用(リマインダーリスト)として作られる。作成後の id は' +
				"create-todo/list-todos の calendarId としてそのまま使える。id を省略した場合、同じ" +
				"displayName で呼び出すと同じ id に解決される(再送は同じコレクションに収束し安全に" +
				"繰り返せる)。同じ displayName でもう1つ別のリストを意図的に作りたい場合は、id を" +
				"明示的に指定すること(省略すると既存のものが返る)。",
			inputSchema: createCalendarInputShape,
			annotations: CREATE_CALENDAR_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, displayName, components, color, timeZone }) => {
			// 2026-07-23 再設計(ユーザー裁定・2回目): displayName 単位の重複検出/矯正は撤回し、
			// 冪等性は「id の安定化」だけで実現する(create-collection.ts 冒頭コメント・
			// CREATE_CALENDAR_ANNOTATIONS コメント参照)。
			// 【成功応答の組み立てを共通化する理由】新規作成できた場合と、id 衝突を検出して
			// 既存コレクションを返す場合(下の handleIdCollision)とで、result/structuredContent の
			// 組み立てロジックが同じなので、ここでヘルパー化して重複を避ける。content のテキストは
			// 「新規作成した」/「既存を返した」で出し分ける。
			const buildSuccessResponse = async (collection: CalendarCollection, note: string | null) => {
				const result = {
					id: collection.id,
					displayName: collection.displayName,
					components: collection.supportedComponents ?? (["VTODO"] as const),
					...(collection.color !== undefined ? { color: collection.color.toString() } : {}),
				};
				// structuredContent は TodosViewModel 契約(UI が読む形)にする。tasks を空配列で
				// 決め打ちしない理由: 作成直後でも実在確認を兼ねて実際に ListTodos を1回通しておくと、
				// 将来 CreateCollection が「既存タスクを引き継いだ複製」等になっても壊れない
				// (buildTodosViewModel は他の mutate 系ツールと同じ経路なので挙動が揃う)。既存流用時
				// (note !== null)もこの1回だけで済ませる(既存にタスクが既にあってもそのまま返せる)。
				// カレンダーのメタ情報(displayName/components/color)は UI 契約に不要なので
				// content(text)側にだけ残し、structuredContent には calendarId のみ載せる。
				const vm = await buildTodosViewModel({ calendarId: collection.id, timeZone });
				// content[0] は従来どおり JSON.stringify(result) だけにする(既存テスト/呼び出し元が
				// content[0].text を JSON.parse する契約を壊さないため)。既存流用時の説明文
				// (note)はモデル向けの補足情報として content[1] に別要素で足す — 同じ文字列に
				// 混ぜると JSON.parse が壊れる(JSON の後ろに文字列が続くと構文エラーになる)。
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
						...(note !== null ? [{ type: "text" as const, text: note }] : []),
					],
					structuredContent: vm as unknown as { [key: string]: unknown },
				};
			};
			try {
				const supportedComponents: readonly ComponentKind[] = (components ?? ["VTODO"]) as readonly ComponentKind[];
				const parsedColor = color !== undefined ? AppleColor.parse(color) : undefined;
				const createCollection = new CreateCollection(deps.collectionRepo);
				// id を明示指定したかどうかで「衝突時の扱い」を変える(下の CollectionAlreadyExistsError
				// ハンドリング参照)。呼び出し元が id を渡した = 「この URL セグメントに作りたい」という
				// 具体的な意図の表明なので、衝突は常にエラーとして呼び手に伝える(黙って別物を返さない)。
				const idWasExplicit = id !== undefined;
				// 【なぜ最大試行回数を設けたループにしたか(id 省略時の slug/hash 衝突対策)】
				// slugifyForCollectionId は「同じ displayName → 同じ id」という安定性を優先して
				// いるため(server.ts コメント参照)、正規化後に同じ slug/hash になる別の displayName
				// (例: "Work!!!" と "Work???" は同じ "work" になる)が偶然ぶつかることがありうる。
				// この場合は「同一リクエストの再送」ではなく「別物を同じ id で作ろうとした事故的衝突」
				// なので、既存を横取りせず接尾辞を振って別 id で新規作成する(下のループ)。上限を
				// 設けるのは、万一 findById が壊れて常に既存ヒットし続けるような異常系で無限ループに
				// ならないようにするための安全装置(通常は1〜2回で空きが見つかる)。
				const MAX_SUFFIX_ATTEMPTS = 20;
				let candidateId = id ?? slugifyForCollectionId(displayName);
				for (let attempt = 0; ; attempt++) {
					try {
						const { collection } = await createCollection.execute({
							owner: principal,
							collectionId: candidateId,
							displayName,
							supportedComponents,
							color: parsedColor,
						});
						return await buildSuccessResponse(collection, null);
					} catch (error) {
						if (!(error instanceof CollectionAlreadyExistsError)) {
							throw error;
						}
						const existing = await deps.collectionRepo.findById(principal, error.collectionId);
						const sameRequest =
							existing !== null &&
							normalizeDisplayNameForComparison(existing.displayName) ===
								normalizeDisplayNameForComparison(displayName);
						if (idWasExplicit) {
							// id を明示指定した衝突は常にエラー(displayName が一致していても)。
							// 【仕様判断(親への報告事項)】id を明示するのは「この URL セグメントに
							// 作りたい」という具体的な意図の表明であり、たまたま displayName まで
							// 一致していても「id を指定したのに黙って既存が返ってくる」方が驚き最小の
							// 原則に反すると判断した。同名でもう1つ意図的に作りたい場合は id を変えて
							// もらう(そのための明示指定でもある)。
							return toolError(error.message);
						}
						if (sameRequest) {
							// id 省略時に自動生成した id が既存と衝突し、かつ displayName も一致 =
							// 「同一リクエストの再送」とみなし、新規作成せず既存を成功として返す
							// (真の冪等の核心 — ここが本タスクの主眼)。
							return await buildSuccessResponse(
								existing,
								"既存のコレクションを返しました(新規作成していません)。" +
									`id="${existing.id}" は既に同じ displayName で存在していました。` +
									"同じ名前でもう1つ別のリストを作りたい場合は、id を明示的に指定して" +
									"create-calendar を呼び直してください。",
							);
						}
						// displayName が異なるのに id だけ衝突した = slug/hash 衝突。事故的な
						// なりすましを避けるため、既存を横取りせず接尾辞付きの別 id で再試行する。
						if (attempt + 1 >= MAX_SUFFIX_ATTEMPTS) {
							return toolError(
								`id の自動生成が ${MAX_SUFFIX_ATTEMPTS} 回連続で衝突しました。` +
									`id を明示的に指定して create-calendar を呼び直してください。`,
							);
						}
						const baseId = id ?? slugifyForCollectionId(displayName);
						candidateId = `${baseId}-${attempt + 2}`;
						continue;
					}
				}
			} catch (error) {
				// InvalidIdentifierError(id/自動生成 slug が不正 — 通常 slugify 側で防げるが id 手動
				// 指定時は起きうる)/ AppleColor.parse の形式エラーはそのまま入力起因エラーとして返す
				// (Error のまま)。CollectionAlreadyExistsError は上のループ内で処理済みなのでここには
				// 届かない(ループが catch せず re-throw するのは CollectionAlreadyExistsError 以外)。
				if (error instanceof InvalidIdentifierError) {
					return toolError(error.message);
				}
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- delete-calendar(list-calendars/create-calendar の対。UI 無しの素の registerTool) ---
	server.registerTool(
		"delete-calendar",
		{
			title: "Delete calendar",
			description:
				"カレンダー/リマインダーリストを削除する。既定では中身(予定/リマインダー)が1件以上ある" +
				"コレクションは拒否する(誤操作で予定・リマインダーが巻き添えで消えるのを防ぐ安全装置)。" +
				"中身ごと削除したい場合のみ force:true を指定する。",
			inputSchema: deleteCalendarInputShape,
			annotations: DELETE_ANNOTATIONS,
		},
		async ({ id, force }) => {
			try {
				// R1(docs/modeling/15 §A-3): confirmToken 検証は撤去(受け取っても無視。schema 上は
				// deleteCalendarInputShape.confirmToken に残るが未使用 — 破壊的操作の確認要否はホストが
				// annotations(下の DELETE_ANNOTATIONS)を見て判断する)。
				const targetId = mkCollectionId(id);
				const deleteCollection = new DeleteCollection(deps.collectionRepo, deps.resourceRepo);
				await deleteCollection.execute({ owner: principal, collectionId: targetId, force });
				const result = { id: targetId, deleted: true };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				// InvalidIdentifierError(id が不正な文字列)/ CollectionNotFoundError(存在しない id)/
				// CollectionNotEmptyError(非空コレクションへの force なし削除)いずれも「入力起因の
				// エラー」としてメッセージをそのまま返す(create-calendar と同じ toolError 流儀。
				// CollectionNotEmptyError のメッセージには件数と force の使い方が既に含まれる —
				// delete-collection.ts 参照)。
				if (
					error instanceof InvalidIdentifierError ||
					error instanceof CollectionNotFoundError ||
					error instanceof CollectionNotEmptyError
				) {
					return toolError(error.message);
				}
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- update-calendar(K2: list-calendars/create-calendar/delete-calendar の対を埋める。
	// UI 無しの素の registerTool — create-calendar と違い、既存カードの再描画は目的ではなく
	// 「メタデータを変えて確認結果を返す」だけの単発操作なので TODOS_UI_URI を紐付けない
	// [下記 (a) を参照]) ---------------------------------------------------------------------
	server.registerTool(
		"update-calendar",
		{
			title: "Update calendar",
			description:
				"カレンダー/リマインダーリストの表示名(displayName)または色(color)を変更する" +
				"(RFC 4918 PROPPATCH と同じユースケース。iOS 側からの変更と同じ経路)。" +
				"displayName/color の少なくとも一方を指定すること(両方省略はエラー)。",
			inputSchema: updateCalendarInputShape,
			annotations: UPDATE_CALENDAR_ANNOTATIONS,
		},
		async ({ id, displayName, color }) => {
			try {
				// no-op ガード: 両方省略はツール呼び出しとして無意味(updateCalendarInputShape コメント
				// 「displayName/color 両方省略を拒否する理由」参照)。UC を呼ぶ前にここで弾く。
				if (displayName === undefined && color === undefined) {
					return toolError(
						"displayName と color のどちらも指定されていません。変更する項目を少なくとも" +
							"一方指定してください(両方省略は変更対象が無く no-op になるため拒否します)。",
					);
				}
				const targetId = mkCollectionId(id);
				const updateCollectionProperties = new UpdateCollectionProperties(deps.collectionRepo);
				// AppleColor.parse の形式エラーは UC 内部(execute)で投げられ、下の catch で
				// InvalidIdentifierError と同様「入力起因エラー」として toolError に変換する
				// (create-calendar の color 検証と同じ流儀 — AppleColor は他の hex 検証と同じ VO)。
				const { collection } = await updateCollectionProperties.execute({
					owner: principal,
					collectionId: targetId,
					displayName,
					color,
				});
				// (a) structuredContent/content: create-calendar の TodosViewModel 流儀(空カードでも
				// 見せる)は「作成直後に空リストを提示する」という create 特有の UX 目的のためのもの。
				// update-calendar は既存カードの表示名/色が変わるだけで、カード側の再描画は
				// K2-UI(次スライス、タスク仕様の「カード反映は次スライス」)の役割。ここでは
				// list-calendars と対称な素の {id, displayName, color, components} を返すに留める
				// (仕様が要求する応答形そのもの)。
				const result = {
					id: collection.id,
					displayName: collection.displayName,
					components: collection.supportedComponents ?? (["VEVENT", "VTODO", "VJOURNAL"] as const),
					...(collection.color !== undefined ? { color: collection.color.toString() } : {}),
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} catch (error) {
				// InvalidIdentifierError(id が不正な文字列)/ CollectionNotFoundError(存在しない id)/
				// AppleColor.parse の形式エラー(不正 hex)いずれも「入力起因のエラー」として
				// メッセージをそのまま返す(create-calendar/delete-calendar と同じ toolError 流儀)。
				if (error instanceof InvalidIdentifierError || error instanceof CollectionNotFoundError) {
					return toolError(error.message);
				}
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- create-todo(E-1 スライス① / E-2 スライス②で ui:// を紐付け + 差分レンズ化)-----
	// registerAppTool 化して list-todos と同じ TODOS_UI_URI を紐付ける(_meta.ui.resourceUri +
	// "openai/outputTemplate")。structuredContent は差分レンズ付き確定一覧(TodosViewModel)に
	// 差し替える。UI 紐付けの可逆性・2キー併記の理由は下の list-todos コメント参照。
	registerAppTool(
		server,
		"create-todo",
		{
			title: "Create todo",
			description:
				"新規 VTODO(リマインダー)を作成する。UID/DTSTAMP はサーバーが生成する。priority は 1=高/5=中/9=低(iOS 準拠、「緊急」段階は無い)。" +
				'due は "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone 必須)。時刻付き due には自動で VALARM(due 時刻の通知)が付く。' +
					// E-2 スライス③: quick-add(UI のタイトル1行入力)や calendarId 省略の呼び出し経路が増えたため、
					// 既定保存先を description 本文にも明示する(従来は inputSchema の calendarId フィールドの
					// describe にだけ書いていたが、ツール選択・省略時挙動の判断材料として本文にも出す)。
					' calendarId を省略した場合は "tasks" コレクションに作成する。' +
					// 2026-07-14 create-todos バッチ追加: 「5冊追加して」のような複数件依頼で
					// create-todo を繰り返し呼ぶと、1呼び出し=1カード仕様のホスト UI にフル一覧
					// カードが N 枚積まれる実害があったため、複数件は create-todos へ誘導する。
					"2件以上のリマインダーをまとめて追加する場合は create-todo を繰り返し呼ばず、必ず create-todos を使うこと。",
			inputSchema: createTodoInputShape,
			annotations: CREATE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ title, notes, due, timeZone, priority, calendarId, recurrence, locationReminder }) => {
			try {
				// recurrence 正規化(Case E): frequency:"none" は presentation 限定の語彙なので、
				// application 層に渡す前にここで吸収する(上の createTodoRecurrenceInputShape
				// コメント「Case E 採用」参照)。"none" + サブフィールド併用は黙殺せずエラーにする
				// (ユーザー/LLM が意図した反復設定が静かに消えるのを防ぐ)。2026-07-14: create-todos
				// バッチ追加に伴い normalizeCreateTodoRecurrenceInput 共通ヘルパーへ切り出した
				// (throw する流儀になったので、ここでは try ブロック内から呼ぶだけでよい —
				// 投げられた RangeError は下の catch の catch-all で toolError に変換される)。
				const normalizedRecurrence = normalizeCreateTodoRecurrenceInput(recurrence);

				// locationReminder 解決(#51): structuredLocation 明示 or location 文字列の自動解決。
				// 解決不能なら resolveLocationReminder が LocationReminderUnresolvedError を投げ、下の
				// catch-all が toolError に変換する(位置なし todo を作らない)。geo は presentation で解決し、
				// application 層(CreateTodo)には座標付き ProximityAlarmInput を渡す(geocoding を知らせない)。
				const resolvedReminder =
					locationReminder !== undefined ? await resolveLocationReminder(deps, principal, locationReminder) : undefined;

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
					// B: location 引数は全廃(上の createTodoItemFieldsShape コメント参照)。CreateTodo は location を
					// 受け取らなくなり LOCATION を書かない — 場所の意味は proximity VALARM(C8)に一本化する。
					recurrence: normalizedRecurrence,
					// #51: 位置リマインダー(解決済み座標付き)。省略時は undefined = proximity VALARM を書かない。
					locationReminder: resolvedReminder?.proximity,
				});
				// affected: 新規作成 = "added"。新 UID は createTodo が返した task.id。確定一覧は
				// 作成先 calendarId・create 入力の timeZone(due 表示ゾーン)で ListTodos を再実行して
				// 得る(反復作成でも作られるのはマスター1件なので affected は常にこの1件でよい)。
				// task: snapshotFromTask で自己完結描画用スナップショットを添える(案X・2026-07-13。
				// tasks に実在する kind でも一貫性のため常に添える契約 — todos-view-model.ts 参照)。
				const vm = await buildTodosViewModel({
					calendarId,
					timeZone,
					affected: [{ id: task.id, kind: "added", task: snapshotFromTask(task) }],
				});
				const resp = await toTodosToolResponse(vm);
				// #51: 解決した場所(title/address)を応答 content に明示する(誤った場所で通知が鳴る実害回避)。
				// content の先頭に足すことで、非 UI ホストでも「どの場所に設定したか」が最初に読める。
				if (resolvedReminder !== undefined) {
					resp.content.unshift({ type: "text" as const, text: resolvedReminder.note });
				}
				return resp;
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

	// --- create-todos(2026-07-14: 複数件バッチ追加ツール。create-todo 語彙の穴を塞ぐ) -------
	// registerAppTool 化して create-todo と同じ TODOS_UI_URI を紐付ける。N 件の追加を「1回の
	// mutate」として扱い、affected に N 件の {kind:"added"} を積んだ1つの TodosViewModel を
	// 返すことで、1 呼び出し=1カードのホスト UI に N 行が becoming-in で入るようにする
	// (create-todo を N 回呼ぶと N 枚のフル一覧カードが積まれる、という当初の実害の解消)。
	registerAppTool(
		server,
		"create-todos",
		{
			title: "Create todos (batch)",
			description:
				"複数のリマインダー(VTODO)をまとめて追加する。2件以上の追加は必ずこちらを使うこと" +
				"(1件ずつ create-todo を繰り返し呼ぶと、ホスト UI に一覧カードが呼び出し回数分積まれてしまう)。" +
				"各 item は create-todo と同じ語彙(title 必須、notes/due/priority/recurrence は省略可)。" +
				'calendarId/timeZone は全 item 共通。省略時の保存先は "tasks"。' +
				"1件だけ追加する場合は create-todo を使ってよい(create-todos でも動くが単発なら簡潔な方を推奨)。",
			inputSchema: createTodosInputShape,
			annotations: CREATE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ items, calendarId, timeZone }) => {
			try {
				// PutCalendarObject/CreateTodo は1回だけ合成して item ループ全体で使い回す
				// (create-todo 単発と同じ構成。item ごとに作り直す必要は無い — 依存はステートレス)。
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createTodo = new CreateTodo(putCalendarObject);

				const succeeded: AffectedTask[] = [];
				const failed: { title: string; reason: string }[] = [];

				// 【なぜ並列化しないか(直列実行の理由)】D1 は1コレクション内の PUT が sync token を
				// 単調増加させる書込みであり、並列に投げると書込み競合(同一コレクションへの
				// 複数トランザクション)や sync token の順序保証が崩れるおそれがある。PutCalendarObject
				// 内部で UoW を使うが、UoW 自体は「1回の PUT の原子性」しか保証せず「複数 PUT 間の
				// 直列性」までは保証しない設計(collection-unit-of-work.ts 参照)。よってこの
				// 呼び出し側(バッチの親)が for await で1件ずつ完了を待ってから次に進める。
				for (const item of items) {
					try {
						const normalizedRecurrence = normalizeCreateTodoRecurrenceInput(item.recurrence);
						const { task } = await createTodo.execute({
							owner: principal,
							title: item.title,
							notes: item.notes,
							due: item.due,
							timeZone,
							priority: item.priority,
							calendarId,
							// B: location 引数は全廃(create-todo と同じ。createTodoItemFieldsShape のコメント参照)。
							recurrence: normalizedRecurrence,
						});
						succeeded.push({ id: task.id, kind: "added", task: snapshotFromTask(task) });
					} catch (error) {
						// 【途中失敗時にロールバックしない理由】既に PUT 済みの成功分を取り消すと、
						// 削除という「さらなる失敗面」を増やすだけ(削除自体も ETag/If-Match 等で
						// 失敗しうる)。CalDAV の PUT は本来1リソース単位の操作であり、このバッチは
						// あくまで presentation 層の利便機能(N 回の PUT を1呼び出しにまとめただけ)。
						// よって「そこまでの成功分は残す」を基本方針にし、失敗した item だけを
						// failed に積んで応答の text で明示する(部分成功を隠さない)。
						failed.push({ title: item.title, reason: error instanceof Error ? error.message : String(error) });
					}
				}

				// 確定一覧は成功分の affected を載せた1回の ListTodos 再実行(create-todo 単発と同じ
				// buildTodosViewModel 経路)。affected が空(全滅)なら未定義のままにする既存の
				// 「空配列を載せない」規約(buildTodosViewModel コメント参照)に合わせる。
				const vm = await buildTodosViewModel({
					calendarId,
					timeZone,
					affected: succeeded.length > 0 ? succeeded : undefined,
				});

				// content(text)側は「非 UI ホスト向けの後方互換」だが、create-todo 単発と違い
				// 部分成功がありうるバッチなので、JSON.stringify(vm) だけでは成功/失敗の内訳が
				// 埋もれる。成功 N 件・失敗タイトルと理由を明記したサマリ文にする(仕様どおり
				// 「部分成功を隠さない」)。
				const summaryLines = [`${succeeded.length}/${items.length} 件のリマインダーを作成しました。`];
				if (failed.length > 0) {
					summaryLines.push("失敗した項目:");
					for (const f of failed) summaryLines.push(`- "${f.title}": ${f.reason}`);
				}
				return {
					content: [{ type: "text" as const, text: summaryLines.join("\n") }],
					structuredContent: vm as unknown as { [key: string]: unknown },
				};
			} catch (error) {
				// items 配列の共通パラメータ(calendarId/timeZone)自体が不正など、ループに入る前/
				// buildTodosViewModel(resolveTimeZone)で起きるバッチ全体のエラーはここで拾う。
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
	// TodosViewModel を MCP ツールの戻り値エンベロープ(content + structuredContent)に包む。
	// content 側は「非 UI ホスト(structuredContent の生テキストしか読まない)」向けの後方互換。
	// 【structuredContent の cast が要る理由】MCP SDK の structuredContent 型は
	// `{ [x: string]: unknown }`(任意キーの index signature)を要求する。get-current-time 等は
	// インラインのオブジェクトリテラルを渡すので暗黙に満たせるが、TodosViewModel は「閉じた
	// contract 型」(UI と共有する明示的な形)なので index signature を持たず、そのままでは
	// 代入できない。contract 型を index signature で緩めると UI 契約の型安全が崩れるため、
	// 境界(SDK へ渡す1点)でだけ cast して閉じた型を保つ。
	// S1(docs/modeling/14 §6 項目5): 全 todos カード応答に免除トークン(cardToken)を _meta.confirm へ
	// 載せる。カードは swipe/詳細ページの delete-todo でこれを confirmToken として返す(propose を経ず
	// カード自身が確認 UI を担う経路の免除)。_meta はモデルの content に入らないのでトークンは漏れない。
	// async 化したのは署名(getCardToken)が Promise のため — 呼び出し側は async ハンドラ内で
	// `return toTodosToolResponse(vm)` のまま Promise を返せば auto-await される(既存の呼び出しは無改修)。
	const toTodosToolResponse = async (vm: TodosViewModel) => ({
		content: [{ type: "text" as const, text: JSON.stringify(vm) }],
		structuredContent: vm as unknown as { [key: string]: unknown },
		_meta: { confirm: { cardToken: await getCardToken() } },
	});

	// ListTodos を同 principal・同 calendarId で実行して「操作後の確定一覧」を作り、渡された
	// 差分メタ(affected/removed)を載せた TodosViewModel を返す共通クロージャ。参照系
	// (list-todos/refresh-todos)も mutate 系(create/complete/update/delete)もこれを共有し、
	// 全 todos ツールが「同じ ListTodos 経路 = 同じ認可・同じ確定値」で一覧を組む。
	//
	// 【mutate 系でも includeCompleted は指定しない(= 既定 false)理由】
	// 確定一覧 tasks は list-todos/refresh-todos と同じ「未完了ビュー」に揃える(contract の
	// 「list-todos と同じ ListTodos UC を再実行」を素直に守る)。完了したタスクは
	// affected:{kind:"completed"} で id を載せるだけで tasks からは抜ける — UI は前回描画に残って
	// いたその行を「抜けていく(becoming)」演出で消せる。この「completed は一覧から消え affected
	// だけが残り香を伝える」形が UI 契約とズレないかは親レビューの論点。
	//
	// 【E-2 view 状態非保持バグ修正・2026-07-14: view echo を追加した経緯】
	// 以前このコメントは「view 引数の引き継ぎ」を親レビューの論点として残していたが、
	// 「list-todos includeCompleted:true で開いた後 reopen すると完了済みが全部消える」実害が
	// 確定したため確定仕様にした。refresh-todos が引数なし(既定=未完了のみ)固定だったのが原因で、
	// 初回ビューの引数が後続の再取得に引き継がれていなかった。対策:
	//  (1) buildTodosViewModel は渡された view 引数(includeCompleted/dueBefore/dueAfter)のうち
	//      非 undefined のものを vm.view に echo する(全部 undefined なら view 自体を省略=既定ビュー)。
	//  (2) refresh-todos の inputSchema を list-todos と同じ listTodosInputShape にし、UI が保持した
	//      currentView をそのまま渡せるようにする(下の refresh-todos 登録参照)。
	// mutate 系(create/update/complete/delete)は view 引数を渡さない(確定一覧は未完了ビューのまま。
	// モデル向けスキーマを view で汚さない判断=仕様3)ので、mutate 応答には view キーは載らない。
	const buildTodosViewModel = async (opts: {
		includeCompleted?: boolean;
		dueBefore?: string;
		dueAfter?: string;
		calendarId?: string;
		timeZone?: string;
		affected?: AffectedTask[];
		removed?: TaskSnapshot[];
		/** move-todo のみ。TodosViewModel.movedTo の JSDoc 参照。 */
		movedTo?: string;
	}): Promise<TodosViewModel> => {
		const zone = resolveTimeZone(opts.timeZone);
		// 【次の伸びしろ(今回スコープ外)】この確定一覧は応答契約(TodosViewModel.tasks)上必要なので
		// 残す。ただし ListTodos は findAllInCollection で全リソースを引いてメモリで VTODO/STATUS/DUE を
		// 絞る(list-todos.ts の設計)ため、コレクションが大きいと 1 mutate で必ず1回の全件読みが残る。
		// さらに削るなら「VTODO 種別・未完了・due 範囲を SQL(D1)側で絞る専用ポート」を足すのが本筋
		// (2026-07-14 レイテンシ改善では UC の before/removed 化で presentation 側の余計な全件読みを
		// 消すところまでに留め、SQL レベルの絞り込みは別タスクにする)。
		const listTodos = new ListTodos(deps.resourceRepo);
		// 【2026-07-23 症状B対策・同日中にコーディネーターの再指摘で修正】
		// 当初は ListTodos を dueBefore/dueAfter を含めて1回呼び、その結果(allTasks)から
		// completedSummary も導いていた。だがこれだと due 窓付きの list-todos 呼び出し(例:
		// モデルが「今週のタスク」で dueBefore/dueAfter を指定)のとき completedSummary.total が
		// due 窓で痩せてしまい、「completedSummary はどんな view の push でも不変」という症状Bの
		// 治療原則そのものが再発する(完了済みタスクにも due が付いていることがあるため、
		// dueBefore/dueAfter が完了済み側の集計まで削ってしまう)。
		// 【2026-07-23 K3 直後・コーディネーター指摘で再修正: calendarId スコープからも独立させる】
		// 上の due 窓修正だけでは足りなかった。K3(todos カードの横断取得+クライアント側フィルタ)
		// 後もモデル発の list-todos/create-todo 等は calendarId を明示指定して呼べる(単一
		// コレクション scoped 呼び出し)。この push がカードへ届くと、completedSummary.total が
		// 「owner 全体の完了済み件数」と「そのコレクションだけの完了済み件数」の間で揺れてしまい、
		// due 窓のときと同じ「サマリはどんな view の push でも不変」という症状Bの治療原則の再発に
		// なる(親レビュー指摘)。よって completedSummary の計算元は **calendarId スコープも
		// due 窓と同じく無視し、常に owner 配下の全 VTODO コレクション横断** から導出する。
		// 【修正】ListTodos は **calendarId を渡さず**(= list-todos.ts の ListTodosInput.calendarId
		// JSDoc どおり owner 横断)・due 引数も渡さず・includeCompleted:true の1回だけ呼ぶ。
		// allTasksAcrossOwner は「owner 配下の全 VTODO コレクション・due 窓非フィルタ・
		// コレクション非絞り・完了/未完了とも全件」になる。completedSummary はこの完全な値から
		// 計算する(due 窓にもコレクション指定にも影響されない)。
		// tasks(応答契約どおりの絞り込み結果)は、この allTasksAcrossOwner に対して
		// (1) opts.calendarId が指定されていればそのコレクションへメモリでスコープを絞り、
		// (2) ListTodos.execute 自身が内部で使うのと同じ純関数 filterTasksByWindow(list-todos.ts
		//     から export)で due 窓/完了フィルタを適用する、の2段で導出する
		// (due 窓判定ロジックを presentation に複製しない=単一情報源。list-todos.ts の
		// filterTasksByWindow JSDoc に経緯を集約)。
		// 【D1 SELECT は1回のまま】ListTodos の内部実装は component_kind="VTODO" だけを SQL で絞り、
		// STATUS/DUE/コレクションは元々メモリ側フィルタ(list-todos.ts 冒頭コメント)なので、
		// calendarId/due 引数を渡さず includeCompleted:true で呼んでも(単に絞り込みをこの関数側の
		// メモリへ肩代わりさせるだけなので)D1 への追加 SELECT は発生しない。IAD レイテンシ事情
		// (2026-07-14 レイテンシ改善の経緯)により追加ラウンドトリップは避ける制約を守っている
		// (owner 横断1クエリの転送量は単一コレクション時より増えるが、K3 で todos カード自体が
		// 常時この横断量を扱う設計へ既に移行済みなので、mutate 系だけ特別に軽い経路を保つ意味は
		// 薄いと判断した)。
		const { tasks: allTasksAcrossOwner } = await listTodos.execute({
			owner: principal,
			includeCompleted: true,
			timeZone: zone,
		});
		// tasks: 応答契約どおり「呼び出し側が指定した calendarId/includeCompleted/dueBefore/dueAfter」
		// に従って絞る。calendarId は opts.calendarId が指定されているときだけこの1段でスコープを
		// 絞る(未指定 or "all" は絞らず owner 横断のまま=list-todos.ts の ListTodosInput.calendarId
		// と同じ語彙)。includeCompleted 未指定=false=未完了のみ(mutate 系が includeCompleted を
		// 渡さないのは buildTodosViewModel コメントの「確定一覧は未完了ビューに揃える」方針のまま変えない)。
		const collectionScoped =
			opts.calendarId !== undefined && opts.calendarId !== "all"
				? allTasksAcrossOwner.filter((t) => t.calendarId === opts.calendarId)
				: allTasksAcrossOwner;
		const tasks = filterTasksByWindow(collectionScoped, {
			includeCompleted: opts.includeCompleted,
			dueBefore: opts.dueBefore,
			dueAfter: opts.dueAfter,
			timeZone: zone,
		});
		// completedSummary: 完了済みの総数 + completedAt 新しい順の直近 COMPLETED_RECENT_MAX 件。
		// **due 窓もコレクションスコープも通していない allTasksAcrossOwner** から計算する
		// (上のコメントの核心・不変条件は「due 窓からもcalendarId スコープからも独立」)。計算ロジックは
		// 純関数 buildCompletedSummary(todos-diff.ts)に抽出済み(D1/principal 非依存なので Task
		// フィクスチャだけで単体テストできる — mcp-todos-diff.test.ts 参照)。symptom B の背景は
		// todos-view-model.ts の completedSummary JSDoc に集約 — includeCompleted/dueBefore/dueAfter
		// の値に関係なく常にこの形で載る。
		// 【K3(2026-07-23) calendarId echo: agenda echo pin(56cbb73)と同じ「単一 ID を偽装しない」規律】
		// 旧実装は calendarId 省略時も `?? "tasks"` で架空の単一 ID を echo していた。これは D 案
		// (otherTodoCollections)前提の「省略=tasks だけ見せる」挙動と対だったが、K3 で省略時の
		// ListTodos は owner 横断に変わった(ListTodosInput.calendarId JSDoc 参照)。横断結果に対して
		// 単一 ID を名乗ると、agenda 側で実際に起きた「echo を currentCalendarId に固定保存 → 2回目
		// 以降の refetch が単一コレクションへ静かに collapse する」のと同じ事故を招く。よって
		// 省略/横断時は正直に null を返す(単一指定時のみその値を echo)。UI(todos-entry.ts)は
		// この null/非 null を「今回の応答が横断か、特定リスト由来か」の判別に使う(K3 の設計判断参照)。
		// 【2026-07-23 SWR 完全形: generatedAt を常時付与(additive)】この view model を Worker が
		// 生成した時刻(epoch ms)。TodosViewModel.generatedAt JSDoc / todos-entry.ts の
		// shouldRevalidateOnPush 参照。ここで Date.now() を取る(=応答直前)ことで、ListTodos の
		// D1 往復にかかった時間まで含めて「この結果を見せてよい鮮度の起点」を正確に刻める
		// (呼び出し側 handler で先に取った時刻を使うと D1 の遅延分だけ古く見積もることになり、
		// 鮮度判定が実態より辛めに倒れる=無害な方向だが、ここで取るほうが素直で理由がいらない)。
		// 2026-07-23(#47) センチネル統一: opts.calendarId === "all"(モデルが明示的に横断を指定した
		// 入力語彙)を、省略時と同じ null echo へ揃える。以前は "all" をそのまま echo しており、
		// UI(todos-entry.ts)側が rawIncomingCalendarId==="all" を ALL_CALENDARS_ID(UI 内部の
		// 横断センチネル "__all__")へ正規化する後方互換コードで吸収していた(2026-07-23 実機FB是正)。
		// 「横断は calendarId:null」という単一の契約に揃えることで、新しいカード応答はもう "all" を
		// 出さなくなる(list-todos の**入力**側が "all" を受理する語彙は変えない — ListTodosInput.calendarId
		// JSDoc どおり。ここで統一するのはあくまで**出力(echo)**側)。UI の正規化コードは旧カード
		// キャッシュ(古い structuredContent が localStorage 等に残るケース)への後方互換として残す。
		const vm: TodosViewModel = {
			tasks,
			calendarId: opts.calendarId !== undefined && opts.calendarId !== "all" ? opts.calendarId : null,
			timeZone: zone,
			generatedAt: Date.now(),
			// ④ カードの版不整合可視化: 現行デプロイの todos カード版ハッシュ(TodosViewModel.uiHash JSDoc 参照)。
			uiHash: TODOS_UI_HASH,
		};
		vm.completedSummary = buildCompletedSummary(allTasksAcrossOwner, COMPLETED_RECENT_MAX);
		// 空配列を載せると UI が「差分ゼロの mutate」と誤認しかねないので、値があるときだけ載せる。
		if (opts.affected !== undefined) vm.affected = opts.affected;
		if (opts.removed !== undefined) vm.removed = opts.removed;
		if (opts.movedTo !== undefined) vm.movedTo = opts.movedTo;
		// view echo(E-2 view 状態非保持バグ修正): 非 undefined の引数だけを載せる。全部 undefined
		// (既定ビュー)なら view キー自体を省いて後方互換を保つ(旧 UI/旧テストは view 不在前提)。
		// UI はこの view を currentView として保持し、focus refetch / mutation 後の再取得へ引き継ぐ。
		const view: NonNullable<TodosViewModel["view"]> = {};
		if (opts.includeCompleted !== undefined) view.includeCompleted = opts.includeCompleted;
		if (opts.dueBefore !== undefined) view.dueBefore = opts.dueBefore;
		if (opts.dueAfter !== undefined) view.dueAfter = opts.dueAfter;
		if (Object.keys(view).length > 0) vm.view = view;
		return vm;
	};

	// 【findTaskById を廃止した経緯(2026-07-14 MCP レイテンシ改善)】
	// 以前ここには「update の before / delete の removed のために ListTodos 全件を
	// includeCompleted:true で読んで id で引く」ヘルパー findTaskById があった。だが本番計測で
	// POST /mcp wall p95≈1164ms のボトルネックが D1 往復と判明し、トグル1回で ①findTaskById の
	// 全件読み → ②UpdateTodo/DeleteTodo(内部 read + PUT)→ ③確定一覧の全件読み、と3回の
	// 全件級読みが直列に走っていた。UpdateTodo/DeleteTodo は If-Match 解決のため更新前リソースを
	// 既に内部で読んでいる(lookupTodo)。その更新前状態を UC が before/removed として返すように
	// 変えた(update-todo.ts / delete-todo.ts の JSDoc 参照)ので、presentation はもう①の
	// 事前全件読みを行わない — これで3回 → 2回に減る。よって findTaskById は削除した。

	const runListTodos = async (args: {
		includeCompleted?: boolean;
		dueBefore?: string;
		dueAfter?: string;
		calendarId?: string;
		timeZone?: string;
	}) => {
		try {
			// K3: calendarId 省略時はそのまま buildTodosViewModel → ListTodos に渡す(owner 横断は
			// application 層の ListTodos が1クエリで担う)。旧実装がここで行っていた
			// resolveOtherTodoCollections の追加 D1 往復(D 案)は撤去済み(listTodosInputShape の
			// calendarId JSDoc・resolveOtherTodoCollections 撤去コメント参照)。
			return toTodosToolResponse(await buildTodosViewModel({ ...args }));
		} catch (error) {
			return toolError(error instanceof Error ? error.message : String(error));
		}
	};

	registerAppTool(
		server,
		"list-todos",
		{
			title: "List todos",
			description: "VTODO(リマインダー)を一覧する。既定は未完了のみ(includeCompleted:false)。反復 VTODO も master 1件として一覧する(展開はしない)。" +
				"calendarId 省略時は owner 配下の全 VTODO コレクションを横断して一覧する(各 task に由来 calendarId が付く)。" +
				"特定のリストだけを見たいときは calendarId を明示すること。",
			inputSchema: listTodosInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
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
	// 【inputSchema を listTodosInputShape に変えた理由(E-2 view 状態非保持バグ修正・2026-07-14)】
	//   以前は inputSchema:{}(引数なし)で「常に既定ビュー(未完了のみ)」を返していた。だがそれだと
	//   list-todos includeCompleted:true で開いた UI が focus refetch / mutation 後に refresh-todos を
	//   引数なしで叩き、完了済みが一覧から全部消える不具合が起きていた(初回ビューが後続再取得へ
	//   引き継がれない)。UI は描画に使った vm.view を currentView として保持し、それをこの refresh-todos に
	//   渡す(todos-entry.ts の fetchLatest 参照)。よって inputSchema を list-todos と同じ
	//   listTodosInputShape にし、引数をそのまま runListTodos に渡す — 「常に既定ビュー」の前提は撤回した。
	//   handler の実行経路は list-todos と同一(runListTodos 共通クロージャ)のまま。
	registerAppTool(
		server,
		"refresh-todos",
		{
			title: "Refresh todos",
			description:
				"UI(リマインダー一覧 App)専用の再読み込みツール。UI が保持する現在ビュー(includeCompleted 等)を" +
				"引数で受け取り、そのビューの最新一覧を返す(引数なしなら既定=未完了のみ)。" +
				"モデルからは呼べない(visibility:[\"app\"])— UI の focus refetch / mutation 後の再取得が callServerTool で叩く用。",
			inputSchema: listTodosInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI, visibility: ["app"] },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ includeCompleted, dueBefore, dueAfter, calendarId, timeZone }) =>
			runListTodos({ includeCompleted, dueBefore, dueAfter, calendarId, timeZone }),
	);

	// --- update-todo(E-1 スライス②-b / E-2 スライス②で ui:// + 差分レンズ化)------------
	registerAppTool(
		server,
		"update-todo",
		{
			title: "Update todo",
			description:
				"既存 VTODO(リマインダー)の一部フィールドを更新する。指定したフィールドのみ変更し、他は維持する。" +
				"status:\"COMPLETED\"/\"NEEDS-ACTION\" でフィールド更新と同時に完了/再開もできる" +
				"(status:\"COMPLETED\" は complete-todo と同じ D4 モデルで定期タスク(RRULE あり)にも対応)。",
			inputSchema: updateTodoInputShape,
			annotations: DESTRUCTIVE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, title, notes, due, timeZone, priority, status, recurrence, locationReminder }) => {
			try {
				// recurrence 正規化(2026-07-15): presentation 5値 + optional を application の三値
				// (undefined=据え置き / null=除去 / 4値=全置換)へ写す。none + サブフィールド併用は
				// ここで RangeError → catch-all で toolError に変換される(意図した設定を黙殺しない)。
				const normalizedRecurrence = normalizeUpdateTodoRecurrenceInput(recurrence);
				// locationReminder 三値の解決(#51): undefined=変更しない / null=除去 / オブジェクト=解決して設定。
				// null はそのまま UC の「除去」へ流す。オブジェクトは resolveLocationReminder で座標へ解決する
				// (解決不能なら例外 → catch-all で toolError)。zod の .nullable().optional() で null/undefined は区別される。
				let resolvedReminder: ResolvedLocationReminder | undefined;
				let locationReminderPatch: ProximityAlarmInput | null | undefined;
				if (locationReminder === null) {
					locationReminderPatch = null; // 除去。
				} else if (locationReminder !== undefined) {
					resolvedReminder = await resolveLocationReminder(deps, principal, locationReminder);
					locationReminderPatch = resolvedReminder.proximity;
				}
				// before 値: UpdateTodo UC が更新前スナップショットを返す(2026-07-14 レイテンシ改善で
				// UC 側に移した。以前は presentation で findTaskById が別途 ListTodos 全件を読んでいたが、
				// UC が If-Match 検証で内部 read する更新前状態を before として公開したことで、その
				// 事前全件読みを丸ごと省けた。update-todo.ts の UpdateTodoOutput.before JSDoc 参照)。
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const updateTodo = new UpdateTodo(putCalendarObject, deps.resourceRepo, deps.iterator);
				const { task, before } = await updateTodo.execute({
					owner: principal,
					todoId: id,
					calendarId,
					title,
					notes,
					// due は三値(undefined=変更なし / null=除去 / string=設定)をそのまま UC へ渡す
					// (zod の .nullable().optional() で null と undefined が区別されて届く。V6 フォローアップ)。
					due,
					timeZone,
					priority,
					// B: location 引数は全廃(update の inputSchema から削除。UpdateTodo へ location を渡さない=
					// LOCATION を更新しない。読み取り互換のため既存 LOCATION は round-trip で保持される)。
					recurrence: normalizedRecurrence,
					// #51: 位置リマインダー(undefined=据え置き / null=除去 / 解決済み ProximityAlarmInput=設定)。
					locationReminder: locationReminderPatch,
					status,
				});

				// affected の kind 判定:
				//  - status を渡していれば「完了/再開」を優先("COMPLETED"→completed / "NEEDS-ACTION"→reopened)。
				//    複合操作(例「due を伸ばして完了」)でも contract の affected は1 kind なので、状態遷移を
				//    主として扱う(フィールド変更は completed 演出に吸収させ、過剰に edited と併記しない)。
				//  - status 無しでフィールドだけ変えたら "edited" + changes。
				// 【affected の id】status:"COMPLETED" かつ反復 VTODO(D4)のときは UpdateTodo が完了
				//   スナップショットの新 UID を持つ task を返す(complete-todo と同じ)。よって id は
				//   常に「返された task.id」を使う(D4 では新 UID・それ以外は元の id と一致)。
				// 【task スナップショット(案X・2026-07-13)】completed は確定一覧 tasks の未完了
				//   ビューから抜けるため、UI が becoming-done をその場に描けるよう snapshotFromTask を
				//   3分岐すべてに添える(reopened/edited は tasks に実在するが契約上の一貫性で添える)。
				let affected: AffectedTask[];
				if (status === "COMPLETED") {
					affected = [{ id: task.id, kind: "completed", task: snapshotFromTask(task) }];
				} else if (status === "NEEDS-ACTION") {
					affected = [{ id: task.id, kind: "reopened", task: snapshotFromTask(task) }];
				} else {
					// 「渡された(非 undefined)フィールド」を changed とみなす素朴判定(UC が変更フィールドを
					// 返さないため。todos-diff.ts の buildEditedChanges コメント参照)。before が取れなかった
					// (直前に他プロセスが消した等)場合は changes を出さず field も無い edited に degrade する。
					const provided = new Set<string>();
					if (title !== undefined) provided.add("title");
					if (notes !== undefined) provided.add("notes");
					if (due !== undefined) provided.add("due");
					if (priority !== undefined) provided.add("priority");
					// recurrence(2026-07-15)。buildEditedChanges では field のみ載せる(「編集済み」バッジへ degrade する contract)。
					// (B: location は update-todo 引数から全廃したので changed 判定にも含めない)。
					if (recurrence !== undefined) provided.add("recurrence");
					const changes = before !== undefined ? buildEditedChanges(before, task, provided) : undefined;
					affected = [{ id: task.id, kind: "edited", task: snapshotFromTask(task), ...(changes !== undefined ? { changes } : {}) }];
				}

				// 2026-07-17 TZ グラウンディング: 応答一覧の due 表示ゾーンに入力 timeZone を流用する
				// (この timeZone は元々 due 解釈用として受けているものを、応答表示ゾーンにも兼用する。
				// UI カードは完了/再開/編集のいずれでも閲覧デバイスのゾーンを載せてくるので、確定一覧の
				// 時刻付き DUE が UTC 落ちしなくなる)。既定 UTC(resolveTimeZone)は不変。
				const vm = await buildTodosViewModel({ calendarId, timeZone, affected });
				const resp = await toTodosToolResponse(vm);
				// #51: 位置リマインダーを設定/差し替えたときは解決した場所を content に明示する(誤った場所で
				// 通知が鳴る実害回避)。除去(null)時はノート無し(消したことは affected/確定一覧で分かる)。
				if (resolvedReminder !== undefined) {
					resp.content.unshift({ type: "text" as const, text: resolvedReminder.note });
				}
				return resp;
			} catch (error) {
				// TodoNotFoundError / InvalidDueError / DueTimeZoneRequiredError / InvalidTimeZoneError /
				// UnsupportedTimeZoneError / RecurringDueRemovalError(V6 フォローアップの due 系検証)/
				// ETagConditionError / CalDAVPreconditionError / CollectionNotFoundError いずれも
				// 「入力起因のエラー」としてメッセージをそのまま返す(create-todo と同じ扱い。
				// instanceof で特別分岐する意味的な差が無いため catch-all で足りる)。
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- complete-todo(E-1 スライス②-b / E-2 スライス②で ui:// + 差分レンズ化)-----------
	registerAppTool(
		server,
		"complete-todo",
		{
			title: "Complete todo",
			description:
				"VTODO(リマインダー)を完了する(STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100 の三点セット)。" +
				"定期タスク(RRULE あり)は docs/modeling/06 §D4 の D4 モデル(新 UID の完了スナップショットを作り、" +
				"マスターを次回 occurrence へ前進させる)で処理する。",
			inputSchema: completeTodoInputShape,
			annotations: DESTRUCTIVE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, timeZone }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const completeTodo = new CompleteTodo(putCalendarObject, deps.resourceRepo, deps.iterator);
				const { task } = await completeTodo.execute({ owner: principal, todoId: id, calendarId });
				// affected: 完了 = "completed"。id は CompleteTodo が返した task.id を使う。
				// 【反復 D4 での扱い(判断と理由)】反復 VTODO を完了すると CompleteTodo は「完了
				// スナップショット(新 UID)」の task を返し、裏でマスターを次回 occurrence へ前進させる
				// (docs/modeling/06 §D4)。affected には「完了スナップショットの id を completed」で
				// 載せる(= task.id)。マスター前進を別途 edited で併記することもできるが、UI 上の
				// becoming は「今完了したこの1件」を見せれば足り、前進後マスターは確定一覧 tasks に
				// 次回 due の未完了行として自然に現れる(前進はユーザーが完了操作で意図した副作用で、
				// 差分としてわざわざ強調する必要が薄い)。過剰にならないよう completed 1件に留める。
				// task: snapshotFromTask で自己完結描画用スナップショットを添える(案X・2026-07-13。
				// completed は tasks の未完了ビューから抜けるので、UI はこの snapshot が無いと
				// becoming-done を描く元データを失う — todos-view-model.ts の TaskSnapshot コメント参照)。
				// 2026-07-17 TZ グラウンディング: 応答一覧の due 表示ゾーンに timeZone を渡す(既定 UTC 不変)。
				const vm = await buildTodosViewModel({
					calendarId,
					timeZone,
					affected: [{ id: task.id, kind: "completed", task: snapshotFromTask(task) }],
				});
				return toTodosToolResponse(vm);
			} catch (error) {
				if (error instanceof TodoNotFoundError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- delete-todo(E-1 スライス②-b / E-2 スライス②で ui:// + 差分レンズ化)------------
	registerAppTool(
		server,
		"delete-todo",
		{
			title: "Delete todo",
			description: "VTODO(リマインダー)を削除する。常に無条件削除(ETag 条件なし — delete-todo.ts 冒頭コメント参照)。",
			inputSchema: deleteTodoInputShape,
			annotations: DELETE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, timeZone }) => {
			try {
				// R1(docs/modeling/15 §A-3): confirmToken 検証は撤去(受け取っても無視 — deleteTodoInputShape の
				// confirmToken フィールドは後方互換のため残るだけ)。
				// removed の title/due は「削除直前」の状態が要る(削除後は当然もう読めない)。
				// DeleteTodo UC が If-Match 解決のため内部 read する更新前レンズを removed として返す
				// ようになった(2026-07-14 レイテンシ改善。以前は presentation で findTaskById が別途
				// ListTodos 全件を読んでいたが、その事前全件読みを省いた。delete-todo.ts の
				// DeleteTodoOutput.removed JSDoc 参照)。
				const deleteCalendarObject = new DeleteCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow);
				const deleteTodo = new DeleteTodo(deleteCalendarObject, deps.resourceRepo);
				const { removed: removedTask } = await deleteTodo.execute({ owner: principal, todoId: id, calendarId });

				// removed も affected と同じ TaskSnapshot に統一した(案X・2026-07-13)。旧 RemovedTask は
				// {id,title,due?} のみだったが、TaskSnapshot は priority/isAllDay も持つ上位互換なので
				// ghost 描画(renderGhostRow)に必要な情報はそのまま満たす。UC が removed を必ず返す
				// (対象不在なら execute が TodoNotFoundError を投げる)ので、旧実装の「target 取得失敗時の
				// {id, title:""} フォールバック」はもう不要になった。
				const removed: TaskSnapshot[] = [snapshotFromTask(removedTask)];
				// 2026-07-17 TZ グラウンディング: 残った行の due 表示ゾーンに timeZone を渡す(既定 UTC 不変)。
				const vm = await buildTodosViewModel({ calendarId, timeZone, removed });
				return toTodosToolResponse(vm);
			} catch (error) {
				if (error instanceof TodoNotFoundError) return toolError(error.message);
				if (error instanceof DeleteTargetNotFoundError) return toolError(error.message);
				if (error instanceof DeleteETagMismatchError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- move-todo(UI 詳細シート「リスト ›」からの VTODO コレクション間移動)-----------------
	// 【move-todo.ts が既に MCP 専用 UC(DAV MOVE 実装はスコープ外)である前提を踏襲】
	// このツールは move-todo.ts が返す removed(移動元から見た「削除直前」スナップショット)を
	// delete-todo と同じ TaskSnapshot ゴーストとして載せつつ、structuredContent.movedTo に
	// 移動先 calendarId を添えて「削除」ではなく「移動」であることを UI が判別できるようにする
	// (todos-view-model.ts の TodosViewModel.movedTo JSDoc 参照)。
	// 【応答のビューは移動元コレクション基準】タスク仕様どおり、確定一覧 tasks は移動元
	// (calendarId 省略時 "tasks")の ListTodos を再実行して作る — 移動先ではなく「操作した場所の
	// 一覧がどう変わったか」を見せるのが delete-todo 等と同じ mutate 系の一貫した契約。
	registerAppTool(
		server,
		"move-todo",
		{
			title: "Move todo",
			description:
				"VTODO(リマインダー)を別のコレクション(リスト)へ移動する。ICS の内容は変更せず、" +
				"移動先へそのまま複製 → 移動元を削除する(2段階。DAV の MOVE メソッドは対象外)。" +
				"移動元=移動先の指定はエラーになる。移動先が VTODO を受け付けないコレクション" +
				"(supported-calendar-component-set に VTODO が無い)もエラーになる。",
			inputSchema: moveTodoInputShape,
			annotations: DESTRUCTIVE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, toCalendarId, timeZone }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const deleteCalendarObject = new DeleteCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow);
				const moveTodo = new MoveTodo(putCalendarObject, deleteCalendarObject, deps.resourceRepo);
				const { removed: removedTask } = await moveTodo.execute({
					owner: principal,
					todoId: id,
					calendarId,
					toCalendarId,
				});

				// removed は delete-todo と同じ TaskSnapshot(案X)。movedTo を併せて載せることで
				// UI は「消えた」ではなく「よそへ移った」ゴーストとして描き分けられる。
				const removed: TaskSnapshot[] = [snapshotFromTask(removedTask)];
				// 2026-07-17 TZ グラウンディング: 移動元ビューの due 表示ゾーンに timeZone を渡す(既定 UTC 不変)。
				const vm = await buildTodosViewModel({ calendarId, timeZone, removed, movedTo: toCalendarId });
				return toTodosToolResponse(vm);
			} catch (error) {
				// MoveTodoSameCollectionError(no-op)/ TodoNotFoundError(移動元に UID 無し)/
				// CollectionNotFoundError(移動先コレクション不在)/ CalDAVPreconditionError
				// (移動先が VTODO を supported しない)/ ETagConditionError(移動先に同 UID の
				// リソースが既存)いずれもメッセージが自己説明的なので、create-todo 等と同じ
				// catch-all で toolError に変換する(instanceof 分岐で特別扱いする意味的な差は無い)。
				if (error instanceof MoveTodoSameCollectionError) return toolError(error.message);
				if (error instanceof TodoNotFoundError) return toolError(error.message);
				if (error instanceof CollectionNotFoundError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- event 系ツール(E-3 スライス S1: create-event/create-events/update-event/delete-event)-----
	// 【registerTool(registerAppTool ではない)理由】アジェンダカード(ui://caldav/agenda.html)は
	// S2 の担当。S1 はサーバー契約(EventsViewModel + affected/removed)を確定させるところまでで、
	// ui:// 紐付けは S2 で list-events-expanded と一緒に配線する。よってここでは素の registerTool。
	// EventsViewModel は閉じた contract 型なので SDK の structuredContent(index signature 要求)へは
	// 境界で cast する(todos の toTodosToolResponse と同じ判断)。
	// S1(docs/modeling/14 §6 項目5): agenda カード応答にも免除トークンを _meta.confirm へ載せる
	// (toTodosToolResponse と対称。理由・ボツ案は toTodosToolResponse / getCardToken のコメント参照)。
	// extraNote: #locationAutoResolve(自動ジオコーディング要件3)が付ける人間可読の一文。
	// create-calendar の「既存のコレクションを返しました」(content[1])と同じ流儀 — content[0] は
	// 従来どおり vm の JSON、追加の説明文は content[1] 以降に積む(structuredContent の形を汚さない)。
	// autoResolveDigest: telemetry 用の属性(要件5)。TELEMETRY_LOCATION_META_KEY 経由で argsDigest に
	// マージされる(下の buildMcpServer 計測ラッパー参照)。undefined なら何も付けない(location 自動解決を
	// 試みなかった呼び出しを telemetry で無駄に埋めない)。
	const eventsToolResponse = async (
		vm: Record<string, unknown>,
		extraNote?: string,
		autoResolveDigest?: LocationAutoResolveOutcome["kind"],
	) => ({
		content: [
			{ type: "text" as const, text: JSON.stringify(vm) },
			...(extraNote !== undefined ? [{ type: "text" as const, text: extraNote }] : []),
		],
		structuredContent: vm as { [key: string]: unknown },
		_meta: {
			confirm: { cardToken: await getCardToken() },
			...(autoResolveDigest !== undefined ? { [TELEMETRY_LOCATION_META_KEY]: { locationAutoResolve: autoResolveDigest } } : {}),
		},
	});

	// create/update-event が投げる「入力起因の kind タグ付きエラー」をまとめて toolError に倒す判定
	// (create-todo の catch と同じ流儀。メッセージが自己説明的なのでそのまま返す)。
	const isEventInputError = (error: unknown): boolean =>
		error instanceof InvalidStartError ||
		error instanceof InvalidEndError ||
		error instanceof EventTimeZoneRequiredError ||
		error instanceof StartAfterEndError ||
		error instanceof StartEndTypeMismatchError ||
		error instanceof InvalidTimeZoneError ||
		error instanceof UnsupportedTimeZoneError ||
		error instanceof RecurrenceCountUntilConflictError ||
		error instanceof RecurrenceWeekdaysRequireWeeklyError ||
		error instanceof InvalidAlarmsError ||
		error instanceof InvalidTravelMinutesError ||
		error instanceof InvalidUrlError ||
		// C8(設計 05): 場所(structuredLocation)/ 会議(conference)の入力検証エラー。
		error instanceof InvalidStructuredLocationError ||
		error instanceof InvalidConferenceUrlError ||
		error instanceof EventNotFoundError;

	// 【③ 2026-07-24 アジェンダカード紐付け】create-event/create-events/update-event/delete-event を
	// registerAppTool 化し _meta.ui=AGENDA_UI_URI を付ける。実機(swift ホスト)で mutate 応答にカードが
	// 出ずテキストのみだった原因は、これらが素の registerTool で _meta.ui を持たなかったこと(S1 の時点で
	// ui:// 紐付けを list-events-expanded の S2 へ後回しにした名残)。agenda カードは affected/removed の
	// 合成に既に対応済み(eventsToolResponse が structuredContent へ affected を載せている)なので、
	// ui を宣言するだけで list-events-expanded と同じカードが mutate 応答でも描かれる。
	registerAppTool(
		server,
		"create-event",
		{
			title: "Create event",
			description:
				"新規 VEVENT(予定)を作成する。UID/DTSTAMP はサーバーが生成する。" +
				'start は "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone 必須)、end は排他的終端(省略可)。' +
				'calendarId 省略時は "calendar" コレクションに作成する。' +
				"2件以上の予定をまとめて追加する場合は create-event を繰り返し呼ばず、必ず create-events を使うこと。",
			inputSchema: createEventInputShape,
			annotations: CREATE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({ title, notes, start, end, timeZone, location, url, calendarId, recurrence, alarms, travelMinutes, structuredLocation, conference }) => {
			try {
				// #locationAutoResolve(要件2): structuredLocation が明示されておらず location だけが
				// 渡された場合のみ自動解決する(明示指定は絶対に上書きしない・要件2「明示的に
				// structuredLocation が渡された場合...は現状どおり」)。
				let effectiveStructuredLocation = structuredLocation;
				let autoResolveNote: string | undefined;
				let autoResolveDigest: LocationAutoResolveOutcome["kind"] | undefined;
				if (structuredLocation === undefined && location !== undefined && location.trim() !== "") {
					const outcome = await autoResolveLocation(deps, principal, location);
					autoResolveDigest = outcome.kind;
					if (outcome.kind !== "failed") {
						effectiveStructuredLocation = outcome.structuredLocation;
						autoResolveNote = describeAutoResolvedLocation(outcome);
					} else {
						autoResolveNote = LOCATION_AUTO_RESOLVE_FAILED_NOTE;
					}
				}

				const normalizedRecurrence = normalizeCreateTodoRecurrenceInput(recurrence);
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createEvent = new CreateEvent(putCalendarObject);
				const { event } = await createEvent.execute({
					owner: principal,
					title,
					notes,
					start,
					end,
					timeZone,
					location,
					url,
					calendarId,
					recurrence: normalizedRecurrence,
					alarms,
					travelMinutes,
					structuredLocation: effectiveStructuredLocation,
					conference,
				});
				const cid = calendarId ?? "calendar";
				// timeZone は「そのまま echo」する(検証は UC 側が時刻付きイベントに対して既に済ませている。
				// resolveTimeZone で再検証すると、既に PUT 済みの終日イベントで junk timeZone を渡された場合に
				// 事後エラーになり部分状態を生むため — 素直に timeZone ?? "UTC" を echo する)。
				const vm = {
					events: [toWireEvent(event, cid, event.recurrence !== null)],
					calendarId: cid,
					timeZone: timeZone ?? "UTC",
					affected: [{ id: event.id, kind: "added", event: snapshotFromEvent(event) } satisfies AffectedEvent],
					// 【2026-07-23 SWR 完全形】mutate 応答も additive に generatedAt を載せる(型契約を
					// 参照系と揃える)。カード側(agenda-entry.ts)の mutation 応答経路は「自分で今取った
					// データは新鮮」の現行方針のまま無条件 markUpdated なので、この値を鮮度判定に使う
					// ことは無いが、EventsViewModel の全構築箇所で一貫させておく方が UI 側の型分岐が
					// 単純になる(「mutate 応答にだけ無い」フィールドを増やさない)。
					generatedAt: Date.now(),
					uiHash: AGENDA_UI_HASH, // ④ カードの版不整合可視化(EventsViewModel.uiHash JSDoc 参照)。
				};
				return eventsToolResponse(vm, autoResolveNote, autoResolveDigest);
			} catch (error) {
				if (isEventInputError(error)) return toolError((error as Error).message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	registerAppTool(
		server,
		"create-events",
		{
			title: "Create events (batch)",
			description:
				"複数の予定(VEVENT)をまとめて追加する。2件以上の追加は必ずこちらを使うこと。" +
				"各 item は create-event と同じ語彙(title/start 必須)。calendarId/timeZone は全 item 共通。",
			inputSchema: createEventsInputShape,
			annotations: CREATE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({ items, calendarId, timeZone }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createEvent = new CreateEvent(putCalendarObject);

				const cid = calendarId ?? "calendar";
				const createdEvents: ReturnType<typeof toWireEvent>[] = [];
				const succeeded: AffectedEvent[] = [];
				const failed: { title: string; reason: string }[] = [];
				// #locationAutoResolve(要件2): create-event と同じ判定を item ごとに行う。バッチは件数が
				// 多くなりうるので、per-item のメッセージではなく件数だけ summaryLines に足す(要件3の
				// 「見えるようにする」は満たしつつ、25件分の詳細でノイズにしない判断)。
				let autoResolvedCount = 0;
				let autoResolveFailedCount = 0;

				// create-todos と同じく直列実行(D1 の同一コレクション PUT 競合・sync token 順序を守る)。
				for (const item of items) {
					try {
						let effectiveStructuredLocation = item.structuredLocation;
						if (item.structuredLocation === undefined && item.location !== undefined && item.location.trim() !== "") {
							const outcome = await autoResolveLocation(deps, principal, item.location);
							if (outcome.kind !== "failed") {
								effectiveStructuredLocation = outcome.structuredLocation;
								autoResolvedCount++;
							} else {
								autoResolveFailedCount++;
							}
						}

						const normalizedRecurrence = normalizeCreateTodoRecurrenceInput(item.recurrence);
						const { event } = await createEvent.execute({
							owner: principal,
							title: item.title,
							notes: item.notes,
							start: item.start,
							end: item.end,
							timeZone,
							location: item.location,
							url: item.url,
							calendarId,
							recurrence: normalizedRecurrence,
							alarms: item.alarms,
							travelMinutes: item.travelMinutes,
							structuredLocation: effectiveStructuredLocation,
							conference: item.conference,
						});
						createdEvents.push(toWireEvent(event, cid, event.recurrence !== null));
						succeeded.push({ id: event.id, kind: "added", event: snapshotFromEvent(event) });
					} catch (error) {
						// create-todos と同じ「そこまでの成功分は残す」方針(部分成功を隠さない)。
						failed.push({ title: item.title, reason: error instanceof Error ? error.message : String(error) });
					}
				}

				const vm: Record<string, unknown> = {
					events: createdEvents,
					calendarId: cid,
					timeZone: timeZone ?? "UTC",
					// SWR 完全形: create-event と同じく additive(上のコメント参照)。
					generatedAt: Date.now(),
					uiHash: AGENDA_UI_HASH, // ④ カードの版不整合可視化(EventsViewModel.uiHash JSDoc 参照)。
				};
				if (succeeded.length > 0) vm.affected = succeeded;

				const summaryLines = [`${succeeded.length}/${items.length} 件の予定を作成しました。`];
				if (autoResolvedCount > 0) summaryLines.push(`うち ${autoResolvedCount} 件は場所を自動解決しました。`);
				if (autoResolveFailedCount > 0)
					summaryLines.push(`うち ${autoResolveFailedCount} 件は場所をテキストのみで登録しました(地図ピンなし)。`);
				if (failed.length > 0) {
					summaryLines.push("失敗した項目:");
					for (const f of failed) summaryLines.push(`- "${f.title}": ${f.reason}`);
				}
				return {
					content: [{ type: "text" as const, text: summaryLines.join("\n") }],
					structuredContent: vm as { [key: string]: unknown },
					// #locationAutoResolve(要件5): create-event と同じ telemetry 属性キー(件数を持つ点だけ
					// 単発版と異なる)。
					...(autoResolvedCount > 0 || autoResolveFailedCount > 0
						? { _meta: { [TELEMETRY_LOCATION_META_KEY]: { locationAutoResolveCount: autoResolvedCount, locationAutoResolveFailedCount: autoResolveFailedCount } } }
						: {}),
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	registerAppTool(
		server,
		"update-event",
		{
			title: "Update event",
			description:
				"既存 VEVENT(予定)の一部フィールドを更新する。指定したフィールドのみ変更し、他は維持する。" +
				"通知(何分前アラーム)・繰り返し・URL・移動時間の追加/変更/削除もこのツールで行う" +
				"(alarms/recurrence/url/travelMinutes を指定すれば更新、null で除去)。" +
				"end は null で終了を外せる(開始のみのイベント)。反復イベントはマスター(系列)単位で編集する。",
			inputSchema: updateEventInputShape,
			annotations: DESTRUCTIVE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({
			id,
			calendarId,
			title,
			notes,
			start,
			end,
			timeZone,
			location,
			url,
			recurrence,
			alarms,
			travelMinutes,
			structuredLocation,
			conference,
		}) => {
			try {
				// #locationAutoResolve(要件2・要件2「update の再解決条件」): structuredLocation が
				// 明示されておらず、location が「文字列に設定」される(undefined=変更なし・null=除去
				// ではない)ときだけ自動解決の対象にする。かつ「location 文字列が変わらない update では
				// 再解決しない」(無駄な quota 消費防止・要件2)ため、現在の location を1回だけ読んで
				// 比較する(下の lookupEvent 呼び出し)。UpdateEvent.execute 内部でも同じリソースを
				// 改めて lookup するため D1 往復が1回増えるが、「location を変更する update」という
				// 相対的に稀な経路にのみ乗るコストなので許容する(create-event 側は既に owner 全体
				// スキャンを伴う known-locations 優先探索をしており、対称的な追加コストと捉えられる)。
				let effectiveStructuredLocation = structuredLocation;
				let autoResolveNote: string | undefined;
				let autoResolveDigest: LocationAutoResolveOutcome["kind"] | undefined;
				if (structuredLocation === undefined && location !== undefined && location !== null && location.trim() !== "") {
					let currentLocation: string | null = null;
					try {
						const cidForLookup = mkCollectionId(calendarId ?? "calendar");
						const looked = await lookupEvent(deps.resourceRepo, principal, cidForLookup, id);
						currentLocation = looked !== null && looked.vevent.location !== undefined ? decodeText(looked.vevent.location) : null;
					} catch {
						// lookup 失敗(イベント未検出等)は「変わった」とみなして自動解決を試みる
						// (どのみち直後の updateEvent.execute が同じエラーで落ちるので、ここで無理に
						// 特別扱いしない best-effort の割り切り)。
						currentLocation = null;
					}
					if (currentLocation !== location) {
						const outcome = await autoResolveLocation(deps, principal, location);
						autoResolveDigest = outcome.kind;
						if (outcome.kind !== "failed") {
							effectiveStructuredLocation = outcome.structuredLocation;
							autoResolveNote = describeAutoResolvedLocation(outcome);
						} else {
							autoResolveNote = LOCATION_AUTO_RESOLVE_FAILED_NOTE;
						}
					}
				}

				const normalizedRecurrence = normalizeUpdateTodoRecurrenceInput(recurrence);
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const updateEvent = new UpdateEvent(putCalendarObject, deps.resourceRepo);
				const { event, before } = await updateEvent.execute({
					owner: principal,
					eventId: id,
					calendarId,
					title,
					notes,
					start,
					// end は三値(undefined=変更なし / null=除去 / string=設定)をそのまま渡す。
					end,
					timeZone,
					location,
					// url も三値(undefined=変更なし / null=除去 / string=設定)をそのまま渡す。
					url,
					recurrence: normalizedRecurrence,
					// alarms(三値: undefined/null/配列)・travelMinutes(三値)もそのまま渡す。
					alarms,
					travelMinutes,
					// structuredLocation/conference(三値)もそのまま渡す(C8)。
					structuredLocation: effectiveStructuredLocation,
					conference,
				});

				// 「渡された(非 undefined)フィールド」を changed とみなす素朴判定(todos-diff.ts と同じ)。
				const provided = new Set<string>();
				if (title !== undefined) provided.add("title");
				if (notes !== undefined) provided.add("notes");
				if (start !== undefined) provided.add("start");
				if (end !== undefined) provided.add("end");
				if (location !== undefined) provided.add("location");
				if (url !== undefined) provided.add("url");
				if (recurrence !== undefined) provided.add("recurrence");
				if (alarms !== undefined) provided.add("alarms");
				if (travelMinutes !== undefined) provided.add("travelMinutes");
				if (structuredLocation !== undefined) provided.add("structuredLocation");
				if (conference !== undefined) provided.add("conference");
				const changes = before !== undefined ? buildEventEditedChanges(before, event, provided) : undefined;

				const cid = calendarId ?? "calendar";
				const affected: AffectedEvent = {
					id: event.id,
					kind: "edited",
					event: snapshotFromEvent(event),
					...(changes !== undefined ? { changes } : {}),
				};
				const vm = {
					events: [toWireEvent(event, cid, event.recurrence !== null)],
					calendarId: cid,
					timeZone: timeZone ?? "UTC",
					affected: [affected],
					// SWR 完全形: create-event と同じく additive(上のコメント参照)。
					generatedAt: Date.now(),
					uiHash: AGENDA_UI_HASH, // ④ カードの版不整合可視化(EventsViewModel.uiHash JSDoc 参照)。
				};
				return eventsToolResponse(vm, autoResolveNote, autoResolveDigest);
			} catch (error) {
				if (isEventInputError(error)) return toolError((error as Error).message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	registerAppTool(
		server,
		"delete-event",
		{
			title: "Delete event",
			description: "VEVENT(予定)を削除する。常に無条件削除(ETag 条件なし — delete-event.ts 冒頭コメント参照)。",
			inputSchema: deleteEventInputShape,
			annotations: DELETE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: AGENDA_UI_URI },
				"openai/outputTemplate": AGENDA_UI_URI,
			},
		},
		async ({ id, calendarId }) => {
			try {
				// R1(docs/modeling/15 §A-3): confirmToken 検証は撤去(delete-todo と対称。受け取っても無視)。
				const deleteCalendarObject = new DeleteCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow);
				const deleteEvent = new DeleteEvent(deleteCalendarObject, deps.resourceRepo);
				const { removed } = await deleteEvent.execute({ owner: principal, eventId: id, calendarId });
				const cid = calendarId ?? "calendar";
				// delete 応答は events を空にし removed(ghost)を載せる(range も affected も名乗らない)。
				const vm = {
					events: [] as unknown[],
					calendarId: cid,
					timeZone: "UTC",
					removed: [snapshotFromEvent(removed)] satisfies EventSnapshot[],
					// SWR 完全形: create-event と同じく additive(上のコメント参照)。
					generatedAt: Date.now(),
					uiHash: AGENDA_UI_HASH, // ④ カードの版不整合可視化(EventsViewModel.uiHash JSDoc 参照)。
				};
				return eventsToolResponse(vm);
			} catch (error) {
				if (error instanceof EventNotFoundError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- list-known-locations(C5・設計 05 §3・§5・§6)-----------------------------------------
	server.registerTool(
		"list-known-locations",
		{
			title: "List known locations",
			description:
				"座標付きの構造化された場所(structuredLocation)を、過去の予定/リマインダーから distinct に集約して返す。" +
				"vevent の「場所または会議」入力・vtodo の到着/出発通知(到着地点)の候補として使う既知の場所の一覧" +
				"(セミモーダルの「既知の場所」候補用)。最近使った順(recency)に並ぶ。",
			inputSchema: listKnownLocationsInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ calendarId }) => {
			try {
				const listKnownLocations = new ListKnownLocations(deps.collectionRepo, deps.resourceRepo);
				const { locations } = await listKnownLocations.execute({ owner: principal, calendarId });
				const vm = { locations };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(vm) }],
					structuredContent: vm as { [key: string]: unknown },
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- search-location(#45 場所モデル・geocoding)----------------------------------------------
	// 【なぜ素の registerTool(カード無し)か】search-location は「文字列 → 候補配列」を返すだけの
	// 純粋な解決ツールで、UI 描画の責務を持たない(選んだ候補を structuredLocation に写すのは
	// create-event/update-event 側 = 別ツール)。list-known-locations と同じく素の registerTool に留める。
	//
	// 【#locationAutoResolve 追加に伴う description 改訂(要件4)】create-event/update-event が
	// location(自由記述テキスト)だけを渡されたときサーバー側で自動的に structuredLocation へ解決する
	// ようになった(この節の上、autoResolveLocation 冒頭コメント参照)ため、search-location を明示的に
	// 呼ぶ意味は「単純な場所指定」では薄くなった。実機で確定した問題(claude.ai iOS(Haiku 4.5)が
	// search-location を呼ばず location だけの素の VEVENT を作った事故)を description の誘導強化では
	// 再発防止しきれない、という判断が自動解決の導入動機そのものなので、この description は
	// 「もう search-location を必ず呼べ」とは言わない(モデルが呼ばなくてもサーバーが解決するので)。
	// 代わりに「曖昧な場所や複数候補から選びたいときに使う」役割へ再定義し、単純な場所は
	// create-event の location に直接渡してよいことを明記する。
	server.registerTool(
		"search-location",
		{
			title: "Search location (geocode)",
			description:
				"場所(店名・施設名・住所)の文字列を、地図検索で座標付きの候補(title/address/geo)に複数解決する。" +
				"【いつ使うか】単純な場所指定(「品川のホテルの叙々苑で」等)は create-event/update-event の location に" +
				"そのまま渡せばよい(サーバーが known-locations 優先で自動的に structuredLocation へ解決する)。" +
				"このツールを明示的に呼ぶのは、曖昧な場所名で複数候補から選びたい・自動解決の結果を事前に確認したい・" +
				"自動解決に失敗した場所を手動で探し直したい、といった候補比較が要る場面に限る。" +
				"candidates から文脈に最も合う1件を選び、structuredLocation {title, address, lat, lon} に写す" +
				"(geo 付きにすると iOS の地図表示・経路案内が効く)。" +
				"【解決できないとき / 枠を使い切ったとき】候補が0件、または今月の解決枠を使い切った場合でも、" +
				"structuredLocation を lat/lon 無し(title と address だけ)で渡せば住所表現として登録できる(degrade)。" +
				"その場合 iOS の地図ピンは付かないが場所名・住所は残る。",
			inputSchema: searchLocationInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ query }) => {
			// query は zod で min(1) 済みだが、空白のみは無意味な Google 呼び出し(= quota 消費)になるので
			// ここでも弾く(要件 #4: バリデーション相当の失敗では quota を消費しない — searchLocation を
			// 呼ばずに返すことで QuotaLimitedGeocoding の tryConsume に到達させない)。
			const trimmed = query.trim();
			if (trimmed === "") {
				return toolError("query が空です。解決したい場所の文字列(店名・施設名・住所)を指定してください。");
			}
			try {
				const candidates = await deps.geocoding.searchLocation(trimmed);
				// structuredContent(モデル/カードが機械的に読む): 候補配列。lat/lon はフラットに載せる
				// (structuredLocation の入力 shape と同じ形にして、モデルがそのまま写しやすくする)。
				const vm = {
					candidates: candidates.map((c) => ({
						title: c.title,
						address: c.address,
						geo: { lat: c.geo.lat, lon: c.geo.lon },
					})),
				};
				// content(人間可読): 候補リスト。0件は「見つからなかった → degrade できる」を明示して誘導する。
				const text =
					candidates.length === 0
						? `「${trimmed}」に一致する場所が見つかりませんでした。住所が分かる場合は structuredLocation を lat/lon 無し(title/address のみ)で登録できます。`
						: [`「${trimmed}」の候補 ${candidates.length} 件:`]
								.concat(
									candidates.map(
										(c, i) =>
											`${i + 1}. ${c.title}${c.address !== null ? ` — ${c.address}` : ""}(${c.geo.lat}, ${c.geo.lon})`,
									),
								)
								.join("\n");
				return {
					content: [{ type: "text" as const, text }],
					structuredContent: vm as { [key: string]: unknown },
				};
			} catch (error) {
				// 型付きエラーは人間可読メッセージへ写しつつ、telemetry の errKind に種別を載せる
				// (toolError の第2引数 → _meta → registerTool ラッパーが記録。要件 #3: quota 超過を
				// observability で区別できるようにする)。ツールは isError で graceful に返すので落ちない。
				if (error instanceof GeocodingQuotaExceededError) {
					return toolError(
						"今月の場所解決の枠を使い切りました。住所が分かる場合は structuredLocation を lat/lon 無し" +
							"(title/address のみ)で登録できます(地図ピンは付きませんが場所名・住所は残ります)。",
						error.kind, // "GeocodingQuotaExceededError"(枠に当たった頻度を errKind で集計できる)。
					);
				}
				if (error instanceof GeocodingNotConfiguredError) {
					return toolError(
						"地図検索(GOOGLE_MAPS_API_KEY)が未設定のため場所を解決できません。管理者に設定を依頼してください。" +
							"住所が分かる場合は structuredLocation を lat/lon 無しで登録できます。",
						error.kind, // "GeocodingNotConfiguredError"(未設定の観測 = 設定漏れの検知)。
					);
				}
				// その他(HTTP エラー・壊れた JSON 等)は種別を "GeocodingProviderError" にまとめる
				// (プロバイダ側の一過性障害。個別のメッセージ本文は errKind に載せない — 内容漏洩防止)。
				return toolError(
					`場所の解決に失敗しました(${error instanceof Error ? error.message : String(error)})。` +
						"住所が分かる場合は structuredLocation を lat/lon 無しで登録できます。",
					"GeocodingProviderError",
				);
			}
		},
	);

	// --- list-deleted / restore-deleted(R2 ソフトデリート・docs/modeling/15 §A-3)----------------
	// 【② 2026-07-24 カード化: registerAppTool 化して todos カードにゴミ箱ビューを載せる】
	// 旧実装は素の registerTool で structuredContent に生の entries(uri 等)を載せるだけだったため、
	// モデルが応答をなぞって「URI: a4de4fc2-….ics」をユーザーに晒す実害が出た(実機観測)。カードに
	// 「ゴミ箱ページ」を描かせ、モデル向け content は人間可読の要約(タイトル・リスト名・相対削除時刻)に
	// する。uri は restore-deleted の引数に必須なので structuredContent(deletedItems)には残すが、
	// content には出さない(description で「ユーザーに URI を見せない」を誘導)。
	registerAppTool(
		server,
		"list-deleted",
		{
			title: "List deleted (trash)",
			description:
				"ソフトデリート済み(ゴミ箱にある)予定/リマインダーを一覧する。カードにゴミ箱ページが開き、" +
				"各行に「復元」ボタンが出る(ユーザーはそこから復元できる)。iOS/CalDAV からは見えない MCP 専用の" +
				"ゴミ箱ビュー。【重要】応答の uri は復元用の内部識別子。ユーザーへの返答に URI/ファイル名を" +
				"書き出さないこと(ユーザーはカードのボタンで操作する。あなたはタイトル・リスト名・削除時刻で言及する)。",
			inputSchema: {
				// カードの下敷き一覧(通常 todos vm)の due 表示ゾーン。省略時 UTC(deletedItems の相対時刻は
				// クライアントの Date.now() で出すので timeZone 非依存 — ここは下敷き tasks の due 用)。
				timeZone: z.string().optional().describe("下敷きに再取得する通常一覧の due 表示に使う IANA タイムゾーン。省略時 UTC。"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ timeZone }) => {
			try {
				const listDeleted = new ListDeleted(deps.resourceRepo);
				const { entries } = await listDeleted.execute({ owner: principal });
				// 下敷きの通常一覧(横断)も一緒に返す。こうしておくと復元でゴミ箱を閉じたとき最新の一覧が
				// 見える & applyStructuredContent の tasks マージが空応答でキャッシュを消さない(deletedItems
				// だけの vm を送ると横断 tasks=空 とみなされ他リストが消える事故を避ける — todos-entry.ts の
				// mergeTasksByCalendar 参照)。deletedItems を additive に載せてゴミ箱ページを開かせる。
				const vm = await buildTodosViewModel({ timeZone });
				vm.deletedItems = entries.map((e) => ({
					uri: e.uri,
					calendarId: e.calendarId,
					title: e.summary ?? "",
					deletedAtMillis: e.deletedAtMillis,
				}));
				// content(モデル向け): 人間可読の要約。URI は出さない(description の誘導どおり)。
				const now = Date.now();
				const lines =
					entries.length === 0
						? ["ゴミ箱は空です。"]
						: [`ゴミ箱に ${entries.length} 件あります:`].concat(
								entries.map(
									(e) =>
										`- 「${e.summary ?? "(無題)"}」(${e.calendarId})— ${formatDeletedAgoForContent(e.deletedAtMillis, now)}に削除`,
								),
							);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					structuredContent: vm as unknown as { [key: string]: unknown },
					_meta: { confirm: { cardToken: await getCardToken() } },
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// 【② 2026-07-24 カード化】restore-deleted も registerAppTool 化。復元後の通常 todos vm を返し
	// (affected に復元行=added を載せて「どれが戻ったか」を UI/モデルが分かる形にする)、カードは
	// 通常一覧を更新する(ゴミ箱ページ側は callServerTool 発なので、カード内で該当行を抜いて閉じる)。
	registerAppTool(
		server,
		"restore-deleted",
		{
			title: "Restore deleted",
			description:
				"ソフトデリート済み(ゴミ箱の)予定/リマインダーを復元する。list-deleted が返した uri と " +
				"calendarId を渡す。前提: 同じ UID の生存リソースが既にある場合は復元できない(衝突相手を示す" +
				"エラーになる)。元の uri が再利用されていれば新しい uri を採番して復元する。" +
				"【重要】uri は内部識別子。ユーザーへの返答に URI/ファイル名を書き出さないこと。",
			inputSchema: {
				uri: z.string().describe("復元対象の uri(list-deleted が返した uri)。"),
				calendarId: z.string().optional().describe('所属コレクション ID。省略時は "tasks"。'),
				timeZone: z.string().optional().describe("復元後に返す一覧の due 表示に使う IANA タイムゾーン。省略時 UTC。"),
			},
			annotations: RESTORE_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ uri, calendarId, timeZone }) => {
			try {
				const restoreDeleted = new RestoreDeleted(deps.collectionRepo, deps.resourceRepo, deps.uow);
				const restored = await restoreDeleted.execute({ owner: principal, resourceUri: uri, calendarId });
				// 復元行を affected:"added" として載せる(復元=一覧に再出現なので、mutate 系の「追加」と
				// 同じ差分レンズで「どれが戻ったか」を表せる)。TaskSnapshot は最小情報(title=summary・
				// 由来 calendarId)で足りる — 確定一覧 tasks 側に本物の行が居るので UI はそこも参照できる。
				const restoredSnapshot: TaskSnapshot = {
					id: restored.uid,
					title: restored.summary ?? "",
					calendarId: restored.calendarId,
				};
				const affected: AffectedTask[] = [{ id: restored.uid, kind: "added", task: restoredSnapshot }];
				const vm = await buildTodosViewModel({ calendarId: restored.calendarId, timeZone, affected });
				return toTodosToolResponse(vm);
			} catch (error) {
				// RestoreTargetNotFoundError(404 相当)/ RestoreUidConflictError(UID 衝突・conflictUri を
				// 含む)/ CollectionNotFoundError いずれもメッセージが自己説明的なので toolError に写す。
				if (error instanceof RestoreTargetNotFoundError) return toolError(error.message);
				if (error instanceof RestoreUidConflictError) return toolError(error.message);
				if (error instanceof CollectionNotFoundError) return toolError(error.message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// --- report-card-telemetry(#52 サーバー側テレメトリ受け)------------------------------
	// 【なぜ TODOS_UI_URI に束縛するか】registerAppTool の第3引数 config._meta.ui.resourceUri は
	// 「どのカードに紐付くツールか」の宣言だが、report-card-telemetry は todos/agenda 両カードから
	// 呼ばれうる。agenda カードからの呼び出しも今回は TODOS_UI_URI 束縛のまま callServerTool できる
	// 公算(ext-apps の callServerTool はホストが _meta.ui.resourceUri で描画中のカードから任意の
	// app-visibility ツールを叩ける想定・visibility:["app"] は「モデルに見せない」の制御であって
	// 「特定カードからしか呼べない」制約ではない)だが、統合検証(タスク B 側)で agenda から呼べない
	// ことが判明したら AGENDA_UI_URI にも同じ handler を alias 登録すればよい(可逆・非破壊)。
	// 【visibility:["app"] にする理由】refresh-todos/refresh-events と同じ理由(冒頭コメント参照): この
	// ツールはカード自身の JS が callServerTool で叩く計測専用の配管で、モデルが自発的に呼んでも
	// 何も意味がある動作をしない(むしろモデルが誤って呼ぶ余地を与えるだけ)。
	// 【禁止フィールドを持たない形(zod スキーマ)】CardTelemetryPort 冒頭コメントの PII 境界どおり、
	// メッセージ本文や自由記述文字列を運べるフィールドを定義しない。msgDigest はカード側で既に
	// 要約・ハッシュ化済みの値という契約(呼び出し側=カード JS の責務。サーバー側はその値をそのまま
	// 通すだけで、本文が紛れ込んでいないかまでは検証できない — 「型で運べる形を作らない」ことが
	// このサーバー側にできる唯一の強制力)。
	// 【.strict() で未知キーを拒否する理由】zod の .object() は既定で未知キーを黙って捨てる
	// (strip)。だが「禁止フィールドを持たない」という契約は「送っても届かない」より「送ったら
	// 気づける」方が事故の早期発見につながる(カード側の実装ミスで自由記述を送ろうとしたら zod
	// バリデーションエラーとして即座に落ちてほしい)ので、各イベント形と全体の両方を .strict() にする。
	const cardTelemetryErrorEventSchema = z
		.object({
			kind: z.literal("error"),
			dt: z.number(),
			name: z.string(),
			msgDigest: z.string(),
			frame: z.string().optional(),
			count: z.number(),
		})
		.strict();
	const cardTelemetryFocusProbeEventSchema = z
		.object({
			kind: z.literal("focus-probe"),
			dt: z.number(),
			phase: z.enum(["before", "after"]),
			activeElementId: z.string().optional(),
			sheetInputConnected: z.boolean(),
			sheetInputActive: z.boolean(),
		})
		.strict();
	const cardTelemetrySafeAreaEventSchema = z
		.object({
			kind: z.literal("safe-area"),
			dt: z.number(),
			top: z.number(),
			right: z.number(),
			bottom: z.number(),
			left: z.number(),
			fallbackTopApplied: z.boolean(),
			fallbackBottomApplied: z.boolean(),
		})
		.strict();
	const reportCardTelemetryInputShape = {
		cardType: z.enum(["todos", "agenda"]).describe("計測イベントの発生元カード。"),
		uiHash: z.string().describe("カード HTML のハッシュ(TODOS_UI_HASH 等の8桁)。どのビルドのカードかを特定する。"),
		instanceId: z.string().describe("カードの描画インスタンス ID(8桁)。同一カードの複数インスタンスを区別する。"),
		displayMode: z.enum(["inline", "fullscreen", "unknown"]).describe("バッチ送信時点のカード表示モード。"),
		events: z
			.array(z.discriminatedUnion("kind", [cardTelemetryErrorEventSchema, cardTelemetryFocusProbeEventSchema, cardTelemetrySafeAreaEventSchema]))
			.max(20)
			.describe("計測イベントのバッチ(最大20件。kind ごとにフィールドが異なる判別共用体)。"),
	};
	registerAppTool(
		server,
		"report-card-telemetry",
		{
			title: "Report card telemetry",
			description:
				"UI(todos/agenda カード)専用の計測受け口。カード内で観測したエラー/フォーカス状態/safe-area の" +
				"バッチをサーバー側テレメトリ(CardTelemetryPort)へ記録する。モデルからは呼べない" +
				'(visibility:["app"])— カード側 JS が callServerTool で叩く用。応答は結果を持たない(常に成功)。',
			inputSchema: reportCardTelemetryInputShape,
			annotations: READ_ONLY_ANNOTATIONS,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI, visibility: ["app"] },
			},
		},
		async ({ cardType, uiHash, instanceId, displayMode, events }, extra) => {
			// host/sessionId は通常の tool call 計測(registerTool ラッパー)と同じ判定関数・同じ
			// _meta キーを使う(telemetry-support.ts に判定ロジックを1関数へ集約する方針どおり —
			// ここで別の判定を書くと2箇所が乖離する)。requestUserAgent は buildMcpServer の
			// 引数として既に closure に来ている(通常ツール計測と同じ値)。
			const host = classifyHost(requestUserAgent);
			const sessionId = readSessionId((extra as { _meta?: Record<string, unknown> } | undefined)?._meta);
			const receivedAt = Date.now();
			for (const event of events) {
				const completed = { ...event, cardType, uiHash, instanceId, displayMode, host, sessionId, receivedAt };
				// 1行 JSON の構造化ログ(既存の計測点と同じ「console.log + Port.record」の二重書き分け
				// 規律。CardTelemetryPort 冒頭コメントの PII 境界を通った値のみがここに来る)。
				console.log(JSON.stringify({ cardTelemetry: completed }));
				// CardTelemetryPort.record は fire-and-forget 契約(戻り値なし・例外を投げない契約)だが、
				// 通常の TelemetryPort と同じ「二重の防御」(telemetry.ts の TelemetryPort コメント参照)
				// として呼び出し側でも try/catch する。カード計測の失敗でこの tool call 自体(＝カード
				// 操作のフィードバック)を壊すのは本末転倒なので、ここは特に厳格に握りつぶす。
				try {
					deps.cardTelemetry.record(completed);
				} catch {
					// 意図的に無視(fire-and-forget)。
				}
			}
			return { content: [{ type: "text" as const, text: "ok" }], structuredContent: { ok: true } };
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

	// 【2026-07-17 キャッシュバスティング S2: エンドポイント URL の版管理】
	// claude.ai は MCP のツール定義(tools/list の結果)を TTL 約1時間でサーバー側キャッシュする
	// (層A)。S1(ui:// の content-address 化)は層B(カード HTML)の自動伝播を解決するが、層A
	// (ツール定義そのもの・入出力スキーマの変更等)は URI を変えても TTL の間は古いまま
	// キャッシュされうる。claude-ai-mcp#137 では「再接続」だけでは直らない報告もあり、
	// 確実な脱出口として「接続先 URL 自体を変える」= コネクタの URL を書き換えて OAuth 再同意
	// させる、という運用ハンドルを用意しておく(docs/next-directions.md 運用フロー参照)。
	// 【なぜ版セグメントに意味を持たせない(allowlist しない)か】
	// `/mcp/v2` を特別扱いして分岐する設計にすると、「新しい版番号を使う」ためにサーバー側の
	// allowlist 更新 → デプロイが先に必要になり、「デプロイを確実に伝播させる」という本来の
	// 目的と本末転倒になる(バージョンを増やすたびにコード変更が要る)。そこでこの :version は
	// パスパラメータとして受け取るだけで中身を一切読まない・分岐しない「純粋なキャッシュバスト
	// ハンドル」にする。`/mcp/v2` も `/mcp/20260714` も同じ最新サーバーを返す。実運用では
	// コネクタ設定の URL を単純にインクリメントするだけで新しい版として扱われる。
	// 【同一ハンドラを2ルートに登録する理由】旧 URL(`/mcp`)は既存接続の後方互換として維持し続け、
	// 版管理は「加算的な脱出口」として追加する(設計方針: 両方とも加算的・可逆・後方互換)。
	const handleMcpRequest = async (c: Context<{ Bindings: CloudflareBindings }>) => {
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
		// 【2026-07-17 S2】以前は `${url.origin}/mcp` にハードコードしていたが、`/mcp/:version`
		// (版管理エンドポイント)を追加したことで実際の接続 URL と食い違う経路が生まれた。
		// 実パス追従(`url.pathname`)にすることで、`/mcp/v2` で接続したクライアントの
		// resourceUri(audience)が実際の接続 URL と一致するようになる。現状の認証アダプタ
		// (static-bearer-auth.ts / oauth-props-auth.ts)は resourceUri を実質使っていない
		// (no-op)ので今回のリクエストで挙動は変わらないが、将来 audience 検証を実装する際に
		// 正しい値になっているようにしておく。
		const resourceUri = `${url.origin}${url.pathname}`;
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
		// request.cf は Workers ランタイムでのみ存在(bun test の素の Request には無い)ため
		// optional chain で安全に取る。colo は計測ログ専用(認可・応答内容には一切影響しない)。
		const cf = (c.req.raw as { cf?: { colo?: string } }).cf;
		// R-6: 認証で解決した scope 集合を buildMcpServer へ束ねる(write ツール強制の材料)。
		// authResult.scopes は undefined(grandfather/静的 Bearer=full access)か、同意 scope 配列。
		// 観測基盤 v1(2026-07-23): User-Agent を host 推定(classifyHost)の材料として渡す。
		// undefined を許容する(ヘッダ無しのクライアントは classifyHost が "unknown" に落とす)。
		const server = buildMcpServer(deps, authResult.principal, authResult.scopes, cf?.colo, c.req.header("user-agent"));
		const transport = new StreamableHTTPTransport();
		await server.connect(transport);
		const response = await transport.handleRequest(c);
		// StreamableHTTPTransport.handleRequest は Response | undefined を返しうる型だが、
		// GET/POST/DELETE いずれのハンドラも必ず Response を返す実装(@hono/mcp のソース確認済み)。
		// undefined は型上の保険であり実運用では起きない想定だが、Hono のハンドラ契約を守るため
		// 保険で 500 に倒す。
		return response ?? new Response("MCP transport returned no response", { status: 500 });
	};

	// 旧 URL(ルート直下)は既存接続の後方互換として維持しつつ、`/:version` セグメント付きの
	// URL でも同一ハンドラが応答するようにする(S2 の脱出口)。
	app.all("/", handleMcpRequest);
	app.all("/:version", handleMcpRequest);

	return app;
}
