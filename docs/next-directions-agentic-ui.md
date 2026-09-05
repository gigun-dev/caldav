# 次セッション詳細カタログ: agentic / カード UI

> `docs/next-directions.md` の頭から分離した詳細カタログ。計画・裁定・ボツ案を保持する。
> 現在の完了・未完了判定と着手順は、常に `docs/next-directions.md` の頭を正とする。
> 本文には各時点の記録を残すため、過去時点の未コミット・未デプロイ表記も履歴として保持する。

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
# 配色監査の残項目

2026-09-06: テーマ接続・配色の主修正はe905642で本番反映済み。[配色監査](card-color-audit-2026-08-02.md)の未使用トークンA-4は今回の対象外で、完了扱いにしない。fullscreen/FAB・キーボードの実機バグ2件も引き続き未解決。
