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
| A7 | iOS はパラメータ値に DQUOTE/改行を含むとき RFC 6868 の ^ エンコード(`^'` `^n` `^^`)を使うか。使うなら現行 serializer の「DQUOTE 表現不可 SerializeError」は 6868 実装で解消すべき | serializer.ts serializeParamValue、docs/rfc/README.md の 6868 注意 | 引用符・改行入りの場所名/参加者名(CN パラメータ等)を iOS で作成して PUT を観測 | ⬜ |
| A8 | iOS の非グレゴリオ暦(旧暦/中国暦)繰り返しイベントは RFC 7529 の `RSCALE` を送るか。**現行パーサーは RSCALE を未知 rule-part として InvalidValueError → validate 違反 → PUT 拒否になる**(2026-07-09 実測)。送ってくるなら寛容化(最低限「壊さず保持」)が必要 | recurrence-rule.ts の default 節(未知 rule-part 拒否) | iOS 設定で中国暦/和暦系の繰り返し(旧暦の誕生日等)を作成して RRULE を観測 | ⬜ |
| A9 | iOS リマインダー/アラームの RFC 9074 プロパティ(ACKNOWLEDGED / PROXIMITY 位置アラーム / VALARM 内 UID)の実態。完了操作・位置ベース通知で何が PUT されるか | valarm.ts(9074 プロパティは未知として生値保持)、fixtures の ACKNOWLEDGED | リマインダー完了/位置アラーム設定の PUT を観測 | ⬜ |

