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
  <!-- 2026-08-01: この SHOULD は 2026-07-08 に記録されていたが実装されておらず(Cache-Control 無しの 301)、
       実測で発覚して修正した。採用値(no-cache)と判断根拠は末尾の「未対応 REPORT の返し方 と
       .well-known の Cache-Control(2026-08-01)」§③ を参照。 -->
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

## R-3: RFC 6578 §5(If ヘッダの DAV:sync-token)の照合(2026-07-14)

`docs/rfc/rfc6578.txt` §5「Servers MUST support use of DAV:sync-token values in If
request headers」を対象に実装。原文照合結果:

- §5「WebDAV provides an If precondition header ... as defined in Section 10.4 of
  [RFC4918]. This specification allows the DAV:sync-token value to be used as one such
  token in an If header.」— sync-token は RFC 4918 §10.4 の **State-token** として使える、
  という以上の独自構文追加は無い(§6 の XML Element Definitions にも If ヘッダ専用の
  追加要素は無し)。
- §5.1/§5.2 の例(PUT/MKCOL)はどちらも **Tagged-list + Resource_Tag**(sync-token が
  定義されているのはコレクションであり、PUT の対象リソース〈newresource.txt〉とは別のため、
  「その State-token がどの資源を指すか」を明示する Resource-Tag 構文が必須)。No-tag-list の
  例は無い。
- RFC 4918 §10.4.2/§10.4.3/§10.4.4 原文照合(docs/rfc/rfc4918.txt):
  ABNF `Condition = ["Not"] (State-token | "[" entity-tag "]")`、List 内は AND、
  Tagged-list/No-tag-list 内の複数 List は OR、ヘッダ全体は全 List が false なら 412。
  §10.4.4「Handling unmapped URLs: treat as if the URL identified a resource that exists
  but does not have the specified state」— 解釈できない/知らない state-token は「一致しない」
  として扱ってよい、が実装の根拠。

**実装スコープ判断(原文に照らして正当化)**: フル ABNF(No-tag-list・entity-tag 混在・
複数 Resource-Tag またぎの OR)は実装せず、RFC 6578 §5.1/§5.2 の例に一致する
「Tagged-list(コレクション href) + State-token(sync-token URI、Not 可)」だけをサポート。
§5 が MUST として要求するのはこの利用形態そのもの(sync-token を If ヘッダの state-token として
使えること)であり、If ヘッダの汎用構文全体ではないため、このサブセットで §5 の MUST を満たせる
と判断した。未対応構文(entity-tag 混在等)を検出した場合は 412 にせず黙殺する(§10.4.1 は
「評価して false なら 412」であって「評価できない」を false とは規定していない。可用性を優先
= フェイルオープン)。判断の詳細コメントは `src/presentation/dav/if-header.ts` 冒頭。

実装: `src/presentation/dav/if-header.ts`(ヘッダ構文解析。presentation 層)、
`src/application/usecases/put-calendar-object.ts` の `evaluateSyncTokenIfPrecondition` /
`SyncTokenIfConditionError`(precondition 評価。PUT/DELETE 共有)、`src/app.ts` の
`ifSyncTokenPrecondition`(両層をつなぐ配線)。テストは
`test/presentation/app.test.ts` の `describe("R-3 ...")`。
- RELATED-TO の既定 RELTYPE は PARENT(RFC 5545 §3.8.4.5 / RFC 9253 §9.1 踏襲)。

## J-4: VJOURNAL の calendar-query time-range 対応(2026-07-14)

`docs/rfc/rfc4791.txt` §9.9(L5158-5170)の VJOURNAL time-range 実効値表を原文照合。

```
+----------------------------------------------------+
| VJOURNAL has the DTSTART property?                 |
|   +------------------------------------------------+
|   | DTSTART property is a DATE-TIME value?         |
|   |   +--------------------------------------------+
|   |   | Condition to evaluate                      |
+---+---+--------------------------------------------+
| Y | Y | (start <= DTSTART)     AND (end > DTSTART) |
+---+---+--------------------------------------------+
| Y | N | (start <  DTSTART+P1D) AND (end > DTSTART) |
+---+---+--------------------------------------------+
| N | * | FALSE                                      |
+---+---+--------------------------------------------+
```

J-1(2026-07-11)時点で `src/domain/ical/recurrence/occurrence-bounds.ts` の
`computeVJournalBounds`(PUT 時の SQL 索引計算)は既にこの表と一致していた(照合済み・訂正不要)。
J-1 の時点で残っていたギャップは「calendar-query REPORT の最終判定」側 —
`parseCalendarQueryFilter`(presentation/dav/xml.ts)が VJOURNAL+time-range を丸ごと
unsupported=403 に倒しており、表自体は反復展開(RRULE)を伴う最終判定として実装されていなかった。

§9.9 冒頭(L5026-5030、VEVENT 表の直前にある一般規則。VJOURNAL 表にも適用される共通規則)の
原文:「Time range tests MUST consider every recurrence instance when testing the time range
condition; if any one instance matches, then the test returns true.」— 反復 VJOURNAL も
RRULE の全 instance を試し、1つでも一致すれば全体マッチという判定が RFC の MUST 要求。

**実装**: `src/domain/ical/recurrence/vjournal-expansion.ts` の `vjournalOverlapsRange`。
DTSTART 無し→FALSE(索引側の null/null=常に候補という安全側の割り切りとは意図的に非対称。
最終判定は表どおり厳密に判定する)、RRULE 付きは expansion.ts の共通ヘルパー(壁時計⇔epoch
変換・UNTIL 厳密判定・maxOccurrences 上限)を再利用して展開し、各 instance に表の効果的
duration(DATE-TIME→0秒/DATE→+P1D)を適用して overlap 判定する。

