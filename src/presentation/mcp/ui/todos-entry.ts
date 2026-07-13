// =============================================================================
// presentation/mcp/ui/todos-entry.ts — list-todos 用 MCP Apps のブラウザ向けエントリ
//                                        (バンドル前ソース / E-2 スライス① 本実装)
// =============================================================================
// 【このファイルの位置づけ】
//   scripts/build-ui-bundle.ts がこのファイルを `bun build --target=browser` で
//   単一 ESM にバンドルし、その結果(文字列)を
//   src/presentation/mcp/ui/todos-bundle.ts(自動生成・コミット対象)へ書き出す。
//   todos-app.ts はその生成物を HTML の <script type="module"> 本体にテンプレート
//   リテラル補間で埋め込むだけになる。つまりこのファイル自体は Workers 上でも DAV
//   経路でも実行されない — サーバーはビルド済みの todos-bundle.ts しか import しない。
//   あくまで「ブラウザ(サンドボックス iframe/WKWebView)で動く TS のソース」で、
//   tsc(tsconfig.ui.json)の型チェック対象・可読性のための単一ソースという役割。
//
// 【なぜ esm.sh 等の実行時 import をせず、ローカルでバンドルするか(tdr の教訓を引き継ぐ)】
//   姉妹プロジェクト tdr-concierge が同じ MCP Apps 方式を先行実装しており、そこでは
//   @modelcontextprotocol/ext-apps の App を実行時に esm.sh から import する旧実装が
//   Claude iOS で「SDK 読込失敗」を繰り返した(?bundle 付きだと zod の z.custom が
//   tree-shake で欠落、?bundle 無しだと import 自体が解決できない)。原因は「専用オリジンを
//   持たないサンドボックス iframe から見た外部 CDN import が、ホスト実装によって不安定/
//   CSP で弾かれやすい」ことで、これはホスト側のバグを踏みに行っているに等しい。公式 MCP
//   Apps の example も例外なく単一自己完結 HTML にバンドルする方式を取る。よって caldav でも
//   最初から自己完結バンドル(実行時ネットワーク import ゼロ)にする。CSP の resourceDomains
//   許可も不要になり、監査可能性も上がる(このHTMLが何を実行するかが同梱JSだけで完結)。
//
// 【DOM 前提のブラウザコードであること / 型は専用 tsconfig で解決する】
//   ここは Workers(V8 isolate・DOM 無し)ではなくブラウザで実行される前提のコード。
//   document / setTimeout 等の DOM API を使ってよい。ただし DOM lib を主 tsconfig に足すと
//   Workers 側(ES2022 lib 前提)のグローバルと衝突するため、このファイルは主 tsconfig の
//   対象から除外(tsconfig.json の exclude)し、DOM lib を持つ tsconfig.ui.json 単独で
//   型チェックする(`make check` が typecheck:ui として別レーンで回す。tdr が
//   `/// <reference lib="dom" />` を置いてプログラム全体の lib を汚染し Workers 側 tsc を
//   壊した失敗を踏まないため、参照ディレクティブは置かない)。
//
// 【外部ライブラリ import 禁止(ext-apps のみ)】
//   バンドルサイズと監査容易性のため、依存は @modelcontextprotocol/ext-apps だけに限る
//   (zod は ext-apps の内部依存として巻き込まれるがそれは意図した範囲)。UI フレームワークや
//   ユーティリティは入れず、素の DOM 操作で描画する。
//
// 【structuredContent の契約(型 import はしない = ui は末端という設計方針)】
//   list-todos / refresh-todos / create-todo / complete-todo / update-todo / delete-todo が
//   返す structuredContent は
//     { tasks: Task[], calendarId: string, timeZone: string,
//       affected?: Array<{ id, kind: "added"|"completed"|"reopened"|"edited",
//                          task?: TaskSnapshot,
//                          changes?: Array<{ field, before?, after? }> }>,
//       removed?: TaskSnapshot[],
//       view?: { includeCompleted?, dueBefore?, dueAfter? } }
//   view は list-todos/refresh-todos が echo する「この一覧はどのビューか」(非既定ビューのときだけ載る。
//   E-2 view 状態非保持バグ修正・2026-07-14)。UI は vm.view ?? {} を currentView として保持し、
//   focus refetch / mutation 後の取り直しへ同じビューを引き継ぐ(引き継がないと includeCompleted:true で
//   開いた後の再取得が既定=未完了のみに落ち、完了済みが全部消える不具合が起きていた)。
//   tasks は常に「サーバー確定の全一覧」(ステートレス)。affected/removed は mutation 系
//   だけが返す差分メタで、list/refresh には無い。UI は affected/removed が欠落していれば
//   単に通常描画する(後方互換 degrade — 古いサーバー/list 応答でも壊れない)。
//   【2026-07-13 案X: affected[].task / removed を TaskSnapshot に統一】
//   complete-todo/update-todo(status:COMPLETED)後の確定一覧 tasks は未完了ビュー
//   (includeCompleted:false)固定のため、いま完了したタスクは tasks から抜ける。
//   旧契約はこの id しか持たず、UI は tasks 側から該当行を探せないため becoming-done
//   (その場で取消線+凍結リング)を描けなかった。解決策として affected にも
//   TaskSnapshot({id,title,due?,priority?,isAllDay?})を添え、UI は tasks に無い行でも
//   snapshot から擬似行を合成して描く(旧 removed の ghost 手法を affected にも広げた)。
//   【差分メタの値の形式(todos-view-model.ts / todos-diff.ts が真実)】TaskSnapshot.due /
//   changes の before/after は生 ISO/RRULE ではなく「表示用の短い正規化文字列」:
//   due は "YYYY-MM-DD"(終日)/ "YYYY-MM-DD HH:MM"(時刻付き・空白区切り)、priority は
//   「高/中/低/なし」の表示語。長い値(notes/長い title/recurrence)は before/after を
//   省き field だけ来る(→ UI は「編集済み」バッジへ degrade)。
//   Task = {
//     id: string, title: string, completed: boolean,
//     status: "NEEDS-ACTION"|"COMPLETED"|"IN-PROCESS"|"CANCELLED"|null,
//     due: string|null("YYYY-MM-DD"(終日) or その todo 自身のゾーンの offset ISO8601
//          例 "2026-07-14T09:00:00+09:00"(時刻付き)),
//     isAllDay: boolean, priority: number(0-9, 0=未設定, iOS 準拠 1-4≈高/5≈中/6-9≈低),
//     percentComplete: number|null, completedAt: string|null, notes: string|null,
//     sortOrder: number|null }(実体は src/application/usecases/task-dto.ts の Task)。
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' ルールが「このディレクトリから
//   src/ 内の他コードへの import」を機械的に禁止しているため、application 層の Task を
//   import すると境界チェックで落ちる。ブラウザバンドルに application 層を巻き込まないための
//   意図的な疎結合であり、契約はここにコメント+ローカル interface として写経するに留める
//   (ズレたら手動テスト/実機確認で気づく前提。tdr と同じ割り切り)。
//
// 【E-2 スライス①の UI 設計(このファイルが実装する範囲)】
//   - セクション分け: 期限切れ / 今日 / 今後 / 期日なし / 完了済み(折り畳み)。
//   - 行: [丸チェック] タイトル / 優先度 !記号 + due(相対表現)。iOS リマインダーの語彙。
//   - 操作: チェックのタップで完了/再開(update-todo の status 変更)。
//   - スコープ外(②③に送る): 作成フォーム・削除・タイトル/優先度編集。
//     作成フォームを持たない理由: chat 内 UI の第一価値は「会話の流れの中で今の状態を
//     見て・完了を打つ」ことで、新規作成は自然言語(create-todo をモデルが呼ぶ)の方が
//     速い。フォームを足すと入力検証・timeZone 選択など①の外の複雑さを一気に抱え込む。
//
// 【完了操作は「楽観 pending → サーバー確定 refresh」— 楽観確定はしない(重要な判断)】
//   反復 VTODO の完了はサーバー側 D4 モデル(完了スナップショットを新 UID で切り出し、
//   マスターの due を次回 occurrence へ前進)で処理される。つまり「完了後の一覧」は
//   クライアントから予測不能(新 UID・次回 due・行の増減が起きる)。DTO に反復フラグも
//   無いため、どの行が D4 対象かも UI からは判別できない。よって
//     タップ → その行だけ pending 表示(spinner+disabled、他行は操作可)
//     → update-todo 成功 → refresh-todos でサーバー確定値を取得して全体を再描画
//   に倒す。楽観確定(即チェック塗り)をしないのは、D4 で行が変形した場合に
//   「一瞬チェックされた行が消えて別の行が現れる」チラつきの方が有害だから。
// =============================================================================

