// =============================================================================
// presentation/mcp/ui/confirm-entry.ts — 汎用「削除の確認」カード(ui://)のブラウザ向けエントリ
//                                        (S1: docs/modeling/14-confirmation-card.md)
// =============================================================================
// 【このファイルの位置づけ】
//   scripts/build-ui-bundle.ts がこのファイルを bun build でブラウザ向け単一 ESM にバンドルし、
//   結果を src/presentation/mcp/ui/confirm-bundle.ts(自動生成・非コミット)へ書き出す。
//   confirm-app.ts がその生成物を HTML の <script type="module"> 本体へ補間して埋め込む。
//   自己完結バンドル方針・DOM 前提・外部 import 禁止(ext-apps + ui/ 内共有のみ)は todos-entry.ts /
//   agenda-entry.ts と完全に同一なので、詳細はそちらの冒頭コメントを参照(重複させない)。
//
// 【このカードが受け取る契約(propose-delete-* の結果 _meta.confirm)】
//   propose-delete-todo / propose-delete-event / propose-delete-calendar は「副作用なし」で対象を読み、
//   結果の _meta にだけ確認トークンとプレビューを載せる(モデルの content には載せない=モデルは
//   トークンを知り得ない。docs/modeling/14 §2)。この _meta はホストが ontoolresult でカードへ渡す:
//     _meta.confirm = {
//       token: string,          // HMAC 署名付きワンタイムトークン(delete-* が実行前に検証)
//       tool: "delete-todo" | "delete-event" | "delete-calendar",  // callServerTool で叩く本体ツール名
//       id: string,             // 削除対象 id(VTODO/VEVENT の UID・またはコレクション id)
//       calendarId?: string,    // 対象コレクション(todo/event のみ)
//       force?: boolean,        // calendar のみ: 非空コレクションを中身ごと消すか
//       heading: string,        // カード見出し(例「このリマインダーを削除しますか?」)
//       preview: { title, subtitle?, collection?, count? }, // 表示用プレビュー
//     }
//   「削除する」ボタン → callServerTool(tool, { id, calendarId?, force?, confirmToken: token })。
//   confirmToken を持つのはこのカード内のこの経路だけ = 実削除は必ずユーザーのタップを経由する。
// =============================================================================

import { App } from "@modelcontextprotocol/ext-apps";
// 絵文字/文字グリフを lucide のインライン SVG へ統一する共有モジュール(icons.ts 冒頭コメント参照)。
import { createIcon } from "./icons";

// --- 静的 DOM への参照(骨格は confirm-app.ts の HTML 側にある)-----------------------
const root = document.getElementById("root") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const liveEl = document.getElementById("live") as HTMLElement;

// --- 受け取った確認契約(ontoolresult の _meta.confirm。型はローカル写経=ui は末端)---------------
interface ConfirmPreview {
	title: string;
	// 副題(日時 / due など。無い対象もある)。
	subtitle?: string;
	// 由来コレクション名(「どのリスト/カレンダーから消えるか」の文脈)。
	collection?: string;
	// calendar 削除のとき: そのコレクションに入っている件数(中身ごと消える警告に使う)。
	count?: number;
}
interface ConfirmContract {
	token: string;
	tool: string;
	id: string;
	calendarId?: string;
	force?: boolean;
	heading: string;
	preview: ConfirmPreview;
}

// 現在表示中の確認契約(ontoolresult で受領。null=まだ届いていない)。
let contract: ConfirmContract | null = null;
// 実行フェーズ。idle=待機 / committing=削除実行中(§7.8: ボタン in-flight 演出)/ done=削除完了 /
// cancelled=キャンセル済み / error=失敗(再試行可)。再描画のたびにこの状態でボタン群を出し分ける。
type Phase = "idle" | "committing" | "done" | "cancelled" | "error";
let phase: Phase = "idle";
let errorText = "";

// --- 診断(iOS WebView はコンソールが無く画面表示でしか切り分けられない。todos/agenda と同じ作法)---
function showStatus(msg: string): void {
	statusEl.hidden = false;
	statusEl.textContent = msg;
}
function clearStatus(): void {
	statusEl.hidden = true;
	statusEl.textContent = "";
}

/** 小ヘルパー: クラス付き要素。 */
function el(tag: string, className: string): HTMLElement {
	const e = document.createElement(tag);
	e.className = className;
	return e;
}

