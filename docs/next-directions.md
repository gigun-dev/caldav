# 次セッションの方向性(2026-07-11 棚卸し・第2版)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする(積層を本文に溶かし込む。今回が第2版 = 着手順の DDD 改訂を機に棚卸し)。
> 時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。

M1「足場固め」が完了した時点。検証フェーズは完了しており、プロダクトとしては序盤。
**次のセッションは方向性 G(G-1 の TZ 解決層)から拾う。**

> **2026-07-11 更新:** G-1 完了 ✅。次は **G-2(RecurrenceExpansion ドメインサービス)** から。

## 今日までに完成しているもの(前提)

- **iCalendar ドメイン層**(RFC 5545): 構造層 + 値型コーデック + 意味論レンズ + 不変条件 I1〜I10。ロスレス往復。
- **CalDAV リソース層**: 3集約(Principal / CalendarCollection+SyncChange / CalendarObjectResource)+ put-preconditions R1〜R7。
- **フルスタック稼働**: application / infrastructure(D1) / presentation(DAV XML + Basic Auth)。
  本番 = Worker `caldav.gigun-dev.workers.dev` + Cloud Run 書き換えプロキシ(iOS 正式入口・恒久構成)。
- **iOS 実機検証 3ラウンド完了**(docs/modeling/06)。A7(RFC 6868)も決着済み — iOS は
  パラメータ値の DQUOTE を黙って除去し `^` エンコードは使わない。6868 実装は不要と確定。
- **M1 足場固め**: CI(境界→tsc→test)/ Workers Builds 自動 deploy / ETag 412 テスト /
  ローカル開発環境(Makefile + cloudflared tunnel + iPhone 実機接続実証)/ pre-push hook で main 保護。
- 203+ tests / tsc green。認証方式の調査済み(docs/modeling/07 が M2 一次資料)。
- proxy の Content-Length 修正は Cloud Run 反映済み(`caldav-proxy-00003-dsz`、OPTIONS 疎通 OK)。

## 着手順(2026-07-11 確定・DDD 戦略設計)

松岡 DDD のコアドメイン蒸留で A〜K を分類(根拠と分類表は **docs/modeling/11 §1**):
コアドメイン = **G / J / E**、支援 = B / K / C / H / I、汎用 = **A** / F。
「コアに最初に投資し、汎用はデファクトをなぞって薄く済ませる」原則から、
当初案(A 先頭。B vs E はユーザー判断待ち)を改訂して以下に確定:

1. **G(意味計算)** — RFC MUST 違反の解消 + コアドメイン。A に依存せず単独で完結。
2. **J(採択途中 RFC)** — G でドメイン層が熱いうちに。ical-tasks の RFC 化前に。
3. **A(M2 マルチユーザー)** — 汎用だが B/D/E 実運用の前提となるボトルネック。
4. **E(agentic 入口)** — B より先と確定(ユーザー判断)。K-4 はこの文脈で。
5. **K-1〜K-3 → B(招待)** — K-1 は B 着手前必須。K-2/K-3 は B と E の共有カーネル。
6. **C → D → H → I** — ただし C の tsdav CI ハーネスだけ **G-3 完了時点に前倒し**。
   H は E の設計に吸収。I は最後(着手前に一次調査)。

**F(運用)はフェーズではなく横断関心事** — 各マイルストーンの Definition of Done に
「rate limit / 上限 precondition の該当分」を含める。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される「頭」(orient 用の
     現在地・完成物・着手順)。以降の方向性カタログはオンデマンド参照(着手する方向性の節だけ
     agent がそのとき読む)。棚卸し時はこのマーカーより上を最新の現在地に保つこと。 -->

## 方向性 G: 意味計算(RRULE 展開・TZ 解決・free-busy)— 現在の本命

- **発端**: agentic 入口(E)の中核能力は「イベントの理解」と「free-busy」という
  ユーザー判断。一次資料は **docs/modeling/08**(RFC 義務・競合実態・TZ 流派・コスト試算)、
  優先度の補正は **09**。
- **発見**: time-range フィルタの RRULE 展開は RFC 4791 の MUST(calendar-query 自体が
  REQUIRED、非対応表明は不可)。現状は厳密には RFC 非準拠 = コア価値に照らしいずれ必須だった。
  一方、09 の調査による粒度補正: ①CALDAV:expand は実は REQUIRED でない(calendar-data の
  子要素)+ iOS はクライアント展開する → 優先度低 ②free-busy-query は REQUIRED だが
  実クライアントは叩かない(Google すら未実装)→ 「iOS のためでなく RFC 準拠と agentic の
  ために作る」機能 ③展開・availability はモダン API(Google/Graph/JMAP)の第一級機能で、
  Nextcloud/Cal.com も本気の計算はアプリ層でやっている。
- **確定した設計判断**(08 §6): TZ は IANA tzdb を正・VTIMEZONE は保存のみ /
  RRULE 反復は ical.js をアダプタ内側に採用(rrule.js は不採用)/
  sabre 式 first/last occurrence 索引を D1 に(PUT 時計算)+ REPORT 時にヒット行のみ展開 /
  展開済みテーブル・KV/Cache キャッシュ・DO は不採用 / 展開上限を API に組み込む。
  コストは実質 $5/月の基本料のみ(CPU-ms 課金、詳細試算は 08 §5.5)。
