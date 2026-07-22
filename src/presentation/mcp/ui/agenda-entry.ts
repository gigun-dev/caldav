// =============================================================================
// presentation/mcp/ui/agenda-entry.ts — list-events-expanded 用 MCP Apps のブラウザ向けエントリ
//                                        (E-3 スライス S2 本実装・バンドル前ソース)
// =============================================================================
// 【このファイルの位置づけ】
//   scripts/build-ui-bundle.ts がこのファイルを bun build でブラウザ向け単一 ESM にバンドルし、
//   結果(文字列)を src/presentation/mcp/ui/agenda-bundle.ts(自動生成・コミット対象)へ書き出す。
//   agenda-app.ts はその生成物を HTML の <script type="module"> 本体に補間して埋め込む。
//   自己完結バンドル方針・DOM 前提のブラウザコード・外部 import 禁止(ext-apps + ui/ 内共有のみ)の
//   3点は todos-entry.ts の冒頭コメントと完全に同一なので、詳細はそちらを参照(重複させない)。
//
// 【structuredContent の契約(EventsViewModel。型 import はしない = ui は末端)】
//   list-events-expanded / refresh-events / create-event(s) / update-event / delete-event が返す
//   structuredContent は events-view-model.ts の EventsViewModel:
//     { events: Event[], calendarId, timeZone,
//       affected?: Array<{ id, kind:"added"|"edited", event?:EventSnapshot,
//                          changes?:Array<{field,before?,after?}> }>,
//       removed?: EventSnapshot[],
//       range?: { from, to },       // list/refresh だけが echo(mutate は名乗らない=判別シグナル)
//       truncated? }
//   range は「この一覧はどの期間か」(todos の view と同役割)。UI は vm.range を currentRange として
//   保持し、focus refetch / mutation 後の取り直しへ同じ期間を引き継ぐ。events は常に「サーバー確定の
//   全一覧(展開済み occurrence 列)」。affected/removed は mutate 系だけが返す差分メタで、
//   list/refresh には無い(欠落は通常描画へ degrade)。
//   Event = { id, recurrenceId, title, start, end, isAllDay, location, url, notes, status,
//             recurrence, alarms:number[], travelMinutes }(実体は application/usecases/event-dto.ts)。
//   .dependency-cruiser.cjs の mcp-ui-is-terminal が「ui/ から src/ 内他コードへの import」を禁止する
//   ため application 層の Event 型は import せず、契約はローカル interface に写経する(ズレは実機で気づく)。
//
// 【todos v3 との関係(丸ごと流用・差分だけ新しい)】
//   一覧の日付見出しセクション・時刻列(行の錨)・now バー・選択モデル(行タップ=タイトル編集 /
//   ⓘ=カード内詳細ページ)・FAB ドラフト行・左スワイプ削除・楽観更新(適用→確定で重ね直し/失敗
//   ロールバック)・becoming・sync レンズ、はすべて todos v3(todos-entry.ts)の文法をそのまま踏襲する。
//   イベント固有の差分だけが新しい: 完了概念なし(becoming は added/edited/削除)・優先度なし・
//   時刻列が行の錨・詳細に参加行/通知/予備の通知/移動時間/URL。共有純関数(日付/時刻整形・recurrence
//   整形・プリセット写像)は ui/format.ts・ui/recurrence.ts へ抽出済みで両 entry が import する。
// =============================================================================

import { App } from "@modelcontextprotocol/ext-apps";
// E-3 S2: システム起因(外部)変化のクライアント差分の純関数コア(todos-diff-client の event 版)。
import { computeSyncDiff, type SyncDiff } from "./events-diff-client";
// 絵文字/文字グリフを lucide のインライン SVG へ統一する(icons.ts 冒頭コメント参照)。
import { createIcon } from "./icons";
// 由来コレクション id → 表示色の決定的割当(2026-07-22 色ドット)。同 id→同色の純関数(単体テストあり)。
import { colorForCalendarId } from "./calendar-colors";
// 行同一性の合成キー(modeling/12 §7.1・2026-07-16 実機FB)。展開 occurrence の id は全行
// マスター UID なので、選択/スワイプ/DOM 特定は id 単独でなく rowKey(id+recurrenceId)で引く。
// 二層分離の理由(mutate 状態はマスター id のまま)は row-key.ts の冒頭コメント参照。
import { rowKey, idOfRowKey } from "./row-key";
// 操作フィードバック統一ドクトリン v2(docs/modeling/12 §7.8)の共有カーネル。committing
// (寿命付きアニメの最中か)の判定式と定数(1周期・寿命周回数・T_hard)を todos-entry.ts と
// 同じ規律で純関数だけ共有する(CSS/DOM は §7.7 判断を維持し todos と共有しない)。
import { FEEDBACK, isCommitting } from "./feedback";
// inline 畳み(P4-DM C1+C2/C3)の畳み共有カーネル(fold.ts)。todos-entry.ts と同じ純関数を使う
// (occurrence 行単位の畳み。見出し高は rowBottoms の累積 offset に織り込まれるので無改造で流用)。
import { INLINE_PREVIEW_MAX, boundPreviewList, canRequestFullscreen, computeInlineFit } from "./fold";
// C2(設計 05 §2): 場所/会議/参照 URL の「行に何を出すか」を決める純関数群(location-view.ts)。
// 判断は純関数に隔離し(mcp-location-view.test.ts で境界を固定)、DOM 組み立てだけをここで行う。
import {
	type ConferenceView,
	type ProximityAlarmView,
	type StructuredLocationView,
	agendaInlineBadge,
	resolveLocationTitle,
	showReferenceUrl,
} from "./location-view";
// C3+C4(設計 05 §4・§5): 作成フォームの「場所または会議」セミモーダルの選択結果 ⇄ create-event
// 引数の変換(write 側)。location-view.ts(read 側)とは別ファイル(役割が違う: 読みは3スロットの
// 表示判断、書きは1つの選択結果からどちらのスロットへ書くかの判断)。
import {
	CONFERENCE_PROVIDERS,
	knownLocationToPickerValue,
	locationPickerIconName,
	locationPickerLabel,
	locationPickerToCreateArgs,
	type KnownLocationView,
	type LocationPickerValue,
} from "./location-picker";
// 共有カーネル(docs/modeling/12 §4)。日付/時刻整形は todos と同一ロジック。
import { WEEKDAYS, localDateKey, localMidnightIso, wallDatePart, wallTimePart, dayDiff, weekdayOf, addDaysToDateKey } from "./format";
// 安全先頭(safe top)規約の共有カーネル(2026-07-23 カード UI 原則 (b) 是正①・modeling/15 §B-3)。
// HostContext.safeAreaInsets → CSS 変数へ落とす px 値の決定(フォールバック込み)だけを担う純関数。
// 実際に CSS 変数を当てる(setProperty)のは applyHostContext 側(todos-entry.ts と共通の分担)。
import { resolveSafeTopPx, resolveSafeBottomPx, type SafeAreaInsets } from "./safe-area";
// 月ビュー(2026-07-22 ロードマップ②)の日付算術。DOM 非依存の純関数として format.ts に置き
// bun:test 済み(mcp-ui-month-grid.test.ts)。ここは結果を受け取って描画/レンジ算出に使うだけ。
import { type YearMonth, addMonths, monthGridDays, monthGridRange, weekdayIndexOf, yearMonthOf } from "./format";
// 日ビュー(2026-07-22 ロードマップ③)の重なりレイアウト純関数。DOM 非依存・bun:test 済み
// (mcp-ui-day-timeline.test.ts)。renderDayView は結果を left%/width%/top/height へ写すだけ。
import { DAY_MIN, type TimedBlock, type LaidOutBlock, layoutOverlaps, nowLineTopMin } from "./day-timeline";
// 共有カーネル。recurrence 整形 + プリセット写像は todos と同一(二重管理を避ける)。
import {
	type RecurrenceSummary,
	type RecurPreset,
	type RecurArgs,
	formatRecurrence,
	PRESET_LABEL,
	PRESET_MENU_ORDER,
	WEEKDAY_JA,
	presetToArgs,
	recurrenceToPreset,
	recurValueText,
} from "./recurrence";

// --- 静的 DOM への参照(骨格は agenda-app.ts の HTML 側にある)-----------------------
// ヘッダ・バナー・ステータス行は「一覧の状態に依らず常時ある面」なので HTML 静的骨格に置き、
// #root だけを描画のたびに作り直す(todos-app.ts と同じ分担)。
const root = document.getElementById("root") as HTMLElement;
const updatedEl = document.getElementById("updated") as HTMLElement;
const bannerEl = document.getElementById("banner") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const liveEl = document.getElementById("live") as HTMLElement;
// 【2026-07-22 appTitleEl 参照は撤去】見出しは「カレンダー」固定(選択内容で変えない)になり JS から
// 触らなくなったため、#app-title への参照は持たない(静的骨格の文言をそのまま表示する。経緯は
// applyStructuredContent の calendarId 分岐コメント参照)。
const rangeEl = document.getElementById("range") as HTMLElement;
const quickAddFab = document.getElementById("quick-add-fab") as HTMLButtonElement;
// --- 表示カレンダーフィルタ(2026-07-22 collection-picker-v5)の参照 ---------------------------
// ヘッダ右端の色ドットクラスタ + chevron ボタン(#cal-filter-btn)、その中のドットクラスタ(#cal-dots)、
// 直下に開くドロップダウン(#cal-menu)、外タップ捕捉レイヤ(#cal-menu-outside)。いずれも #root の外。
const calFilterBtn = document.getElementById("cal-filter-btn") as HTMLButtonElement;
const calDotsEl = document.getElementById("cal-dots") as HTMLElement;
const calMenuEl = document.getElementById("cal-menu") as HTMLElement;
const calMenuOutsideEl = document.getElementById("cal-menu-outside") as HTMLElement;

// --- C1: hostContext から読んだ空間制約(P4-DM・設計04 §5 C1。todos-entry.ts の同名ブロックを移植)---
// getHostContext().containerDimensions.maxHeight / displayMode / availableDisplayModes を保持する。
// renderAll 最終段の畳み判定(applyInlineFold → computeInlineFit)がこれらを読む。maxHeight 未送信の
// ホスト(現本アプリ)は null のままなので畳みは発火しない(不活性が既定・退行ゼロ・fold.ts コメント参照)。
let hostMaxHeightPx: number | null = null;
let hostDisplayMode: string | null = null;
// ホストが広告する availableDisplayModes。「すべて表示」ボタンを押せる形で出してよいか
// (canRequestFullscreen)の入力になる。未受信は null(=受動表示のまま・不活性が既定)。
let hostAvailableDisplayModes: readonly string[] | null = null;

/** C1 本体: getHostContext() を読み hostMaxHeightPx / hostDisplayMode / hostAvailableDisplayModes を
 *  更新する。todos-entry.ts:265 の applyHostContext を agenda へそのまま移植(挙動を揃える)。
 *  【出典/方針】apps.mdx:687-711(View 初期化時に containerDimensions を確認)。maxHeight は CSS の
 *  直接クリップには使わず --host-max-height 変数へ落とすだけ(素朴な overflow:hidden は行の途中で
 *  切れて見苦しい・実際の畳みは行単位で applyInlineFold が行う)。containerDimensions は {height}
 *  (fixed)と {maxHeight}(flexible)の union なので "maxHeight" in dims で判別する(apps.mdx 公式例)。
 *  fullscreen 時は #root に fullscreen-scroll を当て全件を内部スクロールで見せる(畳みは applyInlineFold が
 *  hostDisplayMode!=="inline" で早期 return するので既に全件表示・ここで足すのはスクロール設定だけ)。 */
// safeAreaLogged: 実測用デバッグログ(受信した safeAreaInsets の生値)を初回の1回だけ出す
// (applyHostContext は hostcontextchanged のたびに何度も呼ばれるため、毎回出すとログが埋もれる)。
// 実機採寸(FULLSCREEN_SAFE_TOP_FALLBACK_PX の精度確認)が終わったらこのログごと削ってよい。
let safeAreaLogged = false;

/** ctx.safeAreaInsets → --host-safe-top / --host-safe-bottom への反映(applyHostContext の下請け)。
 *  「いくつにすべきか」の判断は safe-area.ts の純関数に委ね、ここは setProperty するだけ(How)。 */
function applySafeAreaVars(insets: SafeAreaInsets | undefined): void {
	if (!safeAreaLogged) {
		safeAreaLogged = true;
		// 実測用: claude.ai iOS がクローム込みで申告しているか未確認(modeling/15 §B-3)。
		// devtools の console でこの1行を見れば、申告の有無・値をそのまま確認できる。
		console.log("[agenda] hostcontext.safeAreaInsets =", insets, "displayMode =", hostDisplayMode);
	}
	const top = resolveSafeTopPx(insets, hostDisplayMode);
	const bottom = resolveSafeBottomPx(insets);
	document.documentElement.style.setProperty("--host-safe-top", `${top}px`);
	document.documentElement.style.setProperty("--host-safe-bottom", `${bottom}px`);
}

function applyHostContext(): void {
	const ctx = app.getHostContext();
	hostDisplayMode = ctx?.displayMode ?? null;
	hostAvailableDisplayModes = ctx?.availableDisplayModes ?? null;
	const dims = ctx?.containerDimensions;
	const maxHeight = dims !== undefined && "maxHeight" in dims ? dims.maxHeight : undefined;
	hostMaxHeightPx = typeof maxHeight === "number" ? maxHeight : null;
	if (hostMaxHeightPx !== null) {
		document.documentElement.style.setProperty("--host-max-height", `${hostMaxHeightPx}px`);
	} else {
		document.documentElement.style.removeProperty("--host-max-height");
	}
	// --- 安全先頭(safe top)規約(2026-07-23 カード UI 原則 (b) 是正①・modeling/15 §B-3)---------
	// ctx.safeAreaInsets を CSS 変数 --host-safe-top / --host-safe-bottom へ落とす。fullscreen
	// コンテナの padding-top(agenda-app.ts の #root.fullscreen-scroll)がこれを一元的に読むので、
	// 個々のビュー/遷移コード(月/日/一覧の切替・sheetState の各ページ等)は inset を一切意識しない
	// (スクロール top=0 = 安全先頭、という前提の上で書ける)。
	applySafeAreaVars(ctx?.safeAreaInsets);
	// fullscreen 中だけ #root を内部スクロールコンテナにする。inline に戻ったら外す(設計04 決定2)。
	root.classList.toggle("fullscreen-scroll", hostDisplayMode === "fullscreen");
	// 【inline 復帰時は list へ強制リセット(確定済み設計判断1)】inline は高さクランプ内で月グリッドが
	// 潰れるため list 一択。fullscreen で月ビューにしたまま inline へ縮んだら、agendaViewMode を list へ
	// 戻し、月ビューで差し替えていた currentRange を退避してあった listRange へ復元して取り直す
	// (selectedDayKey=今日・monthCursor=今月も戻す)。connect 直後(まだ list)は agendaViewMode!=="list"
	// が false なので no-op(初回描画の refetch を二重に走らせない)。
	if (hostDisplayMode !== "fullscreen" && agendaViewMode !== "list") {
		// day ビューから縮んだときは赤線タイマーも止める(!=="list" が day もカバー・main 裁定 item 5)。
		stopNowLineTimer();
		agendaViewMode = "list";
		const todayKey = localDateKey(new Date());
		monthCursor = yearMonthOf(todayKey);
		selectedDayKey = todayKey;
		currentRange = listRange; // 月/日レンジ → 退避してあった list レンジへ復元(null=既定へ委ねる)
		// refetch は非同期(refetchForRange が終わり次第 renderAll)。呼び出し元(hostcontextchanged)も
		// 直後に renderAll するので、まず list 骨格を出し、確定データが追いついたら差し替わる。
		void refetchForRange();
	}
}

// =============================================================================
// 契約の写経(ローカル interface。application 層は import しない)
// =============================================================================

/** structuredContent.events の要素。event-dto.ts の Event とフィールドを一致させること。 */
interface EventItem {
	id: string;
	recurrenceId: string | null;
	// 由来コレクション id(server の toWireEvent が全 event に付与)。色ドット(どのカレンダー由来か)に使う。
	// 2026-07-22 additive 写経: 旧 vm も calendarId を運んでいたが interface に写経していなかったので足す。
	calendarId?: string;
	title: string;
	// 終日 "YYYY-MM-DD" / 時刻付き offset ISO(例 "2026-07-16T19:00:00+09:00")。start は必須。
	start: string;
	// 同形式・排他的終端(DTEND)。無し=null。
	end: string | null;
	isAllDay: boolean;
	location: string | null;
	url: string | null;
	notes: string | null;
	status: string | null;
	recurrence: RecurrenceSummary | null;
	// 開始相対アラームの minutesBefore 列(0=開始時刻)。最大2件。通知無しは空配列。
	alarms: number[];
	// 移動時間(分)。未設定は null。
	travelMinutes: number | null;
	// C1(設計 05 §2)の派生3スロット(read)。structuredContent で自動的に届く(event-dto.ts が付与)。
	// ui は末端なので C1 の型は location-view.ts へ写経した View 型を使う(src/ 直接 import は禁止)。
	structuredLocation: StructuredLocationView | null;
	proximityAlarm: ProximityAlarmView | null;
	conference: ConferenceView | null;
}

/** 差分レンズ用の自己完結スナップショット(events-view-model.ts の EventSnapshot と同型)。
 *  affected[].event と removed の両方がこれを使う。start/end は表示用短文("YYYY-MM-DD" or
 *  "YYYY-MM-DD HH:MM")。 */
interface EventSnapshot {
	id: string;
	title: string;
	start?: string;
	end?: string;
	location?: string;
	isAllDay?: boolean;
	// sync(S2): このゴーストがシステム起因(外部削除)由来か。true なら中立ラベル「同期(削除)」。
	sync?: boolean;
}

/** affected の1要素(mutation 応答の差分メタ)。イベントに完了は無いので kind は added/edited のみ。 */
interface AffectedEntry {
	id: string;
	kind: string; // "added" | "edited"(既知分)
	event?: EventSnapshot;
	changes?: Array<{ field: string; before?: string; after?: string }>;
	// sync(S2): システム起因(外部変化)由来か。true なら行右端ラベルを中立の「同期(...)」にする。
	sync?: boolean;
}

/** 応答の structuredContent の形(冒頭コメントの契約を型に写経)。 */
interface EventsStructuredContent {
	events?: EventItem[];
	// 【2026-07-22 echo pin バグ修正】server.ts が全コレクション横断時に架空の "calendar" を
	// echo していたのをやめ、正直に null を返すようにした(単一指定時のみ string を返す)。
	// undefined(=キー自体が無い)と null(=明示的に「全横断」)を区別するため両方許容する。
	calendarId?: string | null;
	timeZone?: string;
	affected?: AffectedEntry[];
	removed?: EventSnapshot[];
	range?: { from: string; to: string };
	truncated?: boolean;
}

// =============================================================================
// UI 状態(単一の状態 → renderAll() で全描画、という素朴な一方向データフロー。todos と同じ)
// =============================================================================
// events = 表示用一覧(confirmedEvents に in-flight 楽観を重ね直したもの)。
// confirmedEvents = 直近のサーバー確定一覧(クリーン。差分レンズの prev/next・楽観の重ね土台)。
let events: EventItem[] | null = null;
let confirmedEvents: EventItem[] | null = null;
// pendingIds = mutate 送信中の行 id → 開始時刻(ms epoch)。2026-07-16 ドクトリン v2(§7.8)で
// Set → Map<id, startedAt> に変更(todos-entry.ts F-2 と同型・唯一必要な構造変更)。用途は3つ:
//   ①同じ行の連打を弾く二重送信ガード(旧 Set と同じ) ②差分レンズの degrade(pending 行は
//   システム差分マークの対象外) ③startedAt を isCommitting(now, startedAt) に渡し、
//   「いまこの行の committing アニメ(寿命1周)が有効か」を renderRow が毎描画判定する。
const pendingIds = new Map<string, number>();
// animUntil = 「committing アニメ(寿命1周)が満了する時刻」の id → epoch ms。2026-07-16 v2.1
// (Fable 裁可・親フィードバック): pendingIds は成功/失敗が確定した瞬間に delete されるため、
// tap から確定までが速い操作(実測 p50=287ms)だと committing アニメが 1.2s を完走せず
// 「点滅して終わる」チラつきになっていた。pendingIds(=二重送信ガード/差分レンズ degrade の
// 判定材料)と animUntil(=見た目アニメの寿命)を分離し、後者は startCommitting で一度セットしたら
// 満了 setTimeout でしか消さない(成功/失敗分岐は触らない)。これにより tap から常に固定 1.2s の
// アニメが完走する(「もう確定したのに演出が続く」体感は許容 — §7.8 の「1.2s は待たせすぎない
// 上限」という設計意図とは別軸で、こちらは「最低でも手応えを見せ切る」下限の保証)。
const animUntil = new Map<string, number>();

/**
 * mutate 開始時に pendingIds へ startedAt を積み、寿命(FEEDBACK.cycleMs×animCycles)満了時の
 * 再描画を1本 setTimeout で仕込む。todos-entry.ts の同名関数と設計は完全同型
 * (clearTimeout をしない Why not も同一。詳細は todos-entry.ts 参照)。
 * 【2026-07-16 v2.1】animUntil も同時にセットする(寿命分離。上のコメント参照)。
 * 【2026-07-16 撤回: T_hard(10s)警告バナーのタイマーを廃止した(item 1)】旧実装はここで
 * 2本目の setTimeout を仕込み 10s 超過で「保存に時間がかかっています」を出していたが、計器実測で
 * 10s 超過は claude.ai transport 起因(Worker 実処理は最大 4s)と判明し、楽観表示への待ち重畳は
 * 情報を運ばないため取り下げた(todos-entry.ts / feedback.ts の撤回コメントと同一判断)。
 */
function startCommitting(id: string): void {
	const startedAt = Date.now();
	pendingIds.set(id, startedAt);
	animUntil.set(id, startedAt + FEEDBACK.cycleMs * FEEDBACK.animCycles);
	// committing 満了(寿命1周)→ animUntil を消して再描画(pendingIds には触れない。成功/失敗の
	// 確定描画が別途 pendingIds を delete する)。renderRow の committing 判定は animUntil 基準
	// (下の isCommitting 呼び出しコメント参照)なので、ここで animUntil を消せば静的表現へ収束する。
	setTimeout(() => {
		if (animUntil.has(id)) {
			animUntil.delete(id);
			renderAll();
		}
	}, FEEDBACK.cycleMs * FEEDBACK.animCycles);
}

// editingIds = 悲観パス(§7.8 判定則②: 反復イベントの start/end/recurrence 変更)の in-flight 行 id。
// agenda 固有(todos には悲観パスが無い)なので feedback.ts の共有カーネルには置かずローカル state
// で持つ。saveEdit が積み、成功/失敗の両分岐で必ず対で delete する。
// 【v2.1 でユーザー FB により撤回(旧名 pessimisticIds・旧用途は「保存中…」静的タグの表示条件)】
// 旧設計(F-3)は満了後に li.pending-edit へ切り替え「保存中…」という待ち表示を静的に見せ続けて
// いたが、「要求されておらず楽観語彙に統合してほしい」というユーザー FB を受け、Fable 裁可で
// 待ち表示そのものを撤去した(docs/modeling/12 §7.8 v2.1)。この Set は用途を変えて存続する:
// 「反復の日時/recurrence 変更で optimisticEdits に日時を積めない(=affectedById 由来の
// becoming-edit タグが出ない)ケースでも、確定描画が来るまで becoming-edit タグ自体は出し続ける」
// ための id 追跡に転用した(renderRow の isEditingRecurring 分岐参照)。表示語彙は既存の楽観 edit
// と完全に同じ(「変更」等)にすることで、悲観/楽観の区別をユーザーに見せない設計へ変わった。
const editingIds = new Set<string>();

// --- 楽観更新の in-flight state(todos の機構を流用。完了系 kind は無い)-------------------
// optimisticRows: create-event 送信中の仮イベント(id は "optimistic:<乱数>")。
interface OptimisticRow {
	id: string;
	title: string;
	start: string; // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"(offset なし。表示・ソートはローカル解釈で足りる)
	end: string | null;
	isAllDay: boolean;
	location: string | null;
	url: string | null;
	notes: string | null;
	recurrence: RecurrenceSummary | null;
	alarms: number[];
	travelMinutes: number | null;
}
let optimisticRows: OptimisticRow[] = [];
// optimisticEdits: 詳細編集 / インライン選択の保存が in-flight の間の楽観的なフィールド上書き。
type OptimisticEdit = Partial<
	Pick<EventItem, "title" | "start" | "end" | "isAllDay" | "location" | "url" | "notes" | "recurrence" | "alarms" | "travelMinutes">
>;
const optimisticEdits = new Map<string, OptimisticEdit>();
// optimisticDeletes: delete-event 送信中の行 id(楽観削除。表示から即除去し、失敗でロールバック)。
const optimisticDeletes = new Set<string>();

/** 仮行 id 判定(differ から除外・操作禁止に使う)。 */
function isOptimisticId(id: string): boolean {
	return id.startsWith("optimistic:");
}
/** ドラフト行 id 判定(FAB で生やす未送信の新規行。トグルは無いが ⓘ で作成モード詳細を許すため別 prefix)。 */
function isDraftId(id: string): boolean {
	return id.startsWith("draft:");
}

// --- 選択 / ドラフト / スワイプ / シート状態(todos v3 と同一文法。再描画を跨いで保持)-------------
// 【2026-07-16 実機FB(§7.1)】selectedId / swipeId / sheetState.key が保持するのは
// **rowKey(合成キー)** であって生 id ではない。生 id だと反復イベントの展開 occurrence
// 全行(id は全部マスター UID)が同時に選択/スワイプ状態になってしまう。
// mutate 系の状態(pendingIds 等)はマスター id 単位のまま — 理由は row-key.ts 冒頭。
let selectedId: string | null = null;
// draft: FAB で生やす「まだ送信していない新規イベント行」。既定は「今日・終日」(モック A のドラフト規約)。
let draft: { id: string; title: string; notes: string } | null = null;
let swipeId: string | null = null;
// sheetState: 詳細ページ / リスト選択ページの「カード内ページ遷移」状態(list は event では move 未実装で省略)。
// key は rowKey — 詳細ページは「タップされたその occurrence 行」を対象にする(先頭 occurrence に
// すり替わると開始日時の表示・差分計算が別の日のものになる)。
let sheetState: { key: string; page: "detail"; create?: boolean } | null = null;
let sheetDraft: SheetDraft | null = null;
// 選択行のタイトル/メモ入力への参照(commitSelection が renderAll 前の DOM 値を読むため renderRow がセット)。
let selTitleInput: HTMLInputElement | null = null;
let selMemoInput: HTMLInputElement | null = null;

// --- 表示用 becoming メタ(rebuildDisplay が組み立て、renderRow/announceBecoming が読む)-------------
let affectedById = new Map<string, AffectedEntry>();
// seenAffectedIds: renderAll の1描画パス内で「この id の becoming 装飾はもう出した」を記録する
// (§7.1 系列集約)。renderAll 冒頭でリセットし、renderRow が最初の可視行でだけ装飾を許可する。
// 【Why not renderRow へ引数で渡す】renderRow はドラフト行描画など複数箇所から呼ばれ、既存
// シグネチャを崩さない方が差分が小さい。描画は単一スレッドの同期1パスなのでモジュール変数で安全。
const seenAffectedIds = new Set<string>();
let ghosts: EventSnapshot[] = [];
// サーバー(+sync)由来の becoming 土台(楽観だけの再描画で重ねる基準)。
let serverAffectedBase: AffectedEntry[] = [];
let serverGhostsBase: EventSnapshot[] = [];

// --- この一覧のコンテキスト(応答 echo を保持)---------------------------------------------
let currentCalendarId: string | null = null;
let currentTimeZone: string | null = null;
// currentRange: この一覧の期間(list-events-expanded/refresh-events が echo する range)。focus refetch /
// mutation 後の再取得へ引き継ぐ(引き継がないと再取得のたびに既定期間へ落ちて一覧が変わる)。null=未受領。
let currentRange: { from: string; to: string } | null = null;

