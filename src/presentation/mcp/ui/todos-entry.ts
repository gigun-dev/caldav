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
// 【完了操作は「楽観適用 → サーバー確定で重ね直し / 失敗ロールバック」(2026-07-14 ドクトリン改訂)】
//   タップ即、ローカル state の該当行 status を書き換えて再描画する(becoming をその場で即時に
//   乗せる: completed なら塗り丸+凍結リング+取消線)。裏で update-todo を fire し、成功したら
//   確定 vm で通常再描画(楽観状態とほぼ一致するので視覚変化は最小)、失敗したら楽観変更を
//   ロールバックしてエラーバナー(再試行付き)で告知する。連打二重送信は in-flight の id ガード
//   (pendingIds)で防ぐが、UI はブロックしない(disabled もスピナーも出さない)。
//
//   【なぜ旧「楽観確定しない(pending スピナー→サーバー確定)」を覆したか(Why not 悲観 UI)】
//   旧実装は反復 VTODO の完了がサーバー側 D4 モデル(完了スナップショットを新 UID で切り出し、
//   マスターの due を次回 occurrence へ前進)で処理され「完了後の一覧」がクライアントから
//   予測不能(新 UID・次回 due・行の増減)になることを理由に、タップ→その行だけ pending
//   スピナー→ update-todo 成功→ refresh でサーバー確定値を全体再描画、に倒していた
//   (「一瞬チェックされた行が消えて別の行が現れる」チラつきを嫌った)。しかし:
//     ① 手本の iOS リマインダー自身が楽観更新であり、悲観 UI は「iOS 準拠」品質基準と矛盾する。
//     ② 実測レイテンシ(update 約 600ms〜秒)で pending スピナーは「タップが効いていない/
//        クラッシュした?」体験になると実機で確認した(悲観 UI の実害)。
//     ③ 失敗は稀で、稀な失敗のために毎回を遅く見せるのは配分が逆。
//   D4 変形のチラつき懸念は「楽観状態と確定 vm がほぼ一致する(完了は完了、追加は追加)」ため
//   実害が小さく、確定 vm が来た瞬間の1回の差し替えで吸収できる。反復完了で行が変形しても、
//   楽観の becoming-done が確定 vm の becoming-done(snapshot 合成)へ滑らかに引き継がれる。
//
// 【一貫性の要: 確定 vm(applyStructuredContent)が常に真実・楽観は「次の確定まで」の重ね物】
//   楽観 state は confirmedTasks(直近のサーバー確定一覧)とは別に保持し(optimisticToggle /
//   optimisticRows)、描画のたびに confirmedTasks へ重ね直す(rebuildDisplay)。確定 vm が
//   届いても in-flight の楽観変更が失われないよう、applyStructuredContent は confirmedTasks を
//   更新したうえで残っている in-flight 楽観を再度重ねる。差分レンズ(computeSyncDiff)は
//   confirmedTasks(クリーン)だけを prev/next に使い、仮行(optimistic: prefix)と in-flight
//   トグル(pendingIds)は差分計算から除外する(システム起因の誤検出を防ぐ)。
// =============================================================================

import { App } from "@modelcontextprotocol/ext-apps";
// E-2 スライス④: システム起因(外部)変化のクライアント差分の純関数コア。ui/ 内どうしの
// import は 'mcp-ui-is-terminal' の除外対象(ui/→ui/ は許可)。bun build がバンドル時に
// inline するので生成物 todos-bundle.ts は1ファイルのまま。
import { computeSyncDiff, type SyncDiff } from "./todos-diff-client";
// 絵文字/文字グリフ(≡ ⟳ 📍 ⓘ ‹ › ⌄ ⌃ ＋ ✓)を lucide のインライン SVG へ統一する
// (2026-07-15 ユーザーフィードバック。詳細は icons.ts 冒頭コメント)。
import { createIcon } from "./icons";
// 共有カーネル(docs/modeling/12 §4)。日付/時刻整形と recurrence 整形・プリセット写像は
// agenda-entry.ts と全く同じロジックなので ui/format.ts・ui/recurrence.ts へ集約し、両 entry が
// import する(二重管理で片方だけ直す事故を防ぐ)。bun build がバンドル時に inline するので
// 生成物 todos-bundle.ts は1ファイルのまま。
import { WEEKDAYS, localDateKey, wallDatePart, wallTimePart, dayDiff } from "./format";
// 操作フィードバック統一ドクトリン v2(docs/modeling/12 §7.8)の共有カーネル。committing
// (寿命付きアニメの最中か)の判定式と定数(1周期・寿命周回数・T_hard)を row-key と同じ規律で
// 純関数だけ共有する(CSS/DOM は §7.7 判断を維持し agenda と共有しない)。
import { FEEDBACK, isCommitting } from "./feedback";
// C1+C2(設計04 §5・swift-mcp-app 側 docs/design/04-display-mode-and-card-height.md): inline
// displayMode の「畳み」判定は DOM に触れない純関数として切り出す(feedback.ts / row-key.ts と
// 同じ規律)。DOM 操作(li 間引き・「残り n 件」ノードの挿入)は renderAll 側(このファイル)で行う。
import { INLINE_PREVIEW_MAX, canRequestFullscreen, computeInlineFit } from "./fold";
// C2(設計 05 §2): proximity バッジ文言の生成を純関数に隔離(mcp-location-view.test.ts で境界固定)。
// 型(StructuredLocationView / ProximityAlarmView)も location-view.ts の写経を共有する。
import { type ProximityAlarmView, type StructuredLocationView, proximityBadge } from "./location-view";
// 完了トグル coalesce / 楽観復活の判定(純関数コア。> 2026-07-17 実機 FB「done→undo で完了が残る」監査修正)。
// ui/→ui/ の import は mcp-ui-is-terminal の許可対象。bun build がバンドル時に inline する。
import { coalesceAction, mergeCompletedBase, shouldReviveToggle } from "./toggle-coalesce";
import {
	type RecurrenceSummary,
	type RecurPreset,
	type RecurArgs,
	WEEKDAY_JA,
	RECUR_EVERY,
	formatRecurrence,
	PRESET_LABEL,
	PRESET_MENU_ORDER,
	presetToArgs,
	recurrenceToPreset,
	recurValueText,
} from "./recurrence";

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
// v2 の #sheet-root(詳細セミモーダルの描画先)は v3 で廃止した。詳細/リスト選択は sheetState に応じて
// renderAll が #root(通常フロー)へ直接描く「カード内ページ遷移」に変えたため、独立コンテナは不要
// (廃止理由の詳細は sheetState 宣言のコメント参照)。
// E-2 スライス③: 対象リスト名の見出し。#root の外(常時ある操作面)なので描画の破壊的更新に巻き込まれない。
const appTitleEl = document.getElementById("app-title") as HTMLElement;
// 追加 FAB(+)。タップで一覧末尾に空のドラフト行を選択状態で生やす(startDraft)。
// 【v2→v3 で覆した点(経緯・財産)】v2 は FAB タップで position:fixed の quick-add ボトムシート
// (#quick-add フォーム + 段階的開示パネル)を開いていた。fixed+vh の実機バグとトーン不一致のため
// シート方式は全廃し、FAB は「新規ドラフト行を生やす」トリガーに変えた(draft 宣言のコメント参照)。
const quickAddFab = document.getElementById("quick-add-fab") as HTMLButtonElement;
// 【S-E: カード右上の単一 Done(§7.7)】旧・行内 confirm(button.confirm・renderRow 参照)の撤去先。
// ヘッダは #root の外(常時ある操作面)にあるので、静的 DOM 参照 + 1回だけの addEventListener で足りる
// (quickAddFab と同じ配線パターン。行内に置いていた時代は renderRow のたびに作り直していたが、
// ヘッダに1個だけなので renderAll では hidden の付け外しだけ行う)。
const headerDoneEl = document.getElementById("header-done") as HTMLButtonElement;

/** RRULE 要約(task-dto.ts の Task.recurrence と同型)。共有カーネル ui/recurrence.ts の
 *  RecurrenceSummary と同一。既存の多数の参照名(TodoRecurrence)を保つためのローカル別名。 */
type TodoRecurrence = RecurrenceSummary;

/** structuredContent.tasks の要素。型 import をしない方針のためここでローカル定義する
 *  (契約は冒頭コメント参照。task-dto.ts の Task とフィールドを一致させること)。
 *  【E-2 スライス⑤】location / recurrence を additive 追加(task-dto.ts に a3df4a3 で追加済み)。
 *  DiffTask(todos-diff-client)は TodoItem の構造的部分型なので、フィールドが増えても
 *  差分レンズの受け渡し(confirmedTasks を DiffTask[] として渡す)は壊れない(構造的部分型)。 */
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
	// LOCATION(§3.8.1.7)。未設定は null。詳細展開でのみ表示する(一覧行には出さない)。
	location: string | null;
	// RRULE 要約。未設定(非反復)は null。一覧行に繰り返しバッジ、詳細展開に完全表記を出す。
	recurrence: TodoRecurrence | null;
	// C1(設計 05 §2)の派生: VTODO 直下の X-APPLE-STRUCTURED-LOCATION(構造化場所)。未設定は null。
	// proximityAlarm.location を優先するため一覧の 📍 バッジでは通常使わない(C2 todos 指示 6)が、
	// 契約を取りこぼさないよう写経する(task-dto.ts が付与)。
	structuredLocation: StructuredLocationView | null;
	// C1(設計 05 §1-a/§2): proximity(到着/出発)VALARM。geofence リマインダーの実体。未設定は null。
	// 一覧行の 📍「〜に到着時 / から出発時」バッジの源(C2 todos 指示 5)。
	proximityAlarm: ProximityAlarmView | null;
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
	// sync(E-2 スライス④): このゴーストがシステム起因(外部削除)由来か。true なら
	// renderGhostRow のラベルを中立の「同期(削除)」にする。サーバー由来(ユーザー起因)の
	// removed には付かない(= undefined)。server の TaskSnapshot には無い client 専用フィールド。
	sync?: boolean;
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
	// sync(E-2 スライス④): このエントリがシステム起因(外部変化)由来か。サーバーの affected
	// (ユーザー起因)には付かない。true のとき becoming の form は同じ語彙を使いつつ、行右端の
	// ラベルを中立の「同期(...)」に切り替える(出所=iOS 等は断定しない。ユーザーの「追加/完了」
	// ラベルと区別するため)。クライアント差分(computeSyncDiff)から合成した分だけに立つ。
	sync?: boolean;
}

// --- C1: hostContext から読んだ空間制約(設計04 §5 C1) -------------------------------
// getHostContext().containerDimensions.maxHeight / displayMode を保持する。renderAll 最終段の
// 畳み判定(applyInlineFold → computeInlineFit)がこの2値を読む。maxHeight 未送信のホスト
// (現本アプリ)は null のままなので畳みは発火しない(不活性が既定・fold.ts のコメント参照)。
let hostMaxHeightPx: number | null = null;
let hostDisplayMode: string | null = null;
// C3(設計04 §5): ホストが広告する availableDisplayModes。「すべて表示」ボタンを押せる形で
// 出してよいか(canRequestFullscreen)の入力になる。未受信は null(=受動表示のまま・不活性が既定)。
let hostAvailableDisplayModes: readonly string[] | null = null;

/** C1 本体: getHostContext() を読み、hostMaxHeightPx / hostDisplayMode / hostAvailableDisplayModes を
 *  更新する。
 *  【出典】apps.mdx:687-711(View は containerDimensions を確認して CSS を当てるべき、という
 *  公式例。ただし本カードは maxHeight を CSS の直接クリップ(style.maxHeight)には使わず
 *  --host-max-height という CSS 変数へ落とすだけに留める — overflow:hidden 的な素朴なクリップは
 *  行の途中で切れる見苦しい打ち切りになるため、実際の畳み(行単位で先頭 N 件に切る)は
 *  renderAll 側で行う。この関数はあくまで「読んで反映する」入口)。
 *  spec.types.ts:236,238,243-249(displayMode/availableDisplayModes/containerDimensions の型)。
 *  containerDimensions は {height} 側(fixed)と {maxHeight} 側(flexible)の union なので、
 *  "maxHeight" in containerDimensions で判別する(apps.mdx の公式例と同じ判別方法)。
 *  C3 追加: fullscreen 時は root に overflow-y:auto を当て全件を内部スクロールで見せる
 *  (畳み自体は applyInlineFold が hostDisplayMode!=="inline" で早期 return するので既に全件表示
 *  になっている — ここで足すのはスクロール可能にするコンテナ設定だけ)。 */
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
	// C3: fullscreen 中だけ root を内部スクロールコンテナにする。inline に戻ったら外す
	// (todos-app.ts 冒頭コメントの「内部スクロールコンテナを作らない方針」は inline 限定の方針で、
	// fullscreen は sheet 1枚だけなので二重スクロール問題が構造的に起きない・設計04 決定2)。
	// sticky ヘッダ(.bar)はスクロール可能な祖先が生まれて初めて効く(todos-app.ts の .bar コメント参照)。
	root.classList.toggle("fullscreen-scroll", hostDisplayMode === "fullscreen");
}

// --- UI 状態(単一の状態 → renderAll() で全描画、という素朴な一方向データフロー)-------
// フレームワークを入れない代わりに「状態はこの3つだけ・描画は renderAll() だけ」に
// 絞って予測可能にする。行単位の部分更新はしない(タスク数は個人のリマインダー規模で
// 高々数十件、全再描画で十分速い。差分更新の複雑さはバグの温床になるだけ)。
// tasks = 「描画に使う表示用」一覧(confirmedTasks に in-flight の楽観変更を重ね直したもの)。
// renderAll / sectionize / renderRow / announceBecoming はこの表示用 tasks だけを読む。
let tasks: TodoItem[] | null = null; // null = まだ一度もデータを受け取っていない(skeleton 表示)
// confirmedTasks = 直近のサーバー確定一覧(クリーン。楽観変更を一切含まない)。
// 【なぜ tasks と別に持つか(2026-07-14 楽観更新)】差分レンズ(computeSyncDiff)の prev/next には
// 楽観で汚れていない確定値だけを渡す必要があり、また確定 vm 到着時に「楽観を重ね直す土台」も
// クリーンな確定値でなければならない。表示用 tasks(重ね物込み)を prev に使うと、仮行が
// システム起因の removed に化けたり楽観トグルが edited に誤検出される。
let confirmedTasks: TodoItem[] | null = null;
// pendingIds = mutate 送信中の行 id → 開始時刻(ms epoch)。2026-07-16 ドクトリン v2(§7.8)で
// Set → Map<id, startedAt> に変更(統一状態機械が唯一必要とする構造変更)。用途は3つ:
//   ①同じ行の連打を弾く二重送信ガード(旧 Set と同じ) ②差分レンズの degrade(pending 行は
//   システム差分マークの対象外) ③startedAt を isCommitting(now, startedAt) に渡し、
//   「いまこの行の committing アニメ(寿命1周)が有効か」を renderRow が毎描画判定する。
// 【見た目のブロック(disabled/スピナー)は 2026-07-14 ドクトリンのまま出さない】v2 が変えたのは
// 「アニメの寿命管理」だけで、「操作を待たずに連打できる」設計自体は不変。
const pendingIds = new Map<string, number>();
// animUntil = committing アニメの「寿命の満了時刻」(ms epoch)。id → startedAt + cycleMs*animCycles。
// 【2026-07-16 v2.1(docs/modeling/12 §7.8 更新)で pendingIds から分離した理由(バグ修正)】
// 旧実装は各 mutate の成功/失敗分岐で pendingIds.delete(id) した瞬間に isCommitting 判定(旧: startedAt
// を pendingIds から読む)も終了していた。しかしサーバー確定は実測 p50=287ms と 1.2s(cycleMs×animCycles)
// より速いことが普通で、確定が先に届くと committing アニメが1周し切る前に打ち切られ「見えない/一瞬で
// 終わる」不具合になっていた(ユーザー FB 由来)。animUntil は pendingIds のライフサイクル(二重送信
// ガード・差分レンズ degrade・T_hard 判定 = 「まだサーバー確定していないか」)とは独立に、「tap した
// 瞬間から必ず cycleMs*animCycles だけ持続する」という別の寿命を持つ。各 mutate 成功/失敗分岐は
// pendingIds だけ delete し、animUntil には一切触れない(=animUntil の唯一の書き手は startCommitting
// と下の満了タイマー)。renderRow の committing 判定はこの Map の値と Date.now() の比較だけで行う。
const animUntil = new Map<string, number>();

/**
 * mutate 開始時に pendingIds へ startedAt を積み、animUntil へ寿命の満了時刻(=startedAt+cycleMs×
 * animCycles)を積む。寿命満了時の再描画(committing クラスを外す)を1本 setTimeout で仕込む。
 *
 * 【2026-07-16 撤回: T_hard(10s)警告バナーのタイマーを廃止した(item 1)】
 * 旧実装はここで2本目の setTimeout を仕込み、10s 超過かつ `pendingIds.has(id)` なら「保存に時間が
 * かかっています」の警告バナーを出していた。計器実測で Worker 実処理は最大 4s、10s 超過は
 * claude.ai transport 起因と判明し、楽観で done 済みに見せている行に待ち表示を重ねてもユーザーに
 * 運べる情報が無い(=誤報に近い)ため取り下げた。満了タイマー(animUntil)と pendingIds ロジックは
 * 維持する。安全網は「fetch reject → ロールバック+エラーバナー」(各 mutate の catch)と
 * 「refresh / fresh-instance の確定描画」に一本化済み。詳細は feedback.ts の FEEDBACK コメント。
 *
 * 【なぜ満了タイマーの解除(clearTimeout)をしないか(Why not)】
 * 満了タイマーは pendingIds を見ない(animUntil 自身の寿命だけで無条件に発火・renderAll する —
 * pendingIds が既に delete 済み=サーバー確定済みでも、アニメの残り時間分は committing 表現を
 * 続ける必要があるため、pendingIds の有無で分岐すると旧バグ(確定が速いとアニメが途中で切れる)に
 * 逆戻りする)。id の使い回しは無い(実 todo id か quick-add の仮 optimistic:id)ので、setTimeout の
 * 参照を保持して明示 clear する複雑さは持ち込まない。
 */
function startCommitting(id: string): void {
	const startedAt = Date.now();
	pendingIds.set(id, startedAt);
	const lifespan = FEEDBACK.cycleMs * FEEDBACK.animCycles;
	animUntil.set(id, startedAt + lifespan);
	// committing 満了(寿命1周)→ animUntil を消して再描画(committing クラスが外れ静的 becoming へ
	// 収束する)。pendingIds はここでは触らない(サーバー確定と無関係な寿命なので)。
	setTimeout(() => {
		animUntil.delete(id);
		renderAll();
	}, lifespan);
}
let completedOpen = false; // 完了済み <details> の開閉。再描画で閉じ戻らないよう保持する
// --- 楽観更新の in-flight state(2026-07-14 ドクトリン改訂)---------------------------
// optimisticToggle: update-todo 送信中のトグルの「楽観的な完了状態」。id → {completed,status}。
//   rebuildDisplay が confirmedTasks の該当行にこれを重ね、becoming(completed/reopened)も付ける。
//   成功/失敗のどちらでもこの Map から delete する(成功=確定 vm が真実に、失敗=元へ戻す)。
const optimisticToggle = new Map<string, { completed: boolean; status: string | null }>();
// --- A-1(> 2026-07-17 実機 FB 第2ラウンド: 完了トグルの反応性)coalesce 用 state ---------------
// 【問題】旧 toggleTask 冒頭の `if (pendingIds.has(id)) return;`(二重送信ガード)が、done 直後の
//   取り消しタップ(update-todo 往復 ~1s の窓に入る)を黙って捨てていた(undo が効かない主因)。
// 【新方式: 意図の記録 + 追送(coalesce・last-write-wins)】タップは常に楽観 UI へ即時反映し、
//   「望みの最終状態」を desiredToggle に記録する。in-flight の update-todo が返った時点で、記録した
//   desired と送った状態が食い違っていれば補正の update-todo を1発だけ追送する(連打しても追送は
//   常に最新1発に coalesce = 最後の意図だけがサーバーへ届く)。これで「黙って捨てる」が無くなる。
// 【二重送信防止はどう保つか】旧ガードの目的(同一行へ update-todo を多重発火しない)は、flushToggle が
//   inFlightToggle で「その id の送信ループは1本だけ」を保証することで維持する — 追加タップは新しい
//   ネットワーク呼び出しを起こさず、走っている flush ループが desiredToggle を読んで追送するだけ。
// desiredToggle: id → 望みの最終トグル状態(タップのたびに上書き)。flush ループが「まだ送っていない/
//   食い違う」最終状態としてこれを消費し、確定できたら delete する。
const desiredToggle = new Map<string, { completed: boolean; status: string }>();
// inFlightToggle: いま flushToggle のループが走っている id(= 送信ループの単一性ガード。旧 pendingIds.has
//   ガードの役割を「送信ループが既にあるか」に限定して引き継ぐ)。flush の全終了経路で必ず delete する。
const inFlightToggle = new Set<string>();
// --- A-2(> 2026-07-17 実機 FB 第2ラウンド: 追加直後(緑=仮 id)の完了タップ)------------------------
// pendingToggleIntents: 仮 id(create-todo in-flight の緑行)→ 望みの完了状態。旧実装は
//   `if (isOptimisticId(id)) return;` でこのタップを黙って捨てていた。新方式では意図をここにキューし、
//   仮行は optimisticRowToItem がこの意図を反映して即チェックを描く。create-todo 確定で実 id が判明した
//   時点で applyQueuedToggle が実 id へ update-todo を発火する(create 失敗時は意図ごと破棄)。
const pendingToggleIntents = new Map<string, boolean>();
// optimisticRows: quick-add 送信中の仮タスク(id は "optimistic:<乱数>")。create-todo が
//   採番する実 id が確定するまでの表示用。rebuildDisplay が confirmedTasks の末尾に重ね、
//   becoming-in(追加)を付ける。成功時に該当仮行を除去してから確定 vm を適用する。
// 【E-2 スライス⑥前半】仮行に due/priority/notes を持たせる。quick-add の段階的開示で期日/優先度/
// メモを付けて追加できるようになったので、仮行にもそれを反映する(セクション配置は due に従う=
// 期日を付けた追加は期日なしセクションではなく該当セクションに仮行が出る)。タイトルのみの高速パス
// では due=null / priority=0 / notes=null(従来と同じ挙動)。
interface OptimisticRow {
	id: string;
	title: string;
	// due は表示用 TodoItem と同じ形(終日 "YYYY-MM-DD" / 時刻付き "YYYY-MM-DDTHH:MM:SS")。null=期日なし。
	// 仮行は offset を持たない(create-todo へ送る文字列そのまま)が、formatDue/dueEpoch は wall 部分と
	// ローカル解釈で足りるので表示・ソートに支障はない(次の確定 vm で実 tasks 行の offset ISO に戻る)。
	due: string | null;
	isAllDay: boolean;
	priority: number;
	notes: string | null;
}
let optimisticRows: OptimisticRow[] = [];
// optimisticEdits(E-2 スライス⑥前半・仕様B): 詳細編集の保存が in-flight の間の楽観的なフィールド
// 上書き。id → 変更したフィールドだけの部分上書き。rebuildDisplay が confirmedTasks の該当行へ
// この値を重ねる(値だけ差し替え = becoming-edit のインライン旧→新はサーバー応答の changes に任せる、
// という仕様B-2)。成功で確定 vm に置き換わり、失敗でこの Map から抜いて元値へ戻す(ロールバック)。
// 【v2 追加】recurrence も楽観上書きに含める(詳細セミモーダルの ✓ が繰り返しを部分更新できるため)。
// recurrence は TodoRecurrence|null(null=繰り返し除去)。rebuildDisplay が Object.assign で重ねる。
// 【B(> 2026-07-17): location を Pick から除去】自由テキスト場所の編集を全廃したので楽観上書き対象からも外す。
type OptimisticEdit = Partial<Pick<TodoItem, "title" | "due" | "isAllDay" | "priority" | "notes" | "recurrence">>;
const optimisticEdits = new Map<string, OptimisticEdit>();
/** 仮行 id 判定(differ から除外・トグル禁止に使う)。 */
function isOptimisticId(id: string): boolean {
	return id.startsWith("optimistic:");
}
/** ドラフト行 id 判定(FAB で生やす未送信の新規行。2026-07-15 v3)。トグル/削除/スワイプは禁止だが
 *  ⓘ(作成モード詳細)は許すため、optimistic: とは別 prefix にして isOptimisticId と区別する。 */
function isDraftId(id: string): boolean {
	return id.startsWith("draft:");
}
// 【v2 選択モデル + 詳細セミモーダル + スワイプ削除への置換(2026-07-15)】
// 旧・インライン詳細展開(expandedId + renderDetail)は廃止。iOS リマインダー準拠の「行選択で
// タイトルを直接編集 / ⓘ で詳細シート / 左スワイプで削除」に作り替える。expandedId → selectedId +
// sheetState + swipeId の3状態へ分解する。いずれも再描画(refetch/mutation)を跨いで保持する
// (completedOpen と同じ発想 — 見ていた選択・シート・スワイプが勝手にリセットされるのを防ぐ)。
//
// selectedId: head タップで単一行を選択(iOS の「タップで行が編集モードに入る」)。選択行はタイトルが
//   枠なし input 化し、直下に「メモを追加」行と ⓘ が出る。選択解除=確定(auto-save): 行外タップ /
//   Enter / 別行選択のいずれでも、変更があれば update-todo(title/notes のみ・部分更新)を楽観送信する。
let selectedId: string | null = null;
// draft: FAB(+)で生やす「まだ送信していない新規リマインダー行」(2026-07-15 v3 スコープ追加)。
//   【v2→v3 で覆した点(経緯・財産)】v2 は新規追加を position:fixed の quick-add ボトムシート
//   (FAB タップで開く #quick-add フォーム + 段階的開示パネル)で行っていた。しかし詳細シートと同じ
//   fixed+vh の実機バグ(内部スクロール不能・下部見切れ)を quick-add シートも抱えており、かつ
//   「シートを開く」体験は iOS リマインダーの「行末に空行が生えて即入力」とトーンが合わなかった。
//   v3 は選択モデルで新規行を表現できることに気づき、quick-add シートを全廃 → FAB タップで一覧末尾に
//   空のドラフト行を「選択状態」で挿入し(既存の選択状態=丸チェック無効・枠なしタイトル input・
//   「メモを追加」行・ⓘ をそのまま流用)、タイトル input へフォーカスする。確定は既存の選択解除文法
//   (行外タップ / Enter / 別行選択)と同一で、タイトル非空なら create-todo(既存 optimisticRows 経路)、
//   空のまま解除ならドラフト行は静かに消える。Enter は「確定→即座に次の空ドラフト行」で iOS の
//   「Enter で次の行」体験に合わせる。ドラフト行の ⓘ は v3 詳細ページを作成モードで開く(全フィールド)。
//   null=ドラフト無し。id は "draft:" prefix(isDraftId で判定。optimistic: とは別 — ⓘ を許すため)。
let draft: { id: string; title: string; notes: string } | null = null;
// swipeId: 左スワイプ(touch)or 右クリック/長押し(contextmenu)で削除ボタンを露出している行の id。
//   単一値なので別行を触れば前の露出は畳まれる(iOS の swipe-to-delete と同じ排他)。null=露出なし。
let swipeId: string | null = null;
// sheetState: 詳細ページ / リスト選択ページの「カード内ページ遷移」状態。page で表示ページを差し替える
//   (detail=編集フォーム / list=リスト移動の選択ページ)。null=一覧ページ表示中。
//   【v2→v3 で覆した点(経緯・財産)】v2 はこれを #sheet-root に position:fixed + max-height:88vh の
//   ボトムシート(scrim + grabber)として重ねていた。しかし MCP Apps の iframe はホストがコンテンツ
//   高さに自動リサイズするため vh が信用できず、本番 claude.ai の実機でシート本文が内部スクロール
//   できない/下部の行が見切れる/浮遊ポップオーバー(menu-pop)が画面外に出る、の3バグが出た
//   (docs/log.md の実機検証)。v3 は sheetState を「カードの表示ページ」に転用し、renderAll が
//   一覧 / 詳細 / リスト選択のどれかを #root(通常フロー)に描く。通常フローなので高さ=コンテンツで
//   iframe 自動リサイズと常に整合し、浮遊レイヤーもゼロになる。#sheet-root は廃止した。
//   create: true = 新規作成モード(一覧のドラフト行の ⓘ から開く。id は draft の id)。この場合
//   「保存」は create-todo に全フィールドを渡し、「‹ 戻る」は一覧のドラフト行選択状態へ戻る(破棄しない)。
let sheetState: { id: string; page: "detail" | "list"; create?: boolean } | null = null;
// sheetDraft: シートで編集中の作業コピー。構造フィールド(日付/時刻トグル・繰り返し・優先度・場所 ON/OFF)は
//   ここに持ち、テキスト入力(title/notes/location)は input イベントでここへ同期する — 構造変化での
//   シート再描画(メニュー選択等)でテキスト入力値が失われないようにするため。null=シート閉。
let sheetDraft: SheetDraft | null = null;
// list-calendars の結果キャッシュ(リスト移動ページで列挙)。初回ナビゲーション時に遅延取得する
//   (シートを開くたびに毎回叩かない。移動が起きればサーバー vm が来るのでキャッシュ鮮度は実害小)。
let calendarsCache: Array<{ id: string; displayName: string; components: readonly string[] }> | null = null;
// 選択行のタイトル/メモ入力への参照。commitSelection が renderAll 前の DOM 値を読むために renderRow が
//   選択行の描画時にセットする(renderAll は #root を innerHTML で作り直すので、再描画前に値を捕まえる)。
let selTitleInput: HTMLInputElement | null = null;
let selMemoInput: HTMLInputElement | null = null;
// optimisticDeletes(E-2 スライス⑤・楽観削除): delete-todo 送信中の行 id。rebuildDisplay が
// 表示から即除去する(楽観適用)。成功で確定 vm に置き換わり、失敗でこの Set から抜いて行が復活する。
// 【becoming-gone を1描画見せてから消す演出は省略した(判断)】仕様が許容する省略。楽観削除で
// ghost(破線+畳み)を出すには「行を消す前に snapshot を ghost として1フレーム描き、次の描画で
// 除去」という2段階のタイマー/フレーム管理が要り、ステートレス&アニメ無しのドクトリンと相性が悪い
// (中間フレームをどれだけ見せるかは実質アニメの尺調整になる)。代わりに、サーバー確定後の
// delete-todo 応答が removed(ghost)を載せてくるので、成功時に applyStructuredContent 経由で
// becoming-gone が1描画だけ自然に出る(サーバー由来の静的マーキングに委ねる方がドクトリンと一貫)。
const optimisticDeletes = new Set<string>();

