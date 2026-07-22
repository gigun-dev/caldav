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
// E-3 スライス S2: list-events-expanded が描画するアジェンダカードの ui:// URI と HTML 本体
// (agenda-app.ts → agenda-bundle.ts 自動生成を経由)。todos と同じく server.ts から ui/ への import は許可。
import { AGENDA_APP_HTML, AGENDA_UI_URI } from "./ui/agenda-app";
// S1(docs/modeling/14 確認カード): 破壊的操作の human-in-the-loop 確認カード(ui://)。
import { CONFIRM_APP_HTML, CONFIRM_UI_URI } from "./ui/confirm-app";
// S1: 確認トークンの生成/検証(HMAC-SHA256・canonical JSON・TTL)。層は presentation/mcp に閉じる
// (application 層の UC シグネチャに confirmToken を持ち込まない — docs/modeling/14 §7)。
import { CARD_TOKEN_TTL_MS, PROPOSE_TOKEN_TTL_MS, signConfirmToken, verifyConfirmToken } from "./confirm-token";

import type { AuthenticationPort, CollectionUnitOfWork } from "../../application/ports";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../../application/ports";
// Task 型は findTaskById 廃止(2026-07-14 レイテンシ改善)で presentation から直接参照しなくなった
// (before/removed は UC が返す。差分整形は todos-diff.ts が Task を受ける)。ここでは型 import しない。
import type { CreateTodoRecurrenceInput, Event } from "../../application/usecases";
// E-2 スライス②: mutate 系ツールが返す差分レンズ付き確定一覧の contract と、その表示用整形。
import type { AffectedTask, TaskSnapshot, TodosViewModel } from "./todos-view-model";
import { buildEditedChanges, snapshotFromTask } from "./todos-diff";
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
	// C5(設計 05): 既知の場所ツール。
	ListKnownLocations,
} from "../../application/usecases";
import type { RecurrenceIterator } from "../../domain/ical/recurrence";
import type { CollectionId, ComponentKind, PrincipalRef } from "../../domain/caldav";
import { AppleColor, InvalidIdentifierError, collectionId as mkCollectionId } from "../../domain/caldav";
// list-calendars / create-calendar(方向性直近タスク): DAV MKCALENDAR と同じ UC を MCP から
// 別入口で呼ぶ(CLAUDE.md 長期ビジョン「複数入口」の具体例)。
import { CollectionAlreadyExistsError, CreateCollection, ListCollections } from "../../application/usecases";
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
	// S1(docs/modeling/14 確認カード): 破壊的操作の確認トークンを HMAC 署名/検証する Workers secret
	// (CONFIRM_SECRET)。トークンの生成(propose-delete-*)と検証(delete-* の実行前ガード)は
	// どちらも presentation/mcp に閉じる(application 層の UC シグネチャに confirmToken を持ち込まない
	// = §7「トークン検証は UC 呼び出しの手前」)。空文字は propose-* が実行時に弾く(空鍵で誰でも
	// 通る事故を防ぐ。§ の MCP_TOKEN と同じガード思想)。
	readonly confirmSecret: string;
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
// 語彙が無く、モデルが get-current-time を先行呼びする2往復が実運用で再発したため追加(週は月曜
// 始まり固定。application/time/relative-range.ts 冒頭コメント参照)。
const RANGE_DESCRIPTION =
	'相対レンジ。"today"/"tomorrow"/"next-7-days"/"next-30-days"/"this-week"/"next-week"/"this-month" のいずれか。' +
	"指定時は timeMin/timeMax 不要・timeZone 必須(当該 TZ のローカル午前0時起点・終端排他で境界を計算する。" +
	"this-week/next-week は月曜始まり)。「今週」「来週」「今月」などの相対表現も range で1発で引ける。" +
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
 * 【フォールバック先が crypto.randomUUID() の理由】衝突の心配が無く create-todo.ts の
 * UID 生成と同じ発想(先頭数文字に切り詰めない — CollectionId には文字数上限が特に無いため、
 * フル UUID の方が衝突可能性がさらに低く安全)。
 */
// テスト(server.test.ts)から直接呼べるよう export する(この関数だけを取り出して境界値を
// 検証したいが、registerTool 経由だと McpServer 全体の配線が要るため単体テストが書きにくい)。
export function slugifyForCollectionId(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const isDegenerate = slug.length === 0 || /^[0-9]+$/.test(slug) || slug.length < 3;
	return isDegenerate ? crypto.randomUUID() : slug;
}