// --- ビュー切替 + 月グリッド(2026-07-22 ロードマップ②・fullscreen 限定)-----------------------
// agendaViewMode: 一覧(list)/ 月グリッド(month)/ 日タイムライン(day・2026-07-22 ③)。
//   fullscreen のときだけ #root 先頭にセグメントを出して切り替える。inline は list 一択に強制する
//   (applyHostContext の inline 復帰リセット。確定済み設計判断1。!=="list" 条件が day もそのままカバーする)。
type AgendaViewMode = "list" | "month" | "day";
let agendaViewMode: AgendaViewMode = "list";
// nowLineTimer: 日ビューの現在時刻赤線を 60 秒ごとに再計算する setInterval のハンドル(null=停止中)。
// 【stopNowLineTimer に集約する Why(main 裁定 item 5)】赤線タイマーは day 以外のビューでは無駄なので、
// 全遷移経路(exitToListMode / enterMonthMode / applyHostContext の inline 復帰リセット / visibilitychange
// hidden)で必ず停止する。停止漏れを 1 箇所に閉じ込めるため start/stopNowLineTimer ヘルパー経由に統一する。
let nowLineTimer: number | null = null;
// monthCursor: 月ビューで表示中の年月(1-12)。既定は今月。月送り/今日で更新し、そのたびに
// currentRange を月グリッド 42 セル分へ差し替えて refetch する(確定済み設計判断2)。
let monthCursor: YearMonth = yearMonthOf(localDateKey(new Date()));
// selectedDayKey: 月グリッドで選択中の日("YYYY-MM-DD")。下段の「選択日の予定リスト」がこれに連動する。
// 既定は今日。セルタップで更新。inline 復帰で今日へリセット(確定済み設計判断1)。
let selectedDayKey: string = localDateKey(new Date());
// listRange: 月ビュー突入時に退避する list 用の currentRange(確定済み設計判断2 の「listRange 退避方式」)。
// 月ビュー中は currentRange を月レンジへ差し替えるため、list へ戻るときに元の期間を復元する。
// null = まだ list レンジを受領していない(初回応答前に月へ入った等)→ 復元時は素の既定へ委ねる。
let listRange: { from: string; to: string } | null = null;

// --- 表示カレンダーフィルタ(2026-07-22 collection-picker-v5)---------------------------------
// list-calendars の結果キャッシュ(VEVENT を含むコレクションだけをフィルタメニューに列挙)。
// todos-entry.ts の calendarsCache と同じ「メニューを開くまで遅延取得」方式。null=未取得。
let calendarsCache: Array<{ id: string; displayName: string; components: readonly string[] }> | null = null;
// visibleCalendarIds: 表示 ON のコレクション id 集合。
//   null = 「明示フィルタなし(全 ON・既定)」→ refreshArgs は calendarIds を送らない(=従来挙動)。
//   Set  = 「一部 OFF のフィルタ適用中」→ refreshArgs が calendarIds:[...] を送る(server が calendarIds
//          優先で横断合成)。全部 ON へ戻したときは null に正規化する(送信を省いて全横断=既定へ戻す)。
// 【なぜ null と空 Set を区別するか】空 Set = 「全部 OFF」(何も表示しない)で、null = 「フィルタ未適用」。
// 両者は意味が違うので混同しない(空 Set は calendarIds:[] を送る…と server は length===0 を未指定扱いに
// するため、全 OFF は送信側で「1件も出さない」= events を空表示にする専用処理をする。下記 refetchFiltered)。
let visibleCalendarIds: Set<string> | null = null;
// フィルタメニューが「カレンダーを追加」入力モードかどうか(1つだけなので boolean で足りる)。
let calAddMode = false;
// 全カレンダー OFF(visibleCalendarIds が空 Set)のとき、サーバーは呼ばず一覧を空表示にする。
// renderAll がこのフラグを見て「予定はありません」を出す(空 Set を calendarIds:[] で送ると server が
// 未指定=全横断と解釈してしまうため、送信自体を避ける。上の visibleCalendarIds コメント参照)。
let allCalendarsHidden = false;
// 予定行の左に色ドットを出すか。renderAll が「現在の events に2つ以上のコレクションが混在するか」で
// 決める(単一コレクションのみのビューでは色ドットはノイズなので出さない)。renderRow が読む。
let showCalendarDots = false;

// --- 自動 refetch のガード用状態(todos と同じ)-------------------------------------------
let connected = false;
let lastFetchAt = 0;
const STALE_TIME_MS = 2500;

// S1(docs/modeling/14 §6 項目5): カード発の削除に使う免除トークン(server が _meta.confirm.cardToken で配る)。
// null=未受領。deleteEvent がこれを confirmToken として delete-event に渡す(todos-entry.ts と対称)。
let cardConfirmToken: string | null = null;
/** ontoolresult の結果 _meta.confirm.cardToken を拾って cardConfirmToken を更新する。 */
function captureConfirmToken(r: unknown): void {
	const meta = (r as { _meta?: { confirm?: { cardToken?: unknown } } } | undefined)?._meta;
	const token = meta?.confirm?.cardToken;
	if (typeof token === "string" && token !== "") cardConfirmToken = token;
}

// --- SheetDraft(詳細ページの編集作業コピー)-----------------------------------------------
// 構造フィールドはここに持ち、テキスト(title/notes/location/url)は input イベントでここへ同期する
// (構造変化での再描画でテキスト入力値が失われないように。todos の SheetDraft と同じ発想)。
interface SheetDraft {
	title: string;
	notes: string;
	// 終日トグル(ON=date のみ・OFF=date+time。保存時に start/end の文字列形式へ写像)。
	isAllDay: boolean;
	startDate: string; // "YYYY-MM-DD"
	startTime: string; // "HH:MM"(isAllDay=false のとき有効)
	hasEnd: boolean; // 終了(DTEND)を持つか
	endDate: string;
	endTime: string;
	recurPreset: RecurPreset;
	weekdays: string[];
	recurEnd: "none" | "until" | "count";
	until: string | null;
	count: number | null;
	recurOpen: boolean;
	location: string | null; // null=場所トグル OFF
	url: string | null; // null=URL 無し(空文字は入力中の一過性状態)
	alarms: number[]; // 最大2件。alarms[0]=通知・alarms[1]=予備の通知
	alarmOpen: boolean;
	alarm1Open: boolean;
	travelMinutes: number | null;
	travelOpen: boolean;
	// --- C3(設計 05 §4): 作成モード専用フィールド(create:true のときだけ意味を持つ。編集モードでは
	// 初期化されるが未使用のまま放置される — 型を1つに保つため SheetDraft へ同居させた) ---
	// 予定/リマインダー セグメント(片方向: event→todo のみ切替可・設計 05 §4)。
	formKind: "event" | "todo";
	// C4(設計 05 §5): 「場所または会議」統合入力の確定値(vevent 作成時のみ)。
	locationValue: LocationPickerValue | null;
	// C4 セミモーダルの開閉状態。
	locationPickerOpen: boolean;
	// list-known-locations の結果キャッシュ。null=未取得(セミモーダルを開いたときに一度だけ fetch)。
	knownLocations: KnownLocationView[] | null;
	// list-known-locations が in-flight かどうか(knownLocations===null と分離: [] という「0件確定」と
	// 「まだ取得中」を区別するため)。
	knownLocationsLoading: boolean;
	// ビデオ通話チップ確定前の一時状態(タスク指示の暫定裁定: 全チップが URL 入力を要求するため、
	// 「その他URL」専用ではなく共通化した — CONFERENCE_PROVIDERS のどれを選んだかの一時保持)。
	conferenceProviderDraft: string | null;
	conferenceUrlDraft: string;
	// --- C3: vtodo(リマインダー)作成モードのフィールド(due は startDate/startTime/isAllDay を
	// 使い回す — create-todo の due と create-event の start は同じ2形態("YYYY-MM-DD" /
	// "YYYY-MM-DDTHH:MM:SS")なので、専用フィールドを増やさず既存の start* を「due」として再利用する) ---
	todoHasDue: boolean;
	// PRIORITY(iOS 準拠: 1=高 5=中 9=低)。null=なし。
	todoPriority: number | null;
}

// --- 診断/エラー表示(todos と同じ2分割: status=接続フェーズ / banner=操作失敗)------------------
function showStatus(msg: string): void {
	statusEl.hidden = false;
	statusEl.textContent = msg;
}
function clearStatus(): void {
	statusEl.hidden = true;
	statusEl.textContent = "";
}
/**
 * @param label ボタン文言。既定は失敗バナーの「再試行」(= mutate 再送)。§7.8 の T_hard 警告
 *   バナーだけは「再読み込み」(= fetchLatest 相当。中断もロールバックもしない設計なので
 *   「再試行」を出すと二重書き込みリスクを生む。startCommitting 参照)。
 */
function showBanner(msg: string, retry?: () => void, label = "再試行"): void {
	bannerEl.hidden = false;
	bannerEl.textContent = "";
	const span = document.createElement("span");
	span.textContent = msg;
	bannerEl.appendChild(span);
	if (retry) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = label;
		btn.addEventListener("click", () => {
			clearBanner();
			retry();
		});
		bannerEl.appendChild(btn);
	}
}
function clearBanner(): void {
	bannerEl.hidden = true;
	bannerEl.textContent = "";
}

/** 小ヘルパー: クラス付き要素。 */
function el(tag: string, className: string): HTMLElement {
	const e = document.createElement(tag);
	e.className = className;
	return e;
}

/** 外部リンク(会議「参加」・参照 URL)を App SDK 経由で開く共通ヘルパー(2026-07-18 監査#1)。
 *  出典: node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts の `App#openLink`
 *  (`openLink(params: McpUiOpenLinkRequest["params"]): Promise<{ isError?: boolean }>`。
 *  spec.types.d.ts の `McpUiOpenLinkRequest` は `{ method: "ui/open-link"; params: { url: string } }`)。
 *  `<a target="_blank">` の素朴タップは swift-mcp-app 等の navigation 遮断ホストで不発になるため、
 *  click を preventDefault してこちらを第一手段にする。isError/例外は握りつぶす — 呼び出し元は
 *  `<a href>` を残したままなので、ホストが対応していなくても長押しコピー/共有で degrade できる。 */
function openExternalLink(e: MouseEvent, url: string): void {
	e.preventDefault();
	app.openLink({ url }).catch(() => {
		// 意図的に無視: ホスト未対応・拒否時は <a href> の長押しコピーへ degrade する(上のコメント参照)。
	});
}

// =============================================================================
// イベントの日付/時刻整形(時刻列が行の錨・日付見出しセクション。モック A の言語)
// =============================================================================
// 【前提】start/end の契約: 終日は "YYYY-MM-DD"、時刻付きは「そのイベント自身のゾーンの offset
// ISO8601」。offset があるので new Date(start) で絶対時刻として正しくパースでき、壁時計(HH:MM)は
// 文字列の T 以降をそのまま切り出せる(wallTimePart)。todos の due 整形と同じ規約。
//
// 【「今日」の基準は閲覧者のローカル日付にする(todos formatDue と同じ判断)】
// セクション分けの「今日/明日」は見ている人の体感に合わせるべきなので閲覧デバイスのローカル日付を使い、
// 表示する時刻(HH:MM)はイベント自身のゾーンの壁時計をそのまま出す。

/** ソート用の絶対時刻キー。終日はローカル深夜(その日の先頭)、時刻付きは絶対時刻。 */
function startEpoch(ev: EventItem): number {
	if (!ev.start.includes("T")) {
		const [y, m, d] = ev.start.split("-").map(Number);
		return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime();
	}
	return new Date(ev.start).getTime();
}

/** 終日イベントの「表示上の最終日」("YYYY-MM-DD")。DTEND は排他的終端なので終日は end-1日。
 *  end 無し(null)や end<=start+1日 は単日 → null(跨ぎ表示なし)。 */
function allDayLastVisibleDay(ev: EventItem): string | null {
	if (!ev.isAllDay || ev.end === null) return null;
	const startKey = wallDatePart(ev.start);
	const endKey = wallDatePart(ev.end);
	// end は排他的なので、最終可視日 = end の1日前。dayDiff で単日(=start+1日)なら跨がない。
	if (dayDiff(endKey, startKey) <= 1) return null;
	// end の前日を "YYYY-MM-DD" で返す。
	const [y, m, d] = endKey.split("-").map(Number);
	const prev = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) - 1));
	return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}

/** 時刻付きイベントで開始日と終了日が異なる(日を跨ぐ)ときの終了日 "YYYY-MM-DD"。跨がなければ null。 */
function timedSpanEndDay(ev: EventItem): string | null {
	if (ev.isAllDay || ev.end === null) return null;
	const startKey = wallDatePart(ev.start);
	const endKey = wallDatePart(ev.end);
	return startKey !== endKey ? endKey : null;
}

/** 「〜M/D(曜)」形式の跨ぎ日ラベル(meta 右に出す)。跨がないイベントは null。 */
function spanLabel(ev: EventItem): string | null {
	const lastDay = ev.isAllDay ? allDayLastVisibleDay(ev) : timedSpanEndDay(ev);
	if (lastDay === null) return null;
	const [, m, d] = lastDay.split("-").map(Number);
	return `〜${m}/${d}(${weekdayOf(lastDay)})`;
}

/** 進行中(now)判定: 時刻付きで start<=now<end のイベントだけ true(now バーを出す)。
 *  終日・end 無しは進行中扱いしない(「いま」の1本の錨は時刻ベースが自然)。 */
function isInProgress(ev: EventItem): boolean {
	if (ev.isAllDay || !ev.start.includes("T") || ev.end === null || !ev.end.includes("T")) return false;
	const now = Date.now();
	return new Date(ev.start).getTime() <= now && now < new Date(ev.end).getTime();
}

/** 日付見出しの文言。今日/明日/それ以外は "M/D(曜)"。sub(補助の日付表記)も返す。 */
function sectionHeading(dayKey: string, todayKey: string): { label: string; sub: string } {
	const diff = dayDiff(dayKey, todayKey);
	const [, m, d] = dayKey.split("-").map(Number);
	const md = `${m}/${d}(${weekdayOf(dayKey)})`;
	if (diff === 0) return { label: "今日", sub: md };
	if (diff === 1) return { label: "明日", sub: md };
	return { label: md, sub: "" };
}

// =============================================================================
// 通知(VALARM)・移動時間(X-APPLE-TRAVEL-DURATION)の語彙 ⇄ 分の写像
// =============================================================================
// iOS のプリセット語彙(docs/modeling/12 §3 更新2)。0=開始時刻ちょうど。

/** 通知プリセット(minutesBefore → ラベル)。null = 通知なし。 */
const ALARM_PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
	{ minutes: 0, label: "開始時刻" },
	{ minutes: 5, label: "5分前" },
	{ minutes: 10, label: "10分前" },
	{ minutes: 15, label: "15分前" },
	{ minutes: 30, label: "30分前" },
	{ minutes: 60, label: "1時間前" },
	{ minutes: 120, label: "2時間前" },
	{ minutes: 1440, label: "1日前" },
	{ minutes: 2880, label: "2日前" },
	{ minutes: 10080, label: "1週間前" },
];

/** minutesBefore → 表示ラベル(語彙外は「N分前」で degrade)。 */
function alarmLabel(minutes: number | null): string {
	if (minutes === null) return "なし";
	const hit = ALARM_PRESETS.find((p) => p.minutes === minutes);
	return hit !== undefined ? hit.label : `${minutes}分前`;
}

/** 移動時間プリセット(分 → ラベル)。null = なし。 */
const TRAVEL_PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
	{ minutes: 5, label: "5分" },
	{ minutes: 15, label: "15分" },
	{ minutes: 30, label: "30分" },
	{ minutes: 60, label: "1時間" },
	{ minutes: 90, label: "1時間30分" },
	{ minutes: 120, label: "2時間" },
];

/** 移動時間の分 → 表示ラベル(語彙外は「N分」で degrade)。 */
function travelLabel(minutes: number | null): string {
	if (minutes === null) return "なし";
	const hit = TRAVEL_PRESETS.find((p) => p.minutes === minutes);
	return hit !== undefined ? hit.label : `${minutes}分`;
}

// =============================================================================
// 一覧描画(モック A/B: 日付見出しセクション・時刻列が行の錨・now バー・becoming ラベル)
// =============================================================================

/** becoming: edited のインライン差分計画(renderRow の meta 組み立てが使う)。
 *  インライン表示(旧 → 新)は before/after が揃った start/end だけ。複雑な値(location/url/notes/
 *  recurrence/alarms/travelMinutes)は「編集済み」バッジへ degrade(todos の planEdit と同じ方針)。 */
interface EditPlan {
	startChange: { before?: string; after?: string } | null;
	endChange: { before?: string; after?: string } | null;
	moreCount: number;
	tag: string;
}

function planEdit(aff: AffectedEntry): EditPlan {
	const changes = aff.changes ?? [];
	const hasValue = (c: { before?: string; after?: string }): boolean => c.before !== undefined || c.after !== undefined;
	const startChange = changes.find((c) => c.field === "start" && hasValue(c)) ?? null;
	const endChange = changes.find((c) => c.field === "end" && hasValue(c)) ?? null;
	const inlineCount = (startChange !== null ? 1 : 0) + (endChange !== null ? 1 : 0);
	const moreCount = changes.length - inlineCount;
	// ラベル: 日時変更(start/end インライン)/ 複数は「変更」/ インライン0件は「編集済み」へ degrade。
	const tag = inlineCount === 0 ? "編集済み" : "日時変更";
	return { startChange, endChange, moreCount, tag };
}

/** 差分メタ側の日時短文("YYYY-MM-DD" or "YYYY-MM-DD HH:MM")→ 表示用の短い日付ラベル。
 *  行本体の時刻列と役割が違う(差分は「いつ→いつ」を短く)ので M/D + 時刻(あれば)で出す。 */
function formatInstantMeta(short: string): string {
	const datePart = short.slice(0, 10);
	const [, m, d] = datePart.split("-").map(Number);
	const md = `${m}/${d}(${weekdayOf(datePart)})`;
	const time = short.length > 10 ? short.slice(11, 16) : "";
	return time === "" ? md : `${md} ${time}`;
}

/** 時刻列(行の錨)を作る。終日=「終日」1段 / 時刻付き=開始(上・本文色)+終了(下・muted)2段。 */
function renderTimeColumn(ev: EventItem): HTMLElement {
	const time = el("span", "time");
	if (ev.isAllDay || !ev.start.includes("T")) {
		const allday = el("span", "allday");
		allday.textContent = "終日";
		time.appendChild(allday);
		return time;
	}
	const st = el("span", "st");
	st.textContent = wallTimePart(ev.start);
	time.appendChild(st);
	if (ev.end !== null && ev.end.includes("T")) {
		time.appendChild(document.createElement("br"));
		const en = el("span", "en");
		en.textContent = wallTimePart(ev.end);
		time.appendChild(en);
	}
	return time;
}