import { App } from "@modelcontextprotocol/ext-apps";

// --- 静的 DOM への参照(骨格は todos-app.ts の HTML 側にある)-----------------------
// ヘッダ・バナー・ステータス行は「一覧の状態に依らず常時ある面」なので HTML 静的骨格に
// 置き、#root だけを描画のたびに作り直す(スパイク時代は entry が createElement で
// ボタンを生やしていたが、静的なものは静的に、へ整理)。
const root = document.getElementById("root") as HTMLElement;
const updatedEl = document.getElementById("updated") as HTMLElement;
const bannerEl = document.getElementById("banner") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
// 視覚非表示の aria-live(role="status")。becoming の視覚表現と対になる音声版
// (「「牛乳を買う」を完了しました」等)。todos-app.ts の .sr-only コメント参照。
const liveEl = document.getElementById("live") as HTMLElement;

/** structuredContent.tasks の要素。型 import をしない方針のためここでローカル定義する
 *  (契約は冒頭コメント参照。task-dto.ts の Task とフィールドを一致させること)。 */
interface TodoItem {
	id: string;
	title: string;
	completed: boolean;
	status: string | null;
	due: string | null;
	isAllDay: boolean;
	priority: number;
	percentComplete: number | null;
	completedAt: string | null;
	notes: string | null;
	sortOrder: number | null;
}

/** 差分レンズ用の自己完結スナップショット(案X・2026-07-13。server.ts の TaskSnapshot と同型)。
 *  affected[].task と removed の両方がこれを使う — completed で tasks から抜けた行も、
 *  削除で tasks から消えた行も、この最小限のフィールドだけで擬似行を描き切れる。 */
interface TaskSnapshot {
	id: string;
	title: string;
	due?: string;
	priority?: string;
	isAllDay?: boolean;
}

/** affected の1要素(mutation 応答の差分メタ)。kind は既知4種だが、将来の追加に備えて
 *  string で受け、未知 kind は becoming 装飾なしの通常描画に degrade する。
 *  task: completed で tasks(未完了ビュー)から抜けた行を自己完結で描くための snapshot
 *  (案X)。added/reopened/edited でも contract 上は常に添うが、renderAll は completed かつ
 *  tasks 不在のときだけ合成に使う(他 kind は tasks に実在するので不要)。 */
interface AffectedEntry {
	id: string;
	kind: string; // "added" | "completed" | "reopened" | "edited"(既知分)
	task?: TaskSnapshot;
	changes?: Array<{ field: string; before?: string; after?: string }>;
}

// --- UI 状態(単一の状態 → renderAll() で全描画、という素朴な一方向データフロー)-------
// フレームワークを入れない代わりに「状態はこの3つだけ・描画は renderAll() だけ」に
// 絞って予測可能にする。行単位の部分更新はしない(タスク数は個人のリマインダー規模で
// 高々数十件、全再描画で十分速い。差分更新の複雑さはバグの温床になるだけ)。
let tasks: TodoItem[] | null = null; // null = まだ一度もデータを受け取っていない(skeleton 表示)
const pendingIds = new Set<string>(); // update-todo 送信中の行(spinner+disabled 対象)
let completedOpen = false; // 完了済み <details> の開閉。再描画で閉じ戻らないよう保持する
// becoming(変化の中間状態)の元データ。応答を受け取るたびに丸ごと置き換える —
// affected/removed の無い応答(list/refresh)が来れば空になり、becoming は自然に平常へ
// 戻る(「次の描画まで」というライフサイクルを別タイマー等で管理しない。状態は応答が正)。
let affectedById = new Map<string, AffectedEntry>();
let ghosts: TaskSnapshot[] = [];
// currentView(E-2 view 状態非保持バグ修正・2026-07-14): この UI が「今どのビューで一覧を
// 開いているか」。list-todos/refresh-todos の応答が echo する vm.view を保持し、後続の
// 再取得(focus refetch / mutation 後の取り直し)へ同じビューを引き継ぐ。
// 【なぜ必要か】以前 UI はビューを保持せず、refresh-todos を常に引数なし(既定=未完了のみ)で
// 叩いていた。そのため list-todos includeCompleted:true で開いた後 reopen 等で再取得すると
// 完了済みが一覧から全部消えた。currentView を保持して引き継ぐことで、開いたビューが維持される。
// 【既定判定】includeCompleted が falsy かつ dueBefore/dueAfter が無ければ「既定ビュー」。
// 既定ビューのときは mutation 後に mutate 応答 vm をそのまま描く(従来どおり)。非既定のときだけ
// refresh-todos(currentView 付き)で一覧を取り直して合成する(下の toggleTask 参照)。
interface CurrentView {
	includeCompleted?: boolean;
	dueBefore?: string;
	dueAfter?: string;
}
let currentView: CurrentView = {};
function isDefaultView(v: CurrentView): boolean {
	return !v.includeCompleted && v.dueBefore === undefined && v.dueAfter === undefined;
}
/** currentView を callServerTool の arguments(index signature 必須の Record)へ渡す形に整える。
 *  CurrentView は閉じた型で index signature を持たないため、境界の1点でだけ Record へ広げる
 *  (server.ts の toTodosToolResponse の cast と同じ「閉じた型 vs SDK の index signature」対処)。 */
function viewAsArgs(v: CurrentView): Record<string, unknown> {
	return { ...v };
}

// --- 自動 refetch のガード用状態 -------------------------------------------------
// connected: connect() 完了フラグ。初期化前の callServerTool を避ける既存規律のため、
//   focus 系リスナーはこれが true のときだけ発火させる(strict ホストでの iframe 凍結回避)。
// lastFetchAt: 直近の成功取得の時刻(ms)。staleTime ガードの基準。ontoolresult と
//   fetchLatest 成功時(markUpdated 周辺)に更新する。
let connected = false;
let lastFetchAt = 0;
// staleTime。直近取得からこの時間内の自動 refetch は skip する。2500ms の意図:
//   (1) visibilitychange/focus/pageshow を冪等に複数張るので、1回の復帰で同時多発する
//       発火を1本に間引く。
//   (2) mutation(完了/再開)後は toggleTask が fetchLatest で確定描画する。その直後に
//       focus が飛んでも二重取得しない。
//   (3) ホストが自前で app を再実行して新 ontoolresult を push するタイプのクライアントでは、
//       その push 直後の focus refetch を無駄打ちしない(push でも lastFetchAt を更新するため)。
const STALE_TIME_MS = 2500;

