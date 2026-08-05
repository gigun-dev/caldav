# 次セッションの方向性(2026-08-05 棚卸し・第5版)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする(積層を本文に溶かし込む。**第5版 = フック強化(敵対的検証)を機に棚卸し。
> 第4版までの積層の生記録は git 履歴と docs/log.md にある**)。
> **頭(マーカーより上)は「現在地」+「着手順」だけを 80 行以内に保つ** — 経緯・決定事項・
> ボツ案はカタログ側の該当節へ溶かす(頭は毎セッション自動注入されるので肥大化は直接コスト)。
> 時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。
> 見出し `## 現在地(...)` の括弧が半角なのは SessionStart フックの鮮度検査(頭の日付 vs 最終
> コミット日)の正規表現が半角前提のため — 全角にすると検査が無言で死ぬ(2026-08-05 実測)。

## 現在地(2026-08-05)

**本番は一巡して稼働中** — MCP ツール群 + todos/agenda カード + ゴミ箱(ソフトデリート)+ 場所検索まで
Inspector 受け入れ PASS 済み。焦点は「機能を足す」から**プロトコル適合とカード品質の是正**へ移った。

- **未コミット・未デプロイの成果がある(引き継ぎの最重要点)**: 2026-08-01 の CalDAV 是正5件
  (未対応 REPORT を 403 + `supported-report` へ / `principal-search-property-set` 実装 /
  `.well-known/caldav` 301 に `no-cache` / **404 propstat のプロパティ名が壊れていたバグ修正** /
  `valid-sync-token` の namespace)。`make check` 緑(bun 1105 / worker 42)。deploy 前の確認2点は
  カタログ「CalDAV プロトコル適合」節。
- **カード配色に実バグ9件(2026-08-02・未修正)**: 全件を独立に再検証した監査 →
  [`docs/card-color-audit-2026-08-02.md`](card-color-audit-2026-08-02.md)。重い順に ①`.fab` 等の
  白文字がダークで 2.71(非テキスト最低線 3:1 も割る)②`--text-3` が両モード落第(light 2.07 /
  dark 2.51)③`--hairline` 未定義でダーク 1.03 = 不可視 ④**ホスト注入テーマが一度も `setProperty`
  されておらず `--color-*` の全参照がフォールバック**(iOS システムカラー追従の設計が丸ごと死んで
  いる。`--color-border-secondary` / `--color-border-primary` の綴り違いもあり断線は二重)。
- **MCP 2026-07-28 仕様改訂は「今は着手しない」裁定(2026-07-31)** — 発表(08-01)を壊さないための
  判断で、移行自体は歓迎(ステートレス化は Workers と本質的に好相性・現状の実装が既に実質ステートレス)。
- **iOS 初回アカウント追加の失敗はサーバー無罪と確定(2026-08-01)** — 他社サーバーでも再現。webcal で
  端末を温める回避策と種デバイス `CalDAV-Seed-webcal`(`simctl clone` で 16.7秒・0タップ)を確立。
- **`make dev` が起動しない**(2026-08-01 発見・未調査。custom build の watch が無限ループ。開発体験を直撃)。
- 積み残しの計測: **IAD レイテンシ再計測**(colo タグ付きサンプルの蓄積待ち。判定不能のまま据え置き)。
- **正典の順序**: instructions → この頭 → 該当 modeling / RFC 原文 → project skill → `docs/log.md`。
  詳細履歴は必要な節だけ読む。Claude project memory や session JSONL は同期しない。

## 着手順(次にやること)

順序は棚卸し時の整理であり、ユーザーが確定した優先順位ではない(2〜4 は独立・入れ替え可)。

1. **2026-08-01 の是正5件をコミット → deploy**(未コミットのまま抱えるのが一番危ない)。deploy 前に
   確認: (a) 既存アカウントが古い 301(`Cache-Control: no-cache` 無し版)をキャッシュ済みの可能性
   (b) principal への PROPFIND で `supported-report-set` が 404 propstat → 200 propstat に変わる
   (挙動が変化する箇所)。
2. **カード配色9件の是正** — 監査で原因まで特定済みなので設計判断は不要。特に④のテーマ断線は
   カード全体の色に効く。同じカード側で**未修正の実機バグ2件**(fullscreen FAB が composer に隠れる /
   ⊕ → fullscreen でキーボードが一瞬起動 → 即閉じ)も残っている(カタログ「カード UI のドクトリン」節)。
3. **Apple クライアントモデル総当たりで検出した未着手課題 1〜7**(8 は全プロパティ定義に波及する
   ため別タスクとして起票する)。一覧はカタログ「CalDAV プロトコル適合」節。
4. **`make dev` 無限ループの調査・修正**。
5. **MCP 2026-07-28 移行スライス**(発表後に着手する前提。裁定「今は着手しない」の根拠は発表を
   壊さないことなので、発表が済んだなら再評価してよい)。
6. **IAD 再計測** → 次段最適化(横断1クエリ化の効果確認 / D1 read replication)の go/no-go。
7. ユーザー作業の実機確認(残項目はカタログ「iOS / Simulator 検証」節に集約)。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される「頭」(現在地・着手順)。
     以降は方向性カタログ — 着手する節だけをそのとき読む。棚卸し時はここより上を最新に保つこと。 -->

## 今日までに完成しているもの(前提)

- **iCalendar ドメイン層**(RFC 5545): 構造層 + 値型コーデック + 意味論レンズ + 不変条件 I1〜I10。
  ロスレス往復。VJOURNAL(J-1)・ical-tasks/9253 読み取りアクセサ(J-3)・VTODO 書き込み経路
  (builder/patch/stamp・location・RRULE 全置換/除去・孤立 VTIMEZONE 掃除)。
  【journal 方針(2026-07 決定・memory から移送)】journal コレクションは人間向けでなく agentic
  インフラ。provisioning は既定 provision に入れず「agentic 機能の初回使用時に遅延 get-or-create」
  (除去可能性優先)。J-1 は RFC 確定で素直に・J-3 は原文スナップショット後に string 型で。
  安定度で3層(RFC 確定 / draft / 独自)に分けて疎結合に保つ。
- **CalDAV リソース層**: 3集約 + put-preconditions R1〜R7 + If ヘッダ(sync-token 条件)サブセット。
- **意味計算(G)✅**: TZ 解決層 / RecurrenceExpansion(ical.js port&adapter)/ occurrence 索引 +
  time-range / free-busy。設計判断は docs/modeling/08 §6。
- **フルスタック稼働**: 本番 = Worker `caldav.gigun-dev.workers.dev` + Cloud Run 書き換えプロキシ
  (iOS 正式入口・恒久構成)。deploy = Workers Builds が main push で migrate→deploy 自動。
