# caldav

iOS のカレンダー / リマインダーアプリをプライマリクライアントとする **CalDAV サーバー**。
前作 [hono-caldav](https://github.com/gigun-dev/hono-caldav)(ローカル: `~/ghq/github.com/gigun-dev/hono-caldav`)を
仕様のリファレンスに、松岡幸一郎氏の DDD ベストプラクティスでゼロから再設計する。

**コア価値: CalDAV の RFC 準拠 + iOS 対応。** この2つに寄与しない機能は後回し。

長期ビジョン(設計判断はこれを裏切らないこと):
1. **agentic なタスク管理の基盤** — application 層のユースケースは DAV 専用にせず、
   MCP / REST / メールハンドラなど複数の入口から呼べる形を保つ。
2. **OSS「CalDAV サーバーキット」** — コアはマウント可能な Hono アプリとして切り出せる構造。
   永続化(D1)・認証はポート&アダプタで差し替え可能に(D1 は同梱リファレンス実装)。
   iOS 対応は「特化」ではなく「品質基準」(最も気難しいクライアントで動く汎用サーバー)。

当面は単一パッケージ + CI での機械的な層境界強制。ディレクトリ構造 = 将来のパッケージ境界
(`@caldav/ical` / `@caldav/core` / `@caldav/adapter-d1`)。モノレポ移行トリガーは
ical パースの API 安定 or 他プロジェクトでの実需(2026-07-08 決定、詳細は git 履歴)。

## 開発プロセス

- SUDO モデリング(`docs/modeling/01〜04`)が実装の正。図と RFC の乖離に気づいたら
  コードではなく先に図を直す。
- **RFC の主張を確認するときは必ず `docs/rfc/` の原文(全文スナップショット)を読むこと。**
  学習済み知識や要約に頼らない(RFC 7986 で過剰な断定が入り込んだ反省。経緯は docs/rfc/README.md)。
  照合結果は docs/modeling/05 に記録。
- iOS 実機挙動の検証結果は docs/modeling/06、認証方式の調査は docs/modeling/07。

## 技術スタック

- Runtime: Cloudflare Workers / Framework: Hono / TypeScript strict / PM: Bun / DB: Cloudflare D1
- 認証: 現状は単一ユーザー Basic(secrets 直)。M2 で App Password 化(docs/modeling/07)。
  ドメイン/アプリケーション層は認証方式に依存させない。
- 検証: `make check`(CI と同一の 層境界 → tsc → bun test)。main への push は
  `.githooks/pre-push` が `make check` で守る(`make hooks` で配線)。
- ローカル開発: `make dev` ほか(Makefile 参照)。iOS 実機は
  cloudflared named tunnel → 書き換え proxy(:8080)→ wrangler dev(:8787)。
- 本番: Workers Builds が main push で自動 deploy。iOS の正式入口は Cloud Run 書き換え
  プロキシ(workerd/Workers は MKCALENDAR を通せないため恒久構成)。
  D1 マイグレーションは deploy command に組み込んで自動適用する(前方互換規律必須。詳細 migrations/README.md)。

## アーキテクチャ方針(松岡 DDD)

オニオンアーキテクチャの4層。依存は常に内側(domain)へ向ける。CI が境界を強制。

```
src/
├── domain/         # RFC 5545 のドメインモデル(値オブジェクト・エンティティ・集約・ドメインサービス)
├── application/    # ユースケース層。CalDAV の各操作(PROPFIND, REPORT, PUT...)を1ユースケース1クラスで
├── infrastructure/ # D1 リポジトリ実装、認証など外部技術の詳細
└── presentation/   # Hono ルーティング、WebDAV XML のパース/シリアライズ(プロトコル知識はここに閉じ込める)
```

前作の反省点: ハンドラ直ストレージ → ユースケース層を挟む / ICS 文字列のまま → 型で表現 /
XML・プロトコル知識のハンドラ漏れ → presentation に隔離。

RFC の実装順: 5545(iCalendar)→ 4918(WebDAV)→ 4791(CalDAV)→ 6578(sync)→
6638/5546(スケジューリング)+ iOS 必須の周辺(.well-known、principal、Apple 拡張)。

## コメント方針(重要・このリポジトリの基本ルール)

**コメントをコードと同量レベルでベッタベタに書く。** AI が主に読み書きするコードでは
「自己説明的であるべき」慣習は当てはまらない(乖離は AI が検知できる/情報量のメリットが勝る)。

1. **「意図」を残す** — なぜこの値/この実装か、をコードのすぐ隣に。マジックナンバーには理由必須。
2. **経緯も残す** — `// 2026-05-12 クラッシュ修正: ○○が原因。△△は試したがダメだった` 歓迎。
   ボツ案は次に同じ道を通らないための財産。
3. **コンテキストはコードの近くに** — 別ドキュメントに切り出さない。
4. **分量目安**: 関数はコメント:コード ≒ 半々。既存コメントを消すのは「事実として誤りになった」
   ときだけ。冗長という理由では消さない。

## 現在地・次の作業(セッション引き継ぎ)

- 正典は **`docs/next-directions.md`** — セッション開始時にまず読む。
  作業の区切りごとに必ず更新する(完了は打ち消し線+✅、変化は `> 日付 更新:` を積層。計画は消さない)。
- 時系列の生記録は **`docs/log.md`** に追記(追記専用アーカイブ)。