- **タスク分解**:
  - ~~G-1: TZ 解決層(IANA 名直引き → Windows 名マップ → VTIMEZONE 推測 → 明示エラー。
    Workers の Intl/ICU 利用)+ floating/DATE の実効値算出(§9.9 の表)。~~ ✅
    > **2026-07-11 更新:** 完了。`src/domain/ical/timezone/`(errors / windows-zones /
    > resolver / instant / effective-period)+ テスト 23 件、227 tests green。
    > 実装メモ: floating の既定ゾーンは **UTC を明示**(§7.3 の MAY を暗黙にしない)/
    > DURATION 加算は weeks・days=壁時計 nominal・h/m/s=exact / DST の穴・重なりの
    > 解決値はテストで絶対 epoch 値に固定(ICU/tzdb 更新の検知線)。詳細は各ファイル冒頭コメント。
  - ~~G-2: RecurrenceExpansion ドメインサービス(03 §1-4 の輪郭どおり、ical.js アダプタ +
    オーバーライド解決 + 展開上限)。~~ ✅
    > **2026-07-11 更新:** 完了。`src/domain/ical/recurrence/`(iterator-port /
    > occurrence / expansion)+ `src/infrastructure/recurrence/icaljs-rrule-iterator.ts`
    > (ical.js v2.2.1 を RRULE 反復だけに使用・port&adapter で隔離、domain は ical.js 非依存)。
    > テスト 11 件、238 pass。実装メモ: UNTIL は iterator に渡さず epoch 厳密で inclusive 判定 /
    > 展開はローカル壁時計列挙 → occurrence ごとに G-1 で UTC 化 / I9(DATE dtstart の
    > BYHOUR 等)は展開層で「無視」を実装 / 各回の実効期間は master の DURATION・DTEND を
    > nominal/exact 使い分けで継承 / detached オーバーライドも結果に含める(iOS 実データ耐性)。
    > **既知の制約**: maxOccurrences は dtstart からの列挙総数で消費するため、range が
    > 遠い未来 × 古い dtstart の無限 RRULE では range 到達前に予算切れになりうる →
    > **G-3 の sabre 式 first/last 索引による事前絞り込みが解決する**(そのための索引)。
  - ~~G-3: first/last occurrence 索引(D1 スキーマ。A-1 と同じマイグレーション体系に乗る
    前提で設計、結合はしない)+ calendar-query の time-range フィルタ
    (方向性 C の中核が前倒しでここに来る)。**完了時点で C の tsdav CI ハーネスを前倒し着手可**。~~ ✅
    > **2026-07-11 更新:** 完了。設計は Fable subagent が策定 → Opus 承認(手戻りコストの
    > 大きいスキーマ/PUT 配線判断のため)。実装 = sonnet。256 tests green。
    > 成果: `migrations/0002_occurrence_index.sql`(first/last 列 + 複合索引、NULL=常に候補、
    > 無限反復は 2100 キャップ)/ `occurrence-bounds.ts`(PUT 時に expandRecurrenceSet 再利用、
    > 無限反復のみ展開回避)/ `calendar-query.ts`(SQL 粗絞り込み + ±24h スラック → 展開して
    > §9.9 判定)/ presentation の `parseCalendarQueryFilter`(ネスト対応のバランス走査)。
    > 未対応 filter(prop-filter 等)は黙殺せず **403 supported-filter**。floating は UTC 索引化 +
    > クエリ時スラック補償。**C の tsdav CI ハーネスが前倒し着手可能になった。**
  - ~~G-4: free-busy 計算ユースケース + free-busy-query REPORT(TRANSP/STATUS → FBTYPE)。
    MCP 表面の設計は 09 §1 の共通形(時間窓必須 + 応答TZ分離 + JSON busy区間)に従う。~~ ✅
    > **2026-07-11 更新:** 完了。設計 = Opus(RFC 4791 §7.10 の FBTYPE 表を原文照合)、実装 = sonnet。
    > `src/domain/ical/freebusy/`(deriveFreeBusyType + coalesceBusyIntervals: 同型のみマージ・
    > 異型は重複可)/ `compute-free-busy.ts`(出力は構造化 BusyInterval[] = epoch ms・TZ 非依存で
    > G-5 MCP と共用。CalendarQuery と同じ2段フィルタ + range クリップ + coalesce)/
    > presentation の parseFreeBusyQuery + serializeFreeBusyResponse(既存 serialize() 再利用で
    > VFREEBUSY を text/calendar 出力、空でも VFREEBUSY は返す §7.10 MUST)。object に対する
    > free-busy-query は 403。280 tests green。**応答 TZ 分離の実証** = UC は busy 区間だけ返し
    > iCalendar 化は presentation。G-5 はこの UC をそのまま MCP ツールに露出する。
  - ~~G-5: MCP 照会ツール(list-events-expanded / get-freebusy / get-current-time)—
    E の先鋒。application 層の共通ユースケースを DAV と MCP の両入口から呼ぶ実証。
    **ここで設計するツールの語彙(名前・引数・応答形)は将来 MCP Apps / WebMCP にも
    そのまま露出する原型になる(11 §4)。特定の入口に依存しない形で application 層に置く。**~~ ✅
    > **2026-07-11 更新:** 完了。設計 = Fable、実装 = opus 途中(認証ポート)→ opus セッション上限
    > → sonnet が続行。343 tests green。トランスポート = `@hono/mcp` を `/mcp` にステートレス
    > マウント(McpAgent/DO は使わない = キットのマウント可能思想)。認証 = 静的 Bearer だが
    > **OAuth-ready な AuthenticationPort**(audience 検証の口つき、A で workers-oauth-provider に
    > ミドルウェア差し替え)。3ツールは offset 付き ISO8601・応答 TZ 分離・epoch 非露出・dayOfWeek
    > 明示・truncated フラグ。ListOccurrences UC を再利用、calendarId 省略で全カレンダー集約。
    > **DAV と MCP が同じ application UC を呼ぶ複数入口ビジョンの実証完了。** MCP 統合テスト
    > (initialize/tools-list/tools-call・Bearer 401/200)込み。書き込み・OAuth・MCP Apps は E。
  - ~~G-6: supported-calendar-component-set の明示宣言(宣言しないと「全コンポーネント
    MUST accept」— VJOURNAL を**含めて**宣言する。09 §4a 参照)。~~ ✅(J-2 に統合)
    > **2026-07-11 更新:** G-6 は J-2 に吸収して完了。collectionProps のフォールバックを
    > COMPONENT_KINDS 化(宣言=受理を一致、§5.2.3)/ parseCollectionProperties を複数 comp +
    > VJOURNAL 対応 / MKCALENDAR で VJOURNAL コレクションをオプトイン作成可能に。
    > journal は自動 provision しない(除去可能性優先)。301 tests green。
    > iOS 実機での calendar/tasks 非回帰確認だけ保留(J-4)。

## 方向性 J: 採択途中 RFC への先行投資(agentic タスク管理の本丸)

- **発端**: 「使われていない RFC を切る」だけでなく「採択途中の RFC で先行者になる」
  逆張り(ユーザー方針)。一次資料は **docs/modeling/09 §4**。
