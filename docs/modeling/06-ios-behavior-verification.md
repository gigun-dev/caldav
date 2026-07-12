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
| A7 | iOS はパラメータ値に DQUOTE/改行を含むとき RFC 6868 の ^ エンコード(`^'` `^n` `^^`)を使うか。使うなら現行 serializer の「DQUOTE 表現不可 SerializeError」は 6868 実装で解消すべき | serializer.ts serializeParamValue、docs/rfc/README.md の 6868 注意 | 引用符・改行入りの場所名/参加者名(CN パラメータ等)を iOS で作成して PUT を観測 | 🔶 2026-07-10: ⑥引用符入りタイトル/場所(put05)を観測。引用符は **SUMMARY / LOCATION の値(property value)** に入り(`場所付き'引用符'入り`—全角引用符)、`\,` エスケープはあるが **パラメータ値に DQUOTE/改行を入れる操作は誘発されなかった**。X-ADDRESS パラメータは値に `,`(全角除く)を含むと `"..."` で quote する例あり(put05 `X-ADDRESS="〒501-1132, ..."`)が、値自体に DQUOTE は無い。RFC 6868 `^` エンコードは未観測。→ serializer の「DQUOTE 表現不可 SerializeError」を踏む実データはまだ無い(6868 実装は後回しでよい)。**→ ✅ 2026-07-11(第3ラウンド)決着**: スマート句読点オフで ASCII DQUOTE 入りの場所名を構造化ロケーション(地図候補選択→編集)で PUT を誘発。観測: `LOCATION:...\\, "折立"232-11`(プロパティ値には**生 DQUOTE がそのまま**入る、エスケープなし=RFC 5545 合法)。一方 `X-APPLE-STRUCTURED-LOCATION` の `X-TITLE="しょぱん ... 折立232-11"` では**iOS が DQUOTE をパラメータ値から黙って除去**(quoted-string 内に `"折立"` の引用符が消えている)。**RFC 6868 `^` エンコードは使わない** — iOS は表現不可文字を送信側で排除する方針。したがって現行 serializer の SerializeError 方針は iOS 実データと衝突せず、**6868 実装は不要(恒久的に後回し)**。どちらの PUT も 204 受理(生 DQUOTE 値・quoted param とも現行パーサーで問題なし) |
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
| B7 | MKCALENDAR のリクエストボディ(displayname / supported-calendar-component-set / 色)の実態。**+ MKCALENDAR 501 の後に Extended MKCOL へフォールバックするか**(sabre/dav の記録では Apple クライアントは macOS 10.9.1 以前 Extended MKCOL を使用 → 10.9.2 で MKCALENDAR に切替。実装が残っていればフォールバックの望みあり) | CalendarCollection 集約の属性設計、C1(Workers は MKCALENDAR 不可 → 本作の設計方針) | iOS からカレンダー/リマインダーリストを新規作成して観測(dev プロキシ有り/無しの両方で) | ✅ 2026-07-10(proxy 経由 = `POST + X-Caldav-Method: MKCALENDAR` に変換されて到達)。⑨カレンダー作成と⑭リスト作成の 2 本を観測。ボディ(`urn:...:caldav mkcalendar` > `DAV:set/prop`)の要素: **displayname / apple:calendar-color(symbolic-color 付き)/ apple:calendar-order(整数)/ caldav:supported-calendar-component-set(カレンダー=`comp name="VEVENT"`、リマインダーリスト=`comp name="VTODO"`)/ caldav:calendar-free-busy-set(中身 `<NO/>`)/ caldav:calendar-timezone(VTIMEZONE 同梱)**。→ CalendarCollection 集約の属性設計(色/order/component-set/timezone/displayname)は実データと一致。フォールバック検証(iOS が 501 後に Extended MKCOL を打つか)は **proxy が MKCALENDAR を通してしまうため今回は観測不能** = 本作スケルトン(proxy 無し・直結)で 501 を返して要再測。**フォールバック検証 ❌ 2026-07-10(第2ラウンド)**: workers.dev 直結アカウントで新規リスト作成 → MKCALENDAR は workerd の 501 で死に(アプリ到達せず)、その後 **MKCOL は一切送られない**(キャプチャ全体で0件。home の再 PROPFIND を繰り返すのみ)。iOS 26.5 に Extended MKCOL フォールバックは存在しない → **Cloud Run 変換プロキシは恒久構成**(根治は capnproto/KJ upstream への MKCALENDAR 追加のみ)。**クライアント側キャプチャ(Proxyman iOS、2026-07-10)による裏取り**: ①生 MKCALENDAR リクエスト = `MKCALENDAR /dav/calendars/caldav-user/{新規UUID}/`(`User-Agent: iOS/26.5 (23F77) remindd/3976`、`Content-Type: text/xml`、`Authorization: Basic`、Content-Length 928)。XML ボディはサーバー側では観測不能だった原型で、`urn:...:caldav mkcalendar` > `DAV:set/prop` に displayname「追加」/ apple:calendar-color(`symbolic-color="green"` #83D754)/ supported-calendar-component-set(`comp name="VTODO"`= リマインダーリスト)/ calendar-timezone(Asia/Tokyo VTIMEZONE 同梱)/ calendar-order 3 / calendar-free-busy-set `<NO/>` を含む。②501 応答の実体 = `Server: cloudflare` / `CF-RAY` 付き・**Content-Length 0(ボディ無し)**の裸の 501 Not Implemented(workerd/Cloudflare edge が返す。CalDAV precondition XML ではない)。③501 後の iOS の挙動 = 同一 UUID への MKCALENDAR を **2 回**送信(#587 → 10ms 後 #589、2 本目は color を `symbolic-color="custom"` に変え要素順を入れ替えた別ボディ = 単純リトライではなく remindd の再構成)。両方 501 の後 **MKCOL / MKCOL 亜種は 1 件も送らず**(WD/CR 両ログ全体で MKCOL=0)、home コレクションへの PROPFIND/REPORT 再ポーリングに戻って沈黙 = ユーザー体感の「弾かれた」と一致。補足: workers.dev 直結時のみ iOS は `.well-known/caldav` を 443/`:8443`/`:8843` の 3 ポートで並行プローブ(`:8843` は 999=接続不可)、Cloud Run 経由では 443 のみ。CR ログには対応する新規リスト作成が無く(この回は PUT 1 本のイベント作成のみ)、成功パスの直接対比は取れていない |
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

### iOS のアカウント追加を阻む条件(2026-07-10 に1〜3、2026-07-11 に4を実測・修正して確認)

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
4. **207 応答は Content-Length 付きで返す(chunked だと破棄される)**(2026-07-11、
   ローカル開発環境の tunnel 経由で実測)。ローカル proxy(proxy/server.ts)が
   `response.body` ストリームをそのまま返すと Bun が Transfer-Encoding: chunked に
   再フレーミングし Content-Length が消える。応答ボディは本番とバイト単位で同一・
   ヘッダの意味的差分は CL の有無だけの状態で、iOS(accountsd/remindd/dataaccessd)は
   正しい current-user-principal を受け取りながら principal への OPTIONS に進まず、
   フォールバック探索(/ → /principals/ → /calendar/dav/{user}/user/)をループして
   「SSLに接続できません」→「アカウントが見つかりません」で失敗した。
   proxy を「全バッファ + Content-Length 明示」に修正して解消(iOS 成功実績のある
   Cloud Run 入口は GFE が CL を付けていたため本番では顕在化しなかった)。
   ユーザー向けエラーが SSL を指すのは誤誘導なので注意(TLS は正常だった)。

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

## 2026-07-12 キャプチャ第3ラウンド: VTODO/リマインダー実測(E-1 の一次資料)

方向性 E-1(chat から VTODO 読み書きする MCP ツール)の設計にあたり、iOS リマインダーの
VTODO 挙動を実測した(iOS 26.5 remindd、ローカル dev サーバー = `caldav-dev.097969.xyz` へ
CalDAV 接続、`DUMP_DAV_REQUESTS=1` でボディ採取)。**この節は「iOS リマインダーの
CalDAV 天井」を確定させる。以降 E-1/E-2 の tool 表面はこれを正とする。**

### D1. 優先度(PRIORITY)= 1/5/9(確定)

iOS UI の「低/中/高」を各1件で設定 → PUT の `PRIORITY:` 値: **低=`9` / 中=`5` / 高=`1`**。
RFC 5545 §3.8.1.9 の CUA マッピング(1-4=HIGH / 5=MEDIUM / 6-9=LOW)の端点そのもの。
**「緊急」という第4段階は存在しない**(UI にも無い)。作成時は PRIORITY 無し → 優先度設定で
**2回目の PUT に PRIORITY を追加**する2段構え(iOS の一般的な作成→属性追記パターン)。
→ create-todo は priority を 0-9 で受け、0=未設定はプロパティ省略(iOS の実データに揃える)。

### D2. フラグ・画像は CalDAV アカウントでは不可(iOS がグレーアウト・確定)

編集画面のツールバーで **日付/時刻・位置は有効(黒)、フラグ・カメラ(画像)はグレーアウト**
(押せない)。グレーアウト = iOS 自身が「このアカウント種別では非対応」と判断して無効化して
いる状態で、**サーバー側で何をしても解錠できない**(能力ネゴシエーションの余地なし)。
サブタスク・タグも同様(iCloud/CloudKit 限定)。→ **iOS 連携の天井 = 日付/時刻/位置/優先度/
繰り返し/基本 VALARM/完了**。フラグ・画像・サブタスク・タグは iOS には出せない(我々の
chat/MCP 面でだけ CATEGORIES/RELATED-TO 等として持つ拡張は将来可能だが iOS には映らない)。

### D3. iCloud リマインダー = CloudKit 同期(CalDAV 非経由・確定)

Proxyman 復号キャプチャで確認: iPhone の iCloud 宛は全て `gateway.icloud.com`(証明書
ピンニングで復号不可 = CloudKit)。`p125-caldav.icloud.com`(iCloud の CalDAV)には
iPhone からの CalDAV リクエストが**一切飛ばない**(Mac 由来の CONNECT のみ)。
→ **iCloud リマインダーのリッチ機能(タグ/サブタスク/フラグ/画像)は Apple 自身が CalDAV で
運んでいない**(CloudKit 専用)。よってサードパーティ CalDAV サーバーがそれらを iOS UI に
出せないのは構造的必然。gateway をこじ開ける価値は無い(仮に復号できても CloudKit 独自形式で
CalDAV 表現は存在しない)。

### D4. 反復 VTODO の完了モデル = マスター前進 + 完了スナップショット分離(確定)

毎週(BYDAY=SU,SA, UNTIL=20260731)の反復 VTODO を1 occurrence ずつ完了 → iOS は完了ごとに
**2つの PUT** を打つ:

1. **完了スナップショットを新 UID・新リソースで PUT**: `STATUS:COMPLETED` + `COMPLETED:<UTC>` +
   `PERCENT-COMPLETE:100`、その回の DTSTART/DUE、**RRULE を除去**、VALARM はコピー
   (fixture: `vtodo-recurring-completed-instance.ics`)。
2. **マスターを同一 UID で前進 PUT**: DTSTART/DUE を**次の occurrence へ進める**、RRULE 維持、
   STATUS を NEEDS-ACTION に戻す。マスターの DUE 推移を実証: `7/12 → 7/18 → 7/19 → 7/25 →
   7/26 → (最終 occurrence 完了でマスター自身が STATUS:COMPLETED)`
   (fixture: `vtodo-recurring-master.ics`)。

→ **RECURRENCE-ID オーバーライド方式ではない**(VEVENT の A5 とは別モデル)。単発 VTODO の
完了は3点セット(STATUS/COMPLETED/PERCENT-COMPLETE)のみ。**slice ② の CompleteTodo は
反復のとき「新 UID で完了スナップショット作成 + マスターの DTSTART/DUE 前進(無ければ
COMPLETED)」を実装する**(拒否ではなく iOS 忠実に)。

> 2026-07-13 更新(②-c 実装時の確定): 上記「最終 occurrence 完了でマスター自身が
> STATUS:COMPLETED」は iOS 実機キャプチャの記述だが、②-c の実装スコープでは
> **反復を実際に最後の occurrence まで完了させて完了リストの件数を数える実機検証は
> 未実施**(サーバー実装が iOS の観測どおりに振る舞うかの再現確認が残っている)。
> `advanceMasterToNextOccurrence`(domain/ical/semantics/vtodo-recurrence.ts)が
> exhausted を返したときは、②-c では「スナップショットを作らずマスターへ直接
> `applyCompletion`(単発完了と同じ)」を採用した — 上記の観測記述と整合する設計だが、
> 「最終回だけ完了スナップショットが作られない」という非対称さが本当に iOS の期待と
> 一致するかは、次回の実機検証項目として残す(反復 VTODO を UNTIL/COUNT の最後まで
> chat から完了させ、iOS 側の完了リストに何件表示されるかを数える)。

> 2026-07-13 追記(本番 D1 実機検証 V3・CAP-RRULE2/FREQ=DAILY で採取): iOS は反復完了で
> マスターを前進させるとき、DTSTART/DUE だけでなく **VALARM の絶対トリガー
> (`TRIGGER;VALUE=DATE-TIME:<UTC>`)も同じ絶対時間差だけ前進**させる。実測:
> 前進前マスター `DTSTART;TZID=Asia/Tokyo:20260713T010000` / VALARM
> `TRIGGER;VALUE=DATE-TIME:20260712T160000Z` → 前進後マスター
> `DTSTART;TZID=Asia/Tokyo:20260714T010000` / VALARM
> `TRIGGER;VALUE=DATE-TIME:20260713T160000Z`(ちょうど +86400 秒、DTSTART の日次前進と同じ差)。
> 一方、**完了スナップショット側の VALARM はその回の時刻のまま**(前進させない)— D4 本文の
> スナップショットは「その occurrence を切り出した単発 VTODO」なので、絶対トリガーもその
> occurrence の値を保持するのが正しい。相対トリガー(`TRIGGER;RELATED=START/END:±PT..`)は
> DTSTART/DUE に自動追随するため対象外。位置アラーム(`X-APPLE-PROXIMITY` を持つ VALARM。
> D5 参照)はダミー過去 TRIGGER のままで前進しないことも確認済み(iOS 自身が前進させていない)。
> → `advanceMasterToNextOccurrence`(domain/ical/semantics/vtodo-recurrence.ts)に
> `advanceAbsoluteAlarmTriggers` を追加してこの前進を実装(E-1 スライス②-c フォローアップ)。
> `buildCompletionSnapshot` 側は無変更(現状のまま iOS 一致)。

> 2026-07-13 追記(V2 実機で判明した別経路の欠落・上記 V3 追記とは独立): 反復完了の前進とは別に、
> **`update-todo` で単に due を動かすだけの操作でも VALARM 絶対トリガーが取り残される**ことが
> V2 実機検証で判明した(iOS ネイティブは due を変えるとアラームも一緒に動くが、それまでの
> UpdateTodo 実装は patchVTodoFields で DTSTART/DUE だけを書き換え、VALARM には触れていなかった)。
> 上記の「反復前進」も「due 変更」も本質的には同じ変換(絶対トリガーを絶対時間差ぶん shift する)
> なので、`advanceAbsoluteAlarmTriggers` を `vtodo-recurrence.ts` から `vtodo-patch.ts` の
> `shiftAbsoluteAlarmTriggers` として共有化し、`update-todo.ts` の execute() で
> `input.due` 指定時に「旧 DUE(無ければ旧 DTSTART)→ 新 due(start-of-day)」の絶対エポック差を
> shiftMs として適用するようにした(patch 直後・status 分岐より前 — 反復完了経路
> `completeRecurringTodo` に渡る `masterVtodo` にもこの shift 済みの状態が伝播する)。
> **時刻付き→終日(DATE)変換の近似(限界)**: due を「時刻付き→終日」に変える update では、
> 新 due の「インスタンス」は start-of-day を採るしかない(create/update は現状 DATE の due しか
> 生成できない既存制約と同じ)。結果アラームは「旧 due 時刻から (新 due の start-of-day − 旧 due
> の絶対時刻) だけ動いた絶対時刻」になり、iOS が実際に終日リマインダーを鳴らす時刻(ローカル既定
> 9:00 等)とは一致しない可能性がある。ロスレス・オフセット保存の一貫規則を優先した割り切りとして
> 許容する(詳細は `src/application/usecases/update-todo.ts` の `dueShiftMillis` JSDoc)。

> 2026-07-13 追記(V8 本番実機実測で確定): 248行目以降の「未確定事項」が確定した。
> **iOS は最終 occurrence もスナップショット作成 + マスター DTSTART/DUE を UNTIL 越えの
> 次の生ステップへ前進 + STATUS:COMPLETED(RRULE は UNTIL 含め維持)** という、非最終回と
> 同じ2リソースモデルで扱う。本番 D1 実機実測(反復・`FREQ=DAILY;UNTIL=20260714`・毎日・
> 終日・VALARM 無し・07-13/07-14 の2 occurrence を chat から完了 → マスター
> `DTSTART/DUE=07-15`・`RRULE:FREQ=DAILY;UNTIL=20260714`(不変)・`STATUS:COMPLETED`・
> 完了スナップショットが2件(07-13 分・07-14 分))。「最終回だけスナップショットが
> 作られない」という旧設計上の非対称さは実機と食い違っていたことが分かった。
> これを受け、`advanceMasterToNextOccurrence`(domain/ical/semantics/vtodo-recurrence.ts)を
> 「常に次の生ステップ(UNTIL/COUNT を無視した FREQ 上の次)へ前進し、境界を越えたかどうかは
> `seriesEnded` フラグで返す」契約に変更し、`completeRecurringTodo`
> (application/usecases/recurring-completion.ts)は常に2 PUT(スナップショット +
> 前進マスター)を行うよう均一化した。STATUS の決定(NEEDS-ACTION か COMPLETED か)は
> `seriesEnded` を見て呼び出し側が行う。
> **COUNT 最終回の RRULE 扱いは実機未検証の推定**: 今回実機実測できたのは UNTIL 系列のみで、
> COUNT 由来で今回が最後だった occurrence(`rrule.count <= 1`)の RRULE 書き戻しは、UNTIL 系列と
> 平仄を合わせて「count を減算せず不変に保つ」という推定を採用している(可逆な判断。
> `vtodo-recurrence.ts` の実装コメント参照)。COUNT 系列の実機実測が取れ次第、直す可能性がある。

### D5. VALARM(VTODO のアラーム)は保持可(確定)

iOS は VTODO に VALARM を付ける2形態を実測: **時刻アラーム**(`ACTION:DISPLAY` +
`TRIGGER;VALUE=DATE-TIME:<絶対 UTC>` + `X-WR-ALARMUID`。iOS は相対 TRIGGER でなく絶対時刻で送る)/
**位置アラーム**(ダミー過去 TRIGGER + `X-APPLE-PROXIMITY:ARRIVE` + `X-APPLE-STRUCTURED-LOCATION` +
`geo:`。RFC 9074 の PROXIMITY でなく Apple 独自 = A9 と一致)。我々のドメインは `vtodo.ts` の
`alarms()` で集約し X-APPLE-* を生値保持(A1 のロスレス方針)。**保持・往復は確定でできる**。
ただし「**サーバー発の**(MCP で作った)VALARM を iOS が実際に鳴らすか」は未検証(create-todo に
アラーム引数を足すときの宿題。iOS が自作項目のアラームしか鳴らさない可能性がある)。

> 2026-07-13 追記: create-todo の `alarm` 入力(offset ISO8601)から、上記の実測形式
> (`ACTION:DISPLAY` + `DESCRIPTION:Reminder` + `TRIGGER;VALUE=DATE-TIME:<絶対 UTC>` +
> `UID`/`X-WR-ALARMUID` 同値)を素直に再現する VALARM 生成を実装した
> (`src/domain/ical/semantics/vtodo-write.ts` の `VTodoFields.alarm` /
> `src/application/usecases/create-todo.ts`)。相対トリガー・複数 VALARM・位置アラームは
> 対象外(絶対時刻の DISPLAY アラーム1個のみ)。絶対 UTC トリガーのため VTIMEZONE 生成は
> 不要(時刻付き due の VTIMEZONE 問題=D11/V6 とは別スコープ)。
> **V5 実機検証(サーバー発 VALARM を iOS が実際に鳴らすか)はまだ未実施** — 手順案:
> ①`create-todo` を `alarm` に「数分後(例: 現在時刻+3分)」の offset ISO8601 を指定して呼ぶ
> (due は無しでも可 — due と alarm は独立)。②iOS 実機のリマインダーアプリで初回同期を待つ
> (B1/B2 シーケンス、通常数秒〜数十秒)。③指定時刻に通知(バナー/ロック画面)が鳴るかを
> 目視確認する。④鳴らない場合は「iOS が自作項目のアラームしか鳴らさない」仮説を検証するため、
> 同じ VTODO を iOS 側でいったん編集(タイトル変更等)してから再度 due/alarm を確認する
> (iOS 側の「所有」操作を挟むと鳴るようになるか、の比較)。

### D6. コレクションのリネーム・色変更(PROPPATCH)は対応済み(確定)

タスクリストの名前・色を iOS で変更 → **PROPPATCH が 207 Multi-Status で成功**:
リネーム=`<A:displayname>` / 色=`<D:calendar-color symbolic-color="green">#83D754</D:calendar-color>`
(iOS は6桁 `#RRGGBB` を送る。`apple-color.ts` VO は #RRGGBBAA/#RRGGBB 両対応)。
フラグ/画像と違いグレーアウトされず通る = コレクションのメタ変更は iOS 連携の対応範囲内。
処理は `UpdateCollectionProperties` UC + `app.ts:592` の PROPPATCH 経路。

### D7. ローカル D1 のマイグレーション未適用インシデント(記録)

このラウンド初回、全 PUT が `D1_ERROR: table calendar_objects has no column named
first_occurrence` で 500 になった。ローカル dev D1 に 0002(occurrence 索引)未適用が原因
(本番マイグレーションギャップ 2026-07-12 の**ローカル版**)。`make migrate-local` で 0002/0003
適用して解消。→ 教訓: 新環境/リセット後は `make migrate-local` を忘れない(本番は deploy に
組み込み済みだがローカルは手動)。

### D8. 我々が作った VTODO を iOS が編集/完了できる(往復健全性・確定・V7)

MCP `create-todo` で作った VTODO(UID d3ee8879、`DTSTART;VALUE=DATE=DUE;VALUE=DATE:20260715`、
`PRIORITY:1`、PRODID=我々の `-//gigun-dev//caldav//EN`)を iPhone で編集・完了 → iOS は我々の
ICS を**素直に読み書き**した(server→iOS→server の往復健全性を実証):

- **更新 PUT に `If-Match: "<我々のサーバーの ETag>"` を付ける**。iOS が我々の todo を読み、
  我々の ETag を受け取り、それを If-Match で返す = 我々の ETag 計算は iOS 互換。
  → slice ② の UpdateTodo/CompleteTodo は **must-match で受ける**(read→patch→If-Match PUT)。
- 我々の出力を保持: UID / SUMMARY / **DTSTART=DUE(終日)** / PRIORITY:1。編集で DESCRIPTION 追加。
  iOS は PRODID を自分のに差し替え、`CREATED`/`LAST-MODIFIED`/`X-APPLE-SORT-ORDER` を補完
  (我々は未出力だが iOS が足す = 我々の最小出力で問題なし)。
- **SEQUENCE は付けない**(iOS は todo 編集で SEQUENCE を増分しない)→ UpdateTodo も **SEQUENCE
  据え置きで iOS 準拠**。
- 完了(単発)= STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100 の3点セット(If-Match 付き)。
- 削除(V4)= iOS の DELETE は **If-Match を付けず無条件**(4件実測)→ delete-todo は ETag 条件必須にしない。

→ **create-todo の出力は iOS と完全相互運用**。DTSTART=DUE の終日表現・我々の PRODID を iOS が
問題なく受ける = `buildVTodoCalendar` の設計判断が実機で裏取りされた。**slice ②(update/complete/
delete)の仕様は実データで確定**。残る未検証は V2/V3(完了を**我々から**書いたとき iOS に反映されるか、
単発/反復)・V5(サーバー発 VALARM が鳴るか)・V6(時刻付き due の VTIMEZONE)で、いずれも
slice ② 以降のコードができてからの server→iOS 検証。

### D9. サーバー発 VTODO のプロパティ生成方針(確定・E-1 スライス②-a)

D8 で「我々の最小出力(UID/DTSTAMP/SUMMARY/DESCRIPTION/DTSTART/DUE/PRIORITY のみ)でも iOS は
問題なく読む(CREATED/LAST-MODIFIED/X-APPLE-SORT-ORDER は iOS 側が補完)」ことが実証された。
一方で MCP からの一覧・完了操作を agentic に成立させるには、サーバー自身がこれらを積極的に
生成しておく方が体験がよい(iOS 補完待ちにしない)。以下の基準で生成範囲を確定する:

**生成基準**: 「RFC 定義 + iOS 使用 + 忠実維持できる → 積極生成 / ベンダー拡張は保持のみ、ただし
意味を解読でき忠実再現できるものは生成可」(2026-07-12 ユーザー確定)。

- **全書き込み(create・update 共通)**: `LAST-MODIFIED`(§3.8.7.3)・`DTSTAMP`(§3.8.7.2)を
  操作時刻(now, UTC)で upsert する。
- **create のみ**:
  - `STATUS:NEEDS-ACTION`(§3.8.1.11 の初期値)。
  - `CREATED`(§3.8.7.1、"Date and Time of Creation")。
  - `CALSCALE:GREGORIAN`(§3.7.1、VCALENDAR プロパティ)。iOS 実機の VCALENDAR に必ず含まれる。
  - `X-APPLE-SORT-ORDER`(ベンダー拡張。RFC 定義ではないが、iOS 実機キャプチャで構造を
    実測・デコードできた — CFAbsoluteTime(2001-01-01T00:00:00Z 起点秒)= unixSeconds − 978307200。
    実測: create 2026-07-12T11:48:30Z(unix 1783856910)→ 805549710。「意味を解読でき忠実再現できる
    ベンダー拡張」の実例として積極生成の対象に含める)。
- **完了のみ**(②-c で使用予定): `COMPLETED`(§3.8.2.1、"the value MUST be specified as a date
  with UTC time" — UTC DATE-TIME MUST)・`PERCENT-COMPLETE:100`(§3.8.1.8)。
- **生成しない**: `SEQUENCE`(§3.8.7.4)。D8 の実測どおり iOS は todo 編集で SEQUENCE を増分せず、
  我々も付けない(付けないことで iOS 挙動と揃う)。SEQUENCE 管理はスケジューリング(方向性 B、
  RFC 6638/5546)に必要になった段階で導入する。
- **update は保持(ロスレス)**: `CREATED`・`X-APPLE-SORT-ORDER`(共に「作成時点」の情報)と、
  この UC が関知しない未指定プロパティ(VALARM・X-APPLE-* 等)には触らない。CREATED を更新の
  たびに今へ書き換えるのは「作成日時」という意味を壊す。

実装は `src/domain/ical/semantics/vtodo-stamp.ts`(`stampCreate`/`stampUpdate`)に一本化し、
生成プロパティの「何を・いつ触るか」の判断がユースケースごとに分散しないようにする。

### D10. サーバー発の反復 VTODO 生成方針(確定・タスク③)

D4(反復 VTODO の完了 = マスター前進 + 完了スナップショット分離)はこれまで「iOS 実機が
送ってきた反復マスター」に対してのみ動いていた(complete-todo.test.ts は real-ios フィクスチャ
経由)。タスク③では chat から「毎日/毎週〜」のようにゼロから反復リマインダーを作れるように
`create-todo` に `recurrence` 入力を追加した。この節はその生成方針を記録する。

- **until は DATE 型で出す(DTSTART と値型を揃える)**。根拠は RFC 5545 原文
  `docs/rfc/rfc5545.txt` §3.3.10(2255〜2266行付近):
  > The value of the UNTIL rule part MUST have the same value type as the "DTSTART"
  > property. ... if the "DTSTART" property is specified as a date with local time,
  > then the UNTIL rule part MUST also be specified as a date with local time. ...
  > the UNTIL rule part MUST be specified as a date with UTC time.
  我々の `buildVTodoCalendar` は due 指定時に DTSTART を常に `VALUE=DATE` で立てる
  (D9 以前からの iOS 実機キャプチャ準拠の方針)。よって RRULE の UNTIL も DATE 型に固定する
  ことで値型不一致(update-todo.ts で先に踏んだ同種の罠 = values/recurrence-rule.ts の I6 の
  不変条件)を最初から作らない設計にした(MCP 入力の `until` は "YYYY-MM-DD" のみを受け付け、
  DATE-TIME 版の UNTIL を選べる余地自体を無くしてある)。
- **VALARM はサーバー発では生成しない**。反復であっても単発の CreateTodo と同じ方針
  (D9 のスコープどおり。サーバー発アラームの実機挙動は未検証のため踏み込まない)。
- **weekdays(BYDAY 序数無し)は weekly 主用途に限定**。RFC 上 monthly/yearly も BYDAY を
  持てるが、序数付き BYDAY(2MO 等)としての用法であり、序数無し BYDAY を monthly/yearly に
  付けたときの意味は仕様上曖昧(recurrence-rule.ts の I 系検証も序数付き BYDAY だけを
  monthly/yearly 限定にしている=序数無し BYDAY は素通りする)。chat からのゼロ知識入力で
  この曖昧さを黙って解釈するより安全側(誤反復パターンを黙って作るより失敗させる)を選び、
  weekly 以外に weekdays を指定したら `RecurrenceWeekdaysRequireWeeklyError` で明示的に拒否する
  (application/usecases/create-todo.ts)。monthly/yearly の曜日指定が必要になったら、そのとき
  専用の入力語彙(序数付き)を別途設計する。
- **recurrence は due 必須**。RRULE は DTSTART をアンカーにする(§3.8.5.3)。我々の実装は
  due がそのまま DTSTART/DUE の値になるため、due 無しに RRULE だけを立てることができない。
  `RecurrenceRequiresDueError` で application 層が本線として弾き、
  `buildVTodoCalendar`(domain 層)側にも同じ契約の防御的 throw を置いた(呼び出し側のバグを
  捕まえる最終防衛線。二重防御の設計判断は他の防御的 throw と同じ扱い)。
- **反復完了は「我々が作ったマスター」でも成立する**ことを e2e 的に確認した
  (test/application/create-todo.test.ts「反復付き create → complete-todo」)。D4 の実装
  (recurring-completion.ts)は元データが iOS 発か我々発かを区別せず RRULE の有無だけで
  分岐するため、当然の帰結ではあるが回帰確認として明示的にテストしておく。

### D11. 単発 VTODO の occurrence bounds 不整合 / 反復 VTODO due 変更の UNTIL 型不一致(修正・2026-07-13)

本番実測(単発終日 VTODO: DTSTART=DUE=2026-12-23, CREATED=2026-07-12。「時刻付き due で
作成→update-todo で due を終日に変更」という経緯)で D1 索引列 first_occurrence が
CREATED 相当(07-12)になっていた。RFC 4791 §9.9 の VTODO 実効値表(`docs/rfc/rfc4791.txt`
L5104-5137)を原文で読み直すと、CREATED/COMPLETED は DTSTART・DUE がどちらも無い行にしか
登場しない — occurrence-bounds.ts の旧実装(存在するプロパティ全部の min/max を取る)は
表の行の優先順位を無視して CREATED を無条件候補に混ぜており、これは表と食い違う実装
バグと判断した。表の行ごとに一意に決める実装に直した(`computeVTodoBounds`)。
単発なら first=last=DUE(DTSTART も同時にあれば同じ扱い、DUE 単独/DTSTART 単独は退化点)
になり、CREATED 単独のみのケースは条件式が `end > CREATED` で上限が無いため
`last=OCCURRENCE_INDEX_MAX`(VEVENT の無限反復と同じ扱い)にした。

同じ「due 変更」経路で D10 が予告していた罠(update-todo.ts で先に踏んだ同種の罠)も
実際に発生を確認した: iOS 発の反復マスター(DTSTART;TZID=...(DATE-TIME) +
RRULE UNTIL=...Z(DATE-TIME))の due を chat 経由で終日(DATE)に変更すると、
`patchVTodoFields` が DTSTART/DUE を DATE にする一方 RRULE の UNTIL は DATE-TIME のまま
残り、PutCalendarObject の事前条件 I6(§3.3.10 UNTIL 値型一致 MUST)違反で 412 相当の
エラーになっていた。`vtodo-patch.ts` に `untilToDateIfNeeded`(due 分岐の直後にのみ呼ぶ
内部ヘルパー)を追加し、RRULE があり UNTIL が DATE-TIME なら日付部分だけ残して DATE 化
するようにした(RRULE 無し/UNTIL 無し/既に DATE なら不変)。create 側の
`buildVTodoCalendar` が最初から UNTIL を DATE で出す方針(D10)と対称になるよう、
domain/semantics 層(patchVTodoFields と同じファイル)に置いた — application 層
(update-todo.ts)に置くと「DTSTART が DATE なら UNTIL も揃える」という I6 由来の
domain 制約の知識が application 層に漏れてしまうため。

## 結果の還元先

- **フィクスチャ**: A1〜A5 のキャプチャ ICS を `test/domain/ical/fixtures/` に実データとして
  追加(既存の再現データは残す — 由来をファイル冒頭コメントに書き分ける)。
- **図**: 覆った仮定は 03(不変条件・注記)/ 05(細則)を先に修正 → コード・コメントの順。
- **B2 の実測リスト**: CalDAV リソース層の PROPFIND 実装(presentation のマッピング表)の
  一次資料にする。
- 各項目の結果はこの表の「結果」列に日付付きで記録する(検証済みの証跡を残す)。