// --- 診断/エラー表示 ------------------------------------------------------------
// iOS WebView にはコンソールが無く「画面表示でしか」切り分けられない(スパイクの show()
// の思想を継承)。役割を2つに分ける:
//   status = 接続フェーズの進行表示(接続中…等。成功したら消す)
//   banner = 操作失敗・再読込失敗(リストを壊さずに重ねる。再試行ボタン付き)
function showStatus(msg: string): void {
	statusEl.hidden = false;
	statusEl.textContent = msg;
}
function clearStatus(): void {
	statusEl.hidden = true;
	statusEl.textContent = "";
}
/** エラーバナーを出す。retry を渡すと「再試行」ボタン付きになる。 */
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

// =============================================================================
// due の解釈と表示(相対表現)
// =============================================================================
// 【前提】due の契約(冒頭コメント): 終日は "YYYY-MM-DD"、時刻付きは「その todo 自身の
// ゾーンの offset ISO8601」。offset があるので new Date(due) で絶対時刻として正しく
// パースでき、壁時計(HH:MM)は文字列の offset より前をそのまま切り出せる。
//
// 【「今日」の基準は閲覧者のローカル日付にする(Why not: DTO の timeZone)】
// structuredContent には timeZone(サーバー側の解釈ゾーン)も来るが、セクション分けの
// 「今日/明日」は見ている人の体感に合わせるべきなので、閲覧デバイスのローカル日付を使う。
// 表示する時刻(HH:MM)だけは todo 自身のゾーンの壁時計をそのまま出す — 「9時の予定」は
// どこで見ても 9:00 と書いてある方が iOS リマインダーの表示と一致する(閲覧者ゾーンへの
// 換算表示は、ゾーンが異なるケースが実需になったら検討。①では YAGNI)。
// 日付境界の分類だけは絶対時刻ベース(下記 dayDiff)なので、ゾーン差があっても
// 「期限切れなのに今後に出る」ような実害のある誤分類はしない。

/** ローカル(閲覧デバイス)の "YYYY-MM-DD"。Date#toISOString は UTC になってしまい
 *  日本の朝などで日付がズレるため、getFullYear 系で手組みする。 */
function localDateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** due の「日付部分」("YYYY-MM-DD")。終日はそのまま、時刻付きは todo ゾーンの壁時計日付。 */
function wallDatePart(due: string): string {
	return due.slice(0, 10);
}

/** 時刻付き due の壁時計 "HH:MM"(offset ISO の T 以降先頭5文字)。 */
function wallTimePart(due: string): string {
	const t = due.split("T")[1];
	return t === undefined ? "" : t.slice(0, 5);
}

/** "YYYY-MM-DD" 同士の日数差(a - today)。両方を UTC 深夜として引き算する
 *  (ローカル深夜だと DST 切替日に ±1h ずれて日数が壊れるため UTC で計算)。 */