- **2026-07-11 設計方針(Fable 設計 → Opus 承認 → ユーザー確認)**: 「journal」を安定度で3層に
  分けて疎結合に扱う。①VJOURNAL コンポーネント = RFC 5545 の確定仕様(素直に格納・検証・往復)
  ②「agentic 日誌」製品コンセプト(journal コレクション常設 + RELATED-TO 紐付け)= 未確定の賭け
  → **オプトインにして綺麗に除去可能に保つ**(自動 provision しない。ユーザー判断 2026-07-11)
  ③ical-tasks/9253 プロパティ = draft → 読み取り専用・検証なし・string 型で追従リスク最小。
  実装分割: J-1 基盤 ✅ / J-2 宣言是正+journal オプトイン / J-3 draft アクセサ先取り(原文
  スナップショット後)/ J-4 実機検証・time-range query。詳細は Fable 設計メモ(log.md 参照)。
  - ~~J-1: VJOURNAL 基盤(component-kind / migration 0003 で CHECK 拡張 / VJournal レンズ /
    journals() / occurrence-bounds / PUT / comp-filter は range 無しのみ)。~~ ✅
    > **2026-07-11 更新:** 完了。migrations/0003(12-step テーブル再作成で 0002 の列・索引を
    > 完全再現)/ vjournal.ts(§3.6.3: DTEND/DURATION/DUE/VALARM 無し、DESCRIPTION 複数可・
    > RELATED-TO[RELTYPE 既定 PARENT]、共有 validateRRule 流用)/ COMPONENT_KINDS に追加で
    > put-preconditions は自動受理。VJOURNAL+time-range は unsupported(J-4 送り)。295 tests green。
    > レンズには日誌ビジネスルールを入れず標準の値検証のみ(除去可能性の担保)。
- **VJOURNAL**: 実装コストほぼゼロでサーバー側対応の薄さが生態系のボトルネックそのもの。
  「agent の実行ログ・日誌を時系列に置き RELATED-TO でタスクに紐づける」— 長期ビジョン
  「agentic なタスク管理の基盤」の本丸。検証クライアントは jtx Board + DAVx⁵。
- **ical-tasks draft(RFC Editor Queue 入り、数ヶ月で RFC 化)+ RFC 9253**:
  SUBSTATE(OK/ERROR/SUSPENDED)・STATUS:PENDING/FAILED・REASON・ESTIMATED-DURATION・
  DEPENDS-ON・REFID は agent のタスクグラフ実行ランタイムの状態モデルそのもの。
  競合実装ほぼ皆無 = 差別化。ドメイン層(vtodo.ts 系)に先取りで織り込む。
  - ~~J-3: ical-tasks/9253 の型付きアクセサ先取り(vtodo.ts + VJournal 共通 relatedTo)。~~ ✅
    > **2026-07-11 更新:** 完了。原文スナップショット(docs/rfc/rfc9253.txt・
    > docs/specs/draft-ietf-calext-ical-tasks-17.txt)を取得してから照合実装。**原文が設計メモを
    > 複数訂正**(SUBSTATE/REASON は VSTATUS サブコンポーネント内・REASON は URI・DEPENDS-ON は
    > RELATED-TO の RELTYPE 値・GAP は RELATED-TO パラメータ・REFID は反復プロパティ。照合結果は 05)。
    > vtodo.ts に substate/reason/estimatedDuration/dependsOn/refids/relatedTo、helpers に共通
    > relatedToOf。**全て読み取り専用・検証なし・string 型(union にしない)= draft 追従リスク最小**。
    > CONCEPT/LINK は生値保持のみ。309 tests green(ACKNOWLEDGED 回帰込み)。**方向性 J 一区切り。**
- RFC 9074 ACKNOWLEDGED は生値保持で既に充足(06 A9)— 壊さない状態を維持。
- VAVAILABILITY(7953)は G-4/B のタイミングで、JSCalendar は変換 draft の RFC 化後に
  MCP/REST の JSON 表現として検討(09 §4b)。

## 方向性 A: M2 マルチユーザー

- **発端**: 現状は単一ユーザー Basic(secrets 直)。スケジューリング(方向性 B)の前提。
  secret 消失障害(2026-07-10、log.md)の本質解決でもある(D1 salt付きハッシュへ移行)。
- **確定した方針**(docs/modeling/07): Basic over HTTPS + App Password が業界デファクト。
  32文字級サーバー生成 → Argon2id/bcrypt で D1 保存 + レート制限。OAuth は方向性 E まで持ち越し。
  iOS アカウント追加は .mobileconfig 配布を正式ルート(App Password 発行 → ワンタイム URL で
  プロファイル DL。平文が入るので HTTPS + 使い捨て URL 必須、署名は後回し可)。
- **タスク分解**:
  - A-1: ユーザー / App Password の D1 スキーマ + principal 複数化。
    **方向性 D の先行準備を織り込む**: コレクション×principal の権限表
    (current-user-privilege-set を実データ化 — ここを逃すと D で手戻り)。
    G-3 の occurrence 索引と同じマイグレーション体系に乗せる。
  - A-2: 認証ミドルウェアの差し替え(Argon2id 検証 + レート制限)。
  - A-3: App Password 発行フロー + .mobileconfig ワンタイム配布。
  - A-4: プロキシ内部認証を共有シークレット → HMAC 署名へ格上げ(OSS 公開時までに)。

## 方向性 E: M6 agentic 入口(長期ビジョン本命)

- MCP / REST アダプタ(application 層は DAV 非依存済み)、メール起点のタスク追加(K-4)。
- OAuth(Bearer)はここで導入(docs/modeling/07)。
- **B より先と確定**(2026-07-11 ユーザー判断。根拠: E はコアドメインで B は支援 /
  G-5 で先鋒が立つため増分小 / B は A + K-1/K-2 と依存の鎖が長い)。
- **WebUI は独立した製品要素として持つ**(2026-07-11 ユーザー判断): CalDAV は GUI ありきの
  プロダクトであり、iOS クライアントだけに依存しない。tsdav 直 CalDAV か REST アダプタ
  経由かは E 設計時の論点(直なら Worker に CORS + DAV メソッドの preflight 対応が必要)。
- **露出面は三面**(一次資料は **docs/modeling/11**): MCP サーバー / MCP Apps
  (チャット内 generative UI、2026-01 安定版の公式拡張 — E 設計前に ext-apps spec を読む)/
  WebMCP(WebUI をブラウザエージェントに開く、Chrome 149 オリジントライアル中 —
  WebUI が立った時点で実験。J と同じ先行投資の思想)。三面とも同じ application 層の
  語彙(G-5 が原型)の別露出面であり、ドメイン・application 層への影響はゼロ。
