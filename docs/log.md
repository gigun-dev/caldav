# 作業ログ(時系列アーカイブ)

> **位置づけ**: 追記専用の時系列アーカイブ(何をしたかの生記録)。作業の区切りごとに末尾へ追記する。
> セッション引き継ぎの正典は docs/next-directions.md(そちらの棚卸し・積層更新も同時に行う)。

- 2026-07-08: 初回コミット完了(25a66f7)。SUDO モデリング完了・RFC 原文照合済み。
- 2026-07-08: iCalendar 構造層と値型コーデックの初期実装を未コミット作業ツリーに追加。
  - `src/domain/ical/structure/types.ts`: Component / Property / Parameter の汎用構造。
  - `src/domain/ical/parse/parser.ts`: RFC 5545 §3.1 の unfold、content line、BEGIN/END ネスト。
  - `src/domain/ical/serialize/serializer.ts`: CRLF 出力、75オクテット折り畳み、パラメータ quote。
  - `src/domain/ical/values/`: DATE / DATE-TIME / DURATION / PERIOD / RECUR / UTC-OFFSET / TEXT / CAL-ADDRESS。
  - `test/domain/ical/`: iOS 風 fixture、ロスレス往復、値型不変条件テスト。
  - 検証: `bun test` は 61 pass / 0 fail、`bunx tsc --noEmit` は green。
- 2026-07-08: 意味論レンズ層(`src/domain/ical/semantics/`)を実装(未コミット)。
  - `ICalendarObject` / `VEvent` / `VTodo` / `VTimezone` / `VAlarm` — Component を包む
    読み取りレンズ(独自構造への変換なし = ロスレス往復を保つ)。書き込みアクセサは
    PUT ユースケース実装時に追加予定。
  - `validate(): InvariantViolation[]` — 不変条件 I1〜I10 を「全違反収集」方式で検証
    (CalDAV precondition 応答で列挙して返すため throw 一発にしない)。
    I9 の RRULE 時刻 BYxxx は RFC が「無視 MUST」のため違反報告しない(展開側で無視)。
  - UID 一意性(R3/R4)はこの層では検証しない(CalDAV リソース層の責務)。
  - 検証: `bun test` 90 pass / 0 fail、`bunx tsc --noEmit` green。
  - AGENTS.md は CLAUDE.md へのシンボリックリンクに変更(コピー乖離防止)。
- 2026-07-09: codex レビュー対応(7ed36c7)。VTODO の RRULE 検証追加(I5/I6 を validateRRule に
  共通化)、DUE 値型判定を VALUE 型一致のみに緩和(形態一致 MUST は RECURRENCE-ID だけ)、
  DUE > DTSTART(§3.8.2.3)を I4 として追加(docs 05 訂正5にも追記)。95 pass / tsc green。
- 2026-07-09: RFC 7986 の docs 訂正(「iOS 対応に不要」の断定を撤回、§5/§6 の全スコープを
  原文照合で記載)+ **docs/modeling/06-ios-behavior-verification.md 新設**(iOS 実機挙動の
  検証計画 A1〜A6 / B1〜B8 / C1)。C1 は実測済み: workerd は MKCALENDAR を通さない(501)、
  PROPFIND/REPORT/PROPPATCH は通る → ローカルは前作型の書き換えプロキシが必要。
- 2026-07-09: RFC 原文10本を docs/rfc/ に常備(4f507bb)し、docs/modeling を原文で再監査。
  訂正7件(2456e66): UNTIL の floating ケース欠落(→ parseUntil の実バグとして転写されていた。
  12edca8 で修正)、PUT precondition は10個(location-ok は COPY/MOVE 専用)、
  RECURRENCE-ID の明示 MUST は「値型 + floating iff floating」のみ、ほか。
- 2026-07-09: CalDAV リソースコンテキストのドメインモデル実装(dcf8758)。
  3集約(Principal / CalendarCollection+SyncChange / CalendarObjectResource)+
  ETag / SyncToken(URI 形式)/ put-preconditions(R1〜R7)。137 tests / tsc green。
- 2026-07-10: application / infrastructure(D1) / presentation(DAV XML + Basic Auth)を実装し、
  APAC D1 `caldav-production` と Worker `https://caldav.gigun-dev.workers.dev` へデプロイ。
  PROPFIND探索、VEVENT/VTODOデフォルトコレクション、PUT/GET/DELETE、calendar-multiget、
  sync-collection、Extended MKCOL、PROPPATCHを実装。外部用MKCALENDAR書き換えproxyの
  Dockerイメージもローカル検証済み。184 tests / tsc / 本番smoke green。
  - Cloudflare Containersは入口のWorkerでMKCALENDARが501になるためproxy配置先には使えない。
  - Cloud Run proxyは `fukuro3no.mori@gmail.com` 所有の `caldav-prod-fukuro`
    (asia-northeast1)へデプロイ済み。旧アカウントで誤作成した `caldav-prod-gigun` は削除済み。
    Invoker IAM checkを無効化してBasic Authを透過し、MKCALENDAR 201 / PUT 201 /
    sync REPORT 207 / DELETE 204を本番実証済み。
- 2026-07-10: 上記一式を opus レビュー(P1 4件検出)→ 修正(provision の探索フェーズ限定 /
  sync-collection の prop フィルタ厳密照合 / multiget href のコレクション配下検証 /
  207 href の requestHref 一元化)→ 5コミットに分割してコミット(9362b6d〜11ac417)。
  188 tests / tsc green。テスト用に __setRepositoriesFactoryForTest 注入フックあり。
- 2026-07-10: **iOS 実機検証(第1ラウンド)完了**。wrangler tail + CAPTURE_LOG 方式
  (e1d1f52。大学 Wi-Fi で MITM 不可のため)で 114 リクエスト捕捉、全 14 操作を実施。
  結果を 06 に反映(d506b51)、実データ fixtures 6本追加(a1d1b09)、
  I4 の DUE==DTSTART 許容緩和(f2e50b9 — iOS の日付リマインダー実データによる)。
  198 tests / tsc green。iOS 接続の正式入口は Cloud Run プロキシ URL。
- 2026-07-10: **iOS 実機検証(第2ラウンド)完了 — 検証表が実質コンプリート**。
  A5 ✅(RECURRENCE-ID: 同一リソースに master+override、形態一致 — R3/§3.8.4.4 実証)、
  A8 クローズ(非グレゴリオ暦 UI は iOS 標準に無し = 非該当)、
  B8 ✅(サーバー側削除 → sync-report 404 → iPhone から消滅、end-to-end 成立)、
  B7 ❌(**iOS に Extended MKCOL フォールバックは無い** → Cloud Run 変換プロキシは恒久構成)。
  CAPTURE_LOG=0 に戻してデプロイ済み(99a638ee)。残る 🔶 は A7(6868 未誘発)のみ。
- 2026-07-10: **M1 の CI 部分を実装(bb2f4e1、checks 専用に修正)**。
  GitHub Actions(.github/workflows/ci.yml)で全 push/PR に対し
  層境界(dependency-cruiser)→ tsc → bun test を fail-fast 順に実行。層境界は
  .dependency-cruiser.cjs で「domain 純粋 / application→外側禁止 /
  presentation→infrastructure 禁止 / 循環禁止」を error 強制(現状の実態は全ルール適合)。
  `bun run boundaries` で手元実行可。scripts/make-mobileconfig.ts の TS1375 も
  export {} で解消し tsc green。
  **deploy は GHA でやらない方針に決定**: Cloudflare Workers Builds(ダッシュボードで
  repo を Git 連携)が main への push で deploy する。理由 = API トークンを GitHub secret に
  置かずに済む + PR に非本番 version(preview URL)が自動生成される。
  **未完(要ユーザー操作)**: ①Cloudflare ダッシュボードで repo を Workers Builds 連携
  ②main を branch protection で保護し CI check を required status に指定。
  M1 残タスク: ローカル開発環境(Makefile/seed/dev プロキシ)。
