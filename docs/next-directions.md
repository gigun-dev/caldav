# 次セッションの方向性(2026-07-13 棚卸し・第3版)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする(積層を本文に溶かし込む。今回が第3版 = E-1 完全クローズ + E-2 中盤を機に棚卸し。
> 第2版までの積層の生記録は git 履歴と docs/log.md にある)。
> 時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。

**現在地**: 方向性 G(意味計算)✅・J(採択途中 RFC)✅ が完了。着手順で先行させた
E(agentic 入口)は OAuth-for-MCP ✅・照会 3 ツール ✅・E-1(todo CRUD の MCP 完全対応)✅ まで
クローズし、**E-2(MCP App UI)の本実装スライス②(becoming 差分 UI)まで完了**。
**次のセッションはまず R-1(VJOURNAL hydrate 回帰バグ・「レビュー起票」節参照)を潰し、
その後 E-2 スライス③ / shake-undo 実機キャプチャ / A(マルチユーザー)から冒頭で選ぶ。**
2026-07-13 に Codex 体系レビュー実施 → 裁定は「レビュー起票」節(R-1〜R-8)。

## 今日までに完成しているもの(前提)

- **iCalendar ドメイン層**(RFC 5545): 構造層 + 値型コーデック + 意味論レンズ + 不変条件 I1〜I10。ロスレス往復。
  VJOURNAL(J-1)・ical-tasks/9253 読み取りアクセサ(J-3)・VTODO 書き込み経路(builder/patch/stamp)込み。
- **CalDAV リソース層**: 3集約(Principal / CalendarCollection+SyncChange / CalendarObjectResource)+ put-preconditions R1〜R7。
- **意味計算(G)**: TZ 解決層(IANA 正・Workers ICU)/ RecurrenceExpansion(ical.js を port&adapter で隔離)/
  first/last occurrence 索引(migration 0002)+ calendar-query time-range / free-busy(UC は TZ 非依存の
  BusyInterval[]、iCalendar 化は presentation)。
- **フルスタック稼働**: application / infrastructure(D1) / presentation(DAV XML + Basic Auth + MCP)。
  本番 = Worker `caldav.gigun-dev.workers.dev` + Cloud Run 書き換えプロキシ(iOS 正式入口・恒久構成)。
  **deploy = Workers Builds が main push で migrate→deploy 自動**(package.json `deploy` script。
  前方互換規律は migrations/README.md)。
- **MCP サーバー**(`/mcp`・@hono/mcp ステートレス): 照会 3 ツール + todo 5 ツール(create/list/update/
  complete/delete。単発/反復・VALARM 生成/追随・反復完了は iOS D4 モデル完全再現・時刻付き due +
  VTIMEZONE 生成)。**OAuth(workers-oauth-provider・DCR→authorize→token)本番実機受け入れ済み** +
  静的 Bearer 併存。DAV と MCP が同じ application UC を呼ぶ複数入口ビジョンは実証済み。
- **MCP Apps(E-2)**: list-todos に ui:// UI(ext-apps・自己完結バンドル)。Inspector Apps タブで
  描画・callServerTool の OAuth 認可を検証済み。トリアージ UI(セクション一覧+完了操作+app 駆動
  refetch)+ becoming 差分レンズ(スライス②)まで実機好評。
- **テスト2レーン**: bun test(domain/application 高速)+ vitest-pool-workers(workerd 実 SQL・
  OAuth E2E)。tsdav CI ハーネス(方向性 C 前倒し)込み。CI = 層境界 → tsc → 両レーン。
- **iOS 実機検証**: カレンダー 3 ラウンド + リマインダー(D 系・V 系)完了(docs/modeling/06)。
  A7(RFC 6868 不要)決着。V5(サーバー発 VALARM 通知)・V6(時刻付き due)合格。

## 着手順(2026-07-11 確定・DDD 戦略設計/2026-07-13 進捗反映)

松岡 DDD のコアドメイン蒸留で A〜K を分類(根拠と分類表は **docs/modeling/11 §1**):
コアドメイン = **G / J / E**、支援 = B / K / C / H / I、汎用 = **A** / F。