### B. プロトコル挙動の前提(これから実装する CalDAV リソース層)

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| B1 | 探索フロー: `.well-known/caldav` へのリダイレクト(301/303/307 いずれも追従)→ current-user-principal → calendar-home-set。認証チャレンジは 401 + WWW-Authenticate(前作の知見: 403 では動かない) | 05「探索」節、前作 docs/phase2-guide.md | アカウント追加操作の全リクエストをキャプチャ | 🔶 一部実測(2026-07-10、iOS 26.5 accountsd/1.0): 301 追従・認証再送 OK。探索は 443/8443/8843 の並行プローブ(8843 は Cloudflare edge 非対応で 10s タイムアウト — 致命ではない)。正規チェーン失敗時のフォールバックは `/principals/` → Google 形式 `/calendar/dav/{user}/user/` の順。**下記「アカウント追加を阻む2条件」参照** |
| B2 | iOS がコレクションに PROPFIND するプロパティは displayname / calendar-description / getctag / apple:calendar-color / supported-calendar-component-set / resourcetype / current-user-privilege-set(sabre/dav 文書由来 — 実測未確認) | 05「RFC 7986 と Apple 拡張」節 | PROPFIND ボディをキャプチャして一覧化(iOS バージョンも記録) | 🔶 探索フェーズのみ実測(2026-07-10): accountsd は Depth:0 で **current-user-principal / principal-URL / resourcetype** の3つを要求(+ `Brief: t` / `Prefer: return=minimal` ヘッダ)。コレクション列挙フェーズ(dataaccessd)は未測 |
| B3 | プリセット色選択時、`symbolic-color` 属性付きで calendar-color を PROPPATCH してくる(Stalwart #1611) | 05 の「落とし穴」 | カレンダー色をプリセット/カスタムで変更して PROPPATCH を観測 | ⬜ |
| B4 | 新規 PUT に If-None-Match: * を付ける(SHOULD)。更新 PUT に If-Match を付ける。PUT 応答で ETag を返すと再 GET を省略する(R5 =ロスレス設計の実利) | 05 CalDAV 節「新規作成の作法」、R5 | 作成/編集操作の PUT ヘッダと直後のリクエスト有無を観測 | ⬜ |
| B5 | iOS は sync-collection REPORT を使う(対応を広告すれば)。使わない場合は getctag ポーリング + calendar-multiget。**calendar-query(time-range)無しでも同期が成立する** — 実装順(multiget/sync を query より先)の根拠 | 02-usecases の実装順、03 §1-4「Phase B は展開不要」 | supported-report-set の広告内容を変えて iOS の REPORT 選択を観測 | ⬜ |
| B6 | sync-token は URI 形式(RFC 6578 MUST)でも iOS がそのまま往復してくれる(不透明値として扱う) | 03 SyncToken の設計(内部整数 + 公開時 URI 化) | sync-collection の往復を観測 | ⬜ |
| B7 | MKCALENDAR のリクエストボディ(displayname / supported-calendar-component-set / 色)の実態 | CalendarCollection 集約の属性設計 | iOS からカレンダー/リマインダーリストを新規作成して観測 | ⬜ |
| B8 | サーバー側削除は sync-report の 404(RFC 6578 — 前作の 410 は誤りと原文照合済み)で iOS に伝わる | 05 訂正2 | サーバー側でリソースを消して iOS の同期を観測 | ⬜ |
| B9 | スケジューリング未対応サーバーへの iOS の挙動: ①attendee 付きイベントを作成すると何を PUT するか(ORGANIZER/ATTENDEE プロパティのみか、METHOD 付きか — **METHOD 付きなら R7 で PUT 拒否になり保存不能**)。②探索時に calendar-user-address-set / schedule-inbox-URL 等(RFC 6638)を PROPFIND し、不在だと何が起きるか(招待 UI の無効化だけか、アカウント機能に影響するか) | R7(put-preconditions)、03 §3 スケジューリングコンテキスト(将来)の輪郭、5546/6638 のフェーズ判断 | attendee 付きイベント作成 + アカウント追加時の PROPFIND ボディを観測 | ⬜ |

### C. 実行環境の前提

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| C1 | workerd(wrangler dev)は MKCALENDAR 等の拡張 HTTP メソッドを通せない(前作はこのために POST 書き換えプロキシを常設した)。**現行 wrangler で再現するか** — しないなら本作はプロキシ不要でアーキテクチャが1段簡単になる | 前作 proxy/dev.ts、本作の presentation 層設計 | 本作の wrangler dev に `curl -X MKCALENDAR`(+ PROPFIND / REPORT)を打って確認。ローカルだけでなく本番 Workers でも確認が必要な点に注意 | ❌ 再現(2026-07-09、wrangler 4.x): MKCALENDAR のみ 501。PROPFIND / REPORT / PROPPATCH は通る。**さらに 2026-07-10、本番 Workers でも 501 を実測**(前作本番への iOS リマインダー追加時の MKCALENDAR、フロー 7223/7224)— ローカル限定ではなく Cloudflare ランタイム全体で MKCALENDAR は**元から**不可(退行ではない。前作の書き換えプロキシはローカル専用で、本番は最初から MKCALENDAR 非対応だった)。本番でリマインダーのタスクが保存されないのは、remindd が保存先リストを MKCALENDAR で作れないため(→ サーバー側で VTODO コレクションを事前作成しておけば回避可能)。**本作は MKCALENDAR に依存しない設計が必須**。2026-07-10 追加実測: workerd は **MKCOL / MOVE / COPY / LOCK / ACL を全て通す**(404 = アプリ到達)。拒否は MKCALENDAR のみ → Extended MKCOL [RFC 5689] は Workers 上でプロキシなしに実装可能。Cloudflare Containers は入口が Worker 経由(workerd が先にパース)なのでプロキシ代替にならない。方針: ①Extended MKCOL を主経路 ②アカウント作成時にデフォルトコレクション(VEVENT+VTODO)を自動プロビジョン ③iOS が MKCALENDAR 501 後に MKCOL へフォールバックするかは B7 で検証。2026-07-10 原因確定(web調査): workerd の HTTP 基盤 KJ の HttpMethod enum(capnproto kj/compat/http.h、25メソッド定義)に MKCALENDAR が無いため。compatibility flag 無し・issue 報告すら無しで解決見込み低。「MKCALENDAR 不可なら Extended MKCOL へ」は ownCloud/vdirsyncer でも定番解 |

## 実測から得た教訓(本作 presentation 層の要件)

### iOS のアカウント追加を阻む2条件(2026-07-10、前作で実測・修正して確認)

前作サーバーで iOS のアカウント追加が失敗し、Proxyman の復号キャプチャで原因を特定した。
iOS(accountsd)は正しい current-user-principal を受け取っても以下の不備で**破棄**し、
ハードコードされたフォールバックパス探索に落ちて失敗する:

1. **要求されたプロパティを黙って落とすと NG**(RFC 4918 §9.1)。accountsd は
   current-user-principal / principal-URL / resourcetype を要求し、前作は principal-URL を
   200 にも 404 propstat にも入れず無視していた → iOS が 207 全体を不信扱い。
   **本作の PROPFIND 実装は「見つからないプロパティは 404 propstat に列挙」を必須要件とする**
   (RFC 上も MUST。iOS はこれを実際に強制する)。principal-URL は current-user-principal と
   同値を返すのが安全(Apple クライアントは同義に使う)。
2. **href のパスセグメントはパーセントエンコードする**。前作は principal href の `@` を
   生のまま返していた(iOS 自身のフォールバック探索は `%40` を使う = iOS は href を
   正規化して扱う)。本作の href 生成は encodeURIComponent 相当を通すこと。
3. **207 の `<d:response>` の href はリクエスト URI と一致させる**(RFC 4918 §8.3)。
   前作は `PROPFIND /` への応答に `<d:href>/dav/</d:href>` をハードコード返却しており、
   iOS はこの不一致で応答全体を不信して current-user-principal を破棄した(2026-07-10 特定・
   修正第2弾)。本作の presentation は「応答 href = 正規化したリクエストパス」を機械的に保証する。

※ accountsd の探索は「要求3プロパティ(current-user-principal / principal-URL /
resourcetype)への完全な応答」を複数パス(/dav/ と /)で検分し、1つでも不備があると
正規チェーンを捨ててフォールバック(/principals/ → Google 形式)に落ちる、という
「全部正しくないと進まない」挙動。デバッグは Proxyman 復号キャプチャがないと事実上不可能
(サーバーログだけでは 207 の中身の不備が見えない)。

### 成功時の探索・初回同期シーケンス(2026-07-10、前作本番 + iOS 26.5 remindd で実測 — B1/B2 の一次データ)

リマインダーのみ有効でアカウント追加成功時の全シーケンス(User-Agent: remindd/3976):

1. PROPFIND /.well-known/caldav → 301(相対 Location: /dav/)。**最初から Basic 認証を preemptive 送信**(401 チャレンジは一度も発生しない)
2. PROPFIND /dav/(Depth:0)→ 207: current-user-principal 取得
3. OPTIONS {principal} → 204(Allow と DAV ヘッダの確認。**iOS は principal に OPTIONS を打つ**)
4. PROPFIND {principal}(Depth:0)→ 207。**要求14プロパティ**: calendar-home-set /
   calendar-user-address-set / current-user-principal / displayname / dropbox-home-URL /
   email-address-set / max-attendees-per-instance / notification-URL / principal-collection-set /
   principal-URL / resource-id / schedule-inbox-URL / schedule-outbox-URL / supported-report-set
5. OPTIONS {principal} → 204(再確認)
6. PROPFIND {calendar-home}(Depth:1)→ 207。**要求38プロパティ**(getctag / sync-token /
   supported-calendar-component-set / current-user-privilege-set / calendar-color 等。
   完全リストはキャプチャ参照)
7. MKCALENDAR {home}/{UUID}/ → **501**(→ C1。iOS はリマインダー用リストを作ろうとして失敗、1回リトライして断念)

重要な行動特性:
- **iOS は https スキームのときのみ Basic を preemptive 送信する。平文 http では 401 が返っても資格情報を送らず探索を打ち切る**(失敗側キャプチャとの decisive diff)。
- アカウント追加失敗の主犯と疑った XML 不備(href 等)は、本番(未修正コード)で成功したことから決定打ではなかった。決め手はスキーム(https で正しく到達できること)。
- 8843/8008/8800 ポートプローブはプロキシ環境だと 10 秒×複数のタイムアウトになり UX を大きく悪化させる(直結なら即 RST)。

## 結果の還元先

- **フィクスチャ**: A1〜A5 のキャプチャ ICS を `test/domain/ical/fixtures/` に実データとして
  追加(既存の再現データは残す — 由来をファイル冒頭コメントに書き分ける)。
- **図**: 覆った仮定は 03(不変条件・注記)/ 05(細則)を先に修正 → コード・コメントの順。
- **B2 の実測リスト**: CalDAV リソース層の PROPFIND 実装(presentation のマッピング表)の
  一次資料にする。
- 各項目の結果はこの表の「結果」列に日付付きで記録する(検証済みの証跡を残す)。
