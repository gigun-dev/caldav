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
// E-2 スライス③: 対象リスト名の見出し + quick-add(タイトル1行追加)の静的要素。
// いずれも #root の外(常時ある操作面)なので描画の破壊的更新に巻き込まれない。
const appTitleEl = document.getElementById("app-title") as HTMLElement;
const quickAddForm = document.getElementById("quick-add") as HTMLFormElement;
const quickAddInput = document.getElementById("quick-add-input") as HTMLInputElement;
// 追加ボタン(#quick-add-btn)への参照は廃止した(2026-07-14 楽観更新)。旧実装は送信中に
// btn.disabled で二重送信を防いだが、楽観更新では送信中もボタンを押せるまま維持する
// (連続投入を許す)ので JS から触る必要が無い。送信は form の submit ハンドラが拾う。

/** RRULE 要約(task-dto.ts の Task.recurrence と同型を写経)。frequency は通常 chat 語彙
 *  (daily/weekly/monthly/yearly)だが、degrade 時は生 RRULE / 生 FREQ が入りうる
 *  (task-dto.ts の degrade 方針参照)。UI の formatRecurrence がその degrade を吸収する。 */
interface TodoRecurrence {
	frequency: string;
	interval: number;
	weekdays: string[] | null;
	count: number | null;
	until: string | null;
}

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
// pendingIds = update-todo 送信中の行 id(in-flight の二重送信ガード)。2026-07-14 ドクトリン
// 改訂で「見た目のブロック(disabled/スピナー)」の用途は廃止 — 純粋に「同じ行の連打を弾く」
// ガード + 差分レンズの degrade(pending 行はシステム差分マークの対象外)にだけ使う。
const pendingIds = new Set<string>();
let completedOpen = false; // 完了済み <details> の開閉。再描画で閉じ戻らないよう保持する
// --- 楽観更新の in-flight state(2026-07-14 ドクトリン改訂)---------------------------
// optimisticToggle: update-todo 送信中のトグルの「楽観的な完了状態」。id → {completed,status}。
//   rebuildDisplay が confirmedTasks の該当行にこれを重ね、becoming(completed/reopened)も付ける。
//   成功/失敗のどちらでもこの Map から delete する(成功=確定 vm が真実に、失敗=元へ戻す)。
const optimisticToggle = new Map<string, { completed: boolean; status: string | null }>();
// optimisticRows: quick-add 送信中の仮タスク(id は "optimistic:<乱数>")。create-todo が
//   採番する実 id が確定するまでの表示用。rebuildDisplay が confirmedTasks の末尾に重ね、
//   becoming-in(追加)を付ける。成功時に該当仮行を除去してから確定 vm を適用する。
interface OptimisticRow {
	id: string;
	title: string;
}
let optimisticRows: OptimisticRow[] = [];
/** 仮行 id 判定(differ から除外・トグル禁止に使う)。 */
function isOptimisticId(id: string): boolean {
	return id.startsWith("optimistic:");
}
// expandedId(E-2 スライス⑤): 詳細を開いている行の id。単一値なので「同時に開くのは1行だけ」
// (別の行を開くと前の行は自動で閉じる)が状態設計だけで満たされる。再描画(refetch/mutation)を
// 跨いで展開を保持する(completedOpen と同じ発想 — 見ていた展開が勝手に閉じるのを防ぐ)。null=全閉。
let expandedId: string | null = null;
// optimisticDeletes(E-2 スライス⑤・楽観削除): delete-todo 送信中の行 id。rebuildDisplay が
// 表示から即除去する(楽観適用)。成功で確定 vm に置き換わり、失敗でこの Set から抜いて行が復活する。
// 【becoming-gone を1描画見せてから消す演出は省略した(判断)】仕様が許容する省略。楽観削除で
// ghost(破線+畳み)を出すには「行を消す前に snapshot を ghost として1フレーム描き、次の描画で
// 除去」という2段階のタイマー/フレーム管理が要り、ステートレス&アニメ無しのドクトリンと相性が悪い
// (中間フレームをどれだけ見せるかは実質アニメの尺調整になる)。代わりに、サーバー確定後の
// delete-todo 応答が removed(ghost)を載せてくるので、成功時に applyStructuredContent 経由で
// becoming-gone が1描画だけ自然に出る(サーバー由来の静的マーキングに委ねる方がドクトリンと一貫)。
const optimisticDeletes = new Set<string>();
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
}
/** 位置記憶に無い新規行の自然セクション(due/completed 規則)。sectionize の per-item ロジックと
 *  揃える(becoming-done の in-place は位置記憶が担うのでここでは completed→"completed" で素直に)。 */