1. ~~**G(意味計算)**~~ ✅
2. ~~**J(採択途中 RFC)**~~ ✅(J-4 の iOS 非回帰確認のみ保留)
3. **A(M2 マルチユーザー)** — 汎用だが B/D/E 実運用の前提となるボトルネック。
4. **E(agentic 入口)** — B より先と確定(ユーザー判断)。**実際には A より先行着手し
   OAuth・MCP ツール・E-1・E-2 中盤まで完了**(G-5 の勢いを利用)。残りは E-2 の仕上げ。
5. **K-1〜K-3 → B(招待)** — K-1 は B 着手前必須。K-2/K-3 は B と E の共有カーネル。
6. **C → D → H → I** — C の tsdav CI ハーネスは前倒し完了 ✅。H は E の設計に吸収。I は最後。

**F(運用)はフェーズではなく横断関心事** — 各マイルストーンの Definition of Done に
「rate limit / 上限 precondition の該当分」を含める。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される「頭」(orient 用の
     現在地・完成物・着手順)。以降の方向性カタログはオンデマンド参照(着手する方向性の節だけ
     agent がそのとき読む)。棚卸し時はこのマーカーより上を最新の現在地に保つこと。 -->

## 方向性 G: 意味計算(RRULE 展開・TZ 解決・free-busy)✅ 完了

全タスク(G-1〜G-6)完了。一次資料は docs/modeling/08(義務・TZ 流派・コスト)と 09(優先度補正)。
確定した設計判断(08 §6): TZ は IANA tzdb を正・VTIMEZONE は保存のみ / RRULE 反復は ical.js を
アダプタ内側に / sabre 式 first/last 索引を D1 に + REPORT 時にヒット行のみ展開 / 展開上限を API に組込み。

- ~~G-1 TZ 解決層~~ ✅ `src/domain/ical/timezone/`。floating の既定ゾーンは UTC 明示 /
  DURATION は weeks・days=nominal・h/m/s=exact / DST の穴・重なりは絶対 epoch 固定テスト(tzdb 検知線)。
- ~~G-2 RecurrenceExpansion~~ ✅ `src/domain/ical/recurrence/` + icaljs アダプタ。UNTIL は epoch 厳密
  inclusive / detached オーバーライドも結果に含める。
- ~~G-3 occurrence 索引 + time-range~~ ✅ migration 0002(NULL=常に候補・無限反復は 2100 キャップ)、
  SQL 粗絞り + ±24h スラック → 展開して §9.9 判定。未対応 filter は 403 supported-filter。
- ~~G-4 free-busy~~ ✅ FBTYPE 導出 + 同型のみ coalesce。UC 出力は epoch ms の BusyInterval[](MCP と共用)。
- ~~G-5 MCP 照会 3 ツール~~ ✅(E の先鋒。詳細は方向性 E 冒頭)。
- ~~G-6 supported-calendar-component-set~~ ✅(J-2 に吸収。宣言=受理を一致)。

## 方向性 J: 採択途中 RFC への先行投資 ✅ 一区切り

「journal」を安定度で3層に分けて疎結合(①VJOURNAL=確定仕様を素直に ②agentic 日誌コンセプト=
オプトイン・除去可能 ③ical-tasks/9253=読み取り専用・検証なし・string 型)。一次資料 09 §4。

- ~~J-1 VJOURNAL 基盤~~ ✅(migration 0003 / vjournal レンズ / ビジネスルールはレンズに入れない)。
- ~~J-2 宣言是正 + journal オプトイン~~ ✅(MKCALENDAR で VJOURNAL コレクション作成可・自動 provision しない)。
- ~~J-3 ical-tasks/9253 アクセサ~~ ✅(原文スナップショット docs/rfc/rfc9253.txt・docs/specs/
  draft-ietf-calext-ical-tasks-17.txt を取得してから照合。原文が設計メモを複数訂正 — 照合結果は 05)。
- **J-4(保留)**: iOS 実機での calendar/tasks 非回帰確認 + VJOURNAL time-range query 対応。
- RFC 9074 ACKNOWLEDGED は生値保持で充足(06 A9)。VAVAILABILITY(7953)は B のタイミング、
  JSCalendar は変換 draft の RFC 化後(09 §4b)。

