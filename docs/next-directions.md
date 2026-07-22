# 次セッションの方向性(2026-07-15 棚卸し・第4版)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする(積層を本文に溶かし込む。第4版 = E-2 実質クローズ + E-3 着手を機に棚卸し。
> 第3版までの積層の生記録は git 履歴と docs/log.md にある)。
> 時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。

**現在地(2026-07-15 棚卸し)**: **E-2(todos の MCP App)クローズ ✅** — UI v3(a53f0be)の
本番検証が全項目 PASS(ページ遷移/トーン/繰り返し chips→D1 裏取り/ドラフト行/後始末。
v2 の3バグ再発なし)。残るはユーザー実機の操作感確認のみ(クローズを覆す性質ではない)。
サーバーは todo 系フル装備: update-todo に recurrence/location・move-todo・小粒是正
(slug UUID fallback / recurrence strict / 孤立 VTIMEZONE 掃除 / sync レンズの edited 除外)まで済。
**進行中**: E-3 S1(VEVENT 4 ツール+Event DTO — 設計は docs/modeling/12 が正・artisan 実装中)。

> **2026-07-15 更新: E-3 実装完了・本番検証 PASS。** S1(4ツール+URL・db9664a)→
> S1.5(通知×2=開始相対 VALARM+移動時間 X-APPLE-TRAVEL-DURATION・07e2c14)→
> S2(アジェンダカード+共有カーネル ui/format・ui/recurrence 抽出・781c705)。ツール19本。
> 本番検証(main 直検証): アジェンダカード描画 PASS(期間ヘッダ・日付見出し・時刻2段・
> video/📍/⟳ アイコン)、D1 バイト照合 PASS(VALARM -PT10M/-PT60M・TRAVEL PT15M・URL・
> VTIMEZONE)、delete-event の removed スナップショット契約 PASS。todos カードも lucide
> アイコン化+選択 UI 是正3点(136144c)。**残る実機確認**: カード内操作(詳細ページ・
> chips・ドラフト行 — iframe は automation 不可)と iOS の移動時間/通知表示。
> カレンダーに検証由来の可能性があるイベント(「移動時間(30分)」「ミーティング」重複)が
> 残っており、ユーザーの意図物か確認して掃除する。
> **2026-07-16 更新: 操作フィードバック統一ドクトリン v2(§7.8)実装進行中。**
> F-1(共有カーネル ui/feedback.ts)+ F-2(todos: pendingIds を Map<id,startedAt> 化・
> committing 状態機械・wake-sweep infinite→1・ring/opacity-pulse×1・T_hard バナー・
> reduced-motion)+ S-E 統合(Done 右上・title 垂直ズレ固定)を完了・コミット(b8013de)。
> delete の committing 演出のみ既存の即時削除設計と両立せず見送り(申し送り済み)。
> **F-3(agenda 移植)完了(0043ba5)**: 楽観は F-2 と同型。悲観パス(反復イベントの日時/
> recurrence 変更 → 満了後に静的「保存中…」タグ)を新規実装。悲観 pending はマスター id キーで
> 反復の全 occurrence にヒットするため seenAffectedIds 集約で先頭行のみ表示(レビュー修正)。
> **F-1〜F-3 で UI 実装は一巡**。設計の正は docs/modeling/12 §7.8。
> **計器 follow-up 未着手**: {mcpTool,ms,colo} console.log は observability で field 未インデックス
> → Analytics Engine writeDataPoint 化を別スライス起票(下記カタログ候補)。
>
> **2026-07-16 追加更新(実機 FB 第2波 → v2.1 + ツール設計2件)**:
> - **v2.1 デプロイ済み**(809236c/9d05a2e/d360b82): done アニメ寿命分離(animUntil)+視認性強化・
>   タグ縦位置・優先度色・「保存中…」撤去・追加ピン。**単発追加へ修正(0a29d0e)**: 連続追加は誤解で、
>   FAB→1件→完了でその場シマー・空ドラフト残さないのが正(元の違和感の本丸)。
> - **#3 list-todos silent drop(15f214b)**: calendarId 省略時に otherTodoCollections で「他にもある」を
>   応答側から伝える(D 案・Fable 調査)。events は元から横断既定・todos は単一前提なので B は見送り(可逆)。
> - **時刻グラウンディング(bb1277c)**: list-events-expanded/get-freebusy に相対レンジ enum
>   (today/tomorrow/next-7-days/next-30-days)+ range 時 TZ 必須 + resolvedRange エコー。get-current-time の
>   2往復を解消。resolveRelativeRange は application/time の DST 安全純関数。get-current-time 存置。
> - **follow-up**: delete committing 演出 / 計器 AE 化 / **list-todos due 相対レンジ**(語彙統一)/
>   **#3 スライス2(カード「他に○件」描画)・3(Task per-item calendarId → 横断集約 B)** / #11 iOS URL・CONFERENCE。
>
> **2026-07-16 v2.2(実機FB第3波)**: 統括原理「振り付けはクライアント固定タイマー・サーバー/transport は関与
> しない」。計器で Worker max 4s・10s 超過は claude.ai transport と確定。**item1 T_hard 廃止 / item2 done リング
> pulse-out / item3 位置不変=iOS「手動」モード(positionMemory 完成・add/done で不動・完了はその場・完了済み
> 折り畳みは誕生時完了のみ)/ item4 FAB フロー化**(6d713a6・要実機検証)。**表示順序設定(§7.9・G-1〜G-5)**:
> 手動順=X-APPLE-SORT-ORDER・モード=独自 dead property + D1 カラム(iOS はソートモードをローカル保持=独自で
> 相互運用損失ゼロ)。G-1=iOS の手動並べ替え/モード変更の CalDAV 挙動を Proxyman 観測 → G-4 カード設定 UI → G-5 ドラッグ。
>
> **2026-07-17: 「FAB 追加のシマー中だけ FAB 下に余白が出る」件 → caldav 無罪・真因は host bridge の
> head-of-line blocking(swift-mcp-app)。** caldav 側に一時高さトレーサを入れ実機 Safari Web Inspector で
> 計測(Simulator の WKWebView に接続・要 isInspectable=true・DEBUG 限定)。カードは commit の 16ms 後に
> 真のコンテンツ高へ収束・44ms 後に size-changed 送信済みで無罪。真因は `AppsBridgeSession` の受信ループが
> in-flight の tools/call の実サーバー往復(~730ms)を await し切るまで直後の size-changed 通知を処理できず
> 詰まること(size-changed 限定でなく in-flight tool call の裏の全通知/request が詰まる構造問題)。**対処
> (Fable 設計 → artisan 実装 → 実機再計測で ~730ms→~100ms 確認)= swift-mcp-app 側で `.passthrough` を追跡付き
> Task に非直列化**(typed/response レーンは直列維持=initialize ゲート/teardown 相関を守る・passthrough 応答は
> id 相関で順不同 OK)。swift-mcp-app コミット 91f801b(未 push)。caldav 側はトレーサ撤去済み(e4c8ff5)で
> 恒久変更ゼロ=この件でカード側の作業は無し。残: 余白の残り時間は host の easeOut(0.3s)縮小アニメのみ
> (`InlineCardView.swift:123`・任意の意匠見直し S4)。教訓: 別リポで並行作業がある場合、subagent の未コミット
> 成果は並行セッションのコミットで上書き消失しうる(今回一度 clobber された)→ 早めにコミット/stash で保全。
>
> **2026-07-17 実装ラウンド(Fable 設計 → subagent 実装 → main レビュー・全て可逆/後方互換)**:
> - **キャッシュバスト(cc0525f)**: 「claude.ai コネクタだけカード/ツールが古い」問題。claude.ai は tools/list を
>   TTL~1h でサーバー側キャッシュ(TTL 超過で無限 stale のバグも公式認知 #137/#45)、ui:// も URI 単位で
>   キャッシュしうる(SEP-1865 MAY)。対策2部: ①カード ui:// URI を最終 HTML の FNV-1a hash で content-address 化
>   (`content-hash.ts`・旧 URI エイリアス併設=自動伝播)②`/mcp` に加え `/mcp/:version` を同一ハンドラで受け
>   resourceUri を実パス追従(即時反映の脱出口・URL 変更でどのキー仮説でも fresh)。curl 検証: `/mcp/v2` 401 疎通・
>   `/.well-known/oauth-protected-resource/mcp/v2` 200(RFC 9728 パス metadata OK)。運用: 通常は待つだけ・即時は
>   コネクタ URL を `/mcp/vN` インクリメント。**「再接続」単独は不確実**(#137)。
> - **レイテンシ改善(e569c96)**: observability 実測で list-events-expanded が p50 1.2s・max 2.3s。主因=calendarId
>   省略時に全コレクション(~7)を for-await で直列 D1 クエリ(D1 プライマリ HKG・実行 IAD で ×8)。SQL 0.46ms・
>   9件でパース無罪。横断ループを `Promise.all` 並列化(list-events/get-freebusy)= 直列 8→2 段。要 observability
>   再計測(デプロイ後トラフィック待ち・期待 IAD ~400-500ms)。list-todos は Worker 側既に速い(残りは transport)。
> - **agenda カード fullscreen 対応(f56e6d7 + 6757a07)**: P4-DM を todos から移植(ホスト中立・カードが宣言)。
>   S0=FAB フロー化(.fab-row)/ S1=todos-fold.ts→**fold.ts** 共有カーネル化 / S2=host-context 配線+
>   availableDisplayModes 広告 / S3=行単位畳み(空日見出しペア除去)+「すべて表示」→request-display-mode。
>   畳み単位=行(案A・日グループ案B は budget 浪費でボツ)。computeInlineFit 無改造流用。既定不活性で退行ゼロ。
>   残: S4「・あと M 日」付記(任意)・実機目視。
> - **todos UX 3件(e90bc49)**: ①undo アニメ強化=undo 側だけ circle-drain(塗り→空 drain)追加(done と対称
>   だが空丸で知覚弱かった)②保存/完了二重意味=openCreateSheet の selectedId バグ根治+詳細「保存」→「完了」
>   (作成モードは維持)+「戻る」を保存化(iOS 準拠・破棄廃止)③TZ グラウンディング=症状の真因は read 側 UTC 落ち
>   (create は既に Intl TZ 送信済み)。refreshArgs/全 mutate に viewer Intl TZ 常時付与・サーバー mutate5系の
>   buildTodosViewModel へ timeZone スレッド。**楽観/悲観の現状ネットサマリは modeling/12 §7.8 冒頭に記録済み(9008b9f)**。
> - **[別リポ] swift-mcp-app HOLB 修正 91f801b**: 本セッションで再適用・単一コミット化(clobber からの復旧)。push は
>   ユーザー判断(remote 未設定)。残: S4=host の easeOut(0.3s)縮小アニメ意匠(任意)。
>
> **2026-07-22 更新(レイテンシ実測 ✅ + echo pin 根治 + 月グリッド着地・分担確定)**:
> - **レイテンシ並列化の効果を observability で確認**: 日本経由(NRT/KIX)は list-events-expanded が
>   **2303ms → 325〜351ms(約6.5倍)**。IAD(D1 最遠)は p50 横ばい(min は 763 まで低下=並列化自体は有効・
>   残りは距離×往復)。次段(案2 横断1クエリ化 / 案3 D1 read replication)は日本利用で実害小につき判断待ち。
> - **agenda echo pin 根治(56cbb73)**: 全横断なのに応答が `calendarId:"calendar"` を固定 echo →カードが
>   currentCalendarId に保存→focus refetch が単一へ collapse。対処=全横断時は正直に null echo(単一指定時のみ
>   echo・calendarIds は additive echo)+カード側は「range を名乗る照会応答」のときだけ currentCalendarId を
>   採用(mutate の作成先 echo による再 pin 経路もレビューで検出し遮断)。mutate 系は行由来 ev.calendarId 優先。
> - **② fullscreen ビュー切替+月グリッド(36a8b8d)**: モック agenda-views-v6 準拠。セグメント「リスト|月|日
>   (日=disabled・③で実装)」を fullscreen のみ挿入。6週42セル固定・コレクション色ドット・選択日リスト連動。
>   月算術は ui/format.ts の純関数+bun:test(月/年またぎ・うるう年)。レンジは listRange 退避方式
>   (月ビュー中は currentRange を 42 セル分絶対レンジへ差し替え・inline 復帰で list へ強制リセット)。
>   **残: 実機/Simulator 目視**(セル比率・選択日パネルの収まり・月送り refetch 体感)。
> - **分担確定**: swift-mcp-app 側タスク(実機検証・C6/C7・M2 残論点ほか)は Claude Desktop セッション+
>   同リポ正典(next-directions 2026-07-22 棚卸し節)に全面移管。caldav 本体はこのセッション系で進める。
>   iOS 検証は Simulator のカレンダー/リマインダーへのアカウント追加でも可(実機必須ではない)。
> - **次**: ③ 日タイムライン(現在時刻赤線・重なり解決・終日チップ帯)→ agenda echo pin は済 → 確認カード起票。
>   判断待ち: save ボタン文言統一 / IAD 次段 / メモリ→docs 移送(コンテキストの git 管理化)。
**新規**: Swift コンパニオンアプリ(授業)を別リポ `caldav-companion` で開始(方向性 E §Swift 参照)。

**次の優先順位(2026-07-15 確定)**:
1. ~~UI v3 本番検証~~ ✅ 全 PASS → **E-2 クローズ宣言済み**。残: ユーザー実機確認
   (claude.ai コネクタ再接続込み)+ 小 nit(placeholder「メモを追加」と同値の実データが
   見分け不能 — 実害軽微・必要なら placeholder 文言変更で対処)
2. **E-3**: S1(サーバー・実装中)→ S2(アジェンダカード。todos v3 文法の流用)
3. ~~**R-6(OAuth scope 分離)**~~ ✅ — 公開前必須。Swift コンパニオン(第三者クライアント)の前提整備
   としても優先度上昇。E-3 と並行可(認証層で独立)。
   > **2026-07-15 更新: R-6 完了(4eee336)。** claudedav:read/write 分離・語彙と区分は
   > presentation/mcp/scopes.ts に一元化(read allowlist・未分類は write の safe default)。
   > scope は props で運ぶ(apiHandler は ctx.props しか受け取れない — provider 契約)。
   > 旧 grant は grandfather(full access+警告ログ `oauth_grant_without_scopes`)で既存接続を
   > 壊さない。静的 Bearer は full scope 明示。同意画面に権限サマリ表示。E2E 3ケース込み。
   > 既存 claude.ai / Inspector 接続は再接続すると新 grant として厳密強制に移行する。
4. ~~Swift コンパニオン(caldav-companion)の初期設計~~ — 別リポジトリ **swift-mcp-app**(private)
   としてユーザーが別セッションで進行中。コア価値は「iOS 汎用 MCP Apps ホスト(路線B)」に転換済み。
   caldav 側の関与は R-6 ✅(前提整備)と契約の正(server.ts / modeling/12)の維持のみ。
5. 数日後: Smart Placement 効果再計測({mcpTool,ms,colo} ログ)→ 楽観 UI の再評価
   (ユーザー条件「1s 以内なら悲観でも」)・STATUS 列 migration の要否判断。
6. その後 **A(マルチユーザー)+ R-7(CAS)** — 次の大きな山。
   > **2026-07-15 更新: R-7(CAS)完了 ✅(4c12374)。A-1 は上位設計の調査待ちで一時保留。**
   > R-7: UoW の楽観ロックを CAS 化(①CAS UPDATE WHERE sync_counter=baseline → ②sync_changes
   > INSERT → ③自己参照ガード付き object write)。ConcurrencyConflictError → 412。CalendarCollection
   > に baselineSyncCounter 追加。R-8 名残(snapshot UID の deterministic 化)も同梱。
   > **A-1 の"上の階"問題(ユーザー指摘)**: マルチユーザーには「誰がどこでサインアップして
   > principal を作るか」= アイデンティティ層が要るが、architect の A-1 設計は"下の階"(App Password)
   > だけだった。CalDAV は iOS が Basic しか喋れない宿命で認証は必ず2階建て(上=アイデンティティ/
   > 下=App Password)。**アイデンティティ戦略(自前 better-auth vs 外部 IdP・SIWA の位置づけ・
   > 分析要件・MCP OAuth との統合)を Fable architect が調査中**。結論が出てから A-1 スキーマの
   > アイデンティティ列を確定する(調査→設計の順序を守る)。ハッシュは SHA-256/PHC 確定(modeling/07)。
   > **2026-07-15 追記: アイデンティティ戦略の調査完了 → docs/modeling/13 に設計の正を確定。**
   > 採用 = 自前・SIWA ファースト(better-auth は seam 裏の将来オプション・Firebase 却下)。
   > 認証は2階建て(上=IdentityPort/下=App Password)。分析は AnalyticsPort 分離で Firebase の
   > バンドル加点は消える。ユーザー選択で「まず docs 化」→ 完了。**次の実装スライス(承認後)**:
   > users テーブル + FK(principals/app_passwords → users)+ IdentityPort 型定義を migration に。
   > SIWA 検証アダプタは companion アプリ計画に合わせて後。未確定の製品判断は modeling/13 §9。

## 今日までに完成しているもの(前提)

- **iCalendar ドメイン層**(RFC 5545): 構造層 + 値型コーデック + 意味論レンズ + 不変条件 I1〜I10。ロスレス往復。
  VJOURNAL(J-1)・ical-tasks/9253 読み取りアクセサ(J-3)・VTODO 書き込み経路(builder/patch/stamp。
  location・RRULE 全置換/除去・孤立 VTIMEZONE 掃除込み)。
- **CalDAV リソース層**: 3集約 + put-preconditions R1〜R7 + If ヘッダ(sync-token 条件)サブセット。
- **意味計算(G)✅**: TZ 解決層 / RecurrenceExpansion(ical.js port&adapter)/ occurrence 索引 +
  time-range / free-busy。
- **フルスタック稼働**: 本番 = Worker `caldav.gigun-dev.workers.dev` + Cloud Run 書き換えプロキシ
  (iOS 正式入口・恒久構成)。deploy = Workers Builds が main push で migrate→deploy 自動。
- **MCP サーバー**(`/mcp`): **14 ツール** = 照会3(get-current-time / list-events-expanded /
  get-freebusy)+ todo 7(create/creates/list/update/complete/delete + refresh[app])+
  calendar 3(list/create/delete)+ move-todo。OAuth(workers-oauth-provider)本番実機受け入れ済み。
  DAV と MCP が同じ UC を呼ぶ複数入口ビジョンは実証済み。
- **MCP Apps(E-2)= todos カード v3**: 一覧=走査面(becoming ラベル meta 右端・📍/⟳)/
  行タップ=選択(インライン編集・選択解除=自動保存)/ ⓘ=**カード内ページ遷移**の詳細
  (裸 input・繰り返しプリセット chips 行下展開・リスト›でコレクション移動)/ FAB=インライン
  ドラフト行(Enter 連続追加)/ 削除=左スワイプ。楽観更新+失敗ロールバック+バナー。
  becoming 差分(sync レンズは added/completed/reopened/removed のみ・edited は捨てる)。
  **UI モックの設計変遷は docs/modeling/ui-mockups/(README 索引付き)**。
- **テスト2レーン**: bun test + vitest-pool-workers。tsdav CI ハーネス込み。CI = 層境界 → tsc → 両レーン。
- **iOS 実機検証**: カレンダー3ラウンド + リマインダー D/V 系(docs/modeling/06)。shake-undo は
  サーバー側 RFC 6578 準拠を実測で確認済み(バグ無し)。

## 着手順(2026-07-11 確定・DDD 戦略設計/2026-07-15 進捗反映)

松岡 DDD のコアドメイン蒸留で A〜K を分類(根拠と分類表は **docs/modeling/11 §1**):
コアドメイン = **G / J / E**、支援 = B / K / C / H / I、汎用 = **A** / F。

1. ~~**G(意味計算)**~~ ✅
2. ~~**J(採択途中 RFC)**~~ ✅(J-4 の iOS 非回帰確認のみ保留)
3. **E(agentic 入口)** — A より先行着手し E-1・E-2 完了。E-3(VEVENT)実装中。
4. **A(M2 マルチユーザー)** — B/D/E 実運用と Swift コンパニオン SaaS 化の前提。R-7 と同時。
5. **K-1〜K-3 → B(招待)** — K-1 は B 着手前必須。K-2/K-3 は B と E の共有カーネル。
6. **C → D → H → I** — C の tsdav ハーネスは前倒し完了 ✅。H は E の設計に吸収。I は最後。

**F(運用)はフェーズではなく横断関心事** — 各マイルストーンの Definition of Done に
「rate limit / 上限 precondition の該当分」を含める。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される「頭」(orient 用の
     現在地・完成物・着手順)。以降の方向性カタログはオンデマンド参照(着手する方向性の節だけ
     agent がそのとき読む)。棚卸し時はこのマーカーより上を最新の現在地に保つこと。 -->

## 方向性 G / J ✅(完了・詳細は第3版 = git 履歴)

- G(意味計算)全タスク完了。設計判断は docs/modeling/08 §6。
- J(採択途中 RFC)一区切り。J-4 の残 = iOS 実機での calendar/tasks 非回帰確認
  (allprop sync-token 除外の念押しと合流)。RDATE/EXDATE 付き VJOURNAL はレンズ拡張とセットで別タスク。

## 方向性 E: M6 agentic 入口(長期ビジョン本命)— E-3 実装中

**完了済み(要点のみ。経緯は git 履歴・詳細版は第3版)**:
- OAuth-for-MCP ✅(workers-oauth-provider・DCR→authorize→token・静的 Bearer 併存)。
  暗黙契約: `completeAuthorization({props})` は `{username}` 形 / DCR は
  `token_endpoint_auth_method:"none"` 明示 / `/mcp` は Accept: text/event-stream 必須。
- E-1(VTODO の MCP 完全対応)✅ + E-2(todos カード)✅(v1 トリアージ → becoming 差分 →
  楽観更新 → v2 iOS 借景 → **v3 カード内ページ遷移**へ2日で3世代。頭の「完成しているもの」参照)。
- **E-2 で確立し E-3 以降が流用する資産**:
  - contract: `{tasks, calendarId, timeZone, view?, affected?, removed?, movedTo?}`。
    「view の欠落 = list/refresh 由来でない」が防御の判別シグナル(mutate は view を名乗らない)。
  - claude.ai ホストモデル実測: 1 tool 呼び出し=1カード・push なし・会話復帰は replay のみ
    (再実行なし)→ app 駆動 refetch が正。**iframe はコンテンツ高さに自動リサイズ → fixed+vh の
    オーバーレイ/ポップオーバーは構造的に破綻(v2 の実機バグで実証)。浮遊レイヤーは作らない。**
  - UI ドクトリン: ステートレス・アニメ無し(in-flight シマーのみ例外)・becoming 静的マーキング・
    楽観適用+失敗ロールバック+バナー・位置記憶・選択モデル(行タップ=インライン編集)・
    カード内ページ遷移・インライン chips。
  - mega-SPA 境界: カードが会話からナビ権を奪うか。1意図=1ツール=1テンプレ。WebUI とは
    共有カーネル(contract + 純関数 + コンポーネント)戦略。
- レイテンシ: 計測ログ {mcpTool, ms, colo}(server.ts monkeypatch)+ 往復削減2段 +
  Smart Placement 導入済み。**数日後に再計測**(頭の優先順位 5)。
  実測(07-14): refresh 73ms / update 597ms / list 706ms / delete 2707ms。
  残案: update/delete の点読み経路・STATUS 列 migration。

**E-3(VEVENT ツール+アジェンダカード)— 実装中。設計の正 = docs/modeling/12**:
- S1(サーバー): create-event(+s)/update-event/delete-event + Event DTO + EventsViewModel
  (range echo)。ツール 14→18。→ artisan 実装中(2026-07-15)。
- S2(カード): ui://caldav/agenda.html。todos v3 文法を丸ごと流用 + ui/ 内共有純関数の抽出
  (共有カーネル実践第1号)。S1 完了後に着手。
- 起票のみ(modeling/12 §1): occurrence 単位編集 / VALARM 付き作成 / get-event 詳細カード /
  move-event(move-todo を共用できなければ)。

**Swift コンパニオンアプリ(2026-07-15 起票・別リポ `caldav-companion`)**:
- 授業の Swift アプリ = **MCP 入口第3号**(DAV・claude.ai に次ぐ)。swift-sdk(HTTPClientTransport +
  OAuth 2.1 フル対応)で本番 /mcp にそのまま接続 — **caldav 側の変更ゼロで着手可**。
- 構成方針(2026-07-15 確定): ①MCP クライアント(swift-sdk)②LLM オーケストレータ
  (授業は BYOK、SaaS 化時は薄い LLM プロキシ Workers を課金の関所にしてフリーミアム/サブスクで
  回収 — ユーザーは Claude サブスク不要)③UI は EventKit でなく **MCP 直**(TodosViewModel/
  EventsViewModel 契約の SwiftUI ネイティブ描画 = 共有カーネルの3つ目の消費者)。
- MVP フェーズ: 接続(OAuth+tools/list)→ リマインダー UI → チャット(tool-use ループ)→
  (余力)カレンダー。E-3 の DTO 設計は Swift 消費者を前提に確定済み(modeling/12 §6)。
- caldav 側への影響: R-6 の優先度上昇のみ。

**E-2 の据え置き・降格(実害実証待ち)**:
- becoming の replay nonce(会話復帰でラベル再演)/ sessionStorage 選好復元(パネル再バインド時の
  ビュー選好持ち越し)— claude.ai はカード積みで再バインド無し・実運用で不快が実証されたら。
- V6 Phase 2(DST ゾーンの VTIMEZONE 生成)/ VALARM 管理スライス / 反復 due→DATE の I6 明示エラー。
- WebUI(独立した製品要素)/ WebMCP 実験 / メール起点タスク追加(K-4)。

## 方向性 A: M2 マルチユーザー

- **発端**: 現状は単一ユーザー Basic(secrets 直)。B(招待)と Swift SaaS 化の前提。
  secret 消失障害(2026-07-10)の本質解決(D1 salt付きハッシュ)。
- **確定方針**(docs/modeling/07): Basic over HTTPS + App Password(32文字級サーバー生成 →
  Argon2id/bcrypt で D1 保存 + レート制限)。iOS アカウント追加は .mobileconfig 配布
  (ワンタイム URL・HTTPS 必須)。
- **タスク分解**: A-1 スキーマ + principal 複数化(**D の権限表 = current-user-privilege-set の
  実データ化を織り込む**・**R-7 の CAS 化と同時**)/ A-2 認証ミドルウェア差し替え /
  A-3 App Password 発行 + .mobileconfig / A-4 プロキシ内部認証を HMAC 署名へ(OSS 公開時までに)。

## 方向性 H(購読カレンダー・外部集約)【E/A の後・優先度中】

- iOS の `source`/`subscribed-strip-*`/`apple:refreshrate` 対応 = webcal 購読の読み取り取り込み。
- free-busy の本質(09 §3): 生活が iCloud/Google に分散するユーザーには (c) **agent 側横断**
  (iCloud は CalDAV + app-specific password で正規アクセス可)。「CalDAV client for agent」を
  汎用化し agent が横断合成 — **E の設計に吸収**(独立フェーズにしない)。

## 方向性 K: メール統合(iMIP・予定抽出)

- 一次資料 docs/modeling/10。B(招待の iMIP)と E(メール起点タスク)の共通基盤。
- Cloudflare は送受信両対応(受信 = Email Workers / 送信 = Email Service beta)。
  「REPLY 受信 → iTIP 処理」をキット内で完結できるのは OSS 差別化点。
- K-1: RFC 6047 原文スナップショット(B 着手前必須)/ K-2: 送信ポート(Cloudflare/Resend
  アダプタ)/ K-3: Email Worker 受信 → ProcessIMipMessage UC / K-4: 抽出 UC(ICS 添付 →
  schema.org → LLM 提案 inbox)/ K-5: Siri マークアップ申請(将来・加点)。

## 方向性 B: M3 スケジューリング(招待)

- RFC 6638/5546。schedule-inbox/outbox・iTIP・auto-schedule。B9 実測どおり iOS の招待 UI の前提。
  方向性 A + K-1/K-2 が前提。外部宛は iMIP。ドメインの輪郭は docs/modeling/03 §3。

## 方向性 C: M4 他クライアント対応

- 中核は G-3 + tsdav CI ハーネス ✅ で担保済み。残る広げ方(Thunderbird 等・広いプロパティ照合)は必要時に。

## 方向性 D: M5 共有・委任

- caldav-proxy / calendarserver-sharing(Apple 拡張)。A が前提。権限表スキーマは A-1 に織り込み済み。

## 方向性 I: CardDAV / 連絡先(構想段階)

- 招待相手の解決・記念日の仮想イベント化。WebDAV/content-line 基盤は流用可。最後に着手。
  着手前に RFC 6352 スナップショット + iOS 実機観測。

## 方向性 F: M7 運用(横断関心事)

- 上限系 precondition・監視・バックアップ・rate limit。各マイルストーンの DoD に含める。
- Swift SaaS 化時の LLM プロキシ(メータリング・プラン出し分け)もこの系譜(caldav 本体外)。

## レビュー起票の残(2026-07-13 Codex レビュー。R-1〜R-5 は是正 ✅・詳細は git 履歴)

- ~~**R-6【high・公開前必須】** OAuth scope 分離(read/write + props に scope + ツール別強制 + E2E)。
  AuthenticationPort の seam 内で閉じる。Swift コンパニオンで優先度上昇(頭の優先順位 3)。~~ ✅
  > **2026-07-15 更新:** 完了(4eee336)。詳細は頭の優先順位 3 の更新ブロック参照。
- **R-7【high・A-1 と同時】** ETag/sync counter の TOCTOU → UoW を CAS 型
  (`UPDATE ... WHERE sync_counter = ?` + 0件→412)へ。並行書込みテストを workerd レーンに。
  実装時に R-8 の名残(deterministic snapshot UID で反復完了の再試行重複防止)を軽く入れる。
- R-8(反復完了の非原子 2PUT)は不採用(iOS D4 忠実再現の設計判断・失敗モードは安全側)。

## 小粒の残タスク(方向性に属さない申し送り)

- UI v3 の実機確認(claude.ai / iOS アプリ): 選択→編集→詳細ページ→chips→ドラフト行→スワイプ削除。
  ~~**claude.ai コネクタの再接続**(旧ツール定義キャッシュ解消 — move-todo と update の新パラメータを
  モデルに見せるため)もユーザー操作待ち。~~
  > 2026-07-17 更新: キャッシュバスティング機構実装により運用フロー確定(詳細下記)。通常デプロイは
  > 待つだけでよく、明示の再接続操作は不要になった。

### デプロイ後の claude.ai 反映運用(2026-07-17 確定・キャッシュバスティング機構)

- **通常のデプロイ(ツール追加・パラメータ変更・カード UI 変更など)** = 何もしない。claude.ai の
  ツール定義キャッシュ(層A)は TTL 約1時間で自動的に最新化され、カード UI(層B・ui:// リソース)
  は content-address 化(HTML の hash を URI に埋め込む)により URI 自体が変わるので即座に伝播する
  (`src/presentation/mcp/ui/content-hash.ts` / `todos-app.ts` / `agenda-app.ts`)。
- **即時反映が要る場合・破壊的変更・TTL バグで1時間超 stale が続く場合** = コネクタの接続 URL を
  `/mcp/vN` → `/mcp/v<N+1>` に差し替えて OAuth 再同意する(`createMcpApp` の `/:version` ルート。
  版セグメントに意味は無い純粋なキャッシュバスト用で、`v2` でも日付文字列でも何でもよい)。
  URL 自体を変えることで層Aのキャッシュキーが変わり、確実に最新のツール定義を取得させられる。
- **「再接続」操作だけに頼らない** — claude.ai は「切断→再接続」しても内部キャッシュが必ずしも
  クリアされない報告がある(claude-ai-mcp#137)。確実な脱出口は URL 変更の方であり、再接続は
  補助的な手段として扱う。
- J-4: iOS 実機での calendar/tasks 非回帰(allprop sync-token 除外の念押し込み)。
- completeRecurringTodo のゾーン変更エッジ / 全日→時刻付きで VALARM 新規生成の是非(要望待ち)。