function dayDiff(dateKey: string, todayKey: string): number {
	const toUtc = (k: string): number => {
		const [y, m, d] = k.split("-").map(Number);
		return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
	};
	return Math.round((toUtc(dateKey) - toUtc(todayKey)) / 86_400_000);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** due を相対表現に整形する。例: 「今日 18:00」「昨日」「7/20(月)」「2027/1/5(火) 9:00」。
 *  ±1日は今日/明日/昨日、それ以外は M/D(曜)(年が違うときだけ YYYY/ を前置)。
 *  「3日後」のような日数表現は採らない — iOS リマインダーが日付+曜日で出す語彙に合わせる
 *  (日数は暗算を要求するが、曜日は生活のアンカーとしてそのまま読める)。 */
function formatDue(task: TodoItem, todayKey: string): { text: string; overdue: boolean } {
	const due = task.due;
	if (due === null) return { text: "", overdue: false };
	const dateKey = wallDatePart(due);
	const diff = dayDiff(dateKey, todayKey);

	let dayText: string;
	if (diff === 0) dayText = "今日";
	else if (diff === 1) dayText = "明日";
	else if (diff === -1) dayText = "昨日";
	else {
		const [y, m, d] = dateKey.split("-").map(Number);
		// 曜日は「その日付のローカル深夜」から取る。日付キー自体が壁時計基準なので
		// ここはゾーン換算不要(カレンダー上の曜日は世界共通)。
		const weekday = WEEKDAYS[new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay()] ?? "";
		const yearPrefix = y === new Date().getFullYear() ? "" : `${y}/`;
		dayText = `${yearPrefix}${m}/${d}(${weekday})`;
	}

	// 期限切れ判定: 終日は「日付が昨日以前」、時刻付きは絶対時刻の比較(offset ISO なので
	// new Date が正しく絶対時刻になる)。時刻付きで「今日だがもう過ぎた」は今日セクションに
	// 残しつつ赤で出す(iOS リマインダーと同じ扱い — 今日やるべきものは今日に見えるべき)。
	const overdue = task.isAllDay || !due.includes("T")
		? diff < 0
		: new Date(due).getTime() < Date.now();

	const text = task.isAllDay || !due.includes("T") ? dayText : `${dayText} ${wallTimePart(due)}`;
	return { text, overdue };
}

/** PRIORITY(0-9)→ iOS リマインダーの ! 記号(!=低 / !!=中 / !!!=高)。0=未設定は空。
 *  区分は 1-4=高 / 5=中 / 6-9=低(RFC 5545 §3.8.1.9 の A three-level scheme 解釈 +
 *  iOS が 1/5/9 を書く実測に合わせた寄せ。docs/modeling/06 参照)。 */
function priorityMarks(priority: number): string {
	if (priority <= 0) return "";
	if (priority <= 4) return "!!!";
	if (priority === 5) return "!!";
	return "!";
}

// =============================================================================
// セクション分けとソート
// =============================================================================

/** ソート用の絶対時刻キー。終日はローカル深夜(その日の先頭に来る)、時刻付きは絶対時刻、
 *  due 無しは +∞(末尾)。文字列比較にしないのは、"YYYY-MM-DD" と offset ISO が混在すると
 *  辞書順が時刻順にならないケースがあるため(例: offset が異なる2件)。 */
function dueEpoch(task: TodoItem): number {
	if (task.due === null) return Number.POSITIVE_INFINITY;
	if (!task.due.includes("T")) {
		const [y, m, d] = task.due.split("-").map(Number);
		return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime();
	}
	return new Date(task.due).getTime();
}

/** セクション内の並び: due 昇順 → sortOrder 昇順(null は末尾)→ タイトル。
 *  sortOrder(iOS の手動並べ替え X-APPLE-SORT-ORDER)を第1キーにしないのは、
 *  このビューの主目的が「期限ベースの俯瞰」だから — due が同じときだけ iOS での
 *  手動並びを尊重する、が体感と一致する(期日なしセクションでは sortOrder が実質第1キー)。 */
function compareTasks(a: TodoItem, b: TodoItem): number {
	const de = dueEpoch(a) - dueEpoch(b);
	if (de !== 0 && !Number.isNaN(de)) return de;
	const soA = a.sortOrder ?? Number.POSITIVE_INFINITY;
	const soB = b.sortOrder ?? Number.POSITIVE_INFINITY;
	if (soA !== soB) return soA < soB ? -1 : 1;
	return a.title.localeCompare(b.title, "ja");
}

interface Sections {
	overdue: TodoItem[];
	today: TodoItem[];
	upcoming: TodoItem[];
	noDue: TodoItem[];
	completed: TodoItem[];
}

/** タスクを5セクションへ振り分ける。completed 判定は DTO の completed(boolean)を正とする
 *  (status 文字列の再解釈はしない — サーバーが既に STATUS/PERCENT-COMPLETE から導出済み)。
 *  時刻付きで「今日だがもう過ぎた」は期限切れではなく今日に置く(formatDue コメント参照)。 */
function sectionize(items: TodoItem[], todayKey: string): Sections {
	const s: Sections = { overdue: [], today: [], upcoming: [], noDue: [], completed: [] };
	for (const t of items) {
		// becoming-done(いま完了した行)は完了折り畳みへ飛ばさず「その場」= due ベースの
		// 元のセクションに留める(モックの設計: 押した場所から行が消えると操作の因果が
		// 切れる)。次の応答(affected 無し)で通常どおり完了欄へ移る。
		const inPlaceDone = t.completed && affectedById.get(t.id)?.kind === "completed";
		if (t.completed && !inPlaceDone) s.completed.push(t);
		else if (t.due === null) s.noDue.push(t);
		else {
			const diff = dayDiff(wallDatePart(t.due), todayKey);
			if (diff < 0) s.overdue.push(t);
			else if (diff === 0) s.today.push(t);
			else s.upcoming.push(t);
		}
	}
	s.overdue.sort(compareTasks);
	s.today.sort(compareTasks);
	s.upcoming.sort(compareTasks);
	s.noDue.sort(compareTasks);
	// 完了済みだけは「新しく完了したものが上」(completedAt 降順)。完了直後に自分の操作の
	// 結果が折り畳みを開いた先頭に見える方が、操作→確認の導線として自然。
	s.completed.sort((a, b) => {
		const ca = a.completedAt ?? "";
		const cb = b.completedAt ?? "";
		if (ca !== cb) return ca < cb ? 1 : -1; // ISO 文字列の辞書順 = 時刻順(同一形式前提)
		return a.title.localeCompare(b.title, "ja");
	});
	return s;
}

// =============================================================================
// 描画
// =============================================================================

/** 差分メタ側の due 文字列(TaskSnapshot.due / changes の before/after)を行本体と同じ
 *  相対表現に整形する。サーバー(todos-diff.ts)は生 ISO ではなく表示用正規化
 *  「"YYYY-MM-DD"(終日)/ "YYYY-MM-DD HH:MM"(時刻付き・区切りが T でなく空白)」を
 *  渡してくる契約なので、空白を T に正規化してから formatDue に委譲する — 行本体の
 *  「明日 14:00」と差分の「2026-07-15 14:00」が別の言語になるのを防ぐ(相対化は now を
 *  持つ UI の責務、という todos-diff.ts 側の判断と対になる)。 */
function formatDueMeta(due: string, todayKey: string): string {
	const normalized = due.replace(" ", "T");
	return formatDue({ due: normalized, isAllDay: !normalized.includes("T") } as TodoItem, todayKey).text;
}

/** becoming: edited のインライン差分計画。renderRow の meta 組み立てが使う。
 *  インライン表示(旧 → 新)は before/after が揃った due / priority だけ(最大2件)。
 *  Why not title/notes/その他フィールドもインライン: 新値は行本体が既に表示しており、
 *  title の旧値まで並べると1行の情報量が壊れる。複雑な値(recurrence 等)は整形自体が
 *  未定義。よって既知2フィールド以外は「編集済み」バッジへ degrade する(契約側も
 *  changes 欠落を許すので、degrade が常に安全側の既定)。 */
interface EditPlan {
	dueChange: { before?: string; after?: string } | null;
	priChange: { before?: string; after?: string } | null;
	moreCount: number; // インラインにできなかった変更の件数(「他N件」表示)
	tag: string; // マイクロラベル文言
}

function planEdit(aff: AffectedEntry): EditPlan {
	const changes = aff.changes ?? [];
	// before/after は片側だけの場合がある(契約: due の「未設定 → 値」「値 → 未設定」は
	// 無い側のキーを省く)。少なくとも片側があればインライン表示できる(無い側は「なし」)。
	// 両側とも無い(field だけ)は表示する値が無いので badge へ degrade。
	const hasValue = (c: { before?: string; after?: string }): boolean =>
		c.before !== undefined || c.after !== undefined;
	// find で先頭1件だけ拾う = フィールドごとに最大1件・合計最大2件、を素朴に実現
	// (同一フィールドの変更が複数来る契約ではないため厳密な slice(0,2) は不要)。
	const dueChange = changes.find((c) => c.field === "due" && hasValue(c)) ?? null;
	const priChange = changes.find((c) => c.field === "priority" && hasValue(c)) ?? null;
	const inlineCount = (dueChange !== null ? 1 : 0) + (priChange !== null ? 1 : 0);
	const moreCount = changes.length - inlineCount;
	// ラベル: インライン1件ならフィールド名入り(iOS の語彙に寄せた「期日変更」)、
	// 複数なら総称「変更」、インライン0件(changes 欠落・未知フィールドのみ)は
	// 「編集済み」バッジに degrade(何が変わったかは AI の応答文が語る)。
	const tag =
		inlineCount === 0 ? "編集済み" : inlineCount === 2 ? "変更" : dueChange !== null ? "期日変更" : "優先度変更";
	return { dueChange, priChange, moreCount, tag };
}

/** 1行(li)を組み立てる。チェックは実 <button>(aria-pressed)にする —
 *  div+onclick だと VoiceOver がボタンとして読み上げず、キーボード操作もできないため。 */
function renderRow(task: TodoItem, todayKey: string): HTMLLIElement {
	// 削除ゴースト(removed 由来の擬似 TodoItem)は専用の form で早期 return
	// (チェックボタンを持たない・操作不能・破線ボックス。詳細は renderGhostRow)。
	if (ghosts.some((g) => g.id === task.id)) return renderGhostRow(task, todayKey);

	const li = document.createElement("li");
	const isPending = pendingIds.has(task.id);
	if (task.completed) li.classList.add("done");
	if (isPending) li.classList.add("pending");

	// becoming 装飾の決定。未知 kind は何も足さない(通常描画へ degrade)。
	// pending と becoming は理論上共存し得る(becoming 表示中に再タップ)が、その場合も
	// pending の spinner が circle 描画を上書きするだけで破綻しない。
	const aff = affectedById.get(task.id);
	let tagText: string | null = null;
	let editPlan: EditPlan | null = null;
	if (aff !== undefined) {
		if (aff.kind === "completed") {
			li.classList.add("becoming-done");
			tagText = "完了";
		} else if (aff.kind === "reopened") {
			li.classList.add("becoming-undone");
			tagText = "再開";
		} else if (aff.kind === "added") {
			li.classList.add("becoming-in");
			tagText = "追加";
		} else if (aff.kind === "edited") {
			li.classList.add("becoming-edit");
			editPlan = planEdit(aff);
			tagText = editPlan.tag;
		}
	}

	const check = document.createElement("button");
	check.type = "button";
	check.className = "check";
	// aria-pressed で「トグルボタン」であることを支援技術に伝える。ラベルは操作の結果を
	// 先に言う形(「〜を完了にする」)にして、押す前に何が起きるか分かるようにする。
	check.setAttribute("aria-pressed", String(task.completed));
	check.setAttribute(
		"aria-label",
		task.completed ? `「${task.title}」を未完了に戻す` : `「${task.title}」を完了にする`,
	);
	// pending 中はその行だけ disabled(spinner は CSS の li.pending .circle が描く)。
	// 他の行は操作可のまま — 連続で複数件チェックを打てる体験を守る。
	check.disabled = isPending;
	const circle = document.createElement("span");
	circle.className = "circle";
	circle.setAttribute("aria-hidden", "true");
	circle.textContent = "✓"; // 未完/pending 時は CSS が color:transparent で隠す
	check.appendChild(circle);
	check.addEventListener("click", () => void toggleTask(task));
	li.appendChild(check);

	const texts = document.createElement("div");
	texts.className = "texts";
	const title = document.createElement("div");
	title.className = "title";
	title.textContent = task.title;
	texts.appendChild(title);

	// メタ行: 優先度 !記号 + due 相対表現(あるものだけ)。notes は行内に出さない
	// (①の情報設計 — カード幅で notes まで出すと一覧の走査性が落ちる。展開 UI は②以降)。
	// becoming: edited のインライン差分があるフィールドは、通常表示の代わりに
	// 「旧(減光)→ 新(琥珀)」の凍結表示に差し替える(旧値に取消線は使わない —
	// 取消線=完了の恒久記号、の一貫性)。新値 = 行の現在値なので情報の重複はない。
	const marks = priorityMarks(task.priority);
	const dueInfo = formatDue(task, todayKey);
	const hasInline = editPlan !== null && (editPlan.dueChange !== null || editPlan.priChange !== null);
	const hasMore = editPlan !== null && editPlan.moreCount > 0;
	if (marks !== "" || dueInfo.text !== "" || hasInline || hasMore) {
		const meta = document.createElement("div");
		meta.className = "meta";

		/** 旧 → 新 のインライン差分 span 群を親に追加する小ヘルパー(due/priority 共用)。 */
		const appendDiff = (parent: HTMLElement, before: string, after: string): void => {
			const old = document.createElement("span");
			old.className = "old";
			old.textContent = before;
			const arrow = document.createElement("span");
			arrow.className = "arrow";
			arrow.textContent = "→";
			const next = document.createElement("span");
			next.className = "new";
			next.textContent = after;
			parent.appendChild(old);
			parent.appendChild(arrow);
			parent.appendChild(next);
		};

		if (editPlan?.priChange != null) {
			// 優先度の差分。サーバー(todos-diff.ts)が既に「高/中/低/なし」の表示語へ
			// 正規化して渡す契約なのでそのまま使う(! 記号へ再変換しない — 「なし → 高」の
			// ような遷移は語の方が読める。行本体の ! 記号との不一致は許容し、差分は差分の
			// 言語で語る)。片側欠落は「なし」で補う。
			const pri = document.createElement("span");
			pri.className = "pri";
			appendDiff(pri, editPlan.priChange.before ?? "なし", editPlan.priChange.after ?? "なし");
			meta.appendChild(pri);
		} else if (marks !== "") {
			const pri = document.createElement("span");
			pri.className = "pri";
			pri.textContent = marks;
			// 記号だけだと支援技術に「!!!」と読まれて意味不明なのでラベルを添える。
			pri.setAttribute("aria-label", marks === "!!!" ? "優先度 高" : marks === "!!" ? "優先度 中" : "優先度 低");
			meta.appendChild(pri);
		}

		if (editPlan?.dueChange != null) {
			// 期日の差分。overdue の赤は出さない — 差分表示中の主役は「変わったこと」で、
			// 警告色を重ねると琥珀(新値)との色の意味が濁る(次の描画から通常の赤に戻る)。
			const due = document.createElement("span");
			due.className = "due";
			appendDiff(
				due,
				editPlan.dueChange.before !== undefined ? formatDueMeta(editPlan.dueChange.before, todayKey) : "なし",
				editPlan.dueChange.after !== undefined ? formatDueMeta(editPlan.dueChange.after, todayKey) : "なし",
			);
			meta.appendChild(due);
		} else if (dueInfo.text !== "") {
			const due = document.createElement("span");
			due.className = "due";
			// 完了済み行では期限切れの赤を出さない(もう済んだものに警告色は不要)。
			if (dueInfo.overdue && !task.completed) due.classList.add("overdue");
			due.textContent = dueInfo.text;
			meta.appendChild(due);
		}

		if (editPlan !== null && editPlan.moreCount > 0) {
			// インラインにできなかった変更の存在だけ示す(内容は AI の応答文に委ねる)。
			const more = document.createElement("span");
			more.className = "more";
			more.textContent = `他${editPlan.moreCount}件`;
			meta.appendChild(more);
		}
		texts.appendChild(meta);
	}
	li.appendChild(texts);

	// becoming マイクロラベル(行右端)。装飾(リング・バー等)は支援技術に届かないが、
	// こちらは読み上げ対象のテキスト — さらに操作直後の要約は #live(aria-live)にも流す。
	if (tagText !== null) {
		const tag = document.createElement("span");
		tag.className = "tag";
		tag.textContent = tagText;
		li.appendChild(tag);
	}
	return li;
}

/** 削除ゴースト行(becoming-gone)。removed:[{id,title,due?}] 由来の擬似 TodoItem を
 *  「もう存在しない行」として描く: 破線ボックス + 減光 + 破線丸。チェックボタンは
 *  置かない(操作不能 — 削除済みに 44px タップ面を確保する意味がなく、押せそうな見た目は
 *  誤操作を誘うだけ)。丸は装飾 span のみ。取消線は使わない(完了専用の記号)。 */
function renderGhostRow(task: TodoItem, todayKey: string): HTMLLIElement {
	const li = document.createElement("li");
	li.className = "becoming-gone";

	const circle = document.createElement("span");
	circle.className = "circle";
	circle.setAttribute("aria-hidden", "true");
	li.appendChild(circle);

	const texts = document.createElement("div");
	texts.className = "texts";
	const title = document.createElement("div");
	title.className = "title";
	title.textContent = task.title;
	texts.appendChild(title);
	const dueInfo = formatDue(task, todayKey);
	if (dueInfo.text !== "") {
		const meta = document.createElement("div");
		meta.className = "meta";
		const due = document.createElement("span");
		due.className = "due";
		// overdue の赤は付けない — 削除済みタスクに警告色は無意味(もうやらなくてよい)。
		due.textContent = dueInfo.text;
		meta.appendChild(due);
		texts.appendChild(meta);
	}
	li.appendChild(texts);

	const tag = document.createElement("span");
	tag.className = "tag";
	tag.textContent = "削除";
	li.appendChild(tag);
	return li;
}

/** snapshot(表示用短文 due)→ 描画用擬似 TodoItem。ghost 変換(renderAll のゴースト経路)と
 *  同じ due 正規化(空白→T)を行う。案X の核心: completed で tasks(未完了ビュー)から抜けた
 *  行を、この擬似 TodoItem として tasks に合流させ、sectionize の inPlaceDone 判定・
 *  renderRow の becoming-done 描画にそのまま乗せる。 */
function snapshotToItem(snap: TaskSnapshot, completed: boolean): TodoItem {
	const due = snap.due === undefined ? null : snap.due.replace(" ", "T");
	return {
		id: snap.id,
		title: snap.title,
		completed,
		status: completed ? "COMPLETED" : null,
		due,
		isAllDay: snap.isAllDay ?? (due !== null && !due.includes("T")),
		// priority は snapshot では表示語("高")だが TodoItem.priority は数値。becoming-done の
		// 一過性フレームでは ! 記号は主役でないので 0(記号なし)にする。次応答で通常経路に戻る。
		priority: 0,
		percentComplete: null,
		completedAt: null,
		notes: null,
		sortOrder: null,
	};
}

/** セクション1つ(見出し + ul)を root に追加する。空セクションは描画しない
 *  (「期限切れ 0件」を毎回見せる意味がなく、カードの縦寸だけ食うため)。 */
function appendSection(
	parent: HTMLElement,
	className: string,
	heading: string,
	items: TodoItem[],
	todayKey: string,
): void {
	if (items.length === 0) return;
	const section = document.createElement("section");
	section.className = className;
	const h = document.createElement("h2");
	h.textContent = heading;
	section.appendChild(h);
	const ul = document.createElement("ul");
	for (const t of items) ul.appendChild(renderRow(t, todayKey));
	section.appendChild(ul);
	parent.appendChild(section);
}

/** 全体描画。tasks(状態)から root を作り直す唯一の関数(一方向データフロー)。 */
function renderAll(): void {
	if (tasks === null) {
		renderSkeleton();
		return;
	}
	root.innerHTML = "";
	const todayKey = localDateKey(new Date());
	// 削除ゴースト(removed)は tasks にもう存在しないので、描画用の擬似 TodoItem に
	// 変換して合流させる。due からソート位置が決まる(due 無しは期日なしセクション)ため、
	// 専用の置き場を作らず通常のセクション分け・ソートにそのまま乗せるのが最小実装
	// (renderRow 側が ghost 判定して becoming-gone の見た目に切り替える)。
	const ghostItems: TodoItem[] = ghosts.map((g) => {
		// removed.due はサーバー整形済みの "YYYY-MM-DD" / "YYYY-MM-DD HH:MM"(空白区切り)。
		// tasks 側の due("T" 区切り ISO)と同じ経路(dueEpoch/formatDue)に乗せるため
		// T へ正規化する(offset は無いが、ソート位置と表示にはローカル解釈で十分)。
		const due = g.due === undefined ? null : g.due.replace(" ", "T");
		return {
			id: g.id,
			title: g.title,
			completed: false, // 完了折り畳みには絶対入れない(削除と完了の form を混ぜない)
			status: null,
			due,
			isAllDay: due !== null && !due.includes("T"),
			priority: 0,
			percentComplete: null,
			completedAt: null,
			notes: null,
			sortOrder: null,
		};
	});
	// affected の completed 合成(案X)。completed は tasks の未完了ビューから抜けるので、
	// tasks に見つからない id だけ snapshot から擬似行を作って合流させる。added/reopened/edited は
	// tasks に実在するので合成不要(既に tasks 側の行が becoming 装飾を受け取る)。
	const taskIds = new Set(tasks.map((t) => t.id));
	const affectedItems: TodoItem[] = [];
	for (const a of affectedById.values()) {
		if (a.kind === "completed" && a.task !== undefined && !taskIds.has(a.id)) {
			affectedItems.push(snapshotToItem(a.task, true));
		}
	}
	const s = sectionize(tasks.concat(ghostItems, affectedItems), todayKey);

	const activeCount = s.overdue.length + s.today.length + s.upcoming.length + s.noDue.length;
	if (activeCount === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		// 完了操作で全部消えた直後は達成を短く言祝ぐ(iOS の「すべて完了しました」の語彙)。
		// 完了済みが1件も無い純粋な空とは文言を分ける — 前者は達成、後者はただの空。
		empty.textContent = s.completed.length > 0 ? "すべて完了しました" : "タスクはありません";
		root.appendChild(empty);
	}

	appendSection(root, "sec-overdue", "期限切れ", s.overdue, todayKey);
	appendSection(root, "sec-today", "今日", s.today, todayKey);
	appendSection(root, "sec-upcoming", "今後", s.upcoming, todayKey);
	appendSection(root, "sec-nodue", "期日なし", s.noDue, todayKey);

	// 完了済みは <details> で折り畳み(既定閉)。開閉状態は completedOpen に保持し、
	// 再描画(refresh 確定描画)で勝手に閉じ戻らないようにする — 完了操作直後に
	// 「開いて確認していた折り畳みが閉じる」のは操作を疑わせる悪い挙動。
	if (s.completed.length > 0) {
		const details = document.createElement("details");
		details.className = "sec-completed";
		details.open = completedOpen;
		details.addEventListener("toggle", () => {
			completedOpen = details.open;
		});
		const summary = document.createElement("summary");
		summary.textContent = `完了済み(${s.completed.length}件)`;
		details.appendChild(summary);
		const ul = document.createElement("ul");
		for (const t of s.completed) ul.appendChild(renderRow(t, todayKey));
		details.appendChild(ul);
		root.appendChild(details);
	}
}

/** 読込中スケルトン(行の影3本)。「(リマインダーはありません)」等のテキスト点滅より
 *  レイアウトの予告になり体感が安定する(todos-app.ts の .skel コメント参照)。 */
function renderSkeleton(): void {
	root.innerHTML = "";
	// 3本 = 「複数行のリストが来る」ことを示す最小本数。幅を段々短くして
	// 実在のリストらしく見せる(全部同じ幅だとローディングバーに見える)。
	for (const width of ["70%", "55%", "62%"]) {
		const row = document.createElement("div");
		row.className = "skel";
		const circle = document.createElement("div");
		circle.className = "skel-circle";
		row.appendChild(circle);
		const line = document.createElement("div");
		line.className = "skel-line";
		line.style.width = width;
		row.appendChild(line);
		root.appendChild(row);
	}
}

/** ヘッダの「最終更新 HH:mm」を今にする(成功データを受け取ったときだけ呼ぶ)。
 *  併せて staleTime ガードの基準 lastFetchAt も更新する — 「成功取得の時刻」という意味が
 *  markUpdated と完全に一致するため、更新点を1箇所に集約して取りこぼしを防ぐ
 *  (ontoolresult の push・fetchLatest の両方がこの関数を通る)。 */
function markUpdated(): void {
	lastFetchAt = Date.now();
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	updatedEl.textContent = `最終更新 ${hh}:${mm}`;
}

// =============================================================================
// structuredContent の取り込み(全応答共通の唯一の入口)
// =============================================================================

/** 応答の structuredContent の形(冒頭コメントの契約を型に写経したもの)。 */
interface TodosStructuredContent {
	tasks?: TodoItem[];
	affected?: AffectedEntry[];
	removed?: TaskSnapshot[];
	// view echo(E-2 view 状態非保持バグ修正)。list-todos/refresh-todos が「この一覧はどのビューか」を
	// 返す(非既定ビューのときだけ載る)。mutate 系は view を載せない(既定ビューのまま=仕様3)。
	view?: CurrentView;
}

/**
 * 応答を状態に反映する唯一の関数。ontoolresult / fetchLatest / mutation 成功の
 * 3経路すべてがここを通ることで、「tasks と becoming メタは常に同じ応答のペア」という
 * 不変条件を守る(別々に更新すると、古い affected が新しい tasks に重なる事故が起きる)。
 * affected/removed が無い応答では Map/配列が空になる = becoming が消える(状態コメント参照)。
 */
function applyStructuredContent(sc: unknown): void {
	const structuredContent = sc as TodosStructuredContent | undefined;
	tasks = structuredContent?.tasks ?? [];
	affectedById = new Map(
		(structuredContent?.affected ?? []).map((a) => [a.id, a]),
	);
	ghosts = structuredContent?.removed ?? [];
	// currentView を「描画に使った vm の view」で更新する(vm.view ?? {})。E-2 view 状態非保持
	// バグ修正の要。list-todos/refresh-todos 応答は view を echo するのでビューが維持され、
	// mutate 応答(view 無し)を直接適用するのは既定ビューのときだけ(toggleTask の分岐参照)なので
	// {} へ戻っても既に既定=無害。非既定ビューでの mutation は refresh-todos で view を保った
	// 合成 vm を渡してくるため、ここで currentView が誤って既定に落ちることはない。
	currentView = structuredContent?.view ?? {};
	markUpdated();
	announceBecoming();
}

/**
 * affected/removed から操作結果の読み上げ文を組み立てて aria-live(#live)へ流す。
 * becoming の視覚表現(リング・破線等)は装飾でしかなくスクリーンリーダーに届かないため、
 * 音声版はテキストで別途明示する。文言は iOS の完了読み上げに寄せた短い述語形。
 * becoming が無い応答では空文字にする(前回の読み上げ文が残っていると、フォーカス移動で
 * 再読されるホストがあるため明示的に消す)。
 */
function announceBecoming(): void {
	const parts: string[] = [];
	for (const a of affectedById.values()) {
		// タイトルは tasks 側から優先して引き、無ければ a.task(案X の snapshot)から補う。
		// completed は tasks(未完了ビュー)から抜けるため、a.task フォールバックが無いと
		// completed の読み上げだけ静かに欠落していた(2026-07-13 修正)。それでも無ければ
		// (サーバーのバグ等の不整合)読み上げだけ静かにスキップする。
		const title = tasks?.find((t) => t.id === a.id)?.title ?? a.task?.title;
		if (title === undefined) continue;
		const verb =
			a.kind === "added"
				? "追加しました"
				: a.kind === "completed"
					? "完了しました"
					: a.kind === "reopened"
						? "未完了に戻しました"
						: a.kind === "edited"
							? "変更しました"
							: null;
		if (verb === null) continue; // 未知 kind は視覚同様 degrade(何も読まない)
		parts.push(`「${title}」を${verb}`);
	}
	for (const g of ghosts) parts.push(`「${g.title}」を削除しました`);
	liveEl.textContent = parts.join("。");
}

// =============================================================================
// サーバーとのやりとり
// =============================================================================

// 初期表示: ontoolresult 発火前の空白防止としてスケルトンを出す。iOS WebView には
// コンソールが無く「画面表示でしか」切り分けられないため、tdr と同じく接続中/接続失敗/
// 結果未達の3段階を status 行に出して実機デバッグしやすくする(リスト領域は壊さない)。
renderSkeleton();

let gotResult = false;
const app = new App({ name: "caldav-todos", version: "0.2.0" });
// ハンドラは connect 前に登録する(登録前に来た通知を取りこぼさないため。SDK 推奨。
// ext-apps は「connect 完了後の登録」を警告する _assertHandlerTiming を持つ)。
app.ontoolresult = (r) => {
	gotResult = true;
	clearStatus();
	// list-todos だけでなく create-todo 等の mutation ツールがこの UI を開いた場合も
	// ここに届く。mutation 応答には affected/removed が乗っており、初回描画から
	// becoming(「いま追加された」等)を表現できる — applyStructuredContent が共通処理。
	applyStructuredContent(r?.structuredContent);
	renderAll();
};

showStatus("接続中…");
try {
	await app.connect();
} catch (e) {
	// connect 失敗はこの iframe 内からは再試行できない(ハンドシェイクはホスト起点)ため、
	// 再試行ボタンは付けず事実だけ出す。ユーザー側の復旧手段は「ツールをもう一度呼ぶ」。
	showStatus(`接続失敗: ${e instanceof Error ? e.message : String(e)}`);
	throw e;
}
// connect 成功。以降は callServerTool を叩いてよい(focus 系リスナーの発火条件にする)。
connected = true;

/**
 * refresh-todos を呼んで状態をサーバー確定値で置き換える共通経路。
 * 主に完了/再開の mutation 後の確定描画から使う(手動再読込ボタンは廃止した)。
 * 失敗(transport 例外 / isError)はどちらも Error として投げ、表示は呼び出し側に任せる
 * (呼び出し起点で出したい文言・再試行導線が違うため、ここでは表示しない)。
 *
 * 【refresh-todos の性質(server.ts 側コメントの要約)】visibility:["app"] の UI 専用
 * ツールで、handler は list-todos と同一(既定: 未完了のみ…ではなく全 undefined 引数の
 * 既定動作)。この呼び出しはホストが本体 MCP サーバーへプロキシし、会話 transcript には
 * 出ない(tdr で claude.ai Web は確認済み)。
 */
async function fetchLatest(): Promise<void> {
	// E-2 view 状態非保持バグ修正・2026-07-14: 引数に currentView を渡す。以前は空 object 固定で、
	// includeCompleted:true 等で開いたビューでも既定(未完了のみ)に取り直してしまい完了済みが
	// 消えていた。currentView(直近の list/refresh 応答が echo した vm.view)を渡すことで、開いた
	// ビューのまま最新化する。currentView が既定 {} なら従来どおり既定ビューになる(後方互換)。
	const result = await app.callServerTool({ name: "refresh-todos", arguments: viewAsArgs(currentView) });
	if (result.isError) {
		// ツール実行側のエラー(認可失敗・内部エラー等)。content の text を拾って投げ直す。
		const first = result.content?.[0];
		const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
		throw new Error(text);
	}
	// refresh-todos の structuredContent 契約は list-todos と同一
	//   { tasks: TodoItem[], calendarId, timeZone }(affected/removed は無し)
	// なので、共通の取り込み経路を通す。affected/removed が無い応答を適用すると
	// becoming メタが空になる = 表示中の becoming は平常へ戻る(それが「次の描画まで」の
	// 正しいライフサイクル。focus refetch で差分表示が流れるのは意図どおり)。
	applyStructuredContent(result.structuredContent);
}

/** エラーバナーの「再試行」から使う再取得。手動再読込ボタンは廃止したが、mutation 後の
 *  確定 refresh が失敗したときの復旧導線としてバナー上の再試行は残す(fetchLatest のみ叩く
 *  = update-todo は再送しない。二重完了を避けるため — toggleTask のコメント参照)。 */
async function retryFetch(): Promise<void> {
	clearBanner();
	try {
		await fetchLatest();
		renderAll();
	} catch (e) {
		showBanner(
			`再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
			() => void retryFetch(),
		);
	}
}

/**
 * 完了/再開のトグル本体。設計は「楽観 pending → サーバー確定 refresh」(冒頭コメント):
 *   1. その行だけ pending(spinner+disabled)にして再描画 — チェックの見た目は変えない
 *      (楽観確定しない。D4 反復完了で一覧が予測不能に変形するため)。
 *   2. update-todo で STATUS を遷移(完了→NEEDS-ACTION / 未完→COMPLETED)。
 *      反復 VTODO への COMPLETED はサーバーが D4 で処理する(UI は反復を判別しないし、
 *      判別する必要もない設計 — DTO に反復フラグが無い現契約への適応でもある)。
 *   3. 成功したら refresh-todos でサーバー確定値を取得し全体を再描画。
 *
 * 【update-todo は通常ツール(visibility 制限なし)である点】ext-apps の app.d.ts は
 * callServerTool を「originating MCP server のツールをホスト経由で呼ぶ」とだけ定義しており
 * app 可視ツール限定という制約は型・doc に無い(@throws は host rejection の可能性のみ示唆)。
 * もし実機でホストが app 非可視ツールの呼び出しを拒否したら、サーバー側に app 専用ラッパー
 * (set-todo-status 等)を足す判断になる — その場合もこの関数のツール名を差し替えるだけ。
 */
async function toggleTask(task: TodoItem): Promise<void> {
	// 二重タップ防御(disabled にしているが、描画反映前の連打はここで弾く)。
	if (pendingIds.has(task.id)) return;
	pendingIds.add(task.id);
	clearBanner();
	renderAll(); // 当該行が spinner+disabled になる(他行は操作可のまま)

	try {
		const result = await app.callServerTool({
			name: "update-todo",
			arguments: {
				id: task.id,
				status: task.completed ? "NEEDS-ACTION" : "COMPLETED",
			},
		});
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功 → サーバー確定値で置き換え(楽観確定はしない)。
		// 【E-2 ② での変更】update-todo の structuredContent 自体が「サーバー確定の全一覧
		// + affected(completed/reopened の becoming メタ)」を返す契約になったため、
		// tasks が乗っていればそれをそのまま確定描画に使い、追加の refresh-todos は呼ばない。
		// Why not 従来どおり refresh を挟む: refresh 応答には affected が無いので、
		// せっかくの becoming(凍結リング)が届いた瞬間に消えてしまう。ネットワーク1往復の
		// 節約にもなる。tasks が無い応答(旧サーバー等)のときだけ従来の refresh に degrade。
		const structuredContent = result.structuredContent as TodosStructuredContent | undefined;
		if (structuredContent?.tasks !== undefined) {
			if (isDefaultView(currentView)) {
				// 既定ビュー(未完了のみ・期間絞りなし): mutate 応答の tasks は未完了ビュー固定で
				// currentView と一致するため、そのまま確定描画に使う(従来どおり + becoming が乗る)。
				applyStructuredContent(structuredContent);
			} else {
				// 【E-2 view 状態非保持バグ修正・2026-07-14】非既定ビュー(例 includeCompleted:true):
				// mutate 応答の tasks は「未完了ビュー固定」で currentView と矛盾する(完了済みが
				// 全部消える)。よって tasks は refresh-todos(currentView 付き)で取り直し、mutate 応答の
				// affected/removed(becoming 演出用)だけを保持して合成する。
				// 【becoming の見え方】completed の affected は includeCompleted:true ビューでは tasks に
				// 実在するので、renderRow の inPlaceDone 判定でその場の行に取消線 becoming が乗る
				// (未完了ビューでは snapshot 合成で描いていた行が、ここでは本物の tasks 行になる)— これが正しい。
				try {
					const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: viewAsArgs(currentView) });
					if (refreshed.isError) {
						const first = refreshed.content?.[0];
						const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
						throw new Error(text);
					}
					const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
					// 合成 vm: 一覧 tasks + view は refresh(currentView)側、becoming メタ(affected/removed)は
					// mutate 応答側。view を引き継ぐことで applyStructuredContent が currentView を維持する。
					const composed: TodosStructuredContent = {
						tasks: rsc?.tasks ?? [],
						view: rsc?.view,
						affected: structuredContent.affected,
						removed: structuredContent.removed,
					};
					applyStructuredContent(composed);
				} catch (e) {
					// 取り直し失敗 → 既存の「再読み込み失敗」バナー経路へ degrade(mutate 自体は成功して
					// いるので操作結果は失わない。再試行は fetchLatest のみ = update-todo は再送しない)。
					showBanner(
						`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
						() => void retryFetch(),
					);
				}
			}
		} else {
			// degrade 経路。ここが失敗した場合、更新自体は成功している可能性が高いので
			// 「再読み込み失敗」として出す(再試行 = fetchLatest のみ。update-todo を
			// 再送すると二重完了の恐れがある)。
			try {
				await fetchLatest();
			} catch (e) {
				showBanner(
					`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		}
	} catch (e) {
		// update-todo 自体の失敗(transport / isError)。行は元の状態のまま残る
		// (楽観確定していないので巻き戻し処理が不要 — この設計のもう一つの利点)。
		showBanner(
			`「${task.title}」の更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
		);
	} finally {
		pendingIds.delete(task.id);
		renderAll();
	}
}