// --- C0-a: 完了残骸の有界化(done タップ → タイトルのグレーフェード → 約3秒で自然退場)------------------
// 【なぜ必要か(2026-07-17 設計05 §4 裁定・実機バグ)】カード上でタップ完了した行(becoming-done)は
// 位置記憶 + stickyData により「カード lifecycle スコープ」でその場に残る設計(下記 positionMemory
// コメント)。しかし残骸が無制限に蓄積すると inline カードが maxHeight を突き破ってクリップする実機
// バグの主因になった。よって「サーバー再取得(vm 差し替え)が来ない場合の有界化」の保険として、
// 完了操作から短い猶予後に行を高さ0へ畳んで退場(remove)させる。退場はあくまで保険で、通常は
// サーバー再取得(未完了ビュー)で先に消える(退場タイマーが遅れて発火しても retiredDoneIds が
// 二重退場・復活を防ぐ)。
//   【モック inline-preview.html の旧ボツ案との関係(経緯・財産)】モック冒頭コメントは「(b) 時限フェード
//   (約5秒で退場)」をボツ案として挙げていた(「undo 猶予が時間で切れるのは lifecycle 認識と不一致」)。
//   その後の設計05 §4 で「lifecycle スコープ + 約5秒の undo 猶予後に退場で有界化」へ裁定が更新された
//   (無制限蓄積のクリップ実害の方が重い)。
//   【> 2026-07-17 実機 FB(磨き込み FB2): 「取り消す」ボタン廃止 → グレーフェードで自然退場へ】
//   当初(C0)は猶予中に「取り消す」テキストボタンを tag スロットへ出していたが、実機で
//   「文字が上に偏る崩れ」が出たうえ、Todoist 等のベスプラ(完了項目はグレーに薄れてスッと消える)に
//   照らすと明示ボタンは重い。よって「取り消す」ボタンは根ごと廃止し、done タップの瞬間から行が
//   グレーに薄れ、猶予後に max-height 畳みで自然退場する連続した1つの流れに変えた(done チェック →
//   薄くなる → すっと畳まれる)。猶予中の取り消しは「塗り丸の再タップ=再開」に一本化する
//   (cancelDoneExit が退場タイマー/グレーフェードを止める)。
//   【> 2026-07-17 実機 FB 第2ラウンド(A-3 / A-4)】(A-3)グレーにする対象を「タイトルのテキストのみ」に
//   絞る(丸チェックやメタ行=due/繰り返し等は通常の done 表示のまま。行全体を退色させると「もう消えた
//   行」に見えすぎるとの FB)。→ retire-fade は li ではなくタイトル要素にだけ当てる。
//   (A-4)猶予を 2000→3000ms に延長(「消えるまで 3s くらい待ってもいい」= undo/確認の余裕を増やす)。
// 【agenda には無い】agenda(予定)は完了概念が無いので残骸問題そのものが起きない(この機構は todos 専用)。
const DONE_EXIT_GRACE_MS = 3000; // 約3秒(> 2026-07-17 実機 FB A-4: 2000→3000。undo 猶予の余裕を増やす)
// exitTimers: 退場待ちの行 id → setTimeout ハンドル(行ごと1本)。renderAll 再走(ポーリング等)で
//   二重タイマーが張られないよう scheduleDoneExit が has() ガードする(冪等)。
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
// graceStartAt: 退場待ちの行 id → 猶予開始時刻(ms epoch)。renderRow がグレーフェードアニメの
//   animation-delay を負値で resume する(renderAll が li を作り直しても、タップからの経過位置から
//   フェードを継続させ「頭出しに巻き戻る」チカチカを防ぐ。committing アニメの animUntil と同じ手法)。
const graceStartAt = new Map<string, number>();
// retiredDoneIds: 退場済み(高さ0へ畳んで remove した)行の id。rebuildDisplay / renderAll が
//   この集合の id を「もう再合成しない」ことで、ポーリング再描画や includeCompleted ビューの確定 vm
//   から幽霊復活するのを防ぐ(退場の冪等性の要)。実質別ビュー切替(resetPositionMemory)でクリアし、
//   サーバーが当該 id を未完了で返してきたら un-retire する(genuine な外部再開は再表示を許す)。
const retiredDoneIds = new Set<string>();
// heldDoneExitIds: 監査 C(選択編集中の行が外部完了で退場すると編集テキストが黙って消える)対策。
// 「ユーザーが触っている行を土台ごと消さない」不変条件(2026-07-17 の fold 選択固定と同じ精神)を
// 退場機構にも適用する。selectedId===id の間は退場(タイマー開始/実行のどちらも)を保留し、id を
// ここへ積んでおく。選択解除(commitSelection)時に resumeHeldDoneExit で退場猶予を仕込み直す。
const heldDoneExitIds = new Set<string>();
/** 完了行の退場タイマーを仕込む(約5秒後に retireDoneRow)。冪等 — 既にタイマーがある/退場済みなら何もしない
 *  (renderAll 再走での二重タイマー・復活防止)。選択(編集)中の行(selectedId===id)は開始せず保留する
 *  (監査 C)。 */
function scheduleDoneExit(id: string): void {
	if (exitTimers.has(id) || retiredDoneIds.has(id)) return;
	if (selectedId === id) {
		heldDoneExitIds.add(id);
		return;
	}
	graceStartAt.set(id, Date.now()); // グレーフェードの起点(renderRow が resume delay に使う)
	const timer = setTimeout(() => {
		exitTimers.delete(id);
		retireDoneRow(id);
	}, DONE_EXIT_GRACE_MS);
	exitTimers.set(id, timer);
}
/** 退場タイマーを取り消す(undo=再開時 / 外部再開検知時)。退場済みマーク・グレーフェード起点も解除して
 *  再表示を許す。保留中(heldDoneExitIds)のマークも合わせて解除する。 */
function cancelDoneExit(id: string): void {
	const t = exitTimers.get(id);
	if (t !== undefined) {
		clearTimeout(t);
		exitTimers.delete(id);
	}
	graceStartAt.delete(id);
	retiredDoneIds.delete(id);
	heldDoneExitIds.delete(id);
}
/** 選択解除(commitSelection)で呼ぶ: 直前まで選択されていた行 id の退場が保留(heldDoneExitIds)されて
 *  いれば、いま改めて退場猶予を仕込み直す(監査 C の「保留 → 選択解除で再開」の本体)。 */
function resumeHeldDoneExit(id: string | null): void {
	if (id === null) return;
	if (heldDoneExitIds.delete(id)) scheduleDoneExit(id);
}
/** 完了行を退場させる(高さ0へ畳んで remove → 状態から追放して再描画)。
 *  prefers-reduced-motion: reduce では畳みアニメを止めて即時 remove(モーション過敏配慮)。
 *  DOM に行が見つからない(既に畳まれている等)場合も即 finish。選択(編集)中の行(selectedId===id)は
 *  タイマー発火時点で選択に入っていた場合の防御として、ここでも保留する(監査 C)。 */
function retireDoneRow(id: string): void {
	if (retiredDoneIds.has(id)) return; // 既に退場済み(冪等)
	if (selectedId === id) {
		heldDoneExitIds.add(id);
		return;
	}
	// finish: 状態から追放し、確定土台の上に楽観を重ね直して再描画する。retiredDoneIds に入れることで
	// rebuildDisplay / renderAll が二度と再合成しない(sticky/positionMemory も消す)。
	const finish = (): void => {
		if (retiredDoneIds.has(id)) return; // transitionend とフォールバック setTimeout の二重発火ガード
		retiredDoneIds.add(id);
		graceStartAt.delete(id);
		positionMemory.delete(id);
		stickyData.delete(id);
		optimisticToggle.delete(id);
		rebuildFromConfirmed();
		renderAll();
	};
	const li = root.querySelector<HTMLLIElement>(`li[data-id="${cssEscapeId(id)}"]`);
	// 【reduced-motion / 行が DOM に無い → 即時 remove】matchMedia が無い環境(古い WebView)は
	// 「モーション過敏でない」とみなして通常のアニメ経路へ(?? false)。
	const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	if (prefersReduced || li === null) {
		finish();
		return;
	}
	// 高さ0へ畳むトランジション: max-height は「値なし→0」だとアニメしないので、現在の実高さを一旦
	// 明示してから次フレームで 0 にする(CSS トランジションの定番。.exiting が transition プロパティを持つ)。
	li.style.maxHeight = `${li.offsetHeight}px`;
	li.classList.add("exiting");
	requestAnimationFrame(() => {
		li.style.maxHeight = "0px";
	});
	li.addEventListener("transitionend", finish, { once: true });
	// 保険: transitionend が来ない(要素が別要因で先に外れた等)場合でも必ず finish する。
	setTimeout(finish, 500);
}
/** querySelector 用の id エスケープ(CSS.escape があれば使う。無い古い環境は素通し — 実 todo id は
 *  UUID 系でセレクタ特殊文字を含まないため実害はほぼ無いが、防御的に用意する)。 */
