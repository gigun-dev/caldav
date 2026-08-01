# 次セッションの方向性(2026-07-15 棚卸し・第4版)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする(積層を本文に溶かし込む。第4版 = E-2 実質クローズ + E-3 着手を機に棚卸し。
> 第3版までの積層の生記録は git 履歴と docs/log.md にある)。
> 時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。

## セッション開始時の現在地(2026-07-22)

- **実装・静的検証済みの dirty**: `docs/modeling/14-confirmation-card.md` の S1。確認カード、
  `propose-delete-{todo,event,calendar}`、HMAC確認トークン、delete 3種のtoken強制、
  既存todos/agendaカード用の免除token、`CONFIRM_SECRET` bindingとテストが未コミット。
  Claude Code停止後にCodexでmain reviewを継続し、`make check`を再実行して843 bun tests・
  28 worker testsを含めgreen。既存差分は破棄せず引き継いだ。
- **review裁定**: `kind:"card"` の対象非特定・12h免除tokenは、既存カード内の明示操作を二重確認に
  しないための限定的なcapabilityとして採用。nonceは一意な発行を保証するが使用済み状態を持たず
  TTL内replay可能であり、厳密なone-time tokenとは呼ばない。propose toolのwrite scopeも破壊操作の
  入口として維持する。event/calendarと実カード経路は本番前のE2E項目として残す。
