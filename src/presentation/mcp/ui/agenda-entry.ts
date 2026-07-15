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
// 共有カーネル(docs/modeling/12 §4)。日付/時刻整形は todos と同一ロジック。
import { WEEKDAYS, localDateKey, wallDatePart, wallTimePart, dayDiff, weekdayOf } from "./format";
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
const appTitleEl = document.getElementById("app-title") as HTMLElement;
const rangeEl = document.getElementById("range") as HTMLElement;
const quickAddFab = document.getElementById("quick-add-fab") as HTMLButtonElement;

// =============================================================================
// 契約の写経(ローカル interface。application 層は import しない)
// =============================================================================

/** structuredContent.events の要素。event-dto.ts の Event とフィールドを一致させること。 */
interface EventItem {
	id: string;
	recurrenceId: string | null;
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
	calendarId?: string;
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
// pendingIds = mutate 送信中の行 id(in-flight の二重送信ガード + 差分レンズの degrade)。
const pendingIds = new Set<string>();

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
let selectedId: string | null = null;
// draft: FAB で生やす「まだ送信していない新規イベント行」。既定は「今日・終日」(モック A のドラフト規約)。
let draft: { id: string; title: string; notes: string } | null = null;
let swipeId: string | null = null;
// sheetState: 詳細ページ / リスト選択ページの「カード内ページ遷移」状態(list は event では move 未実装で省略)。
let sheetState: { id: string; page: "detail"; create?: boolean } | null = null;
let sheetDraft: SheetDraft | null = null;
// 選択行のタイトル/メモ入力への参照(commitSelection が renderAll 前の DOM 値を読むため renderRow がセット)。
let selTitleInput: HTMLInputElement | null = null;
let selMemoInput: HTMLInputElement | null = null;

// --- 表示用 becoming メタ(rebuildDisplay が組み立て、renderRow/announceBecoming が読む)-------------
let affectedById = new Map<string, AffectedEntry>();
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

// --- 自動 refetch のガード用状態(todos と同じ)-------------------------------------------
let connected = false;
let lastFetchAt = 0;
const STALE_TIME_MS = 2500;

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
function showBanner(msg: string, retry?: () => void): void {
	bannerEl.hidden = false;
	bannerEl.textContent = "";
	const span = document.createElement("span");
	span.textContent = msg;
	bannerEl.appendChild(span);
	if (retry) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = "再試行";
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
	// 削除ゴースト(removed 由来)は専用の form で早期 return。
	if (ghosts.some((g) => g.id === ev.id)) return renderGhostRow(ev);

	const li = document.createElement("li");
	li.dataset.id = ev.id;
	const sel = selectedId === ev.id;
	const isDraft = isDraftId(ev.id);
	const swiped = swipeId === ev.id;
	if (sel) li.classList.add("selected");
	if (swiped) li.classList.add("swiping");
	// now バー: 進行中の1本だけ accent の左バー(色は増やさない。ドラフト/仮行は判定しない)。
	if (!isDraft && !isOptimisticId(ev.id) && isInProgress(ev)) li.classList.add("now");

	// becoming 装飾の決定(未知 kind は通常描画へ degrade)。
	const aff = affectedById.get(ev.id);
	let tagText: string | null = null;
	let editPlan: EditPlan | null = null;
	if (aff !== undefined) {
		const isSync = aff.sync === true;
		if (aff.kind === "added") {
			li.classList.add("becoming-in");
			tagText = isSync ? "同期(追加)" : "追加";
			if (isOptimisticId(ev.id)) li.classList.add("inflight");
		} else if (aff.kind === "edited") {
			li.classList.add("becoming-edit");
			editPlan = planEdit(aff);
			tagText = isSync ? "同期(変更)" : editPlan.tag;
		}
	}

	const rowMain = el("div", "row-main");
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
		head.addEventListener("click", () => setSelected(ev.id));
	}

