# 次セッション詳細カタログ: CalDAV / iOS

> `docs/next-directions.md` の頭から分離した詳細カタログ。RFC適合とAppleクライアント検証の
> 未完了課題を計画ごと保持する。現在の完了・未完了判定と着手順は、常に頭を正とする。
> RFCの主張を更新するときは `docs/rfc/` 原文と対応する modeling を先に照合する。

> **2026-09-06 更新:** 是正5件は e905642 までの本番反映対象として扱う。well-known の301 +
> `no-cache` は本番確認済みで、残り4件の本番挙動確認は未実施。以下の「deploy前」表記は、
> 実装直後の時点を保存した履歴であり、現況は `docs/next-directions.md` の頭を参照する。

## CalDAV プロトコル適合(2026-08-01 是正5件 + 未着手課題)

**是正5件(実装済み・本番反映済み。実装時点の `make check` は bun 1105 / worker 42)**:
(a) 未対応 REPORT の応答を 404 → **403 + `<DAV:error><DAV:supported-report/></DAV:error>`**(RFC 3253 §3.6/§1.6 を
原文照合。`docs/rfc/rfc3253.txt` を新規スナップショット追加)(b) `principal-search-property-set` REPORT を実装
(RFC 3744 §9.5。200 で返す。`principal-property-search` 未実装のため空集合で返す判断)(c) `.well-known/caldav` の
301 に `Cache-Control: no-cache`(RFC 6764 §5 の SHOULD)(d) **【重要】404 propstat のプロパティ名が壊れていた
バグを修正** — 要求された名前空間が全部 `DAV:` に潰れ大文字が小文字化されていた(例 `{apple-ical}calendar-color`
→ `<d:calendar-color/>`、`{caldav}schedule-default-calendar-URL` → `<d:schedule-default-calendar-url/>`)。
5名前空間すべて・principal/home/collection すべて・PROPFIND と REPORT の両方で再現(RFC 4918 §14.22 違反。
200 propstat 側は正しく 404 側だけが別経路で名前を組み立てていたのが原因)。**iOS 26.5 は現状これを許容している
(実測)ので「証明された iOS 破壊」ではなく仕様違反 + 潜在リスクという扱い。** (e) `valid-sync-token` の名前空間を
CalDAV → `DAV:` に修正(RFC 6578 §3.2)。

**本番確認の残り4件(未実施)**: 既存アカウントが古い 301(`no-cache` 無し版)をキャッシュ済みの可能性 /
principal への PROPFIND で `supported-report-set` が 404 propstat → 200 propstat に変わる(挙動が変化する箇所)。

**調査手法(確立・今後も使える)**: Apple 公式リファレンス実装
`/Users/gigun/ghq/github.com/apple/ccs-calendarserver` の `simplugin/caldavclient.py`(Apple 自身が「実クライアントは
こう動く」とモデル化した負荷シミュレータ・リクエストボディ 78 本)を棚卸しし、約 45 本を本番へ実際に当てる総当たり。

**検出した未着手課題(2026-08-01・次の着手候補)**:
1. `expand-property` / `principal-property-search` / `calendarserver-principal-search` が principal で 404
   (principal ルートに REPORT ハンドラが無い)。**`expand-property` は OS X が毎回のポーリングで投げる経路。**
2. PROPPATCH の未対応プロパティ応答に status も propstat も無い(RFC 4918 §14.24 の DTD 違反)。
3. `Depth: infinity` を黙って Depth 0 扱いして 207 を返す(RFC 4918 §9.1 の SHOULD は 403 + `propfind-finite-depth`)。
4. calendar-home への `sync-collection` が 404。
5. **sync token にリクエストホストが埋まっており、入口(workers.dev / Cloud Run)を変えると全同期が走る**
   (データ喪失はしないが full resync コストが発生)。
6. `.well-known/caldav/`(末尾スラッシュ)が 404。Apple のモデルはこの形を使う(iOS 26.5 はスラッシュ無しなので低優先)。
7. object 宛 `calendar-multiget` が 405(RFC 4791 §7.9 は object 宛も対象と明記)。
8. **200 propstat 側の照合が名前空間を見ていない**(`<foo:calendar-home-set xmlns:foo="urn:bogus"/>` を要求すると
   CalDAV の値が 200 で返る)。直すには props Record のキーを (ns, local) 対に変える必要があり全プロパティ定義に
   波及する = **別タスク相当**(1〜7 とは規模が違うので分けて起票する)。

## iOS / Simulator 検証

- **初回アカウント追加バグの切り分け(2026-08-01・サーバー無罪で確定)**: まっさらな Simulator では CalDAV
  アカウントの初回追加が必ず失敗する(iOS 側の挙動)。ユーザー追加アカウントが1つも無い端末では、サーバー検証は
  通るのに「カレンダー/リマインダー」トグル一覧が空になり、保存するとデータクラス0個の「停止中」になる。
  **他社サーバー(Vikunja のデモ)でも再現**したことで切り分け完了(7月の実機検証は既存アカウントが1つ以上ある
  端末だったので一度も当たらなかった)。
- **回避策(実測で確定)**: `xcrun simctl openurl <UDID> 'webcal://<公開ics のURL>'` で**照会カレンダーを先に1つ
  入れる**(4タップ・テキスト入力ゼロ)と CalDAV の初回追加が通る。端末を温めるのに CalDAV である必要はなく型の
  違う `SubscribedCalendar` で足りる(**システム管理の `HolidayCalDaemonAccount` では温まらず、ユーザー追加の照会
  カレンダーで温まった**ことを `sqlite3` で直接確認)。**`.mobileconfig` はアカウント投入に使えない**ことも確定
  (アカウント系ペイロード全般が Simulator でアカウントを作らない。CalDAV 固有ですらない)。種デバイス
  `CalDAV-Seed-webcal` を残置 — 以後 `xcrun simctl clone` で **16.7秒・0タップ**で CalDAV 付き端末が複製できる。
  詳細は `docs/modeling/06-ios-behavior-verification.md`。
- **iOS 実機検証の残項目(ユーザー作業)**: カード内操作の目視(キーボード出現 / コピー / agenda ラベル /
  C4 編集 / リスト選択 / 月ビュー・日ビューのセル比率と月送り体感)/ geo 無しイベントの iOS 表示(LOCATION の
  `title\naddress` 改行形式)/ search-location 経由の場所付き予定作成の一気通貫 / 移動時間・通知の表示 /
  J-4 の calendar・tasks 非回帰(allprop sync-token 除外の念押し込み)。
- **R2 由来の iOS 検証項目**: 同一 URI の changed 再出現時の再取得挙動 / 同一 ETag 再出現時のキャッシュスキップ
  (問題があれば SEQUENCE / DTSTAMP で ETag を変える逃げ道)/ restore 後の再スキャン発火。
- **カード内 swipe 削除の UI 経路は未検証のまま**(todos 詳細に削除ボタンは無く swipe のみ・browser では touch
  swipe を再現できない。免除トークンのサーバー契約は mcp-server.test.ts で検証済み)。
