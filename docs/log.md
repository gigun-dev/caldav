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