- **S1の残り**: `CONFIRM_SECRET` を値を表示せず本番へ設定し、Inspector/実カードで
  propose → card → delete と既存todos/agenda内deleteを確認してからdeployする。
  その後 #32(日曜始まり)、月/日ビュー目視、IAD再計測、確認カードS2/S3へ進む。
  > **2026-07-23 更新:** S1 コミット済み(bc2b1ef)・~~#32 日曜始まり~~ ✅(3500f6c)。
  > **push は CONFIRM_SECRET の本番設定待ち**(未設定 deploy は delete 系が安全側全拒否で壊れる。
  > secret put は権限クラス上ユーザー実行: `openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put CONFIRM_SECRET`)。
  > 設定後: push(deploy)→ mcp-inspector-verify で propose→card→delete E2E + カード内削除回帰 → IAD 再計測。
  > **2026-07-23 更新: S1 本番 E2E 完了 ✅(deploy 2a9ced5 済み・mcp-inspector-verify 実施)。**
  > 層別の事実: [tool response] ①propose-delete-todo はトークン+プレビューを _meta.confirm のみに載せ
  > content は短文だけ ✅ ③トークン無し delete-todo は「まず propose を呼べ」エラーで拒否 ✅。
  > [App UI] ②確認カード描画(⚠️見出し・対象プレビュー・destructive 赤ボタン)→「削除する」タップ →
  > 「✓ 削除しました」遷移 ✅(スクリーンショット取得)。[D1 raw] 対象 VTODO の物理削除を SELECT で裏取り ✅。
  > 検証データ2件とも正規経路(確認カード承認)で後始末済み・残ゼロ。CONFIRM_SECRET は
  > .secrets.prod.json 控え + wrangler secret bulk で設定(secrets.required ガード 2a9ced5 で以後の
  > 設定漏れ deploy は失敗する)。**未検証のまま残る層**: ④カード内 swipe 削除の UI 経路(todos 詳細に
  > 削除ボタンは無く swipe のみ・browser では touch swipe 再現不可 — 免除トークンのサーバー契約は
  > mcp-server.test.ts で検証済み。Simulator/実機の検証項目へ)・claude.ai / swift-mcp-app ホストでの
  > _meta.confirm 受け渡し(SEP-1865 loose passthrough 想定・実ホストで要確認)。
  > 副産物: OAuth 同意パスワードは検証用につき Claude 自動入力可(ユーザー許可・memory 記録)。
  > 次: 確認カード S2(update diff プレビュー)/S3(バッチ部分承認)・IAD 再計測(トラフィック待ち)。
  > **2026-07-23 更新: HITL 方向転換(ユーザー裁定+architect 一次資料調査)。S2/S3 は中止。**
  > MCP spec 明文で確認 UI はホスト責務(claude.ai は per-tool 許可済み=S1 は二重確認)。
  > サーバー責務は annotations 申告(現状未付与=未履行義務)+可逆性。スライス:
  > R1=annotations 付与+confirmToken optional 降格(propose-delete-* は猶予後撤去)→
  > R2=ソフトデリート(deleted_at+restore・sync_changes 'deleted' 不変で iOS 見え方同一)→
  > R3=object_versions+revert。R4=swift-mcp-app 側許可ゲート(Desktop セッションへ申し送り)。
  > 正典は docs/modeling/15(新設)・14 は Why not として保存。
  > **2026-07-23 更新: todos カード完了済みバグ2件修正・deploy(aab68b6)。**
  > ①3秒退場機構を完全撤去 — 完了は「完了済みセクションへ移す状態遷移」で可視のまま可逆
  > (un-complete が undo 入口)。②カードの完了済み表示は server 常時計算の completedSummary
  > (総件数+直近5件+他 n件、includeCompleted / due 窓に非依存・D1 SELECT 1回のまま)へ乗り換え
  > — includeCompleted:true 照会 push で「完了済み111件」に化ける現象を構造的に解消。
  > due 窓判定は filterTasksByWindow として application 層へ抽出(UC と presentation で単一情報源)。
  > D4 完了スナップショットの無期限累積(111件の真因)の保持ポリシーは未着手の設計事項。
  > **2026-07-24 更新: D4 保持ポリシーは「今は入れない」で裁定・クローズ(architect/Fable 一次設計)。**
  > 理由(優先度順): ①可逆性の非対称(「入れない」は cron 追加で後から覆せるが削除は不可逆。
  > 判別不能な旧データへ自動削除を走らせると非反復タスクの手動完了履歴を誤消去するリスクがある)
  > ②コアバリュー(RFC 準拠+iOS 対応)に非寄与 — 削除はむしろ iOS ネイティブの「無期限累積」
  > 挙動からの逸脱 ③実害ゼロ(本番 150 行/単一ユーザー、D1 10GB まで桁違いの余裕)④「累積が問題」
  > という従来評価は UI 表示問題を指していたもので、それは completedSummary(#43)で解決済み。
  > 本番実測(2026-07-24 SELECT): STATUS:COMPLETED な VTODO 118 件中、確定 D4(`completion-` prefix
  > UID)は 7 件のみ。旧 UUID 採番の D4 か通常完了かを ICS だけで判別不能なものが 111 件
  > (07-16/07-17 の 67 件バーストは D4 実装直後の開発・E2E トラフィックの可能性大)。
  > **据え置きトリガー(いずれかで再着手)**: ①対象コレクションの VTODO 行数が閾値(目安 5,000 行)
  > 超過、または calendar-query/sync-collection REPORT の体感劣化 ②マルチユーザー化(OSS キット化)
  > でテナント別保持ポリシーが商品要件になったとき ③iOS 実機で「サーバー側削除→ローカル表示」の
  > 挙動検証が完了したとき。**将来入れる場合の設計輪郭**: 対象は `uid LIKE 'completion-%'` AND
  > STATUS:COMPLETED AND `updated_at < now - TTL`(TTL 目安180日・iOS キャッシュ挙動未検証のため
  > 保守的に長め)。二段(①日次 cron で deleted_at を立てる→sync_changes に 'deleted' 記録=RFC 6578
  > §3.5.2 の removed MUST を既存 soft-delete 機構が充足 ②既存 purgeDeletedBefore が30日後に物理
  > DELETE)。層配置: 保持判定は domain のポリシー関数、cron 起動は application UC(例
  > PurgeExpiredCompletionSnapshots)、SQL は infrastructure。**判別不能な旧 111 件は恒久的に対象外**
  > (全 STATUS:COMPLETED 一律にすると非反復タスクの手動完了履歴を消す許容不能な副作用があるため)。
  > ボツ案: (b) マスターごと直近 N 件保持 = 旧 UUID で紐付け不能・`completion-` ハッシュはマスター
  > UID へ逆引き不能でボツ。(c) 無期限を「ポリシーとして実装」= それは「入れない」と同義でコード不要。
  > **2026-07-23 更新: カード UI 原則 (b) 採用(ユーザー承認・architect 調査)。**
  > inline=有界高・内部スクロール禁止・深いナビ禁止(OpenAI Apps SDK ガイドラインと一致)/
  > fullscreen=単一スクロールコンテナ許容/プログラム的スクロールを UX 成立条件にしない —
  > 視線誘導は「対象を安全先頭に置く遷移」。安全先頭= HostContext.safeAreaInsets.top
  > (仕様に存在・claude.ai の申告は未実測・iframe 内 env() は不可)→ CSS 変数 --host-safe-top に
  > 一元適用+未申告時はモバイル fullscreen 限定フォールバック。残作業(#35): safe-area 変数/
  > todos ⊕ の scrollIntoView 撤去(作成ビュー先頭表示へ統一)/agenda 月ビュー下段有界化。
  > 原則の明文化は docs/modeling/15 に集約(#36・作業中)。
  > **swift-mcp-app への申し送り(#34)**: R4 許可ゲート(annotations 駆動 per-tool 許可)・
  > fullscreen でキーボードが勝手に閉じる・スクロール過剰発火・safeAreaInsets の正道申告。
  > 責務分界(ユーザー裁定): **ホストは仕様の正道のみ実装し、カードを甘やかす補正魔法
  > (自動スクロール・キーボード連動)を持たない** — 持つと汎用 MCP ホストでなく
  > 「caldav カード専用ビューア」に堕ちる。カード側はホストのスクロール挙動を一切前提にしない。
  > **2026-07-23 更新: R1 実装・deploy(0616e5f)。** 全23ツールへ annotations 付与
  > (read=readOnlyHint / create=非破壊 / update=destructiveHint:true は R3 まで正直申告 /
  > delete=destructive+idempotent / 全部 openWorldHint:false)。delete 系の confirmToken 強制を
  > 撤去(フィールドは optional 残置で無視・カード経路は無改修で動く)。propose-delete-* は
  > [deprecated] 誘導付き猶予残置 — 撤去は別スライス。#28 クローズ。
  > **R2(ソフトデリート)は RFC 適合性検証待ち**(ユーザー懸念を受け architect が docs/rfc/
  > 原文で検証中: 4918 DELETE 意味論・4791 UID 一意性と partial unique index・6578 restore=created
  > 報告の正当性・CTag/ETag・Nextcloud/Apple CalendarServer の先行事例)。結果が出るまで着手しない。
  > **2026-07-23 更新: R2 RFC 検証完了(docs/rfc/ 原文)— 準拠・進めてよい。** 要点:
  > 4918 §9.6 の DELETE 義務は「URI→リソースのマッピング除去」でありデータ破棄ではない
  > (deleted_at フィルタを全 DAV 読み取り経路に一貫適用すれば準拠。soft-delete 済み URI は
  > unmapped なので If-None-Match:* PUT は成功させる)。4791 の UID 一意性は「stored / in use」
  > 空間の話で partial unique index 案は適合。6578 §3.5.1 は再マップを「changed として報告・
  > removed と報告してはならない(MUST NOT)」と明文 — restore=sync_changes 'created' 案は
  > 既存 changesSince の後勝ち fold と噛み合い自動で準拠。ETag は ICS 決定的導出により
  > restore 後も同値で問題なし(7232 上正当)。trash を DAV に露出せず MCP-only にするのは
  > Nextcloud(独自 DAV 拡張)等と比べてもプロトコル純度的に正攻法。
  > **修正必須1点**: restore の前提条件に URI 空きだけでなく **UID 空き**を加える(soft-delete 後の
  > 同 UID 再利用は合法なので、restore で可視 UID 重複が生じ得る → 拒否 or 別採番)。
  > **iOS 実機検証項目**: 同一 URI の changed 再出現の再取得挙動・同一 ETag 再出現のキャッシュ
  > スキップ(問題時は SEQUENCE/DTSTAMP で ETag を変える逃げ道)・restore 後の再スキャン発火。
  > 物理 purge(30日 TTL)は sync_changes を書かない。
  > **2026-07-23 更新: UI 是正3件 deploy(ce7d5aa)+ R2 マージ deploy(b587ef0)。**
  > ce7d5aa: ①agenda 編集詳細へ C4(構造化場所/会議)移植+汎用 URL 欄を作成/編集両方に新設
  > ②リマインダー作成のリスト選択(VTODO コレクションフィルタ)③iOS fullscreen キーボード落ち
  > バグ修正 — 根因はシート表示中の破壊的 renderAll(render-gate.ts で抑止+閉時追いつき、
  > 既知ロケーション読込のみ targeted in-place 更新)。swift-mcp のキーボード問題も同根の
  > 可能性が高く、deploy 後の再現確認待ち(#34)。
  > b587ef0(R2): migration 0004(deleted_at+UID partial unique・URI は PK 全一意+ゴースト
  > rename の非対称構成=前方互換のための意図)・restore-deleted / list-deleted ツール・
  > 30日 purge メソッド(cron 配線は別スライス)。**本番スモーク未実施**(deploy-verify 要:
  > migration 0004 の適用確認・既存データの生存確認・delete→list-deleted→restore の一巡)。
  > **並列進行中(worktree)**: K1 コレクション冪等性(displayName 重複ガード+日本語 slug 安定化)・
  > 観測基盤 v1(イベントスキーマ {requestId,principal,host,ok,errKind,ms,argsDigest}+
  > Analytics Engine 併用・TelemetryPort 化。設計は architect 報告 2026-07-23 が正:
  > 真実源はサーバー・クラッシュは端末 Sentry・相関は _meta["gigun.dev/session"]+自前 requestId)。
  > **次スライス起票済み**: 完了行の残留仕様を iOS 準拠へ(チェック→猶予→完了済みセクションへ
  > 「移動」— 退場先が completedSummary で常時可視になった今なら安全に復活できる。
  > 現状は position invariant で無期限残留+完了済みセクションとの二重表示の匂い)。
  > K2(update-calendar+実色+コレクション詳細ページ)・K3(todos 切替の横断1クエリ化)は
  > #38 参照。テストコレクション重複2件の掃除も未了。
  > **2026-07-23 更新: 並列3本すべて完了・deploy。** K1 冪等性(4f464be: 同名重複ガードは
  > MCP 入口限定 opt-in — iOS/iCloud の同名リスト正当作成を壊さない責務分界。日本語
  > displayName は FNV-1a 安定 slug へ)・観測基盤 v1(91cfaa3: TelemetryPort+AE 併用、
  > イベント {requestId,principal,host,ok,errKind,ms,argsDigest}。AE は index1=mcpTool・
  > 保持3ヶ月・SQL 遡及可)・#40 done 行の iOS 準拠移動(1087c2e: C0-a′ 2相状態機械 =
  > 猶予3秒→退場アニメ 240ms→完了済みセクションへ移動。undo は楽観キャンセル・二重表示排除)。
  > **R2 本番スモーク済み**: migration 0004 適用(partial index 存在)・既存 141 行全生存を
  > D1 読み取りで確認。delete→list-deleted→restore の一巡 E2E は未実施(Inspector 検証項目)。
  > **次の候補**: K2/K3(#38)・propose-delete 撤去スライス・purge cron 配線・
  > IAD 再計測(claude.ai トラフィック待ち)・実機確認(キーボード維持/C4 編集/リスト選択/
  > done 行移動/safeAreaInsets 実測ログ)。
  > **2026-07-23 更新: K シリーズ完了 ✅(#38 クローズ)。** K3(6a1a850: todos 切替を横断
  > 1クエリ+in-memory フィルタで往復ゼロ化・completedSummary は due 窓に加え calendarId
  > スコープからも独立)・K2-server(update-calendar ツール)・K2-UI(de88ae7: 実色
  > resolveCalendarColor+コレクション詳細ページ = 名前・8色チップ編集/新規作成)。
  > **鮮度モデルの裁定(architect 一次資料調査)**: ext-apps 仕様は履歴復元時のホスト再実行・
  > 再可視化通知を規定しない=鮮度はカード自身の責務。claude.ai の履歴復元は楽観復元
  > (実測: 履歴遡り複数回で tool call ほぼゼロ・focus 時のみカード自身の refetch)。
  > 穴: markUpdated が push でも lastFetchAt=now とし古い replay が新鮮を装う。
  > 対策 = SWR 完全形(#42 実装中): view model に generatedAt を additive 追加し、
  > 60秒超の古い push は背景 revalidate(非ブロッキング)。
  > **swift-mcp への申し送り(#41 改)**: 履歴カードの fail-closed ゲート(hint プロトコル)は
  > 撤去推奨 — ①ホスト固有プロトコルでサードパーティカードが全滅(汎用ホスト不成立)
  > ②RFC 5861 の SWR 思想(stale を出して背景検証)の逆 ③ext-apps に標準化の足場なし
  > ④カード操作は封鎖に見合う不可逆高リスクではない。ホストの責務は素の focus/visibility
  > イベント配送のみ(それが無くてもカードの generatedAt 判定だけで成立する)。
  > caldav 側の hint 対応は不要と裁定。
  > **2026-07-23 更新: 冪等化やり直し+実機フィードバック3件対応(5d2a475 / 0d6854f)。**
  > create-calendar: K1 の同名拒否は誤った治療(真因はリトライ重複+ランダム UUID)と
  > ユーザー裁定 → 同名ガード撤去・安定 id への収束で真の冪等化(idempotentHint:true)。
  > 本番 E2E 済み: 同依頼2回目が同 id を返し新規作成なし。意図的な同名複製は id 明示で。
  > 実機 FB: ①キーボード維持 OK ✅ ②done 行が移動しない回帰 → 根因 resetPositionMemory の
  > 退場タイマー巻き添えキャンセル(K3 で complete push がビュー切替扱いになり顕在化)を修正。
  > 静的解析ベースの修正のため実機再確認要 ③既定未選択で全コレクション貫通 → 既定=単一
  > (echo→前回選択→tasks)・「すべて」は明示選択でコレクション別色付きグループ表示へ。
  > 教訓(memory 記録済み): 同一ファイルを触るスライスを並列に出さない(後勝ちマージが
  > 先行実装の配線を乱す。make check green でも統合の振る舞いは守られない)。
  > 完了済み総数(114件)表示と D4 スナップショット保持ポリシーの議論は未決のまま。
  > **2026-07-24 更新: D4 保持ポリシーは「今は入れない」で決着 ✅**(裁定と根拠は上記 07-23
  > completedSummary の更新ブロック参照)。完了済み総数表示は #43 の completedSummary で解決済み。
  > **2026-07-23 更新: 実機フィードバック大量投入(swift ホスト・新版カード)と設計裁定2件。**
  > 【裁定1: done 行の自動移動(C0-a′)は撤回】architect 調査で modeling/12 §7.8 v2.2 の
  > 裁可済みドクトリン「時間駆動の視覚イベントを型から排する」と矛盾する再導入だったと判明
  > (図を更新せずコードで矛盾を持ち込んだ誤り)。iOS の「3秒猶予」は一次資料に存在せず。
  > 最終仕様 (d′): done はその場で取消線・再タップ undo・完了済みへの移動は次の fresh render /
  > リスト切替のクリーン再セクショニングのみ。「操作の差分を静的に見せる」設計言語
  > (ユーザー指摘)と整合。
  > 【裁定2: 完了済みサマリの owner 全体不変は過剰】単一リスト表示ではそのリストの完了済み
  > 件数を見せるのが正(不変条件は「push で揺れない」ことでありスコープ無視ではない)→
  > コレクション別内訳へ作り直し(#43)。
  > 【バージョン不整合の実害】claude.ai web はコネクタ同期時点のツール定義(content-hash
  > ui:// URI)をキャッシュし旧カードを描画し続ける — 今日の「幽霊デバッグ」の主因。
  > 対策: カードに版不整合表示(是正束④)+ユーザーはコネクタ再同期。
  > **実装中(是正束・artisan)**: ①C0-a′ 撤回 ②メニュー失敗固着解消+背景プリフェッチ
  > ③既定選択の決定化+calendarId 契約点検 ④版不整合表示 ⑤all 選択で未完了が出ないバグ
  > ⑥「他 n件の未完了」の並び順 ⑦空リストで + ボタンが消えるバグ(action-row が fold 条件に
  > 巻き込まれていた)。
  > **キュー(直列)**: #43 完了済みコレクション別内訳+削除/復元/ゴミ箱のカード化(URI 生
  > テキストのモデル文脈追放)+イベント mutate カード点検 → #44 作成 UX(イベント詳細
  > ファースト・会議 URL 開く/コピー・+ ラベル明示・リスト作成 fullscreen・作成フロー全般の
  > 同期 focus = iOS はジェスチャ外 focus でキーボードを出さないため 450ms 遅延 focus を
  > 並べ替え)→ #45 場所モデル本対応(structuredLocation の geo 必須緩和 = モデルはジオ
  > コーディング不能・住所のみ受理+iOS 受理性実機検証・ピッカーの geo 無し表示・
  > description 誘導: リスト名→calendarId 解決/住所→structuredLocation/known-locations 先引き)。
  > **バックログ(#47)**: propose-delete 撤去・purge cron 配線・R2 Inspector E2E・IAD 再計測・
  > D4 保持ポリシー(完了済み115件累積の根本)。
  > **2026-07-24 更新: #47 バックログ全項目決着。** ~~propose-delete 撤去~~ ✅・~~purge cron 配線~~ ✅・
  > ~~R2 Inspector E2E~~ ✅(3件とも 545920f で実装済み・受け入れ PASS は docs/log.md 07-23続き10)。
  > ~~D4 保持ポリシー~~ ✅「今は入れない」で裁定・据え置き(裁定と根拠は上の 07-23 completedSummary
  > 更新ブロック参照)。~~IAD 再計測~~ △ colo タグ欠落により判定不能と判明 → AE blob6 に colo 追加+
  > 誤ったコメント訂正(このセッションで実施・詳細は下記 07-22 IAD 更新ブロック直後の追記参照)。
  > colo 蓄積後の再測定は引き続き据え置き。加えて #45 名残の2件も確認しクローズ: known-locations の
  > geo 無し emit は現状どおり出さないのが正(iOS 地図に出ない場所を提示する中途半端さを避ける・
  > 変更不要)/ geocoding quota は失敗時も消費するのが正(実呼び出しが発生した以上試行回数で数える
  > 設計はコード既存コメントどおり・変更不要)。
  > **swift 申し送り(#34/#41)**: swift-mcp-app/docs/next-directions.md に追記済み(未コミット・
  > Desktop セッションに委ねる)。
  > **2026-07-23 更新: 是正束7件の実装・静的検証完了 ✅。** C0-a′ の2相退場機構/
  > `done-exit.ts` を撤去し、positionMemory 所属判定による完了済み重複排除へ置換。Todos/Agenda
  > 共通で list-calendars 失敗時の再試行行+背景プリフェッチ、todos 既定リストの決定化、
  > `"all"` echo の横断センチネル正規化、未完了フッタを完了済みより前へ移動、displayMode 未申告/
  > 空リストでも action-row の + を常設。配信 HTML の焼き込みhashとserver `uiHash`を比較する
  > 版不整合警告を両カードへ追加し、create-calendar 応答を含む配線テストも固定した。
  > `make check` green(境界・tsc 3種・bun 953 tests・worker 34 tests)。**未実施は実ホスト目視**:
  > コネクタ再同期後の swift/claude.ai で7症状の再確認。次の実装スライスは予定どおり #43。
  > **2026-07-23 更新: 是正束 deploy(8f9fc13)+ Inspector subagent 受け入れ導入。** 9 PASS・
  > 1 FAIL(コレクション詳細保存不発 = 残留メニューオーバーレイがタップを吸っていた)→ 修正
  > deploy(7c6b133)→ 再検証で**全10項目 PASS**。以後「実装→deploy→Inspector 受け入れ→FAIL
  > 即修正」ループを標準化。
  > **2026-07-23 更新: ~~#43~~ ✅ 完了(deploy 6d84ae1・Inspector 全項目 PASS)。**
  > ①completedSummary = {total, recent, byCalendar}(単一リストは出身フィルタ+リスト別総数・
  > 0件はセクション非表示)②list-deleted/restore-deleted のカード化(fullscreen ゴミ箱ページ+
  > 行ごと復元・content から URI 追放)③event mutate 4ツールの _meta.ui 未配線が「カードが出ない」
  > 根因(ホスト判断ではない)→ 配線して解消・**swift への mutate カード申し送りは不要に**。
  > 論点(log 2026-07-23 続き6): restore 後は復元先リストへ遷移(意図的)/ゴミ箱ページは
  > render-gate 対象外/byCalendar は所属不明行を数えず内訳合計 ≤ total。次は #44。
  > **2026-07-23 更新: ~~#44~~ ✅ 完了(deploy c06d8d5・Inspector 受け入れ FAIL ゼロ)。**
  > 詳細ファースト(閲覧ページ→明示「編集」)/URL は App.openLink+二段 degrade コピー/
  > ⊕ テキスト併記/新規リスト fullscreen 化/**キーボード根治 = 450ms 遅延 focus 撤去 →
  > タップジェスチャ内の同期 focus → requestDisplayMode の順へ**(render-gate が focus 保持)。
  > UNVERIFIED はホスト制約のみ(Inspector の clipboard 遮断・hostDisplayMode 未送出・fullscreen
  > 不許可)。**残実機確認(ユーザー)**: claude.ai iOS/web でのキーボード出現・コピー・agenda ラベル。
  > **2026-07-23 更新: #45 の geocoding 裁定(経緯は log 続き7)**: known-locations 先引き →
  > **Google Places Text Search 単段**(場所入力の実態は POI 主体・GSI は POI 不可で住所形前処理の
  > 将来候補・Apple はポートの口のみ)。ToS は「サーバーはメタデータ保存のみ・表示はクライアント
  > 解釈」の立場+6.3.2 のユーザー別直接機能で整理。鍵受領後に GSI/Google/Apple の POI 精度ベンチ →
  > 実装。
  > **2026-07-23 更新: ~~#45~~ ✅ 完了(deploy 7ea62c8・Inspector 受け入れ PASS。経緯 log 続き8〜9)。**
  > 実測ベンチで Google Places 単段を確定(GSI は POI に誤答・Apple は必須クエリ0件)→
  > search-location ツール+月次 quota ガード(D1 atomic 予約・既定 1000/月 = Pro SKU 無料枠 5,000 の
  > 20%)+ geo 必須緩和(geo 無しは LOCATION へ degrade)+ picker geo 無し対応。受け入れで
  > **本番のみ発現の fetch this 束縛バグを検出・修正**(スタブ fetch は this を見ないため
  > make check green のまま落ちる)。GCP 整理・予算アラート(¥1,000)・GOOGLE_MAPS_API_KEY 本番投入済み。
  > **残実機確認(ユーザー)**: キーボード出現(#44 ⑤)・geo 無しイベントの iOS 表示(LOCATION の
  > title\naddress 改行形式)・search-location 経由の場所付き予定作成の一気通貫。
  > 次: #47 小粒バックログ(propose-delete 撤去・purge cron・all センチネル統一から着手)。
  > **2026-07-24 更新: geocoding 解決品質ゲート再受け入れ(前回 FAIL の是正確認)**: Inspector
  > proxy 経由の直接 JSON-RPC POST(フォームの locationReminder/recurrence 併存シリアライズ不具合
  > 回避)で4項目実施・**全 PASS**。①VTODO ゴミ弾き(架空場所): 今回はツールがエラーを返し
  > (isError:true)D1 に行が作られない(前回 FAIL → 今回 PASS。ただし応答文言に弾いた候補名は
  > 含まれず「解決できませんでした」の一般文言のみ — VEVENT 側の rejected 文言とは非対称。
  > 要望通りの文言仕様なら軽微な是正余地)。②VTODO 正当クエリ(叙々苑): 成功・D1 raw ICS に
  > X-APPLE-PROXIMITY:ARRIVE + geo + X-APPLE-RADIUS=100 確認(#51 回帰 OK)。③VEVENT ゴミは
  > degrade: エラーにならず作成・`_meta["gigun.dev/locationAutoResolve"]` が
  > `{kind:"rejected",score:0.1875}`・応答文言「一致度が低いため地図ピンは付けませんでした。
  > search-location で確認できます」(failed と区別された文言)・D1 に structuredLocation 無し
  > LOCATION テキストのみ。④VEVENT 正当クエリ: `{kind:"geocoding",score:0.5}`・D1 に
  > X-APPLE-STRUCTURED-LOCATION(geo+X-TITLE)確認(#45 回帰 OK)。検証データは delete-todo/
  > delete-event で後始末(ソフトデリート=trash 行き。ハード削除ではなく設計どおり)。
  > geocoding quota 使用量 2026-07: 16(このセッションの Google 呼び出しは2回のみ消費)。
- **swift-mcp-appセッションからの申し送り(2026-07-23夜・実機バグ2件+iOS切り分け結論+OAuth調査)**
  > 経緯の生記録はdocs/log.md末尾2エントリ(同セッション追記・未コミット)。コミットはこちらに委ねる。
  > **①fullscreen FABがclaude.ai iOSのcomposerに隠れる(実機スクショ確認済み・要修正)**:
  > `resolveSafeBottomPx`の「bottomは深刻なocclusionを起こしにくいのでフォールバック無し」仮定の反証。
  > claude.ai iOSはcomposerクローム分をsafeAreaInsets.bottomに申告していない模様。既存検証項目
  > 「safeAreaInsets実測ログ」で実値を取り、topと同じfullscreen限定bottomフォールバック
  > (1関数隔離・実測後に定数更新)を追加してほしい。
  > **②⊕→fullscreen遷移でキーボード一瞬起動→即閉じの再発(実機確認済み・要修正)**:
  > ce7d5aaのrender-gateは「シート表示中」のみ抑止のため、遷移時のhostcontextchanged起点renderAllが
  > focus中のドラフトinputをDOMごと消す経路が残っている。shouldSkipDestructiveRenderの抑止条件を
  > 「focus中のinputがある間」へ広げる方向を推奨(遅延focusワークアラウンド復活はmodeling/15 §Bボツ案)。
  > **③iOS描画失敗の切り分け結論(diag-cardの役目)**: 正体はclaude.ai iOSカード描画パスの
  > token未refresh(TTL 1時間失効後401 invalid_token→「サーバーに接続できません」。webはrefreshする)。
  > コネクタ再作成で復旧・その後todos/agendaもiOS描画OK。サイズ説は棄却。既知issue
  > claude-ai-mcp#228(proxyパスのrefresh未実装)と同根。diag-cardはAnthropic報告の再現材料として
  > 当面残置し、報告完了後に撤去(#47で同梱コミット済み)。副産物: iOSレンダラーはui/initialize
  > ハンドシェイク無しの素HTMLも表示するが、webは初期化完了まで非表示(diag-cardがwebで出ない理由)。
  > **④OAuthベスプラ調査のcaldav側帰結(swift-mcp-app docs/design/08が正典・出典付き)**:
  > accessTokenTTLは既定3600sを維持(TTL延長でiOSバグを凌ぐ案は却下: blast radius拡大・根本原因
  > 隠蔽・TTL超過で再発)。refresh rotationはworkers-oauth-providerが仕様準拠実装済みで変更不要。
  > 確認事項2点だけ: refresh token失効時にRFC 6749準拠の`invalid_grant`を返すこと、
  > 401に`WWW-Authenticate: Bearer resource_metadata="..."`が付くこと(providerの挙動確認)。
- **MCP 2026-07-28 仕様改訂への移行(2026-07-31 起票・裁定「今は着手しない」)**
  > 一次資料: [仕様](https://modelcontextprotocol.io/specification/2026-07-28/) /
  > [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) /
  > [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/) /
  > [Claude blog](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)。
  > **破壊的変更の規模**: ①`initialize`/`notifications/initialized` ハンドシェイク廃止 +
  > `Mcp-Session-Id` 廃止(完全ステートレス化・版と client capabilities は毎リクエストの `_meta`)
  > ②`server/discover` が **MUST**(新 RPC・サーバー実装必須) ③**全 result に `resultType` 必須**
  > (`"complete"`/`"input_required"`) ④HTTP GET + `resources/subscribe` → `subscriptions/listen`
  > ⑤`ping`/`logging/setLevel`/`notifications/roots/list_changed` 削除(log level は `_meta` の
  > `io.modelcontextprotocol/logLevel` 経由・未指定リクエストへ `notifications/message` を
  > 出すのは MUST NOT) ⑥MRTR がサーバー起点リクエスト(sampling/elicitation/roots)を置換
  > ⑦list 系に `ttlMs`/`cacheScope` 必須・`Mcp-Method`/`Mcp-Name` ヘッダ必須・エラーコード renumber
  > ⑧認可: DCR(RFC 7591)を**非推奨**化し Client ID Metadata Documents へ・RFC 9207 `iss` 検証必須。
  > **裁定(2026-07-31・発表動画の締切 08-01 18:00 を理由に)**: **着手しない**。根拠(優先度順):
  > ①発表デモは swift-mcp-app(自作クライアント)⇄ caldav の閉ループで外部が版を強制しない
  > ②2025-11-25 は有効なリビジョンであり版ネゴシエーションがある以上「壊れた」わけではない
  > ③Claude 側の打ち切り日は未告知で、今回 **feature lifecycle policy(最低12ヶ月の非推奨
  > ウィンドウ)が明文化された**のはむしろ安心材料 ④締切前日の大改修 + 本番 deploy は
  > デモを壊す唯一の現実的な経路。
  > **予防措置(発表まで)**: `bun install` を走らせない(`@modelcontextprotocol/sdk` は `^1.29.0`
  > のレンジ指定。lockfile は commit 済みだが再解決すると上がりうる)。
  > **移行スライスの輪郭(発表後)**: ステートレス化 / `server/discover` / `resultType` /
  > `subscriptions/listen` / **ext-apps の extensions 宣言**(MCP Apps が正式に versioned
  > extensions framework に載った — 本プロジェクトの路線が標準化側に追認された) /
  > list 系の `ttlMs`・`cacheScope` / DCR → CIMD(memory の「OAuth は近い将来の高優先」と合流)。
  > **ステートレス化は Workers と本質的に好相性**(セッション廃止 = エッジ/ラウンドロビン向き)
  > なので、歓迎すべき変更として丁寧にやる。発表資料側の扱いは
  > `swift-mcp-app/docs/presentation-plan.md` §4.6。
  > **2026-07-31 追記(見積もりの下方修正・Hono 作者のツイートを受けた調査):**
  > TS SDK **v2** は `@modelcontextprotocol/server` + **`@modelcontextprotocol/hono`(公式)**
  > という構成で、リモート MCP サーバーを Hono で数行書ける
  > (`createMcpHonoApp()` + `transport.handleRequest(c.req.raw, ...)`、
  > `sessionIdGenerator: undefined` = ステートレス)。Hono 作者はさらに
  > `app.use('/mcp', mcp(server))` へ抽象化する案を提示している。
  > **caldav の現状はこの方向と最初から一致している**: `src/presentation/mcp/server.ts:43` で
  > `@hono/mcp` の `StreamableHTTPTransport` を使い、かつ **同ファイル 12〜20 行のコメントどおり
  > 「Workers ではグローバルに接続済みサーバーを溜め込まない」という理由で @hono/mcp の README
  > サンプルから意図的に外れ、リクエストごとに `McpServer`/`transport` を new している**
  > (= 実質ステートレス運用。principal をクロージャ束縛できる利点も込み)。
  > **よって「ステートレス化」の移行コストは当初見積もりより大幅に小さい。** 乗り換え先も
  > `@hono/mcp` → `@modelcontextprotocol/hono`(公式)が用意されている。
  > **残る重い部分**: `server/discover` の実装 / 全 result への `resultType` 付与 /
  > `subscriptions/listen` / **ext-apps の extensions 宣言**(initialize 廃止により
  > capabilities 申告の場所が変わるため、カード UI の要となる ext-apps の宣言経路は要確認)/
  > list 系の `ttlMs`・`cacheScope` / DCR → CIMD。
- **iOS 初回アカウント追加バグの切り分け + サーバー是正5件 + Apple クライアントモデル総当たり調査(2026-08-01)**
  > 経緯の生記録は docs/log.md 末尾(このセッションで追記)。
  > **①iOS 実機挙動: まっさらな Simulator では CalDAV アカウントの初回追加が必ず失敗する(iOS 側の
  > 挙動・サーバー実装は無関係と確定)。** ユーザー追加アカウントが1つも無い端末では、サーバー検証は
  > 通るのに「カレンダー/リマインダー」トグル一覧が空になり、保存するとデータクラス0個の「停止中」
  > になる。**他社サーバー(Vikunja のデモ)でも再現**したことで切り分けが完了した(7月の実機検証は
  > 既存アカウントが1つ以上ある端末だったため、この現象に一度も当たらなかった)。回避策(実測で確定):
  > `xcrun simctl openurl <UDID> 'webcal://<公開icsのURL>'` で**照会カレンダーを先に1つ入れる**
  > (4タップ・テキスト入力ゼロ)と CalDAV の初回追加が通るようになる。端末を温めるのに CalDAV
  > である必要はなく、型の違う `SubscribedCalendar` で足りる(同一端末に「日本の祝日」が2行並び、
  > **システム管理の `HolidayCalDaemonAccount` では温まらず、ユーザー追加の照会カレンダーで温まった**
  > ことを `sqlite3` で直接確認)。`.mobileconfig` はアカウント投入に使えないことも確定(アカウント系
  > ペイロード全般が Simulator でアカウントを作らない。CalDAV 固有ですらない)。検証用の種デバイス
  > `CalDAV-Seed-webcal` を残置 — 以後 `xcrun simctl clone` で**16.7秒・0タップ**で CalDAV 付き
  > 端末が複製できる。詳細は `docs/modeling/06-ios-behavior-verification.md` に記録済み(別エージェント
  > が執筆。このセッションは参照のみで編集していない)。
  > **②サーバー側の是正5点(未コミット・未デプロイ)**: (a) 未対応 REPORT の応答を 404 →
  > **403 + `<DAV:error><DAV:supported-report/></DAV:error>`** に是正(RFC 3253 §3.6/§1.6 を原文
  > 照合。`docs/rfc/rfc3253.txt` を新規スナップショット追加)(b) `principal-search-property-set`
  > REPORT を実装(RFC 3744 §9.5。200 で返す。`principal-property-search` 未実装のため空集合で
  > 返す判断)(c) `.well-known/caldav` の 301 に `Cache-Control: no-cache`(RFC 6764 §5 の SHOULD)
  > (d) **【重要】404 propstat のプロパティ名が壊れていたバグを修正**: 要求された名前空間が全部
  > `DAV:` に潰れ、大文字が小文字化されていた(例: `{apple-ical}calendar-color` →
  > `<d:calendar-color/>`、`{caldav}schedule-default-calendar-URL` →
  > `<d:schedule-default-calendar-url/>`)。5名前空間すべて・principal/home/collection すべて・
  > PROPFIND と REPORT の両方で再現していた(RFC 4918 §14.22 違反。200 propstat 側は正しく、
  > 404 側だけが別経路で名前を組み立てていたのが原因)。**iOS 26.5 は現状これを許容している
  > (実測)ので「証明された iOS 破壊」ではなく仕様違反+潜在リスクという扱い**。(e)
  > `valid-sync-token` の名前空間を CalDAV → `DAV:` に修正(RFC 6578 §3.2)。`make check` 緑
  > (bun 1105 pass / worker 42 pass)。
  > **deploy 前に確認すること**(未実施のまま次セッションへ引き継ぐ): 既存アカウントが古い 301
  > (`Cache-Control: no-cache` 無し版)をキャッシュ済みの可能性 / principal への PROPFIND で
  > `supported-report-set` が 404 propstat → 200 propstat に変わる(挙動が変化する箇所)。
  > **③Apple 公式リファレンス実装を使った総当たり調査という手法を確立(今後も使える)**:
  > `/Users/gigun/ghq/github.com/apple/ccs-calendarserver` の `simplugin/caldavclient.py`
  > (Apple 自身が「実クライアントはこう動く」とモデル化した負荷シミュレータ・リクエストボディ
  > 78本)を棚卸しし、約45本を本番へ実際に当てて検出する手法で実施。未着手の課題8件を検出 —
  > 一覧は下記「小粒の残タスク」の該当節参照(次セッションの着手候補)。
  > **④別件で踏んだ実バグ: `make dev` が起動しない。** custom build の watch が
  > 「`*-bundle.ts` を再生成 → 変更検知 → 再ビルド」の**無限ループ**に入る。本日2つのエージェント
  > が独立に踏んだ。開発体験を直撃するので要修正(未調査)。
- **正典の順序**: instructions → この最新サマリ → 該当modeling/RFC → project skill →
  `docs/log.md`。詳細履歴は必要な節だけ読む。Claude project memoryやsession JSONLは同期しない。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される最新サマリ。以下は履歴・詳細カタログ。 -->

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
> - **③ 日タイムライン(2a019f0)**: モック v7 を先行作成(v6 に日ビュー描写が無かったため=図が正)。
>   重なり解決は day-timeline.ts 純関数(colCount=クラスタ内同時最大重なり・13 tests)。レンジは選択日
>   1日分へ都度差し替え・赤線タイマーは stopNowLineTimer 集約+visibilitychange 連携。month 突入カーソルは
>   選択日を含む月(day→month の飛び戻り排除)。**②③とも残: 実機/Simulator 目視**。
> - **memory→docs 移送(5406ff1・#30 第一弾)**: Simulator 検証経路→ios-device-verification スキル・
>   journal 方針→本ファイル。重複/陳腐化 memory 4件削除。残る候補: chrome-devtools 検証手順(D1 座標含む
>   ため git 化は要判断)。
>
> **2026-07-22 追更新(夜第2ラウンド: 文言・レイテンシ第2段・range 語彙・確認カード)**:
> - **確定ボタン iOS 準拠(4afb38f)**: 作成モード=「追加」(todos/agenda とも)。編集は todos「完了」/
>   agenda「保存」(イベントに完了概念が無いため)。「完了」×タスク完了のダブルミーニングを作成から排除。
> - **IAD の正体が確定**: claude.ai コネクタは米国発 → Worker が IAD で実行される。IAD ~1259ms は
>   「遠い外国」でなく **claude.ai 利用時に毎回払うレイテンシ**と判明し案2の優先度を上方修正。
> - **案2 横断1クエリ化(a44f0bd)**: 実往復は 3 波(findAllByOwner → hydrate の sync_changes N+1 →
>   time-range N 並列)だった。calendar_objects.owner でコレクション列挙自体が不要 → WHERE owner=? の
>   **1 クエリ**へ。新 port findByOwnerTimeRange + ListOccurrences/ComputeFreeBusyAcrossOwner(単一 UC は
>   DAV 用に不変・echo 契約不変)。**残: claude.ai 経由の実測 before/after(トラフィック待ち)**。
>   sync-collection 系の hydrate N+1 は残置(別スライス候補)。
>   > **2026-07-24 更新: IAD 再計測は colo タグ欠落により判定不能と判明・対処のみ実施し据え置き。**
>   > AE dataset caldav_mcp_events を SQL HTTP API で直接クエリ(計装は 2026-07-23 追加でまだ薄い・
>   > 約1日/419コール、うちエラー27=~6.4%)。全 list/refresh 系が強い bimodal(p50 85〜211ms=近い
>   > D1 クラスタで既測 325〜351ms と整合・p95 ~2000ms/max 4.9s の遅いテール)までは分かったが、
>   > **colo 別の分解が不能だった**: `analytics-engine-telemetry.ts` が colo を AE へ書いていなかった
>   > (96B 予算を理由に除外していたが、その 96B 前提が事実誤認 — 96B は index のみで blobs は
>   > 16KB 枠。Cloudflare 公式 limits ページ 2026-07-24 一次確認)。observability MCP ツールの
>   > events ビューは Zod バグで壊れており console.log 側の colo を読む回避路も不能。**対応(この
>   > セッションで実施)**: AE アダプタの blobs 末尾(blob6)に colo を追記し、誤ったコメントを一次
>   > 資料で訂正(コード変更済み)。**判定は据え置き** — 「IAD が並列化後 ~400-500ms に収まったか」
>   > および次段最適化(横断1クエリ化 / D1 read replication)の go/no-go は、colo タグ付きサンプルが
>   > 蓄積されてから再測定して判断する(単発 IAD からの合成プローブでも可)。現時点では「IAD は
>   > 改善した」と結論づけるデータは無い(bimodal のテールが IAD 由来かも未確認)。
> - **range 語彙拡充(b6961d1)**: 「今週の予定」で get-current-time 2往復が実運用で再発(スクショ確認)→
>   this-week / next-week / this-month を追加・description に「相対表現は range 1発・get-current-time 不要」。
>   **→ #32: 週始まりは月曜固定にしたがユーザーのカレンダーは日曜始まり — 日曜へ変更予定**(単一ユーザーの
>   現在は固定・マルチユーザー(A)で user config へ昇格)。list-todos due の語彙統一は別スライスのまま。
> - **確認カード**: 設計確定 → **modeling/14 が正(332d091)**。propose-* + _meta 限定 HMAC トークン +
>   カード内 callServerTool(ステートレス・D1 変更ゼロ・elicitation は claude.ai 未対応で不採用)。
>   破壊度3層(delete=必須/update・バッチ=誘導/create・complete=直接)。**S1 実装中(artisan)**:
>   confirm-token.ts + 汎用確認カード + propose-delete 3種 + delete トークン必須化。論点=既存カード内
>   削除(ユーザー明示操作)を二重確認にせず壊さない整合。
> - **残タスク(2026-07-22 夜時点)**: S1 レビュー→着地 / #32 日曜始まり化 / ②③月・日ビューと
>   S1 の実機/Simulator 目視 / IAD 実測 / 確認カード S2(update diff プレビュー)・S3(バッチ部分承認)。
> - **次**: 確認カード(human-in-the-loop)起票・設計。判断待ち: save ボタン文言統一 / IAD 次段。
>   **2026-07-22 追記: 設計確定 → docs/modeling/14 が正・S1 から着手。**
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
  【journal 方針(2026-07 決定・memory から移送)】journal コレクションは人間向けでなく agentic
  インフラ。provisioning は既定 provision に入れず「agentic 機能の初回使用時に遅延 get-or-create」
  (除去可能性優先)。J-1 は RFC 確定で素直に・J-3(ical-tasks/9253)は原文スナップショット後に
  string 型で。安定度で3層(RFC 確定/draft/独自)に分けて疎結合に保つ。
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
- 週開始曜日(this-week/next-week の起点)は user 設定への昇格候補(2026-07-23 現在は日曜固定
  ハードコード。application/time/relative-range.ts 参照)。

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
- **`make dev` が起動しない(2026-08-01 発見・未調査)**: custom build の watch が
  「`*-bundle.ts` を再生成 → 変更検知 → 再ビルド」の無限ループに入る。本日2つのエージェントが
  独立に踏んだ。開発体験を直撃するので優先度は高いが原因未特定。

### Apple クライアントモデル総当たり調査で検出した未着手課題(2026-08-01・次の着手候補)

`ccs-calendarserver` の `simplugin/caldavclient.py` を使った総当たり(頭の 2026-08-01 更新ブロック
③参照)で見つかった、この日には未修正のまま残っている課題。

1. `expand-property` / `principal-property-search` / `calendarserver-principal-search` が
   principal で 404(principal ルートに REPORT ハンドラが無い)。
   **`expand-property` は OS X が毎回のポーリングで投げる経路。**
2. PROPPATCH の未対応プロパティ応答に status も propstat も無い(RFC 4918 §14.24 の DTD 違反)。
3. `Depth: infinity` を黙って Depth 0 扱いして 207 を返す(RFC 4918 §9.1 の SHOULD は
   403 + `propfind-finite-depth`)。
4. calendar-home への `sync-collection` が 404。
5. **sync token にリクエストホストが埋まっており、入口(workers.dev / Cloud Run)を変えると
   全同期が走る**(データ喪失はしないが full resync コストが発生)。
6. `.well-known/caldav/`(末尾スラッシュ)が 404。Apple のモデルはこの形を使う
   (iOS 26.5 はスラッシュ無しなので低優先)。
7. object 宛 `calendar-multiget` が 405(RFC 4791 §7.9 は object 宛も対象と明記)。
8. **200 propstat 側の照合が名前空間を見ていない**(`<foo:calendar-home-set xmlns:foo="urn:bogus"/>`
   を要求すると CalDAV の値が 200 で返る)。直すには props Record のキーを (ns, local) 対に
   変える必要があり全プロパティ定義に波及する = **別タスク相当**(1〜7とは規模が違うので分けて
   起票する)。
