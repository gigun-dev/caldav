# caldav

iOS のカレンダー / リマインダーアプリをプライマリクライアントとする **CalDAV サーバー**。
前作 [hono-caldav](https://github.com/gigun-dev/hono-caldav)(ローカル: `~/ghq/github.com/gigun-dev/hono-caldav`)を
仕様のリファレンスとしつつ、松岡幸一郎氏の DDD(ドメイン駆動設計)ベストプラクティスに従ってゼロから再設計する。

**コア価値: CalDAV の RFC 準拠 + iOS 対応。** この2つに寄与しない機能は後回しにする。
目標は「RFC 準拠の保守性」と「新機能開発のしやすさ」の両立。

## 長期ビジョン(最初のスコープ外だが、設計判断はこれを裏切らないこと)

1. **agentic なタスク管理の基盤**。CalDAV サーバーを自前で持つ動機は、todo/task を
   エージェントが操作できるプラットフォームにすること。例:
   - Web フロント(tsdav 等のクライアント採用)からのタスク管理 + WebMCP でのエージェント操作
   - メールその他のソースからのタスク自動追加(hono-caldav の Phase 3 構想の後継)
   - → application 層のユースケースは DAV プレゼンテーション専用にせず、
     MCP / REST / メールハンドラなど複数の入口から呼べる形を保つ。
     iCalendar の型付きドメインモデルは「エージェントが安全にタスクを操作できる API」の土台。
2. **OSS 思想: 他プロジェクトで気軽に自前 CalDAV サーバーを建てられること**。
   特定ユースケース(タスク管理 SaaS 等)への特化より、再利用可能な「CalDAV サーバーキット」
   としての汎用性を優先する。具体的には:
   - コアはマウント可能な Hono アプリ/ライブラリとして切り出せる構造にする
   - 永続化(D1)・認証はアダプタ(ポート&アダプタ)にし、差し替え可能に保つ
     — D1 は「同梱のリファレンス実装」という位置づけ
   - iOS 対応は「特化」ではなく「品質基準」。RFC 準拠の汎用サーバーが
     最も気難しいクライアント(iOS)で動く、という順序で考える

### パッケージ構成の方針(2026-07-08 決定)

- **当面は単一パッケージ + 機械的な境界強制**(ESLint の import 制約 / dependency-cruiser 等で
  「domain は何も import しない」「presentation → infrastructure 禁止」を CI で強制)。
  ディレクトリ構造 = 将来のパッケージ境界(`@caldav/ical` / `@caldav/core` / `@caldav/adapter-d1`)
  として設計しておく。
- 最初からモノレポ分割しない理由: RFC 原文照合でモデルを直したばかりで値オブジェクトの形は
  まだ動く。パッケージ境界 = 公開 API の凍結圧力が早すぎると「API を壊したくないから直さない」
  逆インセンティブが働く。Workers は全部バンドルするので分割のランタイム利点もゼロ。
- **モノレポ(bun workspaces)への移行トリガー**(先送りが「ずるずる」にならないよう事前定義):
  (a) iCalendar コンテキストのパース/シリアライズがロスレス往復テストを通り、
      API が1〜2週間安定したとき、または
  (b) 別プロジェクトで実際に使いたくなった最初の瞬間。
  最初の切り出しは依存ゼロの `@caldav/ical`(純粋ドメイン)から。

## 開発プロセス: SUDO モデリング → 実装

前作は iCalendar の多種多様なドメイン概念(コンポーネント、プロパティ、値型、繰り返し規則…)を
型で表現しきれず、ICS 文字列のまま扱っていた。本プロジェクトでは実装前に
松岡DDD の **SUDO モデリング** を行い、成果物を `docs/modeling/` に置く。実装はこの図を正とする。

- **S**: システム関連図 → `docs/modeling/01-system-context.md`
- **U**: ユースケース図 → `docs/modeling/02-usecases.md`
- **D**: ドメインモデル図 → `docs/modeling/03-domain-model.md`
- **O**: オブジェクト図 → `docs/modeling/04-object-diagrams.md`

モデリングの一次資料は RFC。実装中に図と RFC の乖離に気づいたら、コードではなく先に図を直す。

**RFC の主張を確認するときは必ず `docs/rfc/` の原文(全文スナップショット)を読むこと。**
学習済み知識や要約に頼らない(RFC 7986 で「iOS 対応に不要」という過剰な断定が入り込んだ反省。
2026-07-09 導入、経緯は docs/rfc/README.md)。照合結果は docs/modeling/05 に記録する。

## 技術スタック

- Runtime: Cloudflare Workers(`bun create hono@latest` の cloudflare-workers テンプレートで初期化)
- Framework: Hono / Language: TypeScript strict / PM: Bun
- DB: Cloudflare D1(SQLite)を想定(前作踏襲。バインディングは未設定)
- 認証: **未定**。前作は better-auth(Google OAuth)+ App Password だったが、コア価値は
  RFC 準拠 + iOS 対応なので、iOS が要求する Basic 認証を満たす最小構成から始める可能性が高い。
  ドメイン/アプリケーション層は認証方式に依存させないこと。

## アーキテクチャ方針(松岡 DDD)

オニオンアーキテクチャの4層。依存は常に内側(domain)へ向ける。

```
src/
├── domain/         # RFC 5545 のドメインモデル(値オブジェクト・エンティティ・集約・ドメインサービス)
│                   # 例: CalendarObject 集約、Uid / ETag / ComponentType 等の値オブジェクト
├── application/    # ユースケース層。CalDAV の各操作(PROPFIND, REPORT, PUT...)を1ユースケース1クラスで
├── infrastructure/ # D1 リポジトリ実装、認証など外部技術の詳細
└── presentation/   # Hono ルーティング、WebDAV XML のパース/シリアライズ(プロトコル知識はここに閉じ込める)
```

前作の反省点(この再設計で解消するもの):
- ハンドラが直接ストレージを呼ぶトランザクションスクリプト構造 → ユースケース層を挟む
- ICS がローデータ文字列のままでドメインモデル不在 → RFC 5545 を値オブジェクト/集約として型で表現
- XML 組み立てとプロトコル知識がハンドラに漏れていた → presentation に隔離

## RFC ロードマップ(コアから順に)

1. **RFC 5545** (iCalendar) — 純粋なドメイン層。VEVENT / VTODO、UID、RRULE 等のモデリング
2. **RFC 4918** (WebDAV) — OPTIONS / PROPFIND / PROPPATCH / MKCOL、207 Multi-Status
3. **RFC 4791** (CalDAV) — MKCALENDAR、calendar-query / calendar-multiget REPORT
4. **RFC 6578** (sync-collection) — sync-token による増分同期
5. **RFC 6638 / 5546** (スケジューリング / iTIP) — 将来フェーズ
6. iOS 互換に必須の周辺仕様: `.well-known/caldav`、current-user-principal、calendar-home-set、
   Apple 拡張(calendar-color / calendar-order / getctag)

## コメント方針(重要・このリポジトリの基本ルール)

このリポジトリでは **コメントをコードと同量レベルでベッタベタに書く**。
「コードは自己説明的であるべき」という慣習は AI が主に読み書きするコードには当てはまらない:

- コメントとコードの乖離(メンテ不足)→ AI なら乖離に気づけるので問題にならない
- コメントが多いと読みにくい → AI には過去の情報を知れるメリットの方が大きい

### ルール

1. **「意図」を残す。** コードから絶対に読み取れないもの — 機能の意図・デザイン意図・
   なぜこの値/この実装にしたのか — を、そのコードのすぐ隣に書く。
   設定値・マジックナンバーには「なぜその値か」を必ず添える。
2. **経緯も残す。** `// 2026-05-12 クラッシュ修正: ○○が原因。△△のアプローチは試したがダメだった`
   のような、git が発狂しそうな履歴やボツになった選択肢も歓迎。
   「前に試してダメだった」は次に同じ道を通らないための財産。
3. **コンテキストはコードの近くに置く。** 別ドキュメントに切り出さず、そのコードを
   見たとき常に目に入る位置に書く。使い捨て同然の量でも構わない。
4. **分量の目安**: 関数はコメント:コード ≒ 半々。設定値・ドメインルールはコメント多め。
   乖離やノイズを理由に削らない。既存コメントを消すときは「事実として誤りになった」とき
   だけで、冗長という理由では消さない。

## 現在地(セッションをまたぐ引き継ぎ用。作業の区切りごとに必ず更新すること)

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
- **次の作業**:
  1. 実機検証の残り: A5(RECURRENCE-ID — 繰り返しの1回を「時間変更」して再測。
     今回は EXDATE 削除になった)、A8(RSCALE — 非グレゴリオ暦 UI の場所を要調査)、
     B8(サーバー側削除 → iOS への 404 伝搬)、B7 のフォールバック実験
     (プロキシを外した wrangler dev 直で MKCALENDAR 501 後の挙動観測)。
  2. presentation の確認: ETag 不一致を必ず 412 で返すこと(前作は 403 で iOS が
     回復不能になった — 06 の教訓)。検証完了後は CAPTURE_LOG=0 に戻す。
  3. 実測で確定した B5(sync-collection のみ使用)により calendar-query /
     RecurrenceExpansion は当面不要と確定。次の実装候補は iOS 検証の残件消化 →
     ローカル開発環境の整備(Makefile / seed / dev プロキシ)→ CI。
