// =============================================================================
// presentation/mcp/ui/todos-entry.ts — list-todos 用 MCP Apps のブラウザ向けエントリ
//                                        (バンドル前ソース)
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
//   list-todos が返す structuredContent は
//     { tasks: Task[], calendarId: string, timeZone: string }
//   で、Task = {
//     id: string, title: string, completed: boolean, status: string|null,
//     due: string|null("YYYY-MM-DD"(終日) or ISO8601(時刻付き)),
//     isAllDay: boolean, priority: number(0-9, 0=未設定, iOS 準拠 1=高/5=中/9=低),
//     percentComplete: number|null, completedAt: string|null, notes: string|null,
//     sortOrder: number|null }(実体は src/application/usecases/task-dto.ts の Task)。
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' ルールが「このディレクトリから
//   src/ 内の他コードへの import」を機械的に禁止しているため、application 層の Task を
//   import すると境界チェックで落ちる。ブラウザバンドルに application 層を巻き込まないための
//   意図的な疎結合であり、契約はここにコメント+ローカル interface として写経するに留める
//   (ズレたら手動テスト/実機確認で気づく前提。tdr と同じ割り切り)。
// =============================================================================

import { App } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("root") as HTMLElement;

// --- 再読み込みボタン(E-2 スライス②)-----------------------------------------
// 【なぜ root の外(document.body 直下)に置くか】
//   render() は root.innerHTML = "" で中身を作り直す。ボタンを root 内に入れると
//   再描画のたびに消えて再生成が要る。ボタンは「一覧の状態に依らず常時ある操作」なので
//   root とは独立に body 直下へ置き、render() の破壊的更新から切り離す。
// 【初期は disabled にする理由】
//   App.callServerTool は connect(ui/initialize ハンドシェイク)完了前に呼ぶと strict でない
//   ホストでも警告になり、strict ホストでは iframe が固まりうる(app.d.ts の _assertInitialized
//   コメント / claude-ai-mcp#61・#149 参照)。connect 成功後に enable して「押して即エラー」を防ぐ。
const refreshButton = document.createElement("button");
refreshButton.id = "refresh";
refreshButton.type = "button";
refreshButton.textContent = "再読み込み";
refreshButton.disabled = true; // connect 完了まで押させない(上記コメント)。
document.body.insertBefore(refreshButton, root);

/** 診断/空表示など「リスト以外の一行メッセージ」を出す。ontoolresult 前や失敗時に使う。 */
function show(msg: string): void {
	root.className = "empty";
	root.textContent = msg;
}

/** structuredContent.tasks の要素。型 import をしない方針のためここでローカル定義する
 *  (契約は上記コメント参照。task-dto.ts の Task とフィールドを一致させること)。 */
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

/** PRIORITY(0-9)を iOS リマインダー準拠のラベルに写像する。0=未設定は空文字(バッジ非表示)。
 *  iOS は 1=高/5=中/9=低の3段階(「緊急」段階は無い)で、その間の値も丸めて表示する。
 *  スパイクなので厳密な境界には拘らず、1-4=高 / 5=中 / 6-9=低 の素朴な区分にする。 */
function priorityLabel(priority: number): string {
	if (priority <= 0) return "";
	if (priority <= 4) return "高";
	if (priority === 5) return "中";
	return "低";
}

/** due 文字列(終日 "YYYY-MM-DD" or 時刻付き ISO8601)を表示用に軽く整形する。
 *  スパイクなのでロケール変換等はせず、時刻付きは "T" 以降の秒とタイムゾーンを
 *  素朴に落として "YYYY-MM-DD HH:MM" 風にするだけ(厳密な表示は後続スライスで詰める)。 */
function formatDue(due: string | null, isAllDay: boolean): string {
	if (due === null) return "";
	if (isAllDay) return due;
	// 時刻付き: "2026-07-13T09:00:00+09:00" → "2026-07-13 09:00"。
	// 正規表現に頼らず split で素朴に切る(壊れた入力でも例外を投げないよう防御的に)。
	const [datePart, timePart] = due.split("T");
	if (timePart === undefined) return datePart ?? due;
	const hhmm = timePart.slice(0, 5);
	return `${datePart} ${hhmm}`;
}

