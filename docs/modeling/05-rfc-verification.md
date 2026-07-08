# RFC 原文照合の記録(2026-07-08)

> 03-domain-model.md などの主張を RFC 原文(rfc-editor.org)と突き合わせた検証パスの記録。
> 初版のモデリングは AI の学習済み知識ベースだったため、原文照合で裏取り・訂正を行った。
> 訂正は各図に反映済み。ここには「検証済みであること」と「図に書ききれない細則」を残す。

## 検証サマリー

| RFC | 照合した主張 | 判定 |
|-----|------------|------|
| 5545 (iCalendar) | 16件 | 正 13 / ニュアンス訂正 3(下記) |
| 4791 (CalDAV) | 11件 | 正 9 / 不正確 2(下記) |
| 6578 (sync-collection) | 7件 | 正 5 / 訂正 2 |
| 6764 / 5397 (探索) | 4件 | 正 3 / 訂正 1 |
| 7986 (拡張プロパティ) | 調査 | iOS 対応には不要と確定(下記) |

## 訂正された主張(図に反映済み)

1. **sync-token は有効な URI であることが MUST**(RFC 6578 §3.2, §6.2)。
   「不透明な文字列なら何でもよい」は誤り。前作 hono-caldav の整数カウンタは厳密には違反。
   内部は整数カウンタでよいが、公開形式は `https://…/ns/sync/{n}` 等の URI にする。
2. **削除メンバーは 404**(RFC 6578 §3.2 Marshalling)。前作の 410 は誤りと原文で確定。
3. **初回同期 = 空の DAV:sync-token 要素**(§3.4)。要素の省略は不正(要素自体は必須)。
4. **UNTIL は DTSTART と同値型 MUST + DTSTART が UTC/TZID 付きなら UNTIL は UTC 形式 MUST**
   (RFC 5545 §3.3.10)。TZID 付き UNTIL は存在しない。
5. **DTEND/DUE の値型は DTSTART と一致 MUST(SHOULD ではない)+ DTEND は DTSTART より後 MUST**
   (§3.8.2.2/§3.8.2.3)。同時刻も不可。
6. **VTIMEZONE は STANDARD か DAYLIGHT の少なくとも1つ**(両方必須ではない)(§3.6.5)。
7. **SEQUENCE の増加は「significant revision」ごと**(§3.8.7.4)。全改訂ではない。
   繰り返しインスタンスごとに異なる SEQUENCE を持ちうる。
8. **「リソース = VCALENDAR 1つ」の明文は RFC 4791 §4.1 にない**(§9.6 の calendar-data 定義から
   暗黙に単数)。実装として強制するのは妥当だが、根拠の引用は §9.6 とする。
9. **カレンダーコレクションのネスト禁止は「直下」ではなく「任意の深さ」**(§4.2 b)。
10. **well-known のリダイレクトは 301 限定ではない**(RFC 6764 §5: "e.g., 301, 303, or 307")。

## 新たに判明した不変条件・細則(重要度順)

### CalDAV (RFC 4791)

- **カレンダーオブジェクトリソースは METHOD プロパティを含んでは MUST NOT**(§4.1)。
  → 不変条件 R7 として図に追加。iTIP メッセージ(METHOD 付き)は通常コレクションに入らない。
- **no-uid-conflict は「別 UID での上書き」も禁止**(§5.3.2.1)。PUT 更新時に UID 変更不可。
  エラー時は使用中リソースの URL を DAV:href で返す SHOULD。
- **PUT の precondition は全11個**(§5.3.2.1): supported-calendar-data / valid-calendar-data /
  valid-calendar-object-resource / supported-calendar-component / no-uid-conflict /
  calendar-collection-location-ok / max-resource-size / min-date-time / max-date-time /
  max-instances / max-attendees-per-instance。違反は 403 or 409 + DAV:error 直下に該当要素(§1.3)。
- **ETag**: 全リソースで強い ETag MUST(§5.3.4)。PUT 応答での ETag 返却は「格納データが
  送信ボディとオクテット等価」の場合のみ SHOULD。**サーバーがデータを書き換えたら返しては MUST NOT**。
  → ロスレス往復設計なら常に返せる。書き換えない設計の実利的根拠がここにもある。
- **calendar-data は WebDAV プロパティではない**(§9.6)。PROPFIND で返してはならず、REPORT 応答のみ。
- **calendar-multiget では Depth ヘッダを MUST 無視**(§7.9)。calendar-query は省略時 Depth:0。
- **OPTIONS の DAV ヘッダに `calendar-access` を MUST**(§5.1)。
- **text-match の照合は i;ascii-casemap と i;octet が MUST**(§7.5)。
- **X- 拡張(非標準コンポーネント/プロパティ/パラメータ)の格納は MUST サポート**(§5.3.3)。
  → ロスレス往復は設計趣味ではなく RFC の要求。
- **新規作成の作法**(§5.3.2): 未マップ URI への PUT。クライアントは If-None-Match: * を SHOULD。
  リソース URL 名と UID の一致は要求されない。
- **calendar-timezone プロパティ**(§5.2.2): floating/DATE 値の time-range 判定に使う既定 TZ。
- getcontenttype への言及は RFC 4791 には皆無(text/calendar は §2/§5.2.4 由来の慣行)。

### iCalendar (RFC 5545)

- **行折り畳み**(§3.1): 75オクテット超は CRLF+WSP で折る SHOULD、パースは「まず unfold MUST」。
  UTF-8 マルチバイト境界で折られたデータの復元に注意。行区切りは CRLF。