- **OAuth-for-MCP**: ~~第2スライス(@cloudflare/workers-oauth-provider 導入。src/index.ts /
  src/app.ts の物理分離込み)~~ ✅ ~~第3スライス(authorize UI = GET/POST /authorize の実装)~~ ✅
  ~~完了。次は OAuth フロー全体(DCR → authorize → token)の実機/統合検証。~~ ✅
  > 2026-07-12 更新: **本番実機受け入れ成功**。`68cb67b` を deploy、Claude カスタムコネクタで
  > OAuth(DCR→authorize でパスワード同意→token)接続 → 3ツール動作 → list-events-expanded が
  > RRULE 展開5件を返却。スモーク(well-known・401 discovery・静的 Bearer 経路)も全て green。
  > 経緯は docs/log.md 2026-07-12 / メモリ mcp-auth-and-generative-ui-strategy。
  > 2026-07-12 起票【運用ギャップ・要対応】**deploy と D1 マイグレーションの乖離**:
  > 「main push で worker は Workers Builds 自動 deploy だが D1 マイグレーションは手動 apply」。
  > 今回 0002/0003 未適用のまま deploy し、list/freebusy が `last_occurrence` カラム無しで
  > 落ちた(get-current-time は DB 非依存で動いた)。手動 `wrangler d1 migrations apply --remote`
  > で解消したが、次スキーマ変更で再発する。対応案: (a) Makefile に `deploy-migrations` ターゲット
  > 明文化 + deploy チェックリスト化 / (b) Workers Builds のビルドコマンドに組み込む
  > (本番 DB 変更を自動化してよいかは方針判断 — 手動承認を残す派もある)。vitest-pool-workers
  > 導入より先に軽く片付ける候補。
  > 2026-07-12 更新: **方針確定・実装済み**。前方互換(expand/contract)規律 +
  > Workers Builds の deploy command で migrate→deploy を自動化する方式を採用
  > (package.json `deploy` script = `wrangler d1 migrations apply --remote && wrangler deploy`、
  > Makefile に手動用 `deploy-migrations` 追加、規律の明文化は migrations/README.md 新設)。
  > 2026-07-12 完了 ✅: (1) 本番ブランチの deploy command を `bun run deploy` に設定済み
  > (非本番ブランチは `wrangler versions upload` のまま=未マージ migration を本番 D1 に
  > 当てない。migrations/README.md 参照)。(2) 初回ビルド `afecc023` で
  > `wrangler d1 migrations apply --remote` が**認証エラーなく実行**され自動 migrate→deploy が
  > 稼働することを実測(暗黙トークンでリモート D1 に届く=CLOUDFLARE_API_TOKEN 追加は不要)。
  > → 運用ギャップは恒久対応完了。
  > 2026-07-12 追記: 第3スライスで `completeAuthorization({ props })` を呼ぶときは、
  > **必ず `{ username }` 形(`OAuthPrincipalProps`)を渡すこと**。これを守らないと
  > OAuthPropsAuth(src/infrastructure/auth/oauth-props-auth.ts)が
  > `ctx.props.username` を読めず principal を解決できず、全 MCP 呼び出しが 401 になる
  > (第2スライスとの暗黙契約。resolveExternalTokenForMcp が返す props も同じ形に
  > 合わせてある — src/app.ts 参照)。
  > 2026-07-12 追記(第2スライス SHOULD-3 対応時に起票)【別タスク・OAuth 完了後】
  > **vitest-pool-workers をハイブリッド導入**する: bun test は純ドメイン/application に
  > 残したまま、workerd 上には D1 実 SQL・KV・OAuth E2E(DCR → authorize → token の
  > フロー全体。cloudflare:workers を静的 import する OAuthProvider は bun test に
  > 乗らないため、これは workerd 実行でしか検証できない)だけを新設する。全面移行は
  > しない(bun test の速さを application/domain 層で失いたくない)。詳細設計は着手時に
  > 一次確認する: ① `applyD1Migrations` の API(wrangler の内部 helper か、vitest-pool-workers
  > 側に相当品があるか)② `export default new OAuthProvider(...)`(src/index.ts の
  > exports.default.fetch)が vitest-pool-workers の worker 実行環境でそのまま動くか
  > ③ GitHub Actions 上で workerd 実行(miniflare 経由)が問題なく走るか(メモリ/時間制約)。
  > **2026-07-12 完了 ✅**: 調査(sonnet)→ 設計(Fable)→ 実装(sonnet)で 2 スライス完了。
  > ~~詳細設計は着手時に一次確認~~ → 一次調査で **現行 API が v0.13+ で刷新済み**と判明
  > (`defineWorkersConfig`/`SELF` は廃止 → `cloudflareTest()` plugin + `exports.default.fetch`。
  > 「設計は調査の後」が効いた)。`test/worker/`(vitest 専用第2レーン)を新設し bun test は無変更。
  > スライス1(スパイク `73f420f`)で未確定6点を全て真と確定(fallback 不要): ①素の
  > OAuthProvider を exports.default.fetch で叩ける ②KV は configPath 経由で自動起動・
  > ファイル内 state 持続 ③D1 は readD1Migrations + applyD1Migrations(setupFile)で適用
  > ④bun-types と cloudflare:test 型は共存不可 → test/worker 専用 tsconfig で分離。
  > スライス2(E2E `dd17b23`)で DCR→authorize→token→/mcp を workerd 上で一気通貫検証 +
  > 静的 Bearer 経路 + 失敗系。実挙動の学び: **DCR は `token_endpoint_auth_method: "none"`
  > 明示が必須**(省略で confidential client 扱い → token 交換が 401。本番 Claude コネクタ
  > 接続成功と整合)/ `/mcp` は単発でも SSE で返る(Accept に text/event-stream 必須)。
  > CI に workerd step 追加(secret 不要=ダミー secret を miniflare.bindings 注入)。
  > 振り分け基準は Makefile check ターゲット・vitest.config.ts に厚くコメント。
  >
  > 2026-07-12 更新: **E-1(VTODO を chat から読み書きする MCP ツール)着手**。
  > 調査(sonnet)→ 設計(Fable)→ 実測(iOS 実機 docs/modeling/06 §D)→ 実装(sonnet)。
  > **語彙は todo で統一**(create-todo / list-todos / complete-todo / update-todo / delete-todo)。
  > **スライス①完了 ✅**(`b18efe9`): ドメイン書き込み経路(structure/edit.ts の汎用 upsert
  > プリミティブ + semantics/vtodo-write.ts の VTODO builder。レンズに setter を生やさず
  > ロスレス維持)+ CreateTodo/ListTodos(既存 PutCalendarObject を must-not-exist で合成)+
  > MCP `create-todo`/`list-todos` + E2E。id=UID、出力は E-2 UI-ready な共通 Task DTO。
  > 実機受け入れ: **MCP で作った todo を iOS が素直に読み書き**(06 D8。If-Match に我々の ETag、
  > DTSTART=DUE 終日・PRODID を iOS が受容、SEQUENCE 据え置き)。
  > **スライス②(次)**: complete-todo / update-todo / delete-todo。実測で仕様確定済み —
  > update/complete = read→patch→**must-match** PUT(iOS が我々の ETag で If-Match を打つ)・
  > **SEQUENCE 据え置き**、delete = ETag 条件なし、**反復完了 = 06 D4 モデル**(新 UID で完了
  > スナップショット作成 + マスターの DTSTART/DUE 前進。拒否ではなく iOS 忠実に実装)。反復の
  > 作成(RRULE 付き create)もここで。残る実機検証は V2/V3(完了を我々から書いて iOS に反映
  > されるか)・V5(サーバー発 VALARM が鳴るか)・V6(時刻付き due の VTIMEZONE)。
  > **iOS 連携の天井が確定**(06 §D2/D3): フラグ・画像・サブタスク・タグは iOS が CalDAV
  > アカウントでグレーアウト/CloudKit 限定で**不可**。優先度=1/5/9(緊急なし)。これらは
  > 我々の chat 面でだけ CATEGORIES/RELATED-TO 拡張として将来持てるが iOS には映らない前提。
  > **E-2(MCP App UI・ext-apps/SEP-1865)**: スライス②後。tdr-concierge 方式(registerAppResource/
  > registerAppTool + 自己完結バンドル。esm.sh は Claude iOS で失敗する教訓)。OpenAI todo
  > ウィジェットが参照。最大リスク=個人コネクタで UI 描画されるか(要実機。極小 ui:// スパイクで
  > 先に潰す)。Task DTO は既に UI-ready で固定済み。
  >
  > **2026-07-13 更新: tdr-concierge 実装を調査 → 描画リスクはほぼ解消。** ユーザーが tdr-concierge
  >   (`~/ghq/github.com/gigun-dev/tdr-concierge`)でカスタムコネクタに UI 描画済み。同じ Hono/CF Workers
  >   構成なのでレシピをほぼそのまま移植可(詳細メモリ [[mcp-auth-and-generative-ui-strategy]] に追記)。
  >   具体: `@modelcontextprotocol/ext-apps`(server + browser)/ `registerAppResource`(`ui://` HTML)+
  >   `registerAppTool`(`_meta.ui.resourceUri` で紐付け)/ `@hono/mcp` StreamableHTTPTransport /
  >   `@modelcontextprotocol/sdk ^1.29` / zod 3.25+(ext-apps が zod/v4 サブパス要求)。UI は
  >   **自己完結 HTML に bun build で単一 ESM バンドル**して `<script type=module>` へインライン
  >   (esm.sh 実行時 import は Claude iOS で壊れた実証教訓)。text 要約 + structuredContent の二本立てで
  >   UI 非対応ホストでも会話が壊れない。`ontoolresult` で structuredContent を UI に push。
  >   参照実装: tdr-concierge `src/mcp/server.ts`(registerApp* 呼び出し)/ `src/ui/*`(HTML+entry+bundle)/
  >   `scripts/build-ui-bundle.ts` / `docs/research/connectors-and-generative-ui.md`。
  >   **⚠️ caldav 固有の新論点(tdr-concierge では未検証)**: tdr は authless read-only だが caldav は
  >   **書き込みあり + OAuth 保護**。UI からの `App.callServerTool` の**認可コンテキスト**をどう通すかは
  >   要設計・要実機。→ 極小スパイクの目的を「描画されるか」から「**OAuth 保護 + 書き込み可サーバーで
  >   UI から callServerTool が認可付きで通るか**」に更新する。実機は claude.ai Web の Connector 経由
  >   (Claude Code では描画確認不可)。
  >
  > **2026-07-13 更新: E-2 スパイク スライス① 実装完了 ✅ `63b5d46`(実機描画は未確認)。**
  >   `@modelcontextprotocol/ext-apps` を追加し `list-todos` を `registerAppTool` 化(_meta.ui.resourceUri
  >   追加のみ=非破壊・可逆)+ `registerAppResource(ui://caldav/todos.html)`。UI は
  >   `src/presentation/mcp/ui/`(entry→build-ui-bundle→bundle→app HTML インライン)。depcruise
  >   `mcp-ui-is-terminal` で末端強制・`tsconfig.ui.json` で DOM 隔離・`typecheck:ui` を make check に。
  >   make check green・Worker upload gzip 448 KiB。
  >   **2026-07-13 追記: スライス① 描画検証 合格 ✅**。chrome-devtools で本番 MCP(OAuth 認証済み)を
  >   MCP Inspector 経由で駆動 → Apps タブで list-todos を実行 → **サンドボックス iframe に UI が実データで
  >   描画**(resources/list に "Todos View"・list-todos が _meta.ui.resourceUri で App 認識・
  >   App.connect→ontoolresult→render が本番バンドルで動作)。**Inspector の Apps タブが mcp-app を
  >   フル描画できる**ため claude.ai Web を待たず main 側で検証完了。気づき: 期日が UTC 整形で "00:00"
  >   表示(list-todos を timeZone 未指定で呼んだため。UI は忠実。実運用は timeZone 渡し or UI 側ローカル
  >   整形が要る=後続の詰め)。**次: スライス②(app 専用 `refresh-todos` + `App.callServerTool` で OAuth
  >   認可コンテキスト検証)**。
  >   **2026-07-13 追記: スライス② 実装 + 検証 合格 ✅ `1961cd1`**。app 専用ツール `refresh-todos`
  >   (`_meta.ui.visibility:["app"]`)を追加(handler は list-todos と同じ `runListTodos` 共通クロージャ=
  >   認可経路を完全共有)。UI に「再読み込み」ボタン → `App.callServerTool({name:"refresh-todos"})` →
  >   structuredContent.tasks で再描画。chrome-devtools で Inspector Apps タブから検証: ボタン押下で
  >   **エラーなくカード再描画**=callServerTool がプロキシ経由でサーバーに届き **OAuth の principal
  >   (admin)のタスクを返した**(認可コンテキストが callServerTool 経路でも AuthenticationPort→principal で
  >   効くことを実証)。callServerTool は app プロキシ channel(:6277/sandbox)を通り Inspector 主 History とは
  >   別経路=transcript 分離の機序も確認。**注意: visibility:["app"] でも tools/list には出る**(提示ヒントで
  >   あってプロトコル除外ではない。テスト本数 8→9)。真の「会話 transcript 非出現」は claude.ai Web でのみ
  >   最終確認可能だが機序は確認済み。**E-2 スパイク(描画 + callServerTool 認可)完了。次: E-2 本実装
  >   (UI の作り込み・期日 timeZone 整形・複数ツール UI 化)or 別方向性へ。**
  > **2026-07-12 更新: スライス②-a/②-b 完了 ✅**(`6798fdf` ②-a / `44c9f2f` ②-b)。
  > - ②-a: 生成プロパティを vtodo-stamp.ts(stampCreate/stampUpdate)に一本化。X-APPLE-SORT-ORDER
  >   = CFAbsoluteTime(unix秒 − 978307200・実測 805549710 固定値テスト)。list 既定順を sortOrder 昇順。
  > - ②-b: UpdateTodo/CompleteTodo/DeleteTodo + lossless read→patch(vtodo-patch.ts)。既存 VCALENDAR の
  >   対象 VTODO サブコンポーネントだけを差し替え、VALARM/VTIMEZONE/X-APPLE-* をバイト保持。reopen は
  >   update-todo.status に集約、delete は無条件、反復完了は RecurringCompletionNotSupportedError で拒否。
  > - **V2 実機受け入れ成功**(iOS 26.5・本番): update(title/due/priority)/ complete / reopen / delete が
  >   すべて iOS リマインダーに反映。D1 実データで **VALARM が update 後もバイト保持されていること**を確認
  >   (lossless の実証)。update で時刻付き due → 終日 due への変換も TZID を正しく除去。
  > - **⚠️ 新タスク①【VALARM 追随・②-c とは別スライス】**: `update-todo` で `due` を動かしても、元の
  >   絶対 VALARM トリガー(`TRIGGER;VALUE=DATE-TIME:...`)は取り残される(V2 で顕在化: due を 12-23 へ
  >   動かしたのにアラームが旧 due 時刻 07-13 のまま → iOS がその通知時刻を表示する「取り残されアラーム」)。
  >   lossless 保持自体は正しいが、意味論として「due 連動アラームは追随すべき」。方針(2026-07-12 ユーザー
  >   確定=前者): **今は既知の制限として切り出し、②-c を先に進める**。将来の VALARM 管理スライスで
  >   「旧 due 時刻と一致する絶対トリガーを新 due に移す」精密な追随を設計(V5 サーバー発 VALARM と同じ束)。
  >   ヒューリスティック(due 連動 vs ユーザー設定の早期リマインダーの判別)を含むため独立テーマ。
  > - **新タスク②完了 ✅**(`c7af31b`): VTODO occurrence bounds のバグ修正。computeVTodoBounds が
  >   DTSTART/DUE/COMPLETED/CREATED の無条件 min/max だったのを RFC 4791 §9.9 表どおり行優先に(CREATED/
  >   COMPLETED は DTSTART も DUE も無いときのみ)。単発 VTODO で first が CREATED まで巻き戻る取りこぼしリスクを解消。
  > - **新エッジ(反復 due→DATE の I6)完了 ✅**(`c7af31b`): patchVTodoFields で due を DATE に patch する際
  >   RRULE UNTIL が DATE-TIME なら日付を保って DATE 化(I6 回避)。iOS 発反復マスターの due 変更を救済。
  > - **スライス②-c 完了 ✅**(`e9e47bc`): 反復完了を拒否せず D4 モデルで実装。vtodo-recurrence.ts の
  >   純関数2つ(buildCompletionSnapshot = 新 UID・RRULE 除去・3点セット・DTSTART/DUE 継承・VALARM を
  >   UID/X-WR-ALARMUID 新採番でコピー / advanceMasterToNextOccurrence = 次 occurrence へ前進・DUE−DTSTART
  >   壁時計差保持・COUNT は §3.3.10 根拠で1減算・UNTIL inclusive・最終回は exhausted)+ recurring-completion.ts の
  >   snapshot-first 非原子2PUT(a:新 UID must-not-exist → b:マスター前進 must-match、失敗モード明文化)。
  >   最終 occurrence はスナップショット無しでマスター完了(実測未確定=06 §D4 に V8 として起票)。
  >   RRULE 展開は既存 RecurrenceIterator へ委譲。bun 427 + vitest 13 green。
  >   **VALARM 前進の追加修正 ✅**(`aca8193`): V3 実機で「マスターの表示日付が前進しない」→ iOS は表示時刻に
  >   VALARM トリガーを使うため、前進時に絶対トリガーを据え置くとフリーズして見えると判明。本番 D1 で iOS
  >   ネイティブ完了を実測(CAP-RRULE2: TRIGGER 20260712T160000Z→20260713T160000Z = DTSTART と同じ絶対時間差で
  >   前進)し、advanceMasterToNextOccurrence に advanceAbsoluteAlarmTriggers を追加(triggerShiftMs=nextEpoch−currentEpoch、
  >   TRIGGER;VALUE=DATE-TIME だけ前進・相対トリガー/X-APPLE-PROXIMITY は据え置き)。
  >   **V3 合格 ✅**: 修正後、サーバー駆動の反復完了が iOS に正しく反映(前進後マスター DTSTART/VALARM が iOS
  >   ネイティブ出力と構造完全一致)。当初「前進しない」と見えたのは iOS のキャッシュ/同期遅延で、強制再同期
  >   (アプリ終了 or アカウント off/on)で解消。sync_changes・sync_counter は PUT で正しく進む(D1 実測)。
  >   **残:** V8(最終回スナップショット有無の実測)。
  >   **タスク①完了 ✅**(`1f4bec4`): update-todo の due 変更で VALARM 追随。②-c の前進プリミティブを
  >   vtodo-patch.ts の `shiftAbsoluteAlarmTriggers` として共有化し、due 変更時に (新due−旧due) ぶん絶対
  >   トリガーを shift(オフセット保存)。週末反復(BYDAY=SU,SA)の VALARM 前進を不揃い間隔(6日→1日)で
  >   固定値検証=前進量が固定周期でなく iterator の実 occurrence 間隔である裏取り。V2 の取り残されアラーム解消。
  >   **新エッジ【反復 todo の due→DATE 変更で I6 違反】**: 反復マスターの RRULE が `UNTIL=...Z`(DATE-TIME)の
  >   とき、update-todo の due 変更は DTSTART を VALUE=DATE にするため UNTIL の値型と食い違い I6 事前条件で
  >   エラー(サイレント破損ではなく明示エラー)。反復 todo の due 変更自体がレア(シリーズ anchor を動かす)
  >   なので優先度低。直すなら due patch 時に UNTIL も DATE 化する等。要判断。
  >   **タスク③完了 ✅**(`03540c0`): 反復付き create-todo。MCP create-todo に recurrence 入力
  >   (frequency/interval/weekdays/count/until)を追加、buildVTodoCalendar が RecurrenceRule → RRULE 生成。
  >   until は DTSTART の VALUE=DATE に合わせ DATE 型で出し I6 を構造的に回避(§3.3.10 原文根拠)。recurrence は
  >   due 必須・count/until 排他(I5)・weekdays は weekly のみ、を専用エラーで明示。反復 create→complete が
  >   ②-c の D4 経路で動くことを e2e 検証。chat から反復 todo をゼロから作れるように。
  >   **V8 完了 ✅ + 設計修正**(`711d7c4`): 本番実機実測(FREQ=DAILY;UNTIL=20260714・07-13/07-14 完了)で
  >   当初設計(最終回はスナップショット無し・その場完了)が**iOS と食い違うと判明**。iOS は最終回でも
  >   ①スナップショット作成 ②マスターを UNTIL 越えの次ステップ(07-15)へ前進 + STATUS:COMPLETED(RRULE 維持)。
  >   → advanceMasterToNextOccurrence を「常に次の生ステップへ前進し seriesEnded を返す」契約に変更・STATUS 決定を
  >   completeRecurringTodo へ引き上げ・**常に snapshot-first の2PUT に均一化**。exhausted 特別扱いは廃止
  >   (no-next-step の病的ケースのみ保険)。
  >   **COUNT 宿題クローズ(2026-07-13 B-2 実測)**: iOS は「繰り返し N 回」を **COUNT でなく UNTIL** で保存する
  >   ことが判明(iOS は RRULE に COUNT を一切出さない)。よって COUNT の iOS 実測基準は存在せず照合不能=
  >   我々の COUNT 処理は自前機能(タスク③ create)の内部整合のみ守ればよい(テスト済み)。V8 は B-2 で再確認。
  >   **小課題掃除完了(2026-07-13)**: 新タスク②(bounds)・新エッジ(due→DATE の I6)`c7af31b` / V5 前提の
  >   create-todo アラーム生成 `8903a9f`。残る実機は **V5 発火**(下記)、据え置きは V6(VTIMEZONE・E-2 後)。
  >   **E-1 スライス②系すべて完了。** agentic todo 入口(create/list/update/complete/delete・単発/反復・
  >   VALARM 追随/生成・反復の D4 完全再現)が iOS 忠実に揃った。
  >   **次の本線: E-2(MCP App UI・ext-apps/SEP-1865)**。Task DTO は UI-ready で固定済み。極小 ui:// スパイクで
  >   「個人コネクタで UI 描画されるか」を先に潰してから本実装(tdr-concierge の registerAppResource/registerAppTool 方式)。
  >
  > **2026-07-13 更新: V6(時刻付き due 統合)完了 ✅ `5bb66dd` + Case E `47dd81d`。**
  >   create-todo の due を判別 union 化し `"YYYY-MM-DDTHH:MM:SS"` + timeZone(IANA 名)を受理。
  >   DTSTART;TZID/DUE;TZID を同値で立て、§3.6.5 の VTIMEZONE をサーバー生成して同梱
  >   (timezone/vtimezone-write.ts 新設・Phase 1 = 固定オフセットゾーン限定。DST は
  >   UnsupportedTimeZoneError で塞ぐ)。独立 alarm 入力は廃止し due に統合(時刻付き due には常に
  >   VALARM 自動生成。V5 で「iOS はサーバー発 VALARM でも通知」確定)。offset 付き ISO8601 は拒否
  >   (TZID を offset から一意逆引き不能)。RRULE UNTIL 値型を due に追従(I6)。
  >   **Case E**: recurrence.frequency に `"none"`(繰り返さない)+ `.default("none")` を追加し
  >   Inspector 手動フォームの `{frequency:""}` バグを presentation 層で吸収(application には漏らさない・
  >   "none"+サブフィールド併用はエラー)。
  >   **残る実機: V6 手順**(時刻付き due の iOS 表示・通知・往復 VTIMEZONE 保持)。据え置き: V6 Phase 2(DST ゾーン)。
  >
  > **2026-07-13 更新: V6 実機検証 合格 ✅。** 本番 MCP を chrome-devtools で駆動し時刻付き due を作成 →
  >   本番 D1 の生 ICS で VTIMEZONE(`DTSTART:19700101T000000`・+0900)/ DTSTART;TZID=DUE;TZID /
  >   VALARM 絶対 UTC TRIGGER(JST09:00=UTC00:00)/ UID==X-WR-ALARMUID / RRULE 無し(Case E)を確認。
  >   **iOS 実機で時刻付き期限が正しく表示**(通知は V5 確定の同形 VALARM で確実)。**E-1 完全クローズ。
  >   次の本線 = E-2(MCP App UI)**。据え置き: V6 Phase 2(DST ゾーン)。