- **MCP サーバー**(`/mcp`): OAuth(workers-oauth-provider)本番実機受け入れ済み。DAV と MCP が同じ
  UC を呼ぶ複数入口ビジョンは実証済み。ツール本数は R1(0616e5f)時点で 23 本、以後 restore-deleted /
  list-deleted(R2)・update-calendar(K2)・search-location(#45)が加わっている。
- **MCP Apps カード**: todos(E-2)/ agenda(E-3)/ コレクション詳細 / ゴミ箱ページ。UI モックの
  設計変遷は docs/modeling/ui-mockups/(README 索引付き)。
- **テスト2レーン**: bun test + vitest-pool-workers。tsdav CI ハーネス込み。CI = 層境界 → tsc → 両レーン。
- **iOS 実機検証**: カレンダー3ラウンド + リマインダー D/V 系(docs/modeling/06)。shake-undo は
  サーバー側 RFC 6578 準拠を実測で確認済み(バグ無し)。
- **R-6(OAuth scope 分離)✅**(4eee336): claudedav:read/write 分離。語彙と区分は
  `presentation/mcp/scopes.ts` に一元化(read allowlist・未分類は write の safe default)。scope は
  props で運ぶ(apiHandler は `ctx.props` しか受け取れない = provider 契約)。旧 grant は grandfather
  (full access + 警告ログ `oauth_grant_without_scopes`)で既存接続を壊さない。静的 Bearer は full
  scope 明示。同意画面に権限サマリ。**再接続すると新 grant として厳密強制に移行する。**
- **R-7(CAS)✅**(4c12374): UoW の楽観ロックを CAS 化(①CAS UPDATE WHERE sync_counter=baseline →
  ②sync_changes INSERT → ③自己参照ガード付き object write)。ConcurrencyConflictError → 412。
  CalendarCollection に baselineSyncCounter 追加。R-8 名残(snapshot UID の deterministic 化)同梱。

## 方向性 G / J ✅(完了・詳細は第3版 = git 履歴)

- G(意味計算)全タスク完了。J(採択途中 RFC)一区切り。J-4 の残 = iOS 実機での calendar/tasks
  非回帰確認(allprop sync-token 除外の念押しと合流)。RDATE/EXDATE 付き VJOURNAL はレンズ拡張と
  セットで別タスク。

## 方向性 E: M6 agentic 入口(長期ビジョン本命)— E-1〜E-3 完了・派生スライスが主戦場

- **OAuth-for-MCP ✅**。暗黙契約: `completeAuthorization({props})` は `{username}` 形 / DCR は
  `token_endpoint_auth_method:"none"` 明示 / `/mcp` は `Accept: text/event-stream` 必須。
- **E-1(VTODO の MCP 完全対応)✅ / E-2(todos カード v3)✅**(v1 トリアージ → becoming 差分 →
  楽観更新 → v2 iOS 借景 → v3 カード内ページ遷移へ2日で3世代)。
- **E-3(VEVENT)✅**: S1 4ツール + Event DTO(db9664a)→ S1.5 通知×2(開始相対 VALARM)+ 移動時間
  X-APPLE-TRAVEL-DURATION(07e2c14)→ S2 アジェンダカード + 共有カーネル `ui/format`・`ui/recurrence`
  抽出(781c705)。本番検証 PASS(カード描画 / D1 バイト照合 / delete-event の removed スナップ
  ショット契約)。設計の正は docs/modeling/12。
- **E-2 で確立し E-3 以降が流用する資産**: ①contract
  `{tasks, calendarId, timeZone, view?, affected?, removed?, movedTo?}` — **「view の欠落 = list/refresh 由来では
  ない」が防御の判別シグナル**(mutate は view を名乗らない)②claude.ai ホストモデルの実測 = 1 tool 呼び出し
  = 1カード・push なし・会話復帰は replay のみで再実行なし → **app 駆動の refetch が正** ③カードの操作文法
  (一覧 = 走査面 / 行タップ = 選択とインライン編集・選択解除で自動保存 / ⓘ = カード内ページ遷移 / FAB =
  インラインドラフト行 / 削除 = 左スワイプ。#44 以降は詳細が閲覧ファーストになった点だけ差分)④becoming の
  静的マーキング(sync レンズは added / completed / reopened / removed のみを見て **edited は捨てる**)
  ⑤アニメーションは持たない(in-flight のシマーだけが例外)。
- **mega-SPA 境界(判断基準)**: カードが会話からナビゲーション権を奪っていないか。**1意図 = 1ツール =
  1テンプレ。** WebUI を作るときも共有カーネル(contract + 純関数 + コンポーネント)戦略で、カードを
  肥大化させる方向には行かない。
- **fullscreen ビュー切替**: 月グリッド(36a8b8d・6週42セル固定・コレクション色ドット・選択日リスト
  連動。レンジは listRange 退避方式)+ 日タイムライン(2a019f0・重なり解決は `day-timeline.ts` 純関数・
  赤線タイマーは stopNowLineTimer 集約 + visibilitychange 連携)。モックは agenda-views-v6/v7(**図が正**
  — v6 に日ビュー描写が無かったので v7 を先行作成)。**残: 実機/Simulator 目視**。
- **agenda の inline 畳み(f56e6d7 + 6757a07)**: P4-DM を todos から移植(ホスト中立・カードが宣言)。
  `fold.ts` 共有カーネル化 + 行単位畳み(空日見出しペア除去)+「すべて表示」→ request-display-mode。
  **畳み単位は行(案A)。日グループ単位(案B)は budget 浪費でボツ。** 残: S4「・あと M 日」付記(任意)。
- **時刻グラウンディング**(bb1277c / b6961d1): list-events-expanded / get-freebusy に相対レンジ enum
  (today / tomorrow / next-7-days / next-30-days / this-week / next-week / this-month)+ range 時 TZ 必須
  + resolvedRange エコー。description に「相対表現は range 1発・get-current-time 不要」。
  `resolveRelativeRange` は application/time の DST 安全純関数。get-current-time は存置。
  ~~#32 週始まりを日曜へ~~ ✅(3500f6c)。**list-todos due の語彙統一は別スライスのまま未着手**。
- **echo pin 根治(56cbb73)**: 全横断なのに `calendarId:"calendar"` を固定 echo → カードが
  currentCalendarId に保存 → focus refetch が単一へ collapse していた。全横断時は正直に null echo
  (単一指定時のみ echo・calendarIds は additive echo)+ カード側は「range を名乗る照会応答」のときだけ
  currentCalendarId を採用(mutate の作成先 echo による再 pin 経路もレビューで検出し遮断)。
- **#3 list-todos の silent drop(15f214b)**: calendarId 省略時に `otherTodoCollections` で「他にもある」を
  応答側から伝える(D 案)。events は元から横断既定・todos は単一前提なので B 案は見送り(可逆)。
  **残スライス**: 2 = カードに「他に○件」描画 / 3 = Task per-item calendarId → 横断集約 B。
- **起票のみ**(modeling/12 §1): occurrence 単位編集 / VALARM 付き作成 / get-event 詳細カード /
  move-event(move-todo を共用できなければ)/ #11 iOS URL・CONFERENCE。
- **表示順序設定(modeling/12 §7.9・G-1〜G-5・未着手)**: 手動順 = X-APPLE-SORT-ORDER・モード = 独自
  dead property + D1 カラム(iOS はソートモードをローカル保持 = 独自でも相互運用の損失ゼロ)。
  G-1 = iOS の手動並べ替え/モード変更の CalDAV 挙動を Proxyman 観測 → G-4 カード設定 UI → G-5 ドラッグ。
- **据え置き・降格(実害実証待ち)**: becoming の replay nonce(会話復帰でラベル再演)/ sessionStorage
  選好復元(claude.ai はカード積みで再バインド無し)/ V6 Phase 2(DST ゾーンの VTIMEZONE 生成)/
  VALARM 管理スライス / 反復 due→DATE の I6 明示エラー / delete の committing 演出(既存の即時削除設計と
  両立せず見送り)/ WebUI(独立した製品要素)/ WebMCP 実験 / メール起点タスク追加(K-4)。

## カード UI のドクトリン(確定事項。逸脱するときはコードより先に図を直す)

- **操作フィードバック統一 v2.2(modeling/12 §7.8 が正)**: 統括原理「**振り付けはクライアント固定
  タイマー・サーバー/transport は関与しない**」(計器で Worker max 4s・10s 超過は claude.ai transport と
  確定)。楽観適用 + 失敗ロールバック + バナー。位置不変 = iOS「手動」モード(positionMemory)。
  **時間駆動の視覚イベントを型から排する。** 実装は共有カーネル `ui/feedback.ts`(F-1)+ todos(F-2)+
  agenda(F-3)で一巡済み — pendingIds は `Map<id,startedAt>`・committing 状態機械・wake-sweep は
  infinite → 1・ring / opacity-pulse ×1・T_hard バナーは v2.2 で廃止・reduced-motion 対応。悲観パス
  (反復イベントの日時/recurrence 変更)の pending はマスター id キーなので反復の全 occurrence にヒット
  する → `seenAffectedIds` 集約で先頭行のみ表示。**楽観/悲観の現状ネットサマリは modeling/12 §7.8 冒頭
  (9008b9f)にある。**
- **追加は単発が正(0a29d0e)**: 「FAB → 1件 → 完了でその場シマー・空ドラフト行を残さない」。
  Enter による連続追加は元の違和感の本丸で、**連続追加を UX の既定とみなしたのは誤解**だった。
- **編集の確定は「戻る」でも保存(e90bc49・iOS 準拠で破棄は廃止)**。詳細のボタン文言は「保存」→「完了」
  (作成モードは「追加」のまま)。undo は circle-drain(塗り → 空へ drain)で done と対称にした。
- **タイムゾーン**: 症状の真因は read 側の UTC 落ち(create は既に Intl TZ を送っていた)→ refreshArgs と
  全 mutate に viewer の Intl TZ を常時付与し、サーバー mutate 5系の `buildTodosViewModel` へ timeZone を
  スレッドする(e90bc49)。
- **done 行の最終仕様 (d′)(2026-07-23 裁定・C0-a′ は撤回)**: done はその場で取消線・再タップ undo・
  完了済みへの移動は次の fresh render / リスト切替のクリーン再セクショニングのみ。C0-a′(3秒猶予 →
  退場アニメ → 移動)は §7.8 v2.2 の裁可済みドクトリンと矛盾する再導入だった(図を更新せずコードで
  矛盾を持ち込んだ誤り)。**iOS の「3秒猶予」は一次資料に存在しない。** 設計言語は「操作の差分を
  静的に見せる」(ユーザー指摘)。`done-exit.ts` は撤去し、positionMemory の所属判定で重複排除する。
- **カード形状の原則 (b)(2026-07-23 承認)**: inline = 有界高・内部スクロール禁止・深いナビ禁止
  (OpenAI Apps SDK ガイドラインと一致)/ fullscreen = 単一スクロールコンテナ許容 / **プログラム的
  スクロールを UX の成立条件にしない** — 視線誘導は「対象を安全先頭に置く遷移」。安全先頭 =
  `HostContext.safeAreaInsets.top`(仕様に存在・claude.ai の申告は未実測・iframe 内 `env()` は不可)→
  CSS 変数 `--host-safe-top` に一元適用 + 未申告時はモバイル fullscreen 限定フォールバック。
  原則の明文化は docs/modeling/15 に集約。
- **iframe 制約**: コンテンツ高さに自動リサイズ → **fixed + vh のオーバーレイ/ポップオーバーは構造的に
  破綻**(v2 の実機バグで実証)。浮遊レイヤーは作らない。
- **鮮度は SWR(#42)**: ext-apps 仕様は履歴復元時のホスト再実行・再可視化通知を規定しない = 鮮度は
  カード自身の責務。claude.ai の履歴復元は楽観復元(実測: 履歴遡り複数回で tool call ほぼゼロ・focus 時
  のみカード自身が refetch)。穴は「markUpdated が push でも lastFetchAt=now とし古い replay が新鮮を
  装う」こと → view model に `generatedAt` を additive 追加し、60秒超の古い push は背景 revalidate。
- **バージョン不整合**: claude.ai web はコネクタ同期時点のツール定義(content-hash `ui://` URI)を
  キャッシュし旧カードを描画し続ける = 「幽霊デバッグ」の主因。対策 = 配信 HTML の焼き込み hash と
  server `uiHash` を比較する版不整合警告(両カード)+ ユーザーはコネクタ再同期。
- **render-gate(`render-gate.ts`)**: シート表示中・focus 中の破壊的 renderAll を抑止し、閉時に追いつく
  (既知ロケーション読込などは targeted in-place 更新)。**キーボードは「タップジェスチャ内の同期 focus
  → requestDisplayMode」の順で根治**(450ms 遅延 focus のワークアラウンドは modeling/15 §B のボツ案)。
- **完了済みサマリ**: server 常時計算の `completedSummary = {total, recent, byCalendar}`(D1 SELECT 1回・
  includeCompleted / due 窓 / calendarId スコープに非依存)。単一リスト表示ではそのリストの完了済みを
  見せるのが正(**不変条件は「push で揺れない」ことであってスコープ無視ではない**)。0件はセクション
  非表示・byCalendar は所属不明行を数えないので内訳合計 ≤ total。due 窓判定は `filterTasksByWindow` として
  application 層へ抽出(UC と presentation で単一情報源)。
- **既定リスト**: 単一が既定(echo → 前回選択 → tasks)。「すべて」は明示選択でコレクション別色付き
  グループ表示。`"all"` は横断センチネルとして正規化。
- **完了したカードスライス(2026-07-23〜24・すべて deploy 済み)**: ~~#38 K シリーズ~~ ✅(K1 冪等性 4f464be /
  K2 update-calendar + 実色 `resolveCalendarColor` + コレクション詳細ページ de88ae7 / K3 todos 切替を横断
  1クエリ + in-memory フィルタで往復ゼロ化 6a1a850)・~~是正束7件~~ ✅(8f9fc13 → 残留メニューオーバーレイが
  タップを吸う FAIL を 7c6b133 で修正 → 全10項目 PASS)・~~#43~~ ✅(6d84ae1: completedSummary 内訳 /
  list-deleted・restore-deleted のカード化 = URI 生テキストをモデル文脈から追放 / **event mutate 4ツールの
  `_meta.ui` 未配線が「カードが出ない」根因**(ホスト判断ではなかった)→ 配線)・~~#44~~ ✅(c06d8d5:
  詳細ファースト = 閲覧ページ → 明示「編集」/ URL は App.openLink + 二段 degrade コピー / ⊕ テキスト併記 /
  新規リスト fullscreen 化 / キーボード根治)・~~#45~~ ✅(7ea62c8・下記「場所」節)。ce7d5aa の UI 是正3件
  (agenda 編集詳細へ C4 = 構造化場所/会議を移植 + 汎用 URL 欄を作成・編集の両方に新設 / リマインダー作成の
  リスト選択 = VTODO コレクションのフィルタ / fullscreen キーボード落ちの根因 = シート表示中の破壊的
  renderAll → render-gate 導入)も同系列。