**スコープの割り切り(RDATE/EXDATE 非対応)**: `src/domain/ical/semantics/vjournal.ts` の
VJournal レンズが現状 RDATE/EXDATE のアクセサを持たないため、この J-4 では RRULE +
RECURRENCE-ID オーバーライドの展開のみを実装した。§9.9 冒頭の一般規則は RDATE 由来の
instance にも同じ適用対象だが、レンズ拡張(+validate() 見直し)は別スコープと判断し先送り
(vjournal-expansion.ts 冒頭コメント参照)。

**副作用として直した索引のバグ**: `computeVJournalBounds` は RRULE の有無に関わらず単発の
DTSTART のみから first/last を出していた(J-1 時点では VJOURNAL+time-range 自体が
unsupported で実際には使われなかったため顕在化しなかった)。J-4 で time-range REPORT を
実際に受理するようになったため、RRULE 付き VJOURNAL の lastMillis を OCCURRENCE_INDEX_MAX
(無限扱い)に修正 — そうしないと SQL 側の粗い絞り込みで未来の反復回が恒久的に落ちてしまい、
`vjournalOverlapsRange` まで到達できず false negative になる(VEVENT の isInfinite 分岐と
同種の対策)。

---

## 未対応 REPORT の返し方 と .well-known の Cache-Control(2026-08-01)

サーバー実測で見つかった2件のバグを直すにあたっての原文照合。
**新規に docs/rfc/rfc3253.txt(WebDAV Versioning)を取得した** — REPORT メソッド本体と
`DAV:supported-report-set` / `DAV:supported-report` precondition の定義元であり、
CalDAV の全 REPORT がこの枠組みに乗るため(バージョニング機能自体は実装対象外)。

### ① REPORT メソッドと未対応 report の返し方(RFC 3253)

**現象**: `OPTIONS /dav/principals/admin/` の `Allow` は REPORT を広告しているのに、
`REPORT /dav/principals/admin/` は **404**(素のテキスト)を返していた。
広告したメソッドが 404 を返すのはプロトコル的に不整合。

**原文(rfc3253.txt §3.6 REPORT の Preconditions)**:

```
   Preconditions:

      (DAV:supported-report): The specified report MUST be supported by
      the resource identified by the request-URL.
```

**原文(rfc3253.txt §1.6 Method Preconditions and Postconditions)**:

```
   If a method precondition or postcondition
   for a request is not satisfied, the response status of the request
   MUST be either 403 (Forbidden) if the request should not be repeated
   because it will always fail, or 409 (Conflict) if it is expected that
   the user might be able to resolve the conflict and resubmit the
   request.
   ...
   When a particular precondition is
   not satisfied or a particular postcondition cannot be achieved, the
   appropriate XML element MUST be returned as the child of a top-level
   DAV:error element in the response body, unless otherwise negotiated
   by the request.
```

→ **確定**: 未実装の report は「再送しても必ず失敗する」ので **403 + `<DAV:error><DAV:supported-report/></DAV:error>`**。
404(リソース不在の意味になる)でも 405(メソッド自体が不可の意味になる)でもない。
名前空間は **DAV:**(CalDAV の `urn:ietf:params:xml:ns:caldav` ではない)。

**§3.6 Marshalling で確認したその他**:
- 「The request MAY include a Depth header. If no Depth header is included, Depth:0 is assumed.」
  → Depth 省略時は 0。
- 「If a Depth request header is included, the response MUST be a 207 Multi-Status.」
  → ただし RFC 3744 §9.5 は当該 report を Depth:0 限定と定義しているため、
  principal-search-property-set については 207 化は起こらない(下記)。

**§3.1.5(DAV:supported-report-set)**: 「This property identifies the reports that are
supported by the resource.」— リソース単位の広告プロパティ。principal URL 用の
`supported-report-set` を新設した根拠。

### ② DAV:principal-search-property-set REPORT(RFC 3744 §9.5)

**原文(rfc3744.txt §9.5)**:

```
   Servers MUST support the DAV:principal-search-property-set REPORT on
   all collections identified in the value of a DAV:principal-
   collection-set property.
   ...
   Support for this report is REQUIRED.

   Marshalling:

      The request body MUST be an empty DAV:principal-search-property-
      set XML element.

      This report is only defined when the Depth header has value "0";
      other values result in a 400 (Bad Request) error response.  Note
      that [RFC3253], Section 3.6, states that if the Depth header is
      not present, it defaults to a value of "0".

      The response body MUST be  a DAV:principal-search-property-set XML
      element, containing a DAV:principal-search-property XML element
      for each property that may be searched with the DAV:principal-
      property-search REPORT.  A server MAY limit its response to just a
      subset of the searchable properties, ...

      <!ELEMENT principal-search-property-set
       (principal-search-property*) >
```

**確定した実装方針**:
- 応答は **207 ではなく 200 + `DAV:principal-search-property-set` 本文**(§9.5 Marshalling)。
- Depth ヘッダが 0 以外なら **400**(MUST)。省略は 0 扱い。
- 子要素は DTD 上 `principal-search-property*` = **0個でもよい**。
  本サーバーは **空集合**を返す — この report が返すのは
  「DAV:principal-property-search で *検索できる* プロパティ」であり、
  本サーバーは §9.4 の principal-property-search を実装していないため、
  「検索可能プロパティは無い」が事実に一致する(下記 gap 参照)。
  Apple(ccs-calendarserver `twistedcaldav/resource.py`)は displayname と
  calendar-user-address-set を返すが、真似ると「宣言と実装の乖離」になるため採らなかった
  (このリポジトリの R-5a / J-2 是正で確立した「宣言 = 実際に受理できるもの」の規律)。