function cssEscapeId(id: string): string {
	const cssApi = (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS;
	return cssApi?.escape !== undefined ? cssApi.escape(id) : id;
}

// --- 並び順安定性(位置記憶。2026-07-14 ユーザー確定の仕様変更)---------------------------
// 【なぜ位置記憶を持つか】完了操作でタスクが下(完了済みセクション)へ即移動するのは違和感がある、
// becoming で「その場に留める」と決めたのに次の確定描画で再セクショニングされて結局落ちるのは
// 裏切り、というユーザー判断。よってカードインスタンスの生存中は「一度現れた行はその場に留め、
// 状態(完了/未完了)だけ更新する」。クリーンな再セクショニング(完了が完了欄へ移る)は次の
// カードインスタンス(fresh render = ページ再ロードで module state が新品)か、実質別ビュー
// (calendarId 変更・view 変更)への切り替え時のリセットでだけ起きる。
// 【confirmedTasks / 楽観設計との分離(要件5)】位置記憶は「表示層(renderAll の並べ替え段)だけの
// 関心」。confirmedTasks(差分レンズの土台・クリーン)も optimisticToggle/optimisticRows(in-flight
// 楽観)も一切汚さない。位置記憶と stickyData は renderAll でのみ読み書きする。
type SectionKey = "overdue" | "today" | "upcoming" | "noDue" | "completed";
const SECTION_ORDER: readonly SectionKey[] = ["overdue", "today", "upcoming", "noDue", "completed"];
// positionMemory: id → 記憶した表示位置(どのセクションの、何番目か)。order は単調増加の絶対値で、
// セクション内はこの order 昇順に並べる(新規行は positionSeq を進めて末尾に付く)。
const positionMemory = new Map<string, { section: SectionKey; order: number }>();
// stickyData: id → 最後に見たフル TodoItem。既定ビューで完了した行は確定 vm(未完了ビュー)から
// 抜けるが、位置記憶にある間はこの last-known データでその場に描き続ける(=「操作履歴を残す UI」の本体)。
const stickyData = new Map<string, TodoItem>();
let positionSeq = 0; // order の採番カウンタ(単調増加)。リセットで 0 に戻す。
/** 位置記憶を破棄して次の renderAll をクリーン描画にする(実質別ビューへの切り替え時)。 */
function resetPositionMemory(): void {
	positionMemory.clear();
	stickyData.clear();
	positionSeq = 0;
	// C0-a: 実質別ビューへ切り替えたら完了残骸の退場タイマー/退場済みマークもリセットする(前ビューの
	// 保留タイマーが新ビューの無関係な行を退場させないように・別ビューでは残骸の連続性も無い)。
	for (const t of exitTimers.values()) clearTimeout(t);
	exitTimers.clear();
	retiredDoneIds.clear();
}
/** 位置記憶に無い新規行の自然セクション(due/completed 規則)。初出時の配置と、非 manual 経路の
 *  per-item ロジックに揃える。completed は "completed"(初出時に既に完了していた行だけがここに来て
 *  完了済み <details> の受け皿になる。位置不変 item 3 の選択肢(b)= セッション中に done した行は
 *  「初出時 未完了」なので dueSection の元セクションに留まる)。 */
function naturalSection(task: TodoItem, todayKey: string): SectionKey {
	if (task.completed) return "completed";
	return dueSection(task, todayKey);
}
/** 完了状態を無視した「期日ベースのセクション」。位置不変(item 3・要件5)の「due 編集でセクションを
 *  跨いだか」判定に使う — done/undo(completed 変化)は naturalSection を "completed" へ動かすが、位置は
 *  動かしてはならないので、跨ぎ判定は completed を無視した dueSection どうしで行う(完了に伴うセクション
 *  変化を再配置トリガーにしないための分離。要件3 と要件5 を両立させる鍵)。 */
function dueSection(task: TodoItem, todayKey: string): Exclude<SectionKey, "completed"> {
	if (task.due === null) return "noDue";
	const diff = dayDiff(wallDatePart(task.due), todayKey);
	if (diff < 0) return "overdue";
	if (diff === 0) return "today";
	return "upcoming";
}
// sortMode の seam(将来の表示順序設定に備える。docs/modeling/12 §7.8 v2.2)。iOS リマインダーは
// 表示順序を「手動 / 期限 / 作成日 / 優先順位 / タイトル」から選べる。既定は「手動」で、位置不変
// (一度現れた行はその場に留め状態だけ更新)はこの「手動」モードの挙動そのもの。今回は "manual" 固定で、
// 他モード(期限順など)の実装はしない — 既存の compareTasks を「非 manual 時の比較関数」として温存し、
// renderAll の並べ替え段だけを `sortMode === "manual" ? 位置記憶順 : compareTasks 系` で分岐できる構造に
// しておく。設定 UI・永続化(sortMode を選ばせて保存する)は別スライス(今回スコープ外)。
// 【なぜ let でなく const か】今回は切替 UI が無いので再代入は起きない。将来 UI を足すときに let へ
// 昇格 + 永続化を配線する(その1点だけの変更で他モードへ道が通る、という seam の置き場所)。
const sortMode: "manual" = "manual";
// currentCalendarId(E-2 スライス③): この一覧が今どのコレクションを表示しているか。
// 応答の vm.calendarId(server の buildTodosViewModel は必ず載せる。省略時は "tasks")で更新し、
// ヘッダ見出しの表示と quick-add の作成先(create-todo の calendarId)に使う。null = 未受領。
let currentCalendarId: string | null = null;
// currentTimeZone(v2): この一覧の解釈ゾーン(vm.timeZone)。詳細シートの「時間帯」行を、閲覧者の
// Intl ゾーンと異なるときだけ出すために保持する。null=未受領(その間は時間帯行を出さない)。
let currentTimeZone: string | null = null;
// becoming(変化の中間状態)の元データ。応答を受け取るたびに丸ごと置き換える —
// affected/removed の無い応答(list/refresh)が来れば空になり、becoming は自然に平常へ
// 戻る(「次の描画まで」というライフサイクルを別タイマー等で管理しない。状態は応答が正)。
// affectedById / ghosts は「表示用」の becoming メタ(サーバー由来 + sync 由来 + 楽観由来)。
// rebuildDisplay がこの2つを組み立て、renderRow/announceBecoming が読む。
let affectedById = new Map<string, AffectedEntry>();
let ghosts: TaskSnapshot[] = [];
// serverAffectedBase / serverGhostsBase = 直近の applyStructuredContent が確定した「サーバー
// (+sync)由来の becoming 土台」。楽観アクション(トグル/quick-add)から rebuildDisplay を
// 呼ぶとき、この土台の上に楽観 becoming を重ねる(確定 vm を通さない楽観だけの再描画のため)。
let serverAffectedBase: AffectedEntry[] = [];
let serverGhostsBase: TaskSnapshot[] = [];
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

/** refresh-todos / list-todos 系を呼ぶときの arguments。currentView に加えて currentCalendarId を
 *  必ず載せる(2026-07-14 実機バグ修正)。
 *  【なぜ calendarId を必ず載せるか(重大バグの根治)】focus refetch が calendarId を渡さないと
 *  server 既定 "tasks" を取得してしまい、reading-list 等の別コレクションで開いたカードが
 *  ダブルクリック(iframe フォーカス)のたびに tasks コレクションの内容へ化ける
 *  (→ 差分レンズが全行「同期(追加)」+ 消えた行のゴーストまみれになる)実機事故があった。
 *  currentCalendarId が null(初回応答前)のときは省略して従来どおり server 既定に委ねる。 */
function refreshArgs(): Record<string, unknown> {
	const args = viewAsArgs(currentView);
	if (currentCalendarId !== null) args.calendarId = currentCalendarId;
	// 【2026-07-17 時刻付き todo の TZ グラウンディング(read 側の UTC 落ち修正)】
	// 再取得(refetch/mutate 後の refresh-todos)には閲覧デバイスの IANA ゾーンを常時載せる。
	// これが無いと server 側 resolveTimeZone が UTC に落ち、時刻付き DUE が UTC のまま表示されて
	// 「作成時は正しいのに再取得で時刻がズレる」実機事故になる(真因は read 側で timeZone が
	// 伝播していなかったこと。create-todo は既に Intl ゾーンを送っていた)。refreshArgs は
	// 再取得の単一チョークポイントなのでここ1点で全 refresh 経路をグラウンドする。
	args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return args;
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
/** エラーバナーを出す。retry を渡すと「再試行」ボタン付きになる。
 *  【2026-07-16 撤回: label 引数を削除(item 1)】label は T_hard 警告バナー専用の「再読み込み」
 *  文言を渡すためだけに存在したが、T_hard バナー自体を廃止した(startCommitting 参照)ため
 *  呼び出しが無くなった。残る呼び出しはすべて失敗バナー(mutate 再送の「再試行」)なので、
 *  ボタン文言を「再試行」固定に縮退させた。 */
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

// localDateKey / wallDatePart / wallTimePart / dayDiff / WEEKDAYS は ui/format.ts へ移設(共有カーネル)。

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
// 入力フォーム部品(E-2 スライス⑥前半・quick-add 詳細 / 詳細編集で共用)
// =============================================================================
// quick-add の段階的開示パネルと詳細展開の編集フォームで、期日(ネイティブ input)・優先度
// セグメント・メモ textarea の3部品を使い回す。iOS リマインダーの新規/編集フォームが同じ語彙で
// 出す語彙に寄せる(2つの入口で見た目が割れないように部品を1本化)。

/** 優先度セグメントの4値。value は create-todo/update-todo へ送る PRIORITY 数値(iOS 準拠:
 *  高=1 / 中=5 / 低=9 / なし=0)。priorityMarks(表示側の 1-4→!!!, 5→!!, 6-9→!)の逆写像で、
 *  ユーザーが選んだ ! の段階を代表値 1/5/9 に落とす(iOS が書く実測値。docs/modeling/06)。 */
const PRIORITY_SEGMENTS: ReadonlyArray<{ label: string; value: number; aria: string; pri: boolean }> = [
	{ label: "なし", value: 0, aria: "優先度なし", pri: false },
	{ label: "!", value: 9, aria: "優先度 低", pri: true },
	{ label: "!!", value: 5, aria: "優先度 中", pri: true },
	{ label: "!!!", value: 1, aria: "優先度 高", pri: true },
];

/** 既存タスクの PRIORITY(0-9)を「どのセグメントが選ばれている状態か」の代表値(0/1/5/9)へ丸める。
 *  priorityMarks と同じ区分(1-4=高, 5=中, 6-9=低)を使う。編集時に「見た目のバケットが変わったか」で
 *  変更判定するため(例 priority=3 の行はセグメント「!!!」= 代表値1 が選択状態、そのまま保存しても
 *  3→1 の無用な変更を送らないよう、代表値どうしで比較する)。 */
function priorityToSegment(priority: number): number {
	if (priority <= 0) return 0;
	if (priority <= 4) return 1;
	if (priority === 5) return 5;
	return 9;
}

// 【v2→v3 で覆した点(経緯・財産)】createPrioritySegment(セグメンテッドコントロール部品)と
// createDueField(date⇔datetime-local 切替の日付部品ファクトリ)は v3 で削除した。どちらも旧
// quick-add ボトムシートと v2 の詳細フォームで共用する「部品ファクトリ」だったが、v3 の詳細ページは
// 裸の date/time input + 行内 chips を素の DOM で直接組む方針(モックの語彙)にしたため使わなくなった。
// 優先度は PRIORITY_SEGMENTS(下の定数)を buildDetailPage が直接 chips へ展開し、日付は f-row の
// 裸 input(.naked)で表現する。共通部品を挟まないぶん、モックのマークアップと1対1で対応させやすい。

// 繰り返し(RRULE 要約)の人間可読整形は ui/recurrence.ts へ移設(共有カーネル)。
// WEEKDAY_JA / RECUR_EVERY / formatRecurrence は import 済み。formatUntilDate / formatRecurrenceFull /
// RECUR_UNIT は todos では未使用(agenda 側の詳細で使う)ため import せず recurrence.ts に置くだけにした。

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

/** 完了済みセクションの並び「新しく完了したものが上」(completedAt 降順)。完了直後に自分の操作の
 *  結果が折り畳みを開いた先頭に見える方が操作→確認の導線として自然。manual 経路では「初出時に
 *  既に完了していた行」の初回採番順にだけ使う(以後は位置記憶順で不変)。 */
function completedDesc(a: TodoItem, b: TodoItem): number {
	const ca = a.completedAt ?? "";
	const cb = b.completedAt ?? "";
	if (ca !== cb) return ca < cb ? 1 : -1; // ISO 文字列の辞書順 = 時刻順(同一形式前提)
	return a.title.localeCompare(b.title, "ja");
}

/** タスクを5セクションへ振り分ける(**非 manual(将来の期限順など)経路の比較関数**)。completed 判定は
 *  DTO の completed(boolean)を正とする。時刻付きで「今日だがもう過ぎた」は期限切れでなく今日に置く。
 *  【2026-07-16 撤回: inPlaceDone / pinnedAdded* の特例を削除(item 3・位置不変)】
 *  旧実装はここに2つの特例を持っていた:
 *   - inPlaceDone: becoming-done(いま完了した行)を完了折り畳みへ飛ばさず due の元セクションに留める。
 *   - pinnedAdded*: becoming-in(いま追加された optimistic 行)を通常ソートから外し各セクション末尾へ
 *     投入順でピンする(空 due 行が title.localeCompare で draft から離れた位置へ飛ぶのを防ぐ)。
 *  どちらも「一度現れた行はその場に留める」の部分的な応急処置で、位置記憶(positionMemory)の
 *  一般化 = sectionizeManual がインスタンス生存中の全行について包含する(done-in-place は memory の
 *  元セクション + sticky で、add は natural セクション末尾ピンで実現)。よって manual 経路ではこの
 *  関数は使われず、非 manual 経路のための純粋な compareTasks 整列だけに縮退させた(affectedById を
 *  もう読まない = affectedById は becoming の視覚専用に純化)。非 manual(期限順など)は今回未実装
 *  なので、この関数は温存されるだけで実行経路に乗らない。 */
function sectionize(items: TodoItem[], todayKey: string): Sections {
	const s: Sections = { overdue: [], today: [], upcoming: [], noDue: [], completed: [] };
	for (const t of items) {
		if (t.completed) s.completed.push(t);
		else s[dueSection(t, todayKey)].push(t);
	}
	s.overdue.sort(compareTasks);
	s.today.sort(compareTasks);
	s.upcoming.sort(compareTasks);
	s.noDue.sort(compareTasks);
	s.completed.sort(completedDesc);
	return s;
}

/**
 * 位置不変(item 3・「手動」表示順序モード)の並べ替え。docs/modeling/12 §7.8 v2.2・2026-07-14 確定仕様
 * (positionMemory / stickyData 宣言のコメントに残る仕様)の完成。**状態機械ではなく配置規則**:
 *
 *  1. 初出時に一度だけ配置: このカードインスタンスで初めて描画される行は naturalSection でセクションを
 *     決め positionSeq++ で順位採番する。**初出時のセクション内相対順は compareTasks(completed は
 *     completedDesc)で決めてから採番**する(インスタンス誕生時の初回描画だけクリーン整列)。
 *  2. 以後は positionMemory の order 昇順のみで並べる(サーバーが tasks をどの順で返そうが既出行は不動)。
 *  3. done/undo は位置に作用しない: completed になっても memory のセクション・順位は不変(取消線+塗り円で
 *     状態だけ変わる)。既定(未完了)ビューでは確定 vm から行が抜けるので、stickyData の last-known で
 *     その場に描き続ける(=「操作履歴を残す UI」の本体)。
 *  4. add は natural セクション(タイトルのみなら noDue)末尾に採番され確定後もそこ(下記 transient 経由の
 *     optimistic 行と、確定後の実行が最新 order で末尾に付くことで「同じ場所」を保つ)。
 *  5. 唯一の例外 = due 編集のセクション跨ぎ: dueSection が memory.section と変わる編集のときだけ再配置
 *     (旧エントリ削除 → 新セクション末尾に再採番)。done/undo・同一セクション内の due 変更・タイトル/
 *     メモ/優先度編集は不動(completed を無視した dueSection どうしの比較なので done で動かない)。
 *  6. delete は消滅(applyStructuredContent が removed で positionMemory/stickyData を削除済み)。ghost 行は
 *     memory を失っているので transient として natural セクション末尾に1描画だけ出して becoming-gone で消える。
 *  7. クリーン再セクショニングの唯一の契機 = インスタンス境界(fresh render / calendarId・view 切替の
 *     resetPositionMemory)。この関数はそれ以外では既出行の memory を書き換えない。
 *  8. 完了済み <details> は選択肢(b): 「インスタンス誕生時に既に完了していた項目」だけの受け皿。初出時
 *     completed の行だけ naturalSection が "completed" を返し memory.section=completed → details へ入る。
 *     セッション中に done した行は「初出時 未完了」なので memory.section は dueSection の元のまま=その場に
 *     取消線で残り details に入らない。summary 件数は details 内の実数(s.completed.length)のみ。
 *
 * 【引数の分担】
 *   realLive   = 位置記憶で管理する「実在の確定/楽観重ね行」(confirmedTasks 由来。full data)。sticky を更新する。
 *   synthDone  = 案X の completed 合成(既定ビューで tasks から抜けた done-in-place の一過性フレーム行)。
 *                memory は既存(初出は未完了時)なので位置は memory 由来。sticky は「無ければ」だけ埋める
 *                (低忠実度の synth で、楽観フレームで入った full-data sticky を上書きしないため)。
 *   transient  = memory に載せない一過性行(optimistic 追加行・ghost)。natural セクション末尾に投入順で付く。
 *
 * 【なぜ optimistic 行を memory に載せないか(Why not・id 引き継ぎの割り切り)】optimistic:xxx の仮 id は
 *   create 確定で実 id へ置き換わるが、両者を結ぶ確実な写像は無い(サーバー採番 id を事前に知り得ない)。
 *   仮 id に memory を持たせると確定後に迷子の memory エントリが残り、sticky に載せれば削除後に「幽霊住人」
 *   として復活しうる。よって仮行は transient(末尾ピン)に留め、確定した実行が最新 order で natural
 *   セクション末尾に採番される(=仮行が居た末尾と同じ場所)ことで「確定後もそこ」を実現する。
 */
function sectionizeManual(
	realLive: TodoItem[],
	synthDone: TodoItem[],
	transient: TodoItem[],
	todayKey: string,
): Sections {
	// --- live データの索引化 + sticky 更新 -------------------------------------------------
	const liveById = new Map<string, TodoItem>();
	for (const t of realLive) {
		liveById.set(t.id, t);
		stickyData.set(t.id, t); // 実在行は full data。done-in-place の完了版はここ(楽観重ね)で入る。
	}
	for (const t of synthDone) {
		// synth は「その id を今フレーム描くための最小行」。memory は既に存在する(初出=未完了時)ので
		// 位置は memory 由来。liveById には無ければ入れる(このフレームの描画データとして)。
		if (!liveById.has(t.id)) liveById.set(t.id, t);
		// sticky は「無ければ」だけ埋める(楽観トグルのフレームで入った full-data を低忠実 synth で潰さない)。
		if (!stickyData.has(t.id)) stickyData.set(t.id, t);
	}

	// --- 初出採番 + due 編集セクション跨ぎの再配置 -----------------------------------------
	interface Pending {
		task: TodoItem;
		section: SectionKey;
	}
	const toNumber: Pending[] = [];
	for (const t of liveById.values()) {
		const mem = positionMemory.get(t.id);
		if (mem === undefined) {
			// 初出: naturalSection で配置(completed なら "completed" → 選択肢(b)の details 受け皿)。
			toNumber.push({ task: t, section: naturalSection(t, todayKey) });
		} else if (!t.completed && mem.section !== "completed") {
			// 既出かつ現在未完了かつ memory が due セクション → due 編集でセクションを跨いだかを判定する。
			// completed 行(done-in-place)と born-completed 行は除外 = done/undo で位置は動かさない(要件3)。
			const ds = dueSection(t, todayKey);
			if (ds !== mem.section) {
				positionMemory.delete(t.id); // 旧エントリを消して新セクション末尾に再採番(要件5)。
				toNumber.push({ task: t, section: ds });
			}
		}
	}
	// セクションごとにまとめ、初出時だけクリーン整列(compareTasks / completedDesc)してから採番。
	// 複数行が同一フレームで初出しても「セクション内は due→sortOrder→title のクリーン順」で番号が付く。
	const bySection = new Map<SectionKey, Pending[]>();
	for (const p of toNumber) {
		const arr = bySection.get(p.section);
		if (arr === undefined) bySection.set(p.section, [p]);
		else arr.push(p);
	}
	for (const [section, arr] of bySection) {
		arr.sort((a, b) => (section === "completed" ? completedDesc(a.task, b.task) : compareTasks(a.task, b.task)));
		for (const p of arr) positionMemory.set(p.task.id, { section, order: positionSeq++ });
	}

	// --- memory 順(order 昇順)でセクションを組み立てる。データは live 優先・無ければ sticky ---------
	const withOrder: Record<SectionKey, Array<{ task: TodoItem; order: number }>> = {
		overdue: [],
		today: [],
		upcoming: [],
		noDue: [],
		completed: [],
	};
	for (const [id, mem] of positionMemory) {
		// 楽観削除中(optimisticDeletes)の行は「削除ボタンを押した瞬間に消える」= その場から即除去する。
		// rebuildDisplay は displayTasks から filter 済みだが、positionMemory/stickyData は削除確定
		// (サーバー removed)まで残る設計なので、ここで明示的にスキップしないと sticky 経由で行が復活して
		// しまう(楽観削除が効かない実害。失敗時は optimisticDeletes から抜けて sticky/live 経由で復活する)。
		if (optimisticDeletes.has(id)) continue;
		const data = liveById.get(id) ?? stickyData.get(id);
		// データが無い(例: 迷子になった optimistic memory は本来作らないが保険)エントリは描かない。
		if (data === undefined) continue;
		withOrder[mem.section].push({ task: data, order: mem.order });
	}
	const s: Sections = { overdue: [], today: [], upcoming: [], noDue: [], completed: [] };
	for (const key of SECTION_ORDER) {
		withOrder[key].sort((a, b) => a.order - b.order);
		s[key] = withOrder[key].map((x) => x.task);
	}

	// --- transient(memory に載せない一過性行)を natural セクション末尾に投入順で付ける --------------
	for (const t of transient) {
		const sec = naturalSection(t, todayKey);
		s[sec].push(t);
	}
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

/** 1行(li)を組み立てる(v2 選択モデル)。行 = [丸チェック][head(2行)][trailing]。
 *  非選択: head = タイトル + meta(due/⟳/📍/becoming ラベル)。head タップで選択に入る。
 *  選択:   head = タイトル input + 「メモを追加」行 + meta、trailing に ⓘ(詳細シートを開く)。
 *  チェックは実 <button>(aria-pressed)にする — div+onclick は VoiceOver がボタンとして
 *  読まずキーボード操作もできないため。 */
function renderRow(task: TodoItem, todayKey: string): HTMLLIElement {
	// 【C0-c: 削除ゴースト(破線プレースホルダ)は廃止(2026-07-17 ユーザー裁定)】
	// 旧実装はここで `ghosts.some((g) => g.id === task.id)` を判定し renderGhostRow(破線ボックス+
	// 「削除」タグ)へ早期 return していたが、ユーザー裁定「基本削除しない(完了にする)し、削除した
	// ものは見せなくていい(点々は不要)」に従い、削除された行は視覚には一切出さない(即消滅)。
	// ghosts 配列自体は announceBecoming の aria-live 通知(sync 由来の外部削除を音声で知らせる)と
	// positionMemory/stickyData の掃除にはまだ使うが、DOM 行としては描かない(renderGhostRow は廃止)。
	const li = document.createElement("li");
	// data-id: 行外タップ判定(document click の deselect / swipe close)で closest("li[data-id]") から
	// 拾うため。renderAll は #root を innerHTML で作り直すので毎描画で付け直す。
	li.dataset.id = task.id;
	if (task.completed) li.classList.add("done");
	const sel = selectedId === task.id;
	// ドラフト行(FAB で生やす未送信の新規行)。選択状態の見た目を流用しつつ、確定文法が「create」に
	// なる・チェック無効・ⓘ が作成モード詳細を開く、の3点だけ通常の選択行と分岐する。
	const isDraft = isDraftId(task.id);
	const swiped = swipeId === task.id;
	if (sel) li.classList.add("selected");
	if (swiped) li.classList.add("swiping");

	// becoming 装飾の決定。未知 kind は何も足さない(通常描画へ degrade)。
	// 2026-07-14 楽観更新: in-flight のトグルは optimisticToggle 由来の becoming(completed/reopened)を
	// この affectedById 経由で受け取り、その場で塗り丸/破線に変わる(スピナーは無い)。
	const aff = affectedById.get(task.id);
	// 【2026-07-16 v2.1 §7.8】この行がいま committing(寿命1周のアニメ最中)かを animUntil(サーバー
	// 確定=pendingIds とは独立した「tap からの固定寿命」)から判定する。pendingIds はもう見ない
	// (見ると旧バグ = サーバー確定が速いとアニメが途中で切れる、に戻る。animUntil 宣言のコメント参照)。
	// startedAt は animUntil(満了時刻)から cycleMs×animCycles を引いて逆算する(pendingIds の
	// startedAt は成功分岐で先に delete されうるため、寿命そのものを唯一の情報源にする)。isCommitting
	// (feedback.ts の共有純関数)へこの逆算した startedAt を渡し、判定式そのものは単一情報源のまま保つ。
	const animExpiresAt = animUntil.get(task.id);
	const committingStartedAt =
		animExpiresAt !== undefined ? animExpiresAt - FEEDBACK.cycleMs * FEEDBACK.animCycles : null;
	const committing = committingStartedAt !== null && isCommitting(Date.now(), committingStartedAt);
	// アニメ要素の再描画耐性(v2.1 修正A-4): 成功時 renderAll で li が作り直されるとアニメが頭から
	// 再生され「跳ねる」。committing 中の各アニメ要素へ inline animation-delay を負値で与え、経過位置
	// から再開させる(CSS アニメの標準テクニック — 負の delay は「もう delay 分だけ再生し終えた状態」
	// から始まる)。
	/** committing 中の要素へ経過位置からの animation-delay を付ける小ヘルパー。 */
	const applyAnimResume = (elm: HTMLElement): void => {
		if (committingStartedAt === null) return;
		elm.style.animationDelay = `-${Date.now() - committingStartedAt}ms`;
	};
	// 【2026-07-18 実機 FB「完了も追加もテキスト不要」(ユーザー裁定)】旧実装はここで tagText に
	// "完了"/"追加"/"編集済み"等/sync 時は「同期(...)」を積み、meta 右端の .tag span へ描いていた
	// (直下のコメント群参照)。実機で「テキストの意味が薄い(チェック円の塗り・リング等の非テキスト
	// 演出で状態は十分伝わる)」との FB を受け、becoming の視覚テキストタグは全廃する。
	// 【何を残すか】(1) チェック円の塗り/リング・becoming-* クラス(li の CSS 演出)はそのまま維持。
	// (2) editPlan(due/priority のインライン旧→新差分表示・「他N件」)はタグとは別物(値そのものの
	// 提示で「テキストラベル」ではない)なので維持。(3) announceBecoming の aria-live 音声通知は
	// a11y として維持(視覚が無くても状態変化をスクリーンリーダーに伝える必要は消えない)。
	// planEdit の EditPlan.tag フィールド自体はもう画面に出さないが、「何が変わったか」の要約文言
	// 生成ロジックとして構造は残す(死んでも害は無い経緯記録・将来 aria-live 文言に転用しうる)。
	let editPlan: EditPlan | null = null;
	// v2.1 A-4: どの要素へ animation-delay resume を適用するか(circle=done/undo の ring-pulse+pop、
	// row=add の inflight シマー、tag=edit の opacity pulse)。renderRow 内で対象要素を作る箇所が
	// それぞれ離れているため、ここではフラグだけ立てて後段(check/circle 生成部)で applyAnimResume を
	// 呼ぶ。resumeTag(tag=edit)は 2026-07-18 のテキストタグ全廃で対象要素(tagEl)が無くなり死コード化
	// した(上の "edited" 分岐コメント参照)。
	let resumeCircle = false;
	let resumeRow = false;
	let resumeTag = false;
	if (aff !== undefined) {
		// 【2026-07-18 テキストタグ全廃】sync(E-2 スライス④)由来かどうかで文言を「同期(...)」と
		// 出し分けていたのは表示テキストの分岐だけだったため、テキストタグ全廃に伴い isSync 変数
		// (aff.sync)自体もこの描画分岐からは不要になった(aff.sync は announceBecoming 側の
		// aria-live 文言でまだ読む — そちらは視覚ではなく a11y なので維持)。
		if (aff.kind === "completed") {
			li.classList.add("becoming-done");
			// ring-pulse(0→35%→0 の脈動 + circle の軽いポップ): committing 中だけ乗せる。満了後は
			// li.becoming-done .circle の静的 14% リングにそのまま収束する(committing クラスが外れる
			// だけで box-shadow の値自体は変わらない = アニメの終端フレームと静的形が一致するよう CSS
			// 側で揃えてある。v2.1 修正A-5: 旧 14% 一定リングは check 円の青塗り潰しに埋もれ視認性が
			// 低いとの実機 FB を受け、todos-app.ts 側でリング濃度とポップを強化した)。
			if (committing) {
				li.classList.add("committing");
				resumeCircle = true;
			}
			// isSync(同期由来か)は今はテキストタグの出し分けにしか使っていなかった(廃止済み)。
			// 変数自体は announceBecoming 側で別途 sync 判定するため、ここでは何もしない。
		} else if (aff.kind === "reopened") {
			// 【> 2026-07-17 実機 FB3: undo(再開)は「元に戻すだけ」— 特殊 state / 演出を外す】
			// 旧実装はここで becoming-undone(reopened 専用の逆再生リング演出)+ committing ring-pulse +
			// 「再開」タグを付けていた。ユーザー裁定「undo は元に戻すだけだから特殊な state は不要」に従い、
			// 塗り丸再タップの undo は「チェックアイコンがあっさり戻り、行が即座に未完了の見た目へ」だけに
			// する — ここでは何の装飾も付けない(aff.kind==="reopened" は依然 announceBecoming の aria-live
			// 「未完了に戻しました」には使うので分岐自体は残すが、視覚は素の未完了行=li に .done が付かない
			// ことで自然に達成される)。becoming-undone / li.becoming-undone .circle の CSS(todos-app.ts)は
			// 退行時の再利用に備え残置(参照されなくなった=死んでも害は無い経緯記録)。
			// sync 由来の外部再開も同様に無装飾(区別を見せない — ラベルは aria のみ)。
		} else if (aff.kind === "added") {
			li.classList.add("becoming-in");
			// in-flight シマー: 仮行(quick-add optimistic row)かつ committing 中だけ .inflight を足す
			// (色は増やさず動きだけ)。2026-07-16 ドクトリン v2 で「無限ループ」を「寿命1周」に是正
			// (todos-app.ts の @keyframes wake-sweep コメント参照)。committing が寿命切れになったら
			// このクラスが外れ、静的な becoming-in の wake(帯の先頭が見える位置)に収束する。
			if (isOptimisticId(task.id) && committing) {
				li.classList.add("inflight");
				resumeRow = true; // シマーが動く要素は li 自身(row)なので resume も li に適用する。
			}
		} else if (aff.kind === "edited") {
			li.classList.add("becoming-edit");
			editPlan = planEdit(aff);
			// 【2026-07-18 テキストタグ全廃に伴う死コード化】旧実装はここで committing 中だけ
			// becoming タグ([.tag] span = 廃止済み)を opacity pulse させていた(todos-app.ts の
			// `li.becoming-edit.committing .tag { animation: opacity-pulse ... }` 参照)。タグ要素
			// (tagEl)自体を描かなくなったため、この "committing" クラス付与と resumeTag は今は
			// pulse の対象を持たない死コードになった。editPlan のインライン旧→新 diff(due/pri)は
			// テキストタグではなく値そのものの提示なので pulse を新設して肩代わりさせる必然性は無く、
			// 「削るほどの害も無い」ため CSS 側も含め経緯記録として残置する(消すのは事実として誤りの
			// ときだけ、のコメント規律)。
			if (committing) {
				li.classList.add("committing");
				resumeTag = true;
			}
		}
	}
	if (resumeRow) applyAnimResume(li);

	const check = document.createElement("button");
	check.type = "button";
	check.className = "check";
	check.setAttribute("aria-pressed", String(task.completed));
	check.setAttribute(
		"aria-label",
		task.completed ? `「${task.title}」を未完了に戻す` : `「${task.title}」を完了にする`,
	);
	const circle = document.createElement("span");
	circle.className = "circle";
	circle.setAttribute("aria-hidden", "true");
	// 未完時は CSS が color:transparent で隠す(SVG は stroke=currentColor なので同じ手法が効く。
	// 2026-07-15: 絵文字 "✓" から lucide "check" のインライン SVG へ置換)。
	circle.appendChild(createIcon("check"));
	if (resumeCircle) applyAnimResume(circle);
	check.appendChild(circle);
	// ドラフト行はまだサーバー上に存在しないので完了トグルできない(丸チェックは無効=disabled で描く)。
	if (isDraft) {
		check.disabled = true;
	} else {
		// 丸チェックのトグルは選択と干渉させない(モック要件2)。stopPropagation はしない — 別行の
		// チェックを押したら selectedId!=その行 なので document click で前選択が commit されるのは iOS 的に自然。
		check.addEventListener("click", () => void toggleTask(task));
	}

	const rowMain = document.createElement("div");
	rowMain.className = "row-main";
	rowMain.appendChild(check);

	// --- head(2行: タイトル / meta)------------------------------------------------
	const head = document.createElement("div");
	head.className = "head";
	// A-3(> 2026-07-17 実機 FB): グレーフェード(退場猶予中)の対象をタイトル要素だけに絞るための参照。
	// 非選択行=.title div / 選択行=.title-edit input のどちらかを掴む(下の inGrace ブロックで使う)。
	let titleEl: HTMLElement | null = null;

	if (sel) {
		// 選択中: タイトルは枠なし input(下線なし・背景は CSS の .row.selected が担う)。
		// 【2026-07-15 実機フィードバック修正】以前はこの分岐が input 単体だけを head に足しており、
		// 非選択時に出ていた優先度 !記号(pri-inline)とメモ有りアイコン(note-mark)が選択した瞬間に
		// 消えていた(「選択で UI が変わりすぎる」バグ)。あるべき差分は最小限(タイトル/メモが
		// 編集可能になる・trailing に ⓘ と確定ボタンが増える、だけ)なので、非選択時と同じ
		// pri-inline / note-mark を title-edit-row に並べて残す(値は変えず表示のみ)。
		const titleRow = document.createElement("div");
		titleRow.className = "title-edit-row";
		const titlePriMarks = priorityMarks(task.priority);
		if (titlePriMarks !== "" && editPlan?.priChange == null) {
			const priInline = document.createElement("span");
			priInline.className = "pri-inline";
			priInline.textContent = titlePriMarks;
			priInline.setAttribute(
				"aria-label",
				titlePriMarks === "!!!" ? "優先度 高" : titlePriMarks === "!!" ? "優先度 中" : "優先度 低",
			);
			titleRow.appendChild(priInline);
		}
		const ti = document.createElement("input");
		ti.className = "title-edit";
		ti.type = "text";
		ti.value = task.title;
		ti.setAttribute("aria-label", "タイトル");
		// ドラフト行は空なので入力を促す placeholder を出す(iOS の新規行「新しいリマインダー」)。
		if (isDraft) ti.placeholder = "新しいリマインダー";
		// Enter=確定。通常行は選択解除で確定、ドラフト行は「確定→次の空ドラフト行」(iOS の Enter で次の行)。
		// IME 変換確定の Enter は isComposing で弾く(quick-add と同じ規律)。
		ti.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (isDraft) {
					commitDraftEnter();
				} else {
					commitSelection();
					selectedId = null;
					renderAll();
				}
			}
		});
		titleRow.appendChild(ti);
		if (task.notes !== null && task.notes.trim() !== "") {
			const noteMark = document.createElement("span");
			noteMark.className = "note-mark";
			noteMark.appendChild(createIcon("text"));
			noteMark.setAttribute("aria-label", "メモあり");
			titleRow.appendChild(noteMark);
		}
		head.appendChild(titleRow);
		selTitleInput = ti;
		titleEl = ti; // A-3: 選択中の稀な退場猶予行でもフェード対象はタイトル input に限る

		// 「メモを追加」行 = 枠なし単一行 input(空なら placeholder、既存メモがあれば値表示)。
		// 直接 input 方式を採る(モック要件2 の「タップで textarea 化 or 直接 input」の後者)。
		// 全文改行編集はシート側の textarea に委ねる。input.value は改行を保持できるので、
		// 未編集なら task.notes と厳密一致 → commitSelection は notes を送らない(誤上書きしない)。
		const mi = document.createElement("input");
		mi.className = "memo-line";
		mi.type = "text";
		mi.value = task.notes ?? "";
		mi.placeholder = "メモを追加";
		mi.setAttribute("aria-label", "メモ");
		mi.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (isDraft) {
					commitDraftEnter();
				} else {
					commitSelection();
					selectedId = null;
					renderAll();
				}
			}
		});
		head.appendChild(mi);
		selMemoInput = mi;
	} else {
		// 非選択: タイトル div(優先度 ! 記号 + 本文 + メモ有りアイコン)。head タップで選択に入る。
		const title = document.createElement("div");
		title.className = "title";
		const titlePriMarks = priorityMarks(task.priority);
		if (titlePriMarks !== "" && editPlan?.priChange == null) {
			const priInline = document.createElement("span");
			priInline.className = "pri-inline";
			priInline.textContent = titlePriMarks;
			priInline.setAttribute(
				"aria-label",
				titlePriMarks === "!!!" ? "優先度 高" : titlePriMarks === "!!" ? "優先度 中" : "優先度 低",
			);
			title.appendChild(priInline);
		}
		title.appendChild(document.createTextNode(task.title));
		titleEl = title; // A-3: グレーフェードはこの .title 要素にだけ当てる
		if (task.notes !== null && task.notes.trim() !== "") {
			const noteMark = document.createElement("span");
			noteMark.className = "note-mark";
			// 2026-07-15: 絵文字 "≡"(ハンバーガーメニューに見えるとのフィードバック)から
			// lucide "text" のインライン SVG へ置換(icons.ts のアイコン選定メモ参照)。
			noteMark.appendChild(createIcon("text"));
			noteMark.setAttribute("aria-label", "メモあり");
			title.appendChild(noteMark);
		}
		head.appendChild(title);
		// 【S-D スライス①: 一覧でもメモを見たい】.notes は元々 CSS だけ定義されデッドコードだった
		// (note-mark アイコンだけが「メモがある」目印で、本文は選択して初めて読めた)。非選択行でも
		// 冒頭1行を薄いテキストで truncate 表示する(CSS .notes の overflow:hidden/ellipsis/nowrap)。
		// note-mark アイコンは「メモがある」の視覚的な目印として残す(削らない — 密なリストを
		// ざっと走査するときはアイコンの方が本文より速く目に入るため、アイコン+本文プレビューを併存)。
		if (task.notes !== null && task.notes.trim() !== "") {
			const notesPreview = document.createElement("div");
			notesPreview.className = "notes";
			notesPreview.textContent = task.notes.trim();
			head.appendChild(notesPreview);
		}
		// head タップ=選択(iOS 準拠)。仮行(create 未確定)は選択させても saveEdit が no-op なので許容。
		head.addEventListener("click", () => setSelected(task.id));
	}

	// --- meta 行: due / 繰り返しバッジ / 場所チップ / becoming ラベル(右端)----------------------
	// becoming ラベル(tag)は meta の右端(margin-left:auto)へ移設(モック要件1・④のずれ修正)。
	// (B: 自由テキスト場所チップは全廃。場所の意味は proximity バッジに一本化)。
	const dueInfo = formatDue(task, todayKey);
	const hasInline = editPlan !== null && (editPlan.dueChange !== null || editPlan.priChange !== null);
	const hasMore = editPlan !== null && editPlan.moreCount > 0;
	const hasRecur = task.recurrence !== null && editPlan?.dueChange == null;
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
		const pri = document.createElement("span");
		pri.className = "pri";
		appendDiff(pri, editPlan.priChange.before ?? "なし", editPlan.priChange.after ?? "なし");
		meta.appendChild(pri);
	}
	if (editPlan?.dueChange != null) {
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
		if (dueInfo.overdue && !task.completed) due.classList.add("overdue");
		due.textContent = dueInfo.text;
		meta.appendChild(due);
	}
	if (hasMore) {
		const more = document.createElement("span");
		more.className = "more";
		more.textContent = `他${editPlan?.moreCount ?? 0}件`;
		meta.appendChild(more);
	}
	// 繰り返しバッジ。due の後ろ(iOS リマインダーの並び)。2026-07-15: 絵文字 "⟳" から
	// lucide "repeat" のインライン SVG へ置換(icons.ts 参照)。アイコンは常に付け、テキストは
	// degrade 時("" のとき)は省く(旧仕様どおり)。
	if (hasRecur && task.recurrence !== null) {
		const recurText = formatRecurrence(task.recurrence);
		const recur = document.createElement("span");
		recur.className = "recur";
		recur.appendChild(createIcon("repeat"));
		if (recurText !== "") recur.appendChild(document.createTextNode(` ${recurText}`));
		recur.setAttribute("aria-label", recurText === "" ? "繰り返し" : `繰り返し ${recurText}`);
		meta.appendChild(recur);
	}
	// 【B(> 2026-07-17 実機 FB 第2ラウンド): vtodo 自由テキスト場所(LOCATION)チップは全廃】旧実装は
	// task.location(VTODO 直下 LOCATION テキスト)を 📍 チップで一覧表示していたが、ユーザー裁定
	// 「location は通知(geofence)のためにあり、既存のテキスト場所は不要=実装すらいらない」に従い削除した。
	// 場所の意味は下の proximity バッジ(位置通知)に一本化する。Task.location(read DTO)は互換のため温存する
	// が、カード UI では一切表示しない(既存 ICS の LOCATION は round-trip で残るが不可視)。
	// C2(設計 05 §1-a/§2): 📍 proximity バッジ(「〜に到着時 / から出発時」)。geofence リマインダーの
	// 一覧側の印。文言(到着/出発の語彙・title 欠落時の「位置情報の通知」degrade)は純関数 proximityBadge に
	// 隔離(mcp-location-view.test.ts で境界固定)。場所は proximityAlarm.location を優先する裁定(指示 6)は
	// proximityBadge が prox.location だけを見ることで実装済み(Task.structuredLocation にはフォールバックしない)。
	// 既存の loc(LOCATION 文字列)チップと視覚言語を揃える(map-pin + テキスト・truncate)が、意味は別
	// (loc=場所名の表示 / prox=位置通知の条件)なので別チップとして並べる。
	if (task.proximityAlarm !== null) {
		const badge = proximityBadge(task.proximityAlarm);
		const prox = document.createElement("span");
		prox.className = "prox";
		prox.appendChild(createIcon("map-pin"));
		prox.appendChild(document.createTextNode(` ${badge.text}`));
		prox.setAttribute("aria-label", badge.aria);
		meta.appendChild(prox);
	}
	// 【2026-07-18 becoming マイクロラベル(旧 tagEl = meta 右端 or rowMain 直下の [.tag] span)を全廃】
	// ユーザー裁定「完了も追加もテキスト不要」により、"完了"/"追加"/"編集済み"等/「同期(...)」の
	// テキストタグそのものを描かなくなった(tagText 変数ごと削除済み・上の各 aff.kind 分岐参照)。
	// 【旧コメント(2026-07-15/16 のレイアウト調整史・財産として残す)】旧実装はここでタグの配置を
	// 「meta に中身が無ければ rowMain 直下、あれば meta 内」の二枝→「常に rowMain 直下」(v2.1 修正C)
	// と調整していた。タグ自体が無くなった今はこのレイアウト分岐の対象も消えたため、当時の
	// `.row-main > .tag` / `.meta .tag` の位置調整 CSS(todos-app.ts)は死コード化している(削除は
	// せず経緯記録として残置。CSS 側にも同旨コメントを添える)。
	// resumeTag(committing 中の pulse resume 用フラグ)は上の "edited" 分岐コメントの通りいま死
	// コード化しているが、resumeCircle/resumeRow と対称の設計を保つため宣言自体は残す(TS は
	// noUnusedLocals 無効のためビルドにも影響しない)。
	// C0-a(> 2026-07-17 実機 FB2 / A-3): 完了行が退場猶予中(約3秒)なら、タイトルのテキストだけをグレーに
	// 薄れさせて自然退場に向かわせる。旧実装(C0)はここで「取り消す」テキストボタンを tag スロットへ出して
	// いたが、実機で文字が上に偏る崩れが出たうえベスプラ(Todoist の完了フェードアウト)に合わないため廃止。
	// 代わりに **タイトル要素だけ** に .retiring を付け(A-3: 丸チェック/メタ行は通常の done 表示のまま —
	// 行全体を退色させると「もう消えた行」に見えすぎる FB)、CSS の retire-fade アニメ(opacity 低下 +
	// grayscale)を done タップからの経過位置で resume する(要素を作り直しても頭出しに巻き戻らないよう
	// negative animation-delay と animation-duration を JS から与える。committing の animUntil resume と同じ
	// 手法)。退場の畳み(retireDoneRow の li.exiting)はこのフェードの終端に連続して起きる。取り消しは
	// 「塗り丸の再タップ=再開」に一本化(check の click→toggleTask→cancelDoneExit がフェード/タイマーを止める)。
	const inGrace = task.completed && exitTimers.has(task.id) && !isDraft;
	if (inGrace && titleEl !== null) {
		titleEl.classList.add("retiring");
		titleEl.style.animationDuration = `${DONE_EXIT_GRACE_MS}ms`;
		const started = graceStartAt.get(task.id);
		if (started !== undefined) titleEl.style.animationDelay = `-${Math.max(0, Date.now() - started)}ms`;
	}
	// meta は中身があるとき or 選択中(レイアウトの高さを保つため)に付ける。
	if (meta.childElementCount > 0 || sel) head.appendChild(meta);

	rowMain.appendChild(head);
	// 【2026-07-18】旧 `if (tagEl !== null) rowMain.appendChild(tagEl)` は tagEl 全廃に伴い削除。

	// --- trailing: 選択中の行だけ info ボタン(詳細シートを開く)。非選択行には何も出さない(モック要件1)---
	if (sel) {
		const info = document.createElement("button");
		info.type = "button";
		info.className = "info";
		info.setAttribute("aria-label", `「${task.title}」の詳細`);
		// 2026-07-15: 絵文字 "ⓘ" から lucide "info" のインライン SVG へ置換。ボタン自体に aria-label が
		// あるため SVG は aria-hidden のまま(createIcon の既定)。
		info.appendChild(createIcon("info"));
		info.addEventListener("click", (e) => {
			e.stopPropagation();
			if (isDraft) {
				// ドラフト行の ⓘ → v3 詳細ページを「作成モード」で開く。開く前に現在のインライン入力
				// (タイトル/メモ)を draft へ取り込んでから開く(詳細ページの初期値に引き継ぐ)。
				if (selTitleInput !== null && draft !== null) draft.title = selTitleInput.value;
				if (selMemoInput !== null && draft !== null) draft.notes = selMemoInput.value;
				openCreateSheet();
				return;
			}
			// 詳細ページを開く前にインライン編集を確定してから開く(タイトル/メモを二重管理しない)。
			// 確定後の最新表示行を詳細ページの初期値に使う(楽観上書きが乗った display 行)。
			commitSelection();
			selectedId = null;
			const latest = tasks?.find((t) => t.id === task.id) ?? task;
			openSheet(latest);
		});
		rowMain.appendChild(info);

		// 【2026-07-15 実機フィードバック: 選択の確定操作が可視でない】以前は選択解除=確定が
		// 「行外タップ / Enter」という不可視のジェスチャーしかなく、確定手段が画面上に無かった。
		// info と並ぶ小さな accent 円ボタン button.confirm を追加していた。
		// 【2026-07-16 S-E: カード右上の単一 Done へ撤去(docs/modeling/12 §7.7)】選択は常に高々1行
		// (selectedId は単一値)なので、行ごとに確定ボタンを持つ必要が元々無かった — カード全体で
		// 1個の Done(#header-done。todos-app.ts の HTML/CSS + 本ファイル末尾の click ハンドラ参照)
		// で成立する。行内に置くと info との隣接で押し間違いを誘発しやすく、また rowMain の子要素数が
		// 選択で+2(info・confirm)になることが title 垂直ズレのもう一因でもあった(row-main align-items
		// flex-start 化のコメントも参照)。ここでは button.confirm の生成を削り、trailing は info だけにする。
	}

	li.appendChild(rowMain);

	// --- スワイプ削除ボタン(露出中のみ)。左スワイプ/長押しで露出、タップで楽観削除 ------------
	if (swiped) {
		const del = document.createElement("button");
		del.type = "button";
		del.className = "swipe-del";
		del.textContent = "削除";
		del.setAttribute("aria-label", `「${task.title}」を削除`);
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			swipeId = null;
			void deleteTask(task);
		});
		li.appendChild(del);
	}
	// スワイプ/長押しジェスチャの配線(仮行・ドラフト行は削除できないので付けない)。
	if (!isOptimisticId(task.id) && !isDraft) attachSwipe(li, task);
	return li;
}