## 方向性 H(購読カレンダー・外部データ集約)【E/A の後・優先度中】

- 2026-07-12 起票(ユーザー着想)。iOS が PROPFIND する `source`/`subscribed-strip-*`/
  `apple:refreshrate` に対応 = 外部 .ics(webcal)を購読して読み取り専用で取り込む。
- agentic ビジョンにも効く(外部カレンダーを取り込んでタスク提案の文脈に使う)= 単なる
  iOS パリティ以上の価値。実装は自己完結で軽め(source URL を持つコレクション種別 + Worker
  から定期 fetch + strip)。コア価値(CalDAV RFC + iOS **書き込み**)ではないので E/A の後。

## 方向性 K: メール統合(iMIP・予定抽出・Apple マークアップ)

- **発端**: 「メール ⇄ カレンダー」は agentic 管理と不可分(ユーザー判断)。
  一次資料は **docs/modeling/10**(Cloudflare メール基盤 / iMIP 仕様 / Apple 公式マークアップ)。
  B(招待の iMIP 送受信)と E(メール起点のタスク追加)の共通基盤にあたる。
- **発見**: Cloudflare は送受信両方が揃った(受信 = Email Workers で ICS 添付まで読める・
  GA 無料 / 送信 = Email Service が 2026-04 public beta、send_email binding、月 3,000 通込み)。
  **sabre/dav ですら iMIP の受信側は外部ゲートウェイ任せ** → 「REPLY 受信 → iTIP 処理」を
  キット内で完結できるのは OSS としての差別化点。