**配置の判断(principal URL vs principal collection)**: §9.5 は文字通りには principal
**collection** への MUST。だが本サーバーは
(a) `DAV:principal-collection-set` を広告しておらず、
(b) principal URL 自身の resourcetype を `<DAV:collection/><DAV:principal/>` と宣言しており、
(c) 実測でクライアントは principal URL(`/dav/principals/{user}/`)に投げてくる
ため、単一ユーザー構成では principal URL = principal collection とみなして実装した。

**未実装として記録する gap(意図的)**:
1. **DAV:principal-property-search(§9.4。原文は "Support for the DAV:principal-property-search
   report is REQUIRED.")は未実装** → 403 DAV:supported-report を返す。
   単一ユーザー運用では検索対象が1件しかなく、実需が出るまで着手しない判断。
   実装したら §9.5 の応答にも検索可能プロパティを載せること(2箇所が連動する)。
2. **DAV:principal-collection-set(§5.8)を広告していない。**
   `/dav/principals/`(principal collection にあたるパス)自体もルーティングされておらず
   全メソッドで 404。整えるなら PROPFIND とセットで別途行う。
3. **カレンダーオブジェクトリソース宛の calendar-multiget が未対応**(405 のまま)。
   RFC 4791 §7.9 原文は「if the Request-URI is a calendar object resource」も対応対象と
   しており、ここを 403 DAV:supported-report で塗るのは誤り(嘘の宣言になる)。
   正しい直し方は「object 宛 multiget(href ちょうど1個 = Request-URI)を実装し、
   それ以外を 403 supported-report にする」の2段構え。

**既知の名前空間の疑い(未修正)**<!-- 2026-08-01 更新: 下の「404 propstat のプロパティ名 と
valid-sync-token の名前空間(2026-08-01)」§② で原文確認のうえ修正済み。この段落は
「疑いを持った時点の記録」として残す(打ち消さず、続きを読めば結論に辿り着ける形にする)。 -->:
`davError("valid-sync-token")` は要素を
`urn:ietf:params:xml:ns:caldav` に置いているが、RFC 6578 §3.2 の原文は
`(DAV:valid-sync-token)` = **DAV: 名前空間**。現状の応答は名前空間が誤っている可能性が高い。
iOS の「無効 sync-token からの回復」経路に触れるため、単独で検証するべく今回は据え置いた
(`src/presentation/dav/xml.ts` の davError コメントにも記載)。

### ③ .well-known/caldav の Cache-Control(RFC 6764 §5)

上の「探索 (RFC 6764 / 5397)」節に 2026-07-08 時点で
「リダイレクト応答には Cache-Control を設定 SHOULD」と記録済みだったが、**実装されていなかった**
(Cache-Control 無しの 301 を返していた)。原文(rfc6764.txt §5):

```
   Servers SHOULD set an appropriate Cache-Control header value (as per
   Section 14.9 of [RFC2616]) in the redirect response to ensure caching
   occurs or does not occur as needed or as required by the type of
   response generated.  For example, if it is anticipated that the
   location of the redirect might change over time, then a "no-cache"
   value would be used.

   To facilitate "context paths" that might differ from user to user,
   the server MAY require authentication when a client tries to access
   the ".well-known" URI ...
```

**確定**: `Cache-Control: no-cache` を採用。判断根拠は
「リダイレクト先は将来変わりうる」側 —
(1) マルチユーザー化(docs/modeling/13)で context path がユーザーごとに変わりうる
   (RFC 6764 §5 自身がその前提で認証要求 MAY を用意している)、
(2) OSS キットとしてマウント先パスが利用者ごとに変わる前提(CLAUDE.md 長期ビジョン2)、
(3) 焼き付き事故の回復コストが非対称(no-cache の損はブートストラップ時の1往復のみ)。
**§5 の認証要求 MAY は採らない**(現状は宛先が全ユーザー同一で守る情報が無く、
401 にするとクライアント実装差を踏むリスクだけが増える)。`private` も付けない
(応答が全ユーザー同一で、no-cache により毎回検証されるため実効差が無い)。
ステータスは 301 のまま(§5 は "301, 303, or 307" を等価に並べており、既存クライアントの
実績を崩す理由が無い)。

---

## 404 propstat のプロパティ名 と valid-sync-token の名前空間(2026-08-01)

本番実測(`https://caldav.gigun-dev.workers.dev`)で見つかった2件の是正。

### ① 404 propstat のプロパティ名は「要求された名前」でなければならない(RFC 4918)

**現象**: `PROPFIND` で要求したプロパティのうちサーバーに無いものは 404 propstat に列挙される
(ここまでは正しい)が、**その要素名が全部 `DAV:` 名前空間に潰れ、さらに小文字化されていた**。

```xml
<!-- 要求 -->
<A:prop xmlns:A="DAV:" xmlns:B="http://apple.com/ns/ical/" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <B:calendar-color/><C:schedule-default-calendar-URL/>
</A:prop>
<!-- 修正前の応答(404 propstat) -->
<d:calendar-color/>                <!-- 名前空間が ical: → DAV: に化けている -->
<d:schedule-default-calendar-url/> <!-- 名前空間 + 大文字 URL → url の二重の化け -->
```

200 propstat 側は正しかった(props Record が手書きで正しい prefix を持つため)。
**404 側だけが別経路で `<d:${name}/>` と名前を組み立てていた**のが原因。
caldav / carddav / calendarserver / apple-ical / me.com の5名前空間すべてで、
principal・calendar-home・コレクションのいずれでも、PROPFIND と REPORT の両方で再現した。

**原文(rfc4918.txt §14.22 propstat XML Element)**:

```
   Description:   The propstat XML element MUST contain one prop XML
      element and one status XML element.  The contents of the prop XML
      element MUST only list the names of properties to which the result
      in the status element applies.
```

**原文(rfc4918.txt §4.4 Property Names)**:

```
   A property name is a universally unique identifier that is associated
   with a schema that provides information about the syntax and
   semantics of the property.
   ...
   The XML namespace mechanism, which is based on URIs ([RFC3986]), is
   used to name properties because it prevents namespace collisions and
   provides for varying degrees of administrative control.
```

**原文(rfc4918.txt §17 Internationalization Considerations)**:

```
   WebDAV property names are qualified XML names (pairs of XML namespace
   name and local name).
```

**判定**: プロパティ「名」は (名前空間 URI, ローカル名) の対。名前空間を潰した時点で
「結果が適用されるプロパティの名前」ではなくなるので §14.22 の MUST 違反。
ローカル名の大文字小文字も XML の規則(REC-XML の Name は大文字小文字を区別する)により
別要素になるため、小文字化も同じく違反。

一方 **prefix そのものは保存しなくてよい**。§4.3 の例の注記が明示している:

```
   o  The [prefix] for the property name itself was not preserved, being
      non-significant, whereas all other [prefix] values have been
      preserved,
```

したがって修正方針は「prefix を鸚鵡返しする」ではなく
**「名前空間 URI とローカル名(原表記)を保持し、応答側は自分の宣言済み prefix に写像する」**。

**iOS への影響の程度(誇張しないための記録)**: docs/modeling/06 の
「要求されたプロパティを黙って落とすと NG。404 propstat に列挙必須。iOS はこれを実際に強制する」
は列挙の**有無**の話で、今回は列挙自体はできていた。**iOS 26.5 は壊れた名前でもアカウント追加に
成功する(実測)**。よってこれは「証明された iOS 破壊」ではなく
**仕様違反 + 潜在リスク**(名前空間で判定する他クライアント・将来の iOS で壊れうる)。

**実装(src/presentation/dav/xml.ts)**:
- `PropFilter` を `Set<string>`(小文字ローカル名のみ)から
  `ReadonlyMap<string, RequestedPropName>` へ。`RequestedPropName` は
  `{ key(小文字ローカル名=照合用), localName(原表記), namespace(URI) }`。
  **「照合のための正規化」と「応答に書き戻す表現」を型で分離した**のが要点
  (両者を1つの文字列で兼ねていたのが今回のバグの根)。
- 200 側の照合は従来どおりローカル名のみ(名前空間を見ない)。**これは意図的な据え置き** —
  名前空間つき照合に変えると props Record のキー体系ごと作り直しになり、
  今回のバグ修正と無関係な退行リスクを負う。実クライアントは正しい名前空間で要求してくる。
- 404 側の書き戻しは3通り: (a) multistatus が宣言済みの名前空間 → その prefix、
  (b) 未宣言 → 要素自身に `xmlns:xN="..."` を付ける(要求されうる名前空間は無限で、
  静的な宣言リストでは原理的に閉じないため)、(c) 名前空間不明 → prefix 無し。
- 名前空間の解決はドキュメント全体の `xmlns` 宣言を舐める近似(prefix の再束縛は見ない)。
  Workers に XML パーサを持ち込まない既存方針の踏襲で、外しても「修正前と同じ状態」に
  戻るだけで新規退行にはならない。

### ② DAV:valid-sync-token の名前空間(RFC 6578)

**原文(rfc6578.txt §3.2 DAV:sync-collection Report の Preconditions)**:

```
   Preconditions:

      (DAV:valid-sync-token): The DAV:sync-token element value MUST be a
      valid token previously returned by the server for the collection
      targeted by the request-URI.
```

RFC 3253 §1.6 の記法どおり precondition 名の `DAV:` は名前空間を指す。
実装は `davError("valid-sync-token")` = CalDAV 名前空間(`c:`)に置いていたので誤り。
`{ namespace: "dav" }` を渡して `<d:valid-sync-token/>` を返すよう修正した。

**iOS への影響の程度**: この 403 はクライアントを full resync に落とす唯一の合図。
iOS は現状 status 403 だけで回復しているように見え(壊れている証拠は無い)、
これも「仕様違反 + 潜在リスク」の側。回復経路(403 → token 無しで再送 → full sync)は
`test/presentation/app.test.ts` の「無効 sync-token」で固定した。

## 2026-10-03 本番応答の再照合と404要求名の衝突

正式Cloud Run入口経由、本番version `612f2dd7-9f81-403c-96a6-3670c2f5e471`。
[応答の記録](../verification/2026-10-03-production-readonly.json)は予定本文・認証値を含めない。
RFC原文を再読した範囲は3253 §1.6/3.6、3744 §9.5、4918 §9.1/14.22/17、6578 §3.2。

- 未対応REPORT: principal/collectionとも403、`{DAV:}error`の子に`{DAV:}supported-report`。
- principal-search-property-set: Depth 0/省略は200 + DAV要素・空集合、Depth 1は400。
  principalのsupported-report-setは207の200 propstatに実装済み1種を広告。
- 無効sync token: 403 + `{DAV:}valid-sync-token`。
- 未知名`UnknownCase`をDAV/CalDAV/Apple/CalendarServer/独自URIで同時要求すると、
  principal/home/collectionすべてで先頭のDAV要素1個だけが404に残った。これは成功扱いにしない。

4918原文 §17は名前を「namespace nameとlocal nameの対」と定義し、§9.1は未知プロパティの
404結果を要求する。`parsePropFilter`が小文字local名をMapキーとして先勝ちにしていたため、
別名前空間だけでなくcase違いも欠落する。保持用Mapキーをnamespace URIと原表記local名の
JSON tupleへ分離する。200側の既存local名照合は値のkeyを使い、別タスクの厳密化を残す。
モデルの値/ユースケースの意味を変更しないpresentation codecの是正で、01〜04の図との乖離なし。
同名・別case・別prefix同一名の重複排除と200応答維持を回帰で検証する。

## 2026-10-03 Depth infinityの是正範囲

4918原文 §9.1はDepth 0/1をMUST、infinityをSHOULDとし、負荷・セキュリティ理由で
無限深度を無効化してよい。§9.1.1はcollection宛の拒否を403 + DAV:propfind-finite-depthとする
SHOULDを示す。現在home/collectionは文字列1以外を0に寄せ、principalも深度を見ず207を返す。
本番probeでも3種類すべてresponse1件のみとなり、infinityを完了したように見せている。

既存の有限深度実装を維持し、明示Depth infinityのcollection要求を403 DAV:errorで拒否する。
対象はentry/principal/home/calendar/tasks等のcollection。objectは子を持たないため従来どおり。
discoveryのprovision前に拒否して、失敗する探索要求でD1を更新しない。
02のユースケース図はDepth 1でカレンダー一覧取得と定義済みで、意味の追加・変更なし。
ヘッダ省略をinfinityと扱う§9.1のSHOULDは今回未是正。既存の省略要求を使う探索経路の
互換性を確認してから別途扱う。明示Infinityはヘッダ値の正規表記infinityのみを対象とする。

### 修正後の本番確認

`3364123`のBuild `883f1600-3aa7-4436-8173-11423996ffd4`成功、D1適用待ちなし。
本番version `a43ef5a9-92dc-4266-a5ca-a5f8bbcb688c`で、principal/home/collectionすべて
5名前空間の`UnknownCase`を207の404 propstatへ欠落なく返した。
[修正後応答](../verification/2026-10-03-production-after-404-fix.json)。
元の失敗応答は削除せず保持する。MCP/DAVスモークも再度成功。実端末/iOS UIの検証ではない。

## 2026-10-03 残る8件の優先順位・実装境界

[本番読み取りprobe](../verification/2026-10-03-eight-gap-probes.json)は上記versionで実施。
PROPPATCHのみ本番変更を避けてコード照合。RFCの根拠は原文4918 §9.1/9.2/14.24/17、
4791 §7.1/7.9、3253 §3.8、3744 §9.4、6578 §3.2/4、6764 §5を再読した。
以下の順位は要件の強さだけでなく、小さく独立に検証できる順も考慮した実装順。

|順|課題|現行実測・照合|実装範囲・完了条件|
|---|---|---|---|
|1|明示Depth infinity|principal/home/collectionで207・response1個|collectionのみ403 DAV:propfind-finite-depth。0/1・object・認証/404・provision非実行を回帰、本番再確認。今回の次スライス|
|2|object宛calendar-multiget|既存object宛405。4791 §7.9はobjectも対象|collectionの既存分岐を共通化し、object宛はhref1個・Request-URIと等価を検証。getetag/calendar-data・未知href・Depth無視を回帰。既存データの読み取りで本番検証|
|3|200 propstatの名前空間照合|独自URIのcalendar-home-setがCalDAV名で200になる|propsの定義名をnamespace+localの対へ変更、filter/全定義/PROPPATCH内部filterも統一。正規名前空間を200、別URI/case違いを404、allprop/REPORT非回帰。XML再束縛はパーサの別境界として明示|
|4|PROPPATCH未対応名|src/app.tsはappliedが空でも空responseを207で返す。4918 §14.24 DTD不適合|set/removeの要求名・順序を解析し、非対応403、同時要求の他変更424・書込なしを保証。成功変更は各propstat200。任意dead property保存や部分成功を加えず、atomicityと無変更の回帰を必須にする|
|5|principal宛REPORT3種|3種とも403 supported-report。過去の404は現状の正ではない|4791 §7.1がMUSTとするexpand-propertyをまず実装。3253 §3.8の入れ子href展開/未知名/上限・広告整合。principal-property-searchは3744 §9.4のACL標準、単一principalのdisplayname検索・0/1件・広告を別スライス。calendarserver拡張はRFC必須と扱わず、Apple要求原文と実需を確認して別判断|
|6|sync tokenホスト依存|proxy発行tokenをworker入口へ返すと403 valid-sync-token|6578はopaque URI、ホスト埋込を要求しない。owner/collectionに束縛した安定URIへ変える方針。既発行2入口のtokenとIfヘッダを前方互換で受理する移行を設計してから実装。collection混同/future token/削除・再作成は拒否、入口変更で無変更diffを検証|
|7|末尾slash付きwell-known|認証ありでも404|6764 §5が登録するURIはslashなし。slashありはApple互換の別名として同じ301+no-cacheへ寄せる。匿名/認証/redirect/Location非回帰。RFCのslashありMUSTとは主張しない|
|8|home宛sync-collection|404、homeのsupported-report-setに広告なし|6578 §3.2は実装したcollectionで広告する要件で、すべてのcollectionへの強制ではない。対応を加えるならcollection追加/削除/メタデータ変更のhome変更履歴が必要。既存objectログの転用で嘘の同期を返さず、実クライアント需要の確認後に別ユースケース/永続化の範囲を確定|

全8件の実装完了を意味しない。depthの省略要求をinfinity扱いするSHOULDへの対応は、
明示infinity修正と区別して探索クライアントの互換性検証を残す。認証方式の製品判断や通知設定は対象外。

### Depth是正の本番受け入れ

`2aa1171`、Build `950da153-2b25-4e6e-a979-916193476274`成功、D1適用待ちなし。
version `e423b4b7-a215-4b40-a454-137d3645a7cb`が100%。
正式proxyでentry/principal/home/calendar/tasksの明示Depth infinityはすべて403、
`{DAV:}error`の子に`{DAV:}propfind-finite-depth`。collectionの0/1は207、
既存objectのinfinityも207・response1個、未存在collectionは404。
OPTIONS204、well-known301+no-cache、MCP get-current-timeとDB依存list-events-expandedも成功。
[受け入れ応答](../verification/2026-10-03-production-depth.json)。
`make check`はBun1147/workerd42成功、層境界・3型レーン成功、pre-pushも通過。
本番データのPUT/DELETE/PROPPATCH、実端末UI検証は行っていない。

次のコア修正はobject宛calendar-multiget。200側名前空間照合を続く優先Aとし、
PROPPATCH・principal REPORT・host依存token・well-known別名・home syncは上の境界に沿って残す。

## 2026-10-03 object宛calendar-multigetの是正

4791原文 §7.9を再読。REPORTはcollectionだけでなくobjectにも必須。object宛ではhref1個・
Request-URIと等価がMUST、Depthは無視、成功は207 multistatus、未存在hrefはresponse内404。
既存本番405の証拠はeight-gap-probesに保持している。3253 §3.1.5はsupported-report-setが
資源ごとの対応REPORTを示すことを定めるため、objectにもmultigetだけを広告する。

collection/objectのmultiget取得・個別404・要求prop・calendar-dataを同じ既存MultigetObjectsへ
通す。object宛のhref個数/等価性の不備は400。free-busy-queryのobject宛403は維持し、その他
未対応REPORTを403 DAV:supported-reportへ直す。bodyはREPORT分岐で一度だけ読む。
02の一括取得ユースケース、03のcollection内URIを持つobjectモデルに変更なし。

URI比較に必要な3986全文をRFC Editorから取得してdocs/rfcへ追加し、§2.3/6.2.2/6.2.3を読んだ。
URLによるscheme/host/既定port正規化と、unreservedのpercent復号を使い、予約文字は復号しない。
公開originは既存externalOrigin(正式proxy)を使う。別ホスト/別path/別query/fragment/短い相対名は
等価扱いしない。不正URLは400にする。collection側の既存href境界判定はこの変更で拡張しない。

回帰の対象は、絶対path・絶対URI・unreserved表記差・proxy origin・Depth無視、ETag/ICS選択、
0/複数/非等価href、外国host/予約slash/不正URL、未存在207内404、未対応403、資源別広告。
本番は既存objectの読み取りのみで確認し、受け取ったICS本文・URL/UID/ETagを公開資料へ保存しない。

## 2026-10-03 200 propstat名前空間照合の変更範囲確定

4918原文 §4.4/9.1/14.22/17を再照合。別namespaceの同名は別プロパティであり、既存本番probeの
`{urn:verification}calendar-home-set`に`{caldav}calendar-home-set`を200で返す応答は是正対象。
404保持の先行修正を尊重し、次の実装は読み取りcodecへ閉じて独立タスクに分ける。

**実装範囲**:
- presentation内にnamespace URI + caseを保持したlocal名の対で識別するPropertySetを置く。
  選択した形式は`ReadonlyMap<qualifiedPropKey, { namespace, localName, xml }>`、キーは現在の
  保持用Mapと同じJSON tuple。XML本文から名前を逆算せず、定義時に明示する。
- `entryProps/principalProps/homeProps/collectionProps/objectProps`の5 factoryすべてを移行。
  DAV(例 principal-URL)/CalDAV(例 calendar-home-set/calendar-data)/CalendarServer(getctag)/
  Apple(calendar-color/calendar-order)を正確に定義。domain/application/DB/MCPの契約には波及させない。
- `responseXml`の200選択と404列挙を同一qualified keyで照合。別URI・local case違いは404。
  `allprop`の既存集合とsync-token除外は維持。現在の`requested()`小文字照合は廃止する。
- `parsePropFilter`の名前空間解決をscope-awareにする。既定xmlns・子要素のxmlns・prefix再束縛を
  正しく扱うXML解析が前提。全体regexによる宣言収集は厳密照合には使わない。Workers互換の
  XMLパーサを選び、DTD/外部entityを許さず、malformed XMLを400とする。選定と性能は実装時に検証。
- PROPPATCH内部応答の`applied`/`propFilterFromKeys`も定義済みの名前の対から構築する。
  入力set/remove解析とatomicityの是正は既存0007に残し、読み取り照合変更へ混ぜない。

**検証・互換性**:
- codec:正規prefix/別prefix同一URI/既定xmlns/再束縛/別URI/別case/同名衝突/unknown保持/allpropを確認。
- app:entry/principal/home/calendar/tasks/objectのPROPFIND、calendar-query/multiget/syncの要求prop選択。
  getetagのみのREPORTでICSを返さないこと、正規namespaceのknown200とwrong-namespace404を確認。
- `test/presentation/xml.test.ts`のprops文字列アクセス、`app.test.ts`の既知名ケースを新型へ移す。
  明示的に旧local名照合を期待するテストは要件変更として書き換え、正規名の陽性ケースを残す。
- modeling/06の実測要求14/38プロパティ(§B探索ログ)をキャプチャ原本からfixture化してローカル非回帰。
  iOSはURIとcaseを含む名前に依存するので、誤ったnamespaceを送る未知clientだけを互換例外として
  黙って通さない。実端末の初回探索/同期を確認するまではiOS受け入れ完了と主張しない。
- 本番非破壊では正規/別URI/別caseを同時に送りpropstatを照合する。D1 migrationは不要。

これは変更範囲の確定で、200照合の修正・XMLパーサ選定・実端末検証は未実施。

### object宛multigetの本番受け入れ

実装`a01b2ec`と範囲記録`55fd1c1`をmainへpush。Build
`09f2c16b-def0-4c86-bb52-3c11ea772032`成功、D1は`No migrations to apply!`。
version `b99627b2-8dd9-4dfd-9d78-554f2cc5ad32`が100%。
`make check`/pre-pushはBun1165、workerd42、層境界・3型レーン成功。

正式proxyで既存objectのHEAD ETagと次の応答をメモリ内で比較した。
- 絶対path/公開proxy絶対URI/unreserved percent表記の3種はDepth infinityでも207、ETag一致。
  getetagのみの要求ではcalendar-dataを返さない。
- calendar-data明示要求では207、VCALENDAR本文とETag一致。実ICS本文/UID/ETag/URIは保存していない。
- hrefなし/複数/別path/別host/fragmentは400。
- 存在しないobjectは207内404。objectの広告はcalendar-multigetのみ。
- 未対応object REPORTは403 DAV:supported-report、collection multigetは207・ETag一致。
- OPTIONS204、MCPのDB依存読み取り200/isErrorなし。

[応答記録](../verification/2026-10-03-production-object-multiget.json)。
本番PUT/DELETE/PROPPATCHや実端末UI操作は行っていない。0012のサーバー是正/本番確認は完了。
0013は範囲確定として完了し、実際のQName照合変更は0057に残す。

## 2026-10-03 DAV読み取りのQName照合実装・ローカル検証

4918原文 §4.4/8.2/9.1/14.22/17を再読。property名はnamespace URIとlocal名の対、
非整形式XMLは要求全体を400で拒否する契約に沿い、5 factoryを`PropertySet`へ移行した。
200選択と404判定は同じJSON tupleキーを使用する。正規の`principal-URL`は200、
`principal-url`や同名の別URIは404で原表記を保持する。allpropの既存集合とDAV:sync-token除外は維持。
PROPPATCH内部の成功応答も定義済みQNameから作る。入力set/removeとatomicityは0007に残す。

XMLパーサには`saxes 6.0.0`を固定導入。namespaceモードで既定xmlns・要素自身のxmlns・
prefix再束縛・兄弟へのscope復帰を解決する。root直下のDAV:propの直接の子だけを要求名とし、
プロパティ値内の子や未知拡張内のDAV:propを要求として誤収集しない。DTDはdoctypeイベントで拒否し、
外部entityを取得せず未定義entityも400にする。PROPFINDはprovision前に1回だけ検証し、
collection/objectのREPORTも取得・分岐に先立って検証する。

[選定元の公式説明](https://github.com/lddubeau/saxes)はXML/namespace整形式検証を提供し、
DOCTYPEのentityを自動展開・取得しないことを示している。repoは2025-12-31にarchive済み。
既存transitive依存`sax`はstrictでも非整形式を受理するため採らず、DOMParserが無いWorkersで
動く小さなparserを固定し、本番runtimeと同じworkerdで受け入れを検証する判断とした。
Bunのbrowser targetでparser単体をminifyすると依存xmlchars込み27,865 bytes。
Bun1.4.2上の合成38プロパティ(695 bytes)をwarmup 1,000回後10,000回解析した時間は107.2ms
(1要求平均約0.011ms)。これはローカル参考値で、iOSキャプチャや本番Workers CPUの測定ではない。

`make check`成功: 層境界・3型レーン、Bun1186件、workerd44件。
回帰は全5factoryのPROPFIND、object、query/multiget/syncで正規200・別URI/case404・
getetagのみの要求でICS非出力、既定/子宣言/再束縛/Unicode名、壊れたXML/未宣言prefix/DTD400、
PROPPATCH成功QNameを含む。workerdは実fetch経路で同じscopeと400を確認した。

modeling/06の実測14/38プロパティのキャプチャ原本fixture、および実端末の初回探索/同期と
本番非破壊probeはこの記録時点では未実施。ローカル回帰成功をiOS実端末受け入れ完了とは扱わない。
D1 migrationは不要、domain/application/DB/MCPの契約変更なし。

### 実機探索要求14/38の原本fixture追加

既存保存済みの`[DUMP][req]`ツール出力から、iOS/26.5 (23F77) dataaccessd/1.0の
principal Depth 0(14プロパティ)・home Depth 1(38プロパティ)要求bodyを復元した。
保存元はClaudeローカルproject `69499463-0864-4e96-acd6-3d8e8c128748`の
`tool-results/bqh5xp0dw.txt`(mtime 2026-07-13)。同projectの`b6taf7q5f.txt`
(mtime 07-12)にもreminddの同じ要求が残る。正確な要求日時は出力内に無いので、
mtimeを実機操作日時とは扱わない。06が記す07-10 `[CAP]` 原本そのものは見つからず、
後日の本作の実測要求を採用した。詳しい復元元・SHA-256は
[test fixture README](../../test/presentation/fixtures/real-ios/README.md)に記録した。

ヘッダ・要求pathを含めず、bodyだけを採用。bodyはプロパティ名だけで個人情報を持たず、
namespace宣言・prefix・case・空白を変えていない。独立に展開した全QNameのgoldenも固定し、
parserの誤った要求集合から期待404を作って成功させない。
principalの6既知/8未知、homeの3/35、VEVENT/VTODO collectionの9/29をすべて200/404へ
欠落なく分割する4回帰が成功。対象3ファイル全124件とtscも成功。
これにより原本fixtureによるローカル非回帰は確認済み。現在の実装を接続した実端末探索・同期と
本番probeはこの追記の担当範囲には含めず、実施済みとは主張しない。

### QName是正の本番受け入れ

実装・実機要求fixtureを含む`5af2484`が遠隔mainに一致。
Workers Build `0bbca18f-0be6-4d31-a93d-899d4ef171ef`はsuccess、deployログはD1
`No migrations to apply!`。deployment `22fa46a8-96ee-4d95-ba62-d56f9a8f0bcf`の
version `812e6736-1ba1-4a2b-b6c9-2d328ef315f3`が100%で稼働することをAPIで確認した。

正式proxyを通した非破壊受け入れ33項目が成功。
entry/principal/home/calendar/tasks/objectで正規QNameを200、別URIとcase違いを404に分ける。
既定xmlns・要素自身の宣言・prefix再束縛を含む要求、および実機原本14/38プロパティfixtureを
送り、各responseで要求名の全件保持を照合した。query/collectionとobjectのmultiget/syncは
getetagのみ200、wrong-namespace calendar-dataは404、ICS本文を混入しない。
REPORT自身の既定xmlns/再束縛も確認。calendar-data明示multigetはVCALENDARを返す。
allpropのsync-token除外と、同じtokenによる無変更incremental sync(変更response 0件)も維持。

PROPFIND/collection REPORTの未閉鎖XML・未宣言prefix・DTD・複数rootは400。
OPTIONS204、well-known301+no-cache、MCPの匿名401・initialize・tools/list・get-current-time・
DB依存list-events-expandedは正常。well-knownは既存検証と同じUser-Agentで301を確認した。
途中のPython既定User-Agentでの要求は403で、User-Agent変更後は301。この応答差の原因までは
本受け入れで切り分けていない。

[状態/QName/件数の記録](../verification/2026-10-03-production-qname.json)。
実object URI/UID/ETag/ICS本文はメモリ内で扱い、証拠へ保存していない。
本番PUT/DELETE/PROPPATCHと現在の実端末初回探索・同期UI操作は実施していない。
サーバー実装・原本fixtureローカル非回帰・本番読み取り受け入れは完了。


## 2026-10-04 PROPPATCHの部分保存是正（0007、本番検証済み）

RFC 4918の保存済み原文§9.2/9.2.1/14.23/14.24/14.26を照合した。
指示は文書順、成功は全件または無変更、個別結果はpropstatで返す。
main `a46f0c3200d10770818c4fa8bc6bf414f4dacbf8` の隔離再現では、
表示名setと未知プロパティsetを混在させると保存が1回発生し、表示名だけ変更された。
未知プロパティだけでもsaveを呼び、propstatのない207を返していた。

DAV専用の`presentation/dav/proppatch.ts`で全set/removeをQName・文書順付きで解析し、
書込み前に全件の対応可否と値を検証する。失敗項目は403（未対応）または409（不正値）、
他項目は424。失敗時は既存UpdateCollectionPropertiesを呼ばない。
正常時のみ表示名・Apple色・順序の最終値を既存UCで一度保存する。
XMLの整形式・DTD拒否は既存saxesを使い、壊れた後続XMLも400・書込なしにする。
応答QNameは既存serializerを再利用し、DAV/Appleのprefix互換を維持する。

この変更は任意dead property保存やmetadata removeの追加ではない。
removeは黙って無視せず403で明示拒否する。RFC §14.23の存在しないプロパティ削除を
成功扱いする汎用remove対応まで実装したとは主張しない。空値・非数のorderも従来の
黙った無視/不正値保存ではなく409となる。予定・VTODO、MCP、共通UC/domain、DB schema、
MKCOL・proxy・認証・通知の変更はない。

ローカル検証: 新規Hono経由25件（230 assertions）成功。
混在/未知のみ、namespace/case、再束縛、文書順の重複set、remove混在、不正値、
不正XML/DTDについて応答QNameとstatus、保存回数と保存値を確認した。
実workerd/ローカルD1でも混在要求後の全collection行不変と正常更新の永続化を確認。
`make check`は層境界・3レーン型検査・Bun1215件・workerd45件すべて成功。
Wranglerの既存Issues設定・ダミー秘密値・SDK sourcemapの警告はあるが失敗なし。

PR #3 は main `6e296180d5e5351dfc12b98c46f5b50b6cf5505b` に統合し、Workers Builds成功を確認した。
2026-10-04、正式Cloud Run DAV入口の専用一時カレンダーで13項目を確認。
表示名と未対応項目の混在は403/424、不正色との混在は409/424となり、
どちらも表示名・色・順序・sync-tokenの前後一致をPROPFINDで確認した。
正常な表示名・色・順序の一括更新は200で永続化した。専用カレンダーは削除し404を確認済み。
DB schema変更はなく、この検証はDAV通信の受け入れであり実機の使い心地の評価ではない。
