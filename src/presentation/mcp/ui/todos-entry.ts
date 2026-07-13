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
//   list-todos / refresh-todos が返す structuredContent は
//     { tasks: Task[], calendarId: string, timeZone: string }
//   で、Task = {
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

// --- UI 状態(単一の状態 → renderAll() で全描画、という素朴な一方向データフロー)-------
// フレームワークを入れない代わりに「状態はこの3つだけ・描画は renderAll() だけ」に
// 絞って予測可能にする。行単位の部分更新はしない(タスク数は個人のリマインダー規模で
// 高々数十件、全再描画で十分速い。差分更新の複雑さはバグの温床になるだけ)。
let tasks: TodoItem[] | null = null; // null = まだ一度もデータを受け取っていない(skeleton 表示)
const pendingIds = new Set<string>(); // update-todo 送信中の行(spinner+disabled 対象)
let completedOpen = false; // 完了済み <details> の開閉。再描画で閉じ戻らないよう保持する

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
		if (t.completed) s.completed.push(t);
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

/** 1行(li)を組み立てる。チェックは実 <button>(aria-pressed)にする —
 *  div+onclick だと VoiceOver がボタンとして読み上げず、キーボード操作もできないため。 */
function renderRow(task: TodoItem, todayKey: string): HTMLLIElement {
	const li = document.createElement("li");
	const isPending = pendingIds.has(task.id);
	if (task.completed) li.classList.add("done");
	if (isPending) li.classList.add("pending");

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
	const marks = priorityMarks(task.priority);
	const dueInfo = formatDue(task, todayKey);
	if (marks !== "" || dueInfo.text !== "") {
		const meta = document.createElement("div");
		meta.className = "meta";
		if (marks !== "") {
			const pri = document.createElement("span");
			pri.className = "pri";
			pri.textContent = marks;
			// 記号だけだと支援技術に「!!!」と読まれて意味不明なのでラベルを添える。
			pri.setAttribute("aria-label", marks === "!!!" ? "優先度 高" : marks === "!!" ? "優先度 中" : "優先度 低");
			meta.appendChild(pri);
		}
		if (dueInfo.text !== "") {
			const due = document.createElement("span");
			due.className = "due";
			// 完了済み行では期限切れの赤を出さない(もう済んだものに警告色は不要)。
			if (dueInfo.overdue && !task.completed) due.classList.add("overdue");
			due.textContent = dueInfo.text;
			meta.appendChild(due);
		}
		texts.appendChild(meta);
	}
	li.appendChild(texts);
	return li;
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
	const s = sectionize(tasks, todayKey);

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
	const structuredContent = r?.structuredContent as { tasks?: TodoItem[] } | undefined;
	tasks = structuredContent?.tasks ?? [];
	markUpdated();
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
	const result = await app.callServerTool({ name: "refresh-todos", arguments: {} });
	if (result.isError) {
		// ツール実行側のエラー(認可失敗・内部エラー等)。content の text を拾って投げ直す。
		const first = result.content?.[0];
		const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
		throw new Error(text);
	}
	// refresh-todos の structuredContent 契約は list-todos と同一
	//   { tasks: TodoItem[], calendarId, timeZone }
	// なので、ローカルの TodoItem をそのまま流用する(entry は application を import しない
	// 疎結合のまま — 冒頭「structuredContent の契約」コメント参照)。
	const structuredContent = result.structuredContent as { tasks?: TodoItem[] } | undefined;
	tasks = structuredContent?.tasks ?? [];
	markUpdated();
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
		// 成功 → サーバー確定値で置き換え(楽観確定はしない)。ここが失敗した場合、
		// 更新自体は成功している可能性が高いので「再読み込み失敗」として出す
		// (再試行 = fetchLatest のみ。update-todo を再送すると二重完了の恐れがある)。
		try {
			await fetchLatest();
		} catch (e) {
			showBanner(
				`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
				() => void retryFetch(),
			);
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