/** 1行(li)を組み立てる(todos v3 の選択モデルを踏襲。行 = [時刻列][head][(選択時)ⓘ+確定])。 */
function renderRow(ev: EventItem, todayKey: string): HTMLLIElement {
	// 【C0-c: 削除ゴースト(破線プレースホルダ)は廃止(2026-07-17 ユーザー裁定)】旧実装はここで
	// ghosts 判定 → renderGhostRow(破線ボックス + 「削除」タグ)へ早期 return していたが、
	// 「削除したものは見せなくていい(点々は不要)」に従い、削除行は視覚に一切出さない(即消滅)。
	// ghosts 配列は announceBecoming の aria-live 通知(sync 由来の外部削除の音声版)には残すが、
	// DOM 行にはしない(renderGhostRow は廃止・renderAll の ghostItems 合流も撤去)。todos-entry.ts と同判断。
	const li = document.createElement("li");
	// 行の DOM 特定・選択・スワイプは合成キー(§7.1)。data-id ではなく data-key を持たせる
	// (グローバル click ハンドラの closest 判定も data-key で引く)。
	const key = rowKey(ev);
	li.dataset.key = key;
	const sel = selectedId === key;
	const isDraft = isDraftId(ev.id);
	const swiped = swipeId === key;
	if (sel) li.classList.add("selected");
	if (swiped) li.classList.add("swiping");
	// now バー: 進行中の1本だけ accent の左バー(色は増やさない。ドラフト/仮行は判定しない)。
	if (!isDraft && !isOptimisticId(ev.id) && isInProgress(ev)) li.classList.add("now");

	// becoming 装飾の決定(未知 kind は通常描画へ degrade)。
	// 【系列集約(§7.1・2026-07-16 実機FB)】affectedById はマスター id キーなので、反復イベントの
	// 展開 occurrence 全行にヒットする。全行にバッジ/ハイライトを付けると「別イベントが4件増えた」
	// ように見誤られたため、renderAll の1描画パス内で **最初の可視行にだけ** 装飾を付け、
	// 2行目以降の同 id occurrence は完全無装飾にする(親裁定: 薄い残響も付けない・最小)。
	// added も同じ機構に乗せる — 反復イベントの新規作成でも occurrence が複数行展開されるため。
	const affRaw = affectedById.get(ev.id);
	// 【系列集約は aff と悲観 in-flight で共通(§7.1)】seenAffectedIds は「この描画パスで当該
	// マスター id をもう装飾したか」を表す。aff も editingIds も **マスター id キー** なので、
	// どちらも展開 occurrence 全行にヒットする。集約しないと、反復の日時/recurrence 変更中に
	// becoming-edit タグが表示中の全 occurrence 行へ重複表示され、aff タグと同じ誤読(別イベントが
	// N 件変更中に見える)を招く。→ aff と同じ「最初の可視行にだけ」の集約に悲観 in-flight も乗せる。
	const alreadySeen = seenAffectedIds.has(ev.id);
	// 【2026-07-16 v2.1】この行がいま committing(寿命1周のアニメ最中)かを animUntil から判定する
	// (寿命分離。tap から常に固定 1.2s 完走させる理由は animUntil 宣言コメント参照)。
	const committing = (animUntil.get(ev.id) ?? 0) > Date.now();
	// 【2026-07-16 v2.1 再描画耐性】animUntil を寿命分離した副作用で、committing 中に他の理由で
	// renderAll が再実行される(例: sync ポーリング・別行の操作)と、CSS の `animation: ... 1` は
	// 要素が作り直されるたびに「アニメ0%から再スタート」してしまい、経過時間を無視して見た目が
	// 巻き戻る(=チカチカする)。負の animation-delay で「もうこれだけ経過している」ことを CSS に
	// 伝え、要素が作り直されても寿命内の正しい進捗位置から再生されるようにする(todos-entry.ts
	// と同型の対処)。
	const animElapsedMs = ((): number => {
		const endAt = animUntil.get(ev.id);
		if (endAt === undefined) return 0;
		const life = FEEDBACK.cycleMs * FEEDBACK.animCycles;
		const startedAt = endAt - life; // startCommitting が積んだ元の startedAt を逆算
		return Math.max(0, Date.now() - startedAt);
	})();
	// 【悲観パス(§7.8 判定則②: 反復イベントの start/end/recurrence 変更)。v2.1 でユーザー FB により
	// 「保存中…」の待ち表示を撤去(editingIds 宣言コメント参照)】saveEdit はこの場合 optimisticEdits
	// に積まない(=affectedById 由来の becoming-edit タグが出ない)構造なので、editingIds の有無を
	// 「becoming-edit タグを強制するか」の判定材料に転用する。aff 由来の表示と衝突しないよう、
	// in-flight 中は下の aff 展開自体を止める(確定描画が来て aff が実データを持つようになったら
	// そちらへ自然に収束する)。集約(先頭 occurrence のみ)は aff と共有。
	const isEditingRecurring = editingIds.has(ev.id) && !alreadySeen;
	// aff は「未集約 かつ 悲観 in-flight でない」ときだけ採る(悲観のときは下の isEditingRecurring
	// 分岐が装飾を担う)。悲観 in-flight か aff のどちらかで装飾したら seenAffectedIds に積み、
	// 2行目以降の同 id occurrence を無装飾にする。
	const aff = affRaw !== undefined && !alreadySeen && !isEditingRecurring ? affRaw : undefined;
	if (aff !== undefined || isEditingRecurring) seenAffectedIds.add(ev.id);
	let editPlan: EditPlan | null = null;
	// needsRowMainDelay/needsTagDelay: 上の animElapsedMs による animation-delay 補正を、実際に
	// アニメ対象になる DOM(rowMain=add の wake-sweep / tagEl=edit の opacity-pulse)へ後で当てる
	// ためのフラグ(rowMain/tagEl はこの時点でまだ生成されていない)。
	let needsRowMainDelay = false;
	let needsTagDelay = false;
	// 【2026-07-18 becoming テキストタグ全廃(todos 側の同日裁定を agenda へ波及・監査#3)】
	// 旧実装はここで tagText に "追加"/"変更"/sync 時「同期(...)」を積み、meta 右端の .tag span へ
	// 描いていた(isSync = aff.sync === true で出し分け)。todos-entry.ts で 2026-07-18 に「テキストの
	// 意味が薄い(行のシマー・opacity pulse 等の非テキスト演出で状態は十分伝わる)」との実機 FB を受け
	// 全廃した裁定と同型のため、agenda 側も同じ理由で追随する。tagText 自体(型・生成箇所)も削除し、
	// isSync 変数も出し分け先を失ったので併せて削除する。
	// 【何を残すか】(1) becoming-in/becoming-edit クラス・inflight シマー・committing の opacity pulse
	// (li の CSS 演出)はそのまま維持。(2) editPlan(開始/終了のインライン旧→新差分表示・「他N件」)は
	// タグとは別物(値そのものの提示でテキストラベルではない)なので維持。
	if (aff !== undefined) {
		if (aff.kind === "added") {
			li.classList.add("becoming-in");
			if (isOptimisticId(ev.id) && committing) {
				li.classList.add("inflight");
				needsRowMainDelay = true;
			}
		} else if (aff.kind === "edited") {
			li.classList.add("becoming-edit");
			editPlan = planEdit(aff);
			// opacity pulse ×1: becoming タグ自体を committing 中だけ脈動させる(手応え)。
			// 【2026-07-18 テキストタグ全廃に伴う死コード化】タグ要素(tagEl)自体を描かなくなったため、
			// この "committing" クラス付与と needsTagDelay は pulse の対象を持たない死コードになったが、
			// CSS 側(agenda-app.ts)と対称に残置する(消すのは事実として誤りのときだけ・経緯記録)。
			if (committing) {
				li.classList.add("committing");
				needsTagDelay = true;
			}
		}
	} else if (isEditingRecurring) {
		// 【v2.1 悲観パスの視覚表現】値をローカルに書けない(occurrence 展開はサーバーでしか
		// 成立しない技術事実は不変)ため実 diff は出せないが、「編集した」ことは見せる — 楽観 edit
		// と同じ becoming-edit クラスを強制表示し、confirm 描画で実 aff に自然収束させる(待ち表示を
		// 挟まない = §7.8 v2.1 のドクトリンそのもの)。テキストタグ("変更")は全廃済みなので付けない。
		li.classList.add("becoming-edit");
		if (committing) {
			li.classList.add("committing");
			needsTagDelay = true;
		}
	}

	const rowMain = el("div", "row-main");
	if (needsRowMainDelay) rowMain.style.animationDelay = `-${animElapsedMs}ms`;
	// 由来コレクションの色ドット(2026-07-22)。複数コレクション混在ビューのときだけ・calendarId が
	// 分かる行にだけ付ける(単一コレクションのみ/由来不明はノイズなので出さない)。時刻列(行の錨)の
	// 左に小さく置き、走査時に色でカレンダーを即読みできるようにする。
	if (showCalendarDots && ev.calendarId !== undefined) {
		const dot = el("span", "cal-dot");
		dot.style.background = colorForCalendarId(ev.calendarId);
		dot.setAttribute("aria-hidden", "true");
		rowMain.appendChild(dot);
	}
	rowMain.appendChild(renderTimeColumn(ev));

	// --- head(タイトル / meta)---------------------------------------------------------
	const head = el("div", "head");
	if (sel) {
		const ti = document.createElement("input");
		ti.className = "title-edit";
		ti.type = "text";
		ti.value = ev.title;
		ti.setAttribute("aria-label", "タイトル");
		if (isDraft) ti.placeholder = "新しい予定";
		ti.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (isDraft) commitDraftEnter();
				else {
					commitSelection();
					selectedId = null;
					renderAll();
				}
			}
		});
		head.appendChild(ti);
		selTitleInput = ti;
		// 「メモを追加」行(枠なし単一行 input)。
		const mi = document.createElement("input");
		mi.className = "memo-line";
		mi.type = "text";
		mi.value = ev.notes ?? "";
		mi.placeholder = "メモを追加";
		mi.setAttribute("aria-label", "メモ");
		mi.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (isDraft) commitDraftEnter();
				else {
					commitSelection();
					selectedId = null;
					renderAll();
				}
			}
		});
		head.appendChild(mi);
		selMemoInput = mi;
	} else {
		const title = el("div", "title");
		title.textContent = ev.title;
		if (ev.notes !== null && ev.notes.trim() !== "") {
			const noteMark = el("span", "note-mark");
			noteMark.appendChild(createIcon("text"));
			noteMark.setAttribute("aria-label", "メモあり");
			title.appendChild(noteMark);
		}
		head.appendChild(title);
		// 【S-D スライス①: 一覧でもメモを見たい(todos と対称)】非選択行でも本文冒頭1行を薄いテキストで
		// truncate 表示する(CSS .notes。todos-entry.ts の同箇所コメント参照 — note-mark アイコンは
		// 「メモがある」の目印として残しつつ、本文プレビューを併存させる判断は todos/agenda 共通)。
		if (ev.notes !== null && ev.notes.trim() !== "") {
			const notesPreview = el("div", "notes");
			notesPreview.textContent = ev.notes.trim();
			head.appendChild(notesPreview);
		}
		// 選択はタップされた occurrence 行だけ(合成キー)。id だと系列全行が同時選択になる(§7.1)。
		//
		// 【2026-07-18 実機 FB2: 行タップ = 詳細閲覧へ(vtodo のインライン編集モードと分岐)】
		// 旧実装は todos v3 の選択モデル(タップ→タイトル input 化のインライン編集)をそのまま踏襲していたが、
		// ユーザー FB「vtodo は一覧タップで編集に変わるが、vevent の一覧タップは詳細閲覧への遷移が Theory
		// (過去実装の vevent 詳細へのフル遷移は mcp-app としてとても綺麗)」を受け、**永続化済み(非ドラフト)
		// イベント行だけ** タップの意味を「選択してインライン編集」から「詳細ページ(buildDetailPage)へ
		// フル遷移」へ変える。iOS カレンダーも同じベスプラ(行タップ=詳細閲覧、編集は詳細内の「編集」)。
		// ドラフト行(FAB で生やした未送信の新規行)は既存どおり setSelected でインライン編集のままにする
		// — ドラフトはまだ id を持たず openSheet できない(isOptimisticId ガード)うえ、タイトルをその場で
		// 打ち込む「作成モード」の Theory はタップ=閲覧と別物(iOS リマインダー/カレンダーの新規行も
		// その場で打ち込む)。
		if (isDraft) {
			head.addEventListener("click", () => setSelected(key));
		} else {
			head.addEventListener("click", () => {
				// 他行(主にドラフト行)でインライン編集が進行中なら、詳細ページへ移る前に確定させる
				// (todos には無い遷移だが、agenda はここで selectedId を経由せず直接 sheetState へ飛ぶため、
				// commitSelection を挟まないと打ちかけのドラフト/編集が握り潰される)。
				commitSelection();
				selectedId = null;
				// 最新の display 行を引き直す(id ではなく合成キーで — §7.1。タップ直後に楽観更新等で
				// events が差し替わっていても、開いた occurrence 行がすり替わらないようにする)。
				const latest = events?.find((t) => rowKey(t) === key) ?? ev;
				openSheet(latest);
			});
		}
	}

	// --- meta 行: 繰り返し ⟳ / 🎥参加 / 📍場所 / 🔗参照 URL / 跨ぎ日〜M/D / becoming ラベル(右端)-------
	const meta = el("div", "meta");
	// 日時変更(edited)のインライン旧→新。start/end のどちらか。
	const appendDiff = (parent: HTMLElement, before: string, after: string): void => {
		const old = el("span", "old");
		old.textContent = before;
		const arrow = el("span", "arrow");
		arrow.textContent = "→";
		const next = el("span", "new");
		next.textContent = after;
		parent.appendChild(old);
		parent.appendChild(arrow);
		parent.appendChild(next);
	};
	if (editPlan?.startChange != null) {
		const s = el("span", "diff");
		appendDiff(
			s,
			editPlan.startChange.before !== undefined ? formatInstantMeta(editPlan.startChange.before) : "なし",
			editPlan.startChange.after !== undefined ? formatInstantMeta(editPlan.startChange.after) : "なし",
		);
		meta.appendChild(s);
	}
	if (editPlan?.endChange != null && editPlan.startChange == null) {
		const s = el("span", "diff");
		appendDiff(
			s,
			editPlan.endChange.before !== undefined ? formatInstantMeta(editPlan.endChange.before) : "なし",
			editPlan.endChange.after !== undefined ? formatInstantMeta(editPlan.endChange.after) : "なし",
		);
		meta.appendChild(s);
	}
	// 繰り返しバッジ(⟳ + 短い日本語。degrade 時はアイコンのみ)。editPlan(日時変更)中も描く:
	// 以前は「情報過多回避」で editPlan 中に消していたが、🔁 が消えると系列の occurrence 行が
	// 別イベントに見誤られる実害の方が大きい(2026-07-16 実機FB・§7.1)。
	if (ev.recurrence !== null) {
		const recurText = formatRecurrence(ev.recurrence);
		const recur = el("span", "recur");
		recur.appendChild(createIcon("repeat"));
		if (recurText !== "") recur.appendChild(document.createTextNode(` ${recurText}`));
		recur.setAttribute("aria-label", recurText === "" ? "繰り返し" : `繰り返し ${recurText}`);
		meta.appendChild(recur);
	}
	// 跨ぎ日ラベル(複数日イベント。〜M/D(曜))。
	const span = spanLabel(ev);
	if (span !== null && editPlan == null) {
		const sp = el("span", "span");
		sp.textContent = span;
		meta.appendChild(sp);
	}
	// --- C2(設計 05 §2): 📍場所 / 🎥参加 / 🔗参照 URL の一覧側描画 -------------------------------
	// 【出し分けの判断は純関数 location-view.ts に隔離】どのバッジを主要にするか(inline は1つ)・
	// 参照 URL を独立で出すか、の判断はテスト済み純関数に委ね、ここは DOM 組み立てだけを担う。
	// 【inline / fullscreen の情報量(指示 4)】inline(プレビュー)は「📍タイトル or 🎥参加 の主要1つ」に
	// 束ねる(agendaInlineBadge)。fullscreen は両方出してよいので、場所と会議を並べる。旧実装の
	// 「vid アイコン(URL の印)+ location 全文チップ」は、この3スロット統一形へ揃えて置き換えた
	// (壊すのではなく揃える — 指示 1「既存の location 表示を 📍 付きの統一形に整える」)。
	const isFull = hostDisplayMode === "fullscreen";
	const locTitle = resolveLocationTitle(ev.structuredLocation, ev.location);
	const inlineBadge = agendaInlineBadge(ev.conference, ev.structuredLocation, ev.location);
	// 会議「参加」チップを meta に足す(タップで conference.url を Join として開く)。
	// 【開き方(2026-07-18 監査#1 で修正)】旧実装は `<a target="_blank">` の素朴なタップ任せだった。
	// swift-mcp-app(第一接続先の iOS ホスト)は window.open/navigation をサンドボックスで封じるため、
	// 通常タップが不発になる(長押しコピーだけ効く状態)。App SDK の正規経路 `app.openLink({ url })`
	// (node_modules/@modelcontextprotocol/ext-apps の App#openLink・ui/open-link メソッド)を
	// 第一手段にする — click で preventDefault し openLink を呼ぶ。ホストが未対応/拒否(isError)でも
	// 例外を投げず握りつぶし、`<a href>` 自体は残すので長押しコピー/共有の degrade 経路は生きる。
	// head の click(行選択)へ伝播させないよう stopPropagation は維持する(タップ=参加であって選択ではない)。
	// 任意ドメイン(x.com 等)でも「参加」として出す(設計 05 §2・whitelist しない=判定は C1 が済ませている)。
	const appendJoinChip = (): void => {
		if (ev.conference === null) return;
		const a = document.createElement("a");
		a.className = "join-chip";
		a.href = ev.conference.url;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		a.appendChild(createIcon("video"));
		a.appendChild(document.createTextNode(" 参加"));
		a.setAttribute("aria-label", "会議に参加");
		a.addEventListener("click", (e) => {
			e.stopPropagation();
			openExternalLink(e, ev.conference!.url);
		});
		meta.appendChild(a);
	};
	// 📍場所チップ(タイトルのみ・truncate は CSS .meta .loc)。住所全文は出さない(詳細ページの責務)。
	const appendLocChip = (): void => {
		if (locTitle === null) return;
		const loc = el("span", "loc");
		loc.appendChild(createIcon("map-pin"));
		loc.appendChild(document.createTextNode(` ${locTitle}`));
		loc.setAttribute("aria-label", `場所 ${locTitle}`);
		meta.appendChild(loc);
	};
	if (isFull) {
		// fullscreen: 会議・場所の両方を出す(会議 → 場所の順で並べる)。
		appendJoinChip();
		appendLocChip();
	} else if (inlineBadge !== null) {
		// inline: 主要1つだけ(会議優先。会議が無い行は場所タイトル)。
		if (inlineBadge.kind === "conference") appendJoinChip();
		else appendLocChip();
	}
	// 🔗 参照 URL(会議に化けていない独立リンクのとき)。message: スキーム等も生値で渡す(開けるかはホスト判断)。
	// conference.source === "url" のときは URL が既に「参加」チップになっているので二重に出さない(判定は純関数)。
	if (showReferenceUrl(ev.url, ev.conference)) {
		const ref = document.createElement("a");
		ref.className = "ref-chip";
		ref.href = ev.url!; // showReferenceUrl が非 null を保証(型絞りは boolean を跨げないので ! を使う)
		ref.target = "_blank";
		ref.rel = "noopener noreferrer";
		ref.appendChild(createIcon("link"));
		ref.setAttribute("aria-label", "参照リンクを開く");
		// join-chip と同じ理由(監査#1)で openLink 経由に統一。
		ref.addEventListener("click", (e) => {
			e.stopPropagation();
			openExternalLink(e, ev.url!);
		});
		meta.appendChild(ref);
	}
	// 【2026-07-18 becoming マイクロラベル(旧 tagEl = meta 右端 or rowMain 直下の [.tag] span)を全廃・監査#3】
	// todos-entry.ts の同日裁定(「完了も追加もテキスト不要」)を波及させ、"追加"/"変更"/「同期(...)」の
	// テキストタグそのものを描かなくなった(tagText 変数ごと上の aff.kind 分岐で削除済み)。
	// 【旧コメント(2026-07-16 v2.1・C のレイアウト調整史・財産として残す)】旧実装は「meta に何かあれば
	// meta 右端・meta が空なら rowMain 直下」と配置が行の中身次第で揺れていたのを、todos 側の S-E と
	// 同型に「常に rowMain 直下」へ統一し、CSS 側(agenda-app.ts の `.row-main > .tag`)で
	// align-self:flex-start + margin-top の縦補正 + margin-left:auto を持たせていた。タグ自体が無くなった
	// 今はこの位置調整 CSS も死コード化している(削除はせず経緯記録として残置。CSS 側にも同旨コメントを
	// 添える)。needsTagDelay/animElapsedMs は committing クラスの opacity pulse resume 用フラグとして
	// 上の aff.kind 分岐でまだ使うため(pulse 自体は死コード化済み・そちらのコメント参照)宣言は残す。
	if (meta.childElementCount > 0 || sel) head.appendChild(meta);

	rowMain.appendChild(head);
	// 【2026-07-18】旧 `if (tagEl !== null) rowMain.appendChild(tagEl)` は tagEl 全廃に伴い削除。

	// --- trailing: 選択中の行だけ ⓘ(詳細)+ 確定ボタン(todos v3 と同一)---------------------------
	// 【2026-07-18 ⓘ の扱い(FB2 対応の判断メモ)】上の head クリック変更で、非ドラフト行は selectedId に
	// 一切乗らなくなった(sel=true になる経路は setSelected の唯一の呼び出し元がドラフト行に限定された
	// ため、実質「ドラフト行専用」に狭まった)。よってこの trailing ブロック自体が **非ドラフト行では
	// もう描画されない**(sel が常に false)。ⓘ ボタンの「非 draft 分岐」(下の commitSelection→openSheet)
	// は事実上到達不能になったが、削除はしない — (1) 到達不能であって「間違った実装」ではない
	// (今後 selectedId の使い道が増えて非ドラフト行が sel になる経路が復活しても安全に動く保険として
	// 機能は正しいまま残る)、(2) todos 側の同型コード(ⓘ=常時選択経路)との構造対称性を保つほうが
	// 差分レビューしやすい、という判断。ドラフト分岐(isDraft→openCreateSheet)は「作成モード詳細」への
	// 唯一の入口として現役のまま維持する(head タップでは開けない=タイトル未確定の draft はサーバー id を
	// 持たず openSheet の isOptimisticId ガードに弾かれるため)。
	if (sel) {
		const info = document.createElement("button");
		info.type = "button";
		info.className = "info";
		info.setAttribute("aria-label", `「${ev.title}」の詳細`);
		info.appendChild(createIcon("info"));
		info.addEventListener("click", (e) => {
			e.stopPropagation();
			if (isDraft) {
				if (selTitleInput !== null && draft !== null) draft.title = selTitleInput.value;
				if (selMemoInput !== null && draft !== null) draft.notes = selMemoInput.value;
				openCreateSheet();
				return;
			}
			commitSelection();
			selectedId = null;
			// 最新行の引き直しも合成キーで(id だと系列の「先頭 occurrence」にすり替わり、
			// 詳細ページの開始日時がタップした日と別の日になる — §7.1)。
			// 【上記メモのとおり2026-07-18時点でこの分岐には到達しない(sel は draft でしか true にならない)】
			const latest = events?.find((t) => rowKey(t) === key) ?? ev;
			openSheet(latest);
		});
		rowMain.appendChild(info);

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.className = "confirm";
		confirm.setAttribute("aria-label", "編集を確定");
		confirm.appendChild(createIcon("check"));
		confirm.addEventListener("click", (e) => {
			e.stopPropagation();
			commitSelection();
			draft = null;
			selectedId = null;
			renderAll();
		});
		rowMain.appendChild(confirm);
	}

	li.appendChild(rowMain);

	// --- スワイプ削除ボタン(露出中のみ)-------------------------------------------------------
	if (swiped) {
		const del = document.createElement("button");
		del.type = "button";
		del.className = "swipe-del";
		del.textContent = "削除";
		del.setAttribute("aria-label", `「${ev.title}」を削除`);
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			swipeId = null;
			void deleteEvent(ev);
		});
		li.appendChild(del);
	}
	if (!isOptimisticId(ev.id) && !isDraft) attachSwipe(li, ev);
	return li;
}

// 【C0-c: renderGhostRow(削除ゴースト行)は廃止(2026-07-17 ユーザー裁定)】
// 旧実装はここに renderGhostRow(ev) があり、removed 由来の擬似 EventItem を破線ボックス + 減光 +
// 「削除」/「同期(削除)」タグの becoming-gone 行として描いていた。ユーザー裁定「削除したものは
// 見せなくていい(点々は不要)」に従い削除行は視覚に一切出さないことにしたため廃止した(呼び出し元
// renderRow の早期 return と renderAll の ghostItems 合流も同時に撤去)。
//   - 自分削除(delete-event / 楽観削除): optimisticDeletes で即除去 → 破線を残さず即消滅。
//   - sync 由来の外部削除: nextEvents(events)から抜けて即消滅 + announceBecoming の aria-live 通知
//     (「同期で N 件更新されました」)で「黙って消えて混乱」を防ぐ(視覚常設ゴーストは出さない)。
// becoming-gone の CSS(agenda-app.ts)は退行時の再利用に備え残置(死んでも害は無い・経緯記録)。
// todos-entry.ts の renderGhostRow 廃止コメントと同判断。

// =============================================================================
// セクション分け(日付見出し)とソート
// =============================================================================

/** イベントを「開始日(wallDatePart)」でグルーピングし、日付昇順のセクション列にする。
 *  複数日イベントは開始日にだけ置く(サーバーは1 occurrence で返すため。跨ぎは meta の〜M/D で示す)。
 *  各セクション内は開始時刻昇順(終日はその日の先頭)。 */
function sectionizeByDay(items: EventItem[]): Array<{ dayKey: string; items: EventItem[] }> {
	const byDay = new Map<string, EventItem[]>();
	for (const ev of items) {
		const key = wallDatePart(ev.start);
		const bucket = byDay.get(key);
		if (bucket === undefined) byDay.set(key, [ev]);
		else bucket.push(ev);
	}
	const days = [...byDay.keys()].sort(); // "YYYY-MM-DD" は辞書順=日付順
	return days.map((dayKey) => {
		const dayItems = (byDay.get(dayKey) ?? []).slice();
		// 同日内: 終日を先頭(startEpoch がその日の深夜)→ 時刻付きは開始時刻昇順 → タイトル。
		dayItems.sort((a, b) => {
			const de = startEpoch(a) - startEpoch(b);
			if (de !== 0 && !Number.isNaN(de)) return de;
			return a.title.localeCompare(b.title, "ja");
		});
		return { dayKey, items: dayItems };
	});
}

// =============================================================================
// 描画(#root を作り直す唯一の関数。sheetState に応じて一覧/詳細ページを描く)
// =============================================================================

function renderAll(): void {
	// カード内ページ遷移(v3): sheetState が立っていれば詳細ページを #root に描く。
	// 【C3(設計05 §4): 作成モードは buildCreatePage へ完全に分離】旧実装は buildDetailPage を
	// create/edit 兼用で使っていたが、C3(セグメント切替・場所/会議セミモーダル)を編集モードにまで
	// 波及させると update-event 側の既存挙動を壊すリスクが大きいため、作成モードだけ新関数
	// buildCreatePage(d) に切り出した(currentSheetEvent は編集モードの行引き当てだけを担う形に戻す)。
	if (sheetState !== null && sheetDraft !== null) {
		if (sheetState.create === true) {
			root.innerHTML = "";
			selTitleInput = null;
			selMemoInput = null;
			root.appendChild(buildCreatePage(sheetDraft));
			return;
		}
		const sheetTask = currentSheetEvent();
		if (sheetTask !== null) {
			root.innerHTML = "";
			selTitleInput = null;
			selMemoInput = null;
			root.appendChild(buildDetailPage(sheetTask, sheetDraft));
			return;
		}
	}
	if (sheetState !== null) {
		// 対象行が消えた(削除・外部同期)/ draft 消失 → 一覧描画へ流す。
		sheetState = null;
		sheetDraft = null;
		quickAddFab.hidden = false;
	}

	if (events === null && draft === null) {
		renderSkeleton();
		return;
	}
	root.innerHTML = "";
	selTitleInput = null;
	selMemoInput = null;
	// 系列集約(§7.1)のパス内状態をリセット(この描画パスで最初に出会った可視行だけが装飾を得る)。
	seenAffectedIds.clear();
	// ビュー切替セグメント(リスト|月|日)は fullscreen のときだけ #root 先頭に出す(2026-07-22 ②)。
	// inline は高さクランプ内で月グリッドが潰れるため list 一択(applyHostContext が inline 復帰で
	// agendaViewMode を list へ強制リセットするので、ここは表示制御だけで足りる。確定済み設計判断1)。
	if (hostDisplayMode === "fullscreen") root.appendChild(buildViewSegment());
	// 月ビュー(fullscreen かつ month)。list の日セクション/畳み(applyInlineFold)とは別経路で
	// 描き切って早期 return する(月グリッド + 選択日リストは独立した描画単位)。
	if (hostDisplayMode === "fullscreen" && agendaViewMode === "month") {
		renderMonthView();
		return;
	}
	// 日ビュー(fullscreen かつ day・2026-07-22 ③)。終日チップ帯 + 時刻軸タイムラインを描き切って
	// 早期 return する(list の日セクション/畳みとも月グリッドとも別経路の独立描画単位)。
	if (hostDisplayMode === "fullscreen" && agendaViewMode === "day") {
		renderDayView();
		return;
	}
	// 全カレンダー OFF(フィルタで全部消した)のときは一覧を空扱いにする(サーバーは呼んでいない。
	// refetchFiltered が空 Set のとき allCalendarsHidden を立てる。上のコメント参照)。draft はそのまま。
	const baseEvents = allCalendarsHidden ? [] : (events ?? []);
	const todayKey = localDateKey(new Date());
	// 色ドットの出し分け(2026-07-22): 現在の events に2つ以上のコレクションが混在するときだけ出す
	// (単一コレクションのみのビューでは由来が自明なのでドットはノイズ)。renderRow がこの値を読む。
	{
		const cids = new Set<string>();
		for (const ev of baseEvents) if (ev.calendarId !== undefined) cids.add(ev.calendarId);
		showCalendarDots = cids.size > 1;
	}

	// 【C0-c: 削除ゴースト(ghostItems)の合流を廃止(2026-07-17 ユーザー裁定)】旧実装は ghosts
	// (removed 由来)を擬似 EventItem に変換し日セクションへ合流させ、renderRow が破線ボックスに
	// 描き替えていた。「削除したものは見せなくていい」に従い合流を撤去 — 削除行は視覚に出さない
	// (自分削除=optimisticDeletes で即除去済み・sync 削除=events から抜けて即消滅。announceBecoming の
	// aria-live 通知だけで外部削除を知らせる)。ghosts 配列は announce 用にだけ残す。
	// affected の added 合成(案X 相当)。added で events に見つからない id だけ snapshot から擬似行を作る
	// (通常 added は events に実在するので不要だが、mutate 応答が events を絞る場合の保険)。
	const eventIds = new Set(baseEvents.map((t) => t.id));
	const affectedItems: EventItem[] = [];
	for (const a of affectedById.values()) {
		if (a.kind === "added" && a.event !== undefined && !eventIds.has(a.id)) {
			affectedItems.push(snapshotToItem(a.event));
		}
	}

	const sections = sectionizeByDay(baseEvents.concat(affectedItems));
	const activeCount = sections.reduce((n, s) => n + s.items.length, 0);
	if (activeCount === 0 && draft === null) {
		const empty = el("div", "empty");
		empty.textContent = "予定はありません";
		root.appendChild(empty);
	}

	for (const { dayKey, items } of sections) {
		const heading = sectionHeading(dayKey, todayKey);
		const section = el("div", "section");
		section.appendChild(document.createTextNode(heading.label));
		if (heading.sub !== "") {
			const sub = el("span", "sub");
			sub.textContent = heading.sub;
			section.appendChild(sub);
		}
		root.appendChild(section);
		const ul = document.createElement("ul");
		for (const ev of items) ul.appendChild(renderRow(ev, todayKey));
		root.appendChild(ul);
	}

	// ドラフト行(FAB で生やした未送信の新規行)を末尾に選択状態で描く(sectionize に混ぜない)。
	if (draft !== null) {
		const section = el("div", "section");
		section.textContent = "新規";
		root.appendChild(section);
		const ul = document.createElement("ul");
		// draft-list: 畳み対象から除外するための目印(applyInlineFold の :not(.draft-list) が拾う)。
		// ドラフトは「いま入力中の新規行」なので畳んで隠すと編集が消えたように見える(必ず残す)。
		ul.className = "draft-list";
		ul.appendChild(renderRow(draftToItem(draft), todayKey));
		root.appendChild(ul);
	}

	// C2(P4-DM・2026-07-17): renderAll「最終段」の表示切りだけを行う畳み。ここより前の
	// セクショニング/楽観適用/becoming 装飾には一切触れない(畳みはフル描画済み DOM を実測して
	// 行を間引くだけの後処理。todos-entry.ts:2589 の applyInlineFold と同じ位置づけ)。
	// 【2026-07-18 ユーザー裁定: fold-anchor マーカーは廃止】旧実装はここに Comment ノードを置き、
	// applyInlineFold がその直後(=日セクション群の直後・ドラフト「新規」セクションの手前)へ
	// フッタを挿していた。⊕ を統合した action-row は「ドラフト行より下の flow 最終行」に出す必要が
	// ある(todos と同じ item3: ドラフト行はアクション行の上に出る)ため、マーカー位置への
	// insertBefore ではなく、ドラフトを含めた全ての appendChild が終わったこの時点で
	// applyInlineFold が root.appendChild するだけでよくなった(todos-entry.ts と同じ単純化)。
	applyInlineFold();
}

// =============================================================================
// ビュー切替セグメント + 月グリッド(2026-07-22 ロードマップ②・fullscreen 限定)
// =============================================================================
// モック docs/modeling/ui-mockups/agenda-views-v6.html の「セバスチャン式(上=月グリッド・
// 下=選択日リスト)」を移植。純粋な日付算術は format.ts(bun:test 済み)に隔離し、ここは DOM 組み立てと
// 状態遷移(monthCursor / selectedDayKey / currentRange 差し替え)だけを担う(How はここ・What はテスト)。

/** ビュー切替セグメント(リスト|月|日)。fullscreen の #root 先頭に置く。「日」は後続タスク③まで disabled。 */
function buildViewSegment(): HTMLElement {
	const seg = el("div", "view-seg");
	const mkBtn = (label: string, mode: AgendaViewMode): HTMLButtonElement => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = label;
		b.setAttribute("aria-pressed", String(agendaViewMode === mode));
		b.addEventListener("click", (e) => {
			e.stopPropagation(); // document click(選択解除)へ巻き込まない
			if (agendaViewMode === mode) return; // 同一モードの再タップは no-op(無駄な refetch を避ける)
			if (mode === "month") enterMonthMode();
			else if (mode === "day") enterDayMode();
			else exitToListMode();
		});
		return b;
	};
	seg.appendChild(mkBtn("リスト", "list"));
	seg.appendChild(mkBtn("月", "month"));
	// 「日」(day タイムライン・2026-07-22 ③)。②では disabled だった枠を有効化した(mkBtn で配線)。
	seg.appendChild(mkBtn("日", "day"));
	return seg;
}

/** 表示中の events を「開始日(wallDatePart)」でグルーピングする(月グリッドのドット / 選択日リスト用)。
 *  複数日イベントは開始日にだけ置く(list の sectionizeByDay と同じ規約)。 */
function groupEventsByDay(items: EventItem[]): Map<string, EventItem[]> {
	const byDay = new Map<string, EventItem[]>();
	for (const ev of items) {
		const key = wallDatePart(ev.start);
		const bucket = byDay.get(key);
		if (bucket === undefined) byDay.set(key, [ev]);
		else bucket.push(ev);
	}
	return byDay;
}

/** 予定ドットの色 = 由来コレクション色(calendar-colors.ts)。由来不明(calendarId 無し)は accent へ degrade。 */
function eventDotColor(ev: EventItem): string {
	return ev.calendarId !== undefined ? colorForCalendarId(ev.calendarId) : "var(--accent)";
}

/** 月ビュー本体を #root に描く(月ナビ + 曜日ヘッダ + 42 セルグリッド + 選択日リスト)。
 *  events は list と同じサーバー確定一覧をそのまま使う(表示フィルタ visibleCalendarIds は
 *  月ビューでも同じ集合 — サーバー側の絞り込み応答をそのまま groupBy する。仕様どおり)。 */