- 予定抽出は3レベル(①ICS 添付 = `@caldav/ical` で決定的 ②schema.org HTML = 決定的
  ③自然文 = LLM + 提案 inbox 承認制)。
- **Apple の Siri Event Suggestions Markup は公式に存在するが予約8種限定 + 申請制**。
  汎用の予定通知は iMIP(text/calendar 添付)が登録不要で確実 — こちらが正道。
- タスクの種:
  - K-1: RFC 6047(iMIP)の原文スナップショットを docs/rfc/ に追加(B 着手前に必須)。
  - K-2: 送信ポート(SendEmail port + Cloudflare/Resend アダプタ。beta リスクのヘッジ)。
  - K-3: Email Worker 受信 → ProcessIMipMessage ユースケース(DAV 非依存、複数入口ビジョン)。
  - K-4: 抽出 UC(レベル①→②→③の順)+ 提案 inbox(E の文脈で)。
  - K-5: (将来・加点)Siri マークアップの Allow List 申請(送信ユースケース確立後)。

## 方向性 B: M3 スケジューリング(招待)

- RFC 6638/5546。schedule-inbox/outbox、calendar-user-address-set、iTIP 処理、auto-schedule。
  B9 実測どおり、これが無いと iOS は招待 UI を出さない。方向性 A + K-1/K-2 が前提。