// S1(docs/modeling/14): confirmToken は「確認カードで承認済み」を証明するトークン(§4 Tier A)。
// モデルはこのトークンを知り得ない(propose-delete-* が _meta にだけ載せる)ので、モデルが
// confirmToken 無しで直接叩くと拒否される。カード発の削除は免除トークンを渡す(getCardToken 参照)。
// delete-calendar / delete-todo / delete-event の3つの入力 shape で共有するため、最初に使う
// delete-calendar より前に定義する(const の TDZ を避ける — 使用箇所より前に置く必要がある)。
const confirmTokenField = z
	.string()
	.optional()
	.describe(
		"確認トークン。破壊的操作の承認証跡(propose-* が確認カードの _meta に載せて発行する)。" +
			"通常モデルはこれを直接指定せず、propose-* → 確認カードのユーザータップ経由でのみ設定される。",
	);

// --- propose-delete-*(S1・docs/modeling/14 確認カードの入り口)の入力 shape --------------------
// 副作用なし。対象を読んで確認カードを開くためのトークン + プレビューを _meta に返す。入力は本体
// delete-* の同定情報だけ(confirmToken は取らない — トークンはここで発行する側)。
const proposeDeleteTodoInputShape = {
	id: z.string().describe("削除確認するリマインダー(VTODO)の UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
};
const proposeDeleteEventInputShape = {
	id: z.string().describe("削除確認する予定(VEVENT)の UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "calendar"。'),
};
const proposeDeleteCalendarInputShape = {
	id: z.string().describe("削除確認するカレンダー/リマインダーリストのコレクション ID。"),
};

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

const createTodoInputShape = {
	...createTodoItemFieldsShape,
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
		address: z.string().optional().describe("住所(表示用の補足テキスト)。省略可。"),
		lat: z.number().min(-90).max(90).describe("緯度(WGS84)。"),
		lon: z.number().min(-180).max(180).describe("経度(WGS84)。"),
		radius: z.number().positive().optional().describe("ジオフェンス半径(メートル)。省略可(半径なしの地点として扱う)。"),
	})
	.describe(
		"座標付きの構造化された場所(list-known-locations が返す既知の場所や、地図検索で選んだ地点を想定)。" +
			'自由記述のテキストだけを設定したい場合は location フィールドを使うこと(structuredLocation は "この地点" を' +
			"座標込みで表す場合にのみ使う — 単なる場所の説明文をここに入れない)。",
	);

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
	location: z.string().optional().describe("LOCATION(場所)。§3.8.1.7 の TEXT。空文字は未設定と同義。"),
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
		"LOCATION。省略=変更しない / null=場所を外す / 文字列=差し替え。",
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
	// 【2026-07-16 追記(D 案・silent drop 対策)】旧文言は「省略時は "tasks"」とだけ書いており、
	// 「他にも VTODO コレクションがあるかもしれない」ことを示唆していなかった。実アカウントで
	// tasks/reading-list のように VTODO コレクションが複数あるとき、モデルが calendarId 省略で
	// 「全体を見た」つもりになり reading-list を静かに取りこぼす事故があった(親レビューで確認)。
	// 完全解決(横断既定化。events 系 resolveCollectionIds と同じ挙動)は「カードは単一コレクション
	// 前提」という既存 UI 契約(todos-view-model.ts の calendarId: string 必須)を壊すため見送り、
	// 今回は「他にもある」ことを otherTodoCollections で応答側から伝える最小変更(D 案)に留める。
	calendarId: z.string().optional().describe(
		'対象コレクション ID。省略時は "tasks" のみを対象とする。他の VTODO コレクション' +
			"(list-calendars で components に VTODO を含むもの)を見るには calendarId を明示すること。",
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

/**
 * list-todos の silent drop 対策(D 案)用: calendarId 省略呼び出しで「実際に見せたコレクション以外に
 * VTODO コレクションがまだ存在するか」を解決する。
 *
 * 【なぜ events 系の resolveCollectionIds のように横断既定化しないか(Why not)】
 * events 側(list-events-expanded/get-freebusy)は元から「省略=横断」で、応答も item ごとに
 * calendarId を併記する wire 形(toWireEvent)なので複数コレクション混在を表現できる。
 * todos 側は TodosViewModel.calendarId が単一 string 必須(todos-view-model.ts)で、UI
 * (todos-entry.ts)も「1カード=1コレクション」前提で作られている。ListTodos の実行を横断化すると
 * この単一コレクション契約を壊し、カード描画・quick-add の作成先(currentCalendarId)まで
 * 波及するため、今回のスライスでは見送る(親仕様の指示どおり)。代わりに「tasks は見せたが
 * 他にもある」ことだけを構造化フィールドで伝え、モデルに calendarId 明示の追加呼び出しを促す
 * (Anthropic「Writing tools for agents」の部分結果ステアリングと同じ発想)。
 *
 * 【VTODO 判定基準】list-calendars と同じ「components に VTODO を含む」基準を使う。
 * CalendarCollection.accepts("VTODO")(supportedComponents undefined=全受理 MUST を織り込み済み
 * の既存ドメインヘルパー)をそのまま再利用し、判定ロジックの重複実装を避ける。
 */
async function resolveOtherTodoCollections(
	deps: McpAppDeps,
	owner: PrincipalRef,
	shownCollectionId: string,
): Promise<{ id: string; displayName: string }[]> {
	const collections = await deps.collectionRepo.findAllByOwner(owner);
	return collections
		.filter((c) => c.accepts("VTODO") && c.id !== shownCollectionId)
		.map((c) => ({ id: c.id, displayName: c.displayName }));
}

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

/** MCP ツールハンドラの共通エラー整形。isError:true + content にメッセージを詰める。 */
function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

// =============================================================================
// S1(docs/modeling/14 確認カード): propose-delete-* のプレビュー生成 + delete-* のトークン検証
// =============================================================================

// Tier A(確認必須)の delete ツール名。propose-delete-* が発行する「対象特定トークン」の
// payload.tool と、delete-* 側の検証で照合するキー。
type DeleteToolName = "delete-todo" | "delete-event" | "delete-calendar";

/**
 * propose-delete-* が署名する「対象を特定した」確認トークンの論理ペイロード。delete-* 側は
 * このペイロードが自分の (tool, id, calendarId) と一致するトークンだけを受理する(別対象へ流用させない)。
 * 【なぜ tool も含めるか】delete-todo 用に発行したトークンで delete-event を叩く、のような
 * ツール間流用を防ぐ(id 空間はツールごとに別・混同されると別リソースを消しかねない)。
 */
function deleteProposePayload(tool: DeleteToolName, id: string, calendarId: string | undefined): Record<string, unknown> {
	// calendarId は undefined のときキーごと省く(canonicalJson の undefined 省略と揃え、署名側/検証側で
	// 「calendarId 省略」の表現を1つに固定する — {calendarId: undefined} と {} を同一視させる)。
	return calendarId !== undefined ? { kind: "delete", tool, id, calendarId } : { kind: "delete", tool, id };
}

/**
 * delete-* 実行前のトークン検証(§4 Tier A のハード強制)。confirmToken が無い/不正/別対象/失効なら
 * 拒否メッセージ(string)を返し、受理できるなら null を返す(呼び出し側は null のときだけ UC を実行)。
 *
 * 受理するトークンは2種類(docs/modeling/14 §6 項目5 の設計判断):
 *   (A) propose-delete-* が発行した「対象特定トークン」(payload.kind==="delete" かつ tool/id/calendarId 一致)。
 *   (B) 既存 todos/agenda カードが持つ「免除トークン」(payload.kind==="card")。カード内の swipe/詳細
 *       ページ削除は既にユーザーの明示操作なので確認カードを二重に挟まない。カードは list/refresh/mutate
 *       応答の _meta.confirm.cardToken でこの免除トークンを受け取り、delete 時に confirmToken として返す
 *       (詳細な採択理由・ボツ案は下の getCardToken 定義箇所コメント参照)。
 * どちらも「モデルは _meta を読めない=トークンを知り得ない」ことで、確認済み実行が必ずユーザーの
 * タップを経由することを担保する(§2)。
 */
async function verifyDeleteConfirmation(
	secret: string,
	confirmToken: string | undefined,
	tool: DeleteToolName,
	id: string,
	calendarId: string | undefined,
): Promise<string | null> {
	// secret 未設定は確認機構が成立しない(propose も署名できない)。安全側=削除を通さない
	// (空鍵で誰でも通る事故を防ぐ)。運用者向けの明示メッセージにする。
	if (secret === "") {
		return "サーバーの確認トークン鍵(CONFIRM_SECRET)が未設定のため、削除を実行できません。管理者に設定を依頼してください。";
	}
	if (confirmToken === undefined || confirmToken === "") {
		// Tier A の誘導: モデルが直接 delete-* を叩いた(propose を経ていない)ケース。propose を促す。
		return `この操作には確認が必要です。まず propose-${tool}(id 等を渡す)を呼び、ユーザーが確認カードで承認してから実行してください。`;
	}
	const v = await verifyConfirmToken(secret, confirmToken);
	if (!v.ok) {
		if (v.reason === "expired") return "確認トークンの有効期限が切れています。もう一度 propose-* から確認し直してください。";
		return "確認トークンが不正です。propose-* が発行したトークンを使ってください。";
	}
	const p = v.payload;
	// (B) 免除トークン(カード発の削除)。対象特定はしない(カード操作自体がユーザーの明示確認)。
	if (p.kind === "card") return null;
	// (A) 対象特定トークン。tool/id/calendarId が完全一致するときだけ受理。
	if (
		p.kind === "delete" &&
		p.tool === tool &&
		p.id === id &&
		(p.calendarId ?? undefined) === (calendarId ?? undefined)
	) {
		return null;
	}
	// 署名は正しいが対象が違う(別 id/別ツール用に発行されたトークンの流用)。黙って通さない。
	return "確認トークンがこの削除対象と一致しません。この対象に対する propose-* を呼び直してください。";
}

// --- propose-delete-* のプレビュー生成(表示専用の best-effort な ICS 覗き見)---------------------
// 【なぜ presentation で ICS を覗くのか(層の割り切り)】確認カードのプレビュー(タイトル/日時)は
// 「表示専用」であって、削除の権威的な読み取り・実行は application 層の delete-* UC が行う。ここは
// 「対象を見つけて短い表示文字列を作る」だけの best-effort なので、重い DTO 展開(recurrence 展開等)を
// 呼ばず、リソースの rawIcs から SUMMARY と日時プロパティを素朴に拾う。取れなければ degrade(無題/日時なし)。
function decodeIcsText(raw: string): string {
	// RFC 5545 TEXT の最小 unescape(\\ \, \; \n)。表示用なので厳密さより堅牢さ優先。
	return raw.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function formatIcsDate(raw: string): string {
	// "YYYYMMDD" / "YYYYMMDDTHHMMSSZ?" を "YYYY-MM-DD" / "YYYY-MM-DD HH:MM" へ。合致しなければ生値を返す。
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(raw.trim());
	if (m === null) return raw.trim();
	const date = `${m[1]}-${m[2]}-${m[3]}`;
	return m[4] !== undefined ? `${date} ${m[4]}:${m[5]}` : date;
}
/** rawIcs から表示用プレビュー(title + 日時)を作る。dateProp は VEVENT なら "DTSTART"・VTODO なら "DUE"。 */
function icsPreview(rawIcs: string, dateProp: "DTSTART" | "DUE"): { title: string; subtitle?: string } {
	// 折り返し行(次行が空白/タブ始まり)を畳んでから走査する(RFC 5545 line folding)。
	const unfolded = rawIcs.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
	let title = "";
	let subtitle: string | undefined;
	for (const line of unfolded.split(/\r?\n/)) {
		// プロパティ名は ";"(パラメータ付き)か ":"(値直結)で終わる。SUMMARY / dateProp を先勝ちで拾う。
		if (title === "" && (line.startsWith("SUMMARY:") || line.startsWith("SUMMARY;"))) {
			const i = line.indexOf(":");
			if (i >= 0) title = decodeIcsText(line.slice(i + 1)).trim();
		}
		if (subtitle === undefined && (line.startsWith(`${dateProp}:`) || line.startsWith(`${dateProp};`))) {
			const i = line.indexOf(":");
			if (i >= 0) subtitle = formatIcsDate(line.slice(i + 1));
		}
	}
	return { title: title === "" ? "(無題)" : title, subtitle };
}

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
function buildMcpServer(deps: McpAppDeps, principal: PrincipalRef, scopes: readonly string[] | undefined, requestColo?: string): McpServer {
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
			const startedAtMs = Date.now();
			try {
				return await cb(...args);
			} finally {
				// 1行 JSON(mcpTool 名 + ms + colo)。タスク内容等の個人データは決して載せない。
				// colo は「実行場所 × ツール別レイテンシ」の分解用(buildMcpServer 冒頭コメント参照)。
				console.log(JSON.stringify({ mcpTool: name, ms: Date.now() - startedAtMs, ...(requestColo !== undefined ? { colo: requestColo } : {}) }));
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

	// --- confirm ui:// リソース(S1・docs/modeling/14 確認カード)------------------------
	// propose-delete-* が _meta.ui.resourceUri で参照する「削除の確認」カードの HTML 本体を登録する
	// (todos/agenda カードと対称。自己完結バンドルなので CSP 許可は不要)。旧・静的 URI エイリアスは
	// 作らない(このカードは今回新規追加で「旧 URI を掴んだホスト」が存在しないため — content-address
	// URI だけで足りる)。
	registerAppResource(
		server,
		"Delete Confirmation",
		CONFIRM_UI_URI,
		{
			title: "削除の確認",
			description: "破壊的操作(削除)の前にユーザーへ確認を求める汎用カード(propose-delete-* が開く)",
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
					uri: CONFIRM_UI_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: CONFIRM_APP_HTML,
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

	// --- propose-delete-*(S1・docs/modeling/14 §2)---------------------------------------
	// 「副作用なし。対象を読んで確認カードを開く」ツール。結果 content にはモデル向けの短文だけを載せ、
	// トークン + プレビューは _meta.confirm にだけ載せる(モデルは _meta を読めない=トークンを知り得ない)。
	// 【content にプレビューを載せない理由】プレビュー(タイトル/日時)は _meta 経由でカードにだけ渡す。
	// content に載せるとモデルのコンテキストに入るが、確認フローに必要なのはカード表示だけなので最小に保つ。
	const CONFIRM_CONTENT_TEXT = "確認カードを表示しました。ユーザーがカードで承認するまで削除は実行されません。";

	/** propose-delete-* の共通レスポンス(_meta.ui で確認カードを開き、_meta.confirm に契約を載せる)。 */
	const proposeResponse = (confirm: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text: CONFIRM_CONTENT_TEXT }],
		_meta: {
			// registerAppTool が config._meta から補完する ui.resourceUri を、この結果自身にも明示して
			// 「この propose 結果は確認カードを開く」ことをホストへ確実に伝える(todos の outputTemplate と同型)。
			ui: { resourceUri: CONFIRM_UI_URI },
			"ui/resourceUri": CONFIRM_UI_URI,
			"openai/outputTemplate": CONFIRM_UI_URI,
			confirm,
		},
	});

	// secret 未設定なら propose 自体が署名できない(=確認フローが成立しない)。安全側で明示エラーにする
	// (delete-* 側の verifyDeleteConfirmation の secret 空チェックと対。運用者向けメッセージ)。
	const proposeSecretMissing = (): ReturnType<typeof toolError> =>
		toolError("サーバーの確認トークン鍵(CONFIRM_SECRET)が未設定のため、削除確認を発行できません。管理者に設定を依頼してください。");

	// propose-delete-todo / propose-delete-event は「単一リソースを読み SUMMARY + 日時をプレビューにする」
	// が共通なので1関数に括る(dateProp と既定コレクション・見出し・tool 名だけ差し替える)。
	const proposeDeleteResource = async (
		tool: "delete-todo" | "delete-event",
		id: string,
		calendarId: string | undefined,
		defaultCollection: string,
		dateProp: "DTSTART" | "DUE",
		heading: string,
		notFoundMsg: string,
	) => {
		if (deps.confirmSecret === "") return proposeSecretMissing();
		let cid: CollectionId;
		try {
			cid = mkCollectionId(calendarId ?? defaultCollection);
		} catch (error) {
			if (error instanceof InvalidIdentifierError) return toolError(error.message);
			throw error;
		}
		const uri = await deps.resourceRepo.findUriByUid(principal, cid, id);
		if (uri === null) return toolError(notFoundMsg);
		const resource = await deps.resourceRepo.findByUri(principal, cid, uri);
		if (resource === null) return toolError(notFoundMsg);
		const preview = icsPreview(resource.rawIcs, dateProp);
		const collection = await deps.collectionRepo.findById(principal, cid);
		const token = await signConfirmToken(deps.confirmSecret, deleteProposePayload(tool, id, calendarId), PROPOSE_TOKEN_TTL_MS);
		return proposeResponse({
			token,
			tool,
			id,
			// calendarId は「本体 delete-* が受ける形」をそのまま反映する(propose で省略 → カードも省略 →
			// delete-* は既定コレクションへ・token payload も calendarId 無しで一致する)。
			...(calendarId !== undefined ? { calendarId } : {}),
			heading,
			preview: {
				title: preview.title,
				...(preview.subtitle !== undefined ? { subtitle: preview.subtitle } : {}),
				...(collection !== null ? { collection: collection.displayName } : {}),
			},
		});
	};

	registerAppTool(
		server,
		"propose-delete-todo",
		{
			title: "Propose delete todo",
			description:
				"リマインダー(VTODO)の削除確認カードを表示する(まだ削除しない)。削除は破壊的で取り消せないため、" +
				"delete-todo を直接呼ぶ前に必ずこれを呼び、ユーザーがカードで承認してから削除が実行される。",
			inputSchema: proposeDeleteTodoInputShape,
			_meta: {
				ui: { resourceUri: CONFIRM_UI_URI },
				"openai/outputTemplate": CONFIRM_UI_URI,
			},
		},
		async ({ id, calendarId }) => {
			try {
				return await proposeDeleteResource(
					"delete-todo",
					id,
					calendarId,
					"tasks",
					"DUE",
					"このリマインダーを削除しますか?",
					"削除確認するリマインダーが見つかりません(id/コレクションを確認してください)。",
				);
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	registerAppTool(
		server,
		"propose-delete-event",
		{
			title: "Propose delete event",
			description:
				"予定(VEVENT)の削除確認カードを表示する(まだ削除しない)。削除は破壊的で取り消せないため、" +
				"delete-event を直接呼ぶ前に必ずこれを呼び、ユーザーがカードで承認してから削除が実行される。",
			inputSchema: proposeDeleteEventInputShape,
			_meta: {
				ui: { resourceUri: CONFIRM_UI_URI },
				"openai/outputTemplate": CONFIRM_UI_URI,
			},
		},
		async ({ id, calendarId }) => {
			try {
				return await proposeDeleteResource(
					"delete-event",
					id,
					calendarId,
					"calendar",
					"DTSTART",
					"この予定を削除しますか?",
					"削除確認する予定が見つかりません(id/コレクションを確認してください)。",
				);
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	registerAppTool(
		server,
		"propose-delete-calendar",
		{
			title: "Propose delete calendar",
			description:
				"カレンダー/リマインダーリスト(コレクション)の削除確認カードを表示する(まだ削除しない)。" +
				"中身がある場合は「中身ごと消える」ことをカードで警告する。delete-calendar を直接呼ぶ前に必ずこれを呼ぶ。",
			inputSchema: proposeDeleteCalendarInputShape,
			_meta: {
				ui: { resourceUri: CONFIRM_UI_URI },
				"openai/outputTemplate": CONFIRM_UI_URI,
			},
		},
		async ({ id }) => {
			try {
				if (deps.confirmSecret === "") return proposeSecretMissing();
				let cid: CollectionId;
				try {
					cid = mkCollectionId(id);
				} catch (error) {
					if (error instanceof InvalidIdentifierError) return toolError(error.message);
					throw error;
				}
				const collection = await deps.collectionRepo.findById(principal, cid);
				if (collection === null) return toolError("削除確認するカレンダー/リストが見つかりません。");
				// 中身の件数を数える(> 0 なら「中身ごと削除」= force:true が必要。カードで明示警告する)。
				const contents = await deps.resourceRepo.findAllInCollection(principal, cid);
				const count = contents.length;
				const token = await signConfirmToken(
					deps.confirmSecret,
					deleteProposePayload("delete-calendar", id, undefined),
					PROPOSE_TOKEN_TTL_MS,
				);
				return proposeResponse({
					token,
					tool: "delete-calendar",
					id,
					// 中身があるときだけ force:true をカードへ渡す(delete-calendar の非空拒否を、確認済みなら通す)。
					...(count > 0 ? { force: true } : {}),
					heading: "このカレンダー/リストを削除しますか?",
					preview: {
						title: collection.displayName,
						...(count > 0 ? { count } : {}),
					},
				});
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
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
				"create-todo/list-todos の calendarId としてそのまま使える。",
			inputSchema: createCalendarInputShape,
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, displayName, components, color, timeZone }) => {
			try {
				const resolvedId = id ?? slugifyForCollectionId(displayName);
				const supportedComponents: readonly ComponentKind[] = (components ?? ["VTODO"]) as readonly ComponentKind[];
				const parsedColor = color !== undefined ? AppleColor.parse(color) : undefined;
				const createCollection = new CreateCollection(deps.collectionRepo);
				const { collection } = await createCollection.execute({
					owner: principal,
					collectionId: resolvedId,
					displayName,
					supportedComponents,
					color: parsedColor,
				});
				const result = {
					id: collection.id,
					displayName: collection.displayName,
					components: collection.supportedComponents ?? supportedComponents,
					...(collection.color !== undefined ? { color: collection.color.toString() } : {}),
				};
				// structuredContent は TodosViewModel 契約(UI が読む形)にする。tasks を空配列で
				// 決め打ちしない理由: 作成直後でも実在確認を兼ねて実際に ListTodos を1回通しておくと、
				// 将来 CreateCollection が「既存タスクを引き継いだ複製」等になっても壊れない
				// (buildTodosViewModel は他の mutate 系ツールと同じ経路なので挙動が揃う)。
				// 現状は新規コレクションなので実質空配列が返るだけで、レイテンシコストは他の
				// mutate 系ツール(create-todo 等)と同等(確定一覧の ListTodos 1回)。
				// カレンダーのメタ情報(displayName/components/color)は UI 契約に不要なので
				// content(text)側にだけ残し、structuredContent には calendarId のみ載せる。
				const vm = await buildTodosViewModel({ calendarId: collection.id, timeZone });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: vm as unknown as { [key: string]: unknown },
				};
			} catch (error) {
				// InvalidIdentifierError(id/自動生成 slug が不正 — 通常 slugify 側で防げるが id 手動
				// 指定時は起きうる)/ CollectionAlreadyExistsError(id 衝突。MKCALENDAR の 405/409 相当を
				// presentation でも「入力起因のエラー」としてそのまま返す。既存 create-todo と同じ
				// toolError 流儀)/ AppleColor.parse の形式エラーもここに落ちる(Error のまま)。
				if (error instanceof InvalidIdentifierError || error instanceof CollectionAlreadyExistsError) {
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
		},
		async ({ id, force, confirmToken }) => {
			try {
				// S1(docs/modeling/14 §4 Tier A): UC 実行前にトークン検証。calendarId は無い(コレクション
				// そのものが対象)ので undefined を渡す(propose-delete-calendar の payload も calendarId 無し)。
				const denied = await verifyDeleteConfirmation(deps.confirmSecret, confirmToken, "delete-calendar", id, undefined);
				if (denied !== null) return toolError(denied);
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
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ title, notes, due, timeZone, priority, calendarId, recurrence }) => {
			try {
				// recurrence 正規化(Case E): frequency:"none" は presentation 限定の語彙なので、
				// application 層に渡す前にここで吸収する(上の createTodoRecurrenceInputShape
				// コメント「Case E 採用」参照)。"none" + サブフィールド併用は黙殺せずエラーにする
				// (ユーザー/LLM が意図した反復設定が静かに消えるのを防ぐ)。2026-07-14: create-todos
				// バッチ追加に伴い normalizeCreateTodoRecurrenceInput 共通ヘルパーへ切り出した
				// (throw する流儀になったので、ここでは try ブロック内から呼ぶだけでよい —
				// 投げられた RangeError は下の catch の catch-all で toolError に変換される)。
				const normalizedRecurrence = normalizeCreateTodoRecurrenceInput(recurrence);

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
				return toTodosToolResponse(vm);
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
		/** list-todos/refresh-todos の calendarId 省略時のみ呼び出し側が解決して渡す。
		 *  TodosViewModel.otherTodoCollections の JSDoc 参照。 */
		otherTodoCollections?: { id: string; displayName: string }[];
	}): Promise<TodosViewModel> => {
		const zone = resolveTimeZone(opts.timeZone);
		// 【次の伸びしろ(今回スコープ外)】この確定一覧は応答契約(TodosViewModel.tasks)上必要なので
		// 残す。ただし ListTodos は findAllInCollection で全リソースを引いてメモリで VTODO/STATUS/DUE を
		// 絞る(list-todos.ts の設計)ため、コレクションが大きいと 1 mutate で必ず1回の全件読みが残る。
		// さらに削るなら「VTODO 種別・未完了・due 範囲を SQL(D1)側で絞る専用ポート」を足すのが本筋
		// (2026-07-14 レイテンシ改善では UC の before/removed 化で presentation 側の余計な全件読みを
		// 消すところまでに留め、SQL レベルの絞り込みは別タスクにする)。
		const listTodos = new ListTodos(deps.resourceRepo);
		const { tasks } = await listTodos.execute({
			owner: principal,
			includeCompleted: opts.includeCompleted,
			dueBefore: opts.dueBefore,
			dueAfter: opts.dueAfter,
			calendarId: opts.calendarId,
			timeZone: zone,
		});
		const vm: TodosViewModel = { tasks, calendarId: opts.calendarId ?? "tasks", timeZone: zone };
		// 空配列を載せると UI が「差分ゼロの mutate」と誤認しかねないので、値があるときだけ載せる。
		if (opts.affected !== undefined) vm.affected = opts.affected;
		if (opts.removed !== undefined) vm.removed = opts.removed;
		if (opts.movedTo !== undefined) vm.movedTo = opts.movedTo;
		// otherTodoCollections: 存在しなければフィールド自体を省略(affected/removed と同じ規律)。
		if (opts.otherTodoCollections !== undefined && opts.otherTodoCollections.length > 0) {
			vm.otherTodoCollections = opts.otherTodoCollections;
		}
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
			// 【省略判定は生 input で行う】args.calendarId が undefined かどうかがそのまま
			// 「モデルが対象を絞らずに呼んだか」の判定材料。buildTodosViewModel/ListTodos 内部では
			// `?? "tasks"` に潰ってしまい判定材料が失われるため、潰す前のこの地点で判定する
			// (仕様の指示どおり)。明示指定時は「スコープ明示済み」とみなし解決自体を省く
			// (無駄な findAllByOwner を避ける最適化も兼ねる)。
			const otherTodoCollections = args.calendarId === undefined
				? await resolveOtherTodoCollections(deps, principal, "tasks")
				: undefined;
			return toTodosToolResponse(await buildTodosViewModel({ ...args, otherTodoCollections }));
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
				'calendarId 省略時は "tasks" のみ。応答の otherTodoCollections に他のリマインダーリストが載る場合、全体を見るにはそれらも列挙すること。',
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
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, title, notes, due, timeZone, priority, status, recurrence }) => {
			try {
				// recurrence 正規化(2026-07-15): presentation 5値 + optional を application の三値
				// (undefined=据え置き / null=除去 / 4値=全置換)へ写す。none + サブフィールド併用は
				// ここで RangeError → catch-all で toolError に変換される(意図した設定を黙殺しない)。
				const normalizedRecurrence = normalizeUpdateTodoRecurrenceInput(recurrence);
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
				return toTodosToolResponse(vm);
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
			_meta: {
				ui: { resourceUri: TODOS_UI_URI },
				"openai/outputTemplate": TODOS_UI_URI,
			},
		},
		async ({ id, calendarId, timeZone, confirmToken }) => {
			try {
				// S1(docs/modeling/14 §4 Tier A): UC 実行の手前で確認トークンを検証する(presentation に
				// 閉じる=DeleteTodo UC のシグネチャに confirmToken を持ち込まない)。無効/欠落は propose 誘導。
				const denied = await verifyDeleteConfirmation(deps.confirmSecret, confirmToken, "delete-todo", id, calendarId);
				if (denied !== null) return toolError(denied);
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
	const eventsToolResponse = async (vm: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text: JSON.stringify(vm) }],
		structuredContent: vm as { [key: string]: unknown },
		_meta: { confirm: { cardToken: await getCardToken() } },
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

	server.registerTool(
		"create-event",
		{
			title: "Create event",
			description:
				"新規 VEVENT(予定)を作成する。UID/DTSTAMP はサーバーが生成する。" +
				'start は "YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone 必須)、end は排他的終端(省略可)。' +
				'calendarId 省略時は "calendar" コレクションに作成する。' +
				"2件以上の予定をまとめて追加する場合は create-event を繰り返し呼ばず、必ず create-events を使うこと。",
			inputSchema: createEventInputShape,
		},
		async ({ title, notes, start, end, timeZone, location, url, calendarId, recurrence, alarms, travelMinutes, structuredLocation, conference }) => {
			try {
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
					structuredLocation,
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
				};
				return eventsToolResponse(vm);
			} catch (error) {
				if (isEventInputError(error)) return toolError((error as Error).message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	server.registerTool(
		"create-events",
		{
			title: "Create events (batch)",
			description:
				"複数の予定(VEVENT)をまとめて追加する。2件以上の追加は必ずこちらを使うこと。" +
				"各 item は create-event と同じ語彙(title/start 必須)。calendarId/timeZone は全 item 共通。",
			inputSchema: createEventsInputShape,
		},
		async ({ items, calendarId, timeZone }) => {
			try {
				const putCalendarObject = new PutCalendarObject(deps.collectionRepo, deps.resourceRepo, deps.uow, deps.iterator);
				const createEvent = new CreateEvent(putCalendarObject);

				const cid = calendarId ?? "calendar";
				const createdEvents: ReturnType<typeof toWireEvent>[] = [];
				const succeeded: AffectedEvent[] = [];
				const failed: { title: string; reason: string }[] = [];

				// create-todos と同じく直列実行(D1 の同一コレクション PUT 競合・sync token 順序を守る)。
				for (const item of items) {
					try {
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
							structuredLocation: item.structuredLocation,
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
				};
				if (succeeded.length > 0) vm.affected = succeeded;

				const summaryLines = [`${succeeded.length}/${items.length} 件の予定を作成しました。`];
				if (failed.length > 0) {
					summaryLines.push("失敗した項目:");
					for (const f of failed) summaryLines.push(`- "${f.title}": ${f.reason}`);
				}
				return {
					content: [{ type: "text" as const, text: summaryLines.join("\n") }],
					structuredContent: vm as { [key: string]: unknown },
				};
			} catch (error) {
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	server.registerTool(
		"update-event",
		{
			title: "Update event",
			description:
				"既存 VEVENT(予定)の一部フィールドを更新する。指定したフィールドのみ変更し、他は維持する。" +
				"通知(何分前アラーム)・繰り返し・URL・移動時間の追加/変更/削除もこのツールで行う" +
				"(alarms/recurrence/url/travelMinutes を指定すれば更新、null で除去)。" +
				"end は null で終了を外せる(開始のみのイベント)。反復イベントはマスター(系列)単位で編集する。",
			inputSchema: updateEventInputShape,
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
					structuredLocation,
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
				};
				return eventsToolResponse(vm);
			} catch (error) {
				if (isEventInputError(error)) return toolError((error as Error).message);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	);

	server.registerTool(
		"delete-event",
		{
			title: "Delete event",
			description: "VEVENT(予定)を削除する。常に無条件削除(ETag 条件なし — delete-event.ts 冒頭コメント参照)。",
			inputSchema: deleteEventInputShape,
		},
		async ({ id, calendarId, confirmToken }) => {
			try {
				// S1(docs/modeling/14 §4 Tier A): UC 実行前にトークン検証(delete-todo と対称)。
				const denied = await verifyDeleteConfirmation(deps.confirmSecret, confirmToken, "delete-event", id, calendarId);
				if (denied !== null) return toolError(denied);
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
		const server = buildMcpServer(deps, authResult.principal, authResult.scopes, cf?.colo);
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
