# iOS 実機挙動の検証計画(2026-07-09 起草)

> RFC 原文照合(05)が「仕様上の正しさ」の裏取りだったのに対し、これは
> **「iOS が実際に何を送り、何を要求するか」の実測**による前提検証。
> モデリング・実装の各所に「iOS はこうしてくるはず」という仮定が埋まっており
> (I8 の「iOS は必ず VTIMEZONE を同梱してくる」等)、CalDAV リソースコンテキストの
> 実装に入る前にこれらを実測で確認する。結果はこのファイルの表に追記し、
> 覆った仮定は 03/05 とコードのコメントを先に直す(CLAUDE.md のルールどおり)。

## 検証環境

前作 hono-caldav の資産を流用する(調査済み 2026-07-09):

```
iOS 実機(Proxyman を HTTPS プロキシとして経由 → 平文キャプチャ)
  ↓
cloudflared tunnel(ローカルポートを外部公開。トークンは hono-caldav の .env)
  ↓
(前作では MKCALENDAR 書き換えプロキシ port 3001 → 検証項目 C1 の結果次第で本作は不要かも)
  ↓
wrangler dev(port 8787)
```

- 前作の起動手順: `hono-caldav/Makefile`(`make up` = DB リセット + cloudflared + proxy +
  dev + migrate + seed)。認証は Basic(email + App Password、`.dev.vars` の
  `DEMO_APP_PASSWORD` で固定可)。
- 本作はまだ HTTP 層が無いので、**キャプチャ対象は当面「前作サーバー vs iOS」でよい**。
  iOS が送るリクエスト/データの観測が目的であり、サーバー側は応答できさえすればよいため。
  本作の HTTP 層が立ち次第、同じトンネルを本作に向け替えて再検証する。
- Proxyman: iOS 側に CA プロファイルを入れて HTTPS を復号する。cloudflared の手前
  (iOS のプロキシ設定)に挟む。前作リポジトリに手順の記録は無い(今回が初)。
  **キャプチャした生 ICS はそのまま `test/domain/ical/fixtures/` の実データ版として還元する。**

## 進め方(2026-07-09 決定)

1. **観測系**(A1〜A6 / B1〜B3 / B7)は前作 hono-caldav サーバーに iOS を繋いでキャプチャ
   (環境が既にあり最速。実機操作・Proxyman はユーザー、解析・フィクスチャ化・docs 反映は Claude)。
2. **実験系**(B4〜B6 / B8。サーバー応答を変えて iOS の反応を見る)は本作の最小 HTTP
   スケルトンができてからそちらで行う(前作改造は使い捨てになるため)。
3. キャプチャ待ちの間、CalDAV リソース層のドメインモデル(R1〜R7、HTTP 非依存)を並行実装する
   (実測結果に左右されにくく手戻りリスクが小さい部分)。

## 検証項目

記法: ✅ 仮定どおり / ❌ 覆った(→ 修正先) / ⬜ 未実施。
「前提の所在」は、その仮定に依存している図・コード・コメントの場所。

### A. iCalendar データの前提(実装済み層 — フィクスチャの実データ化を兼ねる)

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| A1 | iOS は X-APPLE-* プロパティ(STRUCTURED-LOCATION, CREATOR-IDENTITY, TRAVEL-ADVISORY-BEHAVIOR 等)を付けてくる。生値保持でロスレス往復できる | structure/types.ts 冒頭の設計決定、fixtures(現状は再現データ) | イベント/リマインダーを iOS で作成 → PUT ボディをキャプチャ → parse→serialize でオクテット等価を確認し fixtures に採用 | ⬜ |
| A2 | iOS は 75 オクテットで折り畳む。日本語(UTF-8 マルチバイト)は文字境界で折る | serializer.ts foldLine、japanese-folding.ics(手計算で自作) | 日本語 SUMMARY/DESCRIPTION 入りイベントの PUT をキャプチャし折り畳み位置を実測 | ⬜ |
| A3 | TZID 付き日時を送るとき、iOS は必ず対応する VTIMEZONE を同梱してくる | I8(03 の表)の注記「iOS は必ず VTIMEZONE を同梱してくる」 | 各種イベント(終日/時刻指定/繰り返し)の PUT を観測 | ⬜ |
| A4 | リマインダー(VTODO)の DUE/DTSTART の値型・形態(DATE か DATE-TIME か、TZID の有無)、X-APPLE-SORT-ORDER の実態 | vtodo.ts の I4/I6 検証、ios-reminder.ics | 期限あり/なし・時刻あり/なしのリマインダーを作成して観測 | ⬜ |
| A5 | 繰り返しの1回だけ変更すると、同一 UID の VEVENT 複数(マスター + RECURRENCE-ID 付き)が同一リソースに PUT される。RECURRENCE-ID は DTSTART と形態一致 | 03 §1-4、R3、recurrence-override.ics | 繰り返しイベントの1回を変更して PUT を観測 | ⬜ |
| A6 | iOS の生成する RRULE は FREQ が先頭 | recurrence-rule.ts の format 方針(生成時 FREQ 先頭 MUST) | 各種繰り返し設定で観測 | ⬜ |

