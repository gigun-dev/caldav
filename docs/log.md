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