- サーバー内ユーザー間 → 外部宛は iMIP(RFC 6047、メール送信)。ドメインの輪郭は docs/modeling/03 §3 に定義済み。

## 方向性 C: M4 他クライアント対応

- calendar-query REPORT + RecurrenceExpansion(iOS は sync-collection だけで足りるが
  Thunderbird / tsdav 系は query を使う)。中核は G-3 に前倒し済み。
- **tsdav は CI にも使える**: 探索→作成→同期→削除の互換性テストハーネスにすれば
  iOS 実機なしで回帰検知できる。**G-3 完了時点で前倒し着手**(汎用テスト基盤は早いほど利く)。

## 方向性 D: M5 共有・委任

- caldav-proxy / calendarserver-sharing(非 RFC の Apple 拡張)。方向性 A が前提。
- 先行準備: ①draft 原文を docs/specs/ に常備(docs/rfc と同じ思想)
  ②権限表スキーマは A-1 に織り込み済み ③read-only privilege 時の iOS 挙動検証は単一ユーザーのままでも可能。

## 方向性 H: フルカレンダーアクセス / 外部データ集約(構想段階 → E に吸収)

- 本質は「**カレンダーを極める(free-busy を本気で提供する)なら、ユーザーの現実の
  カレンダー全体へのアクセスが要る**」という製品上の現実的制約。本作サーバー上の
  イベントだけの free-busy は、生活が iCloud/Google にも分散しているユーザーには
  **嘘の空き時間**を返す。