## 方向性 A: M2 マルチユーザー

- **発端**: 現状は単一ユーザー Basic(secrets 直)。スケジューリング(方向性 B)の前提。
  secret 消失障害(2026-07-10、log.md)の本質解決でもある(D1 salt付きハッシュへ移行)。
- **確定した方針**(docs/modeling/07): Basic over HTTPS + App Password が業界デファクト。
  32文字級サーバー生成 → Argon2id/bcrypt で D1 保存 + レート制限。OAuth は E で導入済み
  (workers-oauth-provider)— A では DAV 側 Basic の App Password 化が主題。
  iOS アカウント追加は .mobileconfig 配布を正式ルート(App Password 発行 → ワンタイム URL で
  プロファイル DL。平文が入るので HTTPS + 使い捨て URL 必須、署名は後回し可)。
- **タスク分解**:
  - A-1: ユーザー / App Password の D1 スキーマ + principal 複数化。
    **方向性 D の先行準備を織り込む**: コレクション×principal の権限表
    (current-user-privilege-set を実データ化 — ここを逃すと D で手戻り)。
  - A-2: 認証ミドルウェアの差し替え(Argon2id 検証 + レート制限)。
  - A-3: App Password 発行フロー + .mobileconfig ワンタイム配布。
  - A-4: プロキシ内部認証を共有シークレット → HMAC 署名へ格上げ(OSS 公開時までに)。

## 方向性 E: M6 agentic 入口(長期ビジョン本命)— 進行中(E-2 中盤)

**完了済みの土台**(詳細は log.md 2026-07-12〜13 / git 履歴):

- ~~OAuth-for-MCP~~ ✅: workers-oauth-provider(DCR→authorize→token)本番実機受け入れ済み
  (Claude カスタムコネクタ接続 → 3 ツール動作)。静的 Bearer 経路併存。
  **暗黙契約**: `completeAuthorization({props})` には必ず `{username}` 形(OAuthPrincipalProps)を
  渡す(oauth-props-auth.ts が `ctx.props.username` で principal 解決。src/app.ts 参照)。
  DCR は `token_endpoint_auth_method:"none"` 明示必須 / `/mcp` は Accept: text/event-stream 必須。
- ~~deploy×migration 運用ギャップ~~ ✅: 本番ブランチ deploy command = `bun run deploy`
  (migrate→deploy 自動)。非本番は versions upload のまま。規律は migrations/README.md。
- ~~vitest-pool-workers ハイブリッド導入~~ ✅: test/worker/ 第2レーン(D1 実 SQL・OAuth E2E)。
  bun test は無変更。振り分け基準は Makefile・vitest.config.ts のコメント。
- ~~E-1: VTODO の MCP 完全対応~~ ✅(**完全クローズ**): create/list/update/complete/delete。
  語彙は todo 統一・id=UID・共通 Task DTO(UI-ready)。lossless read→patch(VALARM/X-APPLE-* バイト
  保持)・must-match PUT・SEQUENCE 据え置き。反復完了 = iOS D4 モデル(snapshot-first 2PUT・
  マスター前進・VALARM 絶対トリガー同幅前進・最終回も snapshot 均一 = V8 実測)。due 変更で
  VALARM 追随(オフセット保存 shift)。反復 create(frequency none/daily/weekly...・COUNT/UNTIL 排他)。
  時刻付き due + VTIMEZONE サーバー生成(V6 ✅・Phase 1 = 固定オフセットゾーン限定)。
  実機合格: D8・V2・V3・V5(サーバー発 VALARM 通知)・V6・V8。
  **iOS 連携の天井**(06 §D2/D3): フラグ・画像・サブタスク・タグは CalDAV アカウント不可。優先度=1/5/9。

**E-2(MCP App UI・ext-apps/SEP-1865)— 現在の本線**:

- ~~スパイク(描画 + callServerTool 認可)~~ ✅: tdr-concierge レシピ移植(registerAppResource/
  registerAppTool・自己完結バンドル=esm.sh は Claude iOS で壊れる教訓・text 要約 + structuredContent
  二本立て)。Inspector Apps タブで描画・app 専用 `refresh-todos` の OAuth 認可(principal 解決)を検証。
  **注意**: `_meta.ui.visibility:["app"]` でも tools/list には出る(提示ヒントでありプロトコル除外でない)。
