# 次セッション詳細カタログ: 前提 / ロードマップ

> `docs/next-directions.md` の頭から分離した詳細カタログ。完了事項、方向性、別リポへの
> 申し送り、長期計画を削除せず保持する。現在の優先順位は頭の着手順を正とする。

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