function renderMonthView(): void {
	// 全カレンダー OFF のときは list と同様に空扱い(サーバーは呼んでいない・renderAll の baseEvents と同型)。
	const baseEvents = allCalendarsHidden ? [] : (events ?? []);
	const todayKey = localDateKey(new Date());
	const byDay = groupEventsByDay(baseEvents);

	// --- 月ナビ(年月見出し + 今日 / 前月 / 次月)---
	const nav = el("div", "mv-nav");
	const ym = el("span", "mv-ym");
	ym.textContent = `${monthCursor.year}年${monthCursor.month}月`;
	nav.appendChild(ym);
	const navBtns = el("div", "mv-nav-btns");
	const todayBtn = document.createElement("button");
	todayBtn.type = "button";
	todayBtn.className = "mv-today-btn";
	todayBtn.textContent = "今日";
	todayBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		// 今日 = 今月へ戻し、選択日も今日へ(月送りとは違い選択日まで戻すのがモックの挙動)。
		selectedDayKey = todayKey;
		setMonthCursor(yearMonthOf(todayKey));
	});
	const prevBtn = document.createElement("button");
	prevBtn.type = "button";
	prevBtn.setAttribute("aria-label", "前の月");
	prevBtn.appendChild(createIcon("chevron-left"));
	prevBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		setMonthCursor(addMonths(monthCursor, -1));
	});
	const nextBtn = document.createElement("button");
	nextBtn.type = "button";
	nextBtn.setAttribute("aria-label", "次の月");
	nextBtn.appendChild(createIcon("chevron-right"));
	nextBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		setMonthCursor(addMonths(monthCursor, 1));
	});
	navBtns.append(todayBtn, prevBtn, nextBtn);
	nav.appendChild(navBtns);
	root.appendChild(nav);

	// --- 曜日ヘッダ(日曜始まり。日曜は danger 色)---
	const dow = el("div", "mv-dow");
	WEEKDAYS.forEach((w, i) => {
		const span = document.createElement("span");
		if (i === 0) span.className = "mv-sun";
		span.textContent = w;
		dow.appendChild(span);
	});
	root.appendChild(dow);

	// --- 42 セルグリッド ---
	const grid = el("div", "mv-grid");
	const cursorPrefix = `${monthCursor.year}-${String(monthCursor.month).padStart(2, "0")}`; // "YYYY-MM"
	for (const dayKey of monthGridDays(monthCursor)) {
		const cell = document.createElement("button");
		cell.type = "button";
		const classes = ["mv-cell"];
		if (dayKey.slice(0, 7) !== cursorPrefix) classes.push("out"); // 前後月にはみ出したセル
		if (weekdayIndexOf(dayKey) === 0) classes.push("sun");
		if (dayKey === todayKey) classes.push("today");
		if (dayKey === selectedDayKey) classes.push("selected");
		cell.className = classes.join(" ");
		cell.dataset.k = dayKey;
		const num = el("span", "mv-num");
		num.textContent = String(Number(dayKey.slice(8, 10))); // 日(前ゼロを外す)
		cell.appendChild(num);
		// 予定ドット(コレクション色)。最大3個(それ以上はノイズ・「ある」ことが伝わればよい・モック準拠)。
		const dots = el("span", "mv-evdots");
		for (const ev of (byDay.get(dayKey) ?? []).slice(0, 3)) {
			const i = document.createElement("i");
			i.style.background = eventDotColor(ev);
			dots.appendChild(i);
		}
		cell.appendChild(dots);
		cell.addEventListener("click", (e) => {
			e.stopPropagation();
			selectedDayKey = dayKey; // 選択日を切り替え → 下段リストが連動(再描画)。月送りはしない。
			renderAll();
		});
		grid.appendChild(cell);
	}
	root.appendChild(grid);

	// --- 選択日の予定リスト(下段連動)---
	root.appendChild(buildDayPanel(byDay));
}

/** 選択日(selectedDayKey)の予定リスト(下段)。開始時刻昇順・終日は先頭。空は「予定はありません」。 */
function buildDayPanel(byDay: Map<string, EventItem[]>): HTMLElement {
	const panel = el("div", "mv-day-panel");
	const head = el("div", "mv-day-head");
	const [, m, d] = selectedDayKey.split("-").map(Number);
	head.textContent = `${m}月${d}日(${weekdayOf(selectedDayKey)})`;
	panel.appendChild(head);
	// startEpoch(list と共有)で開始時刻昇順に整列(終日はその日の深夜=先頭)。
	const evs = (byDay.get(selectedDayKey) ?? []).slice().sort((a, b) => {
		const de = startEpoch(a) - startEpoch(b);
		if (de !== 0 && !Number.isNaN(de)) return de;
		return a.title.localeCompare(b.title, "ja");
	});
	if (evs.length === 0) {
		const empty = el("p", "mv-empty");
		empty.textContent = "予定はありません";
		panel.appendChild(empty);
		return panel;
	}
	// 【2026-07-23 カード UI 原則 (b) 是正③(modeling/15 §B-1・タスク #35)】月ビュー下段の選択日
	// リストは、旧実装だと選択日の予定件数に比例して無制限に伸びていた(fullscreen 内の「単一の
	// 内部スクロールコンテナ」原則には反しないが、月グリッド自体を画面外へ押し出す=見出しの
	// カレンダー面が実質スクロールで消える体験になっていた)。inline プレビュー(fold.ts)と同じ
	// 「N 件 + 他 n件フッタ」の要約表示に倣って有界化し、全件は既存の日ビュー導線(enterDayMode)へ
	// 委ねる — 「新規発明を最小に」の指示どおり、新しい遷移や UI 部品は増やさない。
	const { visible, remaining } = boundPreviewList(evs); // 既定 INLINE_PREVIEW_MAX 件(fold.ts 参照)
	const ul = document.createElement("ul");
	ul.className = "mv-rows";
	for (const ev of visible) {
		const li = document.createElement("li");
		const dot = el("span", "mv-dot");
		dot.style.background = eventDotColor(ev);
		const t = el("span", "mv-t");
		t.textContent = ev.isAllDay || !ev.start.includes("T") ? "終日" : wallTimePart(ev.start);
		li.append(dot, t, document.createTextNode(ev.title));
		ul.appendChild(li);
	}
	panel.appendChild(ul);
	if (remaining > 0) {
		// 「他 n件」フッタ(buildActionRow の .fold-more と同じ語彙・クラス名は流用しない — こちらは
		// 一覧の inline 畳みではなく月ビュー下段専用のため .mv-more という別クラスにする。タップ先が
		// fullscreen 昇格(buildActionRow)ではなく enterDayMode(同じ fullscreen 内でのビュー遷移)な
		// ので、押せる/押せないの死にボタン判定[canRequestFullscreen]は不要 — 月ビューはそもそも
		// fullscreen 限定機能で、常にタップ可能)。
		const more = document.createElement("button");
		more.type = "button";
		more.className = "mv-more";
		more.appendChild(document.createTextNode("他 "));
		const count = el("span", "mv-more-count");
		count.textContent = `${remaining}件`;
		more.appendChild(count);
		more.setAttribute("aria-label", `他 ${remaining}件の予定。日ビューで全件を見る`);
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			enterDayMode(); // 全件は日ビュー(既存の日タイムライン導線)に委ねる。新規 UI を増やさない。
		});
		panel.appendChild(more);
	}
	return panel;
}

// =============================================================================
// 日タイムライン(2026-07-22 ロードマップ③・fullscreen 限定)
// =============================================================================
// モック docs/modeling/ui-mockups/agenda-views-v7.html を移植。重なり列分割の純関数(layoutOverlaps)は
// day-timeline.ts(bun:test 済み)に隔離し、ここは「イベント → 日内分レンジへの写像」+ DOM 組み立て
// (絶対配置・時刻目盛・赤線)だけを担う(How はここ・What はテスト)。

/** 時刻軸の 1 時間あたりの高さ(px)。分 → px は min/60*HOUR_PX。CSS(--dv-hour)と同値に保つ
 *  (二重管理だが、DOM 側は絶対配置で px を直接使うため定数で持つ。値を変えたら CSS も揃える)。 */
const DV_HOUR_PX = 48;

/** "HH:MM" → 日内分(0-1440)。壊れた入力は 0(防御。呼び出し側は wallTimePart 由来で常に整形済み)。 */
function hhmmToMin(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

/** 選択日に「時刻付きで」交差するイベントを日内分レンジ(TimedBlock)へ写す。多日跨ぎは端を day-clamp
 *  相当に寄せる(前日から継続=0 分開始 / 翌日へ継続=1440 分終了)。layoutOverlaps 側でも clamp するが、
 *  ここで先に日境界へ寄せておくことで「別日の壁時計 HH:MM」が誤って混ざらないようにする。
 *  戻り値は {block, ev} の対 — layoutOverlaps は key しか返さないので、描画で ev(色/タイトル)へ引き戻す。 */
function dayTimedBlocks(evs: EventItem[], dayKey: string): Array<{ block: TimedBlock; ev: EventItem }> {
	const out: Array<{ block: TimedBlock; ev: EventItem }> = [];
	for (const ev of evs) {
		if (ev.isAllDay || !ev.start.includes("T")) continue; // 終日は別帯(dayAllDayEvents)
		const startDay = wallDatePart(ev.start);
		const endDay = ev.end !== null && ev.end.includes("T") ? wallDatePart(ev.end) : startDay;
		// この日に時刻帯として交差するか("YYYY-MM-DD" は辞書順=日付順で比較できる)。
		if (startDay > dayKey || endDay < dayKey) continue;
		// 前日から継続なら 0 分開始、当日開始なら壁時計 HH:MM。
		const startMin = startDay < dayKey ? 0 : hhmmToMin(wallTimePart(ev.start));
		// end 無しは 0 分(start と同値 → layoutOverlaps が最小幅 clamp)。翌日へ継続は 1440 分終了。
		let endMin: number;
		if (ev.end === null || !ev.end.includes("T")) {
			endMin = startMin;
		} else if (endDay > dayKey) {
			endMin = DAY_MIN;
		} else {
			endMin = hhmmToMin(wallTimePart(ev.end));
		}
		// 前日から継続してこの日の 00:00 ちょうどで終わる予定は当日に属さない(endMin=0 の見かけ上の点を作らない)。
		if (startDay < dayKey && endMin === 0) continue;
		out.push({ block: { key: rowKey(ev), startMin, endMin }, ev });
	}
	return out;
}

/** 選択日に「終日で」交差するイベント(終日チップ帯用)。終日の DTEND は排他終端なので
 *  [start, end) に dayKey が入るかで判定(end 無しは単日)。allDayLastVisibleDay と同じ規約。 */
function dayAllDayEvents(evs: EventItem[], dayKey: string): EventItem[] {
	return evs.filter((ev) => {
		if (!ev.isAllDay && ev.start.includes("T")) return false;
		const startDay = wallDatePart(ev.start);
		// 排他終端(DTEND の日)。終日 end 無し・時刻無しは単日 → 翌日を排他終端にする。
		const endExcl = ev.end !== null && ev.isAllDay ? wallDatePart(ev.end) : addDaysToDateKey(startDay, 1);
		return startDay <= dayKey && dayKey < endExcl;
	});
}

/** 日ビュー本体を #root に描く(日ナビ + 終日チップ帯 + 時刻軸タイムライン + 赤線)。
 *  events は list/month と同じサーバー確定一覧をそのまま使う(表示フィルタは同じ集合)。 */
function renderDayView(): void {
	const baseEvents = allCalendarsHidden ? [] : (events ?? []);

	// --- 日ナビ(日見出し + 今日 / 前日 / 翌日)。月ナビ(.mv-nav)と同じ視覚言語を .dv- で再現 ---
	const nav = el("div", "dv-nav");
	const head = el("span", "dv-dh");
	const [, m, d] = selectedDayKey.split("-").map(Number);
	head.textContent = `${m}月${d}日(${weekdayOf(selectedDayKey)})`;
	nav.appendChild(head);
	const navBtns = el("div", "dv-nav-btns");
	const todayBtn = document.createElement("button");
	todayBtn.type = "button";
	todayBtn.className = "dv-today-btn";
	todayBtn.textContent = "今日";
	todayBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		dayGoToday();
	});
	const prevBtn = document.createElement("button");
	prevBtn.type = "button";
	prevBtn.setAttribute("aria-label", "前の日");
	prevBtn.appendChild(createIcon("chevron-left"));
	prevBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		shiftDay(-1);
	});
	const nextBtn = document.createElement("button");
	nextBtn.type = "button";
	nextBtn.setAttribute("aria-label", "次の日");
	nextBtn.appendChild(createIcon("chevron-right"));
	nextBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		shiftDay(1);
	});
	navBtns.append(todayBtn, prevBtn, nextBtn);
	nav.appendChild(navBtns);
	root.appendChild(nav);

	// --- 終日イベントのチップ帯(色ドット + タイトル・横並び折返し)---
	const allDay = dayAllDayEvents(baseEvents, selectedDayKey);
	if (allDay.length > 0) {
		const band = el("div", "dv-allday");
		for (const ev of allDay) {
			const chip = el("span", "dv-chip");
			const dot = document.createElement("i");
			dot.style.background = eventDotColor(ev);
			chip.appendChild(dot);
			chip.appendChild(document.createTextNode(ev.title));
			band.appendChild(chip);
		}
		root.appendChild(band);
	}

	// --- 時刻軸タイムライン(0-23 時目盛 + 予定ブロック + 赤線)---
	const timeline = el("div", "dv-timeline");
	timeline.style.height = `${24 * DV_HOUR_PX}px`;
	// 時刻ラベル + 横罫(0-23 時)。position:absolute で top を積む(高さ一定 = 目盛が毎回同位置)。
	for (let h = 0; h < 24; h++) {
		const label = el("span", "dv-hour-label");
		label.style.top = `${h * DV_HOUR_PX}px`;
		label.textContent = `${h}:00`;
		timeline.appendChild(label);
		const line = el("div", "dv-hour-line");
		line.style.top = `${h * DV_HOUR_PX}px`;
		timeline.appendChild(line);
	}
	// 予定ブロック領域(左ガターの右)。layoutOverlaps の結果を left%/width%/top/height へ写す。
	const blocksArea = el("div", "dv-blocks");
	const pairs = dayTimedBlocks(baseEvents, selectedDayKey);
	const evByKey = new Map<string, EventItem>();
	for (const p of pairs) evByKey.set(p.block.key, p.ev);
	const laid: LaidOutBlock[] = layoutOverlaps(pairs.map((p) => p.block));
	for (const b of laid) {
		const ev = evByKey.get(b.key);
		if (ev === undefined) continue; // 論理的に起こらない(key は pairs 由来)
		const block = el("div", "dv-block");
		block.style.top = `${(b.startMin / 60) * DV_HOUR_PX}px`;
		block.style.height = `${((b.endMin - b.startMin) / 60) * DV_HOUR_PX}px`;
		// 等幅列分割: 左 = col/colCount・幅 = 1/colCount(1px の隙間で隣ブロックと分ける)。
		block.style.left = `calc(${(b.col / b.colCount) * 100}% + 1px)`;
		block.style.width = `calc(${100 / b.colCount}% - 2px)`;
		block.style.background = eventDotColor(ev);
		const title = el("div", "dv-bt");
		title.textContent = ev.title;
		block.appendChild(title);
		// 開始時刻(小さく)。行の錨は時刻軸そのものだが、ブロック内にも開始を出すと走査が速い(iOS 準拠)。
		const sub = el("div", "dv-bs");
		sub.textContent = wallTimePart(ev.start) === "" ? "" : wallTimePart(ev.start);
		block.appendChild(sub);
		blocksArea.appendChild(block);
	}
	timeline.appendChild(blocksArea);

	// --- 現在時刻の赤線 + 左端ドット(今日のみ・nowLineTopMin が null なら出さない)---
	// 【transition を付けない Why(main 裁定 item 5)】これは位置更新でありアニメではない。60 秒ごとに
	// 別位置へ跳ぶのが正しい(補間アニメを入れると「線がぬるっと動く」誤った表現になる)。
	const topMin = nowLineTopMin(new Date(), selectedDayKey);
	if (topMin !== null) {
		const nowLine = el("div", "dv-nowline");
		nowLine.style.top = `${(topMin / 60) * DV_HOUR_PX}px`;
		nowLine.setAttribute("aria-hidden", "true");
		timeline.appendChild(nowLine);
	}
	root.appendChild(timeline);
}

// =============================================================================
// ビュー遷移 + レンジ差し替え(確定済み設計判断2「listRange 退避方式」)
// =============================================================================
// 月ビュー突入時に list 用の currentRange を listRange へ退避し、currentRange を月グリッド 42 セル分の
// 絶対 timeMin/timeMax へ差し替えて refetch する。月送り/今日で monthCursor 更新 → 同様に差し替えて
// 再 refetch。list 復帰時に listRange を復元して refetch(必要なら)。
// 【不変条件(確定済み設計判断4)】refreshArgs() を呼ぶ全経路(fetchLatest / ingestStructuredContent /
// maybeRefetch)は currentRange を読む。月ビュー中は currentRange が月レンジなので、これらは自然に
// 月レンジで照会する(echo pin 修正 56cbb73 の「range を名乗る応答だけ currentCalendarId を採る」不変も
// applyStructuredContent 側でそのまま維持される — 本変更は currentRange の中身を変えるだけ)。

/** 月ビューへ入る。list レンジを退避し、選択日を含む月の月レンジへ差し替えて refetch する。
 *  【初期カーソル = 選択日を含む月・選択日は保持(2026-07-22 論点1 裁定)】day で 8/15 を見ていて
 *  「月」に切り替えたら 8 月が出るのが自然(iOS 準拠・selectedDayKey は月/日ビュー共有)。selectedDayKey は
 *  inline 復帰時に今日へリセットされる既存仕様(applyHostContext)があるため、list からの月ビュー突入は
 *  従来どおり「今月・今日」になり、既定の予測可能性は壊れない(list 中は selectedDayKey=今日のまま)。
 *  【ボツ: 常に今月・今日へリセット(旧実装)】どのビューから来ても monthCursor=今月/selectedDayKey=今日へ
 *  寄せていたが、day→month で見ていた月が飛ぶ違和感(8 月を見ていたのに 7 月へ戻る)を招くため裁定で撤回。 */
function enterMonthMode(): void {
	// day ビューから月へ来たときは赤線タイマーを止める(main 裁定 item 5: 全遷移経路で必ず停止)。
	stopNowLineTimer();
	// listRange の退避は list からの遷移時のみ(main 裁定 item 2)。month↔day 間の遷移で
	// 月/日レンジを listRange に上書きすると、list 復帰時に list 用でないレンジを復元してしまう。
	if (agendaViewMode === "list") listRange = currentRange;
	agendaViewMode = "month";
	// selectedDayKey は保持(day/month 共有)。monthCursor はその選択日を含む月へ寄せる(上のコメント参照)。
	monthCursor = yearMonthOf(selectedDayKey);
	currentRange = monthGridRange(monthCursor); // 月グリッド 42 セル分の絶対レンジへ差し替え
	renderAll(); // まず現データで月グリッドを見せる(refetch は非同期で追いつく = 体感の空白を作らない)
	void refetchForRange();
}

/** 日ビューへ入る(2026-07-22 ③)。表示日 selectedDayKey は月ビューと共有する(main 裁定 item 2)—
 *  月から入れば月グリッドで選んだ日、list から入れば既定(今日)を引き継ぐ(ここでは touch しない)。
 *  currentRange はその 1 日分へ差し替え(月境界跨ぎの空欄バグ回避 = 月レンジのまま日を描くと選択日が
 *  月レンジ端の隣月だったとき refetch 済みデータに漏れが出る)。赤線タイマーを起動する。 */
function enterDayMode(): void {
	// listRange の退避は list からの遷移時のみ(main 裁定 item 2)。month→day では上書きしない。
	if (agendaViewMode === "list") listRange = currentRange;
	agendaViewMode = "day";
	currentRange = dayRange(selectedDayKey); // 選択日 1 日分の絶対レンジ(localMidnightIso 〜 翌日深夜)
	startNowLineTimer(); // 60 秒ごとに赤線を再計算(今日以外は nowLineTopMin が null で線が出ないだけ)
	renderAll(); // まず現データで描く(refetch は非同期で追いつく)
	void refetchForRange();
}

/** list ビューへ戻る。退避してあった list レンジを復元して refetch する(null なら server 既定へ委ねる)。 */
function exitToListMode(): void {
	// month/day いずれから戻っても赤線タイマーを止める(main 裁定 item 5)。
	stopNowLineTimer();
	agendaViewMode = "list";
	currentRange = listRange; // 退避レンジを復元(null=未受領なら refreshArgs が range を省いて既定へ)
	renderAll();
	void refetchForRange();
}

/** "YYYY-MM-DD" 1 日分の絶対レンジ(from=その日の深夜・to=翌日の深夜。排他終端で当日を丸ごと含める)。
 *  月ビューの monthGridRange と同じ localMidnightIso 整形を使う(server の timeMin/timeMax は offset ISO)。 */
function dayRange(dayKey: string): { from: string; to: string } {
	return { from: localMidnightIso(dayKey), to: localMidnightIso(addDaysToDateKey(dayKey, 1)) };
}

/** 日送り(±1 日)。selectedDayKey を進め、currentRange を新しい日の 1 日分へ差し替えて refetch する。
 *  赤線タイマーは張り直す(今日 → 隣日で線の要否が変わるが、startNowLineTimer は冪等なので安全)。 */
function shiftDay(delta: number): void {
	selectedDayKey = addDaysToDateKey(selectedDayKey, delta);
	currentRange = dayRange(selectedDayKey);
	startNowLineTimer();
	renderAll();
	void refetchForRange();
}

/** 「今日」ボタン: 表示日を今日へ戻して 1 日レンジを取り直す(月ビューの todayBtn と同じ挙動)。 */
function dayGoToday(): void {
	selectedDayKey = localDateKey(new Date());
	currentRange = dayRange(selectedDayKey);
	startNowLineTimer();
	renderAll();
	void refetchForRange();
}

/** 赤線更新タイマーを(張り直して)起動する。既存タイマーは stopNowLineTimer で必ず一度止めるので冪等。
 *  【60 秒間隔の Why】赤線は「分」精度で足りる(秒まで動かしても知覚差はほぼ無い)。setInterval の
 *  コールバックは day ビューのときだけ renderAll する(他ビューに切り替わった直後の 1 発を無害化)。 */
function startNowLineTimer(): void {
	stopNowLineTimer();
	// setInterval の戻り値はブラウザでは number(Node 型定義混入で unknown 経由の cast)。
	nowLineTimer = setInterval(() => {
		if (agendaViewMode === "day") renderAll();
	}, 60_000) as unknown as number;
}

/** 赤線更新タイマーを停止する(全遷移経路の停止漏れをここ 1 箇所に閉じ込める・main 裁定 item 5)。 */
function stopNowLineTimer(): void {
	if (nowLineTimer !== null) {
		clearInterval(nowLineTimer);
		nowLineTimer = null;
	}
}

/** 月カーソルを差し替えて(月送り/今日)、月レンジを再計算し refetch する。 */
function setMonthCursor(next: YearMonth): void {
	monthCursor = next;
	currentRange = monthGridRange(next);
	renderAll();
	void refetchForRange();
}

/** currentRange 差し替え後の一覧取り直し(月ビュー / list 復帰の共通経路)。refetchFiltered と同型の
 *  degrade(失敗はバナー + 再試行)。全カレンダー OFF のときはサーバーを呼ばず現状のまま(空表示)。 */