	// --- meta 行: 繰り返し ⟳ / 📍場所 / URL video / 跨ぎ日〜M/D / becoming ラベル(右端)-------------
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
	// 繰り返しバッジ(⟳ + 短い日本語。degrade 時はアイコンのみ)。日時変更表示中は出さない(情報過多回避)。
	if (ev.recurrence !== null && editPlan == null) {
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
	// URL があれば video アイコン(参加アフォーダンスの一覧側の印。詳細ページに参加行が出る)。
	if (ev.url !== null && ev.url.trim() !== "") {
		const v = el("span", "vid");
		v.appendChild(createIcon("video"));
		v.setAttribute("aria-label", "オンライン");
		meta.appendChild(v);
	}
	// 場所チップ(truncate は CSS .meta .loc)。
	if (ev.location !== null && ev.location.trim() !== "") {
		const loc = el("span", "loc");
		loc.appendChild(createIcon("map-pin"));
		loc.appendChild(document.createTextNode(` ${ev.location}`));
		loc.setAttribute("aria-label", `場所 ${ev.location}`);
		meta.appendChild(loc);
	}
	// becoming マイクロラベル(meta 右端。margin-left:auto で押し出す)。meta が空なら rowMain 直下に置く。
	const metaHasContent = meta.childElementCount > 0;
	let tagEl: HTMLElement | null = null;
	if (tagText !== null) {
		tagEl = el("span", "tag");
		tagEl.textContent = tagText;
		if (metaHasContent) meta.appendChild(tagEl);
	}
	if (meta.childElementCount > 0 || sel) head.appendChild(meta);

	rowMain.appendChild(head);
	if (tagEl !== null && !metaHasContent) rowMain.appendChild(tagEl);

	// --- trailing: 選択中の行だけ ⓘ(詳細)+ 確定ボタン(todos v3 と同一)---------------------------
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
			const latest = events?.find((t) => t.id === ev.id) ?? ev;
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

/** 削除ゴースト行(becoming-gone)。removed 由来の擬似 EventItem を「もう存在しない行」として描く:
 *  破線ボックス + 減光。時刻列は保つが操作子は置かない(削除済みに 44px タップ面を確保しない)。 */
function renderGhostRow(ev: EventItem): HTMLLIElement {
	const li = document.createElement("li");
	li.className = "becoming-gone";
	const rowMain = el("div", "row-main");
	rowMain.appendChild(renderTimeColumn(ev));
	const head = el("div", "head");
	const title = el("div", "title");
	title.textContent = ev.title;
	head.appendChild(title);
	rowMain.appendChild(head);
	const tag = el("span", "tag");
	// sync(S2): システム起因の外部削除は中立ラベル「同期(削除)」。ユーザー起因は「削除」。
	const isSyncGhost = ghosts.find((g) => g.id === ev.id)?.sync === true;
	tag.textContent = isSyncGhost ? "同期(削除)" : "削除";
	rowMain.appendChild(tag);
	li.appendChild(rowMain);
	return li;
}

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
	if (sheetState !== null) {
		const sheetTask = currentSheetEvent();
		if (sheetTask !== null && sheetDraft !== null) {
			root.innerHTML = "";
			selTitleInput = null;
			selMemoInput = null;
			root.appendChild(buildDetailPage(sheetTask, sheetDraft));
			return;
		}
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
	const baseEvents = events ?? [];
	const todayKey = localDateKey(new Date());

	// 削除ゴースト(removed)を描画用の擬似 EventItem に変換して合流(通常のセクション分けに乗せる)。
	const ghostItems: EventItem[] = ghosts.map((g) => ({
		id: g.id,
		recurrenceId: null,
		title: g.title,
		// 短文 start("YYYY-MM-DD" or "YYYY-MM-DD HH:MM")を offset なし ISO へ正規化(空白→T)。
		start: g.start === undefined ? todayKey : g.start.replace(" ", "T"),
		end: g.end === undefined ? null : g.end.replace(" ", "T"),
		isAllDay: g.isAllDay ?? (g.start === undefined || !g.start.includes(":")),
		location: g.location ?? null,
		url: null,
		notes: null,
		status: null,
		recurrence: null,
		alarms: [],
		travelMinutes: null,
	}));
	// affected の added 合成(案X 相当)。added で events に見つからない id だけ snapshot から擬似行を作る
	// (通常 added は events に実在するので不要だが、mutate 応答が events を絞る場合の保険)。
	const eventIds = new Set(baseEvents.map((t) => t.id));
	const affectedItems: EventItem[] = [];
	for (const a of affectedById.values()) {
		if (a.kind === "added" && a.event !== undefined && !eventIds.has(a.id)) {
			affectedItems.push(snapshotToItem(a.event));
		}
	}

	const sections = sectionizeByDay(baseEvents.concat(ghostItems, affectedItems));
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
		ul.appendChild(renderRow(draftToItem(draft), todayKey));
		root.appendChild(ul);
	}
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

/** setSelected: 行を選択(前の選択があれば確定 auto-save してから切替)。 */
function setSelected(id: string): void {
	if (selectedId === id) return;
	commitSelection();
	draft = null;
	selectedId = id;
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
	if (draft !== null && selectedId === draft.id) {
		const title = (inputTitle !== null ? inputTitle.value : draft.title).trim();
		const notes = inputMemo !== null ? inputMemo.value : draft.notes;
		if (title === "") return false;
		// 高速パス: 既定は「今日・終日」(モック A のドラフト規約)。詳細は作成モード詳細ページで付ける。
		enqueueCreate(title, defaultCreateDetails(notes.trim()));
		return true;
	}
	const ev = events?.find((t) => t.id === selectedId);
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
	selectedId = draft.id;
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
			if (dx < -40 && swipeId !== ev.id) {
				swipeId = ev.id;
				tracking = false;
				renderAll();
			} else if (dx > 40 && swipeId === ev.id) {
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
		swipeId = swipeId === ev.id ? null : ev.id;
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
	};
}

/** 詳細ページを開く(既存イベントの ⓘ から)。 */
function openSheet(ev: EventItem): void {
	if (isOptimisticId(ev.id)) return; // 仮行はサーバー id が無いので編集できない
	sheetDraft = makeSheetDraft(ev);
	sheetState = { id: ev.id, page: "detail" };
	closeSwipe();
	quickAddFab.hidden = true;
	renderAll();
}

/** 詳細ページを「作成モード」で開く(FAB ドラフト行の ⓘ から)。 */
function openCreateSheet(): void {
	if (draft === null) return;
	sheetDraft = makeSheetDraft(draftToItem(draft));
	sheetState = { id: draft.id, page: "detail", create: true };
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
	const id = sheetState.id;
	if (draft !== null && id === draft.id) return draftToItem(draft);
	if (events === null) return null;
	return events.find((t) => t.id === id) ?? null;
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
			selectedId = draft?.id ?? null;
			quickAddFab.hidden = false;
			renderAll();
			return;
		}
		closeSheet();
	});
	const save = document.createElement("button");
	save.type = "button";
	save.className = "link link-save";
	save.textContent = "保存";
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
 * affected/removed が無い応答では Map/配列が空になる = becoming が消える(次の描画まで、のライフサイクル)。
 */
