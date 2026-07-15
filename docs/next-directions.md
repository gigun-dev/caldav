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
  **claude.ai コネクタの再接続**(旧ツール定義キャッシュ解消 — move-todo と update の新パラメータを
  モデルに見せるため)もユーザー操作待ち。
- J-4: iOS 実機での calendar/tasks 非回帰(allprop sync-token 除外の念押し込み)。
- completeRecurringTodo のゾーン変更エッジ / 全日→時刻付きで VALARM 新規生成の是非(要望待ち)。