/** setSelected: 行を選択(前の選択があれば確定 auto-save してから切替)。選択後に新タイトル input へ
 *  フォーカスしキャレットを末尾に置く(iOS の「タップで編集に入りカーソルが末尾」を再現)。 */
function setSelected(id: string): void {
	if (selectedId === id) return; // 同じ行の再タップは何もしない(input のフォーカスを奪わない)
	commitSelection(); // 別行選択=前選択の確定(モック要件2)
	// 別行を選んだ = 直前がドラフト行なら、それは commitSelection で確定/破棄済みなので落とす。
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

/** commitSelection: 選択解除=確定(auto-save)の本体。renderAll 前に selTitleInput/selMemoInput の
 *  DOM 値を読み、変更があれば楽観送信する。呼び出し側が selectedId=null / draft=null と renderAll を担う。
 *  【戻り値】ドラフト行の確定で create-todo を発火した(=新規行が生まれた)ときだけ true。Enter で
 *  「確定→次の空ドラフト行」を続けるか(created=true)/やめるか(false)の判断に使う。通常行(既存
 *  タスクの編集)や空ドラフトの破棄では false(継続ドラフトを生やす意味がないため)。 */
function commitSelection(): boolean {
	const inputTitle = selTitleInput;
	const inputMemo = selMemoInput;
	selTitleInput = null;
	selMemoInput = null;
	if (selectedId === null) return false;
	// 監査 C: この commitSelection は「selectedId の選択を終える」呼び出し側の唯一の共通経路
	// (setSelected の別行切替・commitDraftEnter・Enter コミット等、全 callsite がここを通ってから
	// selectedId を変更/null にする)。よってここを「選択解除」の単一フックにでき、選択中に保留して
	// いた退場(heldDoneExitIds)をここで再開できる。呼び出し側が新しい selectedId を代入するより
	// 前に呼ぶが、resumeHeldDoneExit は「これから確定する id」に対して行うので、直後の選択切替とは
	// 独立して安全(新 id が同じ id になるケースは setSelected の同一 id 早期 return で弾かれる)。
	resumeHeldDoneExit(selectedId);
	// --- ドラフト行(未送信の新規行)の確定 = create-todo(タイトル非空のときだけ)------------------
	if (draft !== null && selectedId === draft.id) {
		const title = (inputTitle !== null ? inputTitle.value : draft.title).trim();
		const notes = inputMemo !== null ? inputMemo.value : draft.notes;
		// タイトル空 → 何も作らずドラフトは静かに消える(エラーなし。呼び出し側が draft=null にする)。
		if (title === "") return false;
		// 既存の楽観追加経路(optimisticRows + create-todo)にそのまま乗せる(タイトル + メモのみ)。
		enqueueQuickAdd(title, { due: null, priority: 0, notes: notes.trim() });
		return true;
	}
	const task = tasks?.find((t) => t.id === selectedId);
	if (task === undefined) return false;
	const changes: UpdateTodoChanges = {};
	if (inputTitle !== null) {
		const nt = inputTitle.value.trim();
		// 空タイトルは送らない(iOS が空を無視する挙動)。変更時のみ。
		if (nt !== "" && nt !== task.title) changes.title = nt;
	}
	if (inputMemo !== null) {
		const nn = inputMemo.value;
		if (nn !== (task.notes ?? "")) changes.notes = nn;
	}
	if (Object.keys(changes).length > 0) void saveEdit(task, changes);
	// 既存タスクの編集は「次の空ドラフト行を継続」の対象外なので false を返す。
	return false;
}

/** FAB(+)で「一覧末尾に空のドラフト行を選択状態で生やす」。タイトル input へフォーカスする
 *  (iOS の新規行と同じ体感)。draft は due/優先度/繰り返し等を持たない最小の {title,notes}(構造化
 *  フィールドは作成モード詳細ページで編集する)。
 *  @param focusDelayMs フォーカス(=キーボード出現)を遅らせる ms。既定 0(即フォーカス)。
 *    【2026-07-18 実機動画の解析: fullscreen 昇格ズームの「中心が右上へ流れる」ブレ対策】
 *    折り畳み中の + は fullscreen へ昇格してから追加するが、即フォーカスするとキーボードの
 *    せり上がりがホストのズーム遷移と同時に走り、遷移の基準矩形が飛行中に動いて spring が
 *    再ターゲット=最大化の中心軸がズレて見える。昇格経路だけフォーカスを遷移完了後
 *    (~450ms: iOS の cover/zoom 遷移は ~0.35-0.4s・余裕をみた値・1定数で可逆)まで遅らせ、
 *    「ズームが終わってからキーボードが上がる」順序に直列化する。inline のままの追加(畳み無し)は
 *    従来どおり即フォーカス(遷移が無いので競合しない)。 */
function startDraft(focusDelayMs = 0): void {
	draft = { id: `draft:${Math.random().toString(36).slice(2)}`, title: "", notes: "" };
	selectedId = draft.id;
	closeSwipe();
	renderAll();
	// renderRow が selTitleInput をセットするので、renderAll 後にフォーカスできる(選択行と同じ流儀)。
	if (focusDelayMs <= 0) {
		if (selTitleInput !== null) selTitleInput.focus();
		return;
	}
	setTimeout(() => {
		// 遅延中にユーザーが別操作(選択解除・別行選択)をしたら奪わない(selectedId が draft のままの
		// ときだけフォーカスする)。draft は startDraft 呼び出しごとに新 id なのでクロージャで捕まえる。
		const draftId = draft?.id ?? null;
		if (draftId !== null && selectedId === draftId && selTitleInput !== null) selTitleInput.focus();
	}, focusDelayMs);
}

/** ドラフト行での Enter = 「確定して追加モードを終える」(= 完了ボタン header-done と同一挙動)。
 *  【2026-07-16 実機FBで単発化: 旧「Enter で次の空ドラフトを連続生成」を撤回】旧実装は Enter 確定後
 *  すぐ startDraft() で次の空行を生やす連続投入だったが、ユーザーの求める体感は「FAB で1件編集 → 確定
 *  したらその1件がその場に表示されて追加モードは終わる(空の入力行が下に残らない)」= 単発追加だった
 *  (実機FB: 追加したのに空ドラフト行が下に残り、追加した item が上に「増えた別行」に見える違和感)。
 *  Enter も完了ボタンも「1件確定 → 追加モード終了」に揃える。連続で足したいときは再度 FAB を押す。
 *  確定した仮行は enqueueQuickAdd 経由で becoming-in(その場でシマー)し、sectionize の末尾ピン
 *  (§7.8 add の inPlace)でドラフトが在った位置=一覧末尾にそのまま出る。 */
function commitDraftEnter(): void {
	commitSelection(); // タイトル非空なら enqueueQuickAdd を発火(空なら何も作らず静かに終える)
	draft = null;
	selectedId = null;
	renderAll();
}

/** closeSwipe: スワイプ露出を畳む(state のみ。renderAll は呼び出し側)。 */
function closeSwipe(): void {
	if (swipeId !== null) swipeId = null;
}

/** 左スワイプ(touch)/ 右クリック・長押し(contextmenu)で削除ボタンを露出するジェスチャ配線。
 *  デスクトップ fallback は contextmenu(モック要件5)。縦方向の動きが優勢ならホストの会話スクロールを
 *  優先し何もしない(UI 内で縦スクロールを奪わない既存ドクトリン)。 */
function attachSwipe(li: HTMLElement, task: TodoItem): void {
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
			// 縦の動きが優勢 → スワイプ判定を降りて縦スクロールに委ねる。
			if (Math.abs(dy) > Math.abs(dx)) {
				tracking = false;
				return;
			}
			// 左へ 40px 超で露出、右へ 40px 超で解除(閾値は誤検出しにくい実測値)。
			if (dx < -40 && swipeId !== task.id) {
				swipeId = task.id;
				tracking = false;
				renderAll();
			} else if (dx > 40 && swipeId === task.id) {
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
		swipeId = swipeId === task.id ? null : task.id;
		renderAll();
	});
}

/** completedAt(§3.8.2.1 で UTC ISO "...Z")→ 閲覧者ローカルの "YYYY/M/D HH:MM"。
 *  完了時刻は「いつ済ませたか」の確認情報なので、due と違い相対化(今日/昨日)はせず絶対時刻で出す
 *  (過去の記録は絶対日時の方が読みやすい)。 */
function formatCompletedAt(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso; // パース不能はロスレスに生値を出す(握りつぶさない)
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// 繰り返しプリセット(iOS 語彙 ⇄ ツール引数)の相互写像は ui/recurrence.ts へ移設(共有カーネル)。
// RecurPreset / RecurArgs / PRESET_LABEL / PRESET_MENU_ORDER / presetToArgs / recurrenceToPreset /
// recurValueText は import 済み。agenda-entry.ts と同一ロジックを1本化した。

// 【v2→v3 で覆した点(経緯・財産)】priorityLabel / PRIORITY_MENU(値メニュー用の表示語・選択肢)と
// ポップアップメニュー(openMenu/closeMenu/openMenuEl/MenuOption)は v3 で全廃した。v2 は繰り返し/
// 終了/優先度を「値行をタップ → position:fixed の menu-pop(浮遊ポップオーバー)を座標指定で開く」で
// 選ばせていたが、本番 claude.ai の実機で menu-pop が出ない/画面外に描かれるバグが出た(iframe の
// 高さ自動リサイズと fixed 座標が噛み合わない)。v3 はポップオーバーをゼロにし、繰り返しは行下の
// インライン展開 chips(buildRecurExpand)、優先度は行内 chips(常時表示)で選ばせる — どちらも通常
// フローに流れるので座標計算も浮遊レイヤーも要らない。

// =============================================================================
// 詳細ページ / リスト選択ページ(v3 カード内ページ遷移。モック scratchpad/todos-refined-v3.html)
// =============================================================================
// ⓘ タップ(または FAB ドラフトの ⓘ = 作成モード)で開く。v2 の #sheet-root への position:fixed +
// max-height:88vh のボトムシート(scrim + grabber + 内部スクロール)は全廃し、sheetState に応じて
// renderAll が #root(通常フロー)へ詳細/リスト選択ページを直接描く(廃止理由の詳細は sheetState と
// draft の宣言コメント)。編集ありき(iOS リマインダー詳細準拠): 裸 input(日付/時刻)+ 小型 accent
// トグル(期日/場所 ON/OFF)+ インライン展開 chips(繰り返し)+ 行内 chips(優先度)+ リスト選択ページ。
// 「‹ 戻る」=破棄して一覧へ / 「保存」=変更フィールドだけ update-todo(既存 saveEdit の楽観機構に乗せる)。
// 作成モード(create:true)は「保存」= create-todo に全フィールド / 「‹ 戻る」= 一覧のドラフト行選択へ戻る。

/** 詳細ページの編集作業コピー。構造フィールドはここに持ち、テキスト(title/notes/location)は input
 *  イベントでここへ同期する — 構造変化での再描画(トグル/chip 選択)でテキスト入力値が失われないように。 */
interface SheetDraft {
	title: string;
	notes: string;
	hasDate: boolean;
	dateVal: string; // "YYYY-MM-DD"
	hasTime: boolean;
	timeVal: string; // "HH:MM"
	recurPreset: RecurPreset;
	weekdays: string[]; // weekly/biweekly のとき選択曜日(BYDAY コード)
	recurEnd: "none" | "until" | "count";
	until: string | null; // "YYYY-MM-DD"
	count: number | null; // 既存 count(UI から新規設定はしない=表示のみの第3状態)
	priority: number; // 代表値 0/1/5/9
	// 【B(> 2026-07-17): location フィールドは全廃】自由テキスト場所の編集を撤去したため SheetDraft から
	// location を除去した(場所 = 位置通知 = proximityAlarm の read のみ。makeSheetDraft/collectSheetChanges/
	// collectCreateDetails からも location 参照を除去)。
	// recurOpen: 繰り返し行を「タップで行下にインライン展開」しているか(v3。v2 の menu-pop 廃止に伴う新状態)。
	// v2 はポップオーバーで選ばせていたが、v3 は行の下に chips を流すのでその開閉状態が要る。
	recurOpen: boolean;
}

/** task から作業コピーを作る。日付/時刻/繰り返し/優先度を逆写像で初期化する(B: location は全廃)。 */
function makeSheetDraft(task: TodoItem): SheetDraft {
	const { preset, weekdays } = recurrenceToPreset(task.recurrence);
	const rec = task.recurrence;
	const hasTime = task.due !== null && !task.isAllDay && task.due.includes("T");
	return {
		title: task.title,
		notes: task.notes ?? "",
		hasDate: task.due !== null,
		dateVal: task.due !== null ? wallDatePart(task.due) : localDateKey(new Date()),
		hasTime,
		timeVal: hasTime ? wallTimePart(task.due as string) : "09:00",
		recurPreset: preset,
		weekdays,
		recurEnd: rec?.count != null ? "count" : rec?.until != null ? "until" : "none",
		until: rec?.until != null ? rec.until.slice(0, 10) : null,
		count: rec?.count ?? null,
		priority: priorityToSegment(task.priority),
		recurOpen: false,
	};
}

/** 詳細ページを開く(既存タスクの ⓘ から)。draft を初期化し detail ページへ遷移する。 */
function openSheet(task: TodoItem): void {
	// 仮行(create 未確定)はサーバー id が無いので詳細編集できない。開かない(no-op)。
	if (isOptimisticId(task.id)) return;
	sheetDraft = makeSheetDraft(task);
	sheetState = { id: task.id, page: "detail" };
	closeSwipe();
	quickAddFab.hidden = true; // 詳細ページ表示中は FAB を隠す(編集面の上に + が浮かないように)。
	renderAll();
}

/** 詳細ページを「作成モード」で開く(FAB ドラフト行の ⓘ から)。draft の title/notes を初期値にし、
 *  期日/優先度/繰り返し/場所を空で開く(全フィールド編集可)。「保存」は create-todo に全フィールドを渡す。 */
function openCreateSheet(): void {
	if (draft === null) return;
	sheetDraft = makeSheetDraft(draftToItem(draft));
	sheetState = { id: draft.id, page: "detail", create: true };
	// 【2026-07-17 selectedId 未クリアバグ根治】詳細ページ(create/detail)へ入るときは一覧の行選択を
	// 必ず解除する。これを怠ると、sticky ヘッダの「完了」(行選択中に出る)と page-head の「保存」が
	// 同時表示される二重表示バグになる(renderAll の「sheet 表示中は selectedId を見ない」前提の
	// コメントが事実になっていなかった。openDetailSheet 相当の入口が selectedId を残していたのが原因)。
	selectedId = null;
	closeSwipe();
	quickAddFab.hidden = true;
	renderAll();
}

/** 詳細/リスト選択ページを閉じて一覧ページへ戻る(「‹ 戻る」= 破棄 / 保存後 / 移動後)。 */
function closeSheet(): void {
	sheetState = null;
	sheetDraft = null;
	quickAddFab.hidden = false;
	renderAll();
}

/** 現在ページが対象にしている表示行(楽観上書きが乗った display 行)。作成モードでは draft の擬似行。無ければ null。 */
function currentSheetTask(): TodoItem | null {
	if (sheetState === null) return null;
	const id = sheetState.id;
	// 作成モード: draft は tasks に無いので擬似行を合成して返す(makeSheetDraft の初期化や再描画に使う)。
	if (draft !== null && id === draft.id) return draftToItem(draft);
	if (tasks === null) return null;
	return tasks.find((t) => t.id === id) ?? null;
}

/** v3 小型トグル(button.sw)。OS 緑ではなく accent(v1 言語の唯一の彩度)で ON を示す。 */
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

// recurValueText は ui/recurrence.ts へ移設(共有カーネル)。呼び出しは recurValueText(d.recurPreset, d.weekdays)。

/** 繰り返し行のインライン展開部(モック C)。プリセット chips + 曜日丸チップ(毎週/隔週)+ 終了 chips。
 *  浮遊させず行の下に流す(f-expand)。プリセット選択・曜日トグル・終了切替はいずれも draft を書き換えて
 *  renderAll で再描画する(v2 の menu-pop → インライン化)。 */
function buildRecurExpand(d: SheetDraft): HTMLElement {
	const expand = el("div", "f-expand");

	// --- プリセット chips(しない/毎日/平日/週末/毎週/隔週/毎月/3か月ごと/6か月ごと/毎年 + カスタム)----
	// mock は2行に割っているがレイアウト都合なので、1コンテナの flex-wrap で自然折り返しに代替する。
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
	// カスタム(disabled・破線)。既存値が語彙外(序数 BYDAY・複雑形・語彙外 FREQ)のときだけ選択状態で
	// 見せる第3状態(送信はしない=collectSheetChanges が custom を触らない)。常時 disabled で置く。
	const custom = document.createElement("button");
	custom.type = "button";
	custom.textContent = "カスタム";
	custom.disabled = true;
	custom.setAttribute("aria-pressed", String(d.recurPreset === "custom"));
	presets.appendChild(custom);
	expand.appendChild(presets);

	// --- 曜日丸チップ(毎週/隔週のときだけ)。複数選択=形で単一選択の pill と区別(.chips.wd)-----------
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

	// --- 終了 chips(繰り返しが「しない」「カスタム」以外のときだけ)。しない/日付。既存 count は読み取り専用 ----
	if (d.recurPreset !== "none" && d.recurPreset !== "custom") {
		const end = el("div", "chips");
		const lbl = el("span", "chips-label");
		lbl.textContent = "終了";
		end.appendChild(lbl);
		// 既存 count がある行だけ「N回」を読み取り専用(disabled)チップで見せる(UI から count 新規設定はしない)。
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
			if (d.until === null) d.until = d.dateVal; // 既定=期日と同じ日
			renderAll();
		});
		end.appendChild(none);
		end.appendChild(until);
		expand.appendChild(end);

		// 終了=日付 のとき、裸 date input を1行足す(値表示と入力の一本化)。
		if (d.recurEnd === "until") {
			const urow = el("div", "chips");
			const ulbl = el("span", "chips-label");
			ulbl.textContent = "終了日";
			const ui = document.createElement("input");
			ui.className = "naked";
			ui.type = "date";
			ui.value = d.until ?? d.dateVal;
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

/** 詳細ページ本体(モック B/C)。d は sheetDraft(この関数がそれを直接読み書きする)。#root に直接描く。 */
function buildDetailPage(task: TodoItem, d: SheetDraft): HTMLElement {
	const isCreate = sheetState?.create === true;
	const page = el("div", "detail-page");

	// --- ヘッダ:「戻る(破棄)/ 保存(accent テキストリンク)」----------------------------------
	const head = el("div", "page-head");
	const back = document.createElement("button");
	back.type = "button";
	back.className = "link link-back";
	// 2026-07-15: 絵文字 "‹" から lucide "chevron-left" のインライン SVG へ置換。ボタン自体に
	// aria-label があるためアイコンは装飾(aria-hidden)のまま、視覚テキストだけ残す。
	back.appendChild(createIcon("chevron-left"));
	// 【2026-07-17 iOS 準拠へ統一: 編集モードの「戻る」を非破棄(保存して戻る)にする】
	// 旧実装は編集モードの「‹ 戻る」= 破棄(closeSheet のみ)だったが、一覧のインライン編集は
	// 「行外タップ=自動確定(auto-save)」であり(グローバルクリックの commitSelection 参照)、
	// カード内で「戻ると保存が別モデル」なのは操作モデルの二重化で iOS の直感にも反する。
	// そこで編集モードの戻るも collectSheetChanges + saveEdit を通してから閉じる形に揃え、
	// 「カード内どこから抜けても保存される」一枚岩の保存モデルにする(失敗時は saveEdit 内の
	// 既存ロールバック + バナーが安全網)。ラベルも「保存して戻る」へ更新して非破棄を明示する。
	// 作成モードの「戻る」は現行維持(元々非破壊 = ドラフト行へ title/notes を持ち帰るだけ)。
	back.appendChild(document.createTextNode(isCreate ? "戻る" : "保存して戻る")); // 間隔は .link の gap で作る(CSS 側参照)
	back.setAttribute("aria-label", isCreate ? "一覧のドラフト行へ戻る" : "保存して一覧へ戻る");
	back.addEventListener("click", () => {
		if (isCreate) {
			// 作成モードの「戻る」= ドラフトごと破棄ではなく、一覧のドラフト行選択状態へ戻る(spec)。
			// 詳細で編集した title/notes は draft へ持ち帰る(構造化フィールドはドラフト行が表現できないので落ちる)。
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
		// 編集モード: 保存経路(下の「完了」ボタンと同一の collectSheetChanges + saveEdit)を通してから閉じる。
		const changes = collectSheetChanges(task, d);
		closeSheet();
		if (Object.keys(changes).length > 0) void saveEdit(task, changes);
	});
	const save = document.createElement("button");
	save.type = "button";
	save.className = "link link-save";
	// 【2026-07-17 「保存」/「完了」二重意味の解消】編集モードのこのボタンは iOS の詳細シート
	// (右上「完了」)に合わせて「完了」にリネームする。ハンドラは現行の保存経路のまま
	// (collectSheetChanges + saveEdit)。狙いは、行選択中に出る sticky ヘッダの「完了」と
	// page-head の「保存」が別語彙で並ぶ紛らわしさを断ち、「完了 = このカードでの編集を確定」に
	// 語彙を一本化すること(selectedId 未クリアバグ根治と併せて二重表示自体も消える)。
	// 作成モードは「完了」だと "タスク完了" と紛れるため「保存」を維持する(create の確定は
	// タスクの新規作成であって完了操作ではない — 語の衝突を避ける判断。親レビューの論点)。
	save.textContent = isCreate ? "保存" : "完了";
	save.setAttribute("aria-label", isCreate ? "この内容で作成" : "編集を保存して一覧へ戻る");
	save.addEventListener("click", () => {
		if (isCreate) {
			// 作成モードの「保存」= create-todo に全フィールドを渡す(既存 optimisticRows 経路 + 詳細フィールド)。
			const title = d.title.trim();
			const details = collectCreateDetails(d);
			sheetState = null;
			sheetDraft = null;
			selectedId = null;
			draft = null; // ドラフトは消費(作成 or 空破棄)
			quickAddFab.hidden = false;
			// 空タイトルは作成できない(create-todo は title 必須)ので静かに破棄して一覧へ戻る。
			if (title !== "") enqueueQuickAdd(title, details);
			else renderAll();
			return;
		}
		const changes = collectSheetChanges(task, d);
		closeSheet();
		if (Object.keys(changes).length > 0) void saveEdit(task, changes);
	});
	head.appendChild(back);
	head.appendChild(save);
	page.appendChild(head);

	const body = el("div", "detail-body");

	// --- タイトル input(16px 太め・枠なし)-------------------------------------------------------
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

	// --- メモ textarea(枠なし)-------------------------------------------------------------------
	const notesInput = document.createElement("textarea");
	notesInput.className = "d-notes";
	notesInput.value = d.notes;
	notesInput.placeholder = "メモを追加";
	notesInput.setAttribute("aria-label", "メモ");
	notesInput.addEventListener("input", () => {
		d.notes = notesInput.value;
	});
	body.appendChild(notesInput);

	// --- 期日行(裸 date input + トグル。OFF=期日除去。OFF 時は値位置に「なし」placeholder)------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "期日";
		const value = el("span", "f-value");
		if (d.hasDate) {
			const di = document.createElement("input");
			di.className = "naked";
			di.type = "date";
			di.value = d.dateVal;
			di.setAttribute("aria-label", "期日");
			di.addEventListener("change", () => {
				d.dateVal = di.value;
			});
			value.appendChild(di);
		} else {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.hasDate, "期日", () => {
				d.hasDate = !d.hasDate;
				if (!d.hasDate) d.hasTime = false; // 期日を外したら時刻も外す(時刻は期日に従属)
				renderAll();
			}),
		);
		body.appendChild(row);
	}

	// --- 時刻行(期日 ON のときだけ出す。モックに無い細部を iOS 的に補完)---------------------------
	if (d.hasDate) {
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "時刻";
		const value = el("span", "f-value");
		if (d.hasTime) {
			const ti = document.createElement("input");
			ti.className = "naked";
			ti.type = "time";
			ti.value = d.timeVal;
			ti.setAttribute("aria-label", "時刻");
			ti.addEventListener("change", () => {
				d.timeVal = ti.value === "" ? "09:00" : ti.value;
			});
			value.appendChild(ti);
		} else {
			const ph = el("span", "placeholder");
			ph.textContent = "なし";
			value.appendChild(ph);
		}
		row.appendChild(label);
		row.appendChild(value);
		row.appendChild(
			makeSwitch(d.hasTime, "時刻", () => {
				d.hasTime = !d.hasTime;
				renderAll();
			}),
		);
		body.appendChild(row);
	}

	// --- 時間帯行(読み取り専用)。一覧の解釈ゾーン(currentTimeZone = 応答 vm.timeZone)が閲覧者ゾーンと
	// 異なるときだけ出す(v2 から継承)。
	// 【2026-07-17 コメント訂正】旧コメントは「task 自身のゾーン」と書いていたが誤り。currentTimeZone は
	// 個々の task 固有のゾーンではなく「この一覧を解釈・表示しているゾーン」(list/refresh に渡した timeZone を
	// server が vm.timeZone に echo したもの)。TZ グラウンディング修正で refresh/mutate に常時閲覧者ゾーンを
	// 送るようになったため、通常 currentTimeZone==viewerZone となりこの行は自然に消える(出し分けロジックは
	// 現状維持 — 何らかの理由で解釈ゾーンが閲覧者と食い違ったときだけ注意喚起として残す)。-----
	if (d.hasDate && currentTimeZone !== null) {
		const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (currentTimeZone !== viewerZone) {
			const row = el("div", "f-row readonly");
			const label = el("span", "f-label");
			label.textContent = "時間帯";
			const value = el("span", "f-value");
			value.textContent = currentTimeZone;
			row.appendChild(label);
			row.appendChild(value);
			body.appendChild(row);
		}
	}

	// --- 繰り返し行(値 + chevron。タップで行下にインライン展開)------------------------------------------
	{
		const row = el("div", "f-row");
		// 展開時は下ヘアラインを省いて展開部と連続させる(モック C の border-bottom:none)。
		if (d.recurOpen) row.style.borderBottom = "none";
		const label = el("span", "f-label");
		label.textContent = "繰り返し";
		const value = el("span", "f-value");
		const val = el("span", d.recurPreset === "custom" ? "muted" : "val"); // 語彙外はグレー
		val.textContent = recurValueText(d.recurPreset, d.weekdays);
		const chev = el("span", "chev");
		// 2026-07-15: 絵文字 "⌄"/"⌃" から lucide "chevron-down"/"chevron-up" のインライン SVG へ置換。
		chev.appendChild(createIcon(d.recurOpen ? "chevron-up" : "chevron-down"));
		value.appendChild(val);
		value.appendChild(chev);
		row.appendChild(label);
		row.appendChild(value);
		row.style.cursor = "pointer";
		row.addEventListener("click", () => {
			d.recurOpen = !d.recurOpen;
			renderAll();
		});
		body.appendChild(row);
	}
	if (d.recurOpen) body.appendChild(buildRecurExpand(d));

	// --- リスト行(値 + chevron → リスト選択ページ)。作成モードは移動概念が無いので読み取り専用にする ---------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "リスト";
		const value = el("span", "f-value");
		const val = el("span", "val");
		val.textContent = currentCalendarId ?? "";
		value.appendChild(val);
		row.appendChild(label);
		row.appendChild(value);
		if (!isCreate) {
			const goto = el("span", "goto");
			// 2026-07-15: 絵文字 "›" から lucide "chevron-right" のインライン SVG へ置換。
			goto.appendChild(createIcon("chevron-right"));
			row.appendChild(goto);
			row.style.cursor = "pointer";
			row.addEventListener("click", () => {
				if (sheetState !== null) sheetState = { id: sheetState.id, page: "list", create: sheetState.create };
				renderAll();
				void ensureCalendars().then(() => {
					// 取得完了後に list ページを描き直す(まだ list ページを見ているときだけ)。
					if (sheetState?.page === "list") renderAll();
				});
			});
		} else {
			// 作成モード: create-todo は currentCalendarId に作る(移動という操作は無い)ので値だけ見せる。
			val.className = "muted";
		}
		body.appendChild(row);
	}

	// --- 優先順位行(行内 chips 常時表示。なし/!/!!/!!!)-------------------------------------------
	{
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		label.textContent = "優先順位";
		const value = el("span", "f-value");
		const chips = el("span", "chips");
		for (const opt of PRIORITY_SEGMENTS) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = opt.label;
			b.setAttribute("aria-pressed", String(d.priority === opt.value));
			b.setAttribute("aria-label", opt.aria);
			b.addEventListener("click", () => {
				d.priority = opt.value;
				renderAll();
			});
			chips.appendChild(b);
		}
		value.appendChild(chips);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}

	// --- 【B(> 2026-07-17 実機 FB 第2ラウンド): 読み取り専用「場所」(LOCATION)行も全廃】-----------------
	// 直前コミット 32c3d2f は「編集入力は廃止するが、既存 LOCATION データは読み取り専用行で見せる」に
	// 留めていた。しかし最終裁定「location は通知(geofence)のためにあり、既存のテキスト場所は不要 —
	// 実装すらいらない」により、その読み取り専用行も削除した(位置通知行=proximityAlarm だけを残す)。
	// Task.location(read DTO)は互換のため温存するが、カード UI では一切表示・編集しない。
	// 【経緯(積層・財産)】v3 で編集可能「場所」カラム(モック要件1)→ 32c3d2f で読み取り専用行へ縮退 →
	// 本ラウンドで完全撤去、という3段階。将来 LOCATION 自由テキストの需要が再燃したら位置通知とは明確に
	// 別ラベルの UI で復活させること(設計 05 §1-a: iOS の場所リマインダーは geofence VALARM であって
	// LOCATION 自由テキストではない、が撤去の根拠)。

	// --- 位置通知行(読み取り専用。C2 実機 FB 修正・設計 05 §1-a/§2)-----------------------------------
	// 【なぜ独立行が要るか(実機 FB の根治)】上の「場所」行は VTODO 直下の LOCATION(テキスト・編集可)を
	// 読む・書く。しかし位置情報リマインダー(geofence)の場所は VALARM 内の structured-location
	// (= DTO の proximityAlarm.location)にあり、LOCATION テキストとは別スロット(設計 05 §1-a の実例)。
	// そのため一覧行には 📍「〜に到着時」バッジが出るのに、詳細の「場所」入力は空、という不整合が実機で
	// 出ていた。これを埋めるために proximity を独立の読み取り専用行として出す。
	// 【なぜ「場所」テキスト入力に流し込まないか(意味の破壊回避・指示)】proximityAlarm.location を編集可能な
	// 場所テキストに入れると、保存時に LOCATION へ書き出され「通知条件の場所」と「場所テキスト」が混線する
	// (2つの別スロットが1つに潰れる)。よって値は d(編集ドラフト)ではなく task.proximityAlarm から直接読み、
	// input ではなく静的テキストで見せる(collectSheetChanges も触らない=保存対象外)。
	// 【文言は一覧バッジと同一(proximityBadge 純関数を再利用)】「福登の自宅に到着時 / から出発時」。title が
	// 無ければ「位置情報の通知」へ degrade(location-view.ts。mcp-location-view.test.ts で境界固定)。
	// 【編集は未対応(経緯コメント)】proximity の変更・削除・新規作成は write の領分(C3〜C5・author 規約 C8)。
	// read カード(C2)では表示のみ。編集 UI(到着/出発トグル・場所ピッカー)は C4 の場所/会議セミモーダルで
	// vtodo にも展開する計画(設計 05 §5 末尾「到着/出発のトグルを添えて同じピッカーを共用」)。
	// 【B(> 2026-07-17): 自由テキスト「場所」行を全廃したので、この位置通知行が場所系の唯一の行になった】
	// 以前は上に LOCATION テキスト行が並んでいたが撤去済み(上の B コメント参照)。この行は proximityAlarm が
	// ある行にだけ増える(read カード=表示のみ。編集は C4 の場所/会議セミモーダルで vtodo にも展開予定)。
	if (task.proximityAlarm !== null) {
		const badge = proximityBadge(task.proximityAlarm);
		const row = el("div", "f-row");
		const label = el("span", "f-label");
		// ラベルは「位置通知」ではなく「場所」(ユーザー裁定 2026-07-17)。自由テキスト場所を全廃した今、
		// 「場所」の名は geofence の場所が引き継ぐ — iOS リマインダーの詳細も「場所」ラベルで到着/出発を
		// 表示するのと同じ意味論。値の文言(proximityBadge)はそのまま。
		label.textContent = "場所";
		const value = el("span", "f-value");
		// 読み取り専用なので f-readonly(muted・map-pin + 文言)。一覧 .prox チップと視覚言語を揃える。
		const ro = el("span", "f-readonly");
		ro.appendChild(createIcon("map-pin"));
		ro.appendChild(document.createTextNode(` ${badge.text}`));
		ro.setAttribute("aria-label", badge.aria);
		value.appendChild(ro);
		row.appendChild(label);
		row.appendChild(value);
		body.appendChild(row);
	}

	page.appendChild(body);
	return page;
}

