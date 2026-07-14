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
// Task 型は findTaskById 廃止(2026-07-14 レイテンシ改善)で presentation から直接参照しなくなった
// (before/removed は UC が返す。差分整形は todos-diff.ts が Task を受ける)。ここでは型 import しない。
import type { CreateTodoRecurrenceInput } from "../../application/usecases";
// E-2 スライス②: mutate 系ツールが返す差分レンズ付き確定一覧の contract と、その表示用整形。
import type { AffectedTask, TaskSnapshot, TodosViewModel } from "./todos-view-model";
import { buildEditedChanges, snapshotFromTask } from "./todos-diff";
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
	MoveTodo,
	MoveTodoSameCollectionError,
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
import type { CollectionId, ComponentKind, PrincipalRef } from "../../domain/caldav";
import { AppleColor, InvalidIdentifierError, collectionId as mkCollectionId } from "../../domain/caldav";
// list-calendars / create-calendar(方向性直近タスク): DAV MKCALENDAR と同じ UC を MCP から
// 別入口で呼ぶ(CLAUDE.md 長期ビジョン「複数入口」の具体例)。
import { CollectionAlreadyExistsError, CreateCollection, ListCollections } from "../../application/usecases";
// delete-calendar(検証運用で「作ったリストを消すツールが無く D1 直で消した」ことが動機。
// DAV DELETE 経路とは別の薄い専用 UC — delete-collection.ts 冒頭コメント参照)。
import { CollectionNotEmptyError, CollectionNotFoundError, DeleteCollection } from "../../application/usecases";
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
};

/**
 * create-calendar の id 省略時に displayName から URL セグメントとして安全な slug を生成する。
 * 【なぜ完全な slugify ライブラリを足さないか】このタスクはドメイン層に触れない制約があり、
 * 依存追加も避けたい。CollectionId の禁止事項(空文字・空白/制御文字・"/")さえ満たせば足りるので、
 * 素朴な正規化(小文字化・許容文字以外を "-" に畳む・前後の "-" を削る)で十分。
 * 【空文字にフォールバックする理由】displayName が絵文字だけ・記号だけ等で slug 化すると
 * 空文字になるケースがある(collectionId() は空文字を拒否する)。その場合は衝突の心配が無い
 * crypto.randomUUID() にフォールバックする(create-todo.ts の UID 生成と同じ発想)。
 */
function slugifyForCollectionId(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : crypto.randomUUID();
}

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
	// LOCATION(§3.8.1.7)。空文字は「未設定」と同義に扱い LOCATION を書かない(2026-07-15 追加)。
	// iOS 標準アプリの位置情報リマインダー(ジオフェンス)とは別物 — こちらは素の TEXT な LOCATION
	// (task-dto.ts の Task.location コメント参照)。
	location: z.string().optional().describe(
		"LOCATION(場所)。§3.8.1.7 の TEXT。空文字は未設定と同義(LOCATION を書かない)。" +
			"iOS の位置情報通知(ジオフェンス)とは別の、単なる場所テキスト。",
	),
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
	timeZone: z.string().optional().describe(
		'due が時刻付き("YYYY-MM-DDTHH:MM:SS")のときの IANA タイムゾーン名(例 "Asia/Tokyo")。必須' +
			"(省略時はエラー・暗黙 UTC フォールバックはしない)。DST ゾーン(例 America/New_York)は" +
			"サーバー側 VTIMEZONE 生成が Phase 1 で未対応のためエラーになる — 固定オフセットゾーンのみ対応。" +
			"due が終日/除去/省略のときは無視する(create-todo の timeZone と同じ制約)。",
	),
	priority: z.number().int().min(0).max(9).optional().describe(
		"PRIORITY(0-9)。0 を渡すと未設定に戻る。省略時は変更しない。",
	),
	// LOCATION(§3.8.1.7)。due の三値と対称(2026-07-15 追加): 省略=変更しない / null=除去 / 文字列=差し替え。
	location: z.string().nullable().optional().describe(
		"LOCATION(場所)。三値: 省略=変更しない / null=場所を外す / 文字列=差し替え。" +
			"iOS の位置情報通知(ジオフェンス)とは別の、単なる場所テキスト(§3.8.1.7 の TEXT)。",
	),
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

