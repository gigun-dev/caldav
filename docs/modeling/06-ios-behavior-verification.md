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
| A1 | iOS は X-APPLE-* プロパティ(STRUCTURED-LOCATION, CREATOR-IDENTITY, TRAVEL-ADVISORY-BEHAVIOR 等)を付けてくる。生値保持でロスレス往復できる | structure/types.ts 冒頭の設計決定、fixtures(現状は再現データ) | イベント/リマインダーを iOS で作成 → PUT ボディをキャプチャ → parse→serialize でオクテット等価を確認し fixtures に採用 | ✅ 2026-07-10: 実測 15 PUT。X-APPLE-CREATOR-IDENTITY / -CREATOR-TEAM-IDENTITY / -STRUCTURED-LOCATION / -TRAVEL-DURATION / -PROXIMITY / -MAPKIT-HANDLE / -REFERENCEFRAME / -RADIUS、X-WR-ALARMUID、X-CALENDARSERVER-ACCESS を確認。すべて生値保持でパース可。フィクスチャ 6 本を fixtures/real-ios/ に採用(往復は 15/15 が意味論的に往復可、うちバイト等価は 11/15。差 4 は A2 の折り畳み位置差のみ) |
| A2 | iOS は 75 オクテットで折り畳む。日本語(UTF-8 マルチバイト)は文字境界で折る | serializer.ts foldLine、japanese-folding.ics(手計算で自作) | 日本語 SUMMARY/DESCRIPTION 入りイベントの PUT をキャプチャし折り畳み位置を実測 | 🔶 2026-07-10: 「文字境界で折る」は✅(マルチバイト分割ゼロ)。ただし「75 オクテット厳守」は❌。iOS は **116B の日本語 SUMMARY を折らずに 1 行**で送り(put01)、83B の LOCATION も折らない一方、ASCII 主体の X-APPLE-STRUCTURED-LOCATION は折る(物理セグメント 88B/90B 始まり → 以降 73B 前後)。傾向は「非 ASCII を含む値は寛容/折らない、ASCII 主体は折る」でしきい値は 75 固定ではない。→ **修正不要**: 本作は「格納時は生バイト保持、生成時のみ 75 で折る」設計なので実害なし。往復はバイト等価でなく冪等で担保(roundtrip.test.ts の FOLDED_REAL_IOS)。serializer の 75 折りは RFC 準拠のまま維持でよい |
| A3 | TZID 付き日時を送るとき、iOS は必ず対応する VTIMEZONE を同梱してくる | I8(03 の表)の注記「iOS は必ず VTIMEZONE を同梱してくる」 | 各種イベント(終日/時刻指定/繰り返し)の PUT を観測 | ✅ 2026-07-10: `DTSTART;TZID=Asia/Tokyo` を含む全 VEVENT(put01/03/05/…)に `BEGIN:VTIMEZONE TZID:Asia/Tokyo` が同梱されていた。逆に **終日イベント**(`DTEND;VALUE=DATE`、put02)や TZID 無しの VTODO(put08/12/13)には VTIMEZONE を付けない = 「TZID を使うときだけ同梱」で I8 の仮定どおり。VTIMEZONE は STANDARD 1本のみ(DST 無し地域)で DTSTART:19510909T010000 と歴史的 offset(+1000→+0900)。MKCALENDAR ボディにも calendar-timezone として同じ VTIMEZONE を同梱(B7 参照) |
| A4 | リマインダー(VTODO)の DUE/DTSTART の値型・形態(DATE か DATE-TIME か、TZID の有無)、X-APPLE-SORT-ORDER の実態 | vtodo.ts の I4/I6 検証、ios-reminder.ics | 期限あり/なし・時刻あり/なしのリマインダーを作成して観測 | ✅ 2026-07-10: ⑩期限日付のみ → 初回 PUT は **DUE も DTSTART も無い**最小 VTODO(STATUS:NEEDS-ACTION のみ、put08)、続く更新で `DTSTART;VALUE=DATE` + `DUE;VALUE=DATE`(TZID 無し、同日)を追加(put09/12)。⑪期限日時 → `DTSTART`/`DUE` に **TZID=Asia/Tokyo 付き DATE-TIME**(put11)。DATE のとき DTSTART==DUE(同日)を送るので **I4「DUE>DTSTART」は等号許容が必須**(既存実装は `>=` でOK)。X-APPLE-SORT-ORDER は**観測されず**(iOS 26.5 は付けない)。値型は VALUE=DATE / TZID 付き DATE-TIME の 2 形態のみ確認 |
| A5 | 繰り返しの1回だけ変更すると、同一 UID の VEVENT 複数(マスター + RECURRENCE-ID 付き)が同一リソースに PUT される。RECURRENCE-ID は DTSTART と形態一致 | 03 §1-4、R3、recurrence-override.ics | 繰り返しイベントの1回を変更して PUT を観測 | 🔶 2026-07-10: 今回のキャプチャでは**確認できず(要再測)**。④「その1回だけ変更」に対応する PUT(put04, 同一 UID 9CBBF90B への 2 回目 PUT)は **RECURRENCE-ID を含まず**、マスター VEVENT に `EXDATE;TZID=Asia/Tokyo:20260716T130000` を 1 本追加しただけだった。RECURRENCE-ID 付き override 成分は本キャプチャの 15 PUT のどこにも出現しない(同一リソース内にも別リソースにも無し)。→ 2026-07-10 ユーザー確認: 操作は実際に「その回だけ削除」だった(変更の UI が不明だったため)。つまり **EXDATE は「1回削除」の正しい表現として実証された**(A5 の副産物)。RECURRENCE-ID の実証は「その回の時間を変更 →「このイベントのみ」を選択」で再測する(残件)。**→ ✅ 2026-07-10(第2ラウンド)で再測完了**: 「このイベントのみ」の時間変更で、同一リソース(9CBBF90B...ics)に同一 UID の VEVENT 2つ(マスター DTSTART;TZID=Asia/Tokyo + `RECURRENCE-ID;TZID=Asia/Tokyo:20260723T130000` 付きオーバーライド)が PUT された。RECURRENCE-ID はマスターの元 occurrence 開始時刻を zoned 形態で指し **DTSTART と形態一致** — R3 と §3.8.4.4 の前提をどちらも実証 |
| A6 | iOS の生成する RRULE は FREQ が先頭 | recurrence-rule.ts の format 方針(生成時 FREQ 先頭 MUST) | 各種繰り返し設定で観測 | ✅ 2026-07-10: `RRULE:FREQ=WEEKLY;UNTIL=20260825T040000Z`(put03/04)。FREQ 先頭・UNTIL は UTC(...Z)。UNTIL は DTSTART が zoned(TZID)でも **UTC 形態**で送る = RFC 5545 §3.3.10「DTSTART が DATE-TIME なら UTC」に準拠(floating UNTIL は来ない)。COUNT は今回未観測 |
| A7 | iOS はパラメータ値に DQUOTE/改行を含むとき RFC 6868 の ^ エンコード(`^'` `^n` `^^`)を使うか。使うなら現行 serializer の「DQUOTE 表現不可 SerializeError」は 6868 実装で解消すべき | serializer.ts serializeParamValue、docs/rfc/README.md の 6868 注意 | 引用符・改行入りの場所名/参加者名(CN パラメータ等)を iOS で作成して PUT を観測 | 🔶 2026-07-10: ⑥引用符入りタイトル/場所(put05)を観測。引用符は **SUMMARY / LOCATION の値(property value)** に入り(`場所付き'引用符'入り`—全角引用符)、`\,` エスケープはあるが **パラメータ値に DQUOTE/改行を入れる操作は誘発されなかった**。X-ADDRESS パラメータは値に `,`(全角除く)を含むと `"..."` で quote する例あり(put05 `X-ADDRESS="〒501-1132, ..."`)が、値自体に DQUOTE は無い。RFC 6868 `^` エンコードは未観測。→ serializer の「DQUOTE 表現不可 SerializeError」を踏む実データはまだ無い(6868 実装は後回しでよい) |
| A8 | iOS の非グレゴリオ暦(旧暦/中国暦)繰り返しイベントは RFC 7529 の `RSCALE` を送るか。**現行パーサーは RSCALE を未知 rule-part として InvalidValueError → validate 違反 → PUT 拒否になる**(2026-07-09 実測)。送ってくるなら寛容化(最低限「壊さず保持」)が必要 | recurrence-rule.ts の default 節(未知 rule-part 拒否) | iOS 設定で中国暦/和暦系の繰り返し(旧暦の誕生日等)を作成して RRULE を観測 | 🔶 2026-07-10: ⑤の操作をしたが **RSCALE は 1 件も観測されず**(15 PUT 中 RRULE は put03/04 の `FREQ=WEEKLY` のみ)。iOS 26.5 の標準 UI に非グレゴリオ暦繰り返しの選択肢が無かった/たどり着けなかった可能性が高い(ユーザーも「UI に選択肢があったか不明」)。RSCALE 拒否バグ(recurrence-rule.ts の default 節)は**未検証のまま残置**。→ 2026-07-10 クローズ(非該当): 日本語ロケールの iOS 26.5 標準カレンダー UI に非グレゴリオ暦繰り返しの導線は存在しない(ユーザー確認)。iOS からは RSCALE が来ないため寛容化は不要。他クライアント(Google 由来のインポート等)で RSCALE 入りデータを受ける可能性だけ既知リスクとして残置 |
| A9 | iOS リマインダー/アラームの RFC 9074 プロパティ(ACKNOWLEDGED / PROXIMITY 位置アラーム / VALARM 内 UID)の実態。完了操作・位置ベース通知で何が PUT されるか | valarm.ts(9074 プロパティは未知として生値保持)、fixtures の ACKNOWLEDGED | リマインダー完了/位置アラーム設定の PUT を観測 | ✅ 2026-07-10: ⑫**完了操作 → ACKNOWLEDGED は使われない**。VTODO 本体に `STATUS:COMPLETED` + `COMPLETED:20260710T045638Z`(UTC)+ `PERCENT-COMPLETE:100` を追加(put12, real-ios/vtodo-completed.ics)。⑬**位置アラーム → VALARM に `X-APPLE-PROXIMITY:ARRIVE`(RFC 9074 の PROXIMITY ではなく X-APPLE 拡張)+ `X-APPLE-STRUCTURED-LOCATION`(geo)+ `TRIGGER;VALUE=DATE-TIME:19760401T005545Z`(過去のダミー日時 = 位置トリガのプレースホルダ)**(put13, real-ios/vtodo-proximity-alarm.ics)。VALARM 内 `UID` と `X-WR-ALARMUID` の両方あり(同値)。ACKNOWLEDGED は完了・通常アラームとも未観測。→ すべて生値保持でパース成功、validate 違反ゼロ(9074/X-APPLE を未知プロパティとして壊さず保持できている) |