- ~~本実装スライス①(トリアージ UI)~~ ✅ `5197a1d`+`678526c`: セクション一覧(期限切れ/今日/今後/
  期日なし/完了折り畳み)+ その場 complete/reopen + 自ゾーン due 整形 + app 駆動 refetch
  (**MCP Apps 仕様はホスト自動更新を保証しない=クライアント依存**が調査確定。app 駆動が正)。実機好評。
- ~~本実装スライス②(becoming 差分レンズ)~~ ✅ `8391f6c`+`d86766c`: **UI ドクトリン確定** —
  ステートレス・アニメ無し・トースト無し。差分は「変化の中間状態(becoming)を静的に」
  (completed=その場で塗り丸+同心リング+取消線 / deleted=破線+畳み / added=左バー+wake /
  edited=インライン旧→新、欠落は編集済みバッジに degrade)。contract =
  `{tasks,calendarId,timeZone, affected?, removed?}`(additive・後方互換)。
- **スライス③(次)**: 優先度表示/編集/削除の UI 化、反復完了 D4 の確認 UX・スヌーズ。
  **2026-07-14 ユーザーフィードバックで追加**:
  - ~~**バグ【view 状態の非保持】**~~ ✅ `7149400`(実機確認は次回: reopen で完了済み維持): includeCompleted:true で Open App → 完了済みを reopen すると
    完了済みが UI から全部消える。原因特定済み — refresh-todos は引数なし(既定 false)・mutate 系
    buildTodosViewModel も既定 false 固定(server.ts のコメントが「親レビューの論点」と自認していた
    まさにその点)。**設計**: contract に `view?`(includeCompleted 等)を additive に echo し、
    UI が view を保持 → refresh-todos に listTodosInputShape を持たせて view 付きで再取得。
    mutate 応答の tasks は既定ビュー固定のままにし、UI は view が既定と違うとき affected/removed
    だけ使って一覧は refresh-todos で取り直す(モデル向け mutate スキーマは汚さない)。
  - **対象リストの明示**: 「リマインダー」だけではどのリスト(コレクション)か不明。UI ヘッダに
    calendarId(将来は displayname)を表示 + モデル向け text 要約にも対象リストを含める。
  - **UI からのタスク追加**: create-todo は registerAppTool 済みなので UI に quick-add を足すだけで
    callServerTool 経由で可能(スライス③の有力候補)。
  - **カレンダー(リスト)作成の MCP 露出**: 現状 MCP に MKCALENDAR 相当ツールは無い(DAV のみ)。
    application に CreateCollection/ListCollections UC は既存なので `list-calendars`/`create-calendar`
    ツールは薄く足せる。対象リスト明示・複数リスト UX の前提としてスライス③〜④候補。
  - **レイテンシ・チューニング(2026-07-14 起票)** → 第1弾 ✅(UC before/removed 化で全件読み 2→1・{mcpTool,ms} ログ導入。残: SQL レベル絞り込み=専用ポート): UI のトグル1回で
    ① findTaskById = ListTodos 全件(before 取得)→ ② UpdateTodo(内部 read + PUT)→
    ③ buildTodosViewModel = ListTodos 全件、が**直列**に走る(全件は毎回 ICS 全パース)。
    UI 側は楽観確定しない設計なのでこの往復が体感そのもの。**手順: 計測が先**
    (workers observability で D1 往復回数・CPU-ms を実測)→ 有力な削減案:
    (a) findTaskById を UID 単発取得に(todo-lookup 流用)(b) UpdateTodo が If-Match 用に
    読んだ before を戻り値に載せて presentation の再読込を消す(「UC を変えない方針」の再考)
    (c) ②と③の間で並列化できるものを並列に。ホスト側プロキシ往復(callServerTool)は制御外。
    F(運用・横断)の性能版として E-2 の仕上げ束に入れる。
- **残る実機確認(任意・claude.ai 実クライアント依存)**: 会話復帰時の更新挙動 /
  visibility:["app"] の transcript 非出現の実効性。