async function refetchForRange(): Promise<void> {
	// 全 OFF(空 Set)はサーバーを呼ばない(refetchFiltered と同じ理由 — calendarIds:[] を全横断と誤解されるため)。
	// この場合 events は空のまま月グリッドもドット無しで描かれる(renderMonthView の baseEvents=[] 経路)。
	if (allCalendarsHidden) {
		renderAll();
		return;
	}
	clearBanner();
	try {
		await fetchLatest();
		renderAll();
	} catch (e) {
		showBanner(`表示範囲の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void refetchForRange());
	}
}

// アクション行(.action-row = 旧フッタ要約行 .fold-more + ⊕ 追加ボタン)の実高さ(margin 込み)の
// キャッシュ。CSS 定数(agenda-app.ts の .action-row/.fold-more)の二重管理を避けるため実測値を
// そのまま budget 先引きに使う。ページ内で一度測れば以降は不変。
// 【2026-07-17 C0-b で probe 対象を「すべて表示」ボタン(.fold-expand)→ フッタ要約行(.fold-more)へ
//  置換】→【2026-07-18 ユーザー裁定で「フッタ + 浮遊 FAB」→「フッタ+⊕ を1行に統合した action-row」へ
//  再置換】(todos-entry.ts と同じ経緯・cachedFooterBlockPx → cachedActionRowBlockPx)。
let cachedActionRowBlockPx: number | null = null;

/** アクション行(.action-row)の高さ(上下 margin 込み・px)を実測する(todos-entry.ts の
 *  measureActionRowBlockPx 移植)。
 *  【2026-07-18 ユーザー裁定: 浮遊 FAB 廃止 → + をフッタ行へ統合(fold 会計の簡素化)】
 *  旧実装は「フッタ要約行(.fold-more)」と「浮遊 FAB(.fab-row)」が別々の flow 要素で、budget の
 *  先引き(bottomChrome)も両者の合計・fullHeight にも FAB 分を別途加算していた(旧
 *  measureFabBlockPx。inline の浮遊 FAB を CSS で隠したため不要になった=削除。経緯は
 *  todos-entry.ts の同名コメント参照)。+ は「他 n件の予定」フッタと同じ行(.action-row)の右端に
 *  統合したため、action-row は inline では常に flow 最終行として1つだけ存在する(畳みが無いときも
 *  左が空なだけで行自体は出る。applyInlineFold・buildActionRow 参照)。そのため bottomChrome は
 *  「action-row 1つ分の高さ」に単純化され、fullHeight 側の加算も同じ値でよくなった(action-row は
 *  畳んでも畳まなくても常に flow に実在するため)。
 *  【なぜ probe を1回描いて測るか】button 版/div 版とも同じ .fold-more クラスを含む1つの probe で
 *  両分岐を代表できる(action-row 自体の高さは ⊕(44px 固定)の min-height が支配的なので、左の
 *  フッタ有無やテキスト長では変わらない設計 — agenda-app.ts の .action-row CSS 参照)。
 *  【なぜ visibility:hidden か】display:none は offsetHeight が 0 で測れない。visibility:hidden は
 *  レイアウトに参加する(一瞬 layout に載るが即 remove するのでちらつきは無い)。 */
function measureActionRowBlockPx(): number {
	if (cachedActionRowBlockPx !== null) return cachedActionRowBlockPx;
	const probe = document.createElement("div");
	probe.className = "action-row";
	probe.style.visibility = "hidden";
	const footerProbe = document.createElement("button");
	footerProbe.type = "button";
	footerProbe.className = "fold-more";
	footerProbe.textContent = "他 00件の予定";
	probe.appendChild(footerProbe);
	const addProbe = document.createElement("button");
	addProbe.type = "button";
	addProbe.className = "action-add";
	probe.appendChild(addProbe);
	root.appendChild(probe);
	const cs = getComputedStyle(probe);
	const marginPx = (Number.parseFloat(cs.marginTop) || 0) + (Number.parseFloat(cs.marginBottom) || 0);
	cachedActionRowBlockPx = probe.offsetHeight + marginPx;
	probe.remove();
	return cachedActionRowBlockPx;
}

/** アクション行(フッタ「他 n 件の予定」+ ⊕)を組み立てる(todos-entry.ts の buildActionRow 移植)。
 *  remaining が null なら畳みが無い(左は空・⊕ だけの行)。⊕ のクリックは agenda の追加フロー
 *  (triggerCreateEvent。旧 quickAddFab ハンドラを抽出した共通関数)をそのまま呼ぶ。 */
function buildActionRow(remaining: number | null): HTMLElement {
	const row = document.createElement("div");
	row.className = "action-row";
	if (remaining !== null) {
		const canFull = canRequestFullscreen(hostAvailableDisplayModes);
		// フッタ要約行「他 n 件の予定」(> 2026-07-17 実機 FB1 で「— 全画面で表示」の CTA を削除・簡素化。
		// todos-entry.ts と同判断)。タップ= fullscreen 昇格の挙動はそのまま。canFull なら button.fold-more を
		// リンク色(accent)にしてタップ可能を色で示す(既存の「accent 色=押せるテキスト」視覚言語に合わせる)。
		// 非広告ホストは受動 div(タップ不可・muted 色)= 死にリンクを作らない。
		const footer = document.createElement(canFull ? "button" : "div");
		footer.className = "fold-more";
		footer.appendChild(document.createTextNode("他 "));
		const count = el("span", "fold-more-count");
		count.textContent = `${remaining}件の予定`;
		footer.appendChild(count);
		if (canFull) {
			(footer as HTMLButtonElement).type = "button";
			footer.addEventListener("click", () => {
				// requestDisplayMode の戻り値は実際に設定されたモード(apps.mdx:787 MUST)。ホストが昇格を拒否したら
				// "inline" が返るだけでエラーではない — 何もしない。通信失敗等はカードを壊さないよう握りつぶす。
				void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
			});
		}
		row.appendChild(footer);
	}
	// ⊕(旧 #quick-add-fab の役割を継承)。inline では常に出す — folded 有無に関わらず主要な
	// 追加導線を隠さない。
	const addBtn = document.createElement("button");
	addBtn.type = "button";
	addBtn.className = "action-add";
	addBtn.setAttribute("aria-label", "予定を追加");
	addBtn.appendChild(createIcon("plus"));
	addBtn.addEventListener("click", (e) => {
		e.stopPropagation(); // 旧 quickAddFab ハンドラと同じ理由(document click の選択解除に巻き込まない)。
		triggerCreateEvent();
	});
	row.appendChild(addBtn);
	return row;
}

/**
 * C0-b 本体(P4-DM・2026-07-17 inline プレビュー化。旧 C2 動的畳みを改訂・todos-entry.ts の applyInlineFold と同型):
 * inline = 直近 N_MAX occurrence のプレビュー / fullscreen = 全件(設計05 §4・モック inline-preview.html)。
 * 表示件数を **min(INLINE_PREVIEW_MAX, computeInlineFit のフィット件数)** にクランプし、隠れた行があれば
 * flow 最終行のアクション行(.action-row)左に「他 n 件の予定」を出す。タップ=右上 ⤢ と同じ
 * requestDisplayMode fullscreen。**⊕(追加)はアクション行の右に統合し、folded でも常に表示**
 * (2026-07-18 ユーザー裁定: 浮遊 FAB 廃止・詳細は measureActionRowBlockPx コメント)。
 * 旧「すべて表示」ボタン + 受動「残り n 件」は ⤢ と役割重複のため廃止。
 *
 * 【computeInlineFit は捨てない = 安全クランプ】N_MAX 件でも端末の maxHeight 次第では溢れるので、その物理
 * フィットの逆算に computeInlineFit を再利用し min で合成する(fold.ts 冒頭コメント)。maxHeight 未送信は
 * Infinity を渡す(full=全行フィット)ので、その場合のクランプは純粋に N_MAX が効く。
 * 【bottomChrome = アクション行1つ分(2026-07-18 単純化)】旧「フッタ + FAB」の合計だった bottomChrome は
 * action-row 1つの高さに単純化された(measureActionRowBlockPx コメント参照)。full 判定の fullHeight 側にも
 * 同じ値を加算する(action-row は folded/full どちらでも常に flow 最終行として実在するため)。
 */
function applyInlineFold(): void {
	// fullscreen 中はプレビュークランプしない(全件 + 内部スクロールは applyHostContext の fullscreen-scroll が担う)。
	// inline 以外(displayMode 未送信のホスト等)は早期 return = 従来どおり全件表示(退行ゼロ)。アクション行自体も
	// 出さない(2026-07-18 ユーザー裁定: fullscreen では浮遊 FAB を復活させ、アクション行は畳みが無い
	// fullscreen では冗長=出さない)。
	// 【2026-07-17 C0-b: hostMaxHeightPx===null の早期 return を撤去】新モデルでは inline は maxHeight の
	// 有無に関わらず「上位 N 件プレビュー」に束ねる(N_MAX クランプは端末制約でなくプロダクト方針)。
	// maxHeight が null のときは computeInlineFit へ Infinity を渡す(full=全行フィット扱い)。
	if (hostDisplayMode !== "inline") return;

	// 畳み対象の occurrence 行。agenda は日セクション(div.section)と ul が root 直下のフラットな兄弟で
	// 並ぶので、通常行の ul(=draft-list 以外)配下の li を文書順に集める。ドラフト行(draft-list)は除外。
	const rows = Array.from(root.querySelectorAll<HTMLLIElement>("ul:not(.draft-list) > li"));
	const rowBottoms = rows.map((li) => li.offsetTop + li.offsetHeight);
	// 2026-07-18 単純化: 旧「フッタ + 浮遊 FAB」の合計だった bottomChrome/fullHeight 先引きは、両者が
	// 1つの action-row(常に flow 最終行として実在)へ統合されたことで「action-row 1つ分」に単純化された。
	const actionRowBlock = measureActionRowBlockPx();
	const fullHeight = root.scrollHeight + actionRowBlock;
	const bottomChrome = actionRowBlock;

	// フィット件数: maxHeight 未送信は Infinity(=全行フィット)。full なら全行、folded なら visibleCount。
	const fit = computeInlineFit(rowBottoms, fullHeight, hostMaxHeightPx ?? Number.POSITIVE_INFINITY, bottomChrome);
	const fitCount = fit.mode === "full" ? rows.length : fit.visibleCount;
	// プレビュークランプ: プロダクト方針(高々 N_MAX 件)と端末制約(それでも溢れるなら更に減らす)の min。
	const visibleCount = Math.min(INLINE_PREVIEW_MAX, fitCount);
	const folded = visibleCount < rows.length;

	if (folded) {
		rows.slice(visibleCount).forEach((li) => li.remove());
		// 空になった(=全行畳まれた)日セクションは見出しだけ宙ぶらりんにならないよう、ul と直前の
		// .section 見出しをペアで除去する(agenda は section と ul がネストせず兄弟に並ぶため、
		// ul の直前の要素兄弟がその日の見出しになる。todos は section が ul を内包するので section 単位で
		// 消していたが、agenda はフラット構造なのでペアで消す — 構造差に由来する唯一の非対称)。
		for (const ul of Array.from(root.querySelectorAll<HTMLElement>("ul:not(.draft-list)"))) {
			if (ul.children.length > 0) continue;
			const prev = ul.previousElementSibling;
			if (prev !== null && prev.classList.contains("section")) prev.remove();
			ul.remove();
		}
	}

	const totalCount = rows.length; // 畳み対象の合計 occurrence 行数(ドラフトは対象外)
	const remaining = totalCount - visibleCount; // = 「他 n 件」の n(folded でなければ使わない)
	// 【2026-07-18 ユーザー裁定: アクション行は常設(畳みの有無に関わらず inline では必ず出す)】
	// 旧実装は畳んだときだけフッタを append していたが、⊕ を統合した今は「畳みが無いときは左が
	// 空の行」として常に出す(root の flow 最終行に置くことで浮遊 FAB を廃止できる)。
	root.appendChild(buildActionRow(folded ? remaining : null));
}

/** 読込中スケルトン(行の影3本。todos と同じ体感安定策)。 */
function renderSkeleton(): void {
	root.innerHTML = "";
	for (const width of ["70%", "55%", "62%"]) {
		const row = el("div", "skel");
		const circle = el("div", "skel-circle");
		row.appendChild(circle);
		const line = el("div", "skel-line");
		line.style.width = width;
		row.appendChild(line);
		root.appendChild(row);
	}
}

/** ヘッダの「最終更新 HH:mm」を今にする(成功データ受領時のみ)。lastFetchAt も同時更新(staleTime 基準)。 */
function markUpdated(): void {
	lastFetchAt = Date.now();
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	updatedEl.textContent = `最終更新 ${hh}:${mm}`;
}

/** range echo をヘッダの期間表示("M/D〜M/D")に反映する。 */
function renderRangeLabel(): void {
	if (currentRange === null) {
		rangeEl.textContent = "";
		return;
	}
	const fmt = (iso: string): string => {
		const dateKey = iso.slice(0, 10);
		const [, m, d] = dateKey.split("-").map(Number);
		return `${m}/${d}`;
	};
	rangeEl.textContent = `${fmt(currentRange.from)}〜${fmt(currentRange.to)}`;
}

// =============================================================================
// 選択 / ドラフト / スワイプ(todos v3 と同一文法)
// =============================================================================

/** 変更フィールドだけを update-event へ渡す集合(部分更新)。 */
interface UpdateEventChanges {
	title?: string;
	notes?: string;
	// start は "YYYY-MM-DD"(終日) / "YYYY-MM-DDTHH:MM:SS"(時刻付き)。開始は除去できない。
	start?: string;
	// end は三値(undefined=変更なし / null=除去 / string=設定)。
	end?: string | null;
	location?: string | null;
	url?: string | null;
	recurrence?: RecurArgs;
	// alarms は三値(undefined=変更なし / null=全除去 / number[]=全置換)。
	alarms?: number[] | null;
	travelMinutes?: number | null;
}

/** setSelected: 行を選択(前の選択があれば確定 auto-save してから切替)。key は rowKey(§7.1)。 */
function setSelected(key: string): void {
	if (selectedId === key) return;
	commitSelection();
	draft = null;
	selectedId = key;
	closeSwipe();
	renderAll();
	if (selTitleInput !== null) {
		selTitleInput.focus();
		const v = selTitleInput.value;
		selTitleInput.setSelectionRange(v.length, v.length);
	}
}

/** commitSelection: 選択解除=確定(auto-save)。renderAll 前の DOM 値を読み、変更があれば楽観送信する。
 *  戻り値: ドラフト行の確定で create-event を発火した(=新規行が生まれた)ときだけ true。 */
function commitSelection(): boolean {
	const inputTitle = selTitleInput;
	const inputMemo = selMemoInput;
	selTitleInput = null;
	selMemoInput = null;
	if (selectedId === null) return false;
	// ドラフト行(未送信の新規行)の確定 = create-event(タイトル非空のときだけ)。
	// selectedId は rowKey なので、ドラフト(recurrenceId 無し)も rowKey({id}) で突き合わせる。
	if (draft !== null && selectedId === rowKey({ id: draft.id })) {
		const title = (inputTitle !== null ? inputTitle.value : draft.title).trim();
		const notes = inputMemo !== null ? inputMemo.value : draft.notes;
		if (title === "") return false;
		// 高速パス: 既定は「今日・終日」(モック A のドラフト規約)。詳細は作成モード詳細ページで付ける。
		enqueueCreate(title, defaultCreateDetails(notes.trim()));
		return true;
	}
	// 選択行の引き当ても rowKey(id だと系列の先頭 occurrence へすり替わる — §7.1)。
	const ev = events?.find((t) => rowKey(t) === selectedId);
	if (ev === undefined) return false;
	const changes: UpdateEventChanges = {};
	if (inputTitle !== null) {
		const nt = inputTitle.value.trim();
		if (nt !== "" && nt !== ev.title) changes.title = nt;
	}
	if (inputMemo !== null) {
		const nn = inputMemo.value;
		if (nn !== (ev.notes ?? "")) changes.notes = nn;
	}
	if (Object.keys(changes).length > 0) void saveEdit(ev, changes);
	return false;
}

/** FAB / Enter 継続で「末尾に空のドラフト行を選択状態で生やす」。 */
function startDraft(): void {
	draft = { id: `draft:${Math.random().toString(36).slice(2)}`, title: "", notes: "" };
	selectedId = rowKey({ id: draft.id }); // selectedId は常に rowKey(§7.1)

	closeSwipe();
	renderAll();
	if (selTitleInput !== null) selTitleInput.focus();
}

/** ドラフト行での Enter = 「確定 → 次の空ドラフト行」(iOS の Enter で次の行)。 */
function commitDraftEnter(): void {
	const created = commitSelection();
	if (created) {
		draft = null;
		startDraft();
	} else {
		draft = null;
		selectedId = null;
		renderAll();
	}
}

/** closeSwipe: スワイプ露出を畳む(state のみ)。 */
function closeSwipe(): void {
	if (swipeId !== null) swipeId = null;
}

/** 左スワイプ(touch)/ 右クリック・長押し(contextmenu)で削除ボタンを露出するジェスチャ配線。 */
function attachSwipe(li: HTMLElement, ev: EventItem): void {
	let startX = 0;
	let startY = 0;
	let tracking = false;
	li.addEventListener(
		"touchstart",
		(e) => {
			const t = e.touches[0];
			if (t === undefined) return;
			startX = t.clientX;
			startY = t.clientY;
			tracking = true;
		},
		{ passive: true },
	);
	li.addEventListener(
		"touchmove",
		(e) => {
			if (!tracking) return;
			const t = e.touches[0];
			if (t === undefined) return;
			const dx = t.clientX - startX;
			const dy = t.clientY - startY;
			if (Math.abs(dy) > Math.abs(dx)) {
				tracking = false;
				return;
			}
			// スワイプ露出も合成キー単位(id だと系列全行の削除ボタンが一斉に開く — §7.1)。
			if (dx < -40 && swipeId !== rowKey(ev)) {
				swipeId = rowKey(ev);
				tracking = false;
				renderAll();
			} else if (dx > 40 && swipeId === rowKey(ev)) {
				swipeId = null;
				tracking = false;
				renderAll();
			}
		},
		{ passive: true },
	);
	li.addEventListener("touchend", () => {
		tracking = false;
	});
	li.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		swipeId = swipeId === rowKey(ev) ? null : rowKey(ev);
		renderAll();
	});
}

// =============================================================================
// 擬似 EventItem 変換(ghost/仮行/ドラフト → 描画用)
// =============================================================================

/** snapshot(表示用短文 start/end)→ 描画用擬似 EventItem。 */
function snapshotToItem(snap: EventSnapshot): EventItem {
	const start = snap.start === undefined ? localDateKey(new Date()) : snap.start.replace(" ", "T");
	const end = snap.end === undefined ? null : snap.end.replace(" ", "T");
	return {
		id: snap.id,
		recurrenceId: null,
		title: snap.title,
		start,
		end,
		isAllDay: snap.isAllDay ?? !start.includes("T"),
		location: snap.location ?? null,
		url: null,
		notes: null,
		status: null,
		recurrence: null,
		alarms: [],
		travelMinutes: null,
		// C1 派生3スロット: snapshot(差分レンズ用の最小情報)は場所/会議を持たない。null で足りる
		// (擬似行は becoming 表示用で、派生バッジは confirmedEvents 側の実行が担う)。
		structuredLocation: null,
		proximityAlarm: null,
		conference: null,
	};
}

/** 仮イベント(create 楽観行)→ 描画用 EventItem。 */
function optimisticRowToItem(row: OptimisticRow): EventItem {
	return {
		id: row.id,
		recurrenceId: null,
		title: row.title,
		start: row.start,
		end: row.end,
		isAllDay: row.isAllDay,
		location: row.location,
		url: row.url,
		notes: row.notes,
		status: null,
		recurrence: row.recurrence,
		alarms: row.alarms,
		travelMinutes: row.travelMinutes,
		// C1 派生3スロット: 楽観 create 行は派生前(サーバー確定で埋まる)。in-flight 中は null で
		// バッジを出さず、確定 vm の EventItem に置き換わった時点で 📍/🎥/🔗 が生える。
		structuredLocation: null,
		proximityAlarm: null,
		conference: null,
	};
}

/** ドラフト行(FAB で生やす未送信の新規行)→ 描画用 EventItem。既定「今日・終日」。 */
function draftToItem(d: { id: string; title: string; notes: string }): EventItem {
	return {
		id: d.id,
		recurrenceId: null,
		title: d.title,
		start: localDateKey(new Date()), // 今日・終日
		end: null,
		isAllDay: true,
		location: null,
		url: null,
		notes: d.notes === "" ? null : d.notes,
		status: null,
		recurrence: null,
		alarms: [],
		travelMinutes: null,
		// C1 派生3スロット: 未送信ドラフトは場所/会議を持たない(作成フローは C3〜)。
		structuredLocation: null,
		proximityAlarm: null,
		conference: null,
	};
}

// =============================================================================
// 詳細ページ(モック C。カード内ページ遷移。#root に直接描く)
// =============================================================================
// ‹戻る/保存・タイトル+メモ・参加行(URL video)・終日トグル・開始/終了・繰り返し・通知・
// 予備の通知・移動時間・場所トグル+入力・URL 行。編集ありき(read/編集の分離なし)。

/** event から作業コピーを作る。終日/開始終了/繰り返し/場所/URL/通知/移動時間を逆写像で初期化。 */
function makeSheetDraft(ev: EventItem): SheetDraft {
	const { preset, weekdays } = recurrenceToPreset(ev.recurrence);
	const rec = ev.recurrence;
	const isAllDay = ev.isAllDay || !ev.start.includes("T");
	const startDate = wallDatePart(ev.start);
	const startTime = ev.start.includes("T") ? wallTimePart(ev.start) : "09:00";
	const hasEnd = ev.end !== null;
	const endDate = ev.end !== null ? wallDatePart(ev.end) : startDate;
	const endTime = ev.end !== null && ev.end.includes("T") ? wallTimePart(ev.end) : "10:00";
	return {
		title: ev.title,
		notes: ev.notes ?? "",
		isAllDay,
		startDate,
		startTime,
		hasEnd,
		endDate,
		endTime,
		recurPreset: preset,
		weekdays,
		recurEnd: rec?.count != null ? "count" : rec?.until != null ? "until" : "none",
		until: rec?.until != null ? rec.until.slice(0, 10) : null,
		count: rec?.count ?? null,
		recurOpen: false,
		location: ev.location,
		url: ev.url,
		alarms: ev.alarms.slice(0, 2),
		alarmOpen: false,
		alarm1Open: false,
		travelMinutes: ev.travelMinutes,
		travelOpen: false,
		// C3 作成モードの既定値。編集モード(openSheet)で作った SheetDraft でも同居するが、
		// buildDetailPage(編集用)はこれらのフィールドを一切読まないので無害(未使用のまま)。
		formKind: "event",
		locationValue: null,
		locationPickerOpen: false,
		knownLocations: null,
		knownLocationsLoading: false,
		conferenceProviderDraft: null,
		conferenceUrlDraft: "",
		todoHasDue: true,
		todoPriority: null,
	};
}

/** 詳細ページを開く(既存イベントの ⓘ から)。 */
function openSheet(ev: EventItem): void {
	if (isOptimisticId(ev.id)) return; // 仮行はサーバー id が無いので編集できない
	sheetDraft = makeSheetDraft(ev);
	sheetState = { key: rowKey(ev), page: "detail" };
	closeSwipe();
	quickAddFab.hidden = true;
	renderAll();
}

/** 詳細ページを「作成モード」で開く(FAB ドラフト行の ⓘ から)。 */
function openCreateSheet(): void {
	if (draft === null) return;
	sheetDraft = makeSheetDraft(draftToItem(draft));
	sheetState = { key: rowKey({ id: draft.id }), page: "detail", create: true };
	closeSwipe();
	quickAddFab.hidden = true;
	renderAll();
}

/** 詳細ページを閉じて一覧へ戻る。 */
function closeSheet(): void {
	sheetState = null;
	sheetDraft = null;
	quickAddFab.hidden = false;
	renderAll();
}

/** 現在ページが対象にしている表示行(楽観上書きが乗った display 行)。作成モードは draft の擬似行。 */
function currentSheetEvent(): EventItem | null {
	if (sheetState === null) return null;
	const key = sheetState.key;
	if (draft !== null && key === rowKey({ id: draft.id })) return draftToItem(draft);
	if (events === null) return null;
	// rowKey で「開いたその occurrence 行」を引く(id だと先頭 occurrence にすり替わる — §7.1)。
	return events.find((t) => rowKey(t) === key) ?? null;
}

/** v3 小型トグル(button.sw)。accent で ON を示す(todos と共通の見た目)。 */
function makeSwitch(on: boolean, ariaLabel: string, onClick: () => void): HTMLButtonElement {
	const b = document.createElement("button");
	b.type = "button";
	b.className = on ? "sw on" : "sw";
	b.setAttribute("role", "switch");
	b.setAttribute("aria-checked", String(on));
	b.setAttribute("aria-label", ariaLabel);
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick();
	});
	return b;
}

/** 繰り返し行のインライン展開部(プリセット chips + 曜日丸チップ + 終了 chips)。
 *  【共有化 TODO】todos-entry.ts の buildRecurExpand とほぼ同一だが、SheetDraft 型が entry ごとに
 *  異なる(todos は priority/場所を含む・agenda は通知/移動時間を含む)ため、DOM 組み立て部は
 *  ここに複製した。純粋な写像(presetToArgs/recurValueText 等)は ui/recurrence.ts で共有済み。
 *  将来 SheetDraft の recurrence 部分だけを共通 interface に切り出せれば DOM 部も共有できる(起票)。 */
function buildRecurExpand(d: SheetDraft): HTMLElement {
	const expand = el("div", "f-expand");
	const presets = el("div", "chips");
	for (const p of PRESET_MENU_ORDER) {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = PRESET_LABEL[p];
		b.setAttribute("aria-pressed", String(d.recurPreset === p));
		b.addEventListener("click", () => {
			d.recurPreset = p;
			renderAll();
		});
		presets.appendChild(b);
	}
	const custom = document.createElement("button");
	custom.type = "button";
	custom.textContent = "カスタム";
	custom.disabled = true;
	custom.setAttribute("aria-pressed", String(d.recurPreset === "custom"));
	presets.appendChild(custom);
	expand.appendChild(presets);

	if (d.recurPreset === "weekly" || d.recurPreset === "biweekly") {
		const wd = el("div", "chips wd");
		const lbl = el("span", "chips-label");
		lbl.textContent = "曜日";
		wd.appendChild(lbl);
		const order: ReadonlyArray<[string, string]> = [
			["SU", "日"],
			["MO", "月"],
			["TU", "火"],
			["WE", "水"],
			["TH", "木"],
			["FR", "金"],
			["SA", "土"],
		];
		for (const [code, ja] of order) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = ja;
			b.setAttribute("aria-pressed", String(d.weekdays.includes(code)));
			b.setAttribute("aria-label", ja);
			b.addEventListener("click", () => {
				d.weekdays = d.weekdays.includes(code) ? d.weekdays.filter((w) => w !== code) : [...d.weekdays, code];
				renderAll();
			});
			wd.appendChild(b);
		}
		expand.appendChild(wd);
	}

	if (d.recurPreset !== "none" && d.recurPreset !== "custom") {
		const end = el("div", "chips");
		const lbl = el("span", "chips-label");
		lbl.textContent = "終了";
		end.appendChild(lbl);
		if (d.count != null) {
			const cnt = document.createElement("button");
			cnt.type = "button";
			cnt.textContent = `${d.count}回`;
			cnt.disabled = true;
			cnt.setAttribute("aria-pressed", String(d.recurEnd === "count"));
			end.appendChild(cnt);
		}
		const none = document.createElement("button");
		none.type = "button";
		none.textContent = "しない";
		none.setAttribute("aria-pressed", String(d.recurEnd === "none"));
		none.addEventListener("click", () => {
			d.recurEnd = "none";
			renderAll();
		});
		const until = document.createElement("button");
		until.type = "button";
		until.textContent = "日付";
		until.setAttribute("aria-pressed", String(d.recurEnd === "until"));
		until.addEventListener("click", () => {
			d.recurEnd = "until";
			if (d.until === null) d.until = d.startDate;
			renderAll();
		});
		end.appendChild(none);
		end.appendChild(until);
		expand.appendChild(end);

		if (d.recurEnd === "until") {
			const urow = el("div", "chips");
			const ulbl = el("span", "chips-label");
			ulbl.textContent = "終了日";
			const ui = document.createElement("input");
			ui.className = "naked";
			ui.type = "date";
			ui.value = d.until ?? d.startDate;
			ui.setAttribute("aria-label", "繰り返しの終了日");
			ui.addEventListener("change", () => {
				d.until = ui.value === "" ? null : ui.value;
			});
			urow.appendChild(ulbl);
			urow.appendChild(ui);
			expand.appendChild(urow);
		}
	}
	return expand;
}

/** 値行 + chevron の共通ヘルパー(繰り返し/通知/予備の通知/移動時間の展開行に使う)。 */
function valueRow(label: string, valueText: string, open: boolean, muted: boolean, onToggle: () => void): HTMLElement {
	const row = el("div", "f-row");
	if (open) row.style.borderBottom = "none";
	const lbl = el("span", "f-label");
	lbl.textContent = label;
	const value = el("span", "f-value");
	const val = el("span", muted ? "muted" : "val");
	val.textContent = valueText;
	const chev = el("span", "chev");
	chev.appendChild(createIcon(open ? "chevron-up" : "chevron-down"));
	value.appendChild(val);
	value.appendChild(chev);
	row.appendChild(lbl);
	row.appendChild(value);
	row.style.cursor = "pointer";
	row.addEventListener("click", onToggle);
	return row;
}

/** 単一選択 chips 展開(通知/予備の通知/移動時間で共用)。options は {value,label}、value=null が「なし」。 */
function buildSingleChoiceExpand(
	options: ReadonlyArray<{ value: number | null; label: string }>,
	current: number | null,
	onPick: (value: number | null) => void,
): HTMLElement {
	const expand = el("div", "f-expand");
	const chips = el("div", "chips");
	for (const opt of options) {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = opt.label;
		b.setAttribute("aria-pressed", String(current === opt.value));
		b.addEventListener("click", () => onPick(opt.value));
		chips.appendChild(b);
	}
	expand.appendChild(chips);
	return expand;
}

/** 詳細ページ本体(モック C)。d は sheetDraft(この関数がそれを直接読み書きする)。 */
function buildDetailPage(ev: EventItem, d: SheetDraft): HTMLElement {
	const isCreate = sheetState?.create === true;
	const page = el("div", "detail-page");

	// --- ヘッダ:「‹戻る(破棄)/ 保存」---------------------------------------------------------
	const head = el("div", "page-head");
	const back = document.createElement("button");
	back.type = "button";
	back.className = "link link-back";
	back.appendChild(createIcon("chevron-left"));
	back.appendChild(document.createTextNode("戻る"));
	back.setAttribute("aria-label", isCreate ? "一覧のドラフト行へ戻る" : "破棄して一覧へ戻る");
	back.addEventListener("click", () => {
		if (isCreate) {
			// 作成モードの「戻る」= ドラフト行選択状態へ戻る(title/notes を持ち帰る。構造化は落ちる)。
			if (draft !== null) {
				draft.title = d.title;
				draft.notes = d.notes;
			}
			sheetState = null;
			sheetDraft = null;
			selectedId = draft !== null ? rowKey({ id: draft.id }) : null;
			quickAddFab.hidden = false;
			renderAll();
			return;
		}
		closeSheet();
	});
	const save = document.createElement("button");
	save.type = "button";
	save.className = "link link-save";
	// 【2026-07-22 main 裁定・todos-entry.ts の作成ボタン改称に追随】従来は create/edit 共通で
	// 「保存」固定だったが、todos 側で新規作成の確定ボタンを iOS 準拠の「追加」へ改称した(下の
	// back の isCreate 分岐と同様、この画面も create/edit で意味が違う)。agenda(予定)には
	// todos の「完了」に相当する完了概念が無い(イベントは完了しない)ため、todos のように
	// 「追加/完了」の二択にはせず、編集モードは従来通り「保存」を維持し、作成モードだけ「追加」にする。
	save.textContent = isCreate ? "追加" : "保存";
	save.setAttribute("aria-label", isCreate ? "この内容で追加" : "編集を保存して一覧へ戻る");
	save.addEventListener("click", () => {
		if (isCreate) {
			const title = d.title.trim();
			const details = collectCreateDetails(d);
			sheetState = null;
			sheetDraft = null;
			selectedId = null;
			draft = null;
			quickAddFab.hidden = false;
			if (title !== "") enqueueCreate(title, details);
			else renderAll();
			return;
		}
		const changes = collectSheetChanges(ev, d);
		closeSheet();
		if (Object.keys(changes).length > 0) void saveEdit(ev, changes);
	});
	head.appendChild(back);
	head.appendChild(save);
	page.appendChild(head);

	const body = el("div", "detail-body");

	// --- タイトル input ---------------------------------------------------------------------
	const titleInput = document.createElement("input");
	titleInput.className = "d-title";
	titleInput.type = "text";
	titleInput.value = d.title;
	titleInput.placeholder = "タイトル";
	titleInput.setAttribute("aria-label", "タイトル");
	titleInput.addEventListener("input", () => {
		d.title = titleInput.value;
	});
	body.appendChild(titleInput);

	// --- 参加行(URL があればタイトル直下。lucide video + URL 表示)-------------------------------
	// 【degrade 方針(タスク指示)】ext-apps のホストがサンドボックス iframe から外部リンクを開けるかは
	// 不明。<a target="_blank" rel="noopener"> を置いて開ければ開く。開けないホストに備え、リンクは
	// テキスト選択可能(user-select:text)にして「長押しでコピー/URL を目視」できるよう degrade する
	// (CONFERENCE 書き込みは起票のまま。iOS 自身も URL から参加 UI を合成する)。
	if (d.url !== null && d.url.trim() !== "") {
		const join = el("div", "join-row");
		join.appendChild(createIcon("video"));
		const a = document.createElement("a");
		a.className = "join-link";
		a.href = d.url;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		a.textContent = d.url;
		join.appendChild(a);
		body.appendChild(join);
	}

	// --- メモ textarea ---------------------------------------------------------------------
	const notesInput = document.createElement("textarea");
	notesInput.className = "d-notes";
	notesInput.value = d.notes;
	notesInput.placeholder = "メモを追加";
	notesInput.setAttribute("aria-label", "メモ");
	notesInput.addEventListener("input", () => {
		d.notes = notesInput.value;
	});
	body.appendChild(notesInput);

	// --- 終日トグル(ON=date のみ・OFF=date+time)-----------------------------------------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "終日";
		const value = el("span", "f-value");
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.isAllDay, "終日", () => {
				d.isAllDay = !d.isAllDay;
				renderAll();
			}),
		);
		body.appendChild(row);
	}

	// --- 開始(日付 [+ 時刻])-----------------------------------------------------------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "開始";
		const value = el("span", "f-value");
		const di = document.createElement("input");
		di.className = "naked";
		di.type = "date";
		di.value = d.startDate;
		di.setAttribute("aria-label", "開始日");
		di.addEventListener("change", () => {
			d.startDate = di.value;
		});
		value.appendChild(di);
		if (!d.isAllDay) {
			const ti = document.createElement("input");
			ti.className = "naked";
			ti.type = "time";
			ti.value = d.startTime;
			ti.setAttribute("aria-label", "開始時刻");
			ti.addEventListener("change", () => {
				d.startTime = ti.value === "" ? "09:00" : ti.value;
			});
			value.appendChild(ti);
		}
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}

	// --- 終了(トグルで DTEND の有無 + 日付 [+ 時刻])--------------------------------------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "終了";
		const value = el("span", "f-value");
		if (d.hasEnd) {
			const di = document.createElement("input");
			di.className = "naked";
			di.type = "date";
			di.value = d.endDate;
			di.setAttribute("aria-label", "終了日");
			di.addEventListener("change", () => {
				d.endDate = di.value;
			});
			value.appendChild(di);
			if (!d.isAllDay) {
				const ti = document.createElement("input");
				ti.className = "naked";
				ti.type = "time";
				ti.value = d.endTime;
				ti.setAttribute("aria-label", "終了時刻");
				ti.addEventListener("change", () => {
					d.endTime = ti.value === "" ? "10:00" : ti.value;
				});
				value.appendChild(ti);
			}
		} else {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.hasEnd, "終了", () => {
				d.hasEnd = !d.hasEnd;
				// 【監査#2・終日イベントの既定終了日バグ】終日を ON にした直後、endDate の初期値が
				// (makeSheetDraft で) startDate と同日のことがある。サーバー(create-event.ts の
				// StartAfterEndError)は排他的終端(§3.8.2.2 I3)で end<=start を弾くため、そのまま
				// 保存すると必ず失敗する。終日は「開始+1日」を既定にする(排他的終端の慣習・
				// iOS カレンダーが「終日1日」を start=D, end=D+1 で表すのと同じ発想)。
				// 時刻付きは startTime/endTime の既定(09:00/10:00)で既に end>start が保たれるため
				// 触らない(endDate はそのまま同日でよい)。
				if (d.hasEnd && d.isAllDay && d.endDate <= d.startDate) {
					d.endDate = addDaysToDateKey(d.startDate, 1);
				}
				renderAll();
			}),
		);
		body.appendChild(row);
	}

	// --- 繰り返し(値 + chevron。タップで行下にインライン展開)------------------------------------------
	body.appendChild(
		valueRow("繰り返し", recurValueText(d.recurPreset, d.weekdays), d.recurOpen, d.recurPreset === "custom", () => {
			d.recurOpen = !d.recurOpen;
			renderAll();
		}),
	);
	if (d.recurOpen) body.appendChild(buildRecurExpand(d));

	// --- 通知(alarms[0])------------------------------------------------------------------
	body.appendChild(
		valueRow("通知", alarmLabel(d.alarms[0] ?? null), d.alarmOpen, false, () => {
			d.alarmOpen = !d.alarmOpen;
			renderAll();
		}),
	);
	if (d.alarmOpen) {
		const options = [{ value: null, label: "なし" }, ...ALARM_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
		body.appendChild(
			buildSingleChoiceExpand(options, d.alarms[0] ?? null, (v) => {
				// alarms[0] を差し替え(null なら通知を全部外す=予備の通知も一緒に落とす)。
				if (v === null) d.alarms = [];
				else d.alarms = [v, ...(d.alarms.length > 1 ? [d.alarms[1] as number] : [])];
				d.alarmOpen = false;
				renderAll();
			}),
		);
	}

	// --- 予備の通知(alarms[1]・通知が1件以上あるときだけ出す)----------------------------------------
	if ((d.alarms[0] ?? null) !== null) {
		body.appendChild(
			valueRow("予備の通知", alarmLabel(d.alarms[1] ?? null), d.alarm1Open, false, () => {
				d.alarm1Open = !d.alarm1Open;
				renderAll();
			}),
		);
		if (d.alarm1Open) {
			const options = [{ value: null, label: "なし" }, ...ALARM_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
			body.appendChild(
				buildSingleChoiceExpand(options, d.alarms[1] ?? null, (v) => {
					const first = d.alarms[0] as number;
					if (v === null) d.alarms = [first];
					else d.alarms = [first, v];
					d.alarm1Open = false;
					renderAll();
				}),
			);
		}
	}

	// --- 移動時間(travelMinutes)-------------------------------------------------------------
	body.appendChild(
		valueRow("移動時間", travelLabel(d.travelMinutes), d.travelOpen, false, () => {
			d.travelOpen = !d.travelOpen;
			renderAll();
		}),
	);
	if (d.travelOpen) {
		const options = [{ value: null, label: "なし" }, ...TRAVEL_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
		body.appendChild(
			buildSingleChoiceExpand(options, d.travelMinutes, (v) => {
				d.travelMinutes = v;
				d.travelOpen = false;
				renderAll();
			}),
		);
	}

	// --- 場所(トグル + 展開内 text input。OFF=除去)---------------------------------------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "場所";
		const value = el("span", "f-value");
		if (d.location === null) {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.location !== null, "場所", () => {
				d.location = d.location === null ? "" : null;
				renderAll();
			}),
		);
		body.appendChild(row);
		if (d.location !== null) {
			const expand = el("div", "f-expand");
			const input = document.createElement("input");
			input.type = "text";
			input.value = d.location;
			input.placeholder = "場所";
			input.setAttribute("aria-label", "場所");
			input.addEventListener("input", () => {
				d.location = input.value;
			});
			expand.appendChild(input);
			body.appendChild(expand);
		}
	}

	// --- URL 行(テキスト入力・空=除去)。トグルは付けず常に入力欄を出す(空なら除去に写像)----------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "URL";
		const value = el("span", "f-value");
		const input = document.createElement("input");
		input.className = "url-input";
		input.type = "text";
		input.value = d.url ?? "";
		input.placeholder = "https://…";
		input.setAttribute("aria-label", "URL");
		input.addEventListener("input", () => {
			d.url = input.value === "" ? null : input.value;
		});
		value.appendChild(input);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}

	// --- リスト行(読み取り専用。move-event 未実装のため今回は › を省略。起票)-----------------------------
	// 【起票】イベントのコレクション移動(move-event)は未実装。todos は move-todo でリスト選択ページを
	// 持つが、agenda は S2 スコープ外。現在のカレンダー名を読み取り専用で見せるだけにする。
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "リスト";
		const value = el("span", "f-value");
		const val = el("span", "muted");
		val.textContent = currentCalendarId ?? "";
		value.appendChild(val);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}

	page.appendChild(body);
	return page;
}

// =============================================================================
// SheetDraft → ツール引数(start/end の文字列形式への写像。終日トグルは形式への写像で実装)
// =============================================================================
// 【終日 → 形式の写像】isAllDay=true → start/end は "YYYY-MM-DD"。isAllDay=false → "YYYY-MM-DDTHH:MM:SS"。
// isAllDay 入力フラグはサーバーに無い(start/end の文字列形式が判別源)ので、ここで形式へ落とす。

/** SheetDraft → start 文字列。 */
function draftStart(d: SheetDraft): string {
	return d.isAllDay ? d.startDate : `${d.startDate}T${d.startTime}:00`;
}
/** SheetDraft → end 文字列(hasEnd=false は null)。 */
function draftEnd(d: SheetDraft): string | null {
	if (!d.hasEnd) return null;
	return d.isAllDay ? d.endDate : `${d.endDate}T${d.endTime}:00`;
}

/** 詳細ページの「保存」が update-event へ渡す「変更フィールドだけ」を draft と ev の差分から集める。 */
function collectSheetChanges(ev: EventItem, d: SheetDraft): UpdateEventChanges {
	const changes: UpdateEventChanges = {};
	const t = d.title.trim();
	if (t !== "" && t !== ev.title) changes.title = t;
	if (d.notes !== (ev.notes ?? "")) changes.notes = d.notes;

	// start/end(壁時計文字列で比較。ev.start は offset 付き ISO なので秒までの wall 部分で比較する)。
	const nextStart = draftStart(d);
	const curStart = ev.start.includes("T") ? ev.start.slice(0, 19) : ev.start;
	if (nextStart !== curStart) changes.start = nextStart;
	const nextEnd = draftEnd(d);
	const curEnd = ev.end === null ? null : ev.end.includes("T") ? ev.end.slice(0, 19) : ev.end;
	if (nextEnd === null) {
		if (curEnd !== null) changes.end = null;
	} else if (nextEnd !== curEnd) {
		changes.end = nextEnd;
	}

	// 場所(OFF=null で除去 / 空文字も除去扱い)。
	const nextLoc = d.location === null || d.location.trim() === "" ? null : d.location;
	const curLoc = ev.location === null || ev.location.trim() === "" ? null : ev.location;
	if (nextLoc !== curLoc) changes.location = nextLoc;

	// URL(空=除去)。
	const nextUrl = d.url === null || d.url.trim() === "" ? null : d.url;
	const curUrl = ev.url === null || ev.url.trim() === "" ? null : ev.url;
	if (nextUrl !== curUrl) changes.url = nextUrl;

	// 通知(alarms)。配列内容が変わったら全置換 / 空なら null(全除去)。
	const nextAlarms = d.alarms.slice(0, 2);
	if (JSON.stringify(nextAlarms) !== JSON.stringify(ev.alarms)) {
		changes.alarms = nextAlarms.length === 0 ? null : nextAlarms;
	}

	// 移動時間。
	if ((d.travelMinutes ?? null) !== (ev.travelMinutes ?? null)) {
		changes.travelMinutes = d.travelMinutes;
	}

	// 繰り返し(custom は触らない)。プリセット/曜日/終了のいずれかが変わったときだけ全置換で送る。
	if (d.recurPreset !== "custom") {
		const orig = recurrenceToPreset(ev.recurrence);
		const origEnd = ev.recurrence?.count != null ? "count" : ev.recurrence?.until != null ? "until" : "none";
		const origUntil = ev.recurrence?.until != null ? ev.recurrence.until.slice(0, 10) : null;
		const changed =
			d.recurPreset !== orig.preset ||
			JSON.stringify([...d.weekdays].sort()) !== JSON.stringify([...orig.weekdays].sort()) ||
			d.recurEnd !== origEnd ||
			(d.recurEnd === "until" && d.until !== origUntil);
		if (changed) {
			const args = presetToArgs(d.recurPreset, d.weekdays);
			if (args !== null) {
				if (d.recurEnd === "until" && d.until != null && args.frequency !== "none") args.until = d.until;
				changes.recurrence = args;
			}
		}
	}
	return changes;
}

/** 新規作成の詳細フィールド(create-event の全フィールド)。 */
interface CreateDetails {
	start: string;
	end: string | null;
	isAllDay: boolean;
	notes: string;
	location?: string | null;
	url?: string | null;
	recurrence?: RecurArgs;
	alarms?: number[];
	travelMinutes?: number | null;
	// C3+C4(設計05 §4・§5): 「場所または会議」セミモーダルの確定値(create-event の
	// structuredLocation/conference へ写す。locationPickerToCreateArgs が実際の変換を担う)。
	locationValue?: LocationPickerValue | null;
}

/** ドラフト行の高速確定(既定「今日・終日」)の CreateDetails。 */
function defaultCreateDetails(notes: string): CreateDetails {
	return { start: localDateKey(new Date()), end: null, isAllDay: true, notes };
}

/** 作成モード詳細ページの SheetDraft → CreateDetails。 */
function collectCreateDetails(d: SheetDraft): CreateDetails {
	let recurrence: RecurArgs | undefined;
	if (d.recurPreset !== "none" && d.recurPreset !== "custom") {
		const args = presetToArgs(d.recurPreset, d.weekdays);
		if (args !== null && args.frequency !== "none") {
			if (d.recurEnd === "until" && d.until != null) args.until = d.until;
			recurrence = args;
		}
	}
	const alarms = d.alarms.slice(0, 2);
	return {
		start: draftStart(d),
		end: draftEnd(d),
		isAllDay: d.isAllDay,
		notes: d.notes.trim(),
		location: d.location === null || d.location.trim() === "" ? null : d.location,
		url: d.url === null || d.url.trim() === "" ? null : d.url,
		recurrence,
		alarms: alarms.length > 0 ? alarms : undefined,
		travelMinutes: d.travelMinutes,
		locationValue: d.locationValue,
	};
}

// =============================================================================
// 楽観の重ね直し(rebuildDisplay)と確定 vm の取り込み(applyStructuredContent)
// =============================================================================
// todos の同名機構と同じ骨格: 確定土台(confirmedEvents)へ in-flight 楽観(edits/rows/deletes)を
// 重ね直して表示用 state(events/affectedById/ghosts)を作る。確定 vm が届いても in-flight が
// 失われないよう、applyStructuredContent は confirmedEvents を更新した上で楽観を再度重ねる。

function rebuildDisplay(baseAffected: AffectedEntry[], baseGhosts: EventSnapshot[]): void {
	const affected = new Map<string, AffectedEntry>(baseAffected.map((a) => [a.id, a]));
	const displayEvents: EventItem[] = (confirmedEvents ?? [])
		.filter((t) => !optimisticDeletes.has(t.id))
		.map((t) => {
			const ed = optimisticEdits.get(t.id);
			if (ed === undefined) return t;
			// 編集の楽観上書き(値だけ差し替え。becoming-edit のインライン旧→新は確定 vm の changes に任せる)。
			return { ...t, ...ed };
		});
	for (const row of optimisticRows) {
		displayEvents.push(optimisticRowToItem(row));
		affected.set(row.id, { id: row.id, kind: "added" });
	}
	// confirmedEvents 未受領 かつ 仮行も無い = まだ描くものが無い → skeleton を維持する。
	events = confirmedEvents === null && displayEvents.length === 0 ? null : displayEvents;
	affectedById = affected;
	ghosts = baseGhosts;
}

/** 確定 vm を通さず、直近のサーバー土台の上に in-flight 楽観だけを重ね直す(楽観アクション直後 / ロールバック)。 */
function rebuildFromConfirmed(): void {
	rebuildDisplay(serverAffectedBase, serverGhostsBase);
}

/** 成功/失敗どちらでも仮行を1つ取り除く。 */
function removeOptimisticRow(id: string): void {
	optimisticRows = optimisticRows.filter((r) => r.id !== id);
}

/**
 * SyncDiff(システム起因の残差)を AffectedEntry[](sync:true)へ変換する。
 * added は events に実在するので snapshot は添えない。edited は sync レンズに出さない
 * (todos と同じ判断: replay スナップショットの DTO 進化で偽陽性が出るのと、現在値が行に表示済みで
 * 情報量が薄いため。高シグナルな added/removed だけ残す)。
 */
function syncDiffToAffected(diff: SyncDiff): AffectedEntry[] {
	const out: AffectedEntry[] = [];
	for (const id of diff.added) out.push({ id, kind: "added", sync: true });
	// edited は捨てる(computeSyncDiff は計算し続けるが消費側で落とす = 戻しやすい)。
	return out;
}

/**
 * 応答を状態に反映する唯一の関数(ontoolresult / fetchLatest / mutation 成功の3経路が通る)。
 *
 * 【becoming の寿命(§7.2・2026-07-16 実機FB)】becoming(serverAffectedBase)のクリアは
 * 「次のユーザー起点更新」= fetchLatest(手動/focus refetch)・ontoolresult(LLM 起点)・
 * range/calendar 切替・別 mutate、に限定する。mutate 成功直後の自動 refresh-events
 * (preserveBecoming: true で呼ばれる)では **保持** する。以前は「affected の無い応答が来たら
 * 無条件で空に上書き」だったため、URL 追加直後に affected 無し refresh が挟まるとバッジが
 * 全消えして 🔁 が復活する、という実装ムラが出ていた。
 */
function applyStructuredContent(sc: unknown, opts?: { preserveBecoming?: boolean }): void {
	const structuredContent = sc as EventsStructuredContent | undefined;
	const nextEvents = structuredContent?.events ?? [];
	let serverAffected = structuredContent?.affected ?? [];
	let serverRemoved = structuredContent?.removed ?? [];
	// preserveBecoming: 応答自身が affected/removed を運んでいればそちらが最新(別 mutate =
	// クリア経路の1つ)。何も運んでいないときだけ直前の becoming 土台を持ち越す。
	if (opts?.preserveBecoming === true && serverAffected.length === 0 && serverRemoved.length === 0) {
		serverAffected = serverAffectedBase;
		serverRemoved = serverGhostsBase;
	}

	// --- システム起因(外部)変化の差分レンズ -------------------------------------------------
	// 別コレクション / 別期間への遷移では差分レンズを回さない(全行が追加+削除の全差分ノイズになるため)。
	const incomingCalendarId = structuredContent?.calendarId;
	const calendarChanged =
		currentCalendarId !== null && incomingCalendarId !== undefined && incomingCalendarId !== currentCalendarId;
	// range 変更(実質別期間)。mutate 応答は range を持たない(undefined)ので誤検出しないよう、
	// sc.range が明示されていて currentRange と中身が違うときだけ「別期間」とみなす。
	const rangeChanged =
		structuredContent?.range !== undefined &&
		currentRange !== null &&
		JSON.stringify(structuredContent.range) !== JSON.stringify(currentRange);
	let syncDiff: SyncDiff = { added: [], edited: [], removed: [] };
	if (confirmedEvents !== null && !calendarChanged && !rangeChanged) {
		const explained = new Set<string>();
		for (const a of serverAffected) explained.add(a.id);
		for (const r of serverRemoved) explained.add(r.id);
		// in-flight 行は触らない(degrade ガード)。Set→Map 化(§7.8)に伴い .keys() で id だけ回す。
		for (const id of pendingIds.keys()) explained.add(id);
		syncDiff = computeSyncDiff(confirmedEvents, nextEvents, explained);
	}

	confirmedEvents = nextEvents;
	const combinedAffected: AffectedEntry[] = serverAffected.concat(syncDiffToAffected(syncDiff));
	const combinedGhosts: EventSnapshot[] = serverRemoved.concat(syncDiff.removed.map((r): EventSnapshot => ({ ...r, sync: true })));
	serverAffectedBase = combinedAffected;
	serverGhostsBase = combinedGhosts;
	rebuildDisplay(combinedAffected, combinedGhosts);

	// range は list/refresh のみ echo。値が来たときだけ更新する(mutate 応答では currentRange を保つ)。
	if (structuredContent?.range !== undefined) currentRange = structuredContent.range;
	// 2026-07-22 mutate echo pin 再発修正: structuredContent.calendarId は create/update/delete
	// の mutate 応答でも「実際に作成/操作した先」を正直に echo してくる(server.ts の vm 組み立て
	// 参照)。これ自体は正しい値だが、currentCalendarId は「表示スコープが全横断か単一か」という
	// “照会の文脈” を保持する変数であり、mutate の作成先で上書きすると、全横断表示中
	// (currentCalendarId===null)に1件 create しただけで単一コレクションへ collapse してしまう
	// (以降の focus refetch がその1コレクションしか見なくなる)。
	// 上の rangeChanged 判定と同じ契約(server.ts:1275 コメント)を再利用する: 照会系(list/refresh)
	// だけが range を名乗り、mutate 応答は range を運ばない。よって「range が来た応答のときだけ」
	// calendarId も信頼して反映する。mutate 応答(range undefined)では触らずに直前の値を保つ。
	if (structuredContent?.range !== undefined && structuredContent?.calendarId !== undefined) {
		// currentCalendarId は refreshArgs の従来経路(フィルタ未適用時)のためだけに保持する。
		// 【2026-07-22 ヘッダ見出しは不動へ】旧実装はここで appTitleEl.textContent = currentCalendarId と
		// していたが、agenda は複数カレンダー合成ビューで見出しは「カレンダー」固定が正しい(選択内容で
		// 変えない・collection-picker-v5 の役割分離)。よって見出しへの書き込みは廃止し、静的骨格の
		// 「カレンダー」のまま据え置く(currentCalendarId 追跡自体は refetch のために残す)。
		currentCalendarId = structuredContent.calendarId;
	}
	if (structuredContent?.timeZone !== undefined) currentTimeZone = structuredContent.timeZone;
	renderRangeLabel();
	// 表示カレンダーの色ドットクラスタを更新(events の由来 id / calendarsCache から凡例を組む)。
	renderCalDots();
	markUpdated();
	announceBecoming();
}

/** affected/removed から操作結果の読み上げ文を組み立てて aria-live(#live)へ流す。 */
function announceBecoming(): void {
	const parts: string[] = [];
	let syncCount = 0;
	for (const a of affectedById.values()) {
		if (a.sync === true) {
			syncCount++;
			continue;
		}
		const title = events?.find((t) => t.id === a.id)?.title ?? a.event?.title;
		if (title === undefined) continue;
		const verb = a.kind === "added" ? "追加しました" : a.kind === "edited" ? "変更しました" : null;
		if (verb === null) continue;
		parts.push(`「${title}」を${verb}`);
	}
	for (const g of ghosts) {
		if (g.sync === true) {
			syncCount++;
			continue;
		}
		parts.push(`「${g.title}」を削除しました`);
	}
	if (syncCount > 0) parts.push(`同期で${syncCount}件更新されました`);
	liveEl.textContent = parts.join("。");
}

// =============================================================================
// サーバーとのやりとり
// =============================================================================

// 初期表示: ontoolresult 発火前の空白防止にスケルトンを出す(todos と同じ)。
renderSkeleton();

let gotResult = false;
// C3(設計04 §5・P4-DM): appCapabilities.availableDisplayModes を宣言する(apps.mdx:781 View は
// appCapabilities.availableDisplayModes を宣言する MUST。無いとホストは apps.mdx:786「View の
// appCapabilities に無いモードへ MUST NOT switch」で fullscreen へ切り替えられない — この宣言が
// 昇格フロー全体の前提)。第2引数が capabilities(spec.types.ts:404-412・AppOptions とは別引数。
// app.d.ts:501 `constructor(_appInfo, _capabilities?, options?)`)。todos-entry.ts:2989 と同じ。
const app = new App({ name: "caldav-agenda", version: "0.1.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
app.ontoolresult = (r) => {
	gotResult = true;
	clearStatus();
	// S1(docs/modeling/14 §6 項目5): カード発の削除に使う免除トークンを _meta.confirm.cardToken から拾う
	// (todos-entry.ts と対称。deleteEvent がこれを confirmToken として delete-event に渡す)。
	captureConfirmToken(r);
	// list-events-expanded だけでなく create/update/delete-event 等の mutation ツールがこの UI を
	// 開いた場合もここに届く(mutation 応答には affected/removed が乗る)。共通経路 applyStructuredContent。
	void ingestStructuredContent(r?.structuredContent).then(() => renderAll());
};
// C1: host-context-changed の購読(設計04 §5 C1)。SDK が host-context-changed 受信のたびに内部
// _hostContext へ merge した後にこのハンドラを呼ぶ(app.d.ts:723-727)ので、applyHostContext() を
// 呼び直すだけで追従できる。maxHeight/displayMode の変化は畳み判定に直接効くため再描画まで行う
// (詳細ページ表示中は renderAll 内の早期 return で畳み対象外になる)。connect 前に登録する
// (ontoolresult と同じ理由・登録前に来た通知を取りこぼさない・SDK 推奨。todos-entry.ts:3012 と同じ)。
app.addEventListener("hostcontextchanged", () => {
	applyHostContext();
	renderAll();
});

showStatus("接続中…");
try {
	await app.connect();
} catch (e) {
	showStatus(`接続失敗: ${e instanceof Error ? e.message : String(e)}`);
	throw e;
}
connected = true;
// C1: connect 完了後に一度読み hostMaxHeightPx/hostDisplayMode を初期化する(apps.mdx:687-711 の
// 「View 初期化時に containerDimensions を確認する」の実装箇所)。以降の変化は上の hostcontextchanged
// 購読が拾う。renderAll はここでは呼ばない — この直後に ontoolresult 由来の初回描画が来る
// (まだ events が無いので skeleton のまま畳み判定しても意味が無い。todos-entry.ts:3035 と同じ)。
applyHostContext();

/** refresh-events / list-events-expanded を呼ぶときの arguments。currentRange(期間)+ calendarId を載せる。
 *  currentRange 未受領(初回応答前)のときは range を省いて server 既定に委ねる。 */
function refreshArgs(): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (currentRange !== null) {
		args.timeMin = currentRange.from;
		args.timeMax = currentRange.to;
	}
	if (currentTimeZone !== null) args.timeZone = currentTimeZone;
	// 表示フィルタ(2026-07-22): 一部 OFF の絞り込み中(visibleCalendarIds が非 null かつ非空)は
	// calendarIds を送り、その集合だけを横断合成させる(server 側 resolveCollectionIds が calendarIds を
	// 優先)。このとき calendarId(単数)は送らない(併記すると意図が曖昧・calendarIds が勝つが明示的に省く)。
	// フィルタ未適用(null)のときだけ従来どおり calendarId(あれば)を送る = 従来挙動を厳密に保つ。
	// 全 OFF(空 Set)はサーバーを呼ばない(refetchFiltered が空表示にする)ので、ここには非空 Set しか来ない。
	if (visibleCalendarIds !== null && visibleCalendarIds.size > 0) {
		args.calendarIds = [...visibleCalendarIds];
	} else if (currentCalendarId !== null) {
		args.calendarId = currentCalendarId;
	}
	return args;
}

/**
 * ontoolresult(ホスト push)専用の入口ガード。mutate 応答(range 無し)を非既定期間で開いている
 * カードへ push されても、tasks(events)ごと直接適用すると currentRange が黙って落ちうるが、
 * agenda は applyStructuredContent が「range が来たときだけ currentRange を更新」する設計なので、
 * mutate 応答をそのまま適用しても currentRange は保たれる(events だけ差し替わる)。todos の
 * needsViewReconcile ほどの穴は無いため、ここでは calendarId 不一致のときだけ refresh で取り直す。
 */
async function ingestStructuredContent(sc: unknown): Promise<void> {
	const structuredContent = (sc as EventsStructuredContent | undefined) ?? {};
	// calendarId 不一致(ホストが別コレクションの結果を同一 App へ push した)→ 自分の期間/コレクションを取り直す。
	if (
		currentCalendarId !== null &&
		structuredContent.calendarId !== undefined &&
		structuredContent.calendarId !== currentCalendarId &&
		currentRange !== null
	) {
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (!refreshed.isError) {
				const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
				applyStructuredContent({
					events: rsc?.events ?? [],
					calendarId: rsc?.calendarId ?? currentCalendarId,
					timeZone: rsc?.timeZone,
					range: rsc?.range,
					affected: structuredContent.affected,
					removed: structuredContent.removed,
				});
				return;
			}
		} catch {
			// degrade: 取り直し失敗時は受け取った vm をそのまま適用(最新データを最優先。todos と同じ判断)。
		}
	}
	applyStructuredContent(sc);
}

/** refresh-events を呼んで状態をサーバー確定値で置き換える共通経路(focus refetch / mutation 後の取り直し)。 */
async function fetchLatest(): Promise<void> {
	const result = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
	if (result.isError) {
		const first = result.content?.[0];
		throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
	}
	applyStructuredContent(result.structuredContent);
}

/** エラーバナーの「再試行」から使う再取得(mutate は再送しない = 二重操作を避ける)。 */
async function retryFetch(): Promise<void> {
	clearBanner();
	try {
		await fetchLatest();
		renderAll();
	} catch (e) {
		showBanner(`再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
	}
}

// =============================================================================
// 表示カレンダーフィルタ(2026-07-22 collection-picker-v5)
// =============================================================================
// ヘッダ右端の色ドットクラスタ(凡例 + フィルタ入口)をタップ → ボタン直下にドロップダウンを開き、
// 色付き丸チェックで各カレンダーの表示 ON/OFF をトグルする(開いたまま・裏の一覧へ即時反映)。
// 末尾「カレンダーを追加」で create-calendar。セミモーダル案はトリガー乖離でボツ(2026-07-22 ユーザーFB)。

/** list-calendars を遅延取得してキャッシュする(フィルタメニューを開くときに使う)。失敗はバナーへ degrade。
 *  todos-entry.ts の ensureCalendars と同型(コード重複だが両 entry は別バンドルなので共有せず写経)。 */
async function ensureCalendars(): Promise<void> {
	if (calendarsCache !== null) return;
	try {
		const result = await app.callServerTool({ name: "list-calendars", arguments: {} });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		const sc = result.structuredContent as
			| { calendars?: Array<{ id: string; displayName?: string; components?: readonly string[] }> }
			| undefined;
		calendarsCache = (sc?.calendars ?? []).map((c) => ({
			id: c.id,
			displayName: c.displayName ?? c.id,
			// components 欠落時は VEVENT 既定(agenda 文脈なので予定カレンダーと見なす)。
			components: c.components ?? ["VEVENT"],
		}));
	} catch (e) {
		showBanner(`カレンダーの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** フィルタ対象になりうるカレンダー(VEVENT を受理するコレクション)の id 一覧。
 *  calendarsCache があればそれを正とし、無い(メニュー未展開)間は現在表示中の events の由来 id を
 *  distinct して代用する(凡例ドットを初回描画から出すため)。順序は安定させたいので events 出現順。 */
function knownCalendarIds(): string[] {
	if (calendarsCache !== null) return calendarsCache.filter((c) => c.components.includes("VEVENT")).map((c) => c.id);
	const seen: string[] = [];
	for (const ev of events ?? []) {
		const cid = ev.calendarId;
		if (cid !== undefined && !seen.includes(cid)) seen.push(cid);
	}
	return seen;
}

/** いま表示 ON のカレンダー id 一覧(色ドットクラスタ・「全 ON か」判定の源)。
 *  visibleCalendarIds が null(フィルタ未適用)なら knownCalendarIds 全部、Set ならその集合と既知の積。 */
function onCalendarIds(): string[] {
	const known = knownCalendarIds();
	const vis = visibleCalendarIds; // module let をローカル const に束ねて closure 内でも narrowing を効かせる。
	if (vis === null) return known;
	return known.filter((id) => vis.has(id));
}

/** ヘッダの色ドットクラスタを描く。表示 ON のカレンダー色を最大3つ重ね、超過は「+N」、全 OFF は「0」
 *  (モック collection-picker-v5 の aRenderDots)。単一カレンダーしか無い環境でも凡例として色1つは出す。 */
function renderCalDots(): void {
	calDotsEl.textContent = "";
	const on = onCalendarIds();
	const shown = on.slice(0, 3);
	for (const id of shown) {
		const d = el("span", "d");
		d.style.background = colorForCalendarId(id);
		calDotsEl.appendChild(d);
	}
	if (on.length > 3) {
		const more = el("span", "d-more");
		more.textContent = `+${on.length - 3}`;
		calDotsEl.appendChild(more);
	} else if (on.length === 0) {
		// 全 OFF(または表示できるカレンダーが1件も無い)。「0」を出して「今は何も表示していない」を明示。
		const zero = el("span", "d-more");
		zero.textContent = "0";
		calDotsEl.appendChild(zero);
	}
}

/** メニューが開いているか(#cal-menu の hidden を真実の源にする)。 */
function isCalMenuOpen(): boolean {
	return !calMenuEl.hidden;
}

/** ドロップダウンの中身を calendarsCache から組み立てる。VEVENT コレクションだけを列挙し、
 *  各行に色付き丸チェック(ON=塗り+白 check / OFF=色輪郭)+ 表示名。末尾に「カレンダーを追加」。 */
function renderCalMenu(): void {
	calMenuEl.textContent = "";
	if (calendarsCache === null) {
		const loading = el("div", "cal-menu-item");
		const name = el("span", "name");
		name.textContent = "読み込み中…";
		loading.append(el("span", "cal-circle"), name);
		calMenuEl.appendChild(loading);
		return;
	}
	const cals = calendarsCache.filter((c) => c.components.includes("VEVENT"));
	// 現在の ON 集合を実体化(null=全 ON なので既知全部を ON とみなす)。
	const onSet = visibleCalendarIds === null ? new Set(cals.map((c) => c.id)) : visibleCalendarIds;
	for (const c of cals) {
		const item = el("button", "cal-menu-item") as HTMLButtonElement;
		item.type = "button";
		const on = onSet.has(c.id);
		const color = colorForCalendarId(c.id);
		const circle = el("span", "cal-circle");
		circle.style.borderColor = color;
		circle.style.background = on ? color : "transparent";
		if (on) circle.appendChild(createIcon("check"));
		const name = el("span", "name");
		name.textContent = c.displayName !== "" ? c.displayName : c.id;
		item.append(circle, name);
		item.addEventListener("click", (e) => {
			e.stopPropagation();
			toggleCalendar(c.id);
		});
		calMenuEl.appendChild(item);
	}
	if (cals.length === 0) {
		const empty = el("div", "cal-menu-item");
		const name = el("span", "name");
		name.textContent = "カレンダーがありません";
		empty.append(el("span", "cal-circle"), name);
		calMenuEl.appendChild(empty);
	}
	// 末尾「カレンダーを追加」行 or 追加入力モード。
	if (calAddMode) {
		const row = el("div", "cal-new-row");
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "カレンダー名";
		input.setAttribute("aria-label", "新しいカレンダー名");
		const confirm = el("button", "cal-new-confirm") as HTMLButtonElement;
		confirm.type = "button";
		confirm.textContent = "作成";
		const submit = (): void => {
			const nm = input.value.trim();
			if (nm === "") return;
			void createCalendar(nm);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		confirm.addEventListener("click", (e) => {
			e.stopPropagation();
			submit();
		});
		row.append(input, confirm);
		calMenuEl.appendChild(row);
		// メニューを開き直した直後に入力へフォーカス(iOS キーボードを即出す)。
		setTimeout(() => input.focus(), 0);
	} else {
		const add = el("button", "cal-menu-add") as HTMLButtonElement;
		add.type = "button";
		const plusSlot = el("span", "plus-slot");
		plusSlot.appendChild(createIcon("plus"));
		add.append(plusSlot, document.createTextNode("カレンダーを追加"));
		add.addEventListener("click", (e) => {
			e.stopPropagation();
			calAddMode = true;
			renderCalMenu();
			applyCalMenuHeightGuard();
		});
		calMenuEl.appendChild(add);
	}
}

/** カレンダーの表示 ON/OFF をトグルする(開いたまま即反映)。全部 ON へ戻ったら null に正規化する。 */
function toggleCalendar(id: string): void {
	const known = knownCalendarIds();
	// 現在の ON 集合を実体化(null=全 ON)。
	const on = visibleCalendarIds === null ? new Set(known) : new Set(visibleCalendarIds);
	if (on.has(id)) on.delete(id);
	else on.add(id);
	// 全部 ON に戻ったら「フィルタ未適用(null)」へ正規化 → refreshArgs が calendarIds を送らず全横断(既定)。
	if (known.length > 0 && on.size >= known.length && known.every((k) => on.has(k))) {
		visibleCalendarIds = null;
	} else {
		visibleCalendarIds = on;
	}
	renderCalMenu();
	renderCalDots();
	void refetchFiltered();
}

/** フィルタ変更後の一覧取り直し。全 OFF(空 Set)はサーバーを呼ばず空表示、それ以外は fetchLatest。 */
async function refetchFiltered(): Promise<void> {
	// 全 OFF: 空 Set。サーバーは呼ばない(calendarIds:[] は server が全横断と誤解するため)。
	if (visibleCalendarIds !== null && visibleCalendarIds.size === 0) {
		allCalendarsHidden = true;
		renderAll();
		return;
	}
	allCalendarsHidden = false;
	clearBanner();
	try {
		await fetchLatest();
		renderAll();
	} catch (e) {
		showBanner(`表示の切り替えに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void refetchFiltered());
	}
}

/** create-calendar(新しい予定カレンダーを作る)。成功で list-calendars 再取得・新カレンダーを ON にして
 *  メニュー内一覧を更新。失敗は既存のバナーパターンへ degrade(メニューは開いたまま)。 */
async function createCalendar(displayName: string): Promise<void> {
	clearBanner();
	try {
		const result = await app.callServerTool({
			name: "create-calendar",
			arguments: {
				displayName,
				// agenda は予定(VEVENT)カレンダーを作る(リマインダーリスト VTODO ではない)。
				components: ["VEVENT"],
				// 作成直後に返る空一覧の表示ゾーン(server が additive に受ける)。閲覧デバイスの IANA ゾーン。
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			},
		});
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		// structuredContent.calendarId = 作成されたコレクション id(server の create-calendar 応答契約)。
		const newId = (result.structuredContent as { calendarId?: string } | undefined)?.calendarId;
		// list-calendars を取り直して新カレンダーをメニューに反映する。
		calendarsCache = null;
		await ensureCalendars();
		calAddMode = false;
		// 新カレンダーを表示 ON にする。フィルタ未適用(null=全 ON)なら新規も自動で ON なので何もしない。
		// 一部 OFF 中(Set)なら新 id を明示的に足す。
		if (newId !== undefined && visibleCalendarIds !== null) visibleCalendarIds.add(newId);
		renderCalMenu();
		renderCalDots();
		applyCalMenuHeightGuard();
		// 新カレンダーは空なので一覧の見た目は変わらないが、フィルタ集合が変わったので取り直す
		// (全 ON=null のときは従来経路で全横断が取り直される)。
		void refetchFiltered();
	} catch (e) {
		// 追加入力モードは維持したままバナーで告知(ユーザーが名前を直して再試行できるように)。
		showBanner(`カレンダーの作成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** フィルタメニューの開閉。開くときは calendarsCache を遅延取得し、外タップ捕捉レイヤを表示、高さ担保。 */
function openCalMenu(open: boolean): void {
	calMenuEl.hidden = !open;
	calMenuOutsideEl.hidden = !open;
	calFilterBtn.setAttribute("aria-expanded", String(open));
	if (open) {
		calAddMode = false; // 開くたびに追加入力モードはリセット(前回開いたときの入力を残さない)。
		renderCalMenu();
		if (calendarsCache === null) {
			void ensureCalendars().then(() => {
				if (isCalMenuOpen()) {
					renderCalMenu();
					renderCalDots(); // キャッシュが埋まると全 ON の凡例が「events 由来」→「既知全部」に精緻化される。
					applyCalMenuHeightGuard();
				}
			});
		}
		applyCalMenuHeightGuard();
	} else {
		calAddMode = false;
		clearCalMenuHeightGuard();
	}
}

/** 【inline ドロップダウンの高さ担保】todos-entry.ts の applyMenuHeightGuard と同じ手法・同じ理由
 *  (absolute のメニューは document フロー高さに寄与せず、auto-height iframe でクリップされるので、
 *  開いている間だけ body に min-height を積んでホストの size-changed に伸ばさせる)。詳細は
 *  todos-entry.ts のコメント参照。右寄せ(right:0)でも下端 Y の計算は同じ(bottom + scrollY)。 */
function applyCalMenuHeightGuard(): void {
	const menuBottom = calMenuEl.getBoundingClientRect().bottom + window.scrollY;
	document.body.style.minHeight = `${Math.ceil(menuBottom) + 12}px`;
}
function clearCalMenuHeightGuard(): void {
	document.body.style.minHeight = "";
}

/** mutate 応答の確定描画共通後処理: tasks(events)が乗っていれば適用、無ければ refresh で取り直す。 */
async function applyMutateResult(structuredContent: EventsStructuredContent | undefined, failMsg: string): Promise<void> {
	if (structuredContent?.events !== undefined) {
		// mutate 起点の適用は becoming を保持(§7.2。応答が affected を運んでいればそちらが優先)。
		applyStructuredContent(structuredContent, { preserveBecoming: true });
		return;
	}
	try {
		await fetchLatest();
	} catch (e) {
		rebuildFromConfirmed();
		renderAll();
		showBanner(`${failMsg}: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
	}
}

/**
 * 削除の楽観適用(todos deleteTask と同型):
 *   1. optimisticDeletes に積み、その場で行を除去して再描画。
 *   2. 裏で delete-event を fire。3. 成功=応答(events 空 + removed ゴースト)を確定描画 / 失敗=行を復活 + バナー。
 */
async function deleteEvent(ev: EventItem): Promise<void> {
	if (isOptimisticId(ev.id)) return;
	if (optimisticDeletes.has(ev.id)) return;
	optimisticDeletes.add(ev.id);
	// 【2026-07-16 §7.8】startCommitting は T_hard(10s)警告 + degrade ガードのためだけに呼ぶ
	// (delete の committing アニメ自体は未実装 — renderGhostRow 冒頭コメント参照)。
	startCommitting(ev.id);
	// delete-event はマスター id 単位(系列全 occurrence が消える)なので、選択/スワイプ/詳細ページが
	// 系列の「どの occurrence」を指していても id が一致すれば畳む(rowKey 完全一致では取り逃す)。
	if (selectedId !== null && idOfRowKey(selectedId) === ev.id) selectedId = null;
	if (swipeId !== null && idOfRowKey(swipeId) === ev.id) swipeId = null;
	if (sheetState !== null && idOfRowKey(sheetState.key) === ev.id) closeSheet();
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	liveEl.textContent = `「${ev.title}」を削除しました`;
	try {
		const args: Record<string, unknown> = { id: ev.id };
		// 【2026-07-22 echo pin バグ修正で currentCalendarId が null になり得るようになった】
		// 全横断表示中(currentCalendarId===null)でも、行自体は toWireEvent が付けた由来コレクション
		// (ev.calendarId)を持っている。全横断中に currentCalendarId を使うと id が不明で送れず、
		// 「削除対象が複数コレクションに同名 id で存在する」曖昧さも server 側で拾えなくなるので、
		// まず対象イベント自身の calendarId を優先し、無ければ currentCalendarId、それも無ければ
		// 省略(server の calendarId 未指定=既定 "calendar" にフォールバック)する。
		const targetCalendarId = ev.calendarId ?? currentCalendarId ?? undefined;
		if (targetCalendarId !== undefined) args.calendarId = targetCalendarId;
		// S1(docs/modeling/14 §6 項目5): 免除トークンを confirmToken として渡す(カード発の削除は
		// ユーザーの明示操作なので propose を経ず、このトークンで delete-event のハード強制を満たす)。
		if (cardConfirmToken !== null) args.confirmToken = cardConfirmToken;
		const result = await app.callServerTool({ name: "delete-event", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		optimisticDeletes.delete(ev.id);
		pendingIds.delete(ev.id);
		// 応答は events を空にし removed(ghost)を載せる。ただし events を空にした vm をそのまま適用すると
		// 期間内の他の予定まで消えるので、削除は「確定一覧から当該行を抜く」= refresh で取り直すのが正しい。
		// delete-event 応答の removed を becoming-gone 演出に使うため、composed で refresh の events + removed を合成する。
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (refreshed.isError) {
				const first = refreshed.content?.[0];
				throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
			}
			const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
			const dsc = result.structuredContent as EventsStructuredContent | undefined;
			// mutate 成功直後の自動 refresh は becoming を消さない(§7.2。removed が空でも土台を保持)。
			applyStructuredContent(
				{
					events: rsc?.events ?? [],
					calendarId: rsc?.calendarId,
					timeZone: rsc?.timeZone,
					range: rsc?.range,
					removed: dsc?.removed,
				},
				{ preserveBecoming: true },
			);
		} catch (e) {
			// 削除自体は成功(行は既に消えている)。再読み込み失敗として degrade。
			rebuildFromConfirmed();
			renderAll();
			showBanner(`削除は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
		}
	} catch (e) {
		optimisticDeletes.delete(ev.id);
		pendingIds.delete(ev.id);
		rebuildFromConfirmed();
		renderAll();
		showBanner(`「${ev.title}」の削除に失敗しました`, () => void deleteEvent(ev));
	}
}

/**
 * 詳細編集 / インライン選択の保存(todos saveEdit と同型)。変更フィールドだけ update-event に送る。
 *   1. optimisticEdits に積み即反映 → 2. 裏で update-event → 3. 成功=確定 vm / 失敗=元値へロールバック + バナー。
 * changes が空なら no-op。時刻付き start/end のときは timeZone(閲覧デバイスの IANA ゾーン)を添える。
 */
async function saveEdit(ev: EventItem, changes: UpdateEventChanges): Promise<void> {
	if (isOptimisticId(ev.id)) return;
	if (Object.keys(changes).length === 0) return;
	// pending はマスター id 単位の直列化(row-key.ts 冒頭の二層分離)。系列の別 occurrence への
	// 連続編集はサーバー上も同一リソースなので順番待ちが正しいが、以前は無言 no-op で
	// 「編集したのに保存されない」ように見えた(2026-07-16 実機FB・§7.1)→ バナーで可視化する。
	if (pendingIds.has(ev.id)) {
		showBanner(`「${ev.title}」は保存中です。完了後にもう一度お試しください`);
		return;
	}

	// 楽観上書きを組み立てる。
	// 【反復イベントでは start/end/recurrence の楽観適用をスキップ(§7.1)】optimisticEdits は
	// マスター id キーなので rebuildDisplay が系列の全 occurrence 行に同じ値を貼る。title 等の
	// 系列共通フィールドはそれで正しいが、日時は occurrence ごとに違う(マスターの新値を全行に
	// 貼ると全 occurrence が同じ日時に潰れて壊れる)。recurrence 変更も展開行の増減を伴うので
	// クライアントでは再現できない。→ pending 表示のみで refresh の確定値を待つ。
	// 反復判定: recurrence があるか、確定一覧に同 id の occurrence が複数あるか(RRULE を外す
	// 編集の最中など recurrence フィールドだけでは拾えないケースの保険)。
	const isRecurring = ev.recurrence !== null || (confirmedEvents?.filter((t) => t.id === ev.id).length ?? 0) > 1;
	const overrides: OptimisticEdit = {};
	if (changes.title !== undefined) overrides.title = changes.title;
	if (changes.notes !== undefined) overrides.notes = changes.notes === "" ? null : changes.notes;
	if (!isRecurring && changes.start !== undefined) {
		overrides.start = changes.start;
		overrides.isAllDay = !changes.start.includes("T");
	}
	if (!isRecurring && changes.end !== undefined) overrides.end = changes.end;
	if (changes.location !== undefined) overrides.location = changes.location;
	if (changes.url !== undefined) overrides.url = changes.url;
	if (changes.alarms !== undefined) overrides.alarms = changes.alarms === null ? [] : changes.alarms;
	if (changes.travelMinutes !== undefined) overrides.travelMinutes = changes.travelMinutes;
	if (!isRecurring && changes.recurrence !== undefined) {
		overrides.recurrence =
			changes.recurrence.frequency === "none"
				? null
				: {
						frequency: changes.recurrence.frequency,
						interval: changes.recurrence.interval ?? 1,
						weekdays: changes.recurrence.weekdays ?? null,
						count: changes.recurrence.count ?? null,
						until: changes.recurrence.until ?? null,
					};
	}

	// 【2026-07-16 §7.8 悲観パス判定】判定則②(反復イベントの start/end/recurrence 変更)そのもの
	// = isRecurring かつ、この変更が実際に start/end/recurrence のどれかを含む。title/notes だけの
	// 編集は反復でも楽観(overrides に積まれる)なので、editingIds には積まない — 悲観と
	// 楽観フィールドが同一 changes に混在する場合(例: title と start を同時保存)は、start が
	// 悲観化する以上この呼び出し全体を悲観として扱う(overrides.title は楽観適用済みで見た目に
	// 反映されるが、行全体としては「保存中…」の空気を優先する判断)。
	const isPessimistic = isRecurring && (changes.start !== undefined || changes.end !== undefined || changes.recurrence !== undefined);
	if (isPessimistic) editingIds.add(ev.id);
	optimisticEdits.set(ev.id, overrides);
	startCommitting(ev.id);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();

	try {
		const args: Record<string, unknown> = { id: ev.id };
		// delete-event と同じ理由(直上コメント参照): 対象イベント自身の calendarId を優先する。
		const targetCalendarId = ev.calendarId ?? currentCalendarId ?? undefined;
		if (targetCalendarId !== undefined) args.calendarId = targetCalendarId;
		if (changes.title !== undefined) args.title = changes.title;
		if (changes.notes !== undefined) args.notes = changes.notes;
		if (changes.start !== undefined) args.start = changes.start;
		if (changes.end !== undefined) args.end = changes.end;
		if (changes.location !== undefined) args.location = changes.location;
		if (changes.url !== undefined) args.url = changes.url;
		if (changes.alarms !== undefined) args.alarms = changes.alarms;
		if (changes.travelMinutes !== undefined) args.travelMinutes = changes.travelMinutes;
		if (changes.recurrence !== undefined) args.recurrence = changes.recurrence;
		// 時刻付き start/end は timeZone 必須(update-event が DTSTART;TZID + VTIMEZONE を組む)。
		const timedStart = changes.start !== undefined && changes.start.includes("T");
		const timedEnd = changes.end !== undefined && changes.end !== null && changes.end.includes("T");
		if (timedStart || timedEnd) args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const result = await app.callServerTool({ name: "update-event", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		optimisticEdits.delete(ev.id);
		pendingIds.delete(ev.id);
		editingIds.delete(ev.id);
		// update 応答は events:[影響したマスター1件] なので、一覧全体は refresh で取り直し、becoming(affected)を合成する。
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (refreshed.isError) {
				const first = refreshed.content?.[0];
				throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
			}
			const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
			const usc = result.structuredContent as EventsStructuredContent | undefined;
			// mutate 成功直後の自動 refresh は becoming を消さない(§7.2。update 応答の affected が
			// 空でも直前の becoming 土台を持ち越す — 「URL 追加でバッジ全消え」の実装ムラ対策)。
			applyStructuredContent(
				{
					events: rsc?.events ?? [],
					calendarId: rsc?.calendarId,
					timeZone: rsc?.timeZone,
					range: rsc?.range,
					affected: usc?.affected,
				},
				{ preserveBecoming: true },
			);
		} catch (e) {
			rebuildFromConfirmed();
			renderAll();
			showBanner(`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
		}
	} catch (e) {
		optimisticEdits.delete(ev.id);
		pendingIds.delete(ev.id);
		editingIds.delete(ev.id);
		rebuildFromConfirmed();
		renderAll();
		showBanner(`「${ev.title}」の変更を保存できませんでした`, () => void saveEdit(ev, changes));
	}
}

// --- create(ドラフト行の確定 / 作成モード詳細の保存。楽観追加 → create-event → refresh 合成)------------
// create-event 応答は events:[作成した1件] のみ(範囲一覧ではない)ので、成功時は refresh-events で
// 範囲一覧を取り直し、becoming(affected:added)を合成する(update/delete と同型)。

/** 仮行を1つ積んで即描画し、裏で create-event を fire する。 */
function enqueueCreate(title: string, details: CreateDetails): void {
	const optimisticId = `optimistic:${Math.random().toString(36).slice(2)}`;
	let recurrence: RecurrenceSummary | null = null;
	if (details.recurrence !== undefined && details.recurrence.frequency !== "none") {
		recurrence = {
			frequency: details.recurrence.frequency,
			interval: details.recurrence.interval ?? 1,
			weekdays: details.recurrence.weekdays ?? null,
			count: details.recurrence.count ?? null,
			until: details.recurrence.until ?? null,
		};
	}
	optimisticRows.push({
		id: optimisticId,
		title,
		start: details.start,
		end: details.end,
		isAllDay: details.isAllDay,
		location: details.location ?? null,
		url: details.url ?? null,
		notes: details.notes === "" ? null : details.notes,
		recurrence,
		alarms: details.alarms ?? [],
		travelMinutes: details.travelMinutes ?? null,
	});
	// 【2026-07-16 §7.8】add は元々 pendingIds を使っていなかった(仮行の存在=optimisticRows 自体が
	// in-flight の目印だったため)。committing の寿命判定(wake-sweep を 1.2s で止める)には
	// startedAt が要るので、ここで初めて optimisticId を pendingIds にも積む(二重送信ガードとしては
	// 使わない — 仮行は毎回新しい乱数 id なので連打ガードの対象外。用途は committing 寿命だけ。
	// todos-entry.ts enqueueQuickAdd と同型)。
	startCommitting(optimisticId);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	announceBecoming();
	void createEventFor(optimisticId, title, details);
}

/** 仮行 optimisticId に対応する create-event を裏で実行し、成功/失敗で仮行を回収する。 */
async function createEventFor(optimisticId: string, title: string, details: CreateDetails): Promise<void> {
	try {
		const args: Record<string, unknown> = { title, start: details.start };
		// create は既存イベントを持たない(そもそも calendarId の由来行が無い)ので「カード上で
		// 選択中のコレクション」= currentCalendarId をそのまま使う。全横断表示中(null)は省略して
		// server 既定("calendar")に委ねる — 従来どおりの挙動(echo pin 修正前から null 分岐は
		// 既にここにあった。今回 currentCalendarId が null になり得るケースが増えただけ)。
		if (currentCalendarId !== null) args.calendarId = currentCalendarId;
		if (details.end !== null) args.end = details.end;
		// 時刻付き start/end は timeZone 必須。
		if (!details.isAllDay) args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (details.notes !== "") args.notes = details.notes;
		if (details.location != null && details.location.trim() !== "") args.location = details.location;
		if (details.url != null && details.url.trim() !== "") args.url = details.url;
		if (details.recurrence !== undefined) args.recurrence = details.recurrence;
		if (details.alarms !== undefined && details.alarms.length > 0) args.alarms = details.alarms;
		if (details.travelMinutes != null) args.travelMinutes = details.travelMinutes;
		// C4(設計05 §5): セミモーダルの確定値を structuredLocation / conference へ写す
		// (locationPickerToCreateArgs が空オブジェクトを返せば何も足さない=既存 location/url と独立)。
		if (details.locationValue !== undefined) {
			const locArgs = locationPickerToCreateArgs(details.locationValue ?? null);
			if (locArgs.structuredLocation !== undefined) args.structuredLocation = locArgs.structuredLocation;
			if (locArgs.conference !== undefined) args.conference = locArgs.conference;
		}
		const result = await app.callServerTool({ name: "create-event", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		// 成功: 仮行を除去(除去前に applyStructuredContent すると仮行+実行の二重表示になる)。
		removeOptimisticRow(optimisticId);
		pendingIds.delete(optimisticId);
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (refreshed.isError) {
				const first = refreshed.content?.[0];
				throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
			}
			const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
			const csc = result.structuredContent as EventsStructuredContent | undefined;
			// mutate 成功直後の自動 refresh は becoming を消さない(§7.2)。
			applyStructuredContent(
				{
					events: rsc?.events ?? [],
					calendarId: rsc?.calendarId,
					timeZone: rsc?.timeZone,
					range: rsc?.range,
					affected: csc?.affected,
				},
				{ preserveBecoming: true },
			);
		} catch (e) {
			// 追加自体は成功(仮行は除去済み)。再読み込み失敗として degrade。
			rebuildFromConfirmed();
			renderAll();
			showBanner(`追加は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
		}
	} catch (e) {
		// create-event 自体の失敗 → 仮行を除去してロールバック。再試行 = 同じ details で積み直す。
		removeOptimisticRow(optimisticId);
		pendingIds.delete(optimisticId);
		rebuildFromConfirmed();
		renderAll();
		showBanner(`「${title}」の追加に失敗しました`, () => enqueueCreate(title, details));
	}
}

// =============================================================================
// C3(設計05 §4): fullscreen 作成フォーム本体。
// =============================================================================
// 【なぜ buildDetailPage(編集用)と完全に別関数にしたか】renderAll の分岐コメント参照。
// 場所/URL 行を「場所または会議」統合トリガ(C4)へ置き換える・予定/リマインダー セグメントを足す、
// という2つの変更を編集モードへ波及させると update-event の既存契約(location/url は独立フィールド
// のまま・§8 の author 規約)を壊しかねないため、作成モードだけ新しいレンダリング経路に切り出した。
// 代償として allday/開始/終了/移動時間/繰り返し/通知/予備の通知の行組み立てコードが buildDetailPage と
// 重複するが、いずれも valueRow/buildRecurExpand/buildSingleChoiceExpand/makeSwitch という既存の
// 共有ヘルパー(ロジックはここに1つしか無い)を呼ぶだけの「行の並べ方」の重複であり、判断ロジック自体
// の二重管理にはならない(親への報告事項: 望むなら次のリファクタで両関数からの共通抽出も可能)。

/** C3: FAB から開く fullscreen 作成フォーム(旧ドラフト行モデルの後継)。 */
function buildCreatePage(d: SheetDraft): HTMLElement {
	const page = el("div", "detail-page");

	// --- ヘッダ: キャンセル / 追加(iOS モーダルシート文法。モックの「新規」中央タイトルは
	// このカードの既存詳細ページ(戻る/保存 pattern)に語彙を揃え省略した) -----------------------
	const head = el("div", "page-head");
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "link link-back";
	cancel.textContent = "キャンセル";
	cancel.setAttribute("aria-label", "作成をキャンセル");
	cancel.addEventListener("click", () => {
		draft = null;
		closeSheet();
	});
	const submit = document.createElement("button");
	submit.type = "button";
	submit.className = "link link-save";
	submit.textContent = "追加";
	submit.addEventListener("click", () => {
		const title = d.title.trim();
		if (title === "") return;
		sheetState = null;
		sheetDraft = null;
		selectedId = null;
		draft = null;
		quickAddFab.hidden = false;
		if (d.formKind === "event") {
			enqueueCreate(title, collectCreateDetails(d));
		} else {
			const details = collectTodoCreateDetails(d);
			renderAll();
			void createTodoFor(title, details);
		}
	});
	head.appendChild(cancel);
	head.appendChild(submit);
	page.appendChild(head);

	// --- セグメント(予定|リマインダー・片方向: event→todo のみ・設計05 §4)-------------------------
	const segment = el("div", "segment");
	segment.setAttribute("role", "tablist");
	const segEvent = document.createElement("button");
	segEvent.type = "button";
	segEvent.setAttribute("role", "tab");
	segEvent.setAttribute("aria-selected", String(d.formKind === "event"));
	segEvent.textContent = "予定";
	segEvent.addEventListener("click", () => {
		d.formKind = "event";
		renderAll();
	});
	const segTodo = document.createElement("button");
	segTodo.type = "button";
	segTodo.setAttribute("role", "tab");
	segTodo.setAttribute("aria-selected", String(d.formKind === "todo"));
	segTodo.textContent = "リマインダー";
	segTodo.addEventListener("click", () => {
		d.formKind = "todo";
		renderAll();
	});
	segment.appendChild(segEvent);
	segment.appendChild(segTodo);
	page.appendChild(segment);

	const body = el("div", "detail-body");

	// --- タイトル(予定/リマインダー共通)---------------------------------------------------------
	const titleInput = document.createElement("input");
	titleInput.className = "d-title";
	titleInput.type = "text";
	titleInput.value = d.title;
	titleInput.placeholder = "タイトル";
	titleInput.setAttribute("aria-label", "タイトル");
	titleInput.addEventListener("input", () => {
		d.title = titleInput.value;
	});
	body.appendChild(titleInput);

	if (d.formKind === "event") appendEventCreateFields(body, d);
	else appendTodoCreateFields(body, d);

	page.appendChild(body);

	// --- C4: 場所/会議セミモーダル(vevent 作成時のみ・カード内オーバーレイ)---------------------------
	if (d.formKind === "event" && d.locationPickerOpen) {
		page.appendChild(buildLocationDimmer(d));
		page.appendChild(buildLocationSemimodal(d));
	}

	return page;
}

/** vevent(予定)作成モードのフィールド一式(タイトル以降)。「場所または会議」統合トリガ(C4)以外は
 *  buildDetailPage の編集用フィールドと同じ並べ方(行の錨は共通ヘルパーが担う)。 */
function appendEventCreateFields(body: HTMLElement, d: SheetDraft): void {
	// 場所または会議(C4 トリガ行)。
	body.appendChild(buildLocationTriggerRow(d));

	// 終日
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "終日";
		const value = el("span", "f-value");
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.isAllDay, "終日", () => {
				d.isAllDay = !d.isAllDay;
				renderAll();
			}),
		);
		body.appendChild(row);
	}
	// 開始
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "開始";
		const value = el("span", "f-value");
		const di = document.createElement("input");
		di.className = "naked";
		di.type = "date";
		di.value = d.startDate;
		di.setAttribute("aria-label", "開始日");
		di.addEventListener("change", () => {
			d.startDate = di.value;
		});
		value.appendChild(di);
		if (!d.isAllDay) {
			const ti = document.createElement("input");
			ti.className = "naked";
			ti.type = "time";
			ti.value = d.startTime;
			ti.setAttribute("aria-label", "開始時刻");
			ti.addEventListener("change", () => {
				d.startTime = ti.value === "" ? "09:00" : ti.value;
			});
			value.appendChild(ti);
		}
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}
	// 終了
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "終了";
		const value = el("span", "f-value");
		if (d.hasEnd) {
			const di = document.createElement("input");
			di.className = "naked";
			di.type = "date";
			di.value = d.endDate;
			di.setAttribute("aria-label", "終了日");
			di.addEventListener("change", () => {
				d.endDate = di.value;
			});
			value.appendChild(di);
			if (!d.isAllDay) {
				const ti = document.createElement("input");
				ti.className = "naked";
				ti.type = "time";
				ti.value = d.endTime;
				ti.setAttribute("aria-label", "終了時刻");
				ti.addEventListener("change", () => {
					d.endTime = ti.value === "" ? "10:00" : ti.value;
				});
				value.appendChild(ti);
			}
		} else {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.hasEnd, "終了", () => {
				d.hasEnd = !d.hasEnd;
				// 【監査#2・終日イベントの既定終了日バグ】終日を ON にした直後、endDate の初期値が
				// (makeSheetDraft で) startDate と同日のことがある。サーバー(create-event.ts の
				// StartAfterEndError)は排他的終端(§3.8.2.2 I3)で end<=start を弾くため、そのまま
				// 保存すると必ず失敗する。終日は「開始+1日」を既定にする(排他的終端の慣習・
				// iOS カレンダーが「終日1日」を start=D, end=D+1 で表すのと同じ発想)。
				// 時刻付きは startTime/endTime の既定(09:00/10:00)で既に end>start が保たれるため
				// 触らない(endDate はそのまま同日でよい)。
				if (d.hasEnd && d.isAllDay && d.endDate <= d.startDate) {
					d.endDate = addDaysToDateKey(d.startDate, 1);
				}
				renderAll();
			}),
		);
		body.appendChild(row);
	}
	// 移動時間
	body.appendChild(
		valueRow("移動時間", travelLabel(d.travelMinutes), d.travelOpen, false, () => {
			d.travelOpen = !d.travelOpen;
			renderAll();
		}),
	);
	if (d.travelOpen) {
		const options = [{ value: null, label: "なし" }, ...TRAVEL_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
		body.appendChild(
			buildSingleChoiceExpand(options, d.travelMinutes, (v) => {
				d.travelMinutes = v;
				d.travelOpen = false;
				renderAll();
			}),
		);
	}
	// 繰り返し
	body.appendChild(
		valueRow("繰り返し", recurValueText(d.recurPreset, d.weekdays), d.recurOpen, d.recurPreset === "custom", () => {
			d.recurOpen = !d.recurOpen;
			renderAll();
		}),
	);
	if (d.recurOpen) body.appendChild(buildRecurExpand(d));
	// カレンダー(読み取り専用。move-event 同様このカードは複数コレクション選択 UI を持たない)。
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "カレンダー";
		const value = el("span", "f-value");
		const val = el("span", "muted");
		val.textContent = currentCalendarId ?? "";
		value.appendChild(val);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}
	// 通知
	body.appendChild(
		valueRow("通知", alarmLabel(d.alarms[0] ?? null), d.alarmOpen, false, () => {
			d.alarmOpen = !d.alarmOpen;
			renderAll();
		}),
	);
	if (d.alarmOpen) {
		const options = [{ value: null, label: "なし" }, ...ALARM_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
		body.appendChild(
			buildSingleChoiceExpand(options, d.alarms[0] ?? null, (v) => {
				if (v === null) d.alarms = [];
				else d.alarms = [v, ...(d.alarms.length > 1 ? [d.alarms[1] as number] : [])];
				d.alarmOpen = false;
				renderAll();
			}),
		);
	}
	// 予備の通知
	if ((d.alarms[0] ?? null) !== null) {
		body.appendChild(
			valueRow("予備の通知", alarmLabel(d.alarms[1] ?? null), d.alarm1Open, false, () => {
				d.alarm1Open = !d.alarm1Open;
				renderAll();
			}),
		);
		if (d.alarm1Open) {
			const options = [{ value: null, label: "なし" }, ...ALARM_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))];
			body.appendChild(
				buildSingleChoiceExpand(options, d.alarms[1] ?? null, (v) => {
					const first = d.alarms[0] as number;
					if (v === null) d.alarms = [first];
					else d.alarms = [first, v];
					d.alarm1Open = false;
					renderAll();
				}),
			);
		}
	}
	// メモ
	const notesInput = document.createElement("textarea");
	notesInput.className = "d-notes";
	notesInput.value = d.notes;
	notesInput.placeholder = "メモ";
	notesInput.setAttribute("aria-label", "メモ");
	notesInput.addEventListener("input", () => {
		d.notes = notesInput.value;
	});
	body.appendChild(notesInput);
}

/** vtodo(リマインダー)作成モードのフィールド一式(タイトル以降)。設計05 §4「リマインダー側に
 *  場所テキスト行は出さない」に従い場所関連は一切出さない。due は startDate/startTime を再利用
 *  (create-event の start と create-todo の due は同じ2形態の文字列規約なので、専用フィールドを
 *  増やさず使い回す)。 */
function appendTodoCreateFields(body: HTMLElement, d: SheetDraft): void {
	// メモ
	const notesInput = document.createElement("textarea");
	notesInput.className = "d-notes";
	notesInput.value = d.notes;
	notesInput.placeholder = "メモ";
	notesInput.setAttribute("aria-label", "メモ");
	notesInput.addEventListener("input", () => {
		d.notes = notesInput.value;
	});
	body.appendChild(notesInput);

	// 期日(due。任意なので todoHasDue トグルを持つ。時刻は常に含める — モック datetime-local に合わせる)。
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "期日";
		const value = el("span", "f-value");
		if (d.todoHasDue) {
			const di = document.createElement("input");
			di.className = "naked";
			di.type = "date";
			di.value = d.startDate;
			di.setAttribute("aria-label", "期日");
			di.addEventListener("change", () => {
				d.startDate = di.value;
			});
			const ti = document.createElement("input");
			ti.className = "naked";
			ti.type = "time";
			ti.value = d.startTime;
			ti.setAttribute("aria-label", "期日の時刻");
			ti.addEventListener("change", () => {
				d.startTime = ti.value === "" ? "18:00" : ti.value;
			});
			value.appendChild(di);
			value.appendChild(ti);
		} else {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.todoHasDue, "期日", () => {
				d.todoHasDue = !d.todoHasDue;
				renderAll();
			}),
		);
		body.appendChild(row);
	}
	// 繰り返し(due アンカー。due 無しでは選ばせない — create-todo は recurrence に due 必須)。
	if (d.todoHasDue) {
		body.appendChild(
			valueRow("繰り返し", recurValueText(d.recurPreset, d.weekdays), d.recurOpen, d.recurPreset === "custom", () => {
				d.recurOpen = !d.recurOpen;
				renderAll();
			}),
		);
		if (d.recurOpen) body.appendChild(buildRecurExpand(d));
	}
	// リスト(読み取り専用の degrade。todos カードのような複数リスト選択 UI は持たず、
	// create-todo の calendarId を省略してサーバー既定 "tasks" に委ねる — 暫定判断・親へ報告)。
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "リスト";
		const value = el("span", "f-value");
		const val = el("span", "muted");
		val.textContent = "タスク";
		value.appendChild(val);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}
	// 優先順位(iOS 準拠: 1=高 5=中 9=低)。
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "優先順位";
		const value = el("span", "f-value");
		const chips = el("div", "chips");
		const options: ReadonlyArray<{ value: number | null; label: string }> = [
			{ value: null, label: "なし" },
			{ value: 9, label: "低" },
			{ value: 5, label: "中" },
			{ value: 1, label: "高" },
		];
		for (const opt of options) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = opt.label;
			b.setAttribute("aria-pressed", String(d.todoPriority === opt.value));
			b.addEventListener("click", () => {
				d.todoPriority = opt.value;
				renderAll();
			});
			chips.appendChild(b);
		}
		value.appendChild(chips);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}
}

/** vtodo 作成の SheetDraft → create-todo 引数(タイトルは呼び出し側が別に渡す)。 */
interface TodoCreateDetails {
	notes: string;
	due: string | null;
	recurrence?: RecurArgs;
	priority: number | null;
}
function collectTodoCreateDetails(d: SheetDraft): TodoCreateDetails {
	let recurrence: RecurArgs | undefined;
	if (d.todoHasDue && d.recurPreset !== "none" && d.recurPreset !== "custom") {
		const args = presetToArgs(d.recurPreset, d.weekdays);
		if (args !== null && args.frequency !== "none") {
			if (d.recurEnd === "until" && d.until != null) args.until = d.until;
			recurrence = args;
		}
	}
	return {
		notes: d.notes.trim(),
		due: d.todoHasDue ? `${d.startDate}T${d.startTime}:00` : null,
		recurrence,
		priority: d.todoPriority,
	};
}

/** create-todo を裏で実行する(agenda カードは todo を表示しないため、events 系の楽観行/差分レンズには
 *  乗せない — 成功/失敗は aria-live(#live)とバナーだけで伝える最小実装)。 */
async function createTodoFor(title: string, details: TodoCreateDetails): Promise<void> {
	try {
		const args: Record<string, unknown> = { title };
		if (details.notes !== "") args.notes = details.notes;
		if (details.due !== null) {
			args.due = details.due;
			args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		}
		if (details.recurrence !== undefined) args.recurrence = details.recurrence;
		if (details.priority !== null) args.priority = details.priority;
		const result = await app.callServerTool({ name: "create-todo", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		liveEl.textContent = `「${title}」をリマインダーに追加しました`;
	} catch (e) {
		showBanner(`「${title}」の追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void createTodoFor(title, details));
	}
}

// =============================================================================
// C4(設計05 §5): 「場所または会議」統合トリガ行 + セミモーダル(カード内 CSS オーバーレイ)。
// =============================================================================
// WKWebView サンドボックス(全通信遮断)とは無関係の純粋な DOM/CSS モーダル(設計05 §5 冒頭コメント)。
// position:fixed で #root の外(page 全体)を覆う — fullscreen 中の #root.fullscreen-scroll は
// 内部スクロールコンテナなので、position:absolute だと入力欄をスクロールしたときにモーダルも
// 一緒に流れてしまう(モック .frame は静的デモ用の相対配置だったが、実装は実際にスクロールする
// コンテナを持つため fixed の方が iOS シートの体感に近い・要出典コメント)。

/** 「場所または会議」統合トリガ行。tap/focus でセミモーダルを開く(§5)。 */
function buildLocationTriggerRow(d: SheetDraft): HTMLElement {
	const row = el("div", "f-row location-trigger");
	row.tabIndex = 0;
	row.setAttribute("role", "button");
	row.setAttribute("aria-haspopup", "dialog");
	const label = el("span", "f-label");
	label.textContent = "場所";
	const value = el("span", "f-value");
	const iconWrap = el("span", "lt-icon");
	iconWrap.appendChild(createIcon(d.locationValue !== null ? locationPickerIconName(d.locationValue) : "map-pin"));
	const text = el("span", d.locationValue !== null ? "val" : "placeholder");
	text.textContent = d.locationValue !== null ? locationPickerLabel(d.locationValue) : "場所または会議";
	value.appendChild(iconWrap);
	value.appendChild(text);
	if (d.locationValue !== null) {
		const clear = document.createElement("button");
		clear.type = "button";
		clear.className = "lt-clear";
		clear.setAttribute("aria-label", "場所または会議をクリア");
		clear.appendChild(createIcon("x"));
		clear.addEventListener("click", (e) => {
			e.stopPropagation();
			d.locationValue = null;
			renderAll();
		});
		value.appendChild(clear);
	}
	row.appendChild(label);
	row.appendChild(value);
	const open = (): void => {
		d.locationPickerOpen = true;
		ensureKnownLocationsLoaded(d);
		renderAll();
	};
	row.addEventListener("click", open);
	row.addEventListener("focus", open);
	return row;
}

/** list-known-locations(C5)を1回だけ取得してキャッシュする(knownLocationsLoading で二重 fetch を防ぐ)。
 *  calendarId は省略する(§3「走査範囲の既定」: 省略時は owner 配下の全コレクション横断が候補として
 *  最も有用 — vevent 作成中でも過去の vtodo proximity 由来の場所を候補に含められる)。 */
function ensureKnownLocationsLoaded(d: SheetDraft): void {
	if (d.knownLocations !== null || d.knownLocationsLoading) return;
	d.knownLocationsLoading = true;
	void app
		.callServerTool({ name: "list-known-locations", arguments: {} })
		.then((result) => {
			d.knownLocationsLoading = false;
			if (result.isError) return;
			const sc = result.structuredContent as { locations?: KnownLocationView[] } | undefined;
			d.knownLocations = sc?.locations ?? [];
			if (d.locationPickerOpen) renderAll();
		})
		.catch(() => {
			// 静かに無視(既知の場所セクションは空のまま=候補ゼロとして表示。C5 は補助候補であり
			// フォーム全体を失敗させる理由にはならない)。
			d.knownLocationsLoading = false;
		});
}

/** セミモーダルの背景ディマー(タップで閉じる)。 */
function buildLocationDimmer(d: SheetDraft): HTMLElement {
	const dimmer = el("div", "loc-dimmer");
	dimmer.addEventListener("click", () => {
		d.locationPickerOpen = false;
		renderAll();
	});
	return dimmer;
}

/** セミモーダル本体(§5 の並び: 1.検索欄→2.ビデオ通話→3.既知の場所(C5)→4.検索候補(C6・スタブ))。 */
function buildLocationSemimodal(d: SheetDraft): HTMLElement {
	const modal = el("div", "loc-semimodal");
	modal.setAttribute("role", "dialog");
	modal.setAttribute("aria-label", "場所または会議");
	modal.appendChild(el("div", "loc-grabber"));

	const header = el("div", "loc-sm-header");
	const title = el("span", "loc-sm-title");
	title.textContent = "場所または会議";
	const done = document.createElement("button");
	done.type = "button";
	done.className = "loc-sm-done";
	done.textContent = "完了";
	done.addEventListener("click", () => {
		d.locationPickerOpen = false;
		renderAll();
	});
	header.appendChild(title);
	header.appendChild(done);
	modal.appendChild(header);

	const body = el("div", "loc-sm-body");

	// 1. 多相検索欄。【C6 未実装】geocode ツールが無いため入力は受け付けるだけで何も検索しない
	// (死に UI にしないため「検索候補」セクションは常時スタブ表示に留める。将来ここへ
	// debounce + `list-known-locations`/geocode 呼び出しの絞り込みを差し込む)。
	const search = el("div", "loc-sm-search");
	search.appendChild(createIcon("search"));
	const searchInput = document.createElement("input");
	searchInput.type = "text";
	searchInput.placeholder = "場所またはビデオ通話を入力";
	searchInput.setAttribute("aria-label", "場所またはビデオ通話を検索");
	search.appendChild(searchInput);
	body.appendChild(search);

	// 2. ビデオ通話 provider チップ。
	const confSection = el("div", "loc-sm-section");
	const confTitle = el("p", "loc-sm-section-title");
	confTitle.textContent = "ビデオ通話";
	confSection.appendChild(confTitle);
	const chipRow = el("div", "loc-chip-row");
	for (const provider of CONFERENCE_PROVIDERS) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "loc-chip";
		chip.textContent = provider === "Google Meet" ? "Meet" : provider;
		chip.setAttribute("aria-pressed", String(d.conferenceProviderDraft === provider));
		chip.addEventListener("click", () => {
			// 【暫定裁定(タスク指示・モック原案からの上書き)】モックは Meet/Zoom/FaceTime を
			// 選択即確定にしていたが、caldav は provider ごとの Join URL 自動生成を持たない
			// (会議 = URL 直入れ or 参照 URL と併存時は DESCRIPTION ブロック・設計05 §1-c)ため、
			// 「その他URL」と同じく全チップで URL 入力を必須にする1経路へ統一した。
			d.conferenceProviderDraft = provider;
			renderAll();
		});
		chipRow.appendChild(chip);
	}
	confSection.appendChild(chipRow);
	if (d.conferenceProviderDraft !== null) {
		const urlRow = el("div", "loc-chip-url-row");
		urlRow.appendChild(createIcon("link"));
		const urlInput = document.createElement("input");
		urlInput.type = "url";
		urlInput.placeholder = "https://...";
		urlInput.value = d.conferenceUrlDraft;
		urlInput.setAttribute("aria-label", "会議の Join URL");
		urlInput.addEventListener("input", () => {
			d.conferenceUrlDraft = urlInput.value;
		});
		const confirm = (): void => {
			const url = urlInput.value.trim();
			if (url === "") return;
			d.locationValue = { kind: "conference", provider: d.conferenceProviderDraft, url };
			d.conferenceProviderDraft = null;
			d.conferenceUrlDraft = "";
			d.locationPickerOpen = false;
			renderAll();
		};
		urlInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") confirm();
		});
		urlRow.appendChild(urlInput);
		const confirmBtn = document.createElement("button");
		confirmBtn.type = "button";
		confirmBtn.className = "loc-chip-url-confirm";
		confirmBtn.textContent = "確定";
		confirmBtn.addEventListener("click", confirm);
		urlRow.appendChild(confirmBtn);
		confSection.appendChild(urlRow);
	}
	body.appendChild(confSection);

	// 3. 既知の場所(C5)。
	const knownSection = el("div", "loc-sm-section");
	const knownTitle = el("p", "loc-sm-section-title");
	knownTitle.textContent = "既知の場所";
	knownSection.appendChild(knownTitle);
	const knownList = el("div", "loc-place-list");
	if (d.knownLocations === null) {
		const loading = el("p", "loc-sm-empty");
		loading.textContent = "読み込み中…";
		knownList.appendChild(loading);
	} else if (d.knownLocations.length === 0) {
		const empty = el("p", "loc-sm-empty");
		empty.textContent = "まだありません";
		knownList.appendChild(empty);
	} else {
		for (const loc of d.knownLocations) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "loc-place-item";
			item.appendChild(createIcon("map-pin"));
			const text = el("span", "loc-pi-text");
			const t = el("div", "loc-pi-title");
			t.textContent = loc.title;
			text.appendChild(t);
			if (loc.address !== null) {
				const sub = el("div", "loc-pi-sub");
				sub.textContent = loc.address;
				text.appendChild(sub);
			}
			item.appendChild(text);
			item.addEventListener("click", () => {
				d.locationValue = knownLocationToPickerValue(loc);
				d.locationPickerOpen = false;
				renderAll();
			});
			knownList.appendChild(item);
		}
	}
	knownSection.appendChild(knownList);
	body.appendChild(knownSection);

	// 4. 検索候補(C6・未実装のためスタブ)。geocode ツールが無いのでダミー結果は出さない
	// (死に UI を作らない・タスク指示)。
	const suggestSection = el("div", "loc-sm-section");
	const suggestTitle = el("p", "loc-sm-section-title");
	suggestTitle.textContent = "検索候補";
	suggestSection.appendChild(suggestTitle);
	const suggestNote = el("p", "loc-sm-empty");
	suggestNote.textContent = "地名検索は今後対応予定です(C6)";
	suggestSection.appendChild(suggestNote);
	body.appendChild(suggestSection);

	modal.appendChild(body);
	return modal;
}

// --- + = fullscreen 作成フォームを開く(C3: 設計05 §4)-------------------------------------
// 【vevent 作成 = fullscreen 詳細フォーム(inline quick-add は DTSTART 必須で API 契約上不成立・
// 設計05 §4 裁定)】旧実装はここで startDraft() だけを呼び「末尾にドラフト行を生やして inline 選択」
// していたが、その体験は廃止した。ただし内部的には startDraft()(draft を1件作る)→
// openCreateSheet()(sheetState.create=true で作成モード詳細ページへ即座に遷移)という**既存の2関数を
// そのまま流用**する(最小破壊: draft 変数・startDraft/openCreateSheet・commitSelection の draft 分岐は
// 一切削除しない)。この2つの呼び出しは同一 tick 内の同期呼び出しなので、startDraft() が一瞬 renderAll()
// して一覧末尾にドラフト行を描いても、直後の openCreateSheet() が sheetState を立てて再度 renderAll()
// する — ブラウザは最終状態しかペイントしないため、ユーザーにはドラフト行は一切見えず fullscreen
// フォームだけが開く(旧「FAB→ドラフト行→ⓘ→詳細ページ」の3手を1手に自動化したのと等価)。
//
// 【2026-07-18 ユーザー裁定: 浮遊 FAB(#quick-add-fab)を廃止し action-row の ⊕ へ統合】
// 押下時のロジックを triggerCreateEvent() へ抽出し、浮遊 FAB(fullscreen 限定で復活)と
// action-row の ⊕(inline)の両方から呼ぶ(todos-entry.ts の triggerQuickAdd と同じ抽出)。
// 【todos との差(報告事項)】todos の ⊕ は「折り畳み中だけ fullscreen へ昇格」だが、agenda の
// vevent 作成はそもそも inline quick-add が API 契約上成立しない(DTSTART 必須)ため、折り畳みの
// 有無に関わらず常に fullscreen 昇格を試みる(lastFoldActive 条件を課さない・設計05 §4 裁定は
// 本改訂でも変更していない)。
function triggerCreateEvent(): void {
	commitSelection();
	draft = null;
	selectedId = null;

	const openForm = (): void => {
		startDraft();
		openCreateSheet();
	};
	// 昇格を試みる(拒否/未対応ホストでも openForm 自体は行う — 作成フォームは #root 内のカード内
	// ページ遷移として inline でも成立するため、fullscreen はあくまで「全件が見える文脈」の付加価値。
	// todos-entry.ts の畳み昇格と違い、ここでは lastFoldActive 条件を課さない(⊕ を押した時点で
	// 常に作成フォームへ入る合意 — 設計05 §4「vevent 作成 = fullscreen 詳細フォーム」)。
	if (canRequestFullscreen(hostAvailableDisplayModes)) {
		app
			.requestDisplayMode({ mode: "fullscreen" })
			.then(() => {
				applyHostContext();
				openForm();
			})
			.catch(() => openForm());
	} else {
		openForm();
	}
}
quickAddFab.addEventListener("click", (e) => {
	e.stopPropagation();
	triggerCreateEvent();
});

// --- 表示カレンダーフィルタ(2026-07-22)のボタン配線 ----------------------------------------------
// 色ドットボタン: タップでドロップダウン開閉。document click(選択解除)へ伝播させない。
calFilterBtn.addEventListener("click", (e) => {
	e.stopPropagation();
	openCalMenu(!isCalMenuOpen());
});
// メニュー内クリックは document click へ伝播させない(行トグル/追加入力を選択解除と誤判定させない)。
calMenuEl.addEventListener("click", (e) => e.stopPropagation());
// 外タップ捕捉レイヤ: どこをタップしても閉じる(ポップオーバーの定石)。
calMenuOutsideEl.addEventListener("click", (e) => {
	e.stopPropagation();
	openCalMenu(false);
});

// --- グローバルクリック: 選択解除(確定)/ スワイプ露出畳み ----------------------------------------
document.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (sheetState !== null) return; // 詳細ページ表示中は一覧の選択/スワイプ処理に巻き込まない
	// 行の DOM 特定は data-key(rowKey・§7.1)。selectedId/swipeId も rowKey なので比較が揃う。
	const row = target.closest("li[data-key]") as HTMLElement | null;
	const rowId = row?.dataset.key ?? null;
	if (selectedId !== null && rowId !== selectedId) {
		commitSelection();
		draft = null;
		selectedId = null;
		renderAll();
	}
	if (swipeId !== null && rowId !== swipeId) {
		swipeId = null;
		renderAll();
	}
});