- 2026-07-10: **M1 ETag 412 テスト担保 完了(PR #1, d9db9c3)**。app.fetch 経由の
  end-to-end で PUT/DELETE の If-Match / If-None-Match 不一致が HTTP 412(≠403)に
  なることを固定(前作の 403 iOS 回復不能退行の検知)。203 pass。初回 CI green + PR に
  Cloudflare Workers Builds も連携済みと判明(deploy を GHA から外した判断と噛み合った)。
- 2026-07-10: **M1 ローカル開発環境を実装(実行はこの環境では不可、実装のみ)**。
  Makefile(dev/proxy/tunnel/seed/migrate-local/reset-local/mobileconfig/check、
  `make check` は CI と同一の 境界→型→テスト)、scripts/seed-local.ts(SQL 直挿しでなく
  HTTP PUT でシード = ETag/sync token をドメインに計算させる。要 `make dev` 起動中)、
  cloudflared/config.example.yml(**named tunnel** 採用。理由: quick tunnel は URL が
  毎回変わり .mobileconfig 再作成が要る / named なら固定ホスト名で使い回せる)。
  経路は iOS → cloudflared → 書き換え proxy(:8080)→ wrangler dev(:8787)。
  config.yml / *.json は .gitignore(tunnel 認証情報をコミットしない)。
  → **これで M1「足場固め」完了**(CI / deploy / ETag 412 / ローカル環境)。次は M2。
- 2026-07-10: **本番障害と復旧: Worker の secret が全消失し 401**(iOS は「必要な情報が
  見つからない」表示 = 認証不能でディスカバリ不達)。消失時刻は PR #1 マージ →
  Workers Builds 自動デプロイの時刻と一致(**因果は未確定**。⚠️ **次のマージ後に必ず
  `wrangler secret list` で再発確認**。再発するなら Cloudflare ダッシュボードの Build 側に
  secret を置く等の対策が要る)。復旧手順: `wrangler versions secret put` ×2 →
  `wrangler versions deploy`(通常の `secret put` は「version not deployed」で失敗した)。
  PROXY_SHARED_SECRET は旧値を読み出せない(write-only)ため**新しい値を生成して両側に配布**:
  Worker secret + GCP Secret Manager `caldav-proxy-shared-secret` に version 2 を追加し
  Cloud Run `caldav-proxy` を新リビジョンで再起動(env は Secret Manager 参照 —
  文字列 literal への update は「different type」で失敗する)。
  検証済み: PROPFIND 207 / MKCALENDAR 201 / DELETE 204(プロキシ経由 end-to-end)。
  パスワード保管のベスプラ整理: 単一開発アカウントの現段階は Wrangler secret
  (暗号化・write-only)が正攻法。本質解決は M2 の D1 salt付きハッシュ App Password。
  gcloud の対象は project=caldav-prod-fukuro / service=**caldav-proxy**(サービス名は
  プロジェクト名と別 — services update を project 名で叩くと not found になる)。
- 2026-07-10: **認証方式の調査完了 → docs/modeling/07-authentication.md 新設**(M2 一次資料)。
  要点: iOS の汎用 CalDAV に OAuth の受け口は無い(Google は専用統合)/ 業界デファクトは
  Basic over HTTPS + App Password(iCloud・Fastmail・Nextcloud)/ Digest は 2026 年に
  選ぶ理由なし / M2 は App Password(32文字級サーバー生成 → Argon2id/bcrypt で D1 保存)
  + レート制限 / プロキシ内部認証は共有シークレット継続、M2 か OSS 公開時に HMAC 署名へ
  格上げ / OAuth(Bearer)は M6 の agentic 入口で導入。
- 2026-07-11: **ローカル開発環境を初めて実環境で検証・実機接続経路を開通**。
  make dev / migrate-local / seed / proxy / check 全て green(MKCALENDAR 201 含む
  end-to-end)。cloudflared named tunnel `caldav-dev`(UUID 0b9e994c-…)を新設し
  `caldav-dev.097969.xyz` → :8080 proxy → :8787 wrangler dev を公開経路として実証
  (PROPFIND 207 / MKCALENDAR 201 / DELETE 204)。⚠️ `tunnel route dns` を名前指定で
  叩くと既存の別 tunnel(dev)に CNAME が張られた — UUID 指定 + --overwrite-dns で
  張り直した。実機用 `~/Downloads/caldav-dev.mobileconfig` 生成済み
  (host=caldav-dev.097969.xyz, admin/local-test-password)。プロファイル UUID /
  PayloadIdentifier は host+username の SHA-256 から決定的に導出する方式に変更
  (同一接続先の再生成 = 置き換え、別接続先 = 併存 — dev と prod を両方入れられる)。
  ローカルのパスワードは本番検証アカウントと同じ changeme に統一(.dev.vars / seed デフォルト)。
- 2026-07-11: **iOS アカウント追加不能バグを特定・修正 → iPhone からローカル環境接続成功**。
  症状: iOS が「SSLに接続できません」→「アカウントが見つかりません」。CAP ログでは正しい
  current-user-principal を返しているのに iOS が principal への OPTIONS に進まず
  フォールバック探索をループ。原因: proxy/server.ts が response.body ストリームを
  そのまま返すと Bun が chunked に再フレーミングし Content-Length が消える(本番との
  唯一の意味的差分。Cloud Run 入口は GFE が CL 付与するため顕在化しなかった)。
  修正: proxy で全バッファ + Content-Length 明示(204/304 は body なし)。
  06 の「阻む条件」に第4項として記録。SSL エラー表示は誤誘導(TLS は正常)。
- 2026-07-11: **PR #2 マージ(c7dd930)= M1 ローカル開発環境一式が main 入り**。
  CI green(GHA + Workers Builds)。マージ後の `wrangler secret list` で secret 2つとも
  健在 = **前回の secret 消失はマージ起因ではないことがほぼ確定**(申し送り解消)。
  本番 smoke: workers.dev / Cloud Run とも PROPFIND 207。
  proxy の CL 修正の Cloud Run への反映(`make deploy-proxy`)は未実施
  (gcloud CLI がこのマシンに無い。本番は GFE が CL を付与するため急ぎではない)。
- 2026-07-11: **main 保護は「pre-push hook 一本」に決着(branch protection ruleset は
  作ってから削除した)**。経緯: 一旦 ruleset(id 18798162)で PR 必須 + required check を
  設定したが、**個人開発では admin(=自分/Claude Code)が always-bypass するため直 push が
  素通り**する(Claude はユーザーの gh/git 認証で push する = admin push)。push 時に
  remote が `Bypassed rule violations`(PR 必須 / required check を bypass)を返すのを
  実測して「見かけの保護と実態の乖離」を確認 → ruleset を削除。
  守りたいのは悪意ではなく「壊れたコードを事故で main に直 push → Workers Builds が
  自動 deploy → 本番が壊れる」(secret 消失で疑った経路)。→ **`.githooks/pre-push` が
  main への push 時のみ `make check`(CI と同一の 境界→型→テスト)をローカル実行して
  止める**。Claude の push もローカル git 経由なので発火する(= AI の事故 push も止まる)。
  `--no-verify` で意図的スキップのみ可(ローカル hook なので。ruleset は元々サーバー側で
  --no-verify 無関係だった)。`.git/hooks` は git 管理外なので `.githooks` を commit +
  `core.hooksPath`(`make hooks` / `make install` で配線)で version 管理。
  → ci.yml/現在地の「未完(要ユーザー操作)②」は「ruleset ではなく hook で解決」に置換。
  (個人開発である限り pre-push hook 一本で十分。)
- 2026-07-11: CLAUDE.md をベストプラクティスに沿って分割・再編。公式ベスプラ
  (200行未満・進捗は別ファイル・@import 不使用)+ cf-asc-dashbord の next-directions 方式を
  subagent で調査した上で採用。セッションログ → docs/log.md(本ファイル、追記専用アーカイブ)、
  引き継ぎの正典 → **docs/next-directions.md**(方向性 A〜F ラベル + 打ち消し線✅ +
  `> 日付 更新:` 積層の追記型。マイルストーン M2〜M7 はここに統合、一時作った roadmap.md は廃止)。
  CLAUDE.md は約80行の恒久憲章 + ポインタのみに。
- 2026-07-11: gcloud CLI がこのマシンに入ったので、保留していた `make deploy-proxy` を実施。
  Content-Length 修正(同日 log 参照)を含む proxy/ を Cloud Run へデプロイ。
  リビジョン `caldav-proxy-00003-dsz` が 100% トラフィック。
  OPTIONS で疎通確認 OK(`dav: 1, 3, calendar-access, sync-collection, extended-mkcol` が
  Worker から proxy 経由で返る = 貫通確認)。認証は fukuro3no.mori@gmail.com /
  project caldav-prod-fukuro(既存設定のまま)。
- 2026-07-11: **iOS 検証 A7(RFC 6868)を第3ラウンドで決着**。Proxyman MCP 経由で
  caldav-dev.097969.xyz の SSL 復号を有効化(初回は CONNECT のみで中身が見えていなかった)し、
  スマート句読点オフ + ASCII DQUOTE 入り場所名(構造化ロケーション)の PUT をキャプチャ。
  結果: プロパティ値(LOCATION)には生 DQUOTE がそのまま入る(RFC 5545 合法)、
  パラメータ値(X-TITLE)では iOS が DQUOTE を**黙って除去** → RFC 6868 `^` エンコードは
  使わない = 6868 実装は不要と確定。副産物として初回試行で「iOS キーボードは半角 " を
  スマート句読点で ” に自動変換する」ことも確認。キャプチャ生 ICS は geo 伏せ字化の上
  fixtures/real-ios/dquote-location-event.ics に還元(冪等群、roundtrip 26 tests pass)。
  記録: docs/modeling/06 A7 行 / next-directions.md 小粒タスク ✅×2。
- 2026-07-11: CAPTURE_LOG の設計を先人 OSS と照合(deepwiki で Radicale / Xandikos を調査)。
  結論: 「env ゲートでサーバー側が生リクエストをダンプ」は Xandikos --dump-dav-xml /
  DUMP_DAV_XML、Radicale request_content_on_debug と同型の定番装備で、設計変更は不要。
  命名だけ Xandikos に倣い **CAPTURE_LOG → DUMP_DAV_REQUESTS** に改名(make の CAP= → DUMP=、
  ログプレフィックス [CAP] → [DUMP])。履歴 docs 内の旧名表記は過去の記録なので残置。
  proxy 側へ移す案も検討したが独自流になるため不採用。将来 OSS 化時は Radicale 型
  (LOG_LEVEL=debug + content-on-debug + ログ量制限)への統合を検討。
- 2026-07-11: **意味計算(RRULE 展開・TZ・free-busy)の一次調査完了 → docs/modeling/08 起草**。
  発端はユーザー判断「agentic 入口では イベントの理解 + free-busy が中核。A と同格以上」。
  subagent 4本(RFC 原文法学 / 競合実装 / TZ 流派 + agentic / Workers コスト)で調査。
  主な発見: ①time-range の RRULE 展開は RFC 4791 の MUST(現状は厳密には非準拠)
  ②TZ は「IANA tzdb 正・VTIMEZONE は保存のみ」が業界標準(当初の ical.js TimezoneService
  推し評価を自己修正)③LLM は日時反復演算が壊滅的に苦手 → サーバー側展開が MCP の製品価値
  ④コストは CPU-ms 課金で実質 $5/月のみ。sabre 式 first/last 索引 + リクエスト時展開の
  ハイブリッドに決定。next-directions に方向性 G として起票(タスク G-1〜G-5)。
  ペルソナ確認: ドッグフーディング + 個人開発プロダクトへの採用、agent には
  「CalDAV client ができることほぼ全部」。方向性 H(CardDAV / 連絡先、記念日の解釈)も
  構想段階として起票。
- 2026-07-11: **標準戦略の調査(3本目まで)→ docs/modeling/09 起草**。発端はユーザーの
  「RFC に盲目に従うだけが価値ではない。expand/free-busy の同等機能を OSS がどう実現して
  いるか、採択途中の RFC の可能性も戦略的に見たい」。subagent 3本(モダン API 表面 /
  プラットフォーム能力 / 採択途中 RFC)。主要な発見: ①展開・availability は
  Google/Graph/JMAP の第一級機能で、Nextcloud/Cal.com は本気の計算をアプリ層でやる
  (本作の application 層方針の実例)②CALDAV:expand は実は REQUIRED でない(08 の粒度を
  補正)③supported-calendar-component-set が RFC 公認のオプトアウト機構(iCloud は
  VEVENT のみ宣言)④web/PWA に標準カレンダー API は存在せず、iCloud は CalDAV +
  app-specific password でフルアクセス可 = H(c) の裏付け ⑤ical-tasks draft が
  RFC Editor Queue 入りで SUBSTATE/REASON 等は agent のタスク実行状態モデルそのもの。
  VJOURNAL はサーバー側対応の薄さがボトルネックで先行価値あり。
  → next-directions: G に優先度補正の更新、方向性 J(採択途中 RFC への先行投資)起票、
  H に裏付け追記。「RFC 準拠」の再定義 =「実装した範囲は原文どおり正確に + capability を
  正直に宣言」(09 §2)。
- 2026-07-11: **メール統合の調査 → docs/modeling/10 起草、方向性 K 起票**。subagent 2本
  (Cloudflare メール基盤 + iMIP / Apple 公式マークアップ)。発見: ①Cloudflare は
  受信(Email Workers、ICS 添付可読、GA 無料)+ 送信(Email Service、2026-04 public beta、
  send_email binding)が揃った ②sabre/dav ですら iMIP 受信は外部任せ → 受信までキットで
  完結が差別化 ③Apple の Siri Event Suggestions Markup は公式存在だが予約8種限定+申請制
  (DKIM 必須)— 汎用予定は iMIP が正道 ④予定抽出は3レベル(ICS 添付/schema.org/自然文LLM)
  ⑤RFC 6047 が docs/rfc/ 未収録と判明(K-1 として起票)。
  なお、この日の subagent は model 未指定で Fable 継承だった → 以後は sonnet/opus を
  明示する運用に(メモリ更新済み)。
- 2026-07-11: **着手順の戦略的再設計(DDD)+ MCP Apps / WebMCP 調査 → next-directions 改訂**。
  発端はユーザーの「A〜K の順序を DDD ベスプラで戦略的に判断したい」。松岡 DDD の
  コアドメイン蒸留で分類: コア = G/J/E(意味計算・採択途中 RFC・agentic 入口)、
  支援 = B/K/C/H/I、汎用 = A/F。「コアに最初に投資」原則から着手順を
  **G → J → A → E(+K-4)→ K-1〜3 → B → C(tsdav ハーネスは G-3 後に前倒し)→ D →
  H(E に吸収)→ I、F は横断関心事**に改訂。B vs E は E 先行で確定(ユーザー判断)。
  合わせて agentic 入口の周辺標準を Web 調査: ①MCP Apps(ext-apps / SEP-1865)は
  2026-01-26 安定版の最初の公式 MCP 拡張、Claude/ChatGPT/VS Code ホスト対応済み —
  E 設計前に一次資料を読む ②WebMCP(navigator.modelContext)は W3C CG Draft +
  Chrome 149 オリジントライアル(Gemini in Chrome が消費)。当初「ウォッチのみ」と
  評価したが、ユーザー判断「CalDAV は GUI ありきで WebUI を独立に持つ」により重要度を
  上方修正 — 既存 WebUI がほぼ追加コストなしでエージェント対応になる(接続設定不要・
  セッション相乗り)。投資の大半は WebUI + application 層の語彙に落ち、WebMCP 固有は
  registerTool() の薄い皮だけなので仕様変動リスクは表皮に限定。
  構造上の結論: **MCP サーバー / MCP Apps / WebMCP は同じ application 層ユースケース
  (G-5 の語彙が原型)の別露出面** — 長期ビジョン1の入口が3面に増えるだけ。
- 2026-07-11: **next-directions を棚卸し(第2版)**。着手順の DDD 改訂が「大きな節目」に
  該当するため、積層した更新ブロックを本文に統合。①節の並びを新着手順(G→J→A→E→K→B→
  C→D→H→I→F)に合わせて再配置 ②MCP Apps / WebMCP の調査詳細 + DDD 戦略分類の根拠を
  docs/modeling/11-agentic-surfaces.md に切り出し(next-directions からは参照のみ)
  ③消化済みの小粒タスク・iOS A7 決着を「完成しているもの」に統合 ④G-6
  (supported-calendar-component-set 宣言)をタスクとして正式化 ⑤modeling/README の
  目次に 08〜11 を追記(07 で止まっていた)。積層ルールへの懸念(コンテキスト膨張)は
  「節目ごとの棚卸しが逃がし弁」という運用で解消— 生の経緯は log.md と git 履歴が持つ。
- 2026-07-11: **G-1(TZ 解決層)実装完了**。`src/domain/ical/timezone/` を新設 —
  ①errors(TimezoneResolutionError。暗黙フォールバック禁止の明示エラー)
  ②windows-zones(CLDR windowsZones 001 の写経。Windows 名→IANA 名、大文字小文字無視)
  ③resolver(IANA 直引き→先頭 "/" 剥がし→Windows 名→X-LIC-LOCATION→TZID 末尾 suffix→
  明示エラー、の4段チェーン。via で解決経路を返す)④instant(Intl/ICU の formatToParts +
  hourCycle:"h23" でオフセット算出、壁時計→UTC は2パス方式。floating の既定ゾーンは
  **UTC を明示** — RFC 4791 §7.3 の MAY を暗黙にしない)⑤effective-period(§9.9 の実効
  [start, end) 算出。DURATION は weeks/days=壁時計 nominal・h/m/s=exact の分離加算、
  DTEND/DURATION 省略時は DATE-TIME→0秒・DATE→+P1D)。テスト 23 件追加で 227 pass。
  DST の穴(NY 2026-03-08 02:30 → 06:30Z=EST 側)・重なり(2026-11-01 01:30 → 05:30Z=
  最初の出現)は実装依存挙動としてテストで絶対値固定(ICU/tzdb 更新の検知線)。
  実装は opus subagent へ委譲し Fable がレビュー(このセッションから実装=subagent、
  設計判断・レビュー=Fable の役割分担を運用開始)。
- 2026-07-11: **G-2(RecurrenceExpansion ドメインサービス)実装完了**。
  `src/domain/ical/recurrence/`(①iterator-port: RRULE 反復だけを外へ委譲する port
  interface、壁時計フィールドの列挙器でTZ概念なし ②occurrence: recurrenceId=master 時刻・
  start/end=実効時刻を分離保持する値オブジェクト ③expansion: RRULE/RDATE/EXDATE/
  RECURRENCE-ID オーバーライドを総合し §9.9 実効期間 + range フィルタ)+
  `src/infrastructure/recurrence/icaljs-rrule-iterator.ts`(ical.js v2.2.1 の ICAL.Recur +
  floating ICAL.Time だけ使用、TimezoneService/ICAL.Event は不使用 = 08 §5 の「TZ 解決には
  使わない」決着どおり)。`bun add ical.js`。テスト 11 件で 238 pass。
  実装判断: UNTIL は iterator に渡さず epoch 厳密で inclusive 判定 / 展開はローカル壁時計
  列挙 → occurrence ごとに G-1 で UTC 化(先に UTC 化しない DST 順序鉄則)/ I9 の
  「無視 MUST」は展開層が実装(values/semantics 層は BYxxx を違反報告しない方針)/
  各回の実効期間は master の DURATION=addDuration・DATE-TIME DTEND=exact ms 差・
  DATE DTEND=nominal 日数差で継承 / detached オーバーライドも含める(iOS 実データ耐性)。
  層境界の注記: dependency-cruiser は npm パッケージ依存を検査しない(src の層間 import のみ)
  ので domain→ical.js は構造的保証(domain では import しない)+ コメントで担保。
  既知の制約: maxOccurrences は dtstart からの列挙総数で消費 → 遠い未来 range × 古い
  dtstart の無限 RRULE で予算切れになりうる。G-3 の first/last 索引が事前絞り込みで解決。
  実装は sonnet 5 subagent、レビューは Opus(メインを Fable→Opus に移譲)。
- 2026-07-11: **G-3(first/last occurrence 索引 + calendar-query time-range フィルタ)実装完了**。
  設計判断は Fable subagent が策定(スキーマ・PUT 層間配線・calendar-query 処理の手戻り
  コストが大きいため)→ Opus がレビュー承認 → sonnet 実装、の3段構成。
  成果: ①migrations/0002_occurrence_index.sql(calendar_objects に first_occurrence/
  last_occurrence を列追加・複合索引。NULL=常に候補、別テーブルにしない sabre 式。無限反復は
  OCCURRENCE_INDEX_MAX=2100 でキャップ)②occurrence-bounds.ts(computeOccurrenceBounds:
  PUT 時に expandRecurrenceSet を再利用し first/last を算出。無限反復のみ展開回避で先頭のみ計算。
  VTODO は §9.9 の実効値表から直接、反復展開しない。計算失敗は throw せず null/null)
  ③calendar-query.ts(CalendarQuery UC: findInCollectionByTimeRange で SQL 粗絞り込み +
  ±24h TZ スラック → VEVENT はヒット行を展開して §9.9「いずれか1回一致」判定、VTODO は
  SQL のみ)④presentation の parseCalendarQueryFilter(comp-filter の同名ネストを
  バランス走査で正しく切り出す簡易パーサ。素朴な非貪欲正規表現が内側の閉じタグに誤マッチする
  罠をテストで発見し修正)。未対応 filter(prop-filter/param-filter/ネスト comp-filter/
  VJOURNAL/expand/limit-recurrence-set)は黙殺せず 403 CALDAV:supported-filter で明示的に断る。
  floating は PUT 時 UTC 固定で索引化 → クエリ時に ±24h スラックで別ゾーン差を吸収(過剰包含は
  展開の最終判定が落とす)。層間配線: PutCalendarObject と CalendarQuery に RecurrenceIterator
  を注入、UoW.saveResource に bounds 引数追加(集約には持たせない=導出インデックス)。
  18 tests 追加で 256 pass。既存 238 は無影響(put/uow シグネチャ変更に伴い fakes とテスト5本を更新)。
  これで方向性 G の Tier 1(RFC 準拠の time-range)完了 = calendar-query 未実装の非準拠を解消。
  C の tsdav CI ハーネスが前倒し着手可能に。
- 2026-07-11: **G-4(free-busy 計算 + free-busy-query REPORT)実装完了**。設計 = Opus
  (RFC 4791 §7.10 の FBTYPE 対応表を原文照合)、実装 = sonnet。①src/domain/ical/freebusy/
  busy-periods.ts(deriveFreeBusyType: TRANSP=TRANSPARENT/STATUS=CANCELLED→null[FREE]・
  TENTATIVE→BUSY-TENTATIVE・その他→BUSY / coalesceBusyIntervals: §7.10「同型の連続・重複を
  マージ、異型は重複可」を type ごと独立マージで実装)②src/application/usecases/
  compute-free-busy.ts(ComputeFreeBusy UC。出力は構造化 BusyInterval[] = epoch ms・TZ 非依存で
  DAV/MCP 共用 = 09 §1「応答 TZ 分離」の実証。CalendarQuery と同じ SQL 粗絞り込み+±24h スラック
  → expandRecurrenceSet → occurrence の component[override 対応] から FBTYPE 導出 → range クリップ
  → coalesce)③presentation の parseFreeBusyQuery + serializeFreeBusyResponse(既存 serialize()
  再利用で VFREEBUSY を text/calendar 出力。空でも VFREEBUSY は返す §7.10 MUST を自然に満たす)
  ④index.ts: free-busy-query 分岐追加(応答は multistatus でなく text/calendar 200、time-range
  欠落は 400)+ object リソースに対する free-busy-query は 403(§7.10)。24 tests 追加で 280 pass。
  これで方向性 G の Tier1(RFC 準拠)+ Tier2(free-busy)の DAV 側が揃った。残る G-5(MCP 照会
  ツール = E の先鋒・語彙原型)は設計判断が重いので着手時に Fable の設計パスを挟む。G-6
  (supported-calendar-component-set 宣言)は小粒で独立。
- 2026-07-11: **方向性 J の設計確定 + J-1(VJOURNAL 基盤)実装完了**。設計は Fable subagent が
  策定 → Opus 承認 → 手戻りリスクのある製品判断をユーザー確認。設計の背骨は「journal を安定度で
  3層に分けて疎結合に」: ①VJOURNAL コンポーネント = RFC 5545 確定仕様 → 素直に入れる(J-1)
  ②agentic 日誌の製品コンセプト(コレクション常設 + RELATED-TO)= 未確定の賭け → **オプトインで
  除去可能に**(当初 Fable は自動 provision 推奨だったが、ユーザーが「疎結合で後の判断次第で綺麗に
  除去したい/保守と新機能を両立し他プロジェクトに流用したい」と再考し、自動 provision → オプトイン
  に倒し直し。2026-07-11 ユーザー判断)③ical-tasks/9253 = draft → 読み取り専用・検証なし・string
  型で追従リスク最小(J-3)。DDD 担保: VJOURNAL レンズに日誌ビジネスルールを生やさず標準の値検証のみ、
  agentic 意味づけは application 層以上、provision は config 関心事 → 標準 CalDAV と agentic 日誌つきを
  同一コードベースで両立でき OSS キットで切れる。
  J-1 成果: migrations/0003_vjournal.sql(SQLite の CHECK は ALTER 不可のため 12-step テーブル
  再作成。0001 の列/PK/UNIQUE/FK + 0002 の first/last_occurrence 列・calendar_objects_time_range
  索引を完全再現し INSERT SELECT でデータ保全)/ COMPONENT_KINDS に VJOURNAL 追加(put-preconditions
  は single source of truth 設計で自動受理)/ src/domain/ical/semantics/vjournal.ts(§3.6.3 jourprop:
  UID/DTSTAMP 必須・DTSTART 任意・DTEND/DURATION/DUE/VALARM 無し・DESCRIPTION 複数可[VEVENT/VTODO と
  非対称]・RELATED-TO[RELTYPE 既定 PARELT]・共有 validateRRule/reportDuplicate 流用)/ journals()
  アクセサ + validate 連結 / occurrence-bounds に computeVJournalBounds(DTSTART 無しは null/null で
  SQL 粗絞り込みの過剰包含側)/ comp-filter は VJOURNAL の range 無しのみ許可・time-range 付きは
  unsupported(J-4 送り)/ docs/modeling/03 に VJournal 節追記。15 tests 追加で 295 pass。実装 = sonnet。
  次: J-2(宣言フォールバックを COMPONENT_KINDS 化 + journal オプトイン)、その後 RFC 9253/ical-tasks
  スナップショット取得(経路確認済み: rfc-editor.org)→ J-3。
- 2026-07-11: **J-2(supported-calendar-component-set 宣言是正 + journal オプトイン)完了**。
  G-6 を J-2 に吸収。①collectionProps のフォールバックを ["VEVENT","VTODO"] ハードコードから
  COMPONENT_KINDS(VEVENT/VTODO/VJOURNAL)へ = supportedComponents undefined のコレクションの
  「宣言」を「実際の受理(put-preconditions は undefined を全受理)」と一致させる。RFC 4791
  §5.2.3「プロパティ不在 = 全コンポーネント accept MUST」準拠。②parseCollectionProperties を
  単一 comp(VEVENT|VTODO 決め打ち)から全 comp を parseComponentKind で拾う ComponentKind[] へ
  拡張(複数 comp + VJOURNAL 対応)。③index.ts の MKCALENDAR 配線を props.components 直渡しに。
  → **journal コレクションは MKCALENDAR で <C:comp name="VJOURNAL"/> を送ればオプトイン作成できる**。
  provision-default-collections は変更せず(自動 provision しない = 除去可能性優先)、意図をコメント化。
  6 tests 追加で 301 pass。既定 calendar/tasks の PROPFIND 出力は不変(explicit supportedComponents なので)
  を回帰テストで保証。実装 = sonnet。iOS 実機での calendar/tasks 非回帰確認のみ J-4 に保留。
  次: RFC 9253 + ical-tasks draft スナップショット取得 → J-3(draft アクセサ先取り)。
- 2026-07-11: **J-3(ical-tasks/RFC 9253 アクセサ先取り)完了 → 方向性 J 一区切り**。
  前提として RFC 9253 全文(docs/rfc/rfc9253.txt)と ical-tasks draft-17(docs/specs/ 新設)を
  取得してコミット(5c3ea61)。**原文照合が Fable 設計メモの想定を複数訂正**した(学習知識で
  断定しない規律の実効例): ①SUBSTATE/REASON は VTODO 直下でなく VSTATUS サブコンポーネント内
  ②REASON の値型は URI(TEXT でない)③DEPENDS-ON は独立プロパティでなく RELATED-TO;RELTYPE=
  DEPENDS-ON ④GAP は RELATED-TO のパラメータ ⑤REFID は反復プロパティ。照合結果は 05 に記録。
  実装(vtodo.ts): substate/reason(先頭 VSTATUS 読み)・estimatedDuration(DURATION)・
  dependsOn(RELATED-TO を RELTYPE=DEPENDS-ON でフィルタ + GAP パラメータ)・refids(allProps)・
  relatedTo。helpers に共通 relatedToOf(VJournal/VTodo 重複解消)。STATUS:PENDING/FAILED は
  現行 string アクセサで既に受かる(JSDoc 追記のみ)。CONCEPT/LINK は生値保持のみ。
  **全アクセサ読み取り専用・検証なし・string 型(union にしない)= draft 追従リスク最小化**。
  8 tests 追加(ACKNOWLEDGED 回帰込み)で 309 pass。実装 = sonnet、原文照合も sonnet が実施。
  方向性 J(VJOURNAL 基盤 J-1 / 宣言+オプトイン J-2 / draft アクセサ J-3)完了。残る J-4
  (jtx/DAVx⁵ 実機検証・VJOURNAL time-range query・RFC 化時の格上げ)は後続。
  次: G-5(MCP 照会ツール = E の先鋒・語彙原型)。着手時に Fable 設計パスを挟む。
- 2026-07-11: **G-5(MCP 照会ツール)完了 → E の先鋒・複数入口ビジョン実証**。設計 = Fable
  (トランスポート3案比較 + 語彙原型 + 層配置)→ Opus 承認 → ユーザーが方式(@hono/mcp マウント)
  ・認証(静的 Bearer + 差替可能ポート)を確定。実装は opus が依存導入 + AuthenticationPort まで
  → opus セッション上限(23時リセット)→ sonnet が続行完了。
  成果: ①依存 @hono/mcp@0.3 + @modelcontextprotocol/sdk@1.29 + zod@4 ②AuthenticationPort
  (application/ports。authorization + resourceUri[audience 検証の口] → AuthResult。OAuth-ready seam)
  ③StaticBearerAuth(infrastructure。secureStringEqual 定数時間比較 + 空トークンガード。A で
  workers-oauth-provider に丸ごと差し替え)④presentation/mcp/(format: epochToIso[offset付ISO8601]/
  parseIsoToEpoch[floating reject]/formatDateOnly、server: リクエストごとに McpServer+
  StreamableHTTPTransport を new[Workers のグローバル状態回避]、3ツール)⑤index.ts で /mcp を
  app.all("*") より前にマウント(Cloud Run プロキシ非経由)。3ツール = get-current-time
  (currentTime/utc/dayOfWeek)/ list-events-expanded(ListOccurrences 再利用・calendarId 省略で
  全カレンダー集約・isAllDay/isRecurring・maxEvents 既定250・truncated・内部 maxOccurrences 非露出)/
  get-freebusy(ComputeFreeBusy をコレクションごと + coalesceBusyIntervals で再マージ)。
  応答は offset 付き ISO8601 + timeZone 分離 + epoch 非露出(09 §1)。structuredContent 併用。
  node_modules で実 API 確認(registerTool は raw shape inputSchema・StreamableHTTPTransport は
  sessionIdGenerator 未指定で stateless・SSE 応答)。27 tests 追加(MCP 統合テスト = initialize/
  tools-list/tools-call・Bearer 401/200 込み)で 343 pass。**DAV と MCP が同じ application UC を
  呼ぶ複数入口ビジョンを実証。** 次: G は G-6 まで完了、残タスクは方向性 A(マルチユーザー +
  OAuth = 高優先)/ E(書き込みツール・MCP Apps)/ C(tsdav CI ハーネス、G-3 完了で着手可)。
- 2026-07-11: **今セッションの成果(G-1〜G-6 / J-1〜J-3 / G-5 MCP / ListOccurrences UC / C tsdav
  ハーネス)を main に push → Workers Builds 自動デプロイ**(ユーザー承認)。実機検証用に
  /mcp の MCP_TOKEN を wrangler secret で設定する運用開始(値はユーザーが `wrangler secret put
  MCP_TOKEN` で投入。未設定なら /mcp は空トークンガードで全拒否 = 公開しても安全)。
  実機検証の割り当て(ユーザーが実施): ①Claude iOS → https://caldav.gigun-dev.workers.dev/mcp
  で3ツール検証(ただし Claude コネクタは OAuth 中心で静的 Bearer 追加可否は未確定 = 追加不可なら
  「Claude コネクタ利用は OAuth[方向性 A]がゲート」という学び)②iOS ネイティブで calendar/tasks の
  非回帰(J-2)③VJOURNAL は DAVx⁵+jtx[Android]、journal コレクションはオプトインなので要手動作成。
- 2026-07-12: **OAuth-for-MCP を3スライスで実装 → 本番実機受け入れ完走**。
  - 経緯: Claude カスタムコネクタは OAuth 一択(静的 Bearer 欄なし)と確定 → `/mcp` を
    `@cloudflare/workers-oauth-provider@0.8.1` で OAuth 保護。第1(`f3ff904` KV 土台)/
    第2(`2d866da` canonical 物理分離: src/app.ts=マウント可能 Hono / src/index.ts=薄い
    `export default new OAuthProvider`。認証 seam 不変で StaticBearerAuth→OAuthPropsAuth、
    MCP_TOKEN は resolveExternalToken で共存)/ 第3(`d29fdff` authorize 同意 UI 単一ユーザー)/
    後片付け(`68cb67b` dependency-cruiser で app.ts への provider 値 import 禁止・vitest 起票)。
  - 検証: Fable 節目レビュー(BLOCKER なし・本番 esbuild が dynamic import を静的巻き上げと実証)
    + OSS ベスプラ調査(canonical は直接 export default = bespoke lazy import は物理分離で撤去)。
    361 tests green。
  - 本番実機: deploy 後スモーク(well-known 2種・401 discovery チャレンジ・静的 Bearer で
    tools/list 200)全 green。**Claude カスタムコネクタで OAuth 接続成功**(DCR→authorize で
    CALDAV_PASSWORD 同意→token)→ 3ツール動作。テストデータ(単発+週次 RRULE)投入後、
    list-events-expanded が Asia/Tokyo 解決の展開5件、get-freebusy が5 BUSY 区間を返却。
  - 運用ギャップ発覚: D1 マイグレーション(0002/0003)は main push の自動 deploy に含まれず
    手動 apply が必要 → 未適用で list/freebusy が落ちていた。手動適用で解消。next-directions に
    「deploy 手順への migrations 組み込み」を起票。
  - MCP_TOKEN は本番 secret + .dev.vars 同値(gitignore なのでローカル/本番を分けない方針)。
- 2026-07-12: **vitest-pool-workers ハイブリッド導入(2スライス)** — OAuth-for-MCP の E2E を
  実 workerd 上で自動テスト。プロセスは 調査(sonnet Explore)→ 設計(Fable architect)→
  実装(sonnet implementer)、main が各節目レビュー。「設計は調査の後」原則どおり調査を先行。
  - 調査の核: **vitest-pool-workers は v0.13+ で API 刷新済み**。巷でよく知られる
    `defineWorkersConfig`/`SELF.fetch()` は廃止 → `cloudflareTest()` Vite plugin +
    `import { env, exports } from "cloudflare:workers"` の `exports.default.fetch()`。
    D1 は `readD1Migrations`(config/Node 側)+ `applyD1Migrations`(setupFile/worker 側)。
    ストレージ隔離はテストファイル単位(isolatedStorage/singleWorker は廃止)。
  - 設計: `test/worker/` を vitest 専用の第2レーンとして隔離。bun test 主レーンは無変更で共存
    (振り分け基準=`cloudflare:*` を import する or provider 本体を fetch で叩くテストのみ vitest)。
    tsconfig は test/worker 専用に分離(bun-types と cloudflare:test 型が共存不可)。
  - スライス1(スパイク `73f420f`): 未確定6点を1ファイルで検証し全て真と確定(fallback 不要。
    素の OAuthProvider を exports.default.fetch で叩ける / KV は configPath で自動起動・ファイル内
    state 持続 / D1 マイグレーション setupFile 適用 / tsconfig 分離が必要)。実装者の逸脱3点も妥当:
    ①ダミー secret を cloudflare:* 非依存の test-secrets.ts に切り出し(config が cloudflare:test を
    辿ると ERR_UNSUPPORTED_ESM_URL_SCHEME)②`bun test` 直呼びは test/worker を拾って落ちるので
    package.json の test script(ディレクトリ列挙)経由に ③test/worker tsconfig の include に
    src/env.d.ts も追加(CloudflareBindings の declaration merging 解決)。
  - スライス2(E2E `dd17b23`): DCR→PKCE authorize(password 同意)→token 交換→/mcp tools/list を
    一気通貫 + 静的 Bearer(MCP_TOKEN)経路 + 失敗系(誤 password で 302 に落ちない / 無効 Bearer で
    401 + WWW-Authenticate realm="OAuth")。実挙動の学び2点(コメントに記録):
    ①**DCR は `token_endpoint_auth_method: "none"` 明示が必須**(省略で confidential client 扱い →
    token 交換が 401 invalid_client)。本番 Claude コネクタ接続成功と整合(Claude の DCR は
    public client 登録)②`/mcp` は単発呼び出しでも SSE(text/event-stream)で返る(Accept に
    text/event-stream 必須。json のみは 406)→ 最小 SSE パーサをテスト内に用意。
  - 配線: `make check` 末尾に test-worker、CI に workerd step(secret 不要=ダミー secret を
    miniflare.bindings 注入)。deploy 系は不変。bun 361 + vitest worker 10 green。
- 2026-07-12: **方向性 E に舵を切る(ユーザー判断)+ E-1 スライス①(VTODO todo ツール)完了**。
  MCP Apps 方向を本命に、chat 利用前提でマルチユーザー(A)より E(agentic 入口)を先行
  (シングルユーザー土台は OAuth-for-MCP で完成済み)。語彙は todo で統一。
  - プロセス: 調査(sonnet Explore ×2: リポジトリ内 VTODO 前提 / MCP Apps・tdr-concierge・
    OpenAI todo ウィジェット)→ 設計(Fable architect)→ **iOS 実機モデリング**(docs/modeling/06 §D)
    → 実装(sonnet implementer)、main が各節目レビュー。
  - **iOS 実機キャプチャ第3ラウンド(06 §D、DUMP_DAV_REQUESTS で採取)**: 優先度=1/5/9(緊急なし)/
    フラグ・画像=iOS が CalDAV アカウントでグレーアウト=不可(スクショで確定)/ iCloud リマインダー
    =CloudKit 同期で CalDAV 非経由(Proxyman: p125-caldav に iPhone リクエスト無し・gateway は
    ピンニング)→ リッチ機能は Apple 自身が CalDAV で運ばない=天井確定 / 反復完了=マスター前進+
    完了スナップショット分離(D4)/ VALARM 保持可 / PROPPATCH リネーム・色=207 対応済み /
    **MCP 作成 todo を iOS が素直に往復**(D8: If-Match に我々の ETag、DTSTART=DUE 終日・PRODID 受容、
    SEQUENCE 据え置き)。ローカル D1 の 0002 未適用で全 PUT 500 → `make migrate-local` で解消(本番
    ギャップのローカル版)。fixtures 2本追加(vtodo-recurring-master / -completed-instance)。
  - **スライス①(`b18efe9`)**: structure/edit.ts(汎用 upsert プリミティブ)+ semantics/vtodo-write.ts
    (VTODO builder。レンズに setter を生やさずロスレス維持)+ CreateTodo/ListTodos(既存
    PutCalendarObject を must-not-exist で合成)+ MCP create-todo/list-todos + E2E。id=UID、
    出力は E-2 UI-ready な共通 Task DTO(title/notes は decodeText、層境界のため format.ts を
    複製)。時刻付き due は VTIMEZONE 生成器未整備のため明示エラー(黙って落とさない)。
    bun 385 + vitest worker 13 green。
  - CLAUDE.md をコメント方針「情報の書き分け(How/What/Why/Why not)」に再構成(`eb11bb9`)。
  - 次: スライス②(complete/update/delete + 反復。実測で仕様確定)→ E-2(MCP App UI)。
    方向性 H(購読カレンダー)を E/A の後の中優先で起票。

## 2026-07-12(続き)E-1 スライス②-a/②-b + V2 実機受け入れ

- **スライス②-a(`6798fdf`)**: サーバー発 VTODO の生成プロパティを vtodo-stamp.ts に一本化
  (stampCreate = STATUS:NEEDS-ACTION/CREATED/LAST-MODIFIED/DTSTAMP/X-APPLE-SORT-ORDER、
  stampUpdate = LAST-MODIFIED/DTSTAMP のみ・CREATED/sortOrder/STATUS は保持)。X-APPLE-SORT-ORDER
  = CFAbsoluteTime(unix秒 − 978307200)で iOS 実機の並びに一致(実測 805549710 を固定値テスト化)。
  ListTodos の既定順を sortOrder 昇順・null 末尾・UID タイブレークに。CALSCALE:GREGORIAN も積極生成。
  create-todo.ts の now 組み立てを now-stamp.ts(nowStampFromDate)に切り出し。
- **スライス②-b(`44c9f2f`)**: UpdateTodo/CompleteTodo/DeleteTodo + lossless read→patch。
  vtodo-patch.ts(patchVTodoFields / applyCompletion 3点セット / applyReopen)は edit.ts の
  upsert/removeProperty だけで組み、VALARM/VTIMEZONE/X-APPLE-* に触れない。UC は既存 VCALENDAR の
  対象 VTODO サブコンポーネントだけを差し替え(参照等価で特定)→ serialize → must-match PUT。
  todo-lookup.ts で UID→URI を findUriByUid 解決(iOS 命名に決め打ちしない)。reopen は
  update-todo.status に集約(別ツールにしない)、delete は chat UX 優先で無条件。反復 VTODO の完了は
  D4(②-c)まで RecurringCompletionNotSupportedError で拒否(complete/update.status 両経路にガード)。
  MCP に update/complete/delete-todo(5→8 ツール)。bun 413 + vitest 13 green。
- **V2 実機受け入れ成功(iOS 26.5・本番 caldav.gigun-dev.workers.dev)**: MCP Inspector 経由で
  update(title/due/priority)/ complete / reopen / delete をすべて iOS リマインダーに反映確認。
  本番 D1 の実 ICS で **VALARM が update 後もバイト保持されている**ことを直接確認(lossless 実証)。
  時刻付き due(DTSTART;TZID+time)→ 終日 due(VALUE=DATE)への変換も TZID を正しく除去。
- **V2 で顕在化した2件を next-directions の方向性 E に起票**(ユーザー確定=「既知の制限として
  切り出し ②-c を先行」):①VALARM 追随(update で due を動かすと絶対トリガーが取り残される。将来の
  VALARM 管理スライスで精密追随を設計)②VTODO の first_occurrence が CREATED 時刻になる索引の癖(要調査・
  MCP フロー無影響)。
- 次: **②-c(反復完了 D4)** — buildCompletionSnapshot(新 UID 完了スナップショット)+ advanceMaster
  (マスター DTSTART/DUE 前進)。反復付き create もここ。完了後 V3 実機確認。

## 2026-07-13 E-1 スライス②-c(反復完了 D4)

- **スライス②-c(`e9e47bc`)**: 反復 VTODO の完了を拒否せず iOS 実機に忠実に再現(D4 モデル)。
  Fable 設計 → sonnet 実装。CompleteTodo/UpdateTodo.status の RecurringCompletionNotSupportedError を
  D4 実装に差し替え。
  - domain 純関数(vtodo-recurrence.ts): `buildCompletionSnapshot`(新 UID・RRULE/RDATE/EXDATE 除去・
    3点セット・DTSTART/DUE をマスターから継承・VALARM を UID/X-WR-ALARMUID 新採番でコピー・
    X-APPLE-SORT-ORDER は付けない=fixture 忠実)/ `advanceMasterToNextOccurrence`(次 occurrence へ
    DTSTART/DUE 前進・元 params[TZID/VALUE=DATE]流用・DUE−DTSTART の壁時計差保持・COUNT は §3.3.10
    「DTSTART は常に最初の occurrence」根拠で1減算・UNTIL は inclusive 判定で RRULE 不変・最終回は
    exhausted)。expansion.ts の非公開ヘルパーは G-1/G-2 完成物を変更しない方針でローカル小複製。
  - application(recurring-completion.ts): snapshot-first の非原子2PUT(a:新 UID must-not-exist →
    b:マスター前進 must-match)。失敗モード表をコメント明文化(a 失敗=無変更で再実行回復、
    a 成功 b 失敗=完了スナップショット余剰1件[良性・可逆]、master-first だと occurrence 消失=非可逆
    なので snapshot-first 厳守)。exhausted(最終回)は 1 PUT でマスター完了。返す Task=完了スナップショット。
  - RRULE 反復展開は既存 RecurrenceIterator へ委譲(再実装しない)。bun 427 + vitest 13 green。
- **06 §D4 に追記**: 最終 occurrence 完了時のスナップショット有無は実測未確定 → ②-c は「作らない
  (マスター完了のみ)」を採用・実機検証項目 V8 として登録。
- **新タスク③(next-directions 方向性 E に起票)**: 反復付き create(RRULE)は未対応 = chat から反復 todo を
  ゼロから作れない(完了=前進は既存の反復マスターに対してのみ)。別スライスで判断。
- 次: **V3 実機確認**(我々の反復完了が iOS リマインダーに反映されるか)→ 問題なければ E-2(MCP App UI)。

## 2026-07-13(続き)②-c VALARM 前進修正 + V3 合格

- **VALARM 前進の追加修正(`aca8193`)**: V3 実機で「反復完了後もマスターの表示日付が前進しない」症状。
  切り分けで判明: iOS はリマインダーの表示時刻に VALARM トリガーを使うため、advanceMasterToNextOccurrence が
  DTSTART/DUE だけ前進させ VALARM 絶対トリガーを据え置く(lossless 保持)と、iOS 上でフリーズして見えた。
  本番 D1 で iOS ネイティブ完了を実測(CAP-RRULE2・FREQ=DAILY): iOS は前進時に VALARM 絶対トリガーも
  DTSTART と同じ絶対時間差で前進(20260712T160000Z→20260713T160000Z = +86400s)。
  → advanceAbsoluteAlarmTriggers を追加(triggerShiftMs=nextEpoch−currentEpoch。TRIGGER;VALUE=DATE-TIME
  =trigabs UTC だけ前進・相対トリガー[RELATED/DURATION]と位置アラーム[X-APPLE-PROXIMITY]は据え置き。
  DUE の壁時計差保持とは別ロジック=絶対時間差)。bun 431 + vitest 13 green。
- **V3 合格(本番実機)**: 修正後、MCP からの反復完了で前進後マスター(DTSTART 07-15・VALARM 20260714T160000Z)が
  iOS ネイティブ出力と構造完全一致。当初「前進しない」と見えたのは iOS のキャッシュ/同期遅延で、
  強制再同期(リマインダーアプリ終了 or CalDAV アカウント off/on)で解消。sync_changes に modification が
  token として正しく積まれ・sync_counter も進むことを D1 実測で確認(サーバー側同期シグナルは健全)。
  副産物: 本番 D1 に principal が admin(iOS 実機 + MCP の実使用)と旧 caldav-user(counter 8・不使用)の2つ。
- **E-1 スライス②(a/b/c)完了**。残: V8(最終回スナップショット有無)/ タスク①(update-todo の due 変更時の
  VALARM 追随・仕組みは②-c で実証済み)/ 新タスク③(反復付き create)。次の本線: E-2(MCP App UI)。

## 2026-07-13(続き)タスク①③(VALARM 追随 + 反復付き create)

- **タスク①(`1f4bec4`)**: update-todo の due 変更で VALARM 追随。②-c の VALARM 前進プリミティブを
  vtodo-patch.ts の `shiftAbsoluteAlarmTriggers` として共有化(vtodo-recurrence から移設)、update-todo の
  due 変更時に (新due−旧due) ぶん絶対トリガーを shift(オフセット保存=due 連動アラームも早期リマインダーも
  同じだけ動く)。相対/位置アラームは据え置き。時刻付き→終日変換は start-of-day 近似(限界コメント)。
  週末反復(BYDAY=SU,SA)の VALARM 前進を不揃い間隔(6日→1日)で固定値検証=前進量が固定周期でなく
  RecurrenceIterator の実 occurrence 間隔である裏取り。V2 の取り残されアラーム解消。
  新エッジ起票: 反復 todo の due→DATE 変更は RRULE UNTIL が DATE-TIME だと I6 違反(レア・優先度低)。
- **タスク③(`03540c0`)**: 反復付き create-todo。MCP に recurrence(frequency/interval/weekdays/count/until)。
  buildVTodoCalendar が RecurrenceRule→RRULE 生成。until は DATE 型で DTSTART と揃え I6 を構造回避
  (§3.3.10 原文根拠)。recurrence は due 必須・count/until 排他・weekdays は weekly 限定を専用エラーで明示。
  反復 create→complete が D4 経路で動く e2e 済み。bun 445 + vitest 13 green。
- 残: **V8**(反復を最後まで完了 → iOS がスナップショットを作るか/マスター完了だけか。我々は後者採用)。
  その後 **E-2(MCP App UI)** が本線。タスク①③で agentic todo 入口(create/list/update/complete/delete・
  単発/反復・VALARM 追随)がほぼ揃った。

## 2026-07-13(続き)V8 実測 → 最終回モデル修正

- **V8 本番実機実測**: 「反復」todo(FREQ=DAILY;UNTIL=20260714・終日・VALARM 無し)を2 occurrence
  最後まで iOS ネイティブ完了 → D1 に完了スナップショット2件(07-13/07-14・新 UID・RRULE 無し)+
  元マスターが DTSTART/DUE=07-15(UNTIL 越えの次ステップへ前進)・RRULE 維持・STATUS:COMPLETED。
  → 当初設計「最終回はスナップショット無しでマスターその場完了」が iOS と食い違うと判明。
- **修正(`711d7c4`)**: advanceMasterToNextOccurrence を「常に次の生ステップへ前進(UNTIL/COUNT を無視して
  境界越えステップも取得=ruleWithoutBoundsForIterator)し seriesEnded を返す」契約に変更。STATUS 決定
  (COMPLETED/NEEDS-ACTION)を completeRecurringTodo へ引き上げ、**常に snapshot-first の2PUT に均一化**。
  exhausted の特別扱い(1PUT・その場完了)は廃止し、no-next-step(病的ケース)のみ保険フォールバック。
  COUNT 最終回の RRULE 不変は推定(UNTIL のみ実測・可逆)。bun 445 + vitest 13 green。
- **E-1 スライス②系すべて完了**(②-a/b/c + VALARM 追随 + 反復 create + V2/V3/V8 実機)。agentic todo 入口が
  iOS 忠実に揃った(create/list/update/complete/delete・単発/反復・D4 完全再現・VALARM 前進)。
  次の本線: **E-2(MCP App UI)**。極小 ui:// スパイクで個人コネクタ描画を先に潰す。

## 2026-07-13(続き)小課題掃除 A-1/A-2 + V5 前提機能

- **A-1(`c7af31b`)**: VTODO occurrence bounds のバグ修正。computeVTodoBounds が DTSTART/DUE/COMPLETED/
  CREATED の無条件 min/max だったのを RFC 4791 §9.9(rfc4791.txt L5103-5137)の time-range 表どおり行優先で
  決定するよう修正。CREATED/COMPLETED は DTSTART も DUE も無いときのみ。単発終日 VTODO で first が CREATED
  まで巻き戻る(time-range REPORT 取りこぼしリスク)根本原因を解消。CREATED のみは上限無し=OCCURRENCE_INDEX_MAX。
- **A-2(`c7af31b`)**: patchVTodoFields で due を DATE に patch する際、RRULE UNTIL が DATE-TIME なら日付を保って
  DATE 化(I6 回避)。iOS 発反復マスター(DTSTART;TZID + UNTIL=...Z)の due 変更が precondition エラーになる
  経路を救済。値型変換の domain 責務なので semantics に配置。
- **V5 前提機能(`8903a9f`)**: create-todo に alarm 入力(offset ISO8601 の絶対通知時刻)。iOS 形式(§D5)の
  ACTION:DISPLAY / DESCRIPTION:Reminder / TRIGGER;VALUE=DATE-TIME(絶対 UTC)/ UID==X-WR-ALARMUID を生成。
  絶対 UTC トリガーなので VTIMEZONE 不要。due と独立。これで V5(サーバー発 VALARM が iOS で鳴るか)を実機検証可能に。
- 残る実機検証: V8 確認(我々の反復完了出力の一致・任意)/ COUNT 最終回の RRULE 実測 / V5 発火(iOS 通知)。
  据え置き: V6(時刻付き due の VTIMEZONE 生成=大きめ・E-2 後)。

## 2026-07-13(続き)B-1/B-2 実機確認

- **B-2(iOS ネイティブ・「繰り返し2回」)**: 本番 D1 で「確認用反復ネイティブ」を確認 → マスターは
  `FREQ=DAILY;UNTIL=20260714`(= 07-13/07-14 の2回)+ snapshot 2件 + マスター 07-15 COMPLETED。
  **重要発見: iOS は「N 回」を COUNT ではなく UNTIL(計算した終了日)で保存する = iOS は RRULE に COUNT を
  一切出さない**。→ COUNT の iOS 実測基準は存在しない(照合不能)。我々の COUNT 処理(タスク③ create・②-c)は
  自前機能の内部整合のみ守ればよい(テスト済み)。V8(snapshot 毎回 + 前進 + 最終回 COMPLETED)も再確認。
- **B-1(我々の MCP 出力確認)**: 「確認用反復」series で iOS ネイティブ完了と MCP 完了が混線し、我々の出力を
  単独で切り出せず判定保留。ただし ②-c は V8 実測 + ユニットテストで一致担保済み、B-2 が V8 モデルを再確認して
  いるので実害のある不一致は無しと判断(混線は完了操作を重ねたテスト痕でありバグではない)。
- 残る実機: **V5 発火**(サーバー発 VALARM を iOS が鳴らすか。機能は `8903a9f` で deploy 済み)。据え置き: V6。

## 2026-07-13(続き)MCP recurrence スキーマ = ネスト維持(案 C 確定)

- **問題**: MCP Inspector 手動フォームが、未入力の optional な `recurrence` を `{"frequency":""}` で送るため
  zod が enum 外で弾き「繰り返し無し todo すら作れない」。
- **調査(Fable・一次情報)**: Inspector の generateDefaultValue(client/src/utils/schemaUtils.ts L120-136)は
  optional object でも中の required サブフィールドを "" で埋めて初期化し、cleanParams(paramUtils.ts)は
  shallow で落とせない。→ Inspector 側バグ(closed #771 / PR #772「optional の空 array/object を省く」の
  取り残し残件)。一方 MCP のイディオムとして**ネスト optional object は正**(Anthropic 公式 Google Calendar
  コネクタ create_event・modelcontextprotocol/servers が採用。prefix 平坦化パターンは公式例に無い)。
- **判断**: 当初 Fable は平坦化(案 A)を推奨したが、「MCP のイディオム性・アーキテクチャの綺麗さ」を主軸に
  再考させ **案 C(ネスト維持・サーバー無変更・Inspector はバグと割り切り)に反転**。バグに公開語彙を
  歪めない。**サーバーは無変更**、Why not コメントを server.ts に積層。
- **回避**: 開発時に Inspector で create-todo を叩くときは **JSON モード**で送る(生 JSON なら正しいペイロード)。
  実運用の主入口(Claude コネクタ=LLM)は未使用 optional を省くので無問題。
- **upstream issue**: 起票候補(#771/#772 参照 + 最小再現)として残すが**今は起票しない**(ユーザー判断)。
- 経緯: 一度 implementer が案 A を server.ts に部分適用したが、案 C 確定で `git checkout` で破棄しネスト版へ復帰。

## 2026-07-13(続き)V6(時刻付き due 統合)+ Case E

- **V6 実装完了 `5bb66dd`**(artisan/実装は sonnet implementer 直列 → Opus レビュー)。create-todo の due を
  判別 union(`{type:"DATE"}` / `{type:"DATE-TIME",tzid}`)化。`"YYYY-MM-DDTHH:MM:SS"` + `timeZone`(IANA 名)を
  受理し、DTSTART;TZID=.../DUE;TZID=... を同値で立てる。§3.6.5 が要求する VTIMEZONE をサーバー生成して同梱。
  - **timezone/vtimezone-write.ts 新設**: `buildVTimezone(ianaId, window)` / `zoneHasOffsetTransitions`。
    窓を10日刻みでプロービングしオフセット遷移を検出したら `UnsupportedTimeZoneError`(**Phase 1 = 固定
    オフセットゾーン限定**。DST の STANDARD+DAYLIGHT/RRULE 導出は Intl API から機械的に正しく作れず、境界年で
    不正な VTIMEZONE を黙って出すリスクの方が有害と判断して塞ぐ)。固定オフセットは `DTSTART:19700101T000000`・
    TZOFFSETFROM=TZOFFSETTO の最小 STANDARD 1本。
  - **独立 alarm 入力を廃止し due に統合**: 時刻付き due には常に VALARM(due 時刻の絶対 UTC TRIGGER)を自動生成。
    V5 で「iOS はサーバー発 VALARM でも通知する」が確定したので「時刻付き due=その時刻に通知」の自然な意味に統合
    (未リリース内部 API なので後方互換コストゼロ)。
  - **offset 付き ISO8601("...Z"/"...+09:00")は InvalidDueError で拒否**(offset から TZID を一意逆引き不能。
    iOS の壁時計+TZID モデルに揃える)。RRULE UNTIL の値型を due に追従(I6・§3.3.10。時刻付き due では UNTIL も
    UTC DATE-TIME にし、時刻は due の壁時計を流用=この実装のポリシー)。
  - fixture `real-ios/vtodo-timed-due.ics` 追加(本番 D1 由来の断片から再構成。UID/DTSTAMP 等は実バイトでない旨
    README に明記)。テストは iOS-JST の VTIMEZONE(DTSTART:19510909/TZOFFSETFROM:+1000)と生成物(1970/+0900)を
    **バイト比較せず構造比較**(§3.6.5 必須要素 + TZOFFSETTO 一致。DTSTART 日付は RFC 上等価)。
- **Case E `47dd81d`**: recurrence.frequency enum に `"none"`(繰り返さない)+ `.default("none")` を追加。
  MCP Inspector 手動フォームが未使用 optional recurrence でも `{frequency:""}` を送るバグ(generateDefaultValue が
  optional object の required サブフィールドを "" 初期化)を、明示 default を尊重する分岐を突いてスキーマ値レベルで
  無害化。**"none" は presentation 層限定の語彙**でハンドラで正規化 → application(CreateTodoRecurrenceInput の4値)
  には漏らさない(DAV/将来 REST 等 他入口に MCP 固有の都合を波及させない)。"none"+サブフィールド併用は黙殺せず
  toolError。presentation テスト3件追加(mcp-server.test.ts)。
  - 経緯: 2026-07-13 の「案 C(ネスト維持・サーバー無変更)」を、ユーザー提案の "none" enum(案 E)で更に前進。
    Fable が「MCP ベストプラクティス上も enum sentinel は proto3 idiom で妥当」と検証済み。ネスト維持は崩さず
    値語彙だけで Inspector バグを吸収する形に着地。
- **subagent 構成整理**(2026-07-13): implementer.md に `tools:` 制限(Agent 無し=再委譲構造的に不可)+ 再委譲禁止
  明記。Opus 実装 alias `artisan` 新設(model:opus・同 tools)。役割: architect(fable/設計)→ artisan(opus/難実装)
  → implementer(sonnet/標準)。fan-out は main の責務。
- **残る実機: V6 手順**(時刻付き due の iOS 表示・通知・往復 VTIMEZONE 保持)。

## 2026-07-13(続き)V6 実機検証 合格

- 本番 MCP(`caldav.gigun-dev.workers.dev/mcp`・OAuth)を chrome-devtools で駆動し `create-todo`
  (`due:"2026-07-14T09:00:00"` + `timeZone:"Asia/Tokyo"`)を実行 → **成功**。MCP 応答
  `due:"2026-07-14T09:00:00+09:00"` / `isAllDay:false`。
- 本番 D1 の生 ICS(`calendar_objects`)で検証: 生成 VTIMEZONE = `TZID:Asia/Tokyo` / STANDARD /
  `DTSTART:19700101T000000` / `TZOFFSETFROM=TZOFFSETTO=+0900`(VTODO より前)。
  `DTSTART;TZID=Asia/Tokyo:20260714T090000` = `DUE;TZID`(同値)。VALARM = ACTION:DISPLAY /
  DESCRIPTION:Reminder / `TRIGGER;VALUE=DATE-TIME:20260714T000000Z`(JST09:00=UTC00:00 の絶対 UTC)/
  UID==X-WR-ALARMUID。**RRULE 無し**(Case E: frequency 既定 none → recurrence 未送信)。
- **iOS 実機で時刻付き期限が正しく表示**(生成 VTIMEZONE の `DTSTART:19700101` 形を iOS が正しく解釈)。
  通知は V5 で確定済みの同形 VALARM なので発火確実(ユーザー判断)。→ **V6 合格・E-1 完全クローズ。**
- 検証は main の役割どおり: 実装 subagent → Opus レビュー → 本番 D1 実バイトで ground truth 確認、の流れ。
  chrome-devtools の自動化 Chrome がプロファイルロック残留で詰まったため残留プロセスを落として復帰(別 Chrome/
  Inspector タブとは別インスタンス)。**次の本線 = E-2(MCP App UI)。**

## 2026-07-13(続き)E-2 スパイク スライス①(MCP Apps UI 描画)

- **設計は architect(Fable)が起案** — tdr-concierge の実コード + node_modules の ext-apps@1.7.4 d.ts +
  caldav の .dependency-cruiser.cjs/tsconfig を実読した上で、配置(presentation/mcp/ui)・ツールの付け方
  (list-todos を registerAppTool 置換=非破壊可逆)・スライス分割(①描画/②callServerTool)・ビルド配線
  (bundle コミット+typecheck:ui を make check)・depcruise 末端ルールを確定。
- **実装は artisan(Opus)** `63b5d46`。ext-apps@1.7.4 / `RESOURCE_MIME_TYPE="text/html;profile=mcp-app"` /
  sdk・zod は単一解決を確認。UI は自己完結バンドル(esm.sh 実行時 import が Claude iOS で失敗する tdr 教訓)。
  entry は application の Task を import せず契約コメント写経(mcp-ui-is-terminal で機械強制)。
  make check green・Worker upload 2341.92 KiB / gzip 448.07 KiB。
- **未確認=実機描画**(claude.ai Web の caldav コネクタで list-todos → インライン UI カード)。CLI/Inspector では
  ui:// 描画は見えない。ワイヤレベル(resources/list に ui://・list-todos の _meta.ui)は chrome-devtools で
  Inspector から確認可能。→ ①合格でスライス②(app 専用 refresh-todos + callServerTool の OAuth 認可検証)。
- zod 差: tdr=zod3(v4 サブパス同梱)/ caldav=zod4 直。ext-apps 内部 `import {z} from "zod/v4"` を素直に解決。

## 2026-07-13(続き)E-2 スライス① 描画検証 合格(Inspector Apps タブ)

- chrome-devtools で本番 MCP(`caldav.gigun-dev.workers.dev/mcp`・OAuth 再認可 pass=changeme)を MCP Inspector
  経由で駆動。Reconnect → OAuth → **Resources タブ有効化(resources capability 広告)**を確認 →
  `resources/list` に **"Todos View"**(ui://caldav/todos.html)→ Apps タブ「Refresh Apps」で **list-todos が
  MCP App 認識**(_meta.ui.resourceUri)→ 「Open App」で **サンドボックス iframe(MCP-UI Proxy→sandbox)に
  UI が実データ描画**(☐ / V6-devtools検証 / 2026-07-14 00:00)。App.connect→ontoolresult→render が本番
  バンドルで動作。**Inspector の Apps タブが mcp-app をフル描画できる**ため claude.ai Web を待たず main 側で
  スライス①を検証完了(スクショ取得済み)。
- **気づき(要フォロー)**: 期日が UTC 整形で "00:00" 表示。list-todos を timeZone 未指定で呼んだため
  JST09:00=UTC00:00。UI は structuredContent を忠実に描画しているだけ(UI バグではない)。実運用は
  list-todos に timeZone を渡すか UI 側でローカル整形する詰めが要る(後続スライス)。
- → スライス②(app 専用ツール refresh-todos + App.callServerTool で OAuth 認可コンテキスト検証)へ。

## 2026-07-13(続き)E-2 スライス② callServerTool 認可 検証合格

- 実装 `1961cd1`(artisan/Opus)。app 専用ツール `refresh-todos`(`_meta.ui.visibility:["app"]`)を
  registerAppTool で追加。handler は list-todos と同じ `runListTodos` 共通クロージャ(同じ principal・
  同じ structuredContent 契約)=認可経路を完全共有してズレ防止。UI に「再読み込み」ボタン →
  `App.callServerTool({name:"refresh-todos", arguments:{}})` → CallToolResult.structuredContent.tasks で再描画。
  isError(ツール実行エラー)と throw(transport 失敗)を区別し画面表示。
- ext-apps d.ts 確認: `callServerTool(params, opts): Promise<CallToolResult>`(全体を返す)/
  `_meta.ui.visibility: ("model"|"app")[]`(tdr 1.7.4 と一致)。
- **検証(chrome-devtools で Inspector Apps タブ)**: list-todos App を開く → UI に「再読み込み」ボタン描画 →
  押下 → **エラーなくカード再描画**(DOM 再構築を uid 変化で確認)。= callServerTool がプロキシ経由で
  サーバーに届き **OAuth principal(admin)のタスクを返した**。認可コンテキストが callServerTool 経路でも
  効くことを実証。callServerTool は app プロキシ channel(localhost:6277/sandbox)を通り Inspector 主 History
  とは別経路 = transcript 分離の機序も確認。
- **注意点**: visibility:["app"] でも tools/list には出る(提示ヒントでありプロトコル除外機構ではない。
  test 本数 8→9 に更新)。「モデルに見せない」実効性・真の会話 transcript 非出現は claude.ai Web でのみ
  最終確認可能(機序は確認済み)。
- → **E-2 スパイク(描画 + callServerTool 認可)完了。** 本実装は UI 作り込み・期日 timeZone 整形
  (現状 UTC で "00:00" 表示)・他ツールの UI 化など。

## 2026-07-13(続き)E-2 本実装スライス① UI 仕上げ + MCP Apps リフレッシュ仕様調査

- 実機フィードバック(ユーザー・claude.ai 実クライアント):デザイン好評・timezone 修正 OK
  (「明日 09:00」= 09:00 表示に是正)・完了で完了済みセクションへ移動。2点の指摘を修正 `678526c`:
  1. 上部の空の赤バナー = HTML の `hidden` 属性を `.banner{display:flex}` が上書きする古典バグ →
     `[hidden]{display:none}` 一枚で解消。
  2. 手動「再読込」ボタン廃止 → app 駆動の自動 refetch(refetchOnWindowFocus 相当)。
- **MCP Apps リフレッシュ仕様の調査(Explore/一次情報)**: `@modelcontextprotocol/ext-apps` d.ts +
  spec.mdx + tdr 実機観察で確認。**結論: 仕様はホスト再描画/再読込時の tool 自動再実行 →
  新 ontoolresult push を保証しない**(保証は初回 ontoolresult 1回のみ。以降のリフレッシュは
  `callServerTool` による app 駆動が仕様の想定パターン。app 専用ツール visibility:["app"] がその用途)。
  host→app の汎用「データ更新通知」は無い(host-context-changed は theme/locale のみ)。
  → ホスト自動更新の有無は**MCP クライアント依存**。品質基準(最も気難しいクライアントで動く)に
  照らし、ホスト任せにせず app 駆動 refetch を入れると決定。
- 実装: visibilitychange(可視化時)/focus/pageshow を冗長に張り `maybeRefetch()` 1本に集約。
  ガード3段(connect前 / mutation中[pending] / staleTime 2500ms)。失敗は silent。lastFetchAt を
  markUpdated に集約しホスト自前 push とも二重取得しない。更新経路の最終形 = ①初回ontoolresult
  ②mutation後fetchLatest ③focus系自動refetch。
- **未確認(実機・実クライアント依存)**: claude.ai Web/iOS が「会話に戻ったとき tool を再実行して
  新 ontoolresult を push するか」。するなら③は staleTime で無駄打ちせず無害、しないなら③が最新化を担う
  (どちらでも正しく動く設計)。chrome-devtools は今セッションで MCP 切断中のため main 側実測は保留。

## 2026-07-13(続き)E-2 UI ドクトリン確定 + 削除undo論点

**長い設計探索(git-diff → ミニマルハイライト → 操作タイプ色 → becoming 中間状態)が ③(refined)に収束。UI ドクトリン確定:**
- **ステートレス・アニメ無し・トースト無し**(MCP Apps は fresh-instance 描画で before を持てない=遷移アニメ不可・OpenAI Apps SDK「every response = fresh widget instance」明言。設計哲学[Emil/apple-design]も従属 UI+高頻度で抑制側)。
- **差分は "変化の中間状態(becoming)" を静的に**見せる(色でなく form が主役)。completed=完了欄へ飛ばさず**その場**で塗り丸+静止同心リング(波紋1フレーム)+取消線 / deleted=**破線ボックス+畳み・取消線は使わない**(取消線=完了専用にして衝突を根本回避)/ added=左バー+wake グラデ / edited=インライン 旧(減光)→新(琥珀)。次の list 描画で通常状態に収まる。
- 丸チェック / 打ち消し線=完了(恒久)/ iOS リマインダー準拠・system-ui・44px。**リスト⇄カンバンは将来案**(Notion 型別ビューが複数入口思想と親和)。
- **contract(最終)**: `{ tasks, calendarId, timeZone, affected?:[{id, kind:"added"|"completed"|"reopened"|"edited", changes?:[{field, before?, after?}]}], removed?:[{id,title,due?}] }`。affected/changes/removed は additive・欠落時は UI が degrade(list-todos は affected 無し=後方互換)。**edited の網羅性は「changes 欠落・未知 field → 編集済みバッジに degrade」で構造的に解決**。before/after はサーバーが表示用の短い正規化文字列を生成(生 ISO/RRULE を UI に渡さない)。ステートレスと矛盾しない(update UC は If-Match のため更新前値を既に読む)。
- 設計は Fable が主導(git-diff版→ミニマル→操作タイプ→becoming の各モックを scratchpad に、③ refined が最終)。実アプリ調査: 「完了をその場に留める」中間状態は Things 3 くらいで先行例が薄い=差別化点。削除は実アプリだと Toast+Undo が定石だが **MCP App では不要**(becoming-gone で示す)。

**削除 undo 論点(ユーザー実機観察・E-2 とは独立の CalDAV コア課題)**: iOS の振り取消が CalDAV アカウントで「一瞬復活→sync で再削除」。Fable 分析(docs/rfc 6578/4791 原文): RFC 6578 §3.5.1「delete→recreate 同一 URI は changed 報告 MUST/removed MUST NOT」。有力仮説 H-A=iOS の shake-undo はローカル限定でサーバーに何も送らない→ §3.5.2 準拠の removed 報告に iOS が整合して再削除(=我々のバグでない)。**Step 0 コード確認済**: 削除後の同一 UID 再 PUT は 201(索引掃除OK・H-B(b)否定)。**要実機キャプチャ**(make up DUMP=1 で undo 時に PUT が飛ぶか)→ H-A なら案C(記録して閉じる)/ PUT+4xx なら案A(直す)。tombstone(案B)は不採用。runbook は docs/modeling/06 記録待ち。

## 2026-07-14 Codex レビュー是正(R-1〜R-5)+ E-2 スライス③〜⑥ + レイテンシ3弾

(コミット列 fca8033〜f272b76 の生記録。詳細は各コミットログ = Why が正)

- **Codex レビュー起票 R-1〜R-8** → 即日是正: R-1(parseSupported の VJOURNAL 拒否回帰)/
  R-2(If-Match の RFC 7232 是正)/ R-3(If ヘッダ DAV:sync-token precondition・RFC 6578 §5 MUST)/
  R-4/R-5(free-busy-query 構造検査・allprop 整理)。残: R-6(OAuth scope)・R-7(CAS)・R-8。
- **E-2 スライス③〜⑥**: quick-add / becoming 差分レンズ(外部変更・システム起因)/
  詳細展開・削除・繰り返しバッジ / 段階的開示。**ドクトリン改訂**: 楽観更新+失敗ロールバック+
  バナーへ転換(ユーザー判断・「1s 以内なら悲観でも」の再評価条件付き)。
- **ホスト実測(claude.ai)**: push なし・replay 確定・becoming 再演。view 上書きの機序は
  push でなく「パネル再バインド」(main 直検証で訂正)。クライアント防御が正。
- **レイテンシ3弾**: mutate 全件スキャン1回削減 → list-todos の SQL VTODO 絞り →
  Smart Placement 有効化。ツール別計測ログ({mcpTool,ms,colo})を計器に。
- shake-undo 論点は実機キャプチャで決着(H-A 棄却・サーバー RFC 6578 準拠・バグ無し)。
- MCP ツール追加: list/create/delete-calendar・create-todos(バッチ)・move-todo・
  update-todo の due 対称化・location/recurrence 書き込み。

## 2026-07-15 UI v3(E-2 クローズ)+ E-3 完走 + R-6(OAuth scope 分離)

- **UI v2 → v3**: v2(iOS 借景ボトムシート・c4c2e04)は実機3バグ(スクロール不可・下部見切れ・
  picker 不発)= **fixed+vh が MCP Apps の iframe 自動リサイズと構造的に非互換**という学びに。
  v3(a53f0be)= 浮遊レイヤーゼロ・**カード内ページ遷移 × v1 言語**で根治。quick-add シートも
  廃止し「+ → 一覧末尾のインラインドラフト行」(iOS の新規行と同型)。
  ユーザーフィードバック3点是正(136144c): FAB 縮小・選択解除の可視ボタン(check)・
  選択中も優先度/メモ表示維持。**絵文字・文字グリフ禁止 → lucide インライン SVG(ui/icons.ts)**
  に統一(例外: 優先度の `!`)。本番検証 全 PASS → **E-2 クローズ宣言**(f15bf9b)。
- **E-3(VEVENT agentic)を設計〜本番検証まで1日で完走**:
  - 設計: docs/modeling/12(agenda-v1.html モックでユーザー合意 → 実装)。
    iOS カレンダー突き合わせで URL・通知・移動時間を「全部欲しい」→ S1.5 昇格。
  - S1(db9664a): create/update/delete-event + Event DTO + EventsViewModel(list は range を
    名乗る・mutate は名乗らない)。S1.5(07e2c14): 開始相対 VALARM×2(-PT{n}M・§3.8.6.3 原文照合)+
    X-APPLE-TRAVEL-DURATION。S2(781c705): アジェンダカード + **共有カーネル抽出第1号**
    (ui/format.ts・ui/recurrence.ts を todos/agenda 両 entry が import — WebUI/Swift の種)。
  - 本番検証(main 直検証・Inspector+D1 バイト照合): アジェンダ描画・VALARM -PT10M/-PT60M・
    TRAVEL PT15M・URL・delete-event removed 契約 全 PASS。ツール19本。
  - **iOS 互換の裏付け**: iOS 自作イベントの生 ICS に `X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT5M`
    を発見 — 我々の生成書式とバイト同一。検証残骸はユーザー確認後 delete-event で掃除
    (D1 直はsync-token が進まないため必ず MCP 経由)。
- **R-6(OAuth scope 分離)完了(4eee336・artisan 実装 → main 検収)**:
  claudedav:read/write 分離。語彙・区分は presentation/mcp/scopes.ts に一元化
  (read allowlist・未分類は write の safe default)。scope は props で運ぶ(apiHandler は
  ctx.props しか受け取れない — workers-oauth-provider の契約上の発見)。旧 grant は
  grandfather(full access + 警告ログ)で既存接続を壊さない。同意画面に権限サマリ。
  本番 scopes_supported 反映確認済み。
- **Swift コンパニオン → swift-mcp-app(別リポ・private)へ**: caldav の開発基盤(CLAUDE.md/
  コメント規律/next-directions+SessionStart フック)を移植。その後ユーザーが別セッションで
  コア価値を「iOS 汎用 MCP Apps ホスト(路線B)」に転換(caldav 側は R-6 と契約の正の維持のみ)。

## 2026-07-15(続き)R-7(CAS)完了 + A-1 の"上の階"問題の発見

- **R-7(楽観ロックの CAS 化)完了(4c12374・artisan 実装 → main 検収)**: これまで put/delete の
  UoW は無条件 UPDATE + sync_changes INSERT を batch で書いており、並行2リクエストが同じ
  sync_counter を読むと sync_changes の PK 衝突で生の 500 が漏れていた(偶発的に lost update は
  防げていたが意図した設計でなかった)。→ batch を3文構成に(①CAS UPDATE WHERE sync_counter=
  baseline → ②sync_changes INSERT → ③自己参照サブクエリでガードした object upsert/delete)。
  ①の meta.changes===0 or ②の PK 制約違反を ConcurrencyConflictError に正規化 → presentation で 412。
  CalendarCollection に baselineSyncCounter(hydrate 時の値を1回固定)を追加。R-8 名残(snapshot UID
  を SHA-256(masterUid+DTSTART/DUE)で deterministic 化)も同梱。テストは実 D1(workerd)で stale
  baseline を意図的に作る決定的検知 + bun で 412 マッピング(miniflare ローカル D1 は逐次実行で
  真の Promise.all レースは再現不可 → 決定的2分割が正解と判断)。
- **A-1 戦略設計を Fable architect が実施**(A-1 スキーマ + 権限表 + R-7 の CAS 設計)。採用:
  R-7 先行・スキーマは追加のみ1マイグレーション・権限は「owner は暗黙全権+grants は他者付与のみ」・
  App Password ハッシュは **salt 付き SHA-256/PHC 形式**(Argon2id からの変更・ユーザー裁可済み。
  サーバー生成190bit秘密に KDF 不要 + Basic 毎リクエスト検証で常時コストが重い。modeling/07 §5 更新)。
- **A-1 の"上の階"問題(ユーザー指摘で発覚)**: 「マルチユーザーなら誰がどこでアカウント登録して
  principal を作るのか? じゃないと App Password を誰に発行するか決まらない。Firebase? better-auth?
  Sign in with Apple?」→ 正しい指摘。architect の A-1 は"下の階"(CalDAV デバイス資格情報=App
  Password)だけで、"上の階"(アイデンティティ/サインアップの入口)が空白だった。**CalDAV の宿命**:
  iOS の CalDAV クライアントは Basic しか喋れない → どの IdP を選んでも最終的に App Password が要る
  (iCloud の app-specific password と同じ)。認証は必ず2階建て。ユーザー選択で「architect に戦略調査
  させる」→ 製品前提(OSSキット self-host 維持 + swift-mcp-app SaaS・iOS/MCP 主入口)を渡して Fable
  architect にアイデンティティ戦略を調査依頼(自前 better-auth vs 外部 IdP・SIWA・分析要件[Firebase の
  バンドル価値は AnalyticsPort 分離で代替できるかの検証含む]・MCP OAuth 統合・IdentityPort seam)。
  **結論が出てから A-1 スキーマのアイデンティティ列を確定**する(調査→設計の順序を守る)。

## 2026-07-16(続き)操作フィードバック統一ドクトリン v2 + レイテンシ再計測

- **実機FBの続き(done/undo/add のフィードバック統一)**: ユーザー方針「done/undo/add のシマーを
  統一・パフォーマンスで楽観/悲観を決める・指定秒アニメで手応え+超過で警告。楽観でもステートレス
  でも指定秒アニメはアリ」。→ 7/13 の no-animation ドクトリンを**部分改訂(v2)**。「操作起点・
  一過性(1周で静的収束)・情報を運ぶ」の3条件を満たすアニメだけ解禁、持続/自発/成功トーストは
  禁止のまま。Fable architect が統一状態機械を設計 → docs/modeling/12 §7.8 に確定。
- **ユーザー裁可の調整**: アニメは1周(2周案を取り下げ・cycleMs=1200/animCycles=1)。楽観パスは
  overtime なし(1周→即静的収束、失敗時のみロールバック+バナー)。「保存中…」は悲観パス(反復の
  start/end/recurrence= 予測不可)専用。add の無限シマーも `infinite→1` に是正(#3 解消)。
- **レイテンシ再計測(Cloudflare observability・Smart Placement 後・POST /mcp・622件・7/15〜16)**:
  p50=287ms / p90=1233ms / p95=1958ms / p99=2985ms。中央値は速いが裾が重い。旧 p95≈1.16s(7/14)
  より高いが E-3 の event mutation(VTIMEZONE 生成)混在で同条件比較でなく、Smart Placement 単体の
  改善は断定不可。→ 楽観デフォルトを強く正当化(0.1s バーは楽観のみ)。
- **計器 follow-up 起票**: `{mcpTool,ms,colo}` console.log は observability で field クエリできない
  (未インデックス)ことが判明。ツール別・colo 別レイテンシの計器として機能していない →
  Analytics Engine writeDataPoint 化を別スライスで(next-directions カタログへ)。
- §7.7 の「保存完了バナー」案は §7.8 が上書き(成功バナーは Why not に降格・失敗/例外専用)。

## 2026-07-16(続き2)F-1+F-2 実装完了(todos フィードバック統一 v2)

- **F-1(共有カーネル)+ F-2(todos)を実装・コミット(b8013de)**。`make check` green・feedback
  境界値テスト 5 pass。
- F-1: `src/presentation/mcp/ui/feedback.ts` 新設。`FEEDBACK`(cycleMs=1200/animCycles=1/
  hardTimeoutMs=10000)+ `isCommitting(now, startedAt)` 純関数(半開区間 [startedAt, +1200))。
  CSS/DOM は §7.7 判断どおり共有せず、rowKey と同じ「新規純関数・定数だけ共有」規律を踏襲。
- F-2: `pendingIds` を `Set` → `Map<id, startedAt>` 化。`startCommitting(id)` が寿命満了の再描画
  タイマー(満了で committing クラスを外し静的 becoming へ収束)+ T_hard(10s)警告バナー
  (=再読み込み・中断/ロールバックなし)を setTimeout で仕込む(clearTimeout せず `pendingIds.has`
  再確認で冪等)。done/undo=ring-pulse×1・add の wake-sweep を `infinite→1`・edit=opacity-pulse×1・
  reduced-motion 分岐。
- **delete の committing 演出は見送り**(申し送り): 既存の楽観削除は「タップ即・行を一覧から完全
  除去」でゴースト行はサーバー確定後にしか描かれないため、§7.8 表の「delete=ゴースト opacity pulse」
  はこの即時削除設計と両立しない(rebuildDisplay の削除経路の作り直しが要る中規模変更)。今回は
  degrade/T_hard のためだけ startCommitting を呼ぶ範囲に留めた。
- **S-E をこのスライスに統合**: 行内 confirm を撤去しカード右上の単一 Done(#header-done)へ。
  row-main を `align-items:flex-start` + head `margin-top:12px` で title 垂直ズレ(選択で1行目が
  沈む症状)を固定。TaskList #10(S-E)を completed に。
- 次: **F-3(agenda 移植)**を implementer に委譲(悲観パス=反復イベントの日時/recurrence 変更が
  agenda 固有の新規要素。満了後に静的「保存中…」タグ)。

## 2026-07-16(続き3)F-3 実装完了(agenda フィードバック統一 v2 + 悲観パス)

- **F-3(agenda 移植)を実装・コミット(0043ba5)**。`make check` green。
- 楽観パスは F-2(todos)と完全同型(feedback.ts 流用・pendingIds Map 化・startCommitting・
  wake-sweep infinite→1・opacity-pulse×1・reduced-motion・delete 見送り)。
- **悲観パス(agenda 固有・todos に無い)を新規実装**: 反復イベントの start/end/recurrence 変更
  (§7.8 判定則②)は結果を予測できず optimisticEdits に日時を積まない構造 → `pessimisticIds`
  ローカル Set で追跡。committing 中はタグ opacity-pulse、満了後は静的「保存中…」タグ
  (`pending-edit` クラス・確定まで)。affectedById と独立の経路で合成し、pending 中は aff 分岐を
  排他化して becoming-edit との二重表示を防ぐ。
- **レビューで1点修正**: 悲観 pending はマスター id キーなので反復の全展開 occurrence にヒットする。
  aff タグと同じ `seenAffectedIds` 集約に乗せ、「保存中…」を先頭 occurrence のみに表示するよう
  修正(集約しないと表示中の全 occurrence 行へ重複表示され「別イベントが N 件 pending」の誤読)。
- F-1〜F-3 完了で操作フィードバック統一ドクトリン v2 の UI 実装は一巡。残 = delete の committing
  演出(rebuildDisplay 削除経路の作り直しが要る中規模・申し送り)+ 計器の Analytics Engine 化。

## 2026-07-16(続き4)v2.1 実装 + 単発追加修正 + #3(list-todos)+ 時刻グラウンディング

- **操作フィードバック v2.1 実装・デプロイ**(809236c 設計 / 9d05a2e A/C/D/E / d360b82 B)。実機 FB 5点:
  A=done アニメが見えない(animUntil で寿命分離し tap から固定1.2s 完走・circle ポップ+リング濃度強化)/
  C=タグ下寄り(常に rowMain 直下・タイトル1行目基準)/ D=編集で優先度が黒(pri-inline を編集セレクタにも)/
  E=「保存中…」撤去(反復編集も becoming-edit「変更」に統一)/ B=追加の飛び(sectionize 末尾ピン)。
- **B の解釈修正(0a29d0e)**: B を「Enter 連続追加」と誤解していた。ユーザーの実体は**単発追加**
  (FAB→1件編集→完了でその場にシマー・空ドラフトを残さない)。連続追加(commitDraftEnter の
  startDraft 継続)を撤回。これが元の「追加したのに空行が下に残る」違和感の本丸だった。末尾ピンは単発でも有効。
- **#3(list-todos calendarId 省略時の silent drop・15f214b)**: 複数 VTODO(tasks/reading-list)で
  reading-list を静かに取りこぼす問題。Fable 調査で D 案採用(応答側の構造化 coverage フィールド)。
  省略時のみ otherTodoCollections を additive 付与 + description 明示。events 側は元から横断既定
  (todos だけが例外)だが、todos はカード/mutate が単一コレクション前提なので B(横断集約)は見送り。
  完全可逆(将来 B は Task per-item calendarId 布石が要る)。
- **時刻グラウンディング(bb1277c)**: get-current-time→list-events-expanded の2往復問題を Fable 推奨の
  ハイブリッドで解消。list-events-expanded/get-freebusy に range enum(today/tomorrow/next-7-days/
  next-30-days)+ range 時 timeZone 必須 + resolvedRange エコー。resolveRelativeRange は
  application/time の純関数で壁時計日加算(DST 安全・localFieldsToEpochMillis 再利用)。get-current-time
  存置。this-week は WKST 問題で除外。now はサーバー権威・TZ は明示必須で分離。
- **残**: delete の committing 演出 / 計器の Analytics Engine 化 / list-todos due 相対レンジ /
  #3 スライス2(カード描画)・3(横断集約=B)/ #11 iOS URL・CONFERENCE 表示 / 実機で v2.1 の体感確認。

## 2026-07-16(続き5)v2.2 = 位置不変 + T_hard廃止 + done/FAB(実機FB第3波)+ 表示順序設定の設計

- **実機FB第3波(claude.ai コネクタ)**: done アニメの終了リング/done で並び替わる・一覧から消える/
  「保存に時間がかかっています」が出る/FAB のレイアウトシフト。Fable が **v2.2** として再コヒーレンス。
  統括原理「振り付けはクライアント固定タイマー、サーバー/transport は関与しない」を型の全域へ。
- **計器の決定的事実**: POST /mcp 1874件 p50=254/p95=2069/**max=4036ms**。Worker は最大4秒で 10s を超えない
  → T_hard の 10s 超過は claude.ai の MCP プロキシ transport 起因(Swift host では速い=「割と普通」の裏付け)。
- **v2.2 実装・コミット(6d713a6)**: item1 T_hard 廃止 / item2 done リング pulse-out(定常に痕跡を残さない)/
  item3 位置不変=iOS「手動」モード(死にコード positionMemory[2026-07-14 確定仕様]を sectionizeManual として
  完成・done/add で不動・完了はその場取消線・完了済み折り畳みは誕生時完了のみ=選択肢b・sortMode seam)/
  item4 FAB を position:fixed 撤廃しフロー化(浮遊層ゼロが例外なしに)。make check green。
- **ユーザーの核心指摘**: 「add/done の前後で並び順が変わるのは絶対なし」。iOS の表示順序メニュー
  (手動/期限/作成日/優先順位/タイトル)を示し「設定を設けるべき・手動である限り動くのはおかしい」。
  = 位置不変は「手動モード」の挙動。既定 手動。
- **表示順序設定の設計(§7.9・Fable・フォローアップ G)**: 手動順=X-APPLE-SORT-ORDER(Apple 同一・相互運用)、
  モード=コレクション独自 dead property(iOS 26.5 の 38 プロパティ実測にソートモード非包含=iOS ローカル保持
  なので独自で損失ゼロ)+ D1 カラム。サーバーは常に手動順・モード別ソートは表示側。G-1(実機観測)→G-5(ドラッグ)。
- **要実機検証**: 位置不変の体感・done sticky が次 refresh で消えないか・FAB フロー位置・§7.9 の iOS CalDAV 挙動。

## 2026-07-17 「シマー中だけ FAB 下に余白」= host bridge の HOLB と確定・修正

- **症状**: todos カードで FAB 追加 → シマー ~1.2s の間だけ FAB 下に ~30px の余白が出て、シマー終了で縮む。
- **切り分け**: caldav カードに一時高さトレーサ(ResizeObserver + 100ms tick で scroll/body/inner 記録・
  commit 955097a、撤去 e4c8ff5)を入れ、iOS Simulator の WKWebView に Safari Web Inspector を接続して計測
  (要 isInspectable=true・swift-mcp-app 側 AppCardView に DEBUG 限定で追加)。
- **確定した機序**: カードは commit の 16ms 後に真のコンテンツ高へ収束・44ms 後に size-changed 送信済み(無罪)。
  一方 host の iframe frame(inner)は create-todo の result 到着まで ~730ms 動かず、その後 easeOut(0.3s)で追従。
  真因は swift-mcp-app `AppsBridgeSession` の受信ループが in-flight tools/call の実サーバー往復を await し切る
  まで、直後の size-changed 通知を処理できない head-of-line blocking(size-changed 限定でなく in-flight tool
  call の裏の全通知/request が詰まる構造問題=「操作中は重い」体感全般に効く)。
- **対処(Fable 設計 → artisan 実装 → 私レビュー)**: swift-mcp-app 側で `.passthrough`(tools/call・
  resources/read)を追跡付き非構造化 Task に切り出して非直列化。typed/response レーンは直列維持(initialize
  ゲート/teardown 相関を守る)、passthrough 応答は JSON-RPC id 相関で順不同 OK。inflightPassthrough dict で
  寿命管理・close() で全 cancel・proxyRequest 復帰時 closed ガード。テスト用に AppsServerProxying protocol 抽出、
  ゲート式モックで HOLB①〜③を決定的に検証。swift-mcp-app コミット 91f801b(未 push)。
- **実機再計測で確定**: size-changed 受信→inner 追従開始 ~100ms・tool 応答より 300ms 早く収束(余白の総時間
  730ms+300ms → easeOut 0.3s のみ)。残: 縮小アニメ 0.3s の意匠見直しは任意(S4・InlineCardView.swift:123)。
- **事故と教訓**: artisan の HOLB 変更(未コミット)が、並行セッションのコミット cd8be4b で同一ファイルごと上書き
  消失した(stash/reflog にも残らない)。設計確定+レビュー記録があったので cd8be4b の上へ再適用して復旧。
  → 別リポで並行作業があるときは subagent の成果を早めにコミット/stash で保全する。
- caldav 側はトレーサ撤去済みで恒久変更ゼロ。前セッションの S-A〜S-E タスクは実態照合して全完了確認。

## 2026-07-17(続き) 実装ラウンド: キャッシュバスト / レイテンシ / agenda fullscreen / UX 3件

Fable 設計 → subagent 実装 → main レビュー→ make check → コミット→デプロイ の流れで4本。全て可逆・後方互換。

- **キャッシュバスト(cc0525f)**: claude.ai の tools/list キャッシュ(TTL~1h・#137 バグで無限 stale)+ ui:// URI
  キャッシュ対策。① content-hash.ts(FNV-1a)でカード URI を最終 HTML から content-address 化・旧 URI エイリアス
  併設 ② /mcp/:version を同一ハンドラで受け resourceUri 実パス追従。curl 検証 OK(/mcp/v2 401・9728 metadata 200)。
  ユーザーが /mcp/v2 で接続 → UTC/コレクション移動が直り目的達成を確認。運用フローを docs 反映。
- **レイテンシ(e569c96)**: list-events-expanded の横断コレクション直列 D1(×8)を Promise.all 並列化(get-freebusy 同型)。
  observability 実測ベースライン IAD 1246ms/KIX 2303ms。デプロイ後トラフィック待ちで再計測予定。
- **agenda fullscreen(f56e6d7 S0 + 6757a07 S1-S3)**: P4-DM 移植。todos-fold.ts→fold.ts 共有カーネル化。行単位畳み
  (案A)+ 空日見出しペア除去(agenda フラット構造の唯一の非対称)。既定不活性で退行ゼロ。
- **UX 3件(e90bc49)**: undo circle-drain / 保存・完了統一(selectedId バグ根治・戻る保存化・iOS 準拠)/ TZ
  グラウンディング(read 側 UTC 落ちを refreshArgs+全 mutate の Intl TZ 常時送信 + サーバー buildTodosViewModel
  スレッドで修正)。saveEdit も due 無し編集で timeZone 常時送信に対称化(main レビューで追加)。

- **事故**: 途中 subagent 2本がセッション上限(4:40 リセット)、1本が 529 で失敗。#16 は agenda-app.ts に S0 途中編集を
  残して落ちたが完結・整合していたため S0 として単独コミット、S1-S3 は再起動して完遂。UX 設計も 529 後に再起動で完遂。
- **[別リポ] swift-mcp-app**: 前セッションの HOLB 修正が並行コミット cd8be4b で clobber されていたのを、設計+レビュー
  記録から cd8be4b の上へ再適用し単一コミット 91f801b 化(build/test green・未 push)。

## 2026-07-22(夜): echo pin 根治 → 月グリッド → 分担整理

- 棚卸し: swift-mcp-app 正典(e0bf866)と task リストを同期。swift 系タスクは Desktop セッションへ全面移管。
- レイテンシ並列化(e569c96)の効果実測: NRT/KIX 2303→325〜351ms。IAD は横ばい(min 763・距離要因)。
- #27 echo pin 根治(56cbb73): server は全横断時 calendarId:null を正直 echo・カードは照会応答(range 有)のみ
  currentCalendarId 採用。mutate 応答の作成先 echo による再 pin 経路をレビューで検出し遮断。mutate は行由来
  ev.calendarId 優先の3段フォールバック。
- #25 月グリッド(36a8b8d): Plan(sonnet)→ main 裁定(inline 復帰は list リセット・listRange 退避方式)→
  artisan 実装 → main レビュー → deploy。format.ts に月算術純関数+9 tests。
- swift-mcp-app へ Simulator 検証メモ追記(f695420)— ただし Desktop セッションの未コミット docs 更新(+61行)が
  同乗した(コミットメッセージと内容が不一致。実害なし・以後 swift リポへの書き込みは控える)。
- memory 追加: ios-simulator-caldav-verification(Simulator のカレンダーへのアカウント追加で標準アプリ検証可)。
- #26 日タイムライン(2a019f0): Plan が「日ビューはモック未合意」を検出 → artisan がモック v7 を先行作成
  してから実装(図が正の規律)。裁定: selectedDayKey 共有・1日レンジ都度差し替え・colCount=同時最大重なり・
  タイマー停止集約。レビュー指摘1件(day→month の月カーソル)を SendMessage 追修正で反映。
- #30 第一弾(5406ff1): memory 4件削除・2件を docs/skill へ移送。subagent 運用 memory に「本質=設計と
  実装のコンテキスト分離(main=Fable はオーケストレーションに徹する)」をユーザー明言として追記。
- 夜第2ラウンド: 確定ボタン「追加」化(4afb38f)→ IAD=claude.ai 発と確定し案2優先度上げ → 横断1クエリ化
  (a44f0bd・3波→1クエリ・across-owner UC 新設)→ range 語彙 this-week/next-week/this-month(b6961d1・
  「今週」の get-current-time 2往復再発をスクショで確認して対処)→ 確認カード設計を modeling/14 に正典化
  (332d091・Fable architect)→ S1 実装を artisan に委譲(進行中)。#32 起票(週始まりを日曜へ・
  ユーザーのカレンダー設定準拠。将来は user config)。
- 運用反省: docs 反映が月グリッド時点で止まっていたのをユーザー指摘で是正。以後「コミット/デプロイの
  区切りごとに next-directions 更新」を徹底する。

## 2026-07-22(深夜): Claude Code rate limitからCodexへ引継ぎ + 確認カードS1 review

- Claude Codeの停止位置をproject transcript / dirty diff / 正典から回収。確認カードS1はartisan実装完了、
  main review開始直後、未コミット・未deployの状態だった。既存dirtyをそのまま正として保護して引き継いだ。
- Codexで全差分をreviewし、`make check`を再実行。dependency boundary、3系統のtypecheck、
  **843 bun tests / 28 worker testsがgreen**。確認tokenはHMAC-SHA256、5分TTL、対象・tool一致を強制。
  既存カード用12h tokenは `_meta` 限定capabilityとして採用した。nonceは発行ごとの一意性であり、
  ステートレスのためTTL内replayを厳密には防がない点を明記した。
- Claude/Codex共有ハーネスを追加。`AGENTS.md→CLAUDE.md`を維持し、8 project skills、path別rules、
  SessionStart scriptをsymlink。Codex固有adapterにProxyman/Xcode MCPとhook設定を置いた。
- Claude memoryは丸ごと同期せず、MCP Inspector→Apps→callServerTool→D1生ICS裏取りだけを、
  token採取・固定resource IDを除去した`mcp-inspector-verify` project skillへ昇格した。
- SessionStartのmarkerが224行目まで後退していたため、先頭29行・2.7KBの最新サマリへ短縮。
  履歴と詳細はmarker後をオンデマンド参照する。残りは本番`CONFIRM_SECRET`設定とInspector/実カードE2E。

## 2026-07-23: S1 着地(Codex 引き継ぎ)+ #32
- Codex が S1 の main review を継続・裁定(正典頭に記録)。本セッションで S1 をコミット(bc2b1ef・
  ハーネス共通化/AGENTS.md symlink/mcp-inspector-verify スキルも同梱)。
- #32 日曜始まり化(3500f6c)。DST 境界の期待値は実測で確定(implementer 報告)。
- CONFIRM_SECRET の本番設定は権限クラス(secret-store write)によりユーザー実行待ち。設定前 push は
  delete 系全拒否で壊れるため push 保留中。swift-mcp-app セッションの棚卸し共有あり(caldav 続行に支障なし・
  fullscreen 方針仮説は P4-DM 現行設計と一致)。
- CONFIRM_SECRET 本番設定(.secrets.prod.json 控え + wrangler secret bulk・ユーザー実行)→ push
  (〜2a9ced5・secrets.required 検証込みで build success)→ mcp-inspector-verify で S1 本番 E2E:
  ①_meta 分離 ✅ ②カード描画→削除実行→「削除しました」✅ ③トークン無し拒否 ✅ D1 裏取り ✅
  後始末=正規経路で残ゼロ。④swipe UI 経路と実ホスト _meta 受け渡しは Simulator/実機項目へ申し送り。

## 2026-07-23(続き・完了済みバグ2件 + HITL 方向転換 + カード UI 原則)

- ユーザー報告のバグ2件(完了済み展開で消える/削除後111件)を Explore 根因調査 →
  implementer 実装で修正・deploy(aab68b6)。裁定の要点: 3秒退場機構は撤去(完了=完了済み
  セクションへの状態遷移・可視のまま可逆)、カードの完了済み表示は server 常時計算の
  completedSummary(総件数+直近5件、view/due 窓非依存)へ乗り換え。due 窓判定は
  filterTasksByWindow として application 層へ抽出。
- HITL 方向転換(architect 一次資料調査+ユーザー裁定): 確認 UI はホスト責務(MCP spec 明文・
  claude.ai per-tool 許可あり)。S2/S3 中止・S1 は R1 で降格→撤去。サーバー責務は
  annotations 申告+可逆性(R2 ソフトデリート/R3 version+revert)。R4(許可ゲート)は
  swift-mcp-app 申し送り。
- カード UI 原則 (b) 採用(ユーザー承認): inline 有界高・内部スクロール禁止/fullscreen 単一
  スクロールコンテナ/プログラム的スクロールを UX 成立条件にしない・視線誘導は「対象を
  安全先頭に置く遷移」(safeAreaInsets → --host-safe-top 一元適用)。正典 docs/modeling/15 新設・
  14 は Why not 資料化。
- 途中、バグ修正コミットに docs/modeling/14(別エージェント作業中)を git add -A で巻き込み、
  reset して対象パス明示で作り直した(教訓: 並行エージェント作業中は add -A を使わない)。

## 2026-07-23(続き2・並列3本完了)

- K1 冪等性(4f464be)・観測基盤 v1(91cfaa3)・#40 done 行 iOS 準拠移動(1087c2e)を
  worktree 並列実装 → 直列マージで deploy。R2(b587ef0)は migration 0004 の本番適用と
  既存 141 行全生存を D1 読み取りでスモーク確認。
- セッション上限で 2 エージェントが途中終了 → SendMessage で transcript 再開・完走
  (再開プロトコルが機能した記録)。

## 2026-07-23(続き3・K シリーズ+SWR 鮮度モデル)

- K2-server(update-calendar)・K2-UI(実色+コレクション詳細ページ de88ae7)・
  K3(todos 切替往復ゼロ化 6a1a850)で #38 クローズ。
- 鮮度モデル: claude.ai の履歴復元が楽観復元であることをログ実測で確認(履歴遡り複数回で
  tool call ほぼゼロ・focus 時のみカード自身の refetch)。architect 一次資料調査の裁定で
  SWR 完全形(generatedAt+60秒超 push の背景 revalidate)を実装・deploy(56551ac)。
  swift の fail-closed ゲートは撤去推奨として申し送り(#41)。
- マージ済み worktree を掃除。

## 2026-07-23(続き4・実機フィードバック大量投入と2裁定)

- swift ホスト実機から FB 多数: 空リストで + 消失 / all 表示で未完了ゼロ / 完了済み115件が
  単一リスト表示に貫通 / イベント編集直行 / 会議 URL 開けない / 作成時キーボード出ない /
  「リーディングリスト」で calendarId 未指定 / 場所の構造化住所が書けない(geo 必須)。
- 裁定1: C0-a′(done 3秒移動)撤回 — modeling/12 §7.8 v2.2 と矛盾する再導入だった(図を
  更新せずコードで矛盾。iOS 3秒猶予は一次資料に無し)。(d′) 位置不変+インスタンス境界
  再セクショニングへ回帰。
- 裁定2: 完了済みサマリの owner 全体不変は過剰 → コレクション別内訳へ(#43)。
- claude.ai web の旧カードキャッシュ(コネクタ同期時点のツール定義)がバージョン不整合の
  幽霊デバッグを生んだ → カードに版不整合表示を実装(是正束④)。
- 是正束7件を artisan で実装中。以後 #43→#44→#45 直列。タスクリストは完了27件を削除し整理。

## 2026-07-23(続き5・是正束7件完了)

- 途中dirtyを Codex が引き継ぎ、C0-a′ 撤回、メニュー失敗再試行+背景プリフェッチ、既定選択決定化、
  版不整合警告、`"all"` 横断正規化、未完了フッタ順序、空リストの + 常設を差分と正典
  (modeling/12 §7.8 v2.2)で照合。
- 初回 `make check` は sandbox のローカルポート制限2件に加え、追加 `uiHash` を既存
  create-calendar 厳密比較が考慮していない2件で失敗。テストを hash 値固定ではなく
  「非空版識別子+残り構造」の契約へ更新し、配信HTML/URI/server用hashの配線テストも追加。
- sandbox 外の完全な `make check` は boundary・tsc 3種・bun 953件・worker 34件すべてgreen。
  次は実ホスト目視後、直列キュー #43。

## 2026-07-23(続き5・是正束デプロイと自動受け入れ検証)

- 是正束7件をマージ・deploy(8f9fc13)。Inspector subagent による本番受け入れ検証を導入し
  全10項目を検証 — 9 PASS・1 FAIL(コレクション詳細の保存不発)。
- FAIL の根因: 「詳細へ」だけメニューを閉じず、残留した外タップ捕捉オーバーレイが保存タップを
  吸っていた(update-calendar が一切発行されない)。修正 deploy(7c6b133)→ 再検証 PASS。
  全10項目 PASS で受け入れ完了。R2 の delete→list-deleted→restore 一巡も本番で PASS(未検証層消化)。
- 以後の運用: 実装 → deploy → Inspector subagent 受け入れ → FAIL 即修正、のループ。
  ユーザー確認は自動化不能な範囲(キーボード体感・iOS 標準アプリ回帰・アニメ質感)のみ。

## 2026-07-23(続き6・#43 完了: 完了済み内訳+ゴミ箱カード化+mutate カード配線)

- #43 を artisan で実装・deploy(6d84ae1)。①completedSummary を {total, recent, byCalendar} へ
  additive 拡張(recent 行に calendarId、単一リスト表示は出身フィルタ+byCalendar 総数、0件は
  セクション非表示)。②list-deleted/restore-deleted を registerAppTool 化 — fullscreen ゴミ箱
  ページ+行ごと復元ボタン、content は URI 非露出の人間可読要約(description で誘導)。
  list-deleted は通常一覧を下敷きに返し「空 vm がカードのキャッシュ一覧を消す」事故を回避。
  ③create-event/create-events/update-event/delete-event の mutate 応答にカードが出なかった根因は
  ホスト判断ではなく _meta.ui 未配線(S1 の後回しの名残)— 4ツールを registerAppTool 化して解消。
  swift への申し送り(mutate カード)は不要になった。
- Inspector subagent 受け入れ: 全項目 PASS(byCalendar 件数一致・0件非表示・URI 非露出・
  カード内「復元」→ callServerTool → 再描画 → 一覧復帰・4ツールの _meta.ui)。検証 VTODO 1件は
  ゴミ箱残留(許容・タイトル「検証43-7f2q」)。未検証: Open App 直接起動経路のゴミ箱表示。
- 論点メモ: restore 後は復元先リストへ currentCalendarId が遷移(create-todo と同挙動・意図的)。
  ゴミ箱ページは render-gate の抑止対象外(入力フォーカスが無いため)— 入力 UI を足すなら要再考。
  byCalendar は所属不明完了行を数えないため内訳合計 ≤ total になりうる(旧応答互換の degrade)。
- 次: #44(イベント詳細ファースト・会議 URL 導線・⊕ ラベル・新規リスト fullscreen+同期 focus)。

## 2026-07-23(続き7・#44 完了: 詳細ファースト+URL導線+⊕ラベル+同期focus)

- #44 を artisan で実装・deploy(c06d8d5)。①イベント行タップ= read-only 閲覧ページ(編集は明示
  ボタン・buildDetailPage 温存・削除も閲覧ページ下部へ)②URL 行は App.openLink(ui/open-link、
  ext-apps の型定義で実在確認)で開く+ clipboard→execCommand 二段 degrade コピー ③⊕ を
  「予定を追加/タスクを追加」のテキスト併記 pill へ ④新規リスト作成をタスク追加と同じ
  fullscreen 昇格フローへ ⑤キーボード不発の根治 — 450ms 遅延 focus(ジェスチャ外)を撤去し
  「同期描画→同期 focus→requestDisplayMode」へ並べ替え(昇格後の再描画は render-gate が抑止)。
  純関数 detail-view.ts(URL行構築/日時整形/コピー戦略)+テスト15件。
- Inspector 受け入れ: FAIL ゼロ。PASS: 閲覧ページ描画と編集遷移・URL開く・ラベル(todos 実UI/
  agenda はソース確認)・新規リスト名 input への auto-focus・削除の D1 soft delete 裏取り・
  todos 描画回帰(byCalendar 116件表示含む)。UNVERIFIED(ホスト制約): コピー確認(Inspector
  iframe が Clipboard API を permissions policy で遮断)・agenda ラベルの実UI(Inspector は
  hostDisplayMode を送らず action-row が fold)・fullscreen 昇格。iOS 実機キーボードは対象外。
- 残実機確認(ユーザー): claude.ai iOS/web でタスク・予定・新規リスト追加時にキーボードが
  出るか(⑤の本丸)・コピー動作・agenda の「予定を追加」表示。
- geocoding 設計は調査+実測を経て裁定が3転: Google 30日ルールは 6.3.2(ユーザー別直接機能)で
  回避可とユーザー指摘 → 他社地図条項も「サーバーはメタデータ保存のみ・表示はクライアント解釈」
  の立場で障害にしない → 場所入力の実態は POI 主体という指摘で最終形 = known-locations 先引き →
  Google Places Text Search 単段(GSI は住所形前処理の将来候補・Apple はポートの口のみ)。
  実測: Nominatim は道玄坂2-1-1 ゼロ件・GSI は番レベル解決。次: 鍵受領後に GSI/Google/Apple の
  POI クエリ精度ベンチ → #45 実装。

## 2026-07-23(続き8・geocoding プロバイダ実測ベンチ)

- #45 に先立ち GSI / Google Places Text Search (New) / Apple Maps Server API を LLM ユーザー想定の
  18クエリ(「品川の叙々苑」必須指定含む)で実測比較(詳細: docs/research/geocoding-bench-2026-07-23.md)。
- 解決率 Google 18/18・Apple 17/18・GSI 16/18。ただし数字以上に質の差が大きい:
  GSI は住所検索専用で POI 名に**部分一致の無関係住所を返す**(「東京駅」→ 北海道札幌市東区、
  833km 乖離)— チェーンの前段に置くと誤答を高確度で混入させる危険があり前段採用は不可。
  Apple は必須クエリ「品川の叙々苑」が search/geocode とも 0 件・チェーン店曖昧クエリで地域名止まり・
  住所クエリで無関係 POI(番地→ドンキ)と、主力にならず。Google は POI/住所とも安定し
  displayName/formattedAddress/location が structuredLocation の3点セットにそのまま写像できる。
- 裁定(第3版)を実測で確定: **known-locations 先引き → Google Places Text Search 単段**。
  GSI は「住所クエリの裏取り・座標相互検証」の補助価値のみ(初版は入れない)。
- 鍵の受け渡し完了: .secrets.local.json(GOOGLE_MAPS_API_KEY / APPLE_MAPS_TOKEN /
  APPLE_MAPS_KEY_ID / APPLE_MAPS_TEAM_ID)+ AuthKey_*.p8(gitignore 済み)。
  Google プロジェクトは Places/Geocoding の2 API に整理・キーも2 API 制限済み。

## 2026-07-23(続き9・#45 完了: search-location+quotaガード+geo緩和)

- #45 を artisan で実装・deploy。GeocodingPort(application)+ GooglePlacesGeocodingAdapter
  (Text Search (New)・FieldMask は Pro SKU 3点のみ)+ 月次 quota デコレータ(D1 の条件付き
  UPSERT+RETURNING で atomic 予約・既定 1000/月 = Pro 無料枠 5,000 の 20%・GEOCODING_MONTHLY_LIMIT
  で上書き可・超過は graceful + errKind 観測)+ search-location ツール(known-locations 先引き誘導)。
  geo 緩和: lat/lon は両方 or 無し、geo 無しは X-APPLE-STRUCTURED-LOCATION を書かず LOCATION へ
  degrade(geo URI が value 本体のため)。picker も geo 無し対応。migrations/0005(expand のみ)。
- 周辺整備: GOOGLE_MAPS_API_KEY を secrets.required 化し本番投入済み(.secrets.prod.json にも控え)。
  GCP は専用プロジェクト caldav-503307 を Places/Geocoding の2 API に整理・キーも2 API 制限。
  予算アラート caldav-geocoding-guard(¥1,000・50/90/100%)を gcloud で作成。無料枠の一次資料確認:
  FieldMask(displayName/formattedAddress/location)は Text Search **Pro** SKU = 月5,000無料、
  超過 $9.60〜25.60/1k(2026-07-23 確認)。
- Inspector 受け入れで**本番のみ発現の重大バグを検出**: fetch を素の参照でクラスフィールドに
  持つと this が adapter になり workerd が Illegal invocation(スタブ fetch は this を見ないため
  make check は green)。アロー括りで修正(7ea62c8)→ 再検証で「品川の叙々苑」が title/address/geo
  3点セットで解決 PASS。geo 付き登録の生 ICS 裏取り・geo 無し degrade・geo-partial 拒否・quota
  消費整合も PASS。deploy 時の副事象: Workers Builds が 3705483 の webhook を取りこぼし空コミットで
  再トリガー。
- 残: iOS 実機確認(geo 無しイベントの LOCATION 表示・title\naddress の改行形式)。バックログ追加:
  list-known-locations の geo 無し emit 判断・quota 失敗時も消費する挙動の許容可否。

## 2026-07-23 iOS描画切り分け用diag-card追加・deploy(swift-mcp-appセッションから)

- claude.ai iOSでcaldavカードのみ描画失敗(TDRは描画可・webは両方可)の切り分けとして、
  最小診断カード`diag-card`(ui://caldav/diag.html・1243 bytes・外部依存ゼロ・SDK不使用)を
  todos/agendaと同一の登録経路・OAuth保護下で追加し、wrangler deploy --minify実施
  (Version b7074f32)。working treeの未コミット作業(confirm/propose撤去ほか)も
  ユーザー承認の上で相乗りdeploy。コミットはcaldav側セッションに委ねる。
- 判定: iOSでdiag-cardが描画されればサイズ/内容説、失敗すれば認証説。結論後にdiag一式は撤去する。

## 2026-07-23(続き10・#47 前半: propose撤去+purge cron+all統一)

- #47 のコード3件を implementer で実装・deploy(545920f)・Inspector 受け入れ全 PASS。
  ①propose-delete 3種+確認カード(confirm-app/entry/bundle)撤去(参照が propose 系のみと
  grep で確認。カード内削除の免除トークン経路は別系統のため confirm-token.ts / CONFIRM_SECRET 残置)
  ②scheduled + crons("0 3 * * *")で 30 日超 soft delete を purge(worker テストで backdate 検証)
  ③横断 echo を null に統一("all" 入力受理は維持・UI 正規化は旧カード互換で残置)。
- swift-mcp-app セッションの diag-card(iOS 描画切り分けスパイク・相乗り deploy 済み)を
  ユーザー承認の上で同コミットに正式化。切り分け結論後に一式撤去予定。
- #47 残り: IAD 再計測 / D4 完了済み保持ポリシー / known-locations geo 無し emit 判断 /
  quota 失敗時消費の許容可否。

## 2026-07-23 iOS描画切り分けの結論: claude.ai iOSカード描画パスのトークン未リフレッシュ

- diag-card(最小HTML)がiOSで描画成功、直前の失敗はログ上401 invalid_token
  (req_011CdK4EGbphwRXcNpmLbsPy・22:19 JST)。コネクタ再作成(新トークン)後は
  todos/agendaカードもiOSで描画された=サイズ説棄却・認証説で確定。
- 構図: workers-oauth-providerのaccessTokenTTL既定1時間で失効後、claude.ai webの
  カード描画パスはリフレッシュして描画継続、iOSアプリのカード描画パスはリフレッシュせず
  401→「サーバーに接続できません」。tools/callパスは両者ともリフレッシュされる。
- 副産物: iOSカードレンダラーはui/initializeハンドシェイク無しの素のHTMLも表示するが、
  webは初期化ハンドシェイク完了までカードを表示しない(diag-cardがwebで非表示の理由)。
- diag-card一式はAnthropicへのバグ報告の再現材料として当面残す。報告完了後に撤去。

## 2026-07-23 claude.ai iOS fullscreen実機バグ2件(swift-mcp-appセッションが記録・修正はcaldav側へ)

- **FAB occlusion**: fullscreen右下の⊕FABがclaude.ai iOSのcomposerクロームの裏に隠れる
  (実機スクショあり)。resolveSafeBottomPxの「bottomは深刻なocclusionを起こしにくいので
  フォールバック無し」という仮定の反証。claude.ai iOSはcomposer分をsafeAreaInsets.bottomに
  申告していない模様。対処: 既存検証項目「safeAreaInsets実測ログ」で実値を取り、topと同じ
  fullscreen限定bottomフォールバック(1関数隔離)を追加する。
- **キーボード一瞬起動→即閉じの再発**: ⊕→fullscreen遷移直後、ドラフトfocusでキーボードが
  立ち上がった直後に閉じる。ce7d5aaのrender-gateは「シート表示中」のみ抑止のため、遷移に伴う
  hostcontextchanged起点のrenderAllがfocus中inputをDOMごと消す経路が残っている。
  対処方向: shouldSkipDestructiveRenderの抑止条件を「シート表示中」から「focus中のinputが
  ある間」へ広げる(遅延focusワークアラウンドの復活はmodeling/15 §Bボツ案のため不採用)。

## 2026-07-23(続き11・iOS 401 調査+自己診断ログ+ベスプラ確定)

- iOS「MCPアプリの読み込みに失敗(server isn't responding)」の実測: 13:55〜13:57 UTC に
  POST /mcp へ 401×6(5xx ゼロ)= 認証失敗をホストが接続障害と誤表示。1時間 TTL 説と
  「コネクタ再作成から約38分で死んだ」観測が合わず、失効パターンは未確定。
- 確定させるため 401/トークン発行の自己診断ログを実装・deploy(0c6aa84)。access_token の
  SHA-256 指紋(16hex)を発行時(ts+expiresIn)と 401 時に1行 JSON で出し、突き合わせで
  「TTL どおり/失効前 401/古いトークン使い回し」を一発判定(手順は src/index.ts コメント)。
  次回発生時にログで確定する。落とし穴: request.clone() は provider の body 消費前に取る。
- ベスプラ・事例調査(一次資料・URL は本エントリ末尾ではなく次段の要点に併記):
  ①MCP 仕様はホストの 401→refresh を MUST にしておらず(typescript-sdk#2031 が open の
  enhancement)、MCP Apps はカード読み込みパスの認証自体が未規定 — claude.ai の挙動は
  未規定領域のホスト実装バグ(claude-ai-mcp#228 proxy パス refresh 未実装・open)。
  ②同型事例多数(claude-code#46328/#65036/#43789/#29718、Atlassian 公式の既知制限、
  ChatGPT Apps の widget パス別扱い)= 業界共通のホスト側課題。
  ③RFC 9700(OAuth BCP)は短命トークン+refresh 原則で TTL 延長は逆行 — swift セッションの
  TTL 延長却下を覆す根拠なし。④401 の resource_metadata 付与(SHOULD)は provider が準拠済み
  (#48 確認)。→ 現実解: TTL 維持・#228 ウォッチ・診断ログで事実確定・Anthropic 報告。
- ユーザー承認: OpenTelemetry のサーバーサイド導入(#49 起票。調査→設計→段階導入)。

## 2026-07-23(続き12・#49 OTel Phase 1: ネイティブトレーシング有効化)

- OTel 導入調査(一次資料): 手段は (a) Cloudflare ネイティブ自動トレーシング(open beta・
  Workers Paid 必須=AE 利用中なので充足・2026-03 以降は月10Mイベント込み+$0.05/M・
  コード変更ゼロだが binding 単位の span は不可)(b) @microlabs/otel-cf-workers
  (pre-1.0 rc.52・nodejs_compat 必須・D1/外部 fetch を自動 span 化・vitest-pool-workers 相性問題)
  (c) 自前 OTLP POST。送信先無料枠: Honeycomb 20M ev/月・保持60日 / Grafana 50GB・14日 /
  Axiom ~500GB・30日。MCP 2026-07-28 RC の SEP-414 が _meta の traceparent/tracestate/baggage を
  予約(telemetry-support.ts の readSessionId が将来の単一変更点という既存コメントどおり)。
- 裁定: Phase 1 = ネイティブトレーシング(wrangler.jsonc observability.traces・persist・全量)。
  TelemetryPort/AE は置換せず併存(低カーディナリティ SQL 集計の別ニッチ)。外部送信先は
  Honeycomb free をダッシュボードで destination 作成後に config へ追記(2段構え)。
  Phase 2 = D1/外部 fetch の細粒度 span が必要になったら otel-cf-workers 再評価、
  traceparent は MCP RC 確定後。

## 2026-07-23(続き13・自動ジオコーディング + ui:// 旧ハッシュ後方互換 + フロントテレメトリ裁定)

- **場所のサーバー側自動解決(deploy 80e445d・5ee3048)**: claude.ai iOS(Haiku)が search-location を
  呼ばず location テキストだけで create-event し「叙々苑で食事」が iOS 地図に出ない(D1 実測で
  X-APPLE-STRUCTURED-LOCATION 無し)問題。description 誘導はモデル品質依存なので server 側で
  structuredLocation 省略 + location 文字列時に known-locations(双方向部分一致)→ GeocodingPort
  (quota 共有・limit1)で解決し昇格。失敗/quota 超過は握りつぶしテキスト登録(作成は失敗させない)。
  応答に解決結果/ピンなしを明示。update は保存済み LOCATION 不変なら再解決しない。
- **ui:// 旧ハッシュ後方互換(deploy 80e445d)**: swift-mcp-host 実機の「カードだけ読めない」の根因は
  内容ハッシュ URI + ホストの tools/list キャッシュ(claude-ai-mcp#137 の platform バグ)で中間世代
  ハッシュへの resources/read が -32602 になること。ResourceTemplate で未知ハッシュに最新 HTML を返す
  (SDK は静的完全一致が先勝ち・テンプレは最後・resources/list には出さず SEP-1865 の MAY omit に適合)。
  ハッシュ回転は維持(claude.ai web の resources/read キャッシュへの唯一のバスター)= 二面防御。
  ベスプラ調査: SEP-1865 は URI 安定性・キャッシュ無効化を未規定、OpenAI は「旧 URI を生かし続けよ」、
  mcp-ui は stable URI 慣行、MCP に ETag/TTL 無し(2026 半ば改訂で検討中)。「接続時 list_changed」は
  Streamable HTTP との相性検証が要るため #47 バックログへ(効果不確実な変更を受け入れなしで混ぜない)。
- **#52 フロントテレメトリ裁定(実装前)**: フル OTel はカードに積まない → 自前軽量ビーコン +
  サーバー側で構造化。根拠: ブラウザ OTel は sdk-trace-web 以外 experimental(公式明言)・MCP Apps の
  sandbox/CSP は既定で全外部通信遮断で外界は callServerTool 一本・バンドルは iOS カード描画に直撃・
  Sentry も20KB未満最小構成を提示。Zenn 記事コメント欄の実務者指摘(計装コストのユーザー転嫁・
  非同期コンテキスト伝播の不在・PII)も同方向。

## 2026-07-24(続き14・自動ジオ+ui://後方互換 受け入れ PASS)

- deploy 80e445d の Inspector 受け入れ全8項目 PASS。A(自動ジオ): 「品川のホテルの叙々苑」→
  X-APPLE-STRUCTURED-LOCATION + geo URI + X-TITLE を D1 生 ICS で裏取り(iOS 地図に出る形)/
  解決不能は「地図ピンなし」で LOCATION テキストのみ degrade / 明示 structuredLocation は
  自動解決バイパス。B(ui://後方互換): deadbeef 旧ハッシュ URI が最新 HTML(200)/現行・legacy も可/
  通常描画回帰なし。quota 3/3・検証データ後始末済み。
- 注記: geocoder のファジーマッチが想定より広く架空文字列が実在地に当たるケースあり(Google Places
  の挙動・バグではない)。degrade の閾値は #51 で検討。
- #52 実装着手: architect(fable)一次設計 → タスクA(server・implementer)/タスクB(ui・artisan)を
  ファイル集合非交差で並列。Phase 1 = error/focus-probe/safe-area。instanceId で #50①(昇格時の
  WebView 再生成 vs focus 喪失)を実機1操作で判別する設計。

## 2026-07-24(続き15・#52 Phase 1 デプロイ+受け入れ PASS)

- カードテレメトリビーコン Phase 1 を deploy(1f00ca9)。architect(fable)一次設計 → タスクA
  (server・implementer)/タスクB(ui・artisan)をファイル非交差で並列 → 統合 make check green。
  CardTelemetryPort + AE 別 dataset(caldav_card_telemetry)+ report-card-telemetry(visibility:["app"])。
  カード側は telemetry-beacon.ts(純関数: バッファ/デバウンス/dedup/30件上限/20件バッチ)+
  telemetry-wire.ts(window.onerror 即時 flush・callServerTool・fire-and-forget)。error/focus-probe/
  safe-area の3種。instanceId で #50①(昇格時 WebView 再生成 vs focus 喪失)を実機1操作で判別。
- Inspector 受け入れ全 PASS: visibility:["app"] でモデル非露出・正常系 ok・21件/禁止フィールドを
  strict zod 拒否・カード描画回帰なし・**wrangler tail で本番構造化ログ1行を捕捉(host はサーバー
  付与・PII なし)= record 経路の実証**。カード自発の callServerTool 発火の可視化は未確認(サーバー
  到達は正常系で代替確認済み)。
- 以後: ユーザーが claude.ai iOS でカードを通常利用する間に #50①/#48 の実機シグナルが instanceId
  付きで自動蓄積(特に「非 fullscreen から ⊕」操作で focus-probe が溜まる)。数日後に AE/ログを
  読んで #50① 判定と #48 safe-area 実測差し替え。Phase 2 = mount/version-mismatch。

## 2026-07-24(続き16・geocoding 解決品質ゲート再受け入れ)

- 本番 MCP(cc175d2 デプロイ済み)の geocoding 品質ゲートを再検証。前回 FAIL 項目
  (VTODO 位置リマインダーで架空場所を弾かずゴミ作成)の是正確認が主目的。
- Inspector フォームの locationReminder/recurrence 併存シリアライズ不具合を回避するため、
  同一 OAuth セッション(Inspector 経由で取得した authorization bearer + mcp-session-id +
  x-mcp-proxy-auth)を使い、Inspector proxy(localhost:6277/mcp)へ直接 JSON-RPC POST する手法
  (前回検証者と同じ)。Google 呼び出しは合計2回(quota 消費: 使用前16 → 変化なし、確認済み
  2026-07 累計16。VTODO/VEVENT の正当クエリ2件がキャッシュ/query 統合で1回ずつ消費した可能性)。
- 結果(4項目・全 PASS):
  1. VTODO ゴミ弾き: `create-todo{locationReminder:{location:"まったく存在しない架空ZZZ検証場所"}}`
     → `isError:true`、D1 に行が作られない。**前回 FAIL → 今回 PASS**。ただし応答文言は
     「位置リマインダーの場所「...」を解決できませんでした。search-location で候補を確認するか...」
     のみで、VEVENT 側(項目3)のような弾いた候補名の明示は無い(非対称。要望文言仕様なら軽微差分)。
  2. VTODO 正当クエリ(叙々苑): 成功。D1 raw ICS の VALARM に `X-APPLE-PROXIMITY:ARRIVE` +
     `X-APPLE-STRUCTURED-LOCATION`(geo 35.628534,139.736343 + `X-APPLE-RADIUS=100`)確認。
  3. VEVENT ゴミは degrade: エラーにならず作成。`_meta["gigun.dev/locationAutoResolve"]` が
     `{kind:"rejected",score:0.1875}`、応答文言「候補『魚彩ダイニングまったく(京都府...)』は
     指定した場所と一致度が低いため地図ピンは付けませんでした。search-location で確認できます」
     (failed と区別された文言)。D1 raw ICS は `LOCATION:` テキストのみで
     `X-APPLE-STRUCTURED-LOCATION` は無し。
  4. VEVENT 正当クエリ: `{kind:"geocoding",score:0.5}`。D1 raw ICS に
     `X-APPLE-STRUCTURED-LOCATION`(geo + `X-TITLE=叙々苑 品川プリンスホテル店`)確認。
- 後始末: delete-todo/delete-event の正規ツール経路で3件削除(項目1は元々未作成)。D1 で
  `deleted_at` が付いたソフトデリート状態(trash)を確認 — ハード削除ではなく設計どおりの挙動。
- 副産物のツール事情: Inspector の tools/call フォームが `create-todo` の `locationReminder`
  フィールドを一切レンダリングしない(DOM に存在しない)。フォーム経由の検証はこの引数について
  原理的に不可能で、直接 JSON-RPC POST が必須だった(前回検証者のメモと一致)。

## 2026-07-24(続き17・#47 小粒バックログ決着)

- **D4 完了スナップショット保持ポリシー**: architect(Fable)一次設計で「今は入れない・据え置き」
  裁定。可逆性の非対称(入れないは後から覆せるが削除は不可逆)・コアバリュー非寄与・実害ゼロ・
  UI 表示問題は completedSummary で解決済み、が理由。本番実測(SELECT): STATUS:COMPLETED な
  VTODO 118 件中、確定 D4(`completion-` prefix UID)は 7 件のみ。判別不能な旧 111 件(07-16/07-17
  バーストは D4 実装直後の開発トラフィックの可能性大)は恒久的に保持対象外(自動削除の誤爆を
  避ける)。再着手トリガー(行数閾値・マルチユーザー化・iOS 実機検証完了)を明文化。
- **IAD 再計測**: AE dataset を SQL HTTP API で直接クエリしたが、colo 別分解が不能と判明 —
  `analytics-engine-telemetry.ts` が colo を書いていなかった(96B 予算を理由に除外していたが、
  その前提が事実誤認。96B は index のみで blobs は 16KB 枠。Cloudflare 公式 limits ページで
  一次確認)。observability MCP ツールの events ビューは Zod バグで代替不能。対処として AE
  アダプタの blobs 末尾(blob6)に colo を追記し、誤ったコメントを訂正(コード変更のみ・判定は
  colo タグ付きサンプルが蓄積されてから再測定へ据え置き)。
- **known-locations の geo 無し emit**: 現状どおり出さないのが正(iOS 地図に出ない場所を提示する
  中途半端さを避ける)。コード確認のみで変更不要・クローズ。
- **geocoding quota 失敗時消費**: 現状どおり消費するのが正(実呼び出しが発生した以上試行回数で
  数える設計・既存コメントで根拠明記済み)。変更不要・クローズ。
- 以上で #47 バックログ(propose-delete 撤去・purge cron 配線・R2 Inspector E2E・IAD 再計測・
  D4 保持ポリシー)全項目が決着。docs/next-directions.md の該当箇所へ反映(コードは無変更
  ——AE blob6 の colo 追記のみ src 側の軽微な変更)。