- **create-calendar の冪等化やり直し(5d2a475 / 0d6854f)**: K1 の同名拒否は誤った治療(真因はリトライ
  重複 + ランダム UUID)とユーザー裁定 → **同名ガードは撤去**し安定 id への収束で真の冪等化
  (`idempotentHint:true`)。本番 E2E 済み(同依頼2回目が同 id を返し新規作成なし)。意図的な同名複製は
  id 明示で。日本語 displayName は FNV-1a 安定 slug。なお K1 当時の同名ガードも「MCP 入口限定 opt-in =
  iOS/iCloud の同名リスト正当作成を壊さない」という責務分界だった。
- **確定ボタン文言(4afb38f・iOS 準拠)**: 作成 =「追加」(todos/agenda とも)。編集は todos「完了」/
  agenda「保存」(イベントに完了概念が無いため)。「完了」× タスク完了のダブルミーニングを作成から排除。
- **Inspector 受け入れの標準化**: 「実装 → deploy → Inspector subagent 受け入れ → FAIL 即修正」ループ。
  **本番でしか出ないバグを捕まえられる**(#45 の fetch `this` 束縛バグ = スタブ fetch は this を見ないため
  `make check` green のまま本番で落ちた)。
- **未修正の実機バグ2件(2026-07-23夜に swift-mcp-app セッションから報告・修正するのは caldav カード側)**:
  ①**fullscreen の FAB が claude.ai iOS の composer に隠れる**(実機スクショ確認済み)—
  `resolveSafeBottomPx` の「bottom は深刻な occlusion を起こしにくいのでフォールバック無し」という仮定の反証。
  claude.ai iOS は composer クローム分を `safeAreaInsets.bottom` に申告していない模様。検証項目
  「safeAreaInsets 実測ログ」で実値を取り、top と同じ **fullscreen 限定の bottom フォールバック**を1関数に隔離して
  追加する(実測後に定数更新)。②**⊕ → fullscreen 遷移でキーボードが一瞬起動 → 即閉じ**(実機確認済み)—
  ce7d5aa の render-gate は「シート表示中」のみ抑止のため、遷移時の hostcontextchanged 起点 renderAll が focus 中の
  ドラフト input を DOM ごと消す経路が残っている。`shouldSkipDestructiveRender` の抑止条件を「**focus 中の input が
  ある間**」へ広げる方向を推奨(遅延 focus ワークアラウンドの復活は modeling/15 §B のボツ案)。
  ※②は同日の #44「キーボード根治」(c06d8d5)と時期が重なるため既に解消している可能性があるが、**解消したという
  記録はどこにも無い**ので未修正として残す(実機で先に再現確認するのが安全)。