// =============================================================================
// 描画(単一状態 → renderAll。todos/agenda と同じ素朴な一方向データフロー)
// =============================================================================
function renderAll(): void {
	root.textContent = "";
	if (contract === null) {
		// _meta.confirm がまだ届いていない(propose 応答前)。空カードにはせずプレースホルダを出す。
		const skel = el("div", "skel");
		skel.textContent = "確認内容を読み込んでいます…";
		root.appendChild(skel);
		return;
	}

	// --- 見出し(削除は破壊的なので警告アイコン + 対象種別で強めに提示)---
	const headRow = el("div", "head-row");
	const warn = el("span", "warn-icon");
	warn.appendChild(createIcon("triangle-alert"));
	warn.setAttribute("aria-hidden", "true");
	headRow.appendChild(warn);
	const heading = el("h1", "heading");
	heading.textContent = contract.heading;
	headRow.appendChild(heading);
	root.appendChild(headRow);

	// --- 対象プレビュー(タイトル / 副題 / コレクション / 件数)---
	const card = el("div", "target-card");
	const title = el("div", "target-title");
	title.textContent = contract.preview.title;
	card.appendChild(title);
	const metaBits: string[] = [];
	if (contract.preview.subtitle !== undefined && contract.preview.subtitle !== "") metaBits.push(contract.preview.subtitle);
	if (contract.preview.collection !== undefined && contract.preview.collection !== "") metaBits.push(contract.preview.collection);
	if (metaBits.length > 0) {
		const meta = el("div", "target-meta");
		meta.textContent = metaBits.join(" · ");
		card.appendChild(meta);
	}
	// calendar 削除で中身がある場合は「中身ごと消える」ことを明示的な警告文で出す(force:true の含意)。
	if (contract.preview.count !== undefined && contract.preview.count > 0) {
		const danger = el("div", "target-danger");
		danger.textContent = `このリスト内の ${contract.preview.count} 件も一緒に削除されます`;
		card.appendChild(danger);
	}
	root.appendChild(card);

	// --- 終端状態(done/cancelled)はボタンを畳んで結果だけ出す(操作後の余韻を残さない)---
	if (phase === "done") {
		const result = el("div", "result done");
		result.appendChild(createIcon("check"));
		result.appendChild(document.createTextNode(" 削除しました"));
		root.appendChild(result);
		return;
	}
	if (phase === "cancelled") {
		const result = el("div", "result cancelled");
		result.textContent = "キャンセルしました";
		root.appendChild(result);
		return;
	}

	// --- 失敗バナー(再試行はボタン群の「削除する」再押下で行う)---
	if (phase === "error") {
		const banner = el("div", "banner");
		banner.textContent = errorText === "" ? "削除に失敗しました" : errorText;
		root.appendChild(banner);
	}

	// --- アクション行(キャンセル / 削除する[破壊的・赤])---
	const actions = el("div", "actions");
	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.className = "btn btn-cancel";
	cancelBtn.textContent = "キャンセル";
	cancelBtn.disabled = phase === "committing";
	cancelBtn.addEventListener("click", () => {
		// キャンセルは純粋にローカルな状態遷移(サーバーは呼ばない=副作用ゼロ。トークンは使わず失効に任せる)。
		phase = "cancelled";
		liveEl.textContent = "削除をキャンセルしました";
		renderAll();
	});
	actions.appendChild(cancelBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.type = "button";
	deleteBtn.className = "btn btn-delete";
	deleteBtn.textContent = phase === "error" ? "もう一度削除する" : "削除する";
	deleteBtn.disabled = phase === "committing";
	// §7.8(docs/modeling/12)committing 演出: 押下後は in-flight のシマーを出しボタンを固定する
	// (楽観 UI ではなく「確定を待っている」ことをボタン自身が語る。独自アニメ語彙は新設しない)。
	if (phase === "committing") deleteBtn.classList.add("committing");
	deleteBtn.addEventListener("click", () => void confirmDelete());
	actions.appendChild(deleteBtn);
	root.appendChild(actions);
}

/**
 * 「削除する」タップ → 本体 delete-* ツールを confirmToken 付きで実行する。
 * committing 中の二重送信は phase ガードで弾く。成功/失敗で phase を遷移して再描画する。
 */
async function confirmDelete(): Promise<void> {
	if (contract === null || phase === "committing") return;
	phase = "committing";
	errorText = "";
	renderAll();
	liveEl.textContent = "削除しています";

	// callServerTool の引数は「本体 delete-* ツールが受ける形」+ confirmToken。calendarId/force は
	// 対象種別に応じて _meta.confirm がセット済みのものだけ載せる(undefined は付けない)。
	const args: Record<string, unknown> = { id: contract.id, confirmToken: contract.token };
	if (contract.calendarId !== undefined) args.calendarId = contract.calendarId;
	if (contract.force !== undefined) args.force = contract.force;

	try {
		const result = await app.callServerTool({ name: contract.tool, arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		phase = "done";
		liveEl.textContent = "削除しました";
	} catch (e) {
		phase = "error";
		errorText = e instanceof Error ? e.message : String(e);
		liveEl.textContent = "削除に失敗しました";
	}
	renderAll();
}

// =============================================================================
// App SDK 配線(ハンドラは connect 前に登録・SDK 推奨。todos/agenda と同じ規律)
// =============================================================================
renderAll(); // 接続前のプレースホルダ。
const app = new App({ name: "caldav-confirm", version: "0.1.0" });
app.ontoolresult = (r) => {
	clearStatus();
	// propose-delete-* の結果 _meta.confirm を取り出す。ここがこのカードの唯一の入力
	// (structuredContent ではなく _meta を読む — モデルに漏れないチャネルから受け取るのが本設計の要)。
	const meta = (r as { _meta?: Record<string, unknown> } | undefined)?._meta;
	const confirm = meta?.confirm as ConfirmContract | undefined;
	if (confirm !== undefined && typeof confirm.token === "string" && typeof confirm.tool === "string") {
		contract = confirm;
		// 新しい確認内容が来たら phase をリセットする(同じカードが別対象の propose 結果で再利用され得る)。
		phase = "idle";
		errorText = "";
		renderAll();
	}
};

showStatus("接続中…");
try {
	await app.connect();
} catch (e) {
	// connect 失敗はこの iframe からは復旧できない(ハンドシェイクはホスト起点)。事実だけ出す。
	showStatus(`接続失敗: ${e instanceof Error ? e.message : String(e)}`);
	throw e;
}
clearStatus();
