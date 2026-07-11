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
3. **初回同期 = 空の DAV:sync-token 要素**(要素自体の必須性は §3.2 Marshalling と §6.1 DTD、
   空要素時の「全件返す」動作は §3.4)。要素の省略は不正。
   <!-- 2026-07-09 原文再照合: 当初 §3.4 のみ引用していたが、「省略不可」の根拠は §3.2/§6.1。 -->
4. **UNTIL は DTSTART と同値型 MUST + 形態も DTSTART に従う**(RFC 5545 §3.3.10):
   ① DTSTART が DATE なら UNTIL も DATE、② **floating DATE-TIME なら UNTIL も floating
   DATE-TIME**、③ UTC または TZID 付き DATE-TIME なら UNTIL は UTC 形式。
   TZID 付き UNTIL は存在しない。
   <!-- 2026-07-09 原文再照合で発見: 当初②の floating ケースが抜けており、「DATE か UTC のみ」
        と誤読できる記述だった。この誤りがコード(parseUntil の floating 拒否)に転写されていた
        実例 — docs/rfc/ 常備の動機。 -->
5. **DTEND/DUE の値型は DTSTART と一致 MUST(SHOULD ではない)+ DTEND は DTSTART より後 MUST**
   (§3.8.2.2/§3.8.2.3)。同時刻も不可。
   <!-- 2026-07-08 レビュー時に発見・追記: DUE も DTSTART より後 MUST。§3.8.2.3 は
        "its value MUST be later in time than the value of the DTSTART property" と明記しており、
        DTEND(§3.8.2.2)と同じ「後 MUST」要求が DUE にもある。当初この訂正5は DTEND のみ言及していた。
        なお「値型一致」は VALUE 型(DATE/DATE-TIME)のみ MUST であって形態(floating/utc/zoned+tzid)一致まで
        縛るのは RECURRENCE-ID だけ(§3.8.4.4・下記75行)。DUE/DTEND は値型一致のみ。 -->
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
  エラー時は使用中リソースの URL を DAV:href で返す SHOULD
  (この SHOULD の原文は「同一 UID を既に使っているリソース」の URL を指す。
  「別 UID での上書き」違反時に何を href で返すかは原文に明言なし — 2026-07-09 再照合で注記)。
- **§5.3.2.1 の precondition は計11個、うち PUT に適用されるのは10個**: supported-calendar-data /
  valid-calendar-data / valid-calendar-object-resource / supported-calendar-component /
  no-uid-conflict / max-resource-size / min-date-time / max-date-time /
  max-instances / max-attendees-per-instance。違反は 403 or 409 + DAV:error 直下に該当要素(§1.3)。
  <!-- 2026-07-09 原文再照合で訂正: 当初「PUT の precondition は全11個」としていたが、
       calendar-collection-location-ok は「COPY/MOVE で Request-URI がカレンダーコレクション
       自体のとき」専用(原文: "In a COPY or MOVE request..." )で PUT には適用されない。
       §5.3.2.1 の表題が "for PUT, COPY, and MOVE" なので混同した。 -->
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
- **RECURRENCE-ID は DTSTART と値型一致 MUST + floating ⇔ floating の相互一致 MUST**(§3.8.4.4)。
  RANGE の値は THISANDFUTURE のみ(THISANDPRIOR は RFC 5545 で廃止)。
  <!-- 2026-07-09 原文再照合で精密化: 明示 MUST は「値型一致」と「floating iff floating」の2点のみ。
       「UTC ⇔ UTC」「TZID ⇔ TZID」の形態一致は明文の MUST ではない(ただし RECURRENCE-ID の値は
       対象 occurrence の DTSTART 原値なので実務上は形態も一致する)。検証実装は明示 MUST の
       2点だけを違反として扱い、utc/zoned の混在は許容すること。 -->
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
- コレクション自体が削除された場合、中のメンバーの削除は報告 MUST NOT
  (**sync-level=infinite のときの規定**。§3.5.2 — 2026-07-09 再照合で条件を補記)。
- ACL でアクセスを失ったメンバーは removed 扱い MAY(§3.5)。
- **DAV:sync-token はコレクションのプロパティとしても定義**(§4)。クライアントは PROPFIND で
  ctag 代わりに取得できる。If ヘッダの state token としても使用可(§5)。
- 無効トークン時の valid-sync-token precondition に HTTP ステータスの明記はない
  (403 + DAV:error は RFC 4918 §16 由来の実装慣行)。トークン無効化は「絶対に必要な時だけ」MUST。
- supported-report-set への掲載は MUST(§3.2。<!-- 2026-07-09 再照合: 当初 §3.1 と誤引用 -->)。

### 探索 (RFC 6764 / 5397)

- well-known へのアクセスに認証(401)を要求してよい(MAY)。
  current-user-principal を返す PROPFIND は認証を強制 MUST(§7)。
- リダイレクト応答には Cache-Control を設定 SHOULD。
- 未認証時の current-user-principal は DAV:unauthenticated 擬似プリンシパル MUST(RFC 5397 §3)。
- 同一ユーザーに複数 principal がある場合、一貫して同じ URI を返す SHOULD。

### RFC 7986 と Apple 拡張(iOS 対応の結論)

