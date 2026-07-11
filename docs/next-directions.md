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
- **OAuth-for-MCP**: 第2スライス(@cloudflare/workers-oauth-provider 導入。src/index.ts /
  src/app.ts の物理分離込み)完了。次は第3スライス(authorize UI = GET/POST /authorize の実装)。
  > 2026-07-12 追記: 第3スライスで `completeAuthorization({ props })` を呼ぶときは、
  > **必ず `{ username }` 形(`OAuthPrincipalProps`)を渡すこと**。これを守らないと
  > OAuthPropsAuth(src/infrastructure/auth/oauth-props-auth.ts)が
  > `ctx.props.username` を読めず principal を解決できず、全 MCP 呼び出しが 401 になる
  > (第2スライスとの暗黙契約。resolveExternalTokenForMcp が返す props も同じ形に
  > 合わせてある — src/app.ts 参照)。

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