- **生成時 FREQ は RECUR 値の先頭 MUST**(受理は順不同 MUST)(§3.3.10)。
- **DATE 型 DTSTART のとき BYSECOND/BYMINUTE/BYHOUR は MUST NOT**(違反時は無視 MUST)。
- **COUNT は DTSTART を1回目として数える**。DTSTART は常に recurrence set の第一インスタンス
  (RRULE パターン外の DTSTART は結果 undefined)。EXDATE で DTSTART を除外しても
  DTSTART 自体は維持 MUST(RECURRENCE-ID の基準のため)。
- **DATE 型イベントの DURATION は日/週単位のみ**(§3.6.1)。デフォルト期間: DATE 型で
  DTEND/DURATION 無し→1日、DATE-TIME 型で無し→長さ0。
- **DURATION 値の週(W)は日時分秒と併用不可**。ISO 8601 の年月指定子は非サポート(§3.3.6)。
- **RDATE は PERIOD 値型も可**(インスタンス個別の期間上書き)。EXDATE が優先。重複は1つに統合。
- **RECURRENCE-ID は DTSTART と値型・形態(floating/UTC/TZID)一致 MUST**(§3.8.4.4)。
  RANGE の値は THISANDFUTURE のみ(THISANDPRIOR は RFC 5545 で廃止)。
- **TZID パラメータは UTC 値(Z付き)と DATE 型に付けては MUST NOT**(§3.2.19/§3.3.5)。
  UTC オフセット形式(`19980119T230000-0800`)は MUST NOT。
- **DTSTAMP は UTC 必須**(§3.8.7.2)。METHOD 有無で意味が変わる(iTIP送信時刻 vs 最終改訂時刻)。
- **VALARM**: DISPLAY は DESCRIPTION 必須、EMAIL は DESCRIPTION+SUMMARY+ATTENDEE 必須。
  DURATION/REPEAT は片方あれば両方 MUST。TRIGGER;VALUE=DATE-TIME は UTC 必須。
- **STANDARD/DAYLIGHT の必須プロパティ**: DTSTART / TZOFFSETTO / TZOFFSETFROM(§3.6.5)。
  この中の UNTIL は常に UTC。
- **複数 RRULE は結果 undefined**(SHOULD NOT)(§3.8.5.3)。
- **TEXT エスケープ**: `\\ \; \, \n \N`(大文字N可)。COLON はエスケープ SHALL NOT(§3.3.11)。
- **未知の X-/IANA コンポーネントは無視 MUST だが黙って捨てる SHOULD NOT**(§3.6)。
- 名前(プロパティ名・パラメータ名・列挙値)は case-insensitive、他の値は case-sensitive(§3.1)。
- うるう秒(秒=60)は正のうるう秒のみ有効。非対応実装は 59 と等価に解釈 SHOULD。

### sync-collection (RFC 6578)

- **Depth ヘッダは "0" のみ**(それ以外 400)。深さ制御は sync-level(1 / infinite)で行う(§3.2/§3.3)。
- **結果打ち切り**: 207 の中で request-URI に 507 + number-of-matches-within-limits(SHOULD)。
  打ち切り時の sync-token は「部分集合まで」を表す正しい値 MUST(=ページング可能)(§3.6)。
  クライアント指定 limit を守れないなら number-of-matches-within-limits postcondition で失敗 MUST(§3.7)。
- **同期間隔内に追加→削除されたメンバーは removed として報告 MUST**(§3.5)。
- コレクション自体が削除された場合、中のメンバーの削除は報告 MUST NOT(§3.5)。
- ACL でアクセスを失ったメンバーは removed 扱い MAY(§3.5)。
- **DAV:sync-token はコレクションのプロパティとしても定義**(§4)。クライアントは PROPFIND で
  ctag 代わりに取得できる。If ヘッダの state token としても使用可(§5)。
- 無効トークン時の valid-sync-token precondition に HTTP ステータスの明記はない
  (403 + DAV:error は RFC 4918 §16 由来の実装慣行)。トークン無効化は「絶対に必要な時だけ」MUST。
- supported-report-set への掲載は MUST(§3.1)。

### 探索 (RFC 6764 / 5397)

- well-known へのアクセスに認証(401)を要求してよい(MAY)。
  current-user-principal を返す PROPFIND は認証を強制 MUST(§7)。
- リダイレクト応答には Cache-Control を設定 SHOULD。
- 未認証時の current-user-principal は DAV:unauthenticated 擬似プリンシパル MUST(RFC 5397 §3)。
- 同一ユーザーに複数 principal がある場合、一貫して同じ URI を返す SHOULD。

### RFC 7986 と Apple 拡張(iOS 対応の結論)

- **RFC 7986 は iOS 対応に不要**。iOS が使うのは WebDAV プロパティの
  `{DAV:}displayname` / `{http://apple.com/ns/ical/}calendar-color`(**#RRGGBBAA hex**)/
  `calendar-order`(macOS)であり、RFC 7986 の COLOR(CSS3 色名の iCalendar プロパティ)や
  NAME は参照しない。レイヤーも値形式も別物。
- iOS がコレクションに PROPFIND してくるプロパティ(sabre/dav ドキュメント):
  displayname / calendar-description / getctag / apple:calendar-color /
  supported-calendar-component-set / resourcetype / **current-user-privilege-set**。
- **落とし穴**: Apple クライアントはプリセット色選択時に `symbolic-color="green"` のような
  XML 属性付きで calendar-color を PROPPATCH してくる。属性を含めて素朴に別プロパティ扱いすると
  色がリセットされるバグになる(Stalwart #1611 で実例)。値の #RRGGBBAA だけ保存し属性は捨てるか
  そのまま保持して返すこと。