// --- 自動 refetch(refetchOnWindowFocus 相当。todos と同じ3イベント冗長張り + staleTime 間引き)----------
const maybeRefetch = (): void => {
	if (!connected) return;
	if (pendingIds.size > 0) return;
	if (Date.now() - lastFetchAt < STALE_TIME_MS) return;
	void fetchLatest()
		.then(() => renderAll())
		.catch(() => {
			// 静かに無視(ユーザー起点でないのでバナーは出さない。既存の一覧は残す)。
		});
};
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		maybeRefetch();
		// 日ビューの赤線: hidden 中に止めていたタイマーを再開し、経過分を即時反映する(復帰時に古い
		// 位置のまま次の 60 秒を待たない。main 裁定 item 5: visibilitychange に相乗り)。
		if (agendaViewMode === "day") {
			startNowLineTimer();
			renderAll();
		}
	} else {
		// バックグラウンドでは無駄な 60 秒タイマーを止める(全停止経路の 1 つ)。
		stopNowLineTimer();
	}
});
window.addEventListener("focus", maybeRefetch);
window.addEventListener("pageshow", maybeRefetch);

// 接続後、ホストが tool-result を push してくるのを待つ(5秒来なければ切り分けメッセージ)。
showStatus("接続完了・データ待ち…");
setTimeout(() => {
	if (!gotResult) showStatus("接続済みですがデータが届いていません");
	else clearStatus();
}, 5000);