/** リスト選択ページ(モック D)。詳細ページと同じくページ差し替え(#root に直接描く)。
 *  「詳細へ戻る」/ コレクション行 + 現在地チェック。選択で move-todo(現在地の選択は詳細へ戻るだけ)。 */
function buildListPickerPage(task: TodoItem): HTMLElement {
	const page = el("div", "list-page");
	const head = el("div", "page-head");
	const back = document.createElement("button");
	back.type = "button";
	back.className = "link link-back";
	// 2026-07-15: 絵文字 "‹" から lucide "chevron-left" のインライン SVG へ置換。
	back.appendChild(createIcon("chevron-left"));
	back.appendChild(document.createTextNode("詳細へ戻る")); // 間隔は .link の gap で作る(CSS 側参照)
	back.addEventListener("click", () => {
		if (sheetState !== null) sheetState = { id: sheetState.id, page: "detail", create: sheetState.create };
		renderAll();
	});
	const title = document.createElement("span");
	title.style.fontSize = "13px";
	title.style.fontWeight = "600";
	title.textContent = "リスト";
	const spacer = document.createElement("span");
	spacer.style.width = "3em"; // 戻るリンクと視覚的にタイトルを中央寄せするためのバランサ(モック D)。
	head.appendChild(back);
	head.appendChild(title);
	head.appendChild(spacer);
	page.appendChild(head);

	const listWrap = document.createElement("div");
	if (calendarsCache === null) {
		// 取得中(呼び出し側 ensureCalendars が完了後に renderAll で描き直す)。
		const loading = el("div", "pick-row");
		loading.textContent = "読み込み中…";
		listWrap.appendChild(loading);
	} else {
		// VTODO を受理できるリスト(リマインダーリスト)だけ列挙する。
		const lists = calendarsCache.filter((c) => c.components.includes("VTODO"));
		if (lists.length === 0) {
			const empty = el("div", "pick-row");
			empty.textContent = "リストがありません";
			listWrap.appendChild(empty);
		}
		for (const c of lists) {
			const row = el("div", "pick-row");
			row.appendChild(document.createTextNode(c.displayName !== "" ? c.displayName : c.id));
			const isHere = c.id === currentCalendarId;
			if (isHere) {
				const check = el("span", "check");
				// 2026-07-15: 絵文字 "✓" から lucide "check" のインライン SVG へ置換。
				check.appendChild(createIcon("check"));
				row.appendChild(check);
			}
			row.addEventListener("click", () => {
				if (isHere) {
					// 現在地の選択 = 詳細へ戻るだけ(移動しない)。
					if (sheetState !== null) sheetState = { id: sheetState.id, page: "detail", create: sheetState.create };
					renderAll();
					return;
				}
				void moveTodo(task, c.id);
			});
			listWrap.appendChild(row);
		}
	}
	page.appendChild(listWrap);
	return page;
}

/** シートの「保存」が update-todo へ渡す「変更フィールドだけ」を draft と task の差分から集める。 */
function collectSheetChanges(task: TodoItem, d: SheetDraft): UpdateTodoChanges {
	const changes: UpdateTodoChanges = {};
	// タイトル(空は送らない・変更時のみ)。
	const t = d.title.trim();
	if (t !== "" && t !== task.title) changes.title = t;
	// メモ(変更時のみ・"" でクリア)。
	if (d.notes !== (task.notes ?? "")) changes.notes = d.notes;
	// 期日(終日 "YYYY-MM-DD" / 時刻付き "YYYY-MM-DDTHH:MM:SS" / null=除去)。
	const nextDue = d.hasDate ? (d.hasTime ? `${d.dateVal}T${d.timeVal}:00` : d.dateVal) : null;
	const curWall = task.due === null ? null : task.due.includes("T") ? task.due.slice(0, 19) : task.due;
	if (nextDue === null) {
		if (curWall !== null) changes.due = null;
	} else if (nextDue !== curWall) {
		changes.due = nextDue;
	}
	// 優先度(代表値バケットが変わったときだけ)。
	if (d.priority !== priorityToSegment(task.priority)) changes.priority = d.priority;
	// 【B(> 2026-07-17 実機 FB 第2ラウンド): 場所(LOCATION)の編集収集は完全撤去】旧実装は d.location と
	// task.location を比較して changes.location を送っていたが、詳細ページから編集入力を撤去(32c3d2f)し、
	// 本ラウンドで SheetDraft.location・引数・server 側 shape まで全廃した(場所 = 位置通知 = proximityAlarm の
	// read のみ、が最終裁定)。よって collectSheetChanges は location を一切収集しない。
	// 繰り返し(custom は触らない)。プリセット/曜日/終了のいずれかが変わったときだけ全置換で送る。
	if (d.recurPreset !== "custom") {
		const orig = recurrenceToPreset(task.recurrence);
		const origEnd = task.recurrence?.count != null ? "count" : task.recurrence?.until != null ? "until" : "none";
		const origUntil = task.recurrence?.until != null ? task.recurrence.until.slice(0, 10) : null;
		const changed =
			d.recurPreset !== orig.preset ||
			JSON.stringify([...d.weekdays].sort()) !== JSON.stringify([...orig.weekdays].sort()) ||
			d.recurEnd !== origEnd ||
			(d.recurEnd === "until" && d.until !== origUntil);
		if (changed) {
			const args = presetToArgs(d.recurPreset, d.weekdays);
			// recurrence は due 必須(none 除去を除く)。due が無ければ送れないので skip(安全側 degrade)。
			if (args !== null && (args.frequency === "none" || d.hasDate)) {
				if (d.recurEnd === "until" && d.until != null && args.frequency !== "none") args.until = d.until;
				changes.recurrence = args;
			}
		}
	}
	return changes;
}

/** list-calendars を遅延取得してキャッシュする(リスト移動ページで使う)。失敗はバナー表示に degrade。 */
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
			components: c.components ?? ["VTODO"],
		}));
	} catch (e) {
		showBanner(`リストの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** move-todo(タスクを別リストへ移動)。応答=移動元ビューの TodosViewModel + removed ghost。
 *  ツールが未実装の環境では isError でバナーに degrade する(UI は壊れない。モック要件6)。 */
async function moveTodo(task: TodoItem, toCalendarId: string): Promise<void> {
	closeSheet();
	if (selectedId === task.id) selectedId = null;
	clearBanner();
	try {
		const args: Record<string, unknown> = { id: task.id, toCalendarId };
		if (currentCalendarId !== null) args.calendarId = currentCalendarId;
		// 【2026-07-17 TZ グラウンディング】move 応答は移動元ビューの確定一覧を組み直すので、
		// 時刻付き DUE が UTC 落ちしないよう閲覧デバイスのゾーンを常時送る(refreshArgs と対称)。
		args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const result = await app.callServerTool({ name: "move-todo", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
		}
		// 応答は移動元ビューの vm(移動したタスクが抜けた一覧)+ removed ghost。そのまま確定描画する
		// (ghost が becoming-gone を1描画だけ描く=「このリストから移動して消えた」を静的に見せる)。
		applyStructuredContent(result.structuredContent);
	} catch (e) {
		rebuildFromConfirmed();
		renderAll();
		showBanner(
			`「${task.title}」の移動に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
			() => void moveTodo(task, toCalendarId),
		);
	}
}

/** 小ヘルパー: クラス付き要素。詳細/リスト選択ページの DOM 構築の記述量を削る。 */
function el(tag: string, className: string): HTMLElement {
	const e = document.createElement(tag);
	e.className = className;
	return e;
}
// 【v2→v3 で覆した点(経緯・財産)】gIcon(g-row の絵文字アイコン span)と makeToggle(iOS システム
// グリーンの span.toggle)は v3 で全廃した。v2 は iOS 設定画面のパスティーシュ(絵文字アイコン・緑
// トグル・inset 白箱)だったが、会話ログ内の従属カードのトーン(v1 = todos-refined の静かなヘアライン
// 言語)と衝突するとのユーザー評価。v3 はアイコンを廃し、トグルは accent(唯一の彩度)の小型 button.sw
// (makeSwitch)に統一した。

// 【C0-c: renderGhostRow(削除ゴースト行)は廃止(2026-07-17 ユーザー裁定)】
// 旧実装はここに renderGhostRow(task, todayKey) があり、removed:[{id,title,due?}] 由来の擬似
// TodoItem を「もう存在しない行」= 破線ボックス + 減光 + 破線丸 + 「削除」/「同期(削除)」タグの
// becoming-gone 行として描いていた(自分削除では optimisticDeletes の即除去により実際にはほぼ出ず、
// サーバー確定 removed / sync 由来の外部削除でだけ1描画現れる位置づけだった)。
// ユーザー裁定「基本削除しない(完了にする)し、削除したものは見せなくていい(点々は不要)」に従い、
// 削除された行は視覚に一切出さないことにしたため、この関数を廃止した(呼び出し元 renderRow の
// 早期 return と renderAll の ghostItems 合流も同時に撤去した)。
//   - 自分削除(delete-todo / 楽観削除): optimisticDeletes で即除去 → 破線プレースホルダを残さず即消滅。
//   - sync 由来の外部削除: nextTasks から抜けて即消滅 + announceBecoming の aria-live 音声通知
//     (「同期で N 件更新されました」)で「黙って消えて混乱」を防ぐ(視覚常設ゴーストは出さない)。
// becoming-gone の CSS(todos-app.ts)は退行時の再利用に備え残置(死んでも害は無い・経緯の記録)。
// 財産(ボツ): 破線ゴーストの持続表示 — 「削除したものは見せない」の裁定で不要になった。

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
		// location/recurrence は snapshot(差分メタ)には無い一過性フレーム用の情報なので null。
		// 次応答で通常経路(taskFromVTodo 由来の実 tasks 行)に戻れば本来の値が乗る。
		location: null,
		recurrence: null,
		// C1 派生: snapshot(becoming 用の最小情報)は場所/proximity を持たない。次応答で実行に戻る。
		structuredLocation: null,
		proximityAlarm: null,
	};
}

/** 仮タスク(quick-add 楽観行)→ 描画用 TodoItem。E-2 スライス⑥前半で段階的開示により due/優先度/
 *  メモを付けられるようになったので、仮行にもそれを反映する(セクション配置は due に従う)。
 *  高速パス(タイトルのみ)では due=null / priority=0 / notes=null(従来と同じ)。
 *  id は "optimistic:" prefix のまま(差分除外印)。 */
function optimisticRowToItem(row: OptimisticRow): TodoItem {
	// A-2(> 2026-07-17 実機 FB 第2ラウンド): 仮行(緑)に対する完了タップの意図がキューされていれば、
	// 確定を待たずにその場でチェックを描く(タップした瞬間に反応する)。意図が無ければ従来どおり未完了。
	const queued = pendingToggleIntents.get(row.id);
	const completed = queued ?? false;
	return {
		id: row.id,
		title: row.title,
		completed,
		status: completed ? "COMPLETED" : "NEEDS-ACTION",
		due: row.due,
		isAllDay: row.isAllDay,
		priority: row.priority,
		percentComplete: null,
		completedAt: null,
		notes: row.notes,
		sortOrder: null,
		// 場所/繰り返しは quick-add の領分外(チャット/詳細編集に委ねる)なので仮行は持たない。
		location: null,
		recurrence: null,
		// C1 派生: 楽観 create 行は proximity/構造化場所を持たない(確定 vm で埋まる)。
		structuredLocation: null,
		proximityAlarm: null,
	};
}

/** ドラフト行(FAB で生やす未送信の新規行)→ 描画用 TodoItem。一覧末尾(期日なし)に選択状態で描くための
 *  擬似行で、id は "draft:" prefix のまま(isDraftId 判定 = トグル/削除/差分から除外)。作成モード詳細ページの
 *  初期値(makeSheetDraft)にも使う。due/優先度/繰り返し/場所は持たない(それらは作成モード詳細で編集する)。 */
function draftToItem(d: { id: string; title: string; notes: string }): TodoItem {
	return {
		id: d.id,
		title: d.title,
		completed: false,
		status: "NEEDS-ACTION",
		due: null,
		isAllDay: false,
		priority: 0,
		percentComplete: null,
		completedAt: null,
		notes: d.notes === "" ? null : d.notes,
		sortOrder: null,
		location: null,
		recurrence: null,
		// C1 派生: 未送信ドラフトは場所/proximity を持たない(作成フローは C3〜)。
		structuredLocation: null,
		proximityAlarm: null,
	};
}

/**
 * 表示用 state(tasks / affectedById / ghosts)を「確定土台 + in-flight 楽観」から組み立てる。
 * 2026-07-14 ドクトリン改訂の中核 —「楽観は confirmedTasks へ重ね直す」を1箇所に集約する。
 *   base 引数 = サーバー(+sync)由来の becoming 土台(applyStructuredContent が確定した値、
 *   または楽観だけの再描画では直近の serverAffectedBase/serverGhostsBase)。
 * 重ねる順:
 *   1. confirmedTasks を土台にコピーし、optimisticToggle の該当行だけ completed/status を上書き
 *      + becoming(completed/reopened)を付ける(在庫にある行だけ = 既に確定 vm から抜けた行は無視)。
 *   2. optimisticRows(仮行)を末尾に足し、becoming-in(追加)を付ける。
 * ghosts はサーバー由来の削除ゴーストのみ(楽観削除はこのスライスでは扱わない)。
 */
function rebuildDisplay(baseAffected: AffectedEntry[], baseGhosts: TaskSnapshot[]): void {
	const affected = new Map<string, AffectedEntry>(baseAffected.map((a) => [a.id, a]));
	// 確定土台(null なら空)。楽観トグルの重ねはシャローコピーした行にだけ行い、
	// confirmedTasks(差分の土台)は決して破壊しない。
	// 楽観削除(optimisticDeletes)中の行はここで即除去する = 削除ボタンを押した瞬間に行が消える
	// (楽観適用)。確定土台 confirmedTasks 自体は消さない(失敗時のロールバックで復活させるため)。
	// C0-a: 退場済み(retiredDoneIds)の完了行は再合成しない — includeCompleted ビューでは確定 vm に
	// 完了行が残るので、退場後もこの filter が無いと幽霊復活する(冪等性の要)。
	const displayTasks: TodoItem[] = (confirmedTasks ?? [])
		.filter((t) => !optimisticDeletes.has(t.id) && !retiredDoneIds.has(t.id))
		.map((t) => {
			const ov = optimisticToggle.get(t.id);
			const ed = optimisticEdits.get(t.id);
			// トグルと編集は独立に重なりうる(まれだが「完了にしつつタイトル編集中」等)。両方あれば
			// 両方を1つのシャローコピーへ重ねる(confirmedTasks は決して破壊しない=差分レンズの土台を守る)。
			if (ov === undefined && ed === undefined) return t;
			const merged: TodoItem = { ...t };
			if (ov !== undefined) {
				merged.completed = ov.completed;
				merged.status = ov.status;
			}
			// 編集の楽観上書き(仕様B-2: 値だけ差し替え。becoming-edit のインライン旧→新は確定 vm の
			// changes に任せるので、ここでは affected を立てない=装飾を付けない)。
			if (ed !== undefined) Object.assign(merged, ed);
			return merged;
		});
	// 【> 2026-07-17 実機 FB 監査修正: 確定 vm から抜けた行への楽観トグルも表示へ復活させる(desired が常に勝つ)】
	// バグ: done → サーバー確定(完了 → 未完了ビューから id が脱落)→ undo(optimisticToggle=未完了)としても、
	// 上の map は confirmedTasks の行しか overlay しないため、脱落済み id の undo が「見えない」= 行が完了表示の
	// まま残る(実機 FB「done 押してすぐ取り消すと完了状態で残る」の主因)。修正: confirmedTasks に居ない
	// optimisticToggle 対象は stickyData の last-known スナップショットを土台に ov を重ねて復活させる(reopen が
	// 即座に見える=サーバー再開の往復を待たない)。復活可否は純関数 shouldReviveToggle に固定(テスト参照)。
	// 復活は in-flight 楽観の間だけ(settle/rollback で optimisticToggle が消えれば止まる)なので幽霊化しない。
	const confirmedIds = new Set((confirmedTasks ?? []).map((t) => t.id));
	for (const [id, ov] of optimisticToggle) {
		if (!shouldReviveToggle(confirmedIds.has(id), retiredDoneIds.has(id), optimisticDeletes.has(id), stickyData.has(id)))
			continue;
		const base = stickyData.get(id);
		if (base === undefined) continue; // shouldReviveToggle が hasSticky=true を保証するが型のため再確認
		const revived: TodoItem = { ...base, completed: ov.completed, status: ov.status };
		const ed = optimisticEdits.get(id);
		if (ed !== undefined) Object.assign(revived, ed);
		displayTasks.push(revived);
	}
	for (const [id, ov] of optimisticToggle) {
		// becoming(completed/reopened)は「今このフレームで実際に表示している行」= displayTasks に居る id に
		// だけ立てる。confirmedTasks に居る行に加え、上で sticky から復活させた脱落行も含む(復活行の undo にも
		// 「再開」ラベルが乗る)。以前は confirmedTasks 在庫だけを条件にしていたため、脱落行の楽観が装飾も
		// 表示も得られず「完了のまま残る」バグになっていた(displayTasks 参照へ是正)。
		if (displayTasks.some((t) => t.id === id)) {
			affected.set(id, { id, kind: ov.completed ? "completed" : "reopened" });
		}
	}
	for (const row of optimisticRows) {
		displayTasks.push(optimisticRowToItem(row));
		affected.set(row.id, { id: row.id, kind: "added" });
	}
	// confirmedTasks 未受領 かつ 仮行も無い = まだ一度も描くものが無い → skeleton を維持する
	// (空配列を入れると「タスクはありません」が出て skeleton が消えてしまう)。
	tasks = confirmedTasks === null && displayTasks.length === 0 ? null : displayTasks;
	affectedById = affected;
	ghosts = baseGhosts;
}

/** 確定 vm を通さず、直近のサーバー土台の上に現在の in-flight 楽観だけを重ね直して表示を作る。
 *  楽観アクション(タップ直後 / quick-add 投入直後 / ロールバック)から呼ぶ。 */
function rebuildFromConfirmed(): void {
	rebuildDisplay(serverAffectedBase, serverGhostsBase);
}