- **据え置き**: V6 Phase 2(DST ゾーンの VTIMEZONE 生成)/ VALARM 管理スライス(due 連動 vs
  ユーザー設定リマインダーの判別ヒューリスティック — 独立テーマ)/ 反復 todo の due→DATE 変更で
  RRULE UNTIL が DATE-TIME だと I6 明示エラー(レアケース・優先度低・直すなら UNTIL も DATE 化)。

**~~⚠️ 新 CalDAV コア課題: iOS shake-undo × sync-collection~~ ✅ 実機キャプチャで決着(2026-07-14)。**
仮説 H-A(undo はローカル限定)は**棄却** — iOS 26.5 remindd は shake-undo で
**PUT If-None-Match:\* により同一 UID を再作成する**。キャプチャ実測: DELETE 204 → sync REPORT が
404 removed(token 62→63)→ undo の PUT 201 → 次の sync REPORT が同 URI を 200+新 ETag で
changed 報告(token 63→64)= 我々のサーバーは全段で RFC 6578 §3.5.1 準拠(delete→recreate を
changed 報告)。**サーバー側バグ無し**。以前の「一瞬復活→再削除」は undo PUT より先に sync が
走った際のクライアント側タイミングと推定 = サーバーで直せない。docs/modeling/06 への正式記録は
次回実機セッション(キャプチャ: ~/caldav-capture.log)。

**E-2 スライス④候補(2026-07-14 ユーザーフィードバック・07-14 再明確化)**: 外部変更の
becoming 適用 — サーバー側 state の変化(iOS 側で追加/完了したタスク)が UI に silent に
混ざる経路が**2つ**ある: (1) focus refetch(refresh-todos は affected を持たない)
(2) **自分の mutation 応答への便乗**(確定一覧はサーバーの現在値なので、iOS で足された
タスクが「自分の完了操作の再描画」にいきなり同乗して現れる)。**両経路とも同じ問題**
(2026-07-14 ユーザー確認)— 「ユーザーが起こしていない変化が説明なしに現れる」点で同罪であり、
対策も applyStructuredContent(全再描画の唯一の入口)での差分計算1箇所で両方に効く。
**設計**: ステートレス原則はインスタンス跨ぎの話であって、生きているインスタンス内では
前回 tasks を持っている → applyStructuredContent で **prev/next のクライアント差分を毎回計算**し、
サーバー affected/removed で説明済みの行はユーザー起因 becoming(現行)、**説明されない残差 =
システム起因**として同じ becoming 語彙(added=左バー+wake 等)+中立ラベル(「同期」等。
出所は不明なので断定しない)を静的に付ける。装飾アニメは引き続き無し・FLIP は任意・
reduced-motion 尊重・pending 中や入力中は適用を延期(指の下で並べ替えない)。aria-live 通知。
編集/削除 UI・D4 確認 UX と同じスライス④の束。

**E の残り(E-2 の先)**:
- WebUI(独立した製品要素・ユーザー判断): tsdav 直 CalDAV か REST アダプタ経由かは設計時の論点
  (直なら Worker に CORS + DAV メソッドの preflight 対応が必要)。WebMCP は WebUI が立った時点で実験。
- メール起点のタスク追加(K-4)は K の文脈で。
- H(外部カレンダー集約)は「CalDAV client for agent」として E の設計に吸収(下記 H 参照)。

## 方向性 H(購読カレンダー・外部データ集約)【E/A の後・優先度中】

- 2026-07-12 起票(ユーザー着想)。iOS が PROPFIND する `source`/`subscribed-strip-*`/
  `apple:refreshrate` に対応 = 外部 .ics(webcal)を購読して読み取り専用で取り込む。
- agentic ビジョンにも効く(外部カレンダーを取り込んでタスク提案の文脈に使う)。実装は自己完結で
  軽め(source URL を持つコレクション種別 + Worker から定期 fetch + strip)。コア価値ではないので E/A の後。
- もう一つの本質(09 §3): 本作サーバー上のイベントだけの free-busy は生活が iCloud/Google に
  分散しているユーザーには嘘の空き時間を返す。採用方向は **(c) agent 側横断** —
  iCloud は CalDAV + app-specific password で外部からフルアクセス可(Apple 公式の正規手段)。
  「CalDAV client for agent」を汎用クライアントにし、本作 + iCloud + Google を agent が横断合成。
  **E の設計に吸収**(独立フェーズにしない)。