const completeTodoInputShape = {
	id: z.string().describe("完了対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
};

const deleteTodoInputShape = {
	id: z.string().describe("削除対象の VTODO UID。"),
	calendarId: z.string().optional().describe('対象コレクション ID。省略時は "tasks"。'),
};

// move-todo の入力(UI 詳細シート「リスト ›」からのコレクション間移動)。move-todo.ts 冒頭コメント
// のとおり DAV MOVE(RFC 4918 §9.9)実装はスコープ外の MCP 専用ツール。
const moveTodoInputShape = {
	id: z.string().describe("移動対象の VTODO UID。"),
	calendarId: z.string().optional().describe('移動元コレクション ID。省略時は "tasks"。'),
	toCalendarId: z.string().describe("移動先コレクション ID(list-calendars/create-calendar が返す id)。"),
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
// requestColo: リクエストが処理されている Cloudflare colo(request.cf.colo)。2026-07-14 追加。
// 【なぜログに colo が要るか】console.log イベントには $workers.event.request.cf.colo が
// 乗らない(observability で groupBy したら空だった実測)ため、リクエストイベントと突合できず
// 「どの colo で実行されたツール呼び出しが遅いのか」を分解できなかった。D1 は APAC 固定なので
// 実行 colo が遠い(例: claude.ai バックエンド発 = IAD)ほど D1 直列往復のペナルティが線形に
// 効く仮説の検証と、Smart Placement(wrangler.jsonc)導入後に実行 colo が D1 側へ寄ったことの
// 確認は、このフィールドが唯一の計器になる。
function buildMcpServer(deps: McpAppDeps, principal: PrincipalRef, requestColo?: string): McpServer {
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
		async ({ id, displayName, components, color }) => {
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
				const vm = await buildTodosViewModel({ calendarId: collection.id });
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
		async ({ id, force }) => {
			try {
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
		async ({ title, notes, due, timeZone, priority, calendarId, recurrence, location }) => {
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
					location, // 空文字は CreateTodo/buildVTodoCalendar 側で「未設定」に倒す(LOCATION を書かない)。
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
							location: item.location, // create-todo と同じく空文字は未設定扱い。
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
	const toTodosToolResponse = (vm: TodosViewModel) => ({
		content: [{ type: "text" as const, text: JSON.stringify(vm) }],
		structuredContent: vm as unknown as { [key: string]: unknown },
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
			return toTodosToolResponse(await buildTodosViewModel(args));
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
		async ({ id, calendarId, title, notes, due, timeZone, priority, status, location, recurrence }) => {
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
					// location は三値(undefined=据え置き / null=除去 / 文字列=差し替え)をそのまま渡す
					// (zod の .nullable().optional() で null と undefined が区別されて届く)。
					location,
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
					// location/recurrence(2026-07-15)。どちらも buildEditedChanges では field のみ載せる
					// (recurrence は「編集済み」バッジへ degrade する contract。location も最小は field のみ)。
					if (location !== undefined) provided.add("location");
					if (recurrence !== undefined) provided.add("recurrence");
					const changes = before !== undefined ? buildEditedChanges(before, task, provided) : undefined;
					affected = [{ id: task.id, kind: "edited", task: snapshotFromTask(task), ...(changes !== undefined ? { changes } : {}) }];
				}

				const vm = await buildTodosViewModel({ calendarId, affected });
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
		async ({ id, calendarId }) => {
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
				const vm = await buildTodosViewModel({
					calendarId,
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
		async ({ id, calendarId }) => {
			try {
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
				const vm = await buildTodosViewModel({ calendarId, removed });
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
		async ({ id, calendarId, toCalendarId }) => {
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
				const vm = await buildTodosViewModel({ calendarId, removed, movedTo: toCalendarId });
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
		// request.cf は Workers ランタイムでのみ存在(bun test の素の Request には無い)ため
		// optional chain で安全に取る。colo は計測ログ専用(認可・応答内容には一切影響しない)。
		const cf = (c.req.raw as { cf?: { colo?: string } }).cf;
		const server = buildMcpServer(deps, authResult.principal, cf?.colo);
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