function applyStructuredContent(sc: unknown): void {
	const structuredContent = sc as EventsStructuredContent | undefined;
	const nextEvents = structuredContent?.events ?? [];
	const serverAffected = structuredContent?.affected ?? [];
	const serverRemoved = structuredContent?.removed ?? [];

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
		for (const id of pendingIds) explained.add(id);
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
	if (structuredContent?.calendarId !== undefined) {
		currentCalendarId = structuredContent.calendarId;
		appTitleEl.textContent = currentCalendarId;
	}
	if (structuredContent?.timeZone !== undefined) currentTimeZone = structuredContent.timeZone;
	renderRangeLabel();
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
const app = new App({ name: "caldav-agenda", version: "0.1.0" });
app.ontoolresult = (r) => {
	gotResult = true;
	clearStatus();
	// list-events-expanded だけでなく create/update/delete-event 等の mutation ツールがこの UI を
	// 開いた場合もここに届く(mutation 応答には affected/removed が乗る)。共通経路 applyStructuredContent。
	void ingestStructuredContent(r?.structuredContent).then(() => renderAll());
};

showStatus("接続中…");
try {
	await app.connect();
} catch (e) {
	showStatus(`接続失敗: ${e instanceof Error ? e.message : String(e)}`);
	throw e;
}
connected = true;

/** refresh-events / list-events-expanded を呼ぶときの arguments。currentRange(期間)+ calendarId を載せる。
 *  currentRange 未受領(初回応答前)のときは range を省いて server 既定に委ねる。 */
function refreshArgs(): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (currentRange !== null) {
		args.timeMin = currentRange.from;
		args.timeMax = currentRange.to;
	}
	if (currentTimeZone !== null) args.timeZone = currentTimeZone;
	if (currentCalendarId !== null) args.calendarId = currentCalendarId;
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

/** mutate 応答の確定描画共通後処理: tasks(events)が乗っていれば適用、無ければ refresh で取り直す。 */
async function applyMutateResult(structuredContent: EventsStructuredContent | undefined, failMsg: string): Promise<void> {
	if (structuredContent?.events !== undefined) {
		applyStructuredContent(structuredContent);
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
	pendingIds.add(ev.id);
	if (selectedId === ev.id) selectedId = null;
	if (swipeId === ev.id) swipeId = null;
	if (sheetState?.id === ev.id) closeSheet();
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	liveEl.textContent = `「${ev.title}」を削除しました`;
	try {
		const args: Record<string, unknown> = { id: ev.id };
		if (currentCalendarId !== null) args.calendarId = currentCalendarId;
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
			applyStructuredContent({
				events: rsc?.events ?? [],
				calendarId: rsc?.calendarId,
				timeZone: rsc?.timeZone,
				range: rsc?.range,
				removed: dsc?.removed,
			});
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
	if (pendingIds.has(ev.id)) return;

	// 楽観上書きを組み立てる。
	const overrides: OptimisticEdit = {};
	if (changes.title !== undefined) overrides.title = changes.title;
	if (changes.notes !== undefined) overrides.notes = changes.notes === "" ? null : changes.notes;
	if (changes.start !== undefined) {
		overrides.start = changes.start;
		overrides.isAllDay = !changes.start.includes("T");
	}
	if (changes.end !== undefined) overrides.end = changes.end;
	if (changes.location !== undefined) overrides.location = changes.location;
	if (changes.url !== undefined) overrides.url = changes.url;
	if (changes.alarms !== undefined) overrides.alarms = changes.alarms === null ? [] : changes.alarms;
	if (changes.travelMinutes !== undefined) overrides.travelMinutes = changes.travelMinutes;
	if (changes.recurrence !== undefined) {
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

	optimisticEdits.set(ev.id, overrides);
	pendingIds.add(ev.id);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();

	try {
		const args: Record<string, unknown> = { id: ev.id };
		if (currentCalendarId !== null) args.calendarId = currentCalendarId;
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
		// update 応答は events:[影響したマスター1件] なので、一覧全体は refresh で取り直し、becoming(affected)を合成する。
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (refreshed.isError) {
				const first = refreshed.content?.[0];
				throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
			}
			const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
			const usc = result.structuredContent as EventsStructuredContent | undefined;
			applyStructuredContent({
				events: rsc?.events ?? [],
				calendarId: rsc?.calendarId,
				timeZone: rsc?.timeZone,
				range: rsc?.range,
				affected: usc?.affected,
			});
		} catch (e) {
			rebuildFromConfirmed();
			renderAll();
			showBanner(`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
		}
	} catch (e) {
		optimisticEdits.delete(ev.id);
		pendingIds.delete(ev.id);
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
		const result = await app.callServerTool({ name: "create-event", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		// 成功: 仮行を除去(除去前に applyStructuredContent すると仮行+実行の二重表示になる)。
		removeOptimisticRow(optimisticId);
		try {
			const refreshed = await app.callServerTool({ name: "refresh-events", arguments: refreshArgs() });
			if (refreshed.isError) {
				const first = refreshed.content?.[0];
				throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
			}
			const rsc = refreshed.structuredContent as EventsStructuredContent | undefined;
			const csc = result.structuredContent as EventsStructuredContent | undefined;
			applyStructuredContent({
				events: rsc?.events ?? [],
				calendarId: rsc?.calendarId,
				timeZone: rsc?.timeZone,
				range: rsc?.range,
				affected: csc?.affected,
			});
		} catch (e) {
			// 追加自体は成功(仮行は除去済み)。再読み込み失敗として degrade。
			rebuildFromConfirmed();
			renderAll();
			showBanner(`追加は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => void retryFetch());
		}
	} catch (e) {
		// create-event 自体の失敗 → 仮行を除去してロールバック。再試行 = 同じ details で積み直す。
		removeOptimisticRow(optimisticId);
		rebuildFromConfirmed();
		renderAll();
		showBanner(`「${title}」の追加に失敗しました`, () => enqueueCreate(title, details));
	}
}

// --- FAB(+)= 末尾にドラフト行を生やす ----------------------------------------------------
quickAddFab.addEventListener("click", (e) => {
	e.stopPropagation();
	commitSelection();
	draft = null;
	selectedId = null;
	startDraft();
});

// --- グローバルクリック: 選択解除(確定)/ スワイプ露出畳み ----------------------------------------
document.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (sheetState !== null) return; // 詳細ページ表示中は一覧の選択/スワイプ処理に巻き込まない
	const row = target.closest("li[data-id]") as HTMLElement | null;
	const rowId = row?.dataset.id ?? null;
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
	if (document.visibilityState === "visible") maybeRefetch();
});
window.addEventListener("focus", maybeRefetch);
window.addEventListener("pageshow", maybeRefetch);

// 接続後、ホストが tool-result を push してくるのを待つ(5秒来なければ切り分けメッセージ)。
showStatus("接続完了・データ待ち…");
setTimeout(() => {
	if (!gotResult) showStatus("接続済みですがデータが届いていません");
	else clearStatus();
}, 5000);