- 選択肢: (a) 完全移行前提(プロダクトでは高ハードル)/ (b) サーバー側集約
  (calendarserver:source / subscribed — 06 B2 で iOS の問い合わせを実測済み)/
  (c) **agent 側横断**(採用方向)。
- (c) の裏付け(09 §3): web/PWA には標準カレンダー API が存在せず(W3C 提案は 2011 年頓挫)、
  **iCloud は CalDAV + app-specific password で外部からフルアクセス可**(Apple 公式の正規手段)。
  web/MCP から現実のカレンダー全体に届く汎用経路はプロトコルアクセスのみ。
  → 「CalDAV client for agent」を任意のサーバーに向けられる汎用クライアントにし、
  本作 + iCloud + Google を agent が横断して合成。**E の設計に吸収**(独立フェーズにしない)。

## 方向性 I: CardDAV / 連絡先(構想段階)

- 動機: ①マルチユーザー/スケジューリングで招待相手の解決に連絡先が欲しくなる
  ②iOS は vCard の誕生日は自動でカレンダーに拾うが**記念日は拾わない** — CardDAV を
  解釈できれば記念日も把握できる(vCard 解釈 → 仮想イベント生成は方向性 G の親戚)。
- 追い風: CardDAV(RFC 6352)は WebDAV 基盤(4918/principal/sync 6578)を CalDAV と共有、
  vCard は content-line 文法が iCalendar と同族 — structure 層・DAV XML はかなり流用可。
  OSS キットの「DAV サーバーキット」への一般化と整合。
- 論点: iOS の連絡先は Apple 拡張(X-ABDATE + X-ABLabel の記念日表現等)が濃い。
- 位置づけ: 最後。着手前に 08 と同様の一次調査(RFC 6352 スナップショット +
  iOS 実機の CardDAV 挙動観測)を行う。

## 方向性 F: M7 運用(横断関心事)

- 上限系 precondition(max-resource-size 等の ServerPolicy 実装)、監視、バックアップ、rate limit。
- 独立フェーズにせず、各マイルストーンの Definition of Done に該当分を含める。

## 小粒の残タスク(方向性に属さない申し送り)

(2026-07-11 の棚卸しで全消化 — proxy の Content-Length 反映 ✅ / iOS A7 決着 ✅。
経緯は log.md と冒頭「完成しているもの」参照)

## 方向性 C: tsdav CI ハーネス着手(2026-07-11)

> **2026-07-11 更新:** C の中核(tsdav 互換性ハーネス)を G-3 完了で前倒し着手・完了 ✅。
> `test/integration/tsdav-harness.test.ts`(tsdav@2.3.1 を devDep 追加)。**Bun.serve で
> app.fetch をラップ + fake repo 注入**で bun test 内に本物の tsdav クライアントを走らせる
> (workerd の MKCALENDAR 制約は Bun.serve が任意メソッドを受けるので回避 = ロジック回帰専用、
> workerd トランスポートの癖は対象外でプロキシ/smoke の責務)。検証フロー: 探索 → VEVENT 作成 +
> ETag → **RRULE + calendar-query time-range が窓内の回にヒット・窓外はミス(G-3 展開の回帰保証)**
> → sync-collection 差分 → 削除 → free-busy-query VFREEBUSY(raw fetch)。プロダクションコード
> 変更ゼロ(既存応答で tsdav を満たせた)。346 tests green。残る C の広げ方(Thunderbird 等の
> 追加クライアント・より広いプロパティ照合)は必要時に。