### B. プロトコル挙動の前提(これから実装する CalDAV リソース層)

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| B1 | 探索フロー: `.well-known/caldav` へのリダイレクト(301/303/307 いずれも追従)→ current-user-principal → calendar-home-set。認証チャレンジは 401 + WWW-Authenticate(前作の知見: 403 では動かない) | 05「探索」節、前作 docs/phase2-guide.md | アカウント追加操作の全リクエストをキャプチャ | 🔶 一部実測(2026-07-10、iOS 26.5 accountsd/1.0): 301 追従・認証再送 OK。探索は 443/8443/8843 の並行プローブ(8843 は Cloudflare edge 非対応で 10s タイムアウト — 致命ではない)。正規チェーン失敗時のフォールバックは `/principals/` → Google 形式 `/calendar/dav/{user}/user/` の順。**下記「アカウント追加を阻む2条件」参照** |
| B2 | iOS がコレクションに PROPFIND するプロパティは displayname / calendar-description / getctag / apple:calendar-color / supported-calendar-component-set / resourcetype / current-user-privilege-set(sabre/dav 文書由来 — 実測未確認) | 05「RFC 7986 と Apple 拡張」節 | PROPFIND ボディをキャプチャして一覧化(iOS バージョンも記録) | ✅ 2026-07-10 完全実測(iOS 26.5 dataaccessd)。**calendar-home への PROPFIND Depth:1 は 38 プロパティ**(全ヘッダ `Depth:1 / Brief:t / Prefer:return=minimal`): add-member, calendarserver:allowed-sharing-modes, apple:autoprovisioned, me.com:bulk-requests, caldav:calendar-alarm, apple:calendar-color, caldav:calendar-description, caldav:calendar-free-busy-set, apple:calendar-order, caldav:calendar-timezone, current-user-privilege-set, caldav:default-alarm-vevent-date, caldav:default-alarm-vevent-datetime, displayname, calendarserver:getctag, apple:language-code, apple:location-code, caldav:max-attendees-per-instance, owner, calendarserver:pre-publish-url, calendarserver:publish-url, calendarserver:push-transports, calendarserver:pushkey, quota-available-bytes, quota-used-bytes, apple:refreshrate, resource-id, resourcetype, caldav:schedule-calendar-transp, caldav:schedule-default-calendar-URL, calendarserver:source, calendarserver:subscribed-strip-alarms, subscribed-strip-attachments, subscribed-strip-todos, caldav:supported-calendar-component-set(+ -component-**sets** 複数形も), supported-report-set, sync-token。**同期ポーリングでは 2 種の軽量 PROPFIND**: (a) Depth:0 で `getctag` + `sync-token` の 2 つだけ(変更検知)、(b) Depth:1 で `getcontenttype` + `getetag` の 2 つだけ(リソース列挙)。→ presentation の PROPFIND マッピング表の一次資料。未知/未対応プロパティは **404 propstat に列挙必須**(教訓節参照) |
| B3 | プリセット色選択時、`symbolic-color` 属性付きで calendar-color を PROPPATCH してくる(Stalwart #1611) | 05 の「落とし穴」 | カレンダー色をプリセット/カスタムで変更して PROPPATCH を観測 | ✅ 2026-07-10: **プリセットもカスタムも常に `symbolic-color` 属性付き**。⑧プリセット赤 → `<calendar-color symbolic-color="red">#FF383C</calendar-color>`、カスタムミント → `symbolic-color="custom">#29ffe6`。差は **属性値だけ**(プリセット名 vs `"custom"`)で属性の有無ではない。MKCALENDAR ボディ内の color も同様(B7: `symbolic-color="brown"` / `"green"`)。→ presentation は `symbolic-color` 属性を**必ず受理・保持**する必要あり(値は #RRGGBB or #RRGGBBAA、iOS は 8 桁 alpha も送りうる)。calendar-order も別 PROPPATCH で来る(整数) |
| B4 | 新規 PUT に If-None-Match: * を付ける(SHOULD)。更新 PUT に If-Match を付ける。PUT 応答で ETag を返すと再 GET を省略する(R5 =ロスレス設計の実利) | 05 CalDAV 節「新規作成の作法」、R5 | 作成/編集操作の PUT ヘッダと直後のリクエスト有無を観測 | ✅ 2026-07-10: 実測どおり。**新規作成 PUT は必ず `If-None-Match: *`**(put01/03/05/06/07/08/10/13/14/15)。**更新 PUT は `If-Match: "<etag>"`**(put04/09/11/12、値は前回 PUT 応答 or REPORT の getetag)。Content-Type は常に `text/calendar; charset=utf-8`。R5 の「PUT 応答で ETag 返す→再 GET 省略」は前作サーバーの応答仕様に依存し本キャプチャでは PUT レスポンスヘッダ未収集のため未確認(本作スケルトンで再測) |
| B5 | iOS は sync-collection REPORT を使う(対応を広告すれば)。使わない場合は getctag ポーリング + calendar-multiget。**calendar-query(time-range)無しでも同期が成立する** — 実装順(multiget/sync を query より先)の根拠 | 02-usecases の実装順、03 §1-4「Phase B は展開不要」 | supported-report-set の広告内容を変えて iOS の REPORT 選択を観測 | ✅ 2026-07-10: iOS が打つ REPORT は **すべて `sync-collection`**(6 件、`sync-level:1`)。**calendar-query も calendar-multiget も time-range も一切観測されず**。各 PUT 直後に同一コレクションへ sync-collection REPORT を打つ(変更確定 → 差分取得のパターン)。→ 実装順「sync-collection を最優先、calendar-query は後回し」の判断が実測で裏付いた。前作は supported-report-set で sync-collection を広告していた前提 |
| B6 | sync-token は URI 形式(RFC 6578 MUST)でも iOS がそのまま往復してくれる(不透明値として扱う) | 03 SyncToken の設計(内部整数 + 公開時 URI 化) | sync-collection の往復を観測 | ✅ 2026-07-10: URI 形式トークンを iOS はそのまま不透明値として往復。例: `https://<cloud-run>/dav/calendars/caldav-user/calendar/ns/sync/0` → 次回 REPORT で `.../sync/1`, `/2` … と**サーバーが返した値をそのまま送り返す**(6 世代の増分を確認)。**トークンの base URL は Cloud Run URL のまま**(proxy が X-Forwarded-Host で外部 URL を保持 → C1 の落とし穴で言及の往復が成立)。本作の「内部整数 + 公開時 URI 化」設計と互換 |
| B7 | MKCALENDAR のリクエストボディ(displayname / supported-calendar-component-set / 色)の実態。**+ MKCALENDAR 501 の後に Extended MKCOL へフォールバックするか**(sabre/dav の記録では Apple クライアントは macOS 10.9.1 以前 Extended MKCOL を使用 → 10.9.2 で MKCALENDAR に切替。実装が残っていればフォールバックの望みあり) | CalendarCollection 集約の属性設計、C1(Workers は MKCALENDAR 不可 → 本作の設計方針) | iOS からカレンダー/リマインダーリストを新規作成して観測(dev プロキシ有り/無しの両方で) | ✅ 2026-07-10(proxy 経由 = `POST + X-Caldav-Method: MKCALENDAR` に変換されて到達)。⑨カレンダー作成と⑭リスト作成の 2 本を観測。ボディ(`urn:...:caldav mkcalendar` > `DAV:set/prop`)の要素: **displayname / apple:calendar-color(symbolic-color 付き)/ apple:calendar-order(整数)/ caldav:supported-calendar-component-set(カレンダー=`comp name="VEVENT"`、リマインダーリスト=`comp name="VTODO"`)/ caldav:calendar-free-busy-set(中身 `<NO/>`)/ caldav:calendar-timezone(VTIMEZONE 同梱)**。→ CalendarCollection 集約の属性設計(色/order/component-set/timezone/displayname)は実データと一致。フォールバック検証(iOS が 501 後に Extended MKCOL を打つか)は **proxy が MKCALENDAR を通してしまうため今回は観測不能** = 本作スケルトン(proxy 無し・直結)で 501 を返して要再測 |
| B8 | サーバー側削除は sync-report の 404(RFC 6578 — 前作の 410 は誤りと原文照合済み)で iOS に伝わる | 05 訂正2 | サーバー側でリソースを消して iOS の同期を観測 | ✅ 2026-07-10(第2ラウンド): 本番 D1 で UoW 等価バッチ(行削除 + sync_counter++ + sync_changes 記録)により終日イベントを削除 → iOS の sync-collection REPORT(旧 URI トークン付き)に対し 207 で `<d:status>HTTP/1.1 404 Not Found</d:status>` + 新トークン ns/sync/8 を返却 → **iPhone 画面から消滅を確認**。RFC 6578 の削除伝搬が end-to-end で成立 |
| B9 | スケジューリング未対応サーバーへの iOS の挙動: ①attendee 付きイベントを作成すると何を PUT するか(ORGANIZER/ATTENDEE プロパティのみか、METHOD 付きか — **METHOD 付きなら R7 で PUT 拒否になり保存不能**)。②探索時に calendar-user-address-set / schedule-inbox-URL 等(RFC 6638)を PROPFIND し、不在だと何が起きるか(招待 UI の無効化だけか、アカウント機能に影響するか) | R7(put-preconditions)、03 §3 スケジューリングコンテキスト(将来)の輪郭、5546/6638 のフェーズ判断 | attendee 付きイベント作成 + アカウント追加時の PROPFIND ボディを観測 | ✅ 2026-07-10: ⑦で **CalDAV カレンダー選択時は招待 UI が出なかった**(ユーザー観察)。実データ的裏付け: 「出席者招待テスト」という SUMMARY のイベント(put06, real-ios/attendee-invite-event.ics)は **ATTENDEE も ORGANIZER も METHOD も一切含まない**素の VEVENT だった。→ ①METHOD 無しなので **R7 の PUT 拒否は起きない**(スケジューリング未対応でも保存可能)。②探索の principal PROPFIND で `calendar-user-address-set` / `schedule-inbox-URL` / `schedule-outbox-URL` を要求している(教訓節の 14 プロパティ)が、サーバーがこれらを返さない(不在)ため iOS は**招待機能そのものを UI から無効化**しただけで、アカウント追加・イベント作成・同期は正常。→ **将来スケジューリング未実装でも iOS は「招待できないカレンダー」として問題なく動く**ことが確定。R7 の METHOD 拒否は iOS 起因では発火しない |

### C. 実行環境の前提

| # | 検証したい前提 | 前提の所在 | 確認方法 | 結果 |
|---|--------------|-----------|---------|------|
| C1 | workerd(wrangler dev)は MKCALENDAR 等の拡張 HTTP メソッドを通せない(前作はこのために POST 書き換えプロキシを常設した)。**現行 wrangler で再現するか** — しないなら本作はプロキシ不要でアーキテクチャが1段簡単になる | 前作 proxy/dev.ts、本作の presentation 層設計 | 本作の wrangler dev に `curl -X MKCALENDAR`(+ PROPFIND / REPORT)を打って確認。ローカルだけでなく本番 Workers でも確認が必要な点に注意 | ❌ 再現(2026-07-09、wrangler 4.x): MKCALENDAR のみ 501。PROPFIND / REPORT / PROPPATCH は通る。**さらに 2026-07-10、本番 Workers でも 501 を実測**(前作本番への iOS リマインダー追加時の MKCALENDAR、フロー 7223/7224)— ローカル限定ではなく Cloudflare ランタイム全体で MKCALENDAR は**元から**不可(退行ではない。前作の書き換えプロキシはローカル専用で、本番は最初から MKCALENDAR 非対応だった)。本番でリマインダーのタスクが保存されないのは、remindd が保存先リストを MKCALENDAR で作れないため(→ サーバー側で VTODO コレクションを事前作成しておけば回避可能)。**本作は MKCALENDAR に依存しない設計が必須**。2026-07-10 追加実測: workerd は **MKCOL / MOVE / COPY / LOCK / ACL を全て通す**(404 = アプリ到達)。拒否は MKCALENDAR のみ → Extended MKCOL [RFC 5689] は Workers 上でプロキシなしに実装可能。Cloudflare Containers は入口が Worker 経由(workerd が先にパース)なのでプロキシ代替にならない。方針: ①Extended MKCOL を主経路 ②アカウント作成時にデフォルトコレクション(VEVENT+VTODO)を自動プロビジョン ③iOS が MKCALENDAR 501 後に MKCOL へフォールバックするかは B7 で検証。2026-07-10 原因確定(web調査): workerd の HTTP 基盤 KJ の HttpMethod enum(capnproto kj/compat/http.h、25メソッド定義)に MKCALENDAR が無いため。compatibility flag 無し・issue 報告すら無しで解決見込み低。「MKCALENDAR 不可なら Extended MKCOL へ」は ownCloud/vdirsyncer でも定番解 |

### C1の本番回避構成(2026-07-10 実装・実証済み)

**iOS に案内する正式な入口は Cloud Run プロキシ URL(前作と同じ構成)。**
workers.dev 直結でも MKCALENDAR 以外は動くが、端末から新規リストを作れないのは
カレンダーサーバーとして論外(2026-07-10 ユーザー判断)なので、直結は検証・デバッグ用途のみ。
B7(iOS の Extended MKCOL フォールバック)が白と実証されたときに初めてプロキシ撤去を検討する。

- 外部入口: Cloud Run `caldav-proxy`(`caldav-prod-fukuro`, asia-northeast1)。
- proxyは `MKCALENDAR` のみ `POST + X-Caldav-Method: MKCALENDAR` へ変換し、共有secretを付けて
  Workerへ転送する。それ以外のメソッドとbodyは透過する。
- 本番実測: Cloud Runへ `MKCALENDAR` → 201、作成コレクションのDELETE → 204。
  PROPFIND → 207、PUT → 201、sync-collection REPORT → 207、DELETE → 204も同じ入口で成功。
- **Cloud Runの落とし穴**: `allUsers`へInvokerを付けるだけではアプリ用
  `Authorization: Basic` をGoogle ID tokenとして先に検査し、`Bearer invalid_token` 401にする。
  `--no-invoker-iam-check`(`run.googleapis.com/invoker-iam-disabled=true`)が必須。
- sync-tokenはproxyが付ける `X-Forwarded-Host/Proto` を基に発行し、Cloud Run URLを保つ。
  Worker内部URLを漏らすと次回REPORTのtoken baseが一致しないため、この往復を本番smokeで検証した。

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

## 2026-07-10 キャプチャ解析で検出した問題

wrangler tail の `[CAP]` ログ 114 リクエスト(前作サーバー + iOS 26.5、Cloud Run proxy 経由)を
時系列再構築して解析。操作①〜⑭に対応付け、PUT 生 ICS 15 本を本作 parse→serialize で実測。

### 本作のバグ(修正済み)

- **I4 誤検知で iOS の日付リマインダーが PUT 拒否される(修正済み 2026-07-10)。**
  iOS の「期限日付のみ」リマインダーは `DTSTART;VALUE=DATE:d` + `DUE;VALUE=DATE:d`(同日=等号)を
  送る(real-ios/vtodo-completed.ics)。vtodo.ts の I4 は `compareDateValue(due,start) <= 0`(同値も違反)
  で、これを「DUE は DTSTART より後 MUST」違反として弾いていた → CalDAV precondition 層で iOS の
  日付タスクを一律拒否 = コア価値の iOS 対応を壊す。**`< 0`(DUE<DTSTART の逆転だけ違反)に緩和**。
  §3.8.2.3 の "later in time" は厳密には `>` だが、最も気難しいクライアント(iOS)が等号を常用する以上
  iOS 実挙動を優先(CLAUDE.md 方針)。invariants.test.ts の該当ケースも「同値→違反なし / 逆転→I4」に更新。

### ロスレス往復の実測(PUT 15 本)

- **意味論的往復は 15/15 成功**(parse→serialize→parse が構造 deepEqual、validate 違反ゼロ)。
- **オクテット等価は 11/15**。崩れた 4 本(put01/02/05/13)は **すべて折り畳み位置の差のみ**が原因で、
  プロパティ順の入れ替えや値の欠落ではない(A2 参照: iOS は 116B 日本語 SUMMARY を折らない等、
  75 オクテット厳守でない)。本作は格納時に生バイト保持なので実害なし。フィクスチャは
  オクテット等価群 4 本 + 折り畳み差異(冪等)群 2 本を real-ios/ に採用。

### サーバー応答の異常(前作サーバー起因 — 本作の課題ではないが記録)

- **PUT 403 が 2 件**(tasks/E87F4211、⑩⑫ の更新 PUT)。iOS が `If-Match: "<etag>"` 付きで更新 PUT
  したが前作サーバーが 403 を返した(初回 If-None-Match:* の作成は 201 成功)。おそらく ETag
  不一致を **412 Precondition Failed ではなく 403** で返しており、iOS はリトライして最終的に諦めた
  形跡(同 UID への PUT が複数)。→ 本作 presentation は「If-Match 不一致は 412、If-None-Match:*
  で既存ありは 412(RFC 4918 §12.1)」を厳守すること(403 で返すと iOS が回復不能)。
- **PROPFIND 401 が 24 件**。すべて remindd が Google 形式フォールバックパス
  `/dav/principals/gu.univ.morita%40gmail.com/`(正規は `caldav-user`)を叩いたもの。
  これは iOS の探索フォールバック挙動(B1 の「正規チェーン成立後も別 principal を投機的に探る」)で
  想定内。正規パスは全て 2xx。**リトライループにはなっていない**(各バースト 6 連 × 数回で収束)。

## 結果の還元先

- **フィクスチャ**: A1〜A5 のキャプチャ ICS を `test/domain/ical/fixtures/` に実データとして
  追加(既存の再現データは残す — 由来をファイル冒頭コメントに書き分ける)。
- **図**: 覆った仮定は 03(不変条件・注記)/ 05(細則)を先に修正 → コード・コメントの順。
- **B2 の実測リスト**: CalDAV リソース層の PROPFIND 実装(presentation のマッピング表)の
  一次資料にする。
- 各項目の結果はこの表の「結果」列に日付付きで記録する(検証済みの証跡を残す)。