## 方向性 K: メール統合(iMIP・予定抽出・Apple マークアップ)

- **発端**: 「メール ⇄ カレンダー」は agentic 管理と不可分(ユーザー判断)。
  一次資料は **docs/modeling/10**(Cloudflare メール基盤 / iMIP 仕様 / Apple 公式マークアップ)。
  B(招待の iMIP 送受信)と E(メール起点のタスク追加)の共通基盤にあたる。
- **発見**: Cloudflare は送受信両方が揃った(受信 = Email Workers・GA 無料 / 送信 = Email Service
  2026-04 public beta・月 3,000 通込み)。**sabre/dav ですら iMIP 受信側は外部ゲートウェイ任せ** →
  「REPLY 受信 → iTIP 処理」をキット内で完結できるのは OSS としての差別化点。
- 予定抽出は3レベル(①ICS 添付=決定的 ②schema.org HTML=決定的 ③自然文=LLM + 提案 inbox 承認制)。
- Apple の Siri Event Suggestions Markup は予約8種限定 + 申請制。汎用は iMIP が正道。
- タスクの種:
  - K-1: RFC 6047(iMIP)の原文スナップショットを docs/rfc/ に追加(B 着手前に必須)。
  - K-2: 送信ポート(SendEmail port + Cloudflare/Resend アダプタ。beta リスクのヘッジ)。
  - K-3: Email Worker 受信 → ProcessIMipMessage ユースケース(DAV 非依存、複数入口ビジョン)。
  - K-4: 抽出 UC(レベル①→②→③の順)+ 提案 inbox(E の文脈で)。
  - K-5: (将来・加点)Siri マークアップの Allow List 申請(送信ユースケース確立後)。

## 方向性 B: M3 スケジューリング(招待)

- RFC 6638/5546。schedule-inbox/outbox、calendar-user-address-set、iTIP 処理、auto-schedule。
  B9 実測どおり、これが無いと iOS は招待 UI を出さない。方向性 A + K-1/K-2 が前提。
- サーバー内ユーザー間 → 外部宛は iMIP(RFC 6047、メール送信)。ドメインの輪郭は docs/modeling/03 §3。

## 方向性 C: M4 他クライアント対応

- 中核(calendar-query + 展開)は G-3 で完了、~~tsdav CI ハーネス~~ ✅ 前倒し完了
  (test/integration/tsdav-harness.test.ts。Bun.serve で app.fetch をラップ + fake repo 注入。
  探索→作成→time-range→sync→削除→free-busy の回帰保証)。
- 残る広げ方(Thunderbird 等の追加クライアント・より広いプロパティ照合)は必要時に。

## 方向性 D: M5 共有・委任

- caldav-proxy / calendarserver-sharing(非 RFC の Apple 拡張)。方向性 A が前提。
- 先行準備: ①draft 原文を docs/specs/ に常備 ②権限表スキーマは A-1 に織り込み済み
  ③read-only privilege 時の iOS 挙動検証は単一ユーザーのままでも可能。

## 方向性 I: CardDAV / 連絡先(構想段階)

- 動機: ①招待相手の解決に連絡先 ②iOS は vCard の誕生日は拾うが記念日は拾わない —
  CardDAV 解釈で記念日も把握(vCard 解釈 → 仮想イベント生成は G の親戚)。
- 追い風: CardDAV(RFC 6352)は WebDAV 基盤を CalDAV と共有、vCard は content-line 同族 —
  structure 層・DAV XML は流用可。「DAV サーバーキット」への一般化と整合。
- 位置づけ: 最後。着手前に 08 と同様の一次調査(RFC 6352 スナップショット + iOS 実機観測)。

## 方向性 F: M7 運用(横断関心事)

- 上限系 precondition(max-resource-size 等の ServerPolicy 実装)、監視、バックアップ、rate limit。
- 独立フェーズにせず、各マイルストーンの Definition of Done に該当分を含める。

## レビュー起票(2026-07-13 Codex 体系レビュー → Fable 設計判断)