<!-- 2026-07-09 訂正(レビュー指摘・原文照合済み): 初版の「RFC 7986 は iOS 対応に不要」は
     断定が過剰だった。正確には「iOS のカレンダー一覧の色・名前は WebDAV プロパティ経由であり
     RFC 7986 の COLOR/NAME を参照しない」が確認済みなだけで、RFC 7986 全体の要否は別問題。 -->
- **RFC 7986 のスコープ**(§5/§6 原文照合済み): プロパティは11個 —
  VCALENDAR レベルのメタデータ(NAME / DESCRIPTION / UID / LAST-MODIFIED / URL /
  CATEGORIES / REFRESH-INTERVAL / SOURCE。後ろ5つは RFC 5545 既存プロパティの適用範囲拡張)+
  COLOR / IMAGE(VCALENDAR, VEVENT, VTODO, VJOURNAL)+ CONFERENCE(VEVENT, VTODO)。
  パラメータは4個 — DISPLAY(IMAGE 用: BADGE/GRAPHIC/FULLSIZE/THUMBNAIL)/
  EMAIL(ORGANIZER・ATTENDEE 用)/ FEATURE(CONFERENCE 用: AUDIO/CHAT/FEED/MODERATOR/
  PHONE/SCREEN/VIDEO)/ LABEL(CONFERENCE 用)。
  - 細則: IMAGE・CONFERENCE は複数出現可(全インスタンス往復保持のこと)。
    VCALENDAR の UID には「ユーザー・ホスト等のプライバシー情報を含めては MUST NOT」の追加制約。
- **iOS のカレンダー一覧色・名前は RFC 7986 を使わない**(ここは初版どおり)。iOS が使うのは
  WebDAV プロパティの `{DAV:}displayname` /
  `{http://apple.com/ns/ical/}calendar-color`(**#RRGGBBAA hex**)/ `calendar-order`(macOS)
  であり、RFC 7986 の COLOR(CSS3 色名の iCalendar プロパティ)や NAME は参照しない。
  レイヤーも値形式も別物。
- **本プロジェクトでの方針**: RFC 7986 プロパティは汎用構造(生値保持)によりすでに
  ロスレス往復される(専用実装は不要)。semantics 層の型付きアクセサは必要になった時点で追加する。
  CONFERENCE / IMAGE / EMAIL パラメータは Apple Calendar の体験(会議リンク表示等)にも
  関わりうるため「iOS 対応に不要」とは断定しない。
- iOS がコレクションに PROPFIND してくるプロパティ(sabre/dav ドキュメント):
  displayname / calendar-description / getctag / apple:calendar-color /
  supported-calendar-component-set / resourcetype / **current-user-privilege-set**。
- **落とし穴**: Apple クライアントはプリセット色選択時に `symbolic-color="green"` のような
  XML 属性付きで calendar-color を PROPPATCH してくる。属性を含めて素朴に別プロパティ扱いすると
  色がリセットされるバグになる(Stalwart #1611 で実例)。値の #RRGGBBAA だけ保存し属性は捨てるか
  そのまま保持して返すこと。

## J-3: ical-tasks draft-17 / RFC 9253 の照合(2026-07-11)

方向性 J のプロパティ先取り(型付き読み取りアクセサ、vtodo.ts)にあたり原文照合。
**Fable 設計メモの想定を原文が複数訂正した**(学習知識で断定しない規律が効いた例)。詳細は
各アクセサの JSDoc(コードの近くに配置。CLAUDE.md 方針)、ここは照合結果の索引:

- **SUBSTATE / REASON は VTODO 直下のプロパティではない**(draft-ietf-calext-ical-tasks-17
  §10.2/§10.3)。**VSTATUS サブコンポーネント**(§12.1、任意コンポーネントに複数指定可)内の
  プロパティ。実装は先頭 VSTATUS を読むプレビュー(履歴全件集約は将来)。
- **REASON の値型は URI**(§10.2)。設計メモは TEXT を仮定していたが訂正。生値返しなので挙動は不変。
- **ESTIMATED-DURATION は VTODO 直下**・値型 DURATION(§10.1)。parseDurationValue 再利用。
- **SUBSTATE の値型は TEXT**(OK/ERROR/SUSPENDED 例示の iana-token 拡張可。§10.3)。union 化しない。
- **STATUS の PENDING/FAILED**(§11.2 / §15.3 registry)は現行 string アクセサで既に受かる。
- **DEPENDS-ON は独立プロパティではない**(RFC 9253 §5/§9.1)。`RELATED-TO;RELTYPE=DEPENDS-ON:<値>`
  の形。dependsOn() は RELATED-TO を RELTYPE でフィルタ。既定値型は UID。
- **GAP は RELATED-TO のパラメータ**(§6.2、DEPENDS-ON 専用ではない)。値型 dur-value(符号あり)。
- **REFID は反復プロパティ**(§8.3、0 回以上)。1プロパティ複数値ではなく allProps で全件。
- **CONCEPT / LINK**(§8.1/§8.2)は型付きアクセサ未実装(生値保持で往復のみ)。使う入口が決まってから。
- RELATED-TO の既定 RELTYPE は PARENT(RFC 5545 §3.8.4.5 / RFC 9253 §9.1 踏襲)。
