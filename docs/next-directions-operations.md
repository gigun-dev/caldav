> **2026-10-02 廃止・凍結:** 移行前の参照記録。以下の更新指示・着手順は現行運用に適用しない。
> 現行タスクは `todo.txt`、設計判断は `docs/adr/`。対応表は [harness-migration.md](harness-migration.md)。本文は保存し、更新しない。

# 次セッション詳細カタログ: 観測 / MCP / 運用

> `docs/next-directions.md` の頭から分離した詳細カタログ。計画・検証手順・移管事項を保持する。
> MCP移行や運用の本番状態は頭と `docs/log.md` の最新追記を正とする。

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

## MCP 2026-07-28 仕様改訂への移行(2026-07-31 起票・裁定「今は着手しない」)

> **2026-09-05 更新:** 発表前の保留を再評価し、公開パッケージと固定依存を照合。
> Inspector 2.5.0 / TS server SDK 2.0.0が公開済み。一方Swift SDKは0.12.1(2025-11-25まで)、
> ext-apps最新版1.7.5もsdk v1をpeer指定。新旧両対応での移行検証が必要。
> [互換性確認](mcp-compatibility-2026-09-05.md)を参照。依存更新・移行実装・本番変更は未実施。
> **2026-09-05 更新:** Inspector 2.5.0の現行本番E2Eを実施。OAuth、2025-11-25接続、25ツール/UI付き18ツール、
> todos描画、カード内refresh-todosと全画面→通常表示を確認。新仕様・Swift・書き込みは未検証。

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