// --- 自動 refetch(refetchOnWindowFocus 相当)------------------------------------
// 【なぜ app 駆動の refetch を入れるか(2026-07-13 調査で確定)】
//   MCP Apps 仕様は「ホストが再描画/再読込時に tool を再実行して新しい ontoolresult を
//   push すること」を保証していない — 保証されるのは初回 ontoolresult の1回だけで、以降の
//   リフレッシュは callServerTool による app 駆動が仕様の想定パターン。ホストが自前で
//   更新してくれるかはクライアント依存で揺れる。caldav の品質基準(最も気難しいクライアントで
//   動く汎用サーバー)に照らし、ホストの善意に頼らず app 側から明示的に取り直す。
//   これは TanStack Query の refetchOnWindowFocus と同じ発想 — カードが会話に戻るたび最新に。
//
// 【なぜイベントを3つ冗長に張るか】
//   サンドボックス iframe / WKWebView ではどのイベントが発火するかがホスト実装依存。
//   visibilitychange(タブ/カード可視化)・focus(ウィンドウ復帰)・pageshow(bfcache 復帰)を
//   全部張り、実体は maybeRefetch() 1本に集約して冪等にする(多重発火は staleTime が吸収)。
const maybeRefetch = (): void => {
	// connect 前は callServerTool を叩かない(初期化前呼び出しで iframe が凍る既存規律)。
	if (!connected) return;
	// mutation 進行中は取り直さない。pending 中に一覧が入れ替わると、操作中の行が消えたり
	// spinner の対象が別タスクにズレる事故になる(toggleTask 完了時の fetchLatest に任せる)。
	if (pendingIds.size > 0) return;
	// staleTime ガード: 直近取得から STALE_TIME_MS 以内は skip(多重イベント/mutation 直後/
	// ホスト自前更新との二重取得を防ぐ。定数のコメント参照)。
	if (Date.now() - lastFetchAt < STALE_TIME_MS) return;
	// 自動 refetch の失敗は握りつぶす(ユーザー起点でないのでバナーは出さない=既存データ維持)。
	// fetchLatest が成功すれば markUpdated 経由で lastFetchAt が進み、次の連打も抑止される。
	void fetchLatest()
		.then(() => renderAll())
		.catch(() => {
			// 静かに無視。次の focus で再挑戦されるし、既存の一覧はそのまま残す。
		});
};
document.addEventListener("visibilitychange", () => {
	// 不可視化(visibilitychange で hidden へ)では何もしない。可視化した瞬間だけ取り直す。
	if (document.visibilityState === "visible") maybeRefetch();
});
window.addEventListener("focus", maybeRefetch);
window.addEventListener("pageshow", maybeRefetch);

// 接続後、ホストが initialized を受けて tool-result を push してくるのを待つ。
// 一定時間来なければ「接続はできたがホストが inline へ結果を送っていない」と切り分ける
// (この間もスケルトンは出続けるので、ユーザーには読込中に見える)。
showStatus("接続完了・データ待ち…");
setTimeout(() => {
	if (!gotResult) {
		showStatus("接続済みですがデータが届いていません");
	} else {
		clearStatus();
	}
}, 5000);