- **教訓(memory 記録済み)**: 同一ファイルを触るスライスを並列に出さない(後勝ちマージが先行実装の配線を
  乱す。`make check` green でも統合の振る舞いは守られない)。別リポで並行作業がある場合、subagent の
  未コミット成果は並行セッションのコミットで上書き消失しうる → 早めにコミット/stash で保全。

## HITL・破壊操作の可逆性(R1〜R4)— 正典 docs/modeling/15

**方向転換(2026-07-23・ユーザー裁定 + architect 一次資料調査)**: MCP spec の明文で確認 UI は**ホスト
責務**(claude.ai は per-tool 許可済み = サーバー側の確認カードは二重確認)。サーバーの責務は annotations
申告(当時は未付与 = 未履行の義務)+ 可逆性。→ **確認カード S2(update diff プレビュー)/ S3(バッチ
部分承認)は中止**。docs/modeling/14(確認カード設計・HMAC 確認トークン)は **Why not として保存**。
S1(propose-delete-* + `_meta` 限定 HMAC トークン + カード内 callServerTool)は本番 E2E まで通した上での
方向転換であり、実装が失敗したわけではない(裁定の記録: `kind:"card"` の 12h 免除トークンは既存カード内の
明示操作を二重確認にしないための限定的 capability・nonce は TTL 内 replay 可能なので厳密な one-time token
とは呼ばない、という整理も modeling/14 側に残っている)。**運用面の残り物**: `CONFIRM_SECRET` は
`.secrets.prod.json` 控え + `wrangler secret bulk` で本番設定済み。**secrets.required ガード(2a9ced5)により
設定漏れの deploy は失敗する**(この機構自体は confirmToken 撤去後も生きている)。

- ~~**R1 annotations 付与 + confirmToken 降格**~~ ✅(0616e5f): 全 23 ツールへ annotations
  (read=readOnlyHint / create=非破壊 / update=destructiveHint:true は R3 まで正直申告 /
  delete=destructive+idempotent / 全部 openWorldHint:false)。delete 系の confirmToken 強制は撤去
  (フィールドは optional 残置で無視・カード経路は無改修で動く)。~~propose-delete-* の撤去~~ ✅(545920f)。#28 クローズ。
- ~~**R2 ソフトデリート**~~ ✅(b587ef0 + 545920f): migration 0004(`deleted_at` + UID partial unique。
  **URI は PK で全一意 + ゴースト rename という非対称構成 = 前方互換のための意図**)・restore-deleted /
  list-deleted ツール・30日 purge + cron 配線。本番スモーク ✅(partial index 存在・既存 141 行全生存)/
  Inspector E2E ✅。
- **R2 の RFC 適合検証(docs/rfc/ 原文で確認・準拠)**: 4918 §9.6 の DELETE 義務は「URI → リソースの
  マッピング除去」でありデータ破棄ではない(`deleted_at` フィルタを全 DAV 読み取り経路へ一貫適用すれば
  準拠。soft-delete 済み URI は unmapped なので `If-None-Match:*` の PUT は成功させる)/ 4791 の UID 一意性は
  「stored / in use」空間の話で partial unique index 案は適合 / 6578 §3.5.1 は再マップを「changed として
  報告・removed と報告してはならない(MUST NOT)」と明文 = restore を sync_changes `'created'` とする案は
  既存 changesSince の後勝ち fold と噛み合い自動で準拠 / ETag は ICS からの決定的導出により restore 後も
  同値で問題なし(7232 上正当)/ trash を DAV に露出せず MCP-only にするのは Nextcloud(独自 DAV 拡張)等と
  比べてもプロトコル純度で正攻法。**修正必須1点**: restore の前提条件に URI 空きだけでなく **UID 空き**を
  加える(soft-delete 後の同 UID 再利用は合法なので restore で可視 UID の重複が生じ得る → 拒否 or 別採番)。
  **物理 purge(30日 TTL)は sync_changes を書かない。**
- **R3(object_versions + revert)= 未着手。** R3 到達後に update の destructiveHint 申告を見直す。
- **R4(swift-mcp-app 側の annotations 駆動 per-tool 許可ゲート)= 別リポへ申し送り済み。**
- **UI 論点(log 2026-07-23 続き6)**: restore 後は復元先リストへ遷移する(意図的)/ ゴミ箱ページは
  render-gate の対象外。

## D4 完了スナップショットの保持ポリシー — 裁定「今は入れない」✅(2026-07-24 クローズ)