/** 成功/失敗どちらでも仮行を1つ取り除く(id 一致・複数連続投入に対応)。 */
function removeOptimisticRow(id: string): void {
	optimisticRows = optimisticRows.filter((r) => r.id !== id);
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

/** 全体描画。#root を作り直す唯一の関数(一方向データフロー)。sheetState に応じて
 *  一覧ページ / 詳細ページ / リスト選択ページのどれかを描く(v3 カード内ページ遷移)。 */
function renderAll(): void {
	// 【S-E: ヘッダ Done の表示/非表示】旧 button.confirm の `if (sel)` 条件と同じ「selectedId が
	// 何かの行を指しているか」だけで決める(ドラフト行の選択中も表示 = 旧仕様どおり作成中も確定できる)。
	// sheetState(詳細/リスト選択ページ)表示中は selectedId が必ず null(openSheet/openCreateSheet の
	// 呼び出し前に commitSelection→selectedId=null を通る)なので、この1行だけで両状態を正しく畳める。
	headerDoneEl.hidden = selectedId === null;
	// --- カード内ページ遷移(v3): sheetState が立っていれば詳細/リスト選択ページを #root に描く --------
	// 通常フローに描くので高さ=コンテンツ(iframe 自動リサイズと整合)。作業コピー(sheetDraft)は input
	// イベントで同期済みなので、構造変化での再描画でもテキスト値は失われない(#sheet-root 廃止の代替)。
	if (sheetState !== null) {
		const sheetTask = currentSheetTask();
		if (sheetTask !== null && sheetDraft !== null) {
			root.innerHTML = "";
			// 選択行入力の参照は詳細ページでは使わないのでクリアしておく(一覧の commit 誤読を防ぐ)。
			selTitleInput = null;
			selMemoInput = null;
			root.appendChild(
				sheetState.page === "list" ? buildListPickerPage(sheetTask) : buildDetailPage(sheetTask, sheetDraft),
			);
			return;
		}
		// 対象行が消えた(削除・外部同期)/ draft 消失 → ページを畳んで一覧描画へ流す。
		sheetState = null;
		sheetDraft = null;
		quickAddFab.hidden = false;
	}

	if (tasks === null && draft === null) {
		renderSkeleton();
		return;
	}
	root.innerHTML = "";
	// 選択行入力への参照を毎描画でリセットする(この描画で選択行が描かれれば renderRow が付け直す)。
	// こうしておくと、選択行がフィルタ等で消えた描画では参照が古いまま残らない(commit の誤読を防ぐ)。
	selTitleInput = null;
	selMemoInput = null;
	// tasks 未受領(null)でも draft(FAB で生やしたドラフト行)があれば一覧を描く。以降は baseTasks を使う。
	const baseTasks = tasks ?? [];
	const todayKey = localDateKey(new Date());
	// 【C0-c: 削除ゴースト(ghostItems)の合流を廃止(2026-07-17 ユーザー裁定)】旧実装はここで
	// ghosts(removed 由来)を擬似 TodoItem に変換し通常セクションへ合流させ、renderRow が破線ボックス
	// (becoming-gone)に描き替えていた。ユーザー裁定「削除したものは見せなくていい(点々は不要)」に
	// 従い、削除行は視覚に一切出さない — よってここでの合流を削除した。ghosts 配列は announceBecoming の
	// aria-live 通知(sync 由来の外部削除を音声で知らせる)と applyStructuredContent の positionMemory/
	// stickyData 掃除にはまだ使うが、DOM 行にはしない(自分削除=optimisticDeletes で即除去済み・
	// sync 削除=nextTasks から抜けて即消滅・どちらも持続プレースホルダを残さない)。
	// affected の completed 合成(案X)。completed は tasks の未完了ビューから抜けるので、
	// tasks に見つからない id だけ snapshot から擬似行を作って合流させる。added/reopened/edited は
	// tasks に実在するので合成不要(既に tasks 側の行が becoming 装飾を受け取る)。
	const taskIds = new Set(baseTasks.map((t) => t.id));
	const affectedItems: TodoItem[] = [];
	for (const a of affectedById.values()) {
		// C0-a: 退場済み id は completed 合成もしない(退場後に mutate 応答の affected が残っていても再出させない)。
		if (a.kind === "completed" && a.task !== undefined && !taskIds.has(a.id) && !retiredDoneIds.has(a.id)) {
			// 【> 2026-07-17 実機 FB「done で notes が消える」修正】snapshot(TaskSnapshot は notes を持たない)から
			// 作った最小行をそのまま synthDone にすると、sectionizeManual の liveById に載って notes まで揃った
			// stickyData より優先され、完了行の notes が描画から消える。sticky を土台に merge して full な形を保つ
			// (mergeCompletedBase・純関数 mcp-toggle-coalesce.test.ts で固定)。
			affectedItems.push(mergeCompletedBase(stickyData.get(a.id), snapshotToItem(a.task, true)));
		}
	}
	// --- 並べ替え段(sortMode の seam。今回は "manual" 固定 = 位置不変 item 3)------------------------
	// manual: sectionizeManual が positionMemory / stickyData で「一度現れた行はその場に留める」を担う。
	//   realLive  = 実在の確定/楽観重ね行(optimistic 仮行は除く。memory + sticky で管理)。
	//   synthDone = done-in-place の合成行(memory は既存・sticky は無ければ補完)。
	//   transient = memory に載せない一過性行 = optimistic 追加の仮行(C0-c で ghost 合流は廃止)。
	// 非 manual(期限順など・今回未実装)は従来の compareTasks 整列(sectionize)へ分岐する seam を残す。
	let s: Sections;
	if (sortMode === "manual") {
		const realLive = baseTasks.filter((t) => !isOptimisticId(t.id));
		const optimisticLive = baseTasks.filter((t) => isOptimisticId(t.id));
		s = sectionizeManual(realLive, affectedItems, optimisticLive, todayKey);
	} else {
		// 非 manual 経路(温存。今回は到達しない)。従来どおり全行を compareTasks で整列する。
		s = sectionize(baseTasks.concat(affectedItems), todayKey);
	}

	const activeCount = s.overdue.length + s.today.length + s.upcoming.length + s.noDue.length;
	// ドラフト行(FAB で生やした未送信の新規行)があるときは「タスクはありません」を出さない
	// (空でも一番下にドラフト行を出すので、空メッセージとドラフト行の同居は誤解を招く)。
	if (activeCount === 0 && draft === null) {
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

	// --- ドラフト行(FAB で生やした未送信の新規行)を一覧末尾(期日なしの下)に選択状態で描く ------------
	// sectionize に混ぜず末尾へ直接置くのは、空タイトルの draft を compareTasks に通すと localeCompare で
	// 期日なしセクションの先頭に来てしまい「末尾に生やす」という iOS の体感とズレるため(位置を固定する)。
	if (draft !== null) {
		const ul = document.createElement("ul");
		ul.appendChild(renderRow(draftToItem(draft), todayKey));
		root.appendChild(ul);
	}

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

	// C2(設計04 §5・2026-07-17 動的フィット改訂): renderAll「最終段」の表示切りだけを行う畳み。
	// ここより前の並べ替え/セクショニング/楽観適用(sectionizeManual・位置記憶・stickyData)には
	// 一切触れない — 畳みは「フル描画済みの DOM」を実測して行を間引くだけの後処理。
	// 【2026-07-18 ユーザー裁定: fold-anchor マーカーは廃止】旧実装はここに Comment ノードを置き、
	// applyInlineFold がその直後(=4セクションの直後・ドラフト行/完了済みの手前)へフッタを挿していた。
	// ⊕ を統合した action-row は「ドラフト行より下の flow 最終行」に出す必要がある(item3: ドラフト行は
	// アクション行の上に出る)ため、マーカー位置への insertBefore ではなく、ドラフト/完了済みを含めた
	// 全ての appendChild が終わったこの時点で applyInlineFold が root.appendChild するだけでよくなった
	// (foldAnchor 自体が不要になった=会計の単純化の一部)。
	applyInlineFold();
}

// アクション行(.action-row)の実高さ(margin 込み)のキャッシュ。CSS 定数(todos-app.ts の
// .action-row/.fold-more)の二重管理を避けるため、実測値をそのまま budget の先引きに使う。
// ページ内で一度測れば以降は不変(フォント/CSS 変数が実行中に変わることは無い)。
// 【2026-07-17 C0-b で probe 対象を「すべて表示」ボタン(.fold-expand)→ フッタ要約行(.fold-more)へ
//  置換】→【2026-07-18 ユーザー裁定で「フッタ + 浮遊 FAB」→「フッタ+⊕ を1行に統合した action-row」へ
//  再置換】(cachedButtonBlockPx → cachedFooterBlockPx → cachedActionRowBlockPx。budget 先引きの
//  意味は不変=「行より下の chrome の高さを先に引く」。経緯の詳細は measureActionRowBlockPx 参照)。 */
let cachedActionRowBlockPx: number | null = null;

// 直近の描画で inline プレビューを実際に畳んだ(アクション行左に「他 N件」を出した)か。
// applyInlineFold が毎描画で設定し、⊕(旧 FAB・現 action-add)ハンドラが「折り畳み中の追加は
// fullscreen へ昇格してから」の判定に読む(宣言は applyInlineFold のコメント参照)。
let lastFoldActive = false;

// 【2026-07-17 実機 FB: 選択(編集モード)で inline プレビューの表示件数が減るバグの根治】
// 症状: 未完了6件・inline が上位3件+「他3件」のとき、3行目「あ」をタップして編集モードに
// 入ると「あ」自身が消え、2件+「他4件」に変わる。原因は applyInlineFold が renderAll の
// たびに DOM を実測して visibleCount を決め直すこと — 選択行はタイトルが input 化しメモ行が
// 増えて**背が伸びる**ため、rowBottoms が下にずれ computeInlineFit の budget クランプが
// fitCount を 3→2 に減らし、選択中の行(=タップできた=見えていたはずの行)まで畳んで
// remove してしまっていた。
//
// 不変条件(ユーザー指定): 「編集と閲覧のリストで表示中の件数は基本変わらない」。選択しても
// プレビューのメンバーシップ(どの行が見えるか)と件数が変わってはならない。とりわけタップした
// 行は必ず見えたままでなければならない。
//
// 対処案は2つ検討した(親から提示):
//   (a) 静止時(selectedId===null)に算出した visibleCount をキャッシュし、選択中はそれを使う。
//   (b) rowBottoms 算出時に選択行の伸びた分を差し引いて静止時相当に補正する。
// (b) は「選択行の静止時高さ」を DOM から直接測れない(既に伸びた状態でしか観測できない)ため
// 実装が壊れやすい。(a) を採用する — 選択は「行の並び順」を変えないので(sectionize/ソートは
// selectedId を見ない)、静止時に決まった「先頭 N 件」というメンバーシップは選択中もそのまま
// 有効であり、キャッシュを使い回すだけで不変条件を満たせる。
// 【(a) のリスクと許容理由】選択中に外部更新(ポーリング等)でタスク集合が変わっても
// visibleCount が古い値に張り付く可能性はあるが、選択解除(=次の selectedId===null の
// renderAll)で必ず最新値に再同期される。選択中は編集に集中している短時間でありポーリング差分の
// 実害は小さいと判断し許容する(過剰実装を避ける)。
let cachedStaticVisibleCount: number | null = null;

/** アクション行(.action-row = 旧フッタ要約行 .fold-more + ⊕ 追加ボタン)の高さ(margin 込み・px)を
 *  実測する(旧 measureFooterBlockPx を改名・拡張)。
 *  【2026-07-18 ユーザー裁定: 浮遊 FAB 廃止 → + をフッタ行へ統合(fold 会計の簡素化)】
 *  旧実装は「フッタ要約行(.fold-more)」と「浮遊 FAB(.fab-row)」が別々の flow 要素で、
 *  budget の先引き(bottomChrome)も両者の合計 + fullHeight にも FAB 分を別途加算していた
 *  (旧 measureFabBlockPx。下記に経緯を残す)。inline では浮遊 FAB 自体を廃止し(CSS 側
 *  `.fab-row{display:none}` → todos-app.ts 参照)、+ は「他 n件の未完了」フッタと同じ行
 *  (.action-row)の右端に統合した — action-row は inline では常に flow 最終行として1つだけ
 *  存在する(畳みが無いときも左が空なだけで行自体は出る。todos-entry.ts の applyInlineFold・
 *  buildActionRow 参照)。そのため「フッタ + FAB の合計」だった bottomChrome は
 *  「action-row 1つ分の高さ」に単純化される — fullHeight 側の加算も同じ値を使えばよく
 *  (action-row は畳んでも畳まなくても常に flow に実在するため)、旧 fullHeight は FAB 分だけ・
 *  bottomChrome はフッタ+FAB、という非対称だった会計が対称(常に action-row 1つ)に単純化された。
 *  【なぜ probe を1回描いて測るか】判定の時点では canRequestFullscreen の結果(フッタをボタン化
 *  するか受動表示か)も remaining(畳みの有無)も未確定だが、action-row の高さは
 *  「⊕ ボタン(44px 固定)を含む行の min-height」で決まり、左のフッタ有無やテキスト長では
 *  変わらない設計にしてある(todos-app.ts の .action-row CSS)。button 版 fold-more(min-height
 *  32px)入りで測っても action-row 自体の min-height(44px)の方が支配的なので、どちらの分岐でも
 *  1つの probe で高さを代表できる。
 *  【なぜ hidden ではなく visibility:hidden か】display:none は offsetHeight が 0 になり測れない。
 *  visibility:hidden はレイアウトに参加する(一瞬 layout に載るが即 remove するのでちらつきは無い)。
 *
 *  【旧 measureFabBlockPx(浮遊 FAB の実測)は本改訂で完全に不要になったため削除した(経緯記録)】
 *  旧実装は「FAB は #root の外(兄弟要素)なので root.scrollHeight に含まれない」ことを理由に
 *  quickAddFab.closest(".fab-row") を直接 getBoundingClientRect 相当で読んでいたが、inline の
 *  浮遊 FAB 自体が無くなった(fullscreen だけに限定・CSS 側で display:none/flex を切替)ため、
 *  inline の fold 会計から FAB の高さを足す必要が消えた。fullscreen は applyInlineFold が早期
 *  return するのでそもそも fold 会計の対象外(浮遊 FAB の実高さを気にする必要がない)。 */
function measureActionRowBlockPx(): number {
	if (cachedActionRowBlockPx !== null) return cachedActionRowBlockPx;
	const probe = document.createElement("div");
	probe.className = "action-row";
	probe.style.visibility = "hidden";
	const footerProbe = document.createElement("button");
	footerProbe.type = "button";
	footerProbe.className = "fold-more";
	footerProbe.textContent = "他 00件の未完了"; // テキスト長は action-row の高さに無関係(下部コメント参照)
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

/**
 * C0-b 本体(2026-07-17 inline プレビュー化・2026-07-18 action-row 統合改訂): inline = 上位 N_MAX 件の
 * 未完了プレビュー / fullscreen = 全件、という役割分担にする(設計05 §4・モック inline-preview.html)。
 * 表示件数を **min(INLINE_PREVIEW_MAX, computeInlineFit のフィット件数)** にクランプし、隠れた行が
 * あれば flow 最終行のアクション行(.action-row)左に「他 n 件の未完了」を出す。タップ=右上 ⤢ と同じ
 * requestDisplayMode({mode:"fullscreen"})(導線は2つ・装置は1つ)。
 * **⊕(追加)はアクション行の右に統合し、folded でも常に表示**(2026-07-18 ユーザー裁定: 浮遊 FAB 廃止・
 * 詳細は measureActionRowBlockPx コメント)。
 *
 * 【旧「すべて表示」ボタン + 受動「残り n 件」の廃止(役割重複の解消)】旧実装は「maxHeight に収まる
 * 限り全件・溢れたら畳む」動的モデルで、末尾に「すべて表示 (全n件)」ボタン(or 受動「残り n 件」)を
 * 挿していた。だがこのボタンは右上 ⤢(fullscreen 昇格)と役割が重複していた(裁定 2026-07-17)。
 * inline を「境界の効いた上位 N 件プレビュー」に一本化し、全件は ⤢/フッタで fullscreen へ、に整理した。
 *
 * 【computeInlineFit は捨てない = 安全クランプとして再利用(fold.ts 冒頭コメント)】N_MAX=5 件でも
 * 端末の maxHeight 次第(小さいホスト)では 5 件が溢れることがある。その物理フィットの逆算に
 * computeInlineFit を使い、min(N_MAX, フィット件数) で「プロダクト方針(高々 N 件)」と「端末制約
 * (それでも溢れるなら更に減らす)」を合成する。maxHeight 未送信のホストは Infinity を渡す(full 判定=
 * 全行フィット)ので、その場合のクランプは純粋に N_MAX が効く。
 *
 * 【bottomChrome = アクション行1つ分(2026-07-18 単純化)】旧「フッタ + FAB」の合計だった bottomChrome は
 * action-row 1つの高さに単純化された(measureActionRowBlockPx コメント参照)。full 判定の fullHeight
 * 側にも同じ値を加算する(action-row は folded/full どちらでも常に flow 最終行として実在するため —
 * 旧実装の「フッタは full のとき出ないので fullHeight には含めない」非対称は解消された)。
 *
 * 【1パスで完結・再測定ループ無し】測る→判定する→適用する、を1回の renderAll 内で完結させる。
 */
/** アクション行(フッタ「他 n 件の未完了」+ ⊕)を組み立てる。remaining が null なら畳みが無い
 *  (左は空・⊕ だけの行)。canRequestFullscreen で fullscreen 昇格ボタン化するかを判定する処理は
 *  旧フッタ生成と同一(コメントは旧 applyInlineFold から移設)。⊕ のクリックは todos の追加フロー
 *  (triggerQuickAdd。旧 quickAddFab ハンドラを抽出した共通関数)をそのまま呼ぶ — 浮遊 FAB と
 *  同じ「折り畳み中は fullscreen へ昇格してから startDraft(450)」判定に乗る(lastFoldActive 参照)。 */
function buildActionRow(remaining: number | null): HTMLElement {
	const row = document.createElement("div");
	row.className = "action-row";
	if (remaining !== null) {
		const canFull = canRequestFullscreen(hostAvailableDisplayModes);
		// フッタ要約行「他 n 件の未完了」(> 2026-07-17 実機 FB1 で「— 全画面で表示」の CTA を削除・簡素化)。
		// タップ= fullscreen 昇格の挙動はそのまま。CTA 文言を消してもタップ可能なことは色で示す —
		// button 版(canFull)は .fold-more 全体をリンク色(accent)にする(todos-app.ts の button.fold-more)。
		// これはカード内の他のタップ可能テキスト(ヘッダ Done・詳細ページのリンク行)と同じ「accent 色=押せる
		// テキスト」という既存の視覚言語に合わせた選定(枠付きボタンにすると inline カードの静かなトーンを乱す)。
		// 非広告ホスト(本アプリの現状=未受信)では受動表示(タップ不可の div・muted 色)= 死にリンクを作らない
		// (設計05 §4・2026-07-16 fable 指摘「押しても何も起きないリンクを出さない」)。
		const footer = document.createElement(canFull ? "button" : "div");
		footer.className = "fold-more";
		footer.appendChild(document.createTextNode("他 "));
		const count = document.createElement("span");
		count.className = "fold-more-count";
		count.textContent = `${remaining}件の未完了`;
		footer.appendChild(count);
		if (canFull) {
			(footer as HTMLButtonElement).type = "button";
			footer.addEventListener("click", () => {
				// requestDisplayMode の戻り値は実際に設定されたモード(apps.mdx:787 MUST)。ホストが昇格を
				// 拒否したら "inline" が返るだけでエラーではない — 何もしない(次回描画は host-context-changed
				// 経由の hostDisplayMode 更新に委ねる)。通信失敗等はカードを壊さないよう握りつぶす。
				void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
			});
		}
		row.appendChild(footer);
	}
	// ⊕(旧 #quick-add-fab の役割を継承)。inline では常に出す — folded 有無に関わらず主要な
	// 追加導線を隠さない(旧「+ FAB は folded でも常に表示」というユーザー実機 FB の意図を継承)。
	const addBtn = document.createElement("button");
	addBtn.type = "button";
	addBtn.className = "action-add";
	addBtn.setAttribute("aria-label", "リマインダーを追加");
	addBtn.appendChild(createIcon("plus"));
	addBtn.addEventListener("click", (e) => {
		e.stopPropagation(); // 旧 quickAddFab ハンドラと同じ理由(document click の選択解除に巻き込まない)。
		triggerQuickAdd();
	});
	row.appendChild(addBtn);
	return row;
}

function applyInlineFold(): void {
	// 【lastFoldActive: 「今この描画で実際に畳んだ(アクション行左に『他 N件』を出した)か」の記録
	// (2026-07-17)】⊕ ハンドラが「折り畳み中に追加しようとしたら fullscreen へ昇格してから追加する」
	// 判定に使う(プレビュー truncate 中に新規行を足すと top-N の窓の外にソートされて見えなくなる/
	// フッタの下に出る不自然さ=実機FB を、そもそも畳みの無い全件表示へ逃がして回避する・ユーザー提案)。
	// 早期 return する経路(inline でない)は「畳んでいない」ので false のまま。
	lastFoldActive = false;
	// fullscreen 中はプレビュークランプしない(全件 + 内部スクロールは C3/applyHostContext の
	// fullscreen-scroll が担う)。inline 以外(hostDisplayMode が null=displayMode 未送信のホスト等)は
	// 早期 return = 従来どおり全件表示(退行ゼロ)。アクション行自体も出さない(2026-07-18 ユーザー
	// 裁定: fullscreen では浮遊 FAB を復活させ、アクション行は畳みが無い fullscreen では冗長=出さない)。
	// 【2026-07-17 C0-b: hostMaxHeightPx===null の早期 return を撤去】旧実装は maxHeight 未送信なら
	// 早期 return して畳まなかったが、新モデルでは inline は maxHeight の有無に関わらず「上位 N 件
	// プレビュー」に束ねる(N_MAX クランプは端末制約ではなくプロダクト方針)。maxHeight が null のときは
	// computeInlineFit へ Infinity を渡す(full=全行フィット扱い)ことで、クランプは N_MAX だけが効く。
	if (hostDisplayMode !== "inline") return;

	// root.scrollHeight 等の読み取りは強制同期レイアウト(reflow)を伴うが、inline カードの描画頻度
	// (ユーザー操作/ポーリング単位)なので実害は小さい。renderRow が li.dataset.id を付けているので
	// セクション見出し(h2)は各行の offsetTop に押し下げとして織り込まれる(fold.ts の設計前提)。
	const rows = Array.from(root.querySelectorAll<HTMLLIElement>("section:not(.sec-completed) > ul > li"));
	const rowBottoms = rows.map((li) => li.offsetTop + li.offsetHeight);
	// 2026-07-18 単純化: 旧「フッタ + 浮遊 FAB」の合計だった bottomChrome/fullHeight 先引きは、両者が
	// 1つの action-row(常に flow 最終行として実在)へ統合されたことで「action-row 1つ分」に単純化
	// された(measureActionRowBlockPx コメント参照)。
	const actionRowBlock = measureActionRowBlockPx();
	const fullHeight = root.scrollHeight + actionRowBlock;
	const bottomChrome = actionRowBlock;

	// フィット件数: maxHeight 未送信は Infinity(=全行フィット)。full なら全行、folded なら visibleCount。
	const fit = computeInlineFit(rowBottoms, fullHeight, hostMaxHeightPx ?? Number.POSITIVE_INFINITY, bottomChrome);
	const fitCount = fit.mode === "full" ? rows.length : fit.visibleCount;
	// プレビュークランプ: プロダクト方針(高々 N_MAX 件)と端末制約(それでも溢れるなら更に減らす)の min。
	const dynamicVisibleCount = Math.min(INLINE_PREVIEW_MAX, fitCount);
	// 【選択中は静止時の visibleCount に固定(上記 cachedStaticVisibleCount コメント参照)】
	// selectedId===null の renderAll でだけ動的値を採用しキャッシュを更新する。選択中
	// (selectedId!==null)は選択行が伸びて計算が縮んでも無視し、直近の静止時キャッシュを使う —
	// これにより「タップした行が畳まれて消える」再発を構造的に防ぐ。キャッシュが無い(通常は
	// 起こらない: 初回 renderAll は必ず selectedId===null で通る)場合のみ動的値へ防御的に
	// フォールバックする。
	let visibleCount = selectedId === null ? dynamicVisibleCount : (cachedStaticVisibleCount ?? dynamicVisibleCount);
	if (selectedId === null) cachedStaticVisibleCount = visibleCount;
	// 【監査 D: 選択中でも選択行が可視集合に入る保証】選択中は上の cachedStaticVisibleCount で
	// 「件数」は固定しているが、外部更新(sync 由来の並び替え・新規行の挿入等)で rows の**メンバー
	// シップ**が変わると、選択行が先頭 visibleCount の外へ押し出されて slice(visibleCount) で
	// remove されうる(不変条件「タップ行は必ず見えたまま」を破る別経路 — cachedStaticVisibleCount
	// は「件数」しか固定しないので、これだけでは選択行自体の残留は保証できない)。選択行が rows の
	// 先頭 visibleCount に入っていなければ、選択行の index+1 まで visibleCount を拡大して必ず含める。
	// maxHeight の予算を超えうるが、「編集中の行が見える」ことを優先する(キーボード回避はホスト側の
	// 責務であってこのカード内 fold の関心事ではない)。
	if (selectedId !== null) {
		const selectedIndex = rows.findIndex((li) => li.dataset.id === selectedId);
		if (selectedIndex >= visibleCount) visibleCount = selectedIndex + 1;
	}
	const folded = visibleCount < rows.length;
	if (folded) {
		lastFoldActive = true; // 実際に畳んで「他 N件」を出す(⊕ の fullscreen 昇格判定に使う)。
		rows.slice(visibleCount).forEach((li) => li.remove());
		// 空になった(=全行畳まれた)セクションは見出しだけ残らないよう畳む。
		for (const section of Array.from(root.querySelectorAll<HTMLElement>("section:not(.sec-completed)"))) {
			const ul = section.querySelector("ul");
			if (ul !== null && ul.children.length === 0) section.remove();
		}
	}

	const totalCount = rows.length; // 畳み対象4セクション横断の合計行数(完了済み・ドラフトは対象外)
	const remaining = totalCount - visibleCount; // = 「他 n 件」の n(folded でなければ使わない)
	// 【2026-07-18 ユーザー裁定: アクション行は常設(畳みの有無に関わらず inline では必ず出す)】
	// 旧実装は畳んだときだけフッタを append していたが、⊕ を統合した今は「畳みが無いときは左が
	// 空の行」として常に出す(root の flow 最終行に置くことで浮遊 FAB を廃止できる — item1)。
	root.appendChild(buildActionRow(folded ? remaining : null));
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
	// calendarId(E-2 スライス③): この一覧の対象コレクション ID。server は必ず載せる(省略時 "tasks")。
	// ヘッダ見出しと quick-add の作成先に使う。合成 vm(mutation の非既定ビュー経路)では refresh 側の
	// vm から引き継がれる(applyStructuredContent が currentCalendarId を更新する)。
	calendarId?: string;
	// timeZone(コレクションの解釈ゾーン)。v2 詳細シートの「時間帯」行を「閲覧者ゾーンと異なるときだけ」
	// 出すために使う(list-todos/create-todo 等の vm が載せる)。
	timeZone?: string;
	affected?: AffectedEntry[];
	removed?: TaskSnapshot[];
	// view echo(E-2 view 状態非保持バグ修正)。list-todos/refresh-todos が「この一覧はどのビューか」を
	// 返す(非既定ビューのときだけ載る)。mutate 系は view を載せない(既定ビューのまま=仕様3)。
	view?: CurrentView;
}

/**
 * SyncDiff(システム起因の残差)を AffectedEntry[](sync:true)へ変換する。
 * added/completed/reopened/edited はいずれも対象行が nextTasks に実在する
 * (=次の描画で本物の tasks 行が becoming 装飾を受け取る)ため、snapshot は添えない —
 * server 側 completed の「未完了ビューから抜けた行を snapshot で合成」する必要は sync には無い。
 *
 * 【重要な限界(default ビューでの完了と削除の非区別)】
 *   includeCompleted:false(既定)ビューでは、外部で「完了」されたタスクは未完了一覧から
 *   抜けるため、クライアント差分では next-欠落 = removed(削除)として検出される
 *   (completed には入らない — completed は両ビューに残る includeCompleted:true のときだけ検出)。
 *   つまり既定ビューでの外部完了は「同期(削除)」ゴーストとして見える。DTO に「なぜ消えたか」の
 *   情報が無い以上クライアントからは区別不能で、これは許容する degrade(実害は「完了なのに削除と
 *   表示」= 一過性の中間表現が1描画だけ出るだけ)。includeCompleted:true で開いていれば
 *   完了は completed として正しく検出される。→ 親への論点として報告。
 */
function syncDiffToAffected(diff: SyncDiff): AffectedEntry[] {
	const out: AffectedEntry[] = [];
	for (const id of diff.added) out.push({ id, kind: "added", sync: true });
	for (const id of diff.completed) out.push({ id, kind: "completed", sync: true });
	for (const id of diff.reopened) out.push({ id, kind: "reopened", sync: true });
	// 【2026-07-15 実機フィードバック: edited は sync レンズに出さない】claude.ai は会話再訪時に
	// 古い tool 応答を replay してから focus refetch する。この機構の上では sync 差分は
	// 「カードを最初に描いた時点からの変化」を意味し、「いま list しただけ」の体感とずれる —
	// 特に edited は現在値が行に表示済みで情報量が薄く、「同期(編集)他1件」がほぼノイズだった。
	// さらに DTO の形の進化(スライス⑤で recurrence/location 追加)により、古い replay スナップ
	// ショット(フィールド不在)と新 DTO の比較が反復タスク全行で偽陽性の edited を出す実害も
	// あった。追加/完了/再開/削除(高シグナルな出来事)だけ残し、edited は捨てる。
	// computeSyncDiff 自体は edited を計算し続ける(契約は変えず、消費側で落とす=戻しやすい)。
	return out;
}

/**
 * 応答を状態に反映する唯一の関数。ontoolresult / fetchLatest / mutation 成功の
 * 3経路すべてがここを通ることで、「tasks と becoming メタは常に同じ応答のペア」という
 * 不変条件を守る(別々に更新すると、古い affected が新しい tasks に重なる事故が起きる)。
 * affected/removed が無い応答では Map/配列が空になる = becoming が消える(状態コメント参照)。
 */
function applyStructuredContent(sc: unknown): void {
	const structuredContent = sc as TodosStructuredContent | undefined;
	const nextTasks = structuredContent?.tasks ?? [];
	const serverAffected = structuredContent?.affected ?? [];
	const serverRemoved = structuredContent?.removed ?? [];

	// --- システム起因(外部)変化の差分レンズ(E-2 スライス④)-------------------------
	// prev(直前に描画した tasks = この関数が前回セットした値)と nextTasks を突き合わせ、
	// サーバーの affected/removed で説明済みでない残差 = ユーザーが起こしていない変化を検出する。
	// 【なぜ applyStructuredContent 1箇所でやるか】ここは全応答(ontoolresult / fetchLatest /
	// mutation 便乗)の唯一の入口。silent に混ざる経路は (1) focus refetch (2) 自分の mutation
	// 応答への便乗 の2つあるが、どちらも最終的にここを通るので、1箇所の差分計算で両方に効く。
	// 【初回は差分なし】tasks===null(まだ一度も描画していない)なら prev が無いので全行が
	// 「追加」に見えてしまう。初回は差分を取らない(prev 無し=差分なし、が正しい静けさ)。
	// 【degrade ガード(仕様3)】pending 中の行は差分マークの対象から外す(explainedIds に混ぜる)。
	// 完全な「延期」はしない理由: 一覧の並べ替え自体は tasks 置換で必ず起きる(becoming マークの
	// 有無とは独立)ので、becoming だけ遅らせても指の下の並べ替えは防げない。データ鮮度を捨てて
	// tasks 置換ごと延期するのは stale 表示という別の害を生む。さらに pending 中は maybeRefetch が
	// 早期 return するので focus 便乗の新データは来ず、来るのは自分の mutation 応答だけ(その行は
	// server affected 側で説明済み)。よって「pending 行にはシステム差分マークを乗せない」まで
	// degrade し、それ以外は即適用する(quick-add 入力中も同様 — 入力欄は #root の外なので再描画で
	// blur されず、指の下で崩れるのは list 行だけ。その list 行の並べ替えは上記のとおり不可避)。
	// 【アニメーション方針】システム差分も既存 becoming と同じ「静的マーキングのみ」に乗る
	// (装飾アニメは足さない)。行の移動を滑らかに見せる FLIP はやらない — 将来任意の加点で、
	// reduced-motion 分岐と会話ログ内カードで動くノイズの検証がセットで要るため今回はスコープ外。
	// reduced-motion は既存の抑制(spinner/skeleton の @media)にそのまま乗る(新規の動きが無い)。
	// 差分レンズの prev/next はクリーンな確定値だけを使う(confirmedTasks)。表示用 tasks は
	// 楽観の重ね物込みなので prev に使うと仮行が removed に化ける等の誤検出になる(2026-07-14)。
	// calendarId が変わった描画では差分レンズを回さない(2026-07-14 実機バグ修正の保険)。
	// reconcile が失敗して別コレクションの vm を degrade 適用した場合、prev(前コレクションの tasks)と
	// next(別コレクションの tasks)を突き合わせると「全行が追加+全行が削除」の全差分ノイズになる。
	// コレクションが違う描画は「差分」ではなく「別物への切り替え」なので、静かに置き換える(sync 差分ゼロ)。
	// currentCalendarId はこの時点でまだ前回値(更新は関数末尾)なので旧コレクションとの比較になる。
	const incomingCalendarId = structuredContent?.calendarId;
	const calendarChanged =
		currentCalendarId !== null && incomingCalendarId !== undefined && incomingCalendarId !== currentCalendarId;
	// view 変更(実質別ビュー)判定。mutate 応答は view を持たない(undefined)ので誤検出しないよう、
	// sc.view が明示されていて currentView と中身が違うときだけ「別ビュー」とみなす(2026-07-14 並び順安定性)。
	const viewChanged =
		structuredContent?.view !== undefined && JSON.stringify(structuredContent.view) !== JSON.stringify(currentView);
	// 実質別ビュー(コレクション切り替え or ビュー切り替え)への遷移では位置記憶をリセットし、
	// 次の renderAll をクリーン描画にする(要件4: クリーン再セクショニングはリセット時 or fresh render のみ)。
	if (calendarChanged || viewChanged) resetPositionMemory();
	let syncDiff: SyncDiff = { added: [], completed: [], reopened: [], edited: [], removed: [] };
	// viewChanged も差分レンズをスキップする(default→includeCompleted で prev/next の件数が
	// 大きく変わり全件が「追加/削除」に誤検出されるのを防ぐ。calendarChanged と同じ理由)。
	if (confirmedTasks !== null && !calendarChanged && !viewChanged) {
		const explained = new Set<string>();
		for (const a of serverAffected) explained.add(a.id);
		for (const r of serverRemoved) explained.add(r.id);
		// in-flight トグル行は触らない(degrade ガード)。Set→Map 化(§7.8)に伴い .keys() で id だけ回す。
		for (const id of pendingIds.keys()) explained.add(id);
		// 仮行(optimistic:)は confirmedTasks に元々入らないので prev/next のどちらにも現れず、
		// 差分計算に混ざらない(仕様3「仮行は差分計算から除外」を state 分離で構造的に満たす)。
		syncDiff = computeSyncDiff(confirmedTasks, nextTasks, explained);
	}

	confirmedTasks = nextTasks;
	// C0-a: サーバーが当該 id を「未完了」で返してきたら退場マークを解除し、退場保留タイマーも取り消す
	// (外部/別クライアントでの genuine な再開は再表示を許す。退場は「完了残骸の有界化」の保険であって
	// 「未完了に戻った行を消し続ける」ためのものではない)。完了のまま(includeCompleted ビュー等)なら
	// retiredDoneIds に留めて再合成しない。
	for (const t of nextTasks) {
		if (!t.completed) cancelDoneExit(t.id);
	}
	// サーバー由来(ユーザー起因)+ システム由来(sync)の affected を統合。sync 側は sync:true を
	// 立て、renderRow/announceBecoming が中立ラベル「同期(...)」で描く。
	const combinedAffected: AffectedEntry[] = serverAffected.concat(syncDiffToAffected(syncDiff));
	// removed も同様に統合。システム由来のゴーストは sync:true。
	const combinedGhosts: TaskSnapshot[] = serverRemoved.concat(
		syncDiff.removed.map((r): TaskSnapshot => ({ ...r, sync: true })),
	);
	// サーバー土台を記録し、その上に in-flight 楽観を重ね直して表示用 state を作る
	// (rebuildDisplay が tasks/affectedById/ghosts をまとめて設定する)。確定 vm が届いても
	// in-flight の楽観トグル/仮行が失われないのは、この重ね直しがあるため(一貫性の要)。
	serverAffectedBase = combinedAffected;
	serverGhostsBase = combinedGhosts;
	// 【2026-07-18 実機 FB「done にして時間が経過しても消えないタスクがある」原因(a)】
	// scheduleDoneExit は従来 toggleTask(カード内タップの楽観ステップ)からしか呼ばれておらず、
	// 「affected:completed」が自分の楽観経路を通らずに届く経路(他クライアントでの完了 = sync 由来の
	// syncDiffToAffected("completed")、または将来ここを通りうる mutate 応答の affected)は退場タイマーが
	// 一切仕込まれず、無期限に sticky 表示(mergeCompletedBase による in-place 合成行)として残り続けていた。
	// これが「消えるものと残留するものが混在する」の正体 — 退場するかどうかが「誰が完了させたか」という
	// 表示に無関係な経路差で決まっていた。
	// 【なぜここで一括処理してよいか】combinedAffected の kind==="completed" は常に「今回の応答で
	// 未完了→完了へ遷移した」ことを意味する差分(applyToggleConfirmed 経由の自分の操作 or
	// computeSyncDiff が検出した外部の操作)であり、includeCompleted:true ビューで最初から完了として
	// 返ってきた行(=遷移ではない)はここに現れない(computeSyncDiff は「遷移」だけを diff として拾う)。
	// よって全 kind==="completed" に一律 scheduleDoneExit を仕込んでも「意図的に開いた完了フィルタ表示」を
	// 誤って退場させることはない。scheduleDoneExit は冪等(exitTimers.has/retiredDoneIds.has で二重仕込み
	// を防止)なので、自分の楽観トグルで既にタイマー済みの id を再度渡しても無害(タイマーが延長も
	// リセットもされない)。
	// 【2026-07-18 監査 B: done→undo 追送中のレース】done→即 undo(reopen)した直後、reopen の
	// update-todo がまだ in-flight（flushToggle の追送中）の間に、先行した done の完了応答が
	// ここへ届くことがある(desiredToggle は「最新のユーザー意図」に更新済みだが、応答は届いた順)。
	// この combinedAffected は応答時点のサーバー遷移を表すだけで、ユーザーの「今」の意図を反映しない
	// ので、無条件に scheduleDoneExit すると reopen 応答が届くまでの間だけ行が退場し(cancelDoneExit
	// は reopen 応答時にしか効かない)、最新意図が「未完了」なのに一瞬消える演出になってしまう。
	// desiredToggle[id] を見て、最新の望みが「未完了」(completed:false)ならタイマーを仕込まない
	// (意図と逆向きの退場演出をしない)。desiredToggle に無い id(この応答で確定して以降ユーザー操作が
	// 無い)は従来どおり素通しする。
	for (const a of combinedAffected) {
		if (a.kind !== "completed") continue;
		const desired = desiredToggle.get(a.id);
		if (desired !== undefined && !desired.completed) continue;
		scheduleDoneExit(a.id);
	}
	// 削除された id は位置記憶 / sticky から追い出す(2026-07-14 並び順安定性)。これをしないと、
	// 削除で消えた行が stickyData の last-known データを頼りに「幽霊住人」として復活してしまう
	// (ghost の becoming-gone は1描画で消えるが、位置記憶が残っていると次描画で sticky 経路が拾う)。
	for (const g of combinedGhosts) {
		positionMemory.delete(g.id);
		stickyData.delete(g.id);
	}
	rebuildDisplay(combinedAffected, combinedGhosts);
	// currentView を「描画に使った vm の view」で更新する(vm.view ?? {})。E-2 view 状態非保持
	// バグ修正の要。list-todos/refresh-todos 応答は view を echo するのでビューが維持され、
	// mutate 応答(view 無し)を直接適用するのは既定ビューのときだけ(toggleTask の分岐参照)なので
	// {} へ戻っても既に既定=無害。非既定ビューでの mutation は refresh-todos で view を保った
	// 合成 vm を渡してくるため、ここで currentView が誤って既定に落ちることはない。
	currentView = structuredContent?.view ?? {};
	// currentCalendarId を応答の calendarId で更新し、ヘッダ見出しへ反映する(E-2 スライス③)。
	// server は必ず calendarId を載せるが、旧サーバー/欠落応答に備え、値が来たときだけ更新する
	// (未受領のうちはプレースホルダ「リマインダー」のまま = 後方互換 degrade)。
	if (structuredContent?.calendarId !== undefined) {
		currentCalendarId = structuredContent.calendarId;
		appTitleEl.textContent = currentCalendarId;
	}
	// timeZone を保持(詳細シートの「時間帯」行の出し分けに使う)。値が来たときだけ更新する。
	if (structuredContent?.timeZone !== undefined) {
		currentTimeZone = structuredContent.timeZone;
	}
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
	// システム起因(sync)の件数。個々のタイトルまでは読み上げず、末尾に要約1文で通知する
	// (E-2 スライス④・仕様4)。ユーザー自身が起こしていない変化を1件ずつ述語形で読み上げると
	// 「あなたがやった」ように聞こえて誤解を生むため、中立の要約「同期で N 件更新されました」に丸める。
	let syncCount = 0;
	for (const a of affectedById.values()) {
		if (a.sync === true) {
			syncCount++;
			continue; // sync は個別読み上げせず要約に集約
		}
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
	for (const g of ghosts) {
		if (g.sync === true) {
			syncCount++;
			continue; // sync 削除も要約へ集約
		}
		parts.push(`「${g.title}」を削除しました`);
	}
	if (syncCount > 0) parts.push(`同期で${syncCount}件更新されました`);
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
// C3(設計04 §5): appCapabilities.availableDisplayModes を宣言する(apps.mdx:781 View は
// appCapabilities.availableDisplayModes を宣言する MUST。これが無いとホストは:786「View の
// appCapabilities に無いモードへ MUST NOT switch」により fullscreen へ切り替えられない —
// この宣言が昇格フロー全体の前提・設計04 §5「順序制約」)。第2引数が capabilities
// (McpUiAppCapabilities・spec.types.ts:404-412、AppOptions とは別引数。app.d.ts:501
// `constructor(_appInfo, _capabilities?, options?)`)。
const app = new App({ name: "caldav-todos", version: "0.2.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
// ハンドラは connect 前に登録する(登録前に来た通知を取りこぼさないため。SDK 推奨。
// ext-apps は「connect 完了後の登録」を警告する _assertHandlerTiming を持つ)。
app.ontoolresult = (r) => {
	gotResult = true;
	clearStatus();
	// list-todos だけでなく create-todo 等の mutation ツールがこの UI を開いた場合も
	// ここに届く。mutation 応答には affected/removed が乗っており、初回描画から
	// becoming(「いま追加された」等)を表現できる — applyStructuredContent が共通処理。
	// 【2026-07-14】ここは list/refresh の自然な結果だけでなく、ホストが同一 resourceUri の
	// 別ツール結果を push してくる経路でもある(下記「view 上書き防御」参照)。ontoolresult
	// のシグネチャは同期だが中身は async(callServerTool を挟みうる)なので void で発火だけする
	// — ontoolresult 自体の戻り値をホストが待つ契約は無い(fire-and-forget は他の非同期処理
	// (toggleTask 等)と同じ扱い)。
	void ingestStructuredContent(r?.structuredContent).then(() => renderAll());
};
// C1: host-context-changed の購読(設計04 §5 C1・SDK フック調査結果)。
// 【SDK フック確認】node_modules/@modelcontextprotocol/ext-apps の app.d.ts に
// `addEventListener("hostcontextchanged", handler)`(非推奨版 `onhostcontextchanged` も同義)が
// 公開されている(app.d.ts:178,219,239,567-582,715-745)。よってポーリング等のワークアラウンドは
// 不要— SDK が host-context-changed 受信のたびに内部 _hostContext へ merge した後にこのハンドラを
// 呼ぶ(app.d.ts:723-727)ので、applyHostContext() を呼び直すだけで追従できる。ハンドラは
// connect 前に登録する(ontoolresult と同じ理由・SDK 推奨)。
app.addEventListener("hostcontextchanged", () => {
	applyHostContext();
	// maxHeight/displayMode の変化は畳み判定に直接効くため、値の反映だけでなく再描画まで行う
	// (sheetState 中の詳細/リスト選択ページはこの再描画では畳み対象外 = renderAll 内の早期
	// return で自然にスキップされる)。
	renderAll();
});

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
// C1: connect 完了後に一度読み、hostMaxHeightPx/hostDisplayMode を初期化する(apps.mdx:687-711 の
// 「View の初期化時に containerDimensions を確認する」の実装箇所)。以降の変化は上の
// hostcontextchanged 購読が拾う。renderAll は呼ばない — この直後に ontoolresult 由来の初回描画が
// 来る(まだ tasks が無いので skeleton のまま畳み判定しても意味が無い)。
applyHostContext();

// =============================================================================
// view 上書き防御(2026-07-14・本番検証で実測した契約外挙動への対策)
// =============================================================================
// 【実測した穴】MCP Apps 仕様は「ホストが同一 resourceUri を持つ別ツールの結果を、開いている
// App へ push してよい」ことを禁じていない。Inspector での実機検証でこの push が実際に起きる
// ことを確認した(claude.ai でも起こり得る契約外に近い挙動として警戒する)。list-todos/
// refresh-todos 以外のツール(create-todo/update-todo/delete-todo 等の mutate 系)の応答は
// view を持たない(冒頭コメントのとおり mutate 系は既定ビュー固定を前提に view を省略する契約)。
// もし includeCompleted:true 等の非既定ビューで App を開いている最中にこの push が届き、
// applyStructuredContent がそのまま tasks を適用してしまうと、currentView が黙って {} へ
// 戻り「開いていたビューが勝手に既定へ狭められる」= 完了済みセクションが消える事故になる。

/** 非既定ビュー中に「view echo の無い vm」を tasks ごとそのまま適用してよいかの判定(純関数)。
 *  【契約の裏付け】list-todos/refresh-todos は非既定ビューのときは必ず view を echo する
 *  (冒頭コメントの契約)。つまり「非既定ビューで開いている最中に view の無い vm が来た」は
 *  「この vm は list/refresh 由来ではない(mutate 応答、または無関係な他ツールの結果の push)」の
 *  確実なシグナルとして使える。既定ビュー({})のときは常に false(素通り)— 既定ビューでは
 *  mutate 応答をそのまま適用する従来挙動を壊さない。 */
function needsViewReconcile(view: CurrentView, sc: TodosStructuredContent): boolean {
	// (a) 非既定ビューで view echo の無い vm(mutate 応答 or 無関係な他ツールの push)→ そのまま
	//     適用すると currentView が黙って {} へ縮む(完了済みセクションが消える)ので refetch に差し替える。
	if (!isDefaultView(view) && sc.view === undefined) return true;
	// (b) calendarId 不一致(2026-07-14 実機バグ修正の最後の砦)。ホストが別コレクションの結果を
	//     同一 App へ push しても、届いた vm の calendarId が現在のカードのコレクションと違えば直接
	//     適用しない(カードが tasks コレクションの内容へ化ける事故の防御)。refetch(currentCalendarId
	//     付き)で自分のコレクションを取り直す。currentCalendarId が null(初回応答前)は自分の
	//     コレクションが未確定なので判定しない(初回 vm をそのまま受け入れて currentCalendarId を確立する)。
	if (currentCalendarId !== null && sc.calendarId !== undefined && sc.calendarId !== currentCalendarId) return true;
	return false;
}

/**
 * needsViewReconcile が true のときの合成: refresh-todos(currentView 付き)で確定 tasks/
 * calendarId/view を取り直し、届いた vm の affected/removed(あれば)だけを重ねる。
 * toggleTask/submitQuickAdd の非既定ビュー合成(quick-add 非既定ビュー経路)と同じ流儀を
 * 汎用化したもの — 「一覧は refresh 側、becoming 演出は届いた vm 側」という役割分担は共通。
 *
 * 【degrade 方針: refetch 失敗時は「そのまま適用」(重要な判断)】
 * toggleTask/submitQuickAdd は自分が起こした mutation の確定描画が目的なので、refetch 失敗時は
 * バナーで「再読み込みに失敗しました」と明示して手動再試行に委ねる(ユーザーは自分の操作が
 * 送信済みなことを知っている)。しかしここはユーザー起点ではない push への防御なので、
 * 「弾いて何も描画しない」を選ぶと、ホスト push を無視し続けて最新データが一切届かない画面に
 * 固まってしまう — サイレントに固まる方が「ビューが既定へ縮む」既知症状より実害が大きい。
 * よって refetch が失敗したときは、古い正しいビューを守るより最新データ(届いた vm をそのまま)を
 * 優先する degrade にする(vm の view が無いので currentView は既定へ戻るが、それは修正前の
 * 既知症状に戻るだけで新規の害を生まない)。
 */
async function reconcileViewAndCompose(sc: TodosStructuredContent): Promise<TodosStructuredContent> {
	try {
		const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
		if (refreshed.isError) {
			const first = refreshed.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
		return {
			tasks: rsc?.tasks ?? [],
			calendarId: rsc?.calendarId ?? sc.calendarId,
			view: rsc?.view,
			affected: sc.affected,
			removed: sc.removed,
		};
	} catch {
		// refetch 失敗 → 上のコメントのとおり degrade: 受け取った vm をそのまま返す
		// (呼び出し側の applyStructuredContent が最新データを最優先で適用する)。
		return sc;
	}
}

/**
 * ontoolresult(ホストからの push)専用の入口ガード。needsViewReconcile が true のときだけ
 * reconcileViewAndCompose を挟み、それ以外(既定ビュー・view 付き・初回描画)は従来どおり
 * applyStructuredContent へ直結する。
 * 【初回描画は対象外】tasks===null のときは currentView がまだ確立していない(既定 {} のまま)
 * ため isDefaultView が true になり needsViewReconcile 自体が false を返す — 明示の分岐を
 * 増やさず自然に対象外になる(仕様どおり)。
 */
async function ingestStructuredContent(sc: unknown): Promise<void> {
	const structuredContent = (sc as TodosStructuredContent | undefined) ?? {};
	if (needsViewReconcile(currentView, structuredContent)) {
		const composed = await reconcileViewAndCompose(structuredContent);
		applyStructuredContent(composed);
	} else {
		applyStructuredContent(sc);
	}
}

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
	const result = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
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
 * 完了/再開のトグル本体(2026-07-14 楽観更新ドクトリン。冒頭コメント参照):
 *   1. タップ即、optimisticToggle に楽観状態を積み、その場で再描画(becoming を即時に乗せる)。
 *      pendingIds に id を積むが disabled もスピナーも出さない(見た目はブロックしない)。
 *   2. 裏で update-todo を fire(完了→NEEDS-ACTION / 未完→COMPLETED)。反復 VTODO への
 *      COMPLETED はサーバーが D4 で処理する(UI は反復を判別しない現契約への適応でもある)。
 *   3. 成功: 楽観を解除し、確定 vm で通常再描画(楽観状態とほぼ一致するので視覚変化は最小)。
 *      失敗: 楽観をロールバック(元の status へ戻して再描画)+ エラーバナー(再試行=同 mutation 再送)。
 *
 * 【update-todo は通常ツール(visibility 制限なし)である点】ext-apps の app.d.ts は
 * callServerTool を「originating MCP server のツールをホスト経由で呼ぶ」とだけ定義しており
 * app 可視ツール限定という制約は型・doc に無い(@throws は host rejection の可能性のみ示唆)。
 * もし実機でホストが app 非可視ツールの呼び出しを拒否したら、サーバー側に app 専用ラッパー
 * (set-todo-status 等)を足す判断になる — その場合もこの関数のツール名を差し替えるだけ。
 */
async function toggleTask(task: TodoItem): Promise<void> {
	// A-2(> 2026-07-17 実機 FB 第2ラウンド): 仮行(create-todo in-flight の緑行)はサーバー id が無いので
	// 即トグルできないが、旧実装のように黙って捨てない — 望みの完了状態を pendingToggleIntents にキューし、
	// 楽観 UI は即反映(optimisticRowToItem が意図を読んでチェックを描く)。create 確定で実 id が判明した
	// 時点で applyQueuedToggle が実 id へトグルを適用する。連続タップは最後の意図で上書き(coalesce)。
	if (isOptimisticId(task.id)) {
		pendingToggleIntents.set(task.id, !task.completed);
		clearBanner();
		rebuildFromConfirmed();
		renderAll();
		return;
	}

	const nextCompleted = !task.completed;
	const nextStatus = nextCompleted ? "COMPLETED" : "NEEDS-ACTION";
	// A-1: 楽観 UI は「常に」即時反映する(in-flight 中の再タップも捨てない = 反応性 FB の核心)。
	// 望みの最終状態を desiredToggle に記録し、送信ループ(flushToggle)がそれを confirm まで追送する。
	optimisticToggle.set(task.id, { completed: nextCompleted, status: nextStatus });
	desiredToggle.set(task.id, { completed: nextCompleted, status: nextStatus });
	// C0-a(完了残骸の有界化): カード上で完了したら約3秒の undo 猶予後に退場するタイマーを仕込む。
	// 再開(nextCompleted=false)なら退場タイマーを取り消す(= undo。退場済みマークも解除して再表示を許す)。
	// タイマーは「タップ即」から起算する(iOS の undo 猶予と同じ体感 — サーバー確定を待たない)。
	if (nextCompleted) scheduleDoneExit(task.id);
	else cancelDoneExit(task.id);
	startCommitting(task.id); // §7.8: startedAt を積み、committing 満了タイマーを仕込む
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	announceBecoming(); // aria-live へ「〜を完了しました」等を即時通知(視覚 becoming と対)

	// 【二重送信防止(旧 pendingIds.has ガードの置き換え)】送信ループが既に走っていれば、そのループが
	// 次の往復後に desiredToggle を読んで追送する — ここで新規の update-todo を発火しない(1 id 1ループ)。
	if (inFlightToggle.has(task.id)) return;
	await flushToggle(task);
}

/**
 * A-1 の送信ループ(coalesce・last-write-wins)。desiredToggle[id] を confirm できるまで update-todo を
 * 送り続ける。往復のたびに「送った状態」と「今の望み」を突き合わせ、食い違えば補正を1発追送する
 * (連打しても常に最新1発だけがサーバーへ届く)。inFlightToggle で「この id の送信ループは1本だけ」を
 * 保証する(= 二重送信防止。旧 `pendingIds.has` ガードの目的をここで担保する)。
 * @param task 再試行バナー/calendarId/タイトル表示のためのスナップショット(望みは desiredToggle から読む)。
 */
async function flushToggle(task: TodoItem): Promise<void> {
	const id = task.id;
	inFlightToggle.add(id);
	try {
		// desiredToggle[id] が「送った内容と一致」に落ち着くまで回る。
		while (true) {
			const desired = desiredToggle.get(id);
			if (desired === undefined) return; // 望みが消えた(ロールバック等)→ 送るものは無い
			let result: Awaited<ReturnType<typeof app.callServerTool>>;
			try {
				// calendarId は今表示中のコレクション(currentCalendarId)を必ず渡す(2026-07-14 実機バグ修正)。
				// null(初回応答前)のときだけ省略して server 既定に委ねる。timeZone は時刻付き DUE の UTC 落ち
				// 防止で常時送る(refreshArgs と同様)。
				const updateArgs: Record<string, unknown> = { id, status: desired.status };
				if (currentCalendarId !== null) updateArgs.calendarId = currentCalendarId;
				updateArgs.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				result = await app.callServerTool({ name: "update-todo", arguments: updateArgs });
				if (result.isError) {
					const first = result.content?.[0];
					throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
				}
			} catch (e) {
				// update-todo 自体の失敗(transport / isError)→ 楽観をロールバックして元へ戻す。
				// coalesce 中でも「サーバー真実(confirmedTasks)へ戻す」のが最も安全(中途半端な意図を残さない)。
				desiredToggle.delete(id);
				optimisticToggle.delete(id);
				pendingIds.delete(id);
				cancelDoneExit(id); // 退場タイマー/退場済みマークも解除(失敗行が隠れ続けないように)
				// 【監査修正の補足(sticky 汚染の修復)】確定 vm から抜けた行(=完了確定済みで未完了ビューから脱落)の
				// reopen が失敗した場合、上記 rebuildDisplay の楽観復活(revive)で stickyData が未完了へ汚染されている。
				// サーバー真実(脱落 ⟺ 完了)へ戻すため、確定一覧に居ない id は sticky を完了状態へ復元する
				// (確定一覧に居る id は rebuildFromConfirmed が server 真実を描くので不要)。これをしないと、失敗後も
				// 行が未完了で残る別バグを生む(revive の裏返し)。
				if (!(confirmedTasks ?? []).some((t) => t.id === id)) {
					const snap = stickyData.get(id);
					if (snap !== undefined) stickyData.set(id, { ...snap, completed: true, status: "COMPLETED" });
				}
				rebuildFromConfirmed();
				renderAll();
				const verb = desired.completed ? "完了" : "再開";
				// 再試行 = 同じ最終状態を再送(toggleTask は task の元状態から nextCompleted を再計算するので、
				// 失敗でロールバック済みの task スナップショットに対して同じ意図に解決する)。
				showBanner(`「${task.title}」の${verb}を保存できませんでした`, () => void toggleTask(task));
				return;
			}
			// 確定 vm を適用(view 別分岐・reload 失敗は degrade。楽観はまだ解除しない = 下の coalesce 判定と
			// 再描画で最新の望みを保持し続けるため。desired==confirmed のときは重ねても値が一致=無害)。
			await applyToggleConfirmed(result.structuredContent as TodosStructuredContent | undefined);
			// coalesce: 往復/確定の間にユーザーが意図を変えていたら(desired と最新の望みが食い違う)、
			// 最新 desired で補正を追送する(ループ)。判定は純関数 coalesceAction に固定(mcp-toggle-coalesce.test.ts)。
			// 【実機バグ「done→undo で完了が残る」の核】この判定を「latest===undefined なら settle」だけでなく
			// 「latest≠sent なら必ず resend」に保つことで、完了往復の裏で undo された未完了意図を握りつぶさない。
			const latest = desiredToggle.get(id);
			if (coalesceAction(desired.completed, latest?.completed) === "resend") continue;
			// 落ち着いた: confirm 済みの状態が最新の望みと一致(or 新しい望み無し)。楽観/送信状態を解除する
			// (confirmedTasks が既に真実なので、解除しても表示は変わらない)。
			desiredToggle.delete(id);
			optimisticToggle.delete(id);
			pendingIds.delete(id);
			return;
		}
	} finally {
		inFlightToggle.delete(id);
	}
}

/**
 * update-todo 応答の確定 vm を反映する(既定ビュー=そのまま / 非既定ビュー=refresh-todos で取り直し
 * becoming メタだけ合成)。reload 失敗は degrade(mutate 自体は成功しているのでロールバックしない・
 * 「再読み込み失敗」バナーのみ)。旧 toggleTask の success 分岐をそのまま関数へ切り出したもの。
 */
async function applyToggleConfirmed(structuredContent: TodosStructuredContent | undefined): Promise<void> {
	// 【E-2 ② での方針】update-todo の structuredContent は「サーバー確定の全一覧 + affected」を返す契約。
	if (structuredContent?.tasks !== undefined) {
		if (isDefaultView(currentView)) {
			applyStructuredContent(structuredContent);
		} else {
			// 【view 状態非保持バグ修正・2026-07-14】非既定ビュー: mutate 応答 tasks は未完了ビュー固定で
			// currentView と矛盾するので tasks は refresh-todos で取り直し、becoming メタ(affected/removed)だけ合成。
			try {
				const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
				if (refreshed.isError) {
					const first = refreshed.content?.[0];
					throw new Error(first !== undefined && first.type === "text" ? first.text : "(詳細不明)");
				}
				const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
				const composed: TodosStructuredContent = {
					tasks: rsc?.tasks ?? [],
					view: rsc?.view,
					affected: structuredContent.affected,
					removed: structuredContent.removed,
				};
				applyStructuredContent(composed);
			} catch (e) {
				rebuildFromConfirmed();
				renderAll();
				showBanner(
					`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		}
	} else {
		// tasks が乗らない応答(旧サーバー等)への degrade: refresh で確定一覧を取り直す。
		try {
			await fetchLatest();
		} catch (e) {
			rebuildFromConfirmed();
			renderAll();
			showBanner(
				`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
				() => void retryFetch(),
			);
		}
	}
}

/**
 * A-2: create-todo 確定後、その仮行にキューされていた完了トグルの意図を実 id へ適用する。
 * 実 id は create 応答の affected(kind:"added")から取る(1回の create-todo 呼び出しの結果=1件)。
 * 望みが「完了」で、確定した実行がまだ未完了なら toggleTask を実 id 行に対して呼ぶ(= 通常の coalesce
 * 経路に合流する)。実 id を特定できない/既に望みの状態なら何もしない(best-effort)。
 */
function applyQueuedToggle(optimisticId: string, createSc: TodosStructuredContent | undefined): void {
	const desiredCompleted = pendingToggleIntents.get(optimisticId);
	pendingToggleIntents.delete(optimisticId);
	if (desiredCompleted !== true) return; // 未完了のまま = 仮行は元々未完了なので何もしない
	const realId = createSc?.affected?.find((a) => a.kind === "added")?.id;
	if (realId === undefined) return;
	const realRow = confirmedTasks?.find((t) => t.id === realId);
	if (realRow === undefined || realRow.completed === desiredCompleted) return;
	void toggleTask(realRow); // realRow.completed=false → 完了へトグル(desiredToggle/flush 経路に乗る)
}

/**
 * 削除の楽観適用(E-2 スライス⑤・deleteTask):
 *   1. optimisticDeletes に id を積み、その場で行を除去して再描画(楽観削除。becoming-gone の
 *      中間演出は省略 — 判断理由は optimisticDeletes の宣言コメント参照)。
 *   2. 裏で delete-todo を fire(calendarId は currentCalendarId を必ず渡す — バグ修正の監査対象)。
 *   3. 成功: 楽観を解除し、delete-todo 応答(tasks + removed ゴースト)を確定描画に使う
 *      (removed により becoming-gone がサーバー由来で1描画だけ自然に出る)。
 *      失敗: 楽観をロールバック(行を復活)+ エラーバナー(再試行=同 delete 再送)。
 * toggleTask と同じ in-flight 隔離 state(optimisticDeletes)で confirmedTasks を汚さない。
 */
async function deleteTask(task: TodoItem): Promise<void> {
	// 仮行(quick-add 未確定)はサーバー id が無いので削除できない(create 確定後に本物 id で操作)。
	if (isOptimisticId(task.id)) return;
	// 二重送信ガード。
	if (optimisticDeletes.has(task.id)) return;

	optimisticDeletes.add(task.id);
	// 【2026-07-16 §7.8 実装スコープ注記】startCommitting は T_hard(10s)警告 + degrade ガードの
	// ためだけに呼ぶ。delete は行を即座に一覧から除去する既存設計(このコメントの直後 rebuildFromConfirmed
	// が optimisticDeletes で filter)のため、削除には「committing 中のゴースト行」自体が存在しない —
	// ドクトリン表の「delete = ゴースト行 opacity pulse」は、この既存の「楽観削除は即消去(中間演出省略)」
	// 設計と両立しない(ゴーストを最初から出すには rebuildDisplay の削除経路の作り直しが要る)。
	// 本スライスは既存の楽観機構(optimisticDeletes 含む)を活かしたまま時間相を乗せる範囲に留める
	// 判断をしたため、delete の committing アニメは実装していない(親レビューへの申し送り事項)。
	startCommitting(task.id); // maybeRefetch の抑止 + 差分レンズの degrade ガードに乗せる
	// 消す行が選択中/シート表示中/スワイプ露出中なら、その状態も畳む(消えた行の UI が宙に浮かないように)。
	if (selectedId === task.id) selectedId = null;
	if (swipeId === task.id) swipeId = null;
	if (sheetState?.id === task.id) closeSheet();
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	liveEl.textContent = `「${task.title}」を削除しました`; // aria-live(視覚の行除去と対の音声版)

	try {
		// calendarId は必ず渡す(2026-07-14 実機バグ修正の監査対象。null のときだけ省略)。
		const deleteArgs: Record<string, unknown> = { id: task.id };
		if (currentCalendarId !== null) deleteArgs.calendarId = currentCalendarId;
		// 【2026-07-17 TZ グラウンディング】delete 応答も確定一覧(残った行)を組み直すので、
		// 一覧の時刻付き DUE が UTC 落ちしないよう閲覧デバイスのゾーンを常時送る(refreshArgs と対称)。
		deleteArgs.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const result = await app.callServerTool({ name: "delete-todo", arguments: deleteArgs });
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功 → 楽観削除を解除してから確定 vm を適用する(解除前に applyStructuredContent すると
		// rebuildDisplay が「もう確定一覧に居ない行」を optimisticDeletes で二度引きしようとするだけで
		// 無害だが、意味を明確にするため先に落とす)。
		optimisticDeletes.delete(task.id);
		pendingIds.delete(task.id);
		const structuredContent = result.structuredContent as TodosStructuredContent | undefined;
		if (structuredContent?.tasks !== undefined) {
			if (isDefaultView(currentView)) {
				// 既定ビュー: mutate 応答 tasks(未完了ビュー固定)は currentView と一致 → そのまま適用。
				// removed ゴーストが becoming-gone を1描画だけ描く(サーバー由来の静的マーキング)。
				applyStructuredContent(structuredContent);
			} else {
				// 非既定ビュー: tasks は refresh-todos(currentView + calendarId 付き)で取り直し、
				// delete 応答の removed(ゴースト)だけ合成する(toggleTask の非既定経路と同型)。
				try {
					const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
					if (refreshed.isError) {
						const first = refreshed.content?.[0];
						const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
						throw new Error(text);
					}
					const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
					const composed: TodosStructuredContent = {
						tasks: rsc?.tasks ?? [],
						calendarId: rsc?.calendarId,
						view: rsc?.view,
						removed: structuredContent.removed,
					};
					applyStructuredContent(composed);
				} catch (e) {
					// 削除自体は成功。行は既に消えている(optimisticDeletes 解除後も confirmedTasks から
					// 抜けている)ので操作結果は失わない。「再読み込み失敗」として degrade。
					rebuildFromConfirmed();
					renderAll();
					showBanner(
						`削除は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
						() => void retryFetch(),
					);
				}
			}
		} else {
			// tasks が乗らない応答(旧サーバー等)への degrade: refresh で確定一覧を取り直す。
			try {
				await fetchLatest();
			} catch (e) {
				rebuildFromConfirmed();
				renderAll();
				showBanner(
					`削除は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		}
	} catch (e) {
		// delete-todo 自体の失敗(transport / isError)→ 楽観削除をロールバックして行を復活させる。
		optimisticDeletes.delete(task.id);
		pendingIds.delete(task.id);
		rebuildFromConfirmed();
		renderAll();
		showBanner(
			`「${task.title}」の削除に失敗しました`,
			() => void deleteTask(task), // 再試行 = 同じ削除を再送(二重削除は先頭の optimisticDeletes ガードが守る)
		);
	}
}

/** 詳細編集の保存(インライン選択の commit・詳細シートの ✓)で update-todo へ渡す「変更フィールドだけ」の
 *  集合(部分更新)。ここに入れたキーだけ送る(未指定=変更しない、が update-todo の契約)。
 *  【v2 で recurrence を追加 / B(> 2026-07-17)で location を全廃】旧・詳細展開フォームは status/recurrence を
 *  対象外にしていたが v2 の詳細セミモーダルは繰り返しを編集できる。場所(LOCATION)は当初 v2 で編集対象だったが、
 *  裁定(場所 = 位置通知 = proximityAlarm の read のみ)で編集導線・引数ともに全廃した(下記 location フィールド削除)。 */
interface UpdateTodoChanges {
	title?: string;
	// due: "YYYY-MM-DD"(終日)/ "YYYY-MM-DDTHH:MM:SS"(時刻付き)/ null(期日を外す)。
	due?: string | null;
	priority?: number; // 0/1/5/9(代表値。0=未設定に戻す)
	notes?: string; // "" でメモをクリア
	// (B: location フィールドは全廃 — 自由テキスト場所の編集を撤去し server の updateTodoInputShape からも削除)。
	// 繰り返し(RRULE)。"none"=除去・全置換・due 必須(update-todo の recurrence 契約)。custom は送らない。
	recurrence?: RecurArgs;
}

/**
 * 詳細編集の保存(E-2 スライス⑥前半・仕様B。toggleTask / deleteTask と同じ楽観更新の骨格):
 *   1. 変更フィールドを optimisticEdits に積み、その場で行に即反映(値だけ差し替え。becoming-edit の
 *      インライン旧→新はサーバー応答の changes に任せる=楽観段階では装飾を付けない。仕様B-2)。
 *      展開は閉じる(編集後の行の変化を一覧上で確認できるように。開いたままだと自分の入力欄が
 *      再描画で初期値に戻って見え、保存されたのか紛らわしい)。
 *   2. 裏で update-todo を fire(変更フィールドだけ + calendarId は必ず currentCalendarId。仕様B-4)。
 *   3. 成功: 楽観を解除し、確定 vm を適用(既定ビューはそのまま / 非既定ビューは refresh 合成 —
 *      toggleTask と同型。mutate 応答の affected:edited が becoming-edit のインライン旧→新を描く)。
 *      失敗: 楽観をロールバック(元値へ戻す)+ エラーバナー(再試行=同じ保存を再送)。
 * changes が空(実質何も変えていない)なら何もしない(無駄な PUT を投げない)。
 */
async function saveEdit(task: TodoItem, changes: UpdateTodoChanges): Promise<void> {
	// 仮行(create 未確定)はサーバー id が無いので編集できない(呼び出し側でも無効化済みだが二重ガード)。
	if (isOptimisticId(task.id)) return;
	// 変更が1つも無ければ何もしない(ユーザーの「保存/確定」意図に沿う静かな no-op)。
	if (Object.keys(changes).length === 0) return;
	// 二重送信ガード(in-flight の同一行は弾く)。
	if (pendingIds.has(task.id)) return;

	// 楽観上書きを組み立てる。due は3値(V6 フォローアップ):
	//   null=期日を外す(overrides.due=null, isAllDay=false)/ 時刻付き(T を含む)/ 終日。
	const overrides: OptimisticEdit = {};
	if (changes.title !== undefined) overrides.title = changes.title;
	if (changes.due !== undefined) {
		if (changes.due === null) {
			overrides.due = null;
			overrides.isAllDay = false;
		} else {
			overrides.due = changes.due;
			overrides.isAllDay = !changes.due.includes("T"); // 時刻付き("...T...")なら終日でない。
		}
	}
	if (changes.priority !== undefined) overrides.priority = changes.priority;
	if (changes.notes !== undefined) overrides.notes = changes.notes === "" ? null : changes.notes;
	// v2 追加: 繰り返しの楽観上書き。recurrence は RecurArgs → TodoRecurrence 形へ変換して重ねる
	// ("none"=繰り返し除去=null)。表示(一覧の ⟳ バッジ・シート再オープン時の初期値)へ即反映する。
	// (B: location の楽観上書きは全廃 — カード UI から場所を編集しないため)。
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

	optimisticEdits.set(task.id, overrides);
	startCommitting(task.id);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();

	try {
		// calendarId は必ず currentCalendarId を渡す(仕様B-4・先日のバグ再発防止)。null(初回応答前)の
		// ときだけ省略して server 既定に委ねる。変更フィールドだけを載せる(undefined は送らない=部分更新)。
		const updateArgs: Record<string, unknown> = { id: task.id };
		if (currentCalendarId !== null) updateArgs.calendarId = currentCalendarId;
		// timeZone は常時送る(件3 TZ グラウンディング 2026-07-17): 2つの役割を兼ねる —
		//  ① 時刻付き due を送るとき DTSTART;TZID/DUE;TZID + VTIMEZONE の解釈ゾーン(下の due 分岐で必須)、
		//  ② update-todo 応答 vm.timeZone の表示ゾーン(「時間帯」行が UTC に落ちないための grounding)。
		// due を変えない編集(タイトルだけ等)でも ② のために送る。update-todo UC は due が渡された
		// ときだけ DUE を patch するので、timeZone 単独送信で DUE を意図せず書き換えることはない
		// (=due 無しでも安全)。refreshArgs / toggle / delete / move と同じく Intl が唯一の真実。
		updateArgs.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (changes.title !== undefined) updateArgs.title = changes.title;
		if (changes.due !== undefined) {
			// null(除去)/ 終日 / 時刻付き をそのまま送る(update-todo の due は三値。V6 フォローアップ)。
			// 時刻付きの TZID 解釈は上で常時送っている updateArgs.timeZone が担う。
			updateArgs.due = changes.due;
		}
		if (changes.priority !== undefined) updateArgs.priority = changes.priority;
		if (changes.notes !== undefined) updateArgs.notes = changes.notes;
		// v2 追加: 繰り返し(RecurArgs をそのまま。"none"=除去・全置換・due 必須)。
		// 時刻付き until を含む recurrence でも until は date-only 文字列なので timeZone は不要(due の
		// 時刻付き分岐で既に timeZone を添えている。recurrence の DTSTART/DUE はサーバーが due から組む)。
		// (B: location 引数は全廃 — server の updateTodoInputShape からも削除済み。カード UI は場所を書かない)。
		if (changes.recurrence !== undefined) updateArgs.recurrence = changes.recurrence;
		const result = await app.callServerTool({ name: "update-todo", arguments: updateArgs });
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功 → 楽観を解除してから確定 vm を適用(解除前だと rebuildDisplay が二重に重ねる)。
		optimisticEdits.delete(task.id);
		pendingIds.delete(task.id);
		const structuredContent = result.structuredContent as TodosStructuredContent | undefined;
		if (structuredContent?.tasks !== undefined) {
			if (isDefaultView(currentView)) {
				// 既定ビュー: mutate 応答 tasks は currentView と整合 → そのまま適用(affected:edited が旧→新を描く)。
				applyStructuredContent(structuredContent);
			} else {
				// 非既定ビュー: tasks は refresh-todos(currentView+calendarId 付き)で取り直し、
				// mutate 応答の becoming メタ(affected/removed)だけ合成する(toggleTask の非既定経路と同型)。
				try {
					const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
					if (refreshed.isError) {
						const first = refreshed.content?.[0];
						const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
						throw new Error(text);
					}
					const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
					const composed: TodosStructuredContent = {
						tasks: rsc?.tasks ?? [],
						calendarId: rsc?.calendarId,
						view: rsc?.view,
						affected: structuredContent.affected,
						removed: structuredContent.removed,
					};
					applyStructuredContent(composed);
				} catch (e) {
					// 更新自体は成功。楽観は解除済みなので次の focus refetch がビューを正す。「再読み込み失敗」告知。
					rebuildFromConfirmed();
					renderAll();
					showBanner(
						`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
						() => void retryFetch(),
					);
				}
			}
		} else {
			// tasks が乗らない応答(旧サーバー等)への degrade: refresh で確定一覧を取り直す。
			try {
				await fetchLatest();
			} catch (e) {
				rebuildFromConfirmed();
				renderAll();
				showBanner(
					`更新は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		}
	} catch (e) {
		// update-todo 自体の失敗(transport / isError)→ 楽観編集をロールバック(元値へ戻す)。
		optimisticEdits.delete(task.id);
		pendingIds.delete(task.id);
		rebuildFromConfirmed();
		renderAll();
		showBanner(
			`「${task.title}」の変更を保存できませんでした`,
			() => void saveEdit(task, changes), // 再試行 = 同じ変更を再送(二重送信は先頭の pendingIds ガードが守る)
		);
	}
}

// --- quick-add(E-2 スライス③ + 2026-07-14 楽観更新ドクトリン)-------------------------
// フォーム送信(追加ボタン / Enter)で create-todo を叩く。楽観更新へ転換したので:
//   送信即 → 入力をクリアして入力可能のまま維持し、仮タスク(id は "optimistic:<乱数>")を
//   期日なしセクションへ即挿入(becoming-added を即時に乗せる)→ 裏で create-todo を fire。
//   成功: 仮行を除去し確定 vm を適用(仮 id 行が消え、サーバー採番の実行が同位置に現れる)。
//   失敗: 仮行を除去 + 入力欄にタイトルを復元 + バナー告知(再試行=同 mutation 再送)。
// 複数連続投入(仮行が複数)も成立する — 各投入が独立した optimisticRows 要素と in-flight fire。
// 二重送信ロック(旧 quickAddBusy / disabled)は廃止した(連続投入を許すため)。仮行は id が
// 一意なので取り違えない。in-flight 中に確定 vm が届いても rebuildDisplay が残りの仮行を
// 重ね直すので消えない(一貫性の要)。
// 【役割分担】quick-add はタイトルのみ。due/優先度/メモ/反復はチャット(LLM の create-todo)の領分。

/** 新規作成の詳細フィールド。ドラフト行のインライン確定(高速パス)は due=null / priority=0 / notes=""
 *  で呼ばれ、作成モード詳細ページ(collectCreateDetails)は期日/優先度/メモ/繰り返しを載せる。
 *  recurrence は作成モード詳細でのみ付く(undefined=送らない。仮行の楽観表示には出さないが、
 *  create-todo には送られ、確定 vm が正しい値を返す)。(B: location は全廃)。 */
interface QuickAddDetails {
	due: { due: string; isAllDay: boolean } | null;
	priority: number;
	notes: string;
	// (B: location フィールドは全廃 — 作成カード UI から自由テキスト場所を送らない。server shape からも削除)。
	// 繰り返し(RRULE)。作成モード詳細で「しない/カスタム」以外を選んだときだけ入る(frequency は "none" 以外)。
	recurrence?: RecurArgs;
}

/** 作成モード詳細ページの SheetDraft → QuickAddDetails(create-todo の全フィールド)。
 *  due は3値ではなく「終日 / 時刻付き / なし」の2 union(create-todo は due 除去の概念が無く、
 *  無ければ省略)。recurrence は「しない/カスタム」と due 無しのときは送らない(RRULE は due 必須)。 */
function collectCreateDetails(d: SheetDraft): QuickAddDetails {
	const due = d.hasDate ? { due: d.hasTime ? `${d.dateVal}T${d.timeVal}:00` : d.dateVal, isAllDay: !d.hasTime } : null;
	let recurrence: RecurArgs | undefined;
	if (d.recurPreset !== "none" && d.recurPreset !== "custom" && d.hasDate) {
		const args = presetToArgs(d.recurPreset, d.weekdays);
		// presetToArgs は none/custom で null。ここまで来れば frequency は必ず "none" 以外だが、型の絞り込みで確認する。
		if (args !== null && args.frequency !== "none") {
			if (d.recurEnd === "until" && d.until != null) args.until = d.until;
			recurrence = args;
		}
	}
	return {
		due,
		priority: d.priority,
		notes: d.notes.trim(),
		recurrence, // B: location は載せない
	};
}

/** 仮行を1つ積んで即描画し、裏で create-todo を fire する(送信・再試行の共通経路)。 */
function enqueueQuickAdd(title: string, details: QuickAddDetails): void {
	// 仮 id は乱数で一意化(複数連続投入で衝突しないように)。差分レンズは optimistic: prefix で除外。
	const optimisticId = `optimistic:${Math.random().toString(36).slice(2)}`;
	// 仮行にも due/priority/notes を反映(セクション配置は due に従う=期日を付けた追加は該当セクションへ)。
	optimisticRows.push({
		id: optimisticId,
		title,
		due: details.due?.due ?? null,
		isAllDay: details.due?.isAllDay ?? false,
		priority: details.priority,
		notes: details.notes === "" ? null : details.notes,
	});
	// 【2026-07-16 §7.8】add は元々 pendingIds を使っていなかった(仮行の存在=optimisticRows 自体が
	// in-flight の目印だったため)。committing の寿命判定(wake-sweep を 1.2s で止める)には startedAt
	// が要るので、ここで初めて optimisticId を pendingIds にも積む(二重送信ガードとしては使わない —
	// 仮行は quick-add ごとに新しい乱数 id なので連打ガードの対象外。用途は committing 寿命だけ)。
	startCommitting(optimisticId);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	announceBecoming(); // 「〜を追加しました」を aria-live へ即時通知
	void createTodoFor(optimisticId, title, details);
}

/** 仮行 optimisticId に対応する create-todo を裏で実行し、成功/失敗で仮行を回収する。 */
async function createTodoFor(optimisticId: string, title: string, details: QuickAddDetails): Promise<void> {
	try {
		// calendarId は今表示中のコレクション(currentCalendarId)に作る。未受領(null)なら引数を
		// 省いて server 既定("tasks")に委ねる(ヘッダがプレースホルダ表示中に投入された場合の安全側)。
		const args: Record<string, unknown> = { title };
		if (currentCalendarId !== null) args.calendarId = currentCalendarId;
		// 段階的開示の詳細を create-todo の due 判別 union の形に正確に合わせる(仕様A-3):
		//   due が終日 → "YYYY-MM-DD"(timeZone 不要) / 時刻付き → "YYYY-MM-DDTHH:MM:SS" + timeZone。
		//   timeZone は閲覧デバイスの IANA ゾーン(create-todo は時刻付き due に timeZone 必須)。
		if (details.due !== null) {
			args.due = details.due.due;
			if (!details.due.isAllDay) args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		}
		// priority は 0(なし)なら送らない(省略=未設定)。1/5/9 のときだけ載せる。
		if (details.priority > 0) args.priority = details.priority;
		if (details.notes !== "") args.notes = details.notes;
		// (B: location 引数は全廃 — create-todo の自由テキスト場所は送らない。server の createTodoInputShape からも削除)。
		// 繰り返し(作成モード詳細でのみ付く)。frequency は "none" 以外(collectCreateDetails が保証)。
		if (details.recurrence !== undefined) args.recurrence = details.recurrence;
		const result = await app.callServerTool({ name: "create-todo", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功: まず仮行を除去(除去前に applyStructuredContent すると仮行+実行の二重表示になる)。
		removeOptimisticRow(optimisticId);
		pendingIds.delete(optimisticId);
		const structuredContent = result.structuredContent as TodosStructuredContent | undefined;
		if (structuredContent?.tasks !== undefined && !isDefaultView(currentView)) {
			// 非既定ビュー: mutate 応答 tasks は未完了ビュー固定で currentView と矛盾しうるので、
			// tasks は refresh-todos(currentView 付き)で取り直し、becoming(affected:added)だけ合成する。
			try {
				const refreshed = await app.callServerTool({ name: "refresh-todos", arguments: refreshArgs() });
				if (refreshed.isError) {
					const first = refreshed.content?.[0];
					const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
					throw new Error(text);
				}
				const rsc = refreshed.structuredContent as TodosStructuredContent | undefined;
				const composed: TodosStructuredContent = {
					tasks: rsc?.tasks ?? [],
					calendarId: rsc?.calendarId,
					view: rsc?.view,
					affected: structuredContent.affected,
					removed: structuredContent.removed,
				};
				applyStructuredContent(composed);
			} catch (e) {
				// 追加自体は成功しているので操作結果は失わない(仮行は除去済み)。「再読み込み失敗」
				// として degrade(再試行 = fetchLatest のみ。create-todo は再送しない = 二重追加を避ける)。
				rebuildFromConfirmed();
				renderAll();
				showBanner(
					`追加は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		} else if (structuredContent?.tasks !== undefined) {
			// 既定ビュー: mutate 応答 vm をそのまま確定描画(affected:added が becoming-in を描く)。
			// rebuildDisplay が他の in-flight 仮行を重ね直すので、同時投入した別の仮行は消えない。
			applyStructuredContent(structuredContent);
		} else {
			// tasks が乗らない応答(旧サーバー等)への degrade: refresh で確定一覧を取り直す。
			try {
				await fetchLatest();
			} catch (e) {
				rebuildFromConfirmed();
				renderAll();
				showBanner(
					`追加は送信されましたが再読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
					() => void retryFetch(),
				);
			}
		}
		// A-2: この仮行に完了タップの意図がキューされていれば、確定した実 id へ適用する
		// (create 応答 structuredContent.affected の added id を実 id として使う)。
		applyQueuedToggle(optimisticId, structuredContent);
	} catch (e) {
		// create-todo 自体の失敗(transport / isError)→ 仮行を除去してロールバックする。
		removeOptimisticRow(optimisticId);
		pendingIds.delete(optimisticId);
		// A-2: create 失敗ならキューした完了意図も破棄する(適用先の実 id が生まれないため)。
		pendingToggleIntents.delete(optimisticId);
		rebuildFromConfirmed();
		renderAll();
		// 【v3】旧・quick-add 入力欄へのタイトル復元は廃止(入力欄自体が無くなった)。追加失敗は稀で、
		// バナーの「再試行」が同じ details(タイトル+全フィールド)で再送するのでそちらで救う。
		showBanner(
			`「${title}」の追加に失敗しました`,
			() => enqueueQuickAdd(title, details), // 再試行 = 同じ仮行(詳細込み)を積み直して再送
		);
	}
}

// --- + 追加 = 一覧末尾にドラフト行を生やす(v3。旧 quick-add ボトムシートを置換)-------------------
// 【v2→v3 で覆した点(経緯・財産)】v2 は FAB タップで position:fixed の quick-add ボトムシート
// (#quick-add フォーム + 段階的開示パネル + createDueField/createPrioritySegment の部品組み立て +
// submitQuickAdd/openQuickAddSheet/closeQuickAddSheet + 外側タップ閉じ + IME ガード)を開いていた。
// しかし詳細シートと同じ fixed+vh の実機バグ(内部スクロール不能・下部見切れ)を quick-add シートも
// 抱えており、かつ「シートを開く」より「行末に空行が生えて即入力」の方が iOS のトーンに合う、という
// ユーザー確定で全廃した。FAB は「新規ドラフト行を選択状態で生やす」トリガーに変え、確定/連続投入/
// 詳細編集は選択モデル(startDraft / commitSelection / commitDraftEnter / openCreateSheet)に載せた。
// 共通部品ファクトリ(createDueField/createPrioritySegment)も併せて削除した(詳細ページは素の DOM で
// 組む方針にしたため未使用になった。経緯は入力フォーム部品セクションのコメント参照)。
//
// 【2026-07-18 ユーザー裁定: 浮遊 FAB(#quick-add-fab)を廃止し action-row の ⊕ へ統合】
// 追加トリガーの入口が「浮遊 FAB」1箇所から「fullscreen の浮遊 FAB」+「inline の action-row ⊕」の
// 2箇所に増えたため、押下時のロジック(選択確定→折り畳み中なら fullscreen 昇格→startDraft)を
// triggerQuickAdd() へ抽出し、両方の入口(quickAddFab のクリックハンドラ・buildActionRow の
// action-add ボタン)から呼ぶ(最小破壊: startDraft/commitSelection 自体は無改造)。
function triggerQuickAdd(): void {
	// 既存の選択(別行編集 or 別ドラフト)は先に確定してから新しい空ドラフト行を生やす。
	commitSelection();
	draft = null;
	selectedId = null;

	// 【折り畳み中の追加は fullscreen へ昇格してから(2026-07-17 実機FB・ユーザー提案)】
	// inline プレビューは上位 N 件だけを見せる truncate なので、畳んだ状態で新規行を足すと
	// (1) 新規行が top-N の窓の外にソートされてフッタ「他 N件」の下に出る不自然さ、
	// (2) 追加確定後にその行が畳みに飲まれて見えなくなる、という2つの破綻が起きる(実機FB)。
	// 並び順やピン留めで inline のまま辻褄を合わせるより、「全件表示+スクロールできる fullscreen へ
	// 上げてから追加する」方が単純で自然(iOS リマインダーでも新規追加は全件の見える文脈で行う)。
	// 昇格が受理されたら applyHostContext で hostDisplayMode を更新してから startDraft する
	// (applyInlineFold は inline でなくなり畳まないので、新規行が全件の末尾に見えたまま残る)。
	// 昇格不可(ホストが fullscreen 非対応=canRequestFullscreen false)や拒否/失敗のときは inline の
	// まま追加へフォールバックする(この経路でも draft 行は section 外の ul なので畳み対象外=消えはしない。
	// フッタとの上下は fullscreen 非対応ホストでのみ残る軽微な既知事項)。
	if (lastFoldActive && canRequestFullscreen(hostAvailableDisplayModes)) {
		app
			.requestDisplayMode({ mode: "fullscreen" })
			.then(() => {
				applyHostContext(); // 昇格結果(displayMode=fullscreen)を反映してから
				startDraft(450); //      畳まれない全件表示の末尾にドラフトを生やす(focus はズーム遷移後・関数コメント参照)
			})
			.catch(() => startDraft()); // 拒否/失敗は inline のまま追加(フォールバック)
	} else {
		startDraft();
	}
}
quickAddFab.addEventListener("click", (e) => {
	// FAB クリックは下の document click(選択解除)へ伝播させない(伝播すると生やした直後の
	// 空ドラフトが「選択外タップ」と誤判定されて即消える)。
	e.stopPropagation();
	triggerQuickAdd();
});

// --- ヘッダ Done(S-E: 旧・行内 confirm の撤去先)---------------------------------------------
// 旧 button.confirm(renderRow)の click ハンドラをそのまま移設: commitSelection → draft/selectedId
// クリア → renderAll(選択行外タップと同じ確定経路)。stopPropagation は不要(document click の
// deselect ロジックは「selectedId !== null && rowId !== selectedId」のときだけ動くが、ここで既に
// selectedId=null にするので二重 commit にはならない — quickAddFab と同様に安全)。
headerDoneEl.addEventListener("click", () => {
	commitSelection();
	draft = null;
	selectedId = null;
	renderAll();
});

// --- グローバルクリック: 選択解除(確定)/ スワイプ露出畳み --------------------------------------
// 一覧の外側(空白・別領域)をタップしたときの後始末を1本に集約する。行の head/circle/ⓘ 自身の
// クリックはそれぞれのハンドラで先に処理され、ここは「その外」を担う(iOS の編集外タップに相当)。
// 【v2→v3】menu-pop(ポップオーバー)は廃止したので外側タップでの closeMenu は不要になり削除。
// #sheet-root も廃止(詳細ページは #root に描くので sheetState 表示中はこのハンドラを丸ごと skip)。
// 【順序の噛み合い】別行の head をタップした選択切替では、head の setSelected が先に走って selectedId が
// 新 id になり renderAll 済み。ここに来た時点で closest("li[data-id]") は(detached でも)クリックした
// 行の li を返し data-id === 新 selectedId なので二重 commit しない。空白タップだけが commit+解除に至る。
document.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	// 詳細/リスト選択ページ表示中は、そのページ内のクリックを一覧の選択/スワイプ処理に巻き込まない。
	if (sheetState !== null) return;
	const row = target.closest("li[data-id]") as HTMLElement | null;
	const rowId = row?.dataset.id ?? null;
	// 選択解除=確定(auto-save): 選択行の外をタップしたら commit して選択を外す。ドラフト行なら
	// commit で create(タイトル非空時)/空破棄し、draft も落とす。
	if (selectedId !== null && rowId !== selectedId) {
		commitSelection();
		draft = null;
		selectedId = null;
		renderAll();
	}
	// スワイプ露出行の外をタップしたら畳む(削除ボタン自身は stopPropagation 済みで別扱い)。
	if (swipeId !== null && rowId !== swipeId) {
		swipeId = null;
		renderAll();
	}
});

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