function render(tasks: TodoItem[]): void {
	if (!Array.isArray(tasks) || tasks.length === 0) {
		show("(リマインダーはありません)");
		return;
	}

	root.className = "";
	root.innerHTML = "";
	const ul = document.createElement("ul");
	for (const task of tasks) {
		const li = document.createElement("li");
		if (task.completed) li.className = "done";

		// 左: チェック印 + タイトル(+ メモがあれば控えめに)。
		const main = document.createElement("div");
		main.className = "main";

		const check = document.createElement("span");
		check.className = "check";
		// 完了は塗り、未完は白丸。絵文字ではなく記号で(フォント差の崩れを避ける)。
		check.textContent = task.completed ? "☑" : "☐";
		main.appendChild(check);

		const texts = document.createElement("div");
		texts.className = "texts";
		const title = document.createElement("div");
		title.className = "title";
		title.textContent = task.title;
		texts.appendChild(title);
		if (task.notes) {
			const notes = document.createElement("div");
			notes.className = "notes";
			notes.textContent = task.notes;
			texts.appendChild(notes);
		}
		main.appendChild(texts);
		li.appendChild(main);

		// 右: 期日 + 優先度バッジ(あるものだけ)。
		const meta = document.createElement("div");
		meta.className = "meta";
		const dueText = formatDue(task.due, task.isAllDay);
		if (dueText) {
			const dueEl = document.createElement("span");
			dueEl.className = "due";
			dueEl.textContent = dueText;
			meta.appendChild(dueEl);
		}
		const pl = priorityLabel(task.priority);
		if (pl) {
			const pri = document.createElement("span");
			pri.className = `pri pri-${pl}`;
			pri.textContent = pl;
			meta.appendChild(pri);
		}
		li.appendChild(meta);

		ul.appendChild(li);
	}
	root.appendChild(ul);
}

// 初期表示(ontoolresult 発火前の空白防止)。以降は診断メッセージ→結果で上書きされる。
// iOS WebView にはコンソールが無く「画面表示でしか」切り分けられないため、tdr と同じく
// 接続中/接続失敗/結果未達の3段階を画面に出して実機デバッグしやすくする。
show("初期化中…");

let gotResult = false;
const app = new App({ name: "caldav-todos", version: "0.1.0" });
// ハンドラは connect 前に登録する(登録前に来た通知を取りこぼさないため。SDK 推奨。
// ext-apps は「connect 完了後の登録」を警告する _assertHandlerTiming を持つ)。
app.ontoolresult = (r) => {
	gotResult = true;
	const structuredContent = r?.structuredContent as { tasks?: TodoItem[] } | undefined;
	render(structuredContent?.tasks ?? []);
};

show("① 接続中…");
try {
	await app.connect();
} catch (e) {
	show(`① 接続失敗: ${e instanceof Error ? e.message : String(e)}`);
	throw e;
}

// --- 再読み込み(E-2 スライス②の検証本体)-------------------------------------
// connect 完了後にだけ有効化する(strict ホストでの早すぎる callServerTool を避ける)。
refreshButton.disabled = false;
refreshButton.addEventListener("click", async () => {
	// 二重押下防止 + 進行表示。iOS WebView はコンソールが無く画面表示でしか切り分けられない
	// ため(既存 show() の3段診断と同じ思想)、進行/失敗をボタンラベルと root に出す。
	refreshButton.disabled = true;
	const prevLabel = refreshButton.textContent;
	refreshButton.textContent = "再読み込み中…";
	try {
		// 【このスライスで検証したい当のもの】
		//   App.callServerTool は「ホストが本体 MCP サーバーへプロキシする」ツール呼び出し
		//   (app.d.ts)。ここで refresh-todos(visibility:["app"])を叩き、
		//   (a) 呼び出したユーザーの principal のタスクだけが返るか(= OAuth 認可コンテキストが
		//       callServerTool 経路でも効くか)、
		//   (b) この呼び出しが会話 transcript に出ないか、
		//   を実機で確認する。tdr で「claude.ai Web は callServerTool をプロキシし transcript に
		//   出さない」ことは確認済みだが、caldav 固有の「OAuth + 書き込み可サーバーでの認可」は未検証。
		// 【戻り値の形】callServerTool は CallToolResult 全体(structuredContent を内包)を返す
		//   (app.d.ts の callServerTool シグネチャで確認)。ツール実行エラーは throw ではなく
		//   result.isError:true で返るため、transport 例外(catch)と区別して両方を画面に出す。
		const result = await app.callServerTool({ name: "refresh-todos", arguments: {} });
		if (result.isError) {
			// ツール実行側のエラー(認可失敗・内部エラー等)。content の text を拾って表示する。
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			show(`再読み込み失敗: ${text}`);
			return;
		}
		// refresh-todos の structuredContent 契約は list-todos と同一
		//   { tasks: TodoItem[], calendarId, timeZone }
		// なので、ローカルの TodoItem をそのまま流用して render() に渡す(entry は application を
		// import しない疎結合のまま — ファイル冒頭「structuredContent の契約」コメント参照)。
		const structuredContent = result.structuredContent as { tasks?: TodoItem[] } | undefined;
		render(structuredContent?.tasks ?? []);
	} catch (e) {
		// transport 失敗(ホスト拒否・タイムアウト・接続喪失)。callServerTool は
		// これらを例外として投げる(app.d.ts の @throws)。
		show(`再読み込み失敗: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		refreshButton.textContent = prevLabel;
		refreshButton.disabled = false;
	}
});

// 接続後、ホストが initialized を受けて tool-result を push してくるのを待つ。
// 一定時間来なければ「接続はできたがホストが inline へ結果を送っていない」と切り分ける。
show("② 接続完了・データ待ち…");
setTimeout(() => {
	if (!gotResult) show("② 接続済みだが tool-result 未達(ホストが inline へ結果を push していない可能性)");
}, 5000);