function naturalSection(task: TodoItem, todayKey: string): SectionKey {
	if (task.completed) return "completed";
	if (task.due === null) return "noDue";
	const diff = dayDiff(wallDatePart(task.due), todayKey);
	if (diff < 0) return "overdue";
	if (diff === 0) return "today";
	return "upcoming";
}
// currentCalendarId(E-2 スライス③): この一覧が今どのコレクションを表示しているか。
// 応答の vm.calendarId(server の buildTodosViewModel は必ず載せる。省略時は "tasks")で更新し、
// ヘッダ見出しの表示と quick-add の作成先(create-todo の calendarId)に使う。null = 未受領。
let currentCalendarId: string | null = null;
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
// 繰り返し(RRULE 要約)の人間可読整形(E-2 スライス⑤)
// =============================================================================
// 【なぜ UI 側の純関数か】人間可読文への整形(「毎週 月・水」等)は表示層の仕事、という
// task-dto.ts の判断と対になる。DTO は chat 語彙(daily/weekly...)+ 構造化フィールドを
// ロスレスに渡し、UI が閲覧者の言語(日本語)へ整形する。整形ルールが変わっても DTO は不変。

/** BYDAY の weekday コード → 日本語1文字。序数付き("2MO" 等)はここに無い = degrade シグナル。 */
const WEEKDAY_JA: Record<string, string> = { SU: "日", MO: "月", TU: "火", WE: "水", TH: "木", FR: "金", SA: "土" };
/** frequency(chat 語彙)→ 「毎日/毎週/毎月/毎年」。語彙外(生 RRULE/生 FREQ)はここに無い。 */
const RECUR_EVERY: Record<string, string> = { daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年" };
/** interval>1 のときの単位。「2週ごと」の「週」等。monthly は「か月」。 */
const RECUR_UNIT: Record<string, string> = { daily: "日", weekly: "週", monthly: "か月", yearly: "年" };

/**
 * 繰り返しバッジのテキスト部分(⟳ アイコンは呼び出し側が前置する)を返す。
 * 返り値 "" = アイコンのみに degrade(テキストは出さない)。仕様(E-2 スライス⑤):
 *   - daily → 毎日 / weekly+weekdays → 毎週 月・水 / monthly → 毎月 / yearly → 毎年
 *   - interval>1 → 「2週ごと」等(単位は RECUR_UNIT)
 *   - 語彙外 frequency(生 RRULE / 生 FREQ degrade)→ "" (アイコンのみ)
 *   - 序数付き BYDAY("2MO" 等・月/週の複雑形)→ "" (アイコンのみ)
 * 【なぜ複雑形をアイコンのみに degrade するか】序数付き BYDAY や語彙外 FREQ を無理に日本語化
 * すると誤訳(「第2月曜」を「月」と誤読)や語彙のでっち上げになる。バッジは「反復がある」ことを
 * ⟳ で最小限に示し、詳細(完全表記)は formatRecurrenceFull と展開 UI に委ねる安全側 degrade。
 */
function formatRecurrence(rec: TodoRecurrence): string {
	// 語彙外 frequency(task-dto.ts の degrade ケース1/2: 生 RRULE 全体 or 生 FREQ)→ アイコンのみ。
	if (!(rec.frequency in RECUR_EVERY)) return "";
	// 序数付き BYDAY(例 "2MO")が1つでも混ざる = 月/週の複雑形 → アイコンのみに degrade。
	if (rec.weekdays !== null && rec.weekdays.some((w) => !(w in WEEKDAY_JA))) return "";
	// INTERVAL>1 は曜日より先に「N単位ごと」で丸める(バッジは短さ優先。完全表記は展開 UI が担う)。
	if (rec.interval > 1) {
		return `${rec.interval}${RECUR_UNIT[rec.frequency] ?? ""}ごと`;
	}
	// weekly + 曜日指定 → 「毎週 月・水」。曜日は WEEKDAY_JA 順ではなく RRULE の並び順を尊重する。
	if (rec.frequency === "weekly" && rec.weekdays !== null && rec.weekdays.length > 0) {
		const days = rec.weekdays.map((w) => WEEKDAY_JA[w]).join("・");
		return `${RECUR_EVERY[rec.frequency]} ${days}`;
	}
	return RECUR_EVERY[rec.frequency] ?? "";
}

/** until("YYYY-MM-DD" or offset ISO)→ 表示用日付(時刻付きなら " HH:MM" を添える)。
 *  完全表記の終了条件「〜まで」に使う。相対化(今日/明日)はしない — 遠い未来の終了日が
 *  多く、絶対日付の方が確認しやすい(バッジの due 相対表現とは役割が違う)。 */
function formatUntilDate(until: string): string {
	const datePart = until.slice(0, 10);
	const hasTime = until.includes("T");
	if (!hasTime) return datePart;
	const time = until.split("T")[1]?.slice(0, 5) ?? "";
	return time === "" ? datePart : `${datePart} ${time}`;
}

/**
 * 繰り返しの完全表記(詳細展開用)。終了条件(count/until)込みで1文にする。
 * 例: 「毎週 月・水・10回まで」「毎日・2026-07-31 まで」。
 * バッジがアイコンのみに degrade する複雑形(語彙外 FREQ・序数 BYDAY)では、基部を
 * 「繰り返し(生値)」にして情報を失わない(バッジは黙るが詳細は生値を見せる)。
 */
function formatRecurrenceFull(rec: TodoRecurrence): string {
	const badge = formatRecurrence(rec);
	// 基部: バッジが出せるならそれを使い、degrade なら生値を括弧付きで見せる(何も分からないより良い)。
	const base = badge !== "" ? badge : `繰り返し(${rec.frequency})`;
	const parts = [base];
	if (rec.count !== null) parts.push(`${rec.count}回まで`);
	if (rec.until !== null) parts.push(`${formatUntilDate(rec.until)} まで`);
	return parts.join("・");
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
	if (task.completed) li.classList.add("done");
	// 2026-07-14 ドクトリン改訂: pending でも見た目はブロックしない(li.pending クラス付与と
	// スピナー・disabled を廃止)。in-flight の間は既に楽観状態が塗られており(optimisticToggle)、
	// 二重送信は toggleTask 冒頭の pendingIds ガードで防ぐ。よって行/ボタンの見た目は通常のまま。

	// becoming 装飾の決定。未知 kind は何も足さない(通常描画へ degrade)。
	// 2026-07-14 楽観更新: in-flight のトグルは optimisticToggle 由来の becoming(completed/reopened)を
	// この affectedById 経由で受け取り、その場で塗り丸/破線に変わる(スピナーは無い)。
	const aff = affectedById.get(task.id);
	let tagText: string | null = null;
	let editPlan: EditPlan | null = null;
	if (aff !== undefined) {
		// sync(E-2 スライス④): システム起因の変化はラベルを中立の「同期(...)」にする。
		// form(左バー/リング/破線)は user 起因と同一語彙を使い、区別はラベルだけに集約する
		// (出所は断定しない・ユーザーの「追加/完了」ラベルと明確に区別、という設計)。
		const isSync = aff.sync === true;
		if (aff.kind === "completed") {
			li.classList.add("becoming-done");
			tagText = isSync ? "同期(完了)" : "完了";
		} else if (aff.kind === "reopened") {
			li.classList.add("becoming-undone");
			tagText = isSync ? "同期(再開)" : "再開";
		} else if (aff.kind === "added") {
			li.classList.add("becoming-in");
			tagText = isSync ? "同期(追加)" : "追加";
		} else if (aff.kind === "edited") {
			li.classList.add("becoming-edit");
			editPlan = planEdit(aff);
			// 編集はインライン差分(旧→新)の粒度ラベル(期日変更 等)を user 起因では使うが、
			// sync では出所不明の一括ラベル「同期(編集)」に丸める(何が変わったかは form と
			// meta の旧→新が語る。ラベルは「これは同期由来」の一言に徹する)。
			tagText = isSync ? "同期(編集)" : editPlan.tag;
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
	// disabled にはしない(見た目のブロックはしない方針)。in-flight の再タップは toggleTask 冒頭の
	// pendingIds ガードが無害に弾く。連続で複数件チェックを打てる体験も維持される。
	const circle = document.createElement("span");
	circle.className = "circle";
	circle.setAttribute("aria-hidden", "true");
	circle.textContent = "✓"; // 未完/pending 時は CSS が color:transparent で隠す
	check.appendChild(circle);
	check.addEventListener("click", () => void toggleTask(task));
	li.appendChild(check);

	const texts = document.createElement("div");
	texts.className = "texts";
	// row-head(E-2 スライス⑤): タイトル + meta を包むタップ開閉領域。詳細(削除ボタンを含む)は
	// この header の内側ではなく texts 直下の兄弟に置く — role="button" の中に <button> をネストすると
	// ARIA 違反(インタラクティブ入れ子)になるため、クリック領域は header に限定する。
	// チェック円(check button)は header の外(li 直下の別 flex 子)なので、円のタップは開閉と干渉しない。
	const isExpanded = expandedId === task.id;
	const header = document.createElement("div");
	header.className = "row-head";
	header.setAttribute("role", "button");
	header.setAttribute("tabindex", "0");
	header.setAttribute("aria-expanded", String(isExpanded));
	// 開閉トグル: 同時に開くのは1行だけ(expandedId は単一値なので別行を開くと前行は自動で閉じる)。
	const toggleExpand = (): void => {
		expandedId = isExpanded ? null : task.id;
		renderAll();
	};
	header.addEventListener("click", toggleExpand);
	// キーボード操作(role=button は Enter/Space での起動を自前で配線する必要がある)。
	header.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault(); // Space のページスクロール抑止 + Enter の暗黙送信抑止
			toggleExpand();
		}
	});
	const title = document.createElement("div");
	title.className = "title";
	// 優先度 ! 記号(E-2 スライス③): iOS リマインダーに合わせてタイトルの左に小さく置く。以前は
	// meta 行(2行目)に出していたが、iOS の語彙(タイトル前・オレンジ)へ寄せて title 先頭へ移した。
	// becoming-edit(優先度変更)のときは meta 行に旧→新の差分を出すので、ここでの常時表示は
	// 抑止する(差分は差分の言語で語る、という既存方針。二重表示を避ける)。
	const titlePriMarks = priorityMarks(task.priority);
	if (titlePriMarks !== "" && editPlan?.priChange == null) {
		const priInline = document.createElement("span");
		priInline.className = "pri-inline";
		priInline.textContent = titlePriMarks;
		// 記号だけだと支援技術に「!!!」と読まれて意味不明なのでラベルを添える(旧 meta 実装を踏襲)。
		priInline.setAttribute(
			"aria-label",
			titlePriMarks === "!!!" ? "優先度 高" : titlePriMarks === "!!" ? "優先度 中" : "優先度 低",
		);
		title.appendChild(priInline);
	}
	// タイトル本文はテキストノードで追加する(pri-inline span の後ろに置くため textContent 代入は使わない)。
	title.appendChild(document.createTextNode(task.title));
	// メモ有りインジケータ(E-2 スライス⑤): notes が非 null かつ非空なら控えめな「≡」をタイトル末尾に。
	// 中身は詳細展開で見せるので、一覧では「メモがある」ことだけを最小の記号で示す(iOS リマインダーの
	// サブタイトル行に相当する情報を、走査性を損なわないアイコン1つに畳む)。
	if (task.notes !== null && task.notes.trim() !== "") {
		const noteMark = document.createElement("span");
		noteMark.className = "note-mark";
		noteMark.textContent = "≡";
		noteMark.setAttribute("aria-label", "メモあり");
		title.appendChild(noteMark);
	}
	header.appendChild(title);

	// メタ行: due 相対表現(あるものだけ)。優先度の常時表示は title 先頭へ移した(上記)。notes は行内に出さない
	// (①の情報設計 — カード幅で notes まで出すと一覧の走査性が落ちる。展開 UI は②以降)。
	// becoming: edited のインライン差分があるフィールドは、通常表示の代わりに
	// 「旧(減光)→ 新(琥珀)」の凍結表示に差し替える(旧値に取消線は使わない —
	// 取消線=完了の恒久記号、の一貫性)。新値 = 行の現在値なので情報の重複はない。
	// 通常の優先度 ! は title 先頭へ移したので meta の描画条件からは外す(E-2 スライス③)。
	// meta に優先度が出るのは becoming-edit の旧→新差分(priChange)のときだけ = hasInline に含まれる。
	const dueInfo = formatDue(task, todayKey);
	const hasInline = editPlan !== null && (editPlan.dueChange !== null || editPlan.priChange !== null);
	const hasMore = editPlan !== null && editPlan.moreCount > 0;
	// 繰り返しバッジ(E-2 スライス⑤): recurrence があれば due の隣に「⟳ 毎週 月・水」等を出す。
	// 語彙外/複雑形はテキスト "" で ⟳ アイコンのみ(formatRecurrence 参照)。becoming-edit の
	// 期日差分表示中(dueChange インライン)は一過性の差分表示に専念させ、常時バッジは抑止する
	// (差分は差分の言語で語る、という meta 行の既存方針)。それ以外では常に出す。
	const hasRecur = task.recurrence !== null && editPlan?.dueChange == null;
	if (dueInfo.text !== "" || hasInline || hasMore || hasRecur) {
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
		// 繰り返しバッジ(E-2 スライス⑤)。due の後ろに置く(iOS リマインダーの並びに寄せる)。
		if (hasRecur && task.recurrence !== null) {
			const recurText = formatRecurrence(task.recurrence);
			const recur = document.createElement("span");
			recur.className = "recur";
			// テキスト "" のとき(語彙外/複雑形 degrade)は ⟳ アイコンのみ。テキストありは「⟳ 毎週 月・水」。
			recur.textContent = recurText === "" ? "⟳" : `⟳ ${recurText}`;
			recur.setAttribute("aria-label", recurText === "" ? "繰り返し" : `繰り返し ${recurText}`);
			meta.appendChild(recur);
		}
		header.appendChild(meta);
	}
	texts.appendChild(header);
	// 詳細展開(E-2 スライス⑤): 開いている行だけ header の下に詳細パネルを差し込む。開閉は
	// アニメ無し(ドクトリン)= 単に DOM の有無で表現する(再描画のたび作り直す一方向データフロー)。
	if (isExpanded) {
		texts.appendChild(renderDetail(task, todayKey));
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

/**
 * 詳細展開パネル(E-2 スライス⑤)。行の header タップで開き、行下にインライン表示する。
 * 内容: メモ全文(改行保持・長文はスクロール)/ 繰り返しの完全表記(終了条件込み)/ 場所 /
 * 完了時刻(完了済みのみ)/ 削除ボタン。存在する情報だけ出す(空の行は作らない)。
 * 削除ボタンは「展開内のみに配置=それ自体が確認段階」という設計(confirm ダイアログは出さない。
 * 一覧の行には出さず、意図的に一段深い場所に置くことで誤タップを防ぐ)。
 */
function renderDetail(task: TodoItem, _todayKey: string): HTMLElement {
	const detail = document.createElement("div");
	detail.className = "detail";

	// メモ全文。改行を保持(white-space: pre-wrap)し、長文は max-height + スクロールで畳む(CSS 側)。
	if (task.notes !== null && task.notes.trim() !== "") {
		const notes = document.createElement("div");
		notes.className = "detail-notes";
		notes.textContent = task.notes; // textContent = XSS 安全(HTML として解釈されない)
		detail.appendChild(notes);
	}

	/** ラベル付き1行(「繰り返し: 毎週 月・水」等)を作る小ヘルパー。 */
	const addRow = (label: string, value: string): void => {
		const row = document.createElement("div");
		row.className = "detail-row";
		const l = document.createElement("span");
		l.className = "detail-label";
		l.textContent = `${label}: `;
		row.appendChild(l);
		row.appendChild(document.createTextNode(value));
		detail.appendChild(row);
	};

	// 繰り返しの完全表記(終了条件込み)。バッジ(一覧行)より詳しい情報を出す唯一の場所。
	if (task.recurrence !== null) {
		addRow("繰り返し", formatRecurrenceFull(task.recurrence));
	}
	// 場所(LOCATION)。iOS のジオフェンス通知とは別物(task-dto.ts の location JSDoc 参照)だが、
	// 他クライアント/自前書き込みの LOCATION は素直に見せる。
	if (task.location !== null && task.location.trim() !== "") {
		addRow("場所", task.location);
	}
	// 完了時刻は完了済みのときだけ(未完了行に「完了: —」を出しても意味がない)。
	if (task.completed && task.completedAt !== null) {
		addRow("完了", formatCompletedAt(task.completedAt));
	}

	// 削除ボタン(赤系・展開内のみ)。header の外(兄弟)なので role=button の入れ子にはならない。
	const del = document.createElement("button");
	del.type = "button";
	del.className = "detail-delete";
	del.textContent = "削除";
	del.setAttribute("aria-label", `「${task.title}」を削除`);
	// 楽観削除(deleteTask)。仮行(create 未確定)は本物 id が無いので押せないようにする。
	if (isOptimisticId(task.id)) del.disabled = true;
	del.addEventListener("click", () => void deleteTask(task));
	detail.appendChild(del);

	return detail;
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
	// sync(E-2 スライス④): システム起因の外部削除は中立ラベル「同期(削除)」。ユーザー起因の
	// 削除(server の removed)は従来どおり「削除」。ghosts の該当スナップショットの sync 印で分岐する。
	const isSyncGhost = ghosts.find((g) => g.id === task.id)?.sync === true;
	tag.textContent = isSyncGhost ? "同期(削除)" : "削除";
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
		// location/recurrence は snapshot(差分メタ)には無い一過性フレーム用の情報なので null。
		// 次応答で通常経路(taskFromVTodo 由来の実 tasks 行)に戻れば本来の値が乗る。
		location: null,
		recurrence: null,
	};
}

/** 仮タスク(quick-add 楽観行)→ 描画用 TodoItem。due 等の詳細はチャット領分なので持たない
 *  (タイトルのみ・期日なしセクションに入る)。id は "optimistic:" prefix のまま(差分除外印)。 */
function optimisticRowToItem(row: OptimisticRow): TodoItem {
	return {
		id: row.id,
		title: row.title,
		completed: false,
		status: "NEEDS-ACTION",
		due: null,
		isAllDay: false,
		priority: 0,
		percentComplete: null,
		completedAt: null,
		notes: null,
		sortOrder: null,
		// 仮行はタイトルのみ(due/場所/繰り返しはチャット領分)。
		location: null,
		recurrence: null,
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
	const displayTasks: TodoItem[] = (confirmedTasks ?? [])
		.filter((t) => !optimisticDeletes.has(t.id))
		.map((t) => {
			const ov = optimisticToggle.get(t.id);
			if (ov === undefined) return t;
			return { ...t, completed: ov.completed, status: ov.status };
		});
	for (const [id, ov] of optimisticToggle) {
		// 該当行が確定一覧に居るときだけ becoming を立てる(既に確定 vm から抜けた・成功直前の
		// 過渡でも二重表示にならないよう在庫確認する)。
		if (confirmedTasks?.some((t) => t.id === id)) {
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
			// ghost(削除済み)は最小情報だけ描くので location/recurrence は持たない。
			location: null,
			recurrence: null,
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
	// calendarId(E-2 スライス③): この一覧の対象コレクション ID。server は必ず載せる(省略時 "tasks")。
	// ヘッダ見出しと quick-add の作成先に使う。合成 vm(mutation の非既定ビュー経路)では refresh 側の
	// vm から引き継がれる(applyStructuredContent が currentCalendarId を更新する)。
	calendarId?: string;
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
	for (const e of diff.edited) out.push({ id: e.id, kind: "edited", changes: e.changes, sync: true });
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
		for (const id of pendingIds) explained.add(id); // in-flight トグル行は触らない(degrade ガード)
		// 仮行(optimistic:)は confirmedTasks に元々入らないので prev/next のどちらにも現れず、
		// 差分計算に混ざらない(仕様3「仮行は差分計算から除外」を state 分離で構造的に満たす)。
		syncDiff = computeSyncDiff(confirmedTasks, nextTasks, explained);
	}

	confirmedTasks = nextTasks;
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
const app = new App({ name: "caldav-todos", version: "0.2.0" });
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
	// 仮行(quick-add 未確定)はサーバー id が無いのでトグルできない(create 確定後に本物 id で操作)。
	if (isOptimisticId(task.id)) return;
	// 二重送信ガード: in-flight の同一行は弾く(UI はブロックしないので描画反映前の連打はここで止める)。
	if (pendingIds.has(task.id)) return;

	const nextCompleted = !task.completed;
	const nextStatus = nextCompleted ? "COMPLETED" : "NEEDS-ACTION";
	// 楽観適用: 表示を即トグルし becoming を即時に乗せる(塗り丸+凍結リング / 破線に戻る)。
	optimisticToggle.set(task.id, { completed: nextCompleted, status: nextStatus });
	pendingIds.add(task.id);
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	announceBecoming(); // aria-live へ「〜を完了しました」等を即時通知(視覚 becoming と対)

	try {
		// calendarId は今表示中のコレクション(currentCalendarId)を必ず渡す(2026-07-14 実機バグ修正)。
		// 渡さないと server 既定 "tasks" を探して reading-list 等のカードからの操作が TodoNotFound になる。
		// null(初回応答前)のときだけ省略して server 既定に委ねる(その状態では実質 tasks を見ている)。
		const updateArgs: Record<string, unknown> = { id: task.id, status: nextStatus };
		if (currentCalendarId !== null) updateArgs.calendarId = currentCalendarId;
		const result = await app.callServerTool({
			name: "update-todo",
			arguments: updateArgs,
		});
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功 → 楽観を解除してから確定 vm を適用する(解除前に applyStructuredContent すると
		// rebuildDisplay が楽観を二重に重ねてしまうため、必ずここで先に落とす)。
		optimisticToggle.delete(task.id);
		pendingIds.delete(task.id);
		// 【E-2 ② での方針】update-todo の structuredContent は「サーバー確定の全一覧 + affected
		// (completed/reopened の becoming メタ)」を返す契約。tasks が乗っていればそれを確定描画に
		// 使い、追加の refresh は呼ばない(refresh 応答には affected が無く becoming が消えるため)。
		const structuredContent = result.structuredContent as TodosStructuredContent | undefined;
		if (structuredContent?.tasks !== undefined) {
			if (isDefaultView(currentView)) {
				// 既定ビュー: mutate 応答の tasks は未完了ビュー固定で currentView と一致 → そのまま適用。
				applyStructuredContent(structuredContent);
			} else {
				// 【view 状態非保持バグ修正・2026-07-14】非既定ビュー(例 includeCompleted:true):
				// mutate 応答 tasks は未完了ビュー固定で currentView と矛盾するので、tasks は refresh-todos
				// (currentView 付き)で取り直し、mutate 応答の becoming メタ(affected/removed)だけ合成する。
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
						view: rsc?.view,
						affected: structuredContent.affected,
						removed: structuredContent.removed,
					};
					applyStructuredContent(composed);
				} catch (e) {
					// 取り直し失敗 → degrade。mutate 自体は成功しているので楽観解除済みの表示を維持し、
					// 「再読み込み失敗」だけ告げる(再試行は fetchLatest のみ = update-todo は再送しない)。
					// 楽観は既に解除済みなので、次の focus refetch がビューを正す(rebuildFromConfirmed で再描画)。
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
		// update-todo 自体の失敗(transport / isError)→ 楽観変更をロールバックして元の status に戻す。
		optimisticToggle.delete(task.id);
		pendingIds.delete(task.id);
		rebuildFromConfirmed();
		renderAll();
		// 再試行は「同じ mutation を再送」= toggleTask をもう一度呼ぶ(task は元の状態のスナップショット
		// なので nextCompleted も同じに解決する)。二重送信は先頭の pendingIds ガードが引き続き守る。
		// 文言の出し分け(E-2 スライス⑤・小修正): 完了操作(→COMPLETED)と再開操作(→NEEDS-ACTION)で
		// 語を変える。以前は両方「完了を保存できませんでした」で、再開失敗時に文言が実態とズレていた。
		const verb = nextCompleted ? "完了" : "再開";
		showBanner(
			`「${task.title}」の${verb}を保存できませんでした`,
			() => void toggleTask(task),
		);
	}
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
	pendingIds.add(task.id); // maybeRefetch の抑止 + 差分レンズの degrade ガードに乗せる
	// 展開中の行を消すので展開状態も閉じる(消えた行の詳細パネルが宙に浮かないように)。
	if (expandedId === task.id) expandedId = null;
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	liveEl.textContent = `「${task.title}」を削除しました`; // aria-live(視覚の行除去と対の音声版)

	try {
		// calendarId は必ず渡す(2026-07-14 実機バグ修正の監査対象。null のときだけ省略)。
		const deleteArgs: Record<string, unknown> = { id: task.id };
		if (currentCalendarId !== null) deleteArgs.calendarId = currentCalendarId;
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

/** 仮行を1つ積んで即描画し、裏で create-todo を fire する(送信・再試行の共通経路)。 */
function enqueueQuickAdd(title: string): void {
	// 仮 id は乱数で一意化(複数連続投入で衝突しないように)。差分レンズは optimistic: prefix で除外。
	const optimisticId = `optimistic:${Math.random().toString(36).slice(2)}`;
	optimisticRows.push({ id: optimisticId, title });
	clearBanner();
	rebuildFromConfirmed();
	renderAll();
	announceBecoming(); // 「〜を追加しました」を aria-live へ即時通知
	void createTodoFor(optimisticId, title);
}

/** 仮行 optimisticId に対応する create-todo を裏で実行し、成功/失敗で仮行を回収する。 */
async function createTodoFor(optimisticId: string, title: string): Promise<void> {
	try {
		// calendarId は今表示中のコレクション(currentCalendarId)に作る。未受領(null)なら引数を
		// 省いて server 既定("tasks")に委ねる(ヘッダがプレースホルダ表示中に投入された場合の安全側)。
		const args: Record<string, unknown> =
			currentCalendarId !== null ? { title, calendarId: currentCalendarId } : { title };
		const result = await app.callServerTool({ name: "create-todo", arguments: args });
		if (result.isError) {
			const first = result.content?.[0];
			const text = first !== undefined && first.type === "text" ? first.text : "(詳細不明)";
			throw new Error(text);
		}
		// 成功: まず仮行を除去(除去前に applyStructuredContent すると仮行+実行の二重表示になる)。
		removeOptimisticRow(optimisticId);
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
	} catch (e) {
		// create-todo 自体の失敗(transport / isError)→ 仮行を除去してロールバックし、タイトルを復元。
		removeOptimisticRow(optimisticId);
		rebuildFromConfirmed();
		renderAll();
		// 入力欄が空のときだけタイトルを戻す(ユーザーが既に次の入力を打っていたら奪わない)。
		if (quickAddInput.value.trim() === "") quickAddInput.value = title;
		showBanner(
			`「${title}」の追加に失敗しました`,
			() => enqueueQuickAdd(title), // 再試行 = 同じ仮行を積み直して再送
		);
	}
}

function submitQuickAdd(): void {
	// 空文字・空白のみは送信しない(iOS リマインダーで空行入力が無視される挙動に合わせる)。
	const title = quickAddInput.value.trim();
	if (title === "") return;
	quickAddInput.value = ""; // 送信即クリア(入力可能のまま維持)
	enqueueQuickAdd(title);
}

quickAddForm.addEventListener("submit", (e) => {
	// フォーム送信は iframe 内のページ遷移(リロード)を伴うので必ず preventDefault する。
	e.preventDefault();
	submitQuickAdd();
});
// IME 変換確定の Enter で誤送信しない。単一テキスト入力の form は Enter で暗黙送信されるが、
// 日本語入力の「変換確定」Enter も submit を発火させてしまう。keydown は submit より先に走るので、
// ここで isComposing(変換中)の Enter を preventDefault して暗黙送信自体を止める
// (変換中でない通常の Enter は素通しし、form の submit ハンドラに処理を委ねる)。
quickAddInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && e.isComposing) {
		e.preventDefault();
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