理由(優先度順): ①**可逆性の非対称** — 「入れない」は cron 追加で後から覆せるが削除は不可逆。判別不能な
旧データへ自動削除を走らせると非反復タスクの手動完了履歴を誤消去するリスクがある ②コアバリュー(RFC 準拠 +
iOS 対応)に非寄与 — 削除はむしろ iOS ネイティブの「無期限累積」挙動からの逸脱 ③実害ゼロ(本番 150 行/
単一ユーザー、D1 10GB まで桁違いの余裕)④「累積が問題」という従来評価は UI 表示問題を指していたもので、
それは completedSummary(#43)で解決済み。

- **本番実測(2026-07-24 SELECT)**: STATUS:COMPLETED な VTODO 118 件中、確定 D4(`completion-` prefix UID)は
  7 件のみ。旧 UUID 採番の D4 か通常完了かを ICS だけで判別不能なものが 111 件(07-16/07-17 の 67 件バーストは
  D4 実装直後の開発・E2E トラフィックの可能性大)。
- **据え置きトリガー(いずれかで再着手)**: ①対象コレクションの VTODO 行数が閾値(目安 5,000 行)超過、
  または calendar-query / sync-collection REPORT の体感劣化 ②マルチユーザー化(OSS キット化)でテナント別
  保持ポリシーが商品要件になったとき ③iOS 実機で「サーバー側削除 → ローカル表示」の挙動検証が完了したとき。
- **将来入れる場合の設計輪郭**: 対象は `uid LIKE 'completion-%'` AND STATUS:COMPLETED AND
  `updated_at < now - TTL`(TTL 目安 180日・iOS キャッシュ挙動が未検証のため保守的に長め)。二段(①日次 cron で
  `deleted_at` を立てる → sync_changes に 'deleted' 記録 = RFC 6578 §3.5.2 の removed MUST を既存 soft-delete
  機構が充足 ②既存 `purgeDeletedBefore` が30日後に物理 DELETE)。層配置 = 保持判定は domain のポリシー関数・
  cron 起動は application UC(例 `PurgeExpiredCompletionSnapshots`)・SQL は infrastructure。
  **判別不能な旧 111 件は恒久的に対象外**(全 STATUS:COMPLETED を一律に扱うと非反復タスクの手動完了履歴を
  消す許容不能な副作用があるため)。
- **ボツ案**: (b) マスターごと直近 N 件保持 = 旧 UUID で紐付け不能・`completion-` ハッシュはマスター UID へ
  逆引き不能 (c) 無期限を「ポリシーとして実装」= それは「入れない」と同義でコード不要。

## 観測基盤とレイテンシ

- **観測基盤 v1 ✅**(91cfaa3): TelemetryPort + Analytics Engine 併用。イベント
  `{requestId, principal, host, ok, errKind, ms, argsDigest}`・index1 = mcpTool・保持3ヶ月・SQL で遡及可。
  設計は architect 報告 2026-07-23 が正: **真実源はサーバー・クラッシュは端末 Sentry・相関は
  `_meta["gigun.dev/session"]` + 自前 requestId**。旧 `{mcpTool,ms,colo}` console.log は field 未インデックスで
  使えなかったため AE 化した経緯。
- **レイテンシ改善の実測**: 横断ループの `Promise.all` 並列化(e569c96)で日本経由(NRT/KIX)の
  list-events-expanded が **2303ms → 325〜351ms(約6.5倍)**。案2 = 横断1クエリ化(a44f0bd): 実往復は3波
  (findAllByOwner → hydrate の sync_changes N+1 → time-range N 並列)だった → `calendar_objects.owner` により
  コレクション列挙自体が不要になり `WHERE owner=?` の1クエリへ(新 port `findByOwnerTimeRange` +
  `ListOccurrences` / `ComputeFreeBusyAcrossOwner`。単一 UC は DAV 用に不変・echo 契約も不変)。
  **sync-collection 系の hydrate N+1 は残置(別スライス候補)。**
- **IAD の正体**: claude.ai コネクタは米国発 → Worker が IAD で実行される。つまり IAD ~1259ms は「遠い外国」
  ではなく **claude.ai 利用時に毎回払うレイテンシ**(D1 プライマリは HKG)。
- **IAD 再計測は判定不能につき据え置き(2026-07-24)**: AE dataset `caldav_mcp_events` を SQL HTTP API で直接
  クエリ(計装は 07-23 追加でまだ薄い・約1日/419 コール、うちエラー 27 = ~6.4%)。全 list/refresh 系が強い
  bimodal(p50 85〜211ms = 近い D1 クラスタで既測の 325〜351ms と整合 / p95 ~2000ms・max 4.9s の遅いテール)
  までは分かったが、**colo 別の分解が不能だった** — `analytics-engine-telemetry.ts` が colo を AE へ書いて
  いなかった(96B 予算を理由に除外していたが、**96B は index のみで blobs は 16KB 枠**という Cloudflare 公式
  limits の一次確認で事実誤認と判明)。observability MCP ツールの events ビューは Zod バグで壊れており
  console.log 側の colo を読む回避路も不能。**対応済み**: AE アダプタの blobs 末尾(blob6)に colo を追記し
  誤ったコメントを訂正。**判定は colo タグ付きサンプルが蓄積されてから**(単発 IAD からの合成プローブでも可)。
  現時点では「IAD は改善した」と結論づけるデータは無い(bimodal のテールが IAD 由来かも未確認)。
- 参考実測(2026-07-14・並列化前): refresh 73ms / update 597ms / list 706ms / delete 2707ms。残案 =
  update/delete の点読み経路・STATUS 列 migration の要否・D1 read replication。Smart Placement 導入済み。

## 場所モデルと geocoding(#45 ✅)

- **裁定(2026-07-23)**: known-locations 先引き → **Google Places Text Search 単段**。場所入力の実態は POI 主体で、
  実測ベンチでも GSI は POI に誤答(住所形の前処理としては将来候補)・Apple は必須クエリ0件(ポートの口だけ
  用意)。ToS は「サーバーはメタデータ保存のみ・表示はクライアント解釈」+ 6.3.2 のユーザー別直接機能で整理。
- **実装 ✅**(7ea62c8): `search-location` ツール + 月次 quota ガード(D1 atomic 予約・既定 1000/月 = Pro SKU
  無料枠 5,000 の 20%)+ geo 必須緩和(geo 無しは LOCATION へ degrade)+ picker の geo 無し対応。モデルは
  ジオコーディング不能なので住所のみでも受理する。GCP 整理・予算アラート(¥1,000)・`GOOGLE_MAPS_API_KEY`
  本番投入済み。
- **解決品質ゲート(2026-07-24 再受け入れ・全4項目 PASS)**: ①VTODO でゴミ(架空場所)はツールがエラー
  (`isError:true`)を返し D1 に行が作られない ②VTODO 正当クエリ(叙々苑)は X-APPLE-PROXIMITY:ARRIVE + geo +
  X-APPLE-RADIUS=100 を D1 raw ICS で確認(#51 回帰 OK)③VEVENT のゴミは degrade(エラーにせず作成・
  `_meta["gigun.dev/locationAutoResolve"] = {kind:"rejected",score:0.1875}`・文言「一致度が低いため地図ピンは
  付けませんでした。search-location で確認できます」= failed と区別・D1 は structuredLocation 無しの LOCATION
  テキストのみ)④VEVENT 正当クエリは `{kind:"geocoding",score:0.5}` + X-APPLE-STRUCTURED-LOCATION(geo+X-TITLE。
  #45 回帰 OK)。**軽微な是正余地**: VTODO の拒否文言は「解決できませんでした」の一般文言で弾いた候補名を
  含まず、VEVENT の rejected 文言と非対称。
- **確認済みの「変更不要」**: known-locations の geo 無し emit は出さないのが正(iOS 地図に出ない場所を提示する
  中途半端さを避ける)/ geocoding quota は失敗時も消費するのが正(実呼び出しが発生した以上、試行回数で数える)。
- 検証は Inspector proxy 経由の直接 JSON-RPC POST を使う(フォームの locationReminder / recurrence 併存
  シリアライズ不具合を回避できる)。geocoding quota 使用量 2026-07 = 16。

## MCP 2026-07-28 仕様改訂への移行(2026-07-31 起票・裁定「今は着手しない」)

一次資料: [仕様](https://modelcontextprotocol.io/specification/2026-07-28/) /
[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) /
[MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/) /
[Claude blog](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)。

- **破壊的変更の規模**: ①`initialize` / `notifications/initialized` ハンドシェイク廃止 + `Mcp-Session-Id` 廃止
  (完全ステートレス化・版と client capabilities は毎リクエストの `_meta`)②`server/discover` が **MUST**
  ③**全 result に `resultType` 必須**(`"complete"` / `"input_required"`)④HTTP GET + `resources/subscribe` →
  `subscriptions/listen` ⑤`ping` / `logging/setLevel` / `notifications/roots/list_changed` 削除(log level は
  `_meta` の `io.modelcontextprotocol/logLevel` 経由・未指定リクエストへ `notifications/message` を出すのは
  MUST NOT)⑥MRTR がサーバー起点リクエスト(sampling / elicitation / roots)を置換 ⑦list 系に `ttlMs` /
  `cacheScope` 必須・`Mcp-Method` / `Mcp-Name` ヘッダ必須・エラーコード renumber ⑧認可: DCR(RFC 7591)を
  **非推奨**化し Client ID Metadata Documents へ・RFC 9207 `iss` 検証必須。
- **裁定(2026-07-31・発表動画の締切 08-01 18:00 を理由に): 着手しない。** 根拠(優先度順): ①発表デモは
  swift-mcp-app(自作クライアント)⇄ caldav の閉ループで外部が版を強制しない ②2025-11-25 は有効なリビジョンで
  あり版ネゴシエーションがある以上「壊れた」わけではない ③Claude 側の打ち切り日は未告知で、今回 **feature
  lifecycle policy(最低12ヶ月の非推奨ウィンドウ)が明文化された**のはむしろ安心材料 ④締切前日の大改修 +
  本番 deploy はデモを壊す唯一の現実的な経路。
- **予防措置(発表まで)**: `bun install` を走らせない(`@modelcontextprotocol/sdk` は `^1.29.0` のレンジ指定。
  lockfile は commit 済みだが再解決すると上がりうる)。
- **見積もりの下方修正(2026-07-31・Hono 作者のツイートを受けた調査)**: TS SDK **v2** は
  `@modelcontextprotocol/server` + **`@modelcontextprotocol/hono`(公式)** の構成でリモート MCP サーバーを Hono で
  数行書ける(`createMcpHonoApp()` + `transport.handleRequest(c.req.raw, ...)`、`sessionIdGenerator: undefined` =
  ステートレス)。Hono 作者はさらに `app.use('/mcp', mcp(server))` への抽象化案を提示。**caldav は最初から
  この方向と一致している**: `src/presentation/mcp/server.ts:43` で `@hono/mcp` の `StreamableHTTPTransport` を使い、
  同ファイル 12〜20 行のコメントどおり「Workers ではグローバルに接続済みサーバーを溜め込まない」理由で README
  サンプルから意図的に外れ、リクエストごとに `McpServer` / `transport` を new している(= 実質ステートレス運用。
  principal をクロージャ束縛できる利点も込み)。**よってステートレス化の移行コストは当初見積もりより大幅に小さい。**
- **残る重い部分**: `server/discover` 実装 / 全 result への `resultType` 付与 / `subscriptions/listen` /
  **ext-apps の extensions 宣言**(MCP Apps が正式に versioned extensions framework に載った = 本プロジェクトの
  路線が標準化側に追認された。ただし initialize 廃止で capabilities 申告の場所が変わるため、カード UI の要である
  ext-apps の宣言経路は要確認)/ list 系の `ttlMs`・`cacheScope` / DCR → CIMD(memory の「OAuth は近い将来の
  高優先」と合流)。発表資料側の扱いは `swift-mcp-app/docs/presentation-plan.md` §4.6。

## CalDAV プロトコル適合(2026-08-01 是正5件 + 未着手課題)

**是正5件(実装済み・`make check` 緑 = bun 1105 / worker 42。未コミット・未デプロイ)**:
(a) 未対応 REPORT の応答を 404 → **403 + `<DAV:error><DAV:supported-report/></DAV:error>`**(RFC 3253 §3.6/§1.6 を
原文照合。`docs/rfc/rfc3253.txt` を新規スナップショット追加)(b) `principal-search-property-set` REPORT を実装
(RFC 3744 §9.5。200 で返す。`principal-property-search` 未実装のため空集合で返す判断)(c) `.well-known/caldav` の
301 に `Cache-Control: no-cache`(RFC 6764 §5 の SHOULD)(d) **【重要】404 propstat のプロパティ名が壊れていた
バグを修正** — 要求された名前空間が全部 `DAV:` に潰れ大文字が小文字化されていた(例 `{apple-ical}calendar-color`
→ `<d:calendar-color/>`、`{caldav}schedule-default-calendar-URL` → `<d:schedule-default-calendar-url/>`)。
5名前空間すべて・principal/home/collection すべて・PROPFIND と REPORT の両方で再現(RFC 4918 §14.22 違反。
200 propstat 側は正しく 404 側だけが別経路で名前を組み立てていたのが原因)。**iOS 26.5 は現状これを許容している
(実測)ので「証明された iOS 破壊」ではなく仕様違反 + 潜在リスクという扱い。** (e) `valid-sync-token` の名前空間を
CalDAV → `DAV:` に修正(RFC 6578 §3.2)。

**deploy 前に確認すること(未実施)**: 既存アカウントが古い 301(`no-cache` 無し版)をキャッシュ済みの可能性 /
principal への PROPFIND で `supported-report-set` が 404 propstat → 200 propstat に変わる(挙動が変化する箇所)。

**調査手法(確立・今後も使える)**: Apple 公式リファレンス実装
`/Users/gigun/ghq/github.com/apple/ccs-calendarserver` の `simplugin/caldavclient.py`(Apple 自身が「実クライアントは
こう動く」とモデル化した負荷シミュレータ・リクエストボディ 78 本)を棚卸しし、約 45 本を本番へ実際に当てる総当たり。

**検出した未着手課題(2026-08-01・次の着手候補)**:
1. `expand-property` / `principal-property-search` / `calendarserver-principal-search` が principal で 404
   (principal ルートに REPORT ハンドラが無い)。**`expand-property` は OS X が毎回のポーリングで投げる経路。**
2. PROPPATCH の未対応プロパティ応答に status も propstat も無い(RFC 4918 §14.24 の DTD 違反)。
3. `Depth: infinity` を黙って Depth 0 扱いして 207 を返す(RFC 4918 §9.1 の SHOULD は 403 + `propfind-finite-depth`)。
4. calendar-home への `sync-collection` が 404。
5. **sync token にリクエストホストが埋まっており、入口(workers.dev / Cloud Run)を変えると全同期が走る**
   (データ喪失はしないが full resync コストが発生)。
6. `.well-known/caldav/`(末尾スラッシュ)が 404。Apple のモデルはこの形を使う(iOS 26.5 はスラッシュ無しなので低優先)。
7. object 宛 `calendar-multiget` が 405(RFC 4791 §7.9 は object 宛も対象と明記)。
8. **200 propstat 側の照合が名前空間を見ていない**(`<foo:calendar-home-set xmlns:foo="urn:bogus"/>` を要求すると
   CalDAV の値が 200 で返る)。直すには props Record のキーを (ns, local) 対に変える必要があり全プロパティ定義に
   波及する = **別タスク相当**(1〜7 とは規模が違うので分けて起票する)。

## iOS / Simulator 検証

- **初回アカウント追加バグの切り分け(2026-08-01・サーバー無罪で確定)**: まっさらな Simulator では CalDAV
  アカウントの初回追加が必ず失敗する(iOS 側の挙動)。ユーザー追加アカウントが1つも無い端末では、サーバー検証は
  通るのに「カレンダー/リマインダー」トグル一覧が空になり、保存するとデータクラス0個の「停止中」になる。
  **他社サーバー(Vikunja のデモ)でも再現**したことで切り分け完了(7月の実機検証は既存アカウントが1つ以上ある
  端末だったので一度も当たらなかった)。
- **回避策(実測で確定)**: `xcrun simctl openurl <UDID> 'webcal://<公開ics のURL>'` で**照会カレンダーを先に1つ
  入れる**(4タップ・テキスト入力ゼロ)と CalDAV の初回追加が通る。端末を温めるのに CalDAV である必要はなく型の
  違う `SubscribedCalendar` で足りる(**システム管理の `HolidayCalDaemonAccount` では温まらず、ユーザー追加の照会
  カレンダーで温まった**ことを `sqlite3` で直接確認)。**`.mobileconfig` はアカウント投入に使えない**ことも確定
  (アカウント系ペイロード全般が Simulator でアカウントを作らない。CalDAV 固有ですらない)。種デバイス
  `CalDAV-Seed-webcal` を残置 — 以後 `xcrun simctl clone` で **16.7秒・0タップ**で CalDAV 付き端末が複製できる。
  詳細は `docs/modeling/06-ios-behavior-verification.md`。
- **iOS 実機検証の残項目(ユーザー作業)**: カード内操作の目視(キーボード出現 / コピー / agenda ラベル /
  C4 編集 / リスト選択 / 月ビュー・日ビューのセル比率と月送り体感)/ geo 無しイベントの iOS 表示(LOCATION の
  `title\naddress` 改行形式)/ search-location 経由の場所付き予定作成の一気通貫 / 移動時間・通知の表示 /
  J-4 の calendar・tasks 非回帰(allprop sync-token 除外の念押し込み)。
- **R2 由来の iOS 検証項目**: 同一 URI の changed 再出現時の再取得挙動 / 同一 ETag 再出現時のキャッシュスキップ
  (問題があれば SEQUENCE / DTSTAMP で ETag を変える逃げ道)/ restore 後の再スキャン発火。
- **カード内 swipe 削除の UI 経路は未検証のまま**(todos 詳細に削除ボタンは無く swipe のみ・browser では touch
  swipe を再現できない。免除トークンのサーバー契約は mcp-server.test.ts で検証済み)。

## swift-mcp-app への申し送り(別リポ・Desktop セッションへ移管済み)

**分担**: swift-mcp-app 側タスク(実機検証・C6/C7・M2 残論点ほか)は Claude Desktop セッション + 同リポの正典へ
全面移管。caldav 本体はこちらのセッション系で進める。申し送りは swift-mcp-app/docs/next-directions.md に追記済み。

- **責務分界(ユーザー裁定)**: **ホストは仕様の正道のみ実装し、カードを甘やかす補正魔法(自動スクロール・
  キーボード連動)を持たない** — 持つと汎用 MCP ホストではなく「caldav カード専用ビューア」に堕ちる。カード側も
  ホストのスクロール挙動を一切前提にしない。
- **#34 系**: R4 の annotations 駆動 per-tool 許可ゲート / fullscreen でキーボードが勝手に閉じる /
  スクロール過剰発火 / `safeAreaInsets` の正道申告(実測ログを取る)。
- **#41 改(履歴カードの fail-closed ゲート = hint プロトコル)は撤去推奨**: ①ホスト固有プロトコルでは
  サードパーティカードが全滅(汎用ホスト不成立)②RFC 5861 の SWR 思想(stale を出して背景検証)の逆
  ③ext-apps に標準化の足場が無い ④カード操作は封鎖に見合う不可逆・高リスクではない。ホストの責務は素の
  focus/visibility イベント配送のみ(それが無くてもカードの `generatedAt` 判定だけで成立する)。
  **caldav 側の hint 対応は不要と裁定。**
- **iOS 描画失敗の切り分け結論(diag-card の役目)**: 正体は claude.ai iOS のカード描画パスの token 未 refresh
  (TTL 1時間失効後 401 invalid_token →「サーバーに接続できません」。web は refresh する)。コネクタ再作成で復旧。
  **サイズ説は棄却。** 既知 issue claude-ai-mcp#228(proxy パスの refresh 未実装)と同根。diag-card は Anthropic
  報告の再現材料として当面残置し、報告完了後に撤去(#47 で同梱コミット済み)。副産物: iOS レンダラーは
  ui/initialize ハンドシェイク無しの素 HTML も表示するが、web は初期化完了まで非表示(diag-card が web で出ない理由)。
- **OAuth ベスプラ調査の caldav 側帰結**(swift-mcp-app/docs/design/08 が正典・出典付き): `accessTokenTTL` は既定
  3600s を維持(**TTL 延長で iOS バグを凌ぐ案は却下** — blast radius 拡大・根本原因隠蔽・TTL 超過で再発)。
  refresh rotation は workers-oauth-provider が仕様準拠実装済みで変更不要。**確認事項2点**: refresh token 失効時に
  RFC 6749 準拠の `invalid_grant` を返すこと / 401 に `WWW-Authenticate: Bearer resource_metadata="..."` が付くこと。
- **HOLB 修正(2026-07-17・swift 側 91f801b・未 push)**: 「FAB 追加のシマー中だけ FAB 下に余白が出る」件は
  **caldav 無罪**(カードは commit の 16ms 後に真の高さへ収束・44ms 後に size-changed 送信済み。実機 Safari Web
  Inspector で計測)。真因は `AppsBridgeSession` の受信ループが in-flight の tools/call の実サーバー往復(~730ms)を
  await し切るまで直後の通知を処理できないこと(size-changed 限定でなく全通知/request が詰まる構造問題)→
  `.passthrough` を追跡付き Task に非直列化(typed/response レーンは直列維持 = initialize ゲート/teardown 相関を
  守る・passthrough 応答は id 相関で順不同 OK)。実機再計測 ~730ms → ~100ms。caldav 側のトレーサは撤去済み
  (e4c8ff5)で恒久変更ゼロ。残: 余白の残り時間は host の easeOut(0.3s)縮小アニメのみ
  (`InlineCardView.swift:123`・任意の意匠見直し S4)。

## 方向性 A: M2 マルチユーザー

- **発端**: 現状は単一ユーザー Basic(secrets 直)。B(招待)と Swift SaaS 化の前提。secret 消失障害
  (2026-07-10)の本質解決(D1 salt 付きハッシュ)。
- **確定方針**(docs/modeling/07): Basic over HTTPS + App Password(32文字級サーバー生成 → ハッシュは
  SHA-256/PHC 確定・レート制限つき)。iOS アカウント追加は .mobileconfig 配布(ワンタイム URL・HTTPS 必須)を
  想定していたが、**2026-08-01 の実測で .mobileconfig ではアカウントを作れないと判明**したため配布手段は要再検討。
- **アイデンティティ層(docs/modeling/13 が正)**: マルチユーザーには「誰がどこでサインアップして principal を
  作るか」が要る(ユーザー指摘で判明した"上の階"問題。当初の A-1 設計は App Password という"下の階"だけだった)。
  CalDAV は iOS が Basic しか喋れない宿命で認証は必ず2階建て。採用 = **自前・SIWA ファースト**(better-auth は
  seam 裏の将来オプション・Firebase 却下)。認証は上 = IdentityPort / 下 = App Password。分析は AnalyticsPort 分離で
  Firebase のバンドル加点は消える。**次の実装スライス(承認後)**: users テーブル + FK(principals / app_passwords →
  users)+ IdentityPort 型定義を migration に。SIWA 検証アダプタは companion アプリ計画に合わせて後。未確定の
  製品判断は modeling/13 §9。
- **タスク分解**: A-1 スキーマ + principal 複数化(**D の権限表 = current-user-privilege-set の実データ化を織り込む**・
  R-7 は完了済みなので単独で進めてよい)/ A-2 認証ミドルウェア差し替え / A-3 App Password 発行 + 配布 /
  A-4 プロキシ内部認証を HMAC 署名へ(OSS 公開時までに)。
- 週開始曜日(this-week / next-week の起点)は user 設定への昇格候補(現在は日曜固定ハードコード。
  `application/time/relative-range.ts`)。

## 方向性 H(購読カレンダー・外部集約)【E/A の後・優先度中】

- iOS の `source` / `subscribed-strip-*` / `apple:refreshrate` 対応 = webcal 購読の読み取り取り込み。
- free-busy の本質(09 §3): 生活が iCloud/Google に分散するユーザーには (c) **agent 側横断**(iCloud は CalDAV +
  app-specific password で正規アクセス可)。「CalDAV client for agent」を汎用化し agent が横断合成 —
  **E の設計に吸収**(独立フェーズにしない)。

## 方向性 K: メール統合(iMIP・予定抽出)

- 一次資料 docs/modeling/10。B(招待の iMIP)と E(メール起点タスク)の共通基盤。Cloudflare は送受信両対応
  (受信 = Email Workers / 送信 = Email Service beta)。「REPLY 受信 → iTIP 処理」をキット内で完結できるのは
  OSS 差別化点。
- K-1: RFC 6047 原文スナップショット(B 着手前必須)/ K-2: 送信ポート(Cloudflare / Resend アダプタ)/
  K-3: Email Worker 受信 → ProcessIMipMessage UC / K-4: 抽出 UC(ICS 添付 → schema.org → LLM 提案 inbox)/
  K-5: Siri マークアップ申請(将来・加点)。

## 方向性 B / C / D / I / F

- **B: M3 スケジューリング(招待)** — RFC 6638/5546。schedule-inbox/outbox・iTIP・auto-schedule。B9 実測どおり
  iOS の招待 UI の前提。方向性 A + K-1/K-2 が前提。外部宛は iMIP。ドメインの輪郭は docs/modeling/03 §3。
- **C: M4 他クライアント対応** — 中核は G-3 + tsdav CI ハーネス ✅ で担保済み。残る広げ方(Thunderbird 等・
  広いプロパティ照合)は必要時に。
- **D: M5 共有・委任** — caldav-proxy / calendarserver-sharing(Apple 拡張)。A が前提。権限表スキーマは A-1 に
  織り込み済み。
- **I: CardDAV / 連絡先(構想段階)** — 招待相手の解決・記念日の仮想イベント化。WebDAV/content-line 基盤は流用可。
  最後に着手。着手前に RFC 6352 スナップショット + iOS 実機観測。
- **F: M7 運用(横断関心事・フェーズではない)** — 上限系 precondition・監視・バックアップ・rate limit。各
  マイルストーンの Definition of Done に「rate limit / 上限 precondition の該当分」を含める。Swift SaaS 化時の
  LLM プロキシ(メータリング・プラン出し分け)もこの系譜(caldav 本体外)。

## Swift クライアント(別リポ swift-mcp-app・旧 caldav-companion)

- 授業の Swift アプリ = **MCP 入口第3号**(DAV・claude.ai に次ぐ)。swift-sdk(HTTPClientTransport + OAuth 2.1
  フル対応)で本番 `/mcp` にそのまま接続でき **caldav 側の変更ゼロで着手可**。コア価値は「iOS 汎用 MCP Apps ホスト
  (路線B)」に転換済みで、caldav 側の関与は R-6 ✅(前提整備)と契約の正(server.ts / modeling/12)の維持のみ。
- 構成方針: ①MCP クライアント(swift-sdk)②LLM オーケストレータ(授業は BYOK、SaaS 化時は薄い LLM プロキシ
  Workers を課金の関所にしてフリーミアム/サブスクで回収 — ユーザーは Claude サブスク不要)③UI は EventKit でなく
  **MCP 直**(TodosViewModel / EventsViewModel 契約の SwiftUI ネイティブ描画 = 共有カーネルの3つ目の消費者)。
- MVP フェーズ: 接続(OAuth + tools/list)→ リマインダー UI → チャット(tool-use ループ)→(余力)カレンダー。

## レビュー起票の残(2026-07-13 Codex レビュー。R-1〜R-6 は是正 ✅・詳細は git 履歴)

- ~~R-6(OAuth scope 分離)~~ ✅ / ~~R-7(CAS)~~ ✅ — いずれも「今日までに完成しているもの」参照。
- R-8(反復完了の非原子 2PUT)は**不採用**(iOS D4 忠実再現の設計判断・失敗モードは安全側)。deterministic
  snapshot UID の名残だけ R-7 に同梱済み。

## デプロイ後の claude.ai 反映運用(2026-07-17 確定・キャッシュバスティング機構 cc0525f)

- **通常のデプロイ(ツール追加・パラメータ変更・カード UI 変更など)= 何もしない。** claude.ai のツール定義
  キャッシュ(層A)は TTL 約1時間で自動最新化され、カード UI(層B・`ui://` リソース)は content-address 化
  (HTML の FNV-1a hash を URI に埋め込む・旧 URI エイリアス併設で自動伝播)により URI 自体が変わるので即座に
  伝播する(`src/presentation/mcp/ui/content-hash.ts` / `todos-app.ts` / `agenda-app.ts`)。
- **即時反映が要る場合・破壊的変更・TTL バグで1時間超 stale が続く場合** = コネクタの接続 URL を `/mcp/vN` →
  `/mcp/v<N+1>` に差し替えて OAuth 再同意する(`createMcpApp` の `/:version` ルート。版セグメントに意味は無く
  純粋なキャッシュバスト用で `v2` でも日付文字列でもよい)。URL が変わると層A のキャッシュキーも変わる。
  検証済み: `/mcp/v2` 401 疎通・`/.well-known/oauth-protected-resource/mcp/v2` 200(RFC 9728 パス metadata OK)。
- **「再接続」操作だけに頼らない** — claude.ai は「切断 → 再接続」しても内部キャッシュが必ずしもクリアされない
  報告がある(claude-ai-mcp#137。TTL 超過で無限 stale になるバグも公式認知 #137/#45)。確実な脱出口は URL 変更。

## 小粒の残タスク(方向性に属さない申し送り)

- **`make dev` が起動しない(2026-08-01 発見・未調査)**: custom build の watch が「`*-bundle.ts` を再生成 →
  変更検知 → 再ビルド」の無限ループに入る。同日2つのエージェントが独立に踏んだ。開発体験を直撃するので優先度は
  高いが原因未特定。
- **Hono ログの OpenTelemetry 計装(2026-08-02 起票・検討中・ユーザーが「やりたい気がする」)**:
  [記事](https://azukiazusa.dev/blog/instrument-hono-logs-with-opentelemetry.md)。Pino +
  `@opentelemetry/instrumentation-pino` でログにアクティブスパンの Trace ID / Span ID を自動付与し Grafana Loki
  (ログ)⇄ Tempo(トレース)を相互参照する手法。**要検証**: 記事は Node.js ランタイム前提
  (`@opentelemetry/instrumentation-http` / `sdk-node` の自動計装は Node の module hook 依存)で、Cloudflare Workers
  (V8 isolate・Node API 非搭載)でそのまま動くかは未確認 — `@microlabs/otel-cf-workers` 等の代替が必要になる可能性が
  高い。caldav は既に観測基盤 v1 を持つため、OTel は置き換えではなく「トレース ⇄ ログの相関」を上乗せする価値が
  あるかを Workers 対応状況とセットで判断する。**ユーザーの着眼点**: OTel 形式で取ること自体の価値は「ベンダーに
  依存しないログ形式」— 今の観測基盤 v1 は Analytics Engine 直結で Cloudflare ロックインだが、OTel なら Grafana /
  Honeycomb / Datadog など好きなバックエンドへ差し替え可能(将来の OSS「CalDAV サーバーキット」化とも相性がよい)。
- UI v3 の実機確認(claude.ai / iOS アプリ): 選択 → 編集 → 詳細ページ → chips → ドラフト行 → スワイプ削除。
  小 nit: placeholder「メモを追加」と同値の実データが見分け不能(実害軽微・必要なら placeholder 文言変更で対処)。
- `completeRecurringTodo` のゾーン変更エッジ / 全日 → 時刻付きで VALARM を新規生成する是非(要望待ち)。
- **本番データの掃除が未了**: テストコレクション重複2件 / 2026-07-15 の検証由来かもしれないイベント
  (「移動時間(30分)」「ミーティング」の重複)— ユーザーの意図物か確認してから消す。
- chrome-devtools 検証手順の docs 化(D1 座標を含むため git 化の是非は要判断。memory → docs 移送 #30 の残り)。

## 長期の着手順(2026-07-11 確定・DDD 戦略設計)

松岡 DDD のコアドメイン蒸留で A〜K を分類(根拠と分類表は **docs/modeling/11 §1**):
コアドメイン = **G / J / E**、支援 = B / K / C / H / I、汎用 = **A** / F。

1. ~~**G(意味計算)**~~ ✅
2. ~~**J(採択途中 RFC)**~~ ✅(J-4 の iOS 非回帰確認のみ保留)
3. ~~**E(agentic 入口)**~~ ✅ E-1〜E-3 完了(A より先行着手した)。派生スライスは上記カード節が正。
4. **A(M2 マルチユーザー)** — B/D/E 実運用と Swift SaaS 化の前提。**次の大きな山。**
5. **K-1〜K-3 → B(招待)** — K-1 は B 着手前必須。K-2/K-3 は B と E の共有カーネル。
6. **C → D → H → I** — C の tsdav ハーネスは前倒し完了 ✅。H は E の設計に吸収。I は最後。