### B. プロトコル挙動の前提(これから実装する CalDAV リソース層)

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| B1 | 探索フロー: `.well-known/caldav` へのリダイレクト(301/303/307 いずれも追従)→ current-user-principal → calendar-home-set。認証チャレンジは 401 + WWW-Authenticate(前作の知見: 403 では動かない) | 05「探索」節、前作 docs/phase2-guide.md | アカウント追加操作の全リクエストをキャプチャ | ⬜ |
| B2 | iOS がコレクションに PROPFIND するプロパティは displayname / calendar-description / getctag / apple:calendar-color / supported-calendar-component-set / resourcetype / current-user-privilege-set(sabre/dav 文書由来 — 実測未確認) | 05「RFC 7986 と Apple 拡張」節 | PROPFIND ボディをキャプチャして一覧化(iOS バージョンも記録) | ⬜ |
| B3 | プリセット色選択時、`symbolic-color` 属性付きで calendar-color を PROPPATCH してくる(Stalwart #1611) | 05 の「落とし穴」 | カレンダー色をプリセット/カスタムで変更して PROPPATCH を観測 | ⬜ |
| B4 | 新規 PUT に If-None-Match: * を付ける(SHOULD)。更新 PUT に If-Match を付ける。PUT 応答で ETag を返すと再 GET を省略する(R5 =ロスレス設計の実利) | 05 CalDAV 節「新規作成の作法」、R5 | 作成/編集操作の PUT ヘッダと直後のリクエスト有無を観測 | ⬜ |
| B5 | iOS は sync-collection REPORT を使う(対応を広告すれば)。使わない場合は getctag ポーリング + calendar-multiget。**calendar-query(time-range)無しでも同期が成立する** — 実装順(multiget/sync を query より先)の根拠 | 02-usecases の実装順、03 §1-4「Phase B は展開不要」 | supported-report-set の広告内容を変えて iOS の REPORT 選択を観測 | ⬜ |
| B6 | sync-token は URI 形式(RFC 6578 MUST)でも iOS がそのまま往復してくれる(不透明値として扱う) | 03 SyncToken の設計(内部整数 + 公開時 URI 化) | sync-collection の往復を観測 | ⬜ |
| B7 | MKCALENDAR のリクエストボディ(displayname / supported-calendar-component-set / 色)の実態 | CalendarCollection 集約の属性設計 | iOS からカレンダー/リマインダーリストを新規作成して観測 | ⬜ |
| B8 | サーバー側削除は sync-report の 404(RFC 6578 — 前作の 410 は誤りと原文照合済み)で iOS に伝わる | 05 訂正2 | サーバー側でリソースを消して iOS の同期を観測 | ⬜ |

### C. 実行環境の前提

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| C1 | workerd(wrangler dev)は MKCALENDAR 等の拡張 HTTP メソッドを通せない(前作はこのために POST 書き換えプロキシを常設した)。**現行 wrangler で再現するか** — しないなら本作はプロキシ不要でアーキテクチャが1段簡単になる | 前作 proxy/dev.ts、本作の presentation 層設計 | 本作の wrangler dev に `curl -X MKCALENDAR`(+ PROPFIND / REPORT)を打って確認。ローカルだけでなく本番 Workers でも確認が必要な点に注意 | ❌ 再現(2026-07-09、wrangler 4.x): MKCALENDAR のみ 501(workerd が拒否、アプリに届かない)。PROPFIND / REPORT / PROPPATCH は通る(Hono の 404 = アプリ到達)。→ ローカル開発は前作同様の書き換えプロキシが必要。本番 Workers は未確認(⬜) |

## 結果の還元先

- **フィクスチャ**: A1〜A5 のキャプチャ ICS を `test/domain/ical/fixtures/` に実データとして
  追加(既存の再現データは残す — 由来をファイル冒頭コメントに書き分ける)。
- **図**: 覆った仮定は 03(不変条件・注記)/ 05(細則)を先に修正 → コード・コメントの順。
- **B2 の実測リスト**: CalDAV リソース層の PROPFIND 実装(presentation のマッピング表)の
  一次資料にする。
- 各項目の結果はこの表の「結果」列に日付付きで記録する(検証済みの証跡を残す)。