Codex(gpt-5.4)による6観点レビューの結果を Fable が裏取り・裁定したもの。原文照合済みの
判断のみ記載(RFC 主張は docs/rfc/ 原文で確認)。

**採用・即修正(バグ)**:
- ~~**R-1【high・回帰バグ】**~~ ✅ `e5a6acb` `repositories.ts` の `parseSupported()` が VEVENT/VTODO しか許容せず、
  J-2 で導入した VJOURNAL コレクションの hydrate が例外 → 500(実コード確認済み)。
  `COMPONENT_KINDS` を唯一の許容集合に + `["VJOURNAL"]` 往復テスト。J-2 の取りこぼし。
- ~~**R-2【medium】**~~ ✅ `91900a0`(DELETE 側の If-Match:* 誤 412 も同時修正) `If-Match: *` を hex ETag として `ETag.fromHex` に渡し 500。RFC 7232 §3.1 では
  「存在すること」の意味。wildcard / ETag リスト / 単一 ETag を型分離して条件評価を是正。

**採用・方向性に載せる(RFC 準拠)**:
- ~~**R-3【high → C/F 系】**~~ ✅(if-header.ts サブセット実装・未対応構文は fail open) RFC 6578 §5「Servers MUST support use of DAV:sync-token values in
  If request headers」(原文確認済み)に未対応 = MUST 違反。ただし iOS は使わない(実測トラフィックに
  出ていない)ため実害は他クライアント互換。**R-2 の条件評価の型分離と同じ束で設計**するのが得
  (If ヘッダ解析 → コレクション sync-token 照合 precondition を application へ)。tsdav ハーネスに回帰を足す。
- ~~**R-4【medium】**~~ ✅ `aeeb6f5` `parseFreeBusyQuery` が time-range 複数/欠落を黙認(RFC 4791 §9.11 は exactly one)。
  構造的に数えて 400。小粒。
- ~~**R-5【low】**~~ ✅ `aeeb6f5`(allprop×sync-token の iOS 実機念押しは J-4 に合流) `supported-report-set` に free-busy-query を広告 / allprop から sync-token を除外
  (RFC 6578 §4 SHOULD NOT)。2点セットで小粒。

**採用・タイミングを A に紐付け(設計判断)**:
- **R-6【high → E の OAuth 仕上げ】** OAuth が `claudedav:read` 広告のまま write 5 ツールを実行可能・
  props に scope 非保持。単一ユーザーの現在は実害限定だが、**スケール前提リリース方針
  (メモリ参照)に照らし公開前必須**。read/write scope 分離 + props に scope 搭載 + ツール別強制 +
  E2E。AuthenticationPort の seam 内で閉じる(ドメイン非依存)。
- **R-7【high → A-1 と同時】** ETag/sync counter 検証が D1 batch の外で TOCTOU(同時 PUT が同じ
  next token を生成し得る)。単一ユーザー+単一 agent の現在は顕在化しにくいが、マルチユーザー化で
  現実化する。**A-1 のスキーマ改修と同時に UoW を CAS 型(`UPDATE ... WHERE sync_counter = ?` +
  更新0件→412)へ**。vitest-pool-workers レーンに並行書込みテスト。

**不採用(理由つき)**:
- **R-8(反復完了の非原子 2PUT)** — 見送り。snapshot-first は iOS D4 忠実再現の設計判断で、失敗
  モードは明文化済み(片割れ snapshot は「完了記録が残る」安全側)。D1 で2つの PUT UC を跨ぐ原子性は
  UoW の大改修になり、R-7 の CAS 化のほうが先。将来 R-7 実装時に「deterministic snapshot UID
  (UID = master UID + occurrence 日付由来)で再試行重複を防ぐ」だけ軽く入れる価値はある。

## 小粒の残タスク(方向性に属さない申し送り)

- J-4: iOS 実機での calendar/tasks 非回帰 + VJOURNAL time-range(方向性 J 節参照)。
- iOS shake-undo 実機キャプチャ(方向性 E 節の ⚠️ 参照)。
- V6 Phase 2(DST ゾーン)/ VALARM 管理スライス / 反復 due→DATE の I6(いずれも E 節「据え置き」参照)。
