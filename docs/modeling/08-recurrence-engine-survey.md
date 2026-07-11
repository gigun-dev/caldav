# 意味計算(RRULE 展開・TZ・free-busy)の調査と設計判断(2026-07-11)

> **位置づけ**: 07(認証)と同じく、実装前の一次調査記録。
> **発端**: agentic 入口(MCP app / WebMCP、方向性 E)では「CalDAV に保存された
> イベントの理解」と「free-busy」が中核能力になる、というユーザー判断(2026-07-11)。
> マルチユーザー(方向性 A)と同等かそれ以上に重要なスコープとして扱う。
> **ペルソナ(2026-07-11 ユーザー確認)**: まず自分で使い(ドッグフーディング)、
> 個人開発のカレンダー/リマインダー関連プロダクトで採用する。スケーリングは常に意識。
> agent 向けには「CalDAV client for agent」を用意したい — スコープは
> **CalDAV クライアントができることほぼ全部**(照会だけでなく書き込み・繰り返し編集含む)。
> **前提**: 03 §1-4 で `RecurrenceExpansion` ドメインサービス
> (`expand(master, overrides, range) → Occurrence[]`)の輪郭は予約済み・未実装。
> 現状のドメイン層は「ロスレス保持 + 静的不変条件 I1〜I10」まで。

## 0. 結論サマリ

1. **time-range フィルタの RRULE 展開は RFC 上の MUST**(逃げ道なし)。calendar-query
   自体が REQUIRED で supported-report-set は「広告義務」であって非対応表明の手段ではない。
   → 現状の本作は厳密には RFC 非準拠(calendar-query 未実装)。「RFC 準拠」をコア価値と
   する以上、意味計算はいずれにせよ必須だった。
2. **タイムゾーンは「IANA tzdb を正、VTIMEZONE は保存のみ」が業界標準**(sabre / Stalwart /
   Xandikos すべて実質 IANA 正)。VTIMEZONE の RRULE を自前評価するエンジンは作らない。
   Workers では Intl(ICU の tzdb 内蔵)で TZID→UTC 変換が無料で手に入る。
3. **agentic 用途ではサーバー側展開が製品価値そのもの**。LLM は日時の反復演算が壊滅的に
   苦手(Test of Time: Schedule 正答 29〜43%、Duration 13〜16%)で、先行 MCP
   (Google Calendar MCP)は全て展開済み構造化データ + get-freebusy + get-current-time を
   提供する流儀。CalDAV 直結 MCP は下に展開済み API が無いので、この層を自前で持つことが差別化。
4. エンジンは **rrule.js 不採用、ical.js(RRULE 反復)+ 自前 TZ 解決層(IANA/Intl)** の
   組み合わせを第一候補とする。
5. **コストは問題にならない**(Workers は CPU-ms 課金で 1 CPU 秒 = $0.00002。個人〜
   小規模なら事実上 $5/月の基本料のみ)。戦略は「PUT 時に first/last occurrence を
   索引化(sabre 式)+ REPORT 時にヒット行のみ展開」のハイブリッド。展開済み
   occurrence テーブル・KV/Cache API キャッシュは不採用。

## 1. RFC 4791 がサーバーに課す解釈義務(原文照合済み、docs/rfc/rfc4791.txt)

### MUST の集合(逃げられない最小ライン)

- **calendar-query / calendar-multiget / free-busy-query / DAV:expand-property の
  各 REPORT は REQUIRED**(§7.8 L1988, §7.9 L3490, §7.10 L3693, §7.1 L1720)。
- **time-range 判定は全 recurrence instance を評価 MUST**(§9.9 L5026「MUST consider
  every recurrence instance」、§7.4 L1801「MUST expand recurring components」)。
  実効 DTSTART/DTEND/DURATION/DUE の算出規則(DTEND 欠落→DTSTART+DURATION、
  DATE 値→+P1D、DTEND 非包含)も §9.9 の表で規範指定。
- **floating/DATE の解決チェーン**(§7.3 L1758-1772): calendar-query では
  ①リクエストの CALDAV:timezone 要素 → ②calendar-timezone プロパティに MUST rely、
  ③どちらも無ければサーバー任意(MAY)。free-busy では ②→③。
- クライアントが **CALDAV:expand を要求したら**展開して単一 occurrence 群 + UTC 化で
  返す MUST(§9.6.5)。RRULE/EXDATE/RDATE を残すこと・VTIMEZONE 参照は MUST NOT。
- free-busy-query の応答は **VFREEBUSY 厳密1個** MUST(該当なしでも空 VFREEBUSY)。

### SHOULD / MAY(裁量がある部分)

- calendar-timezone プロパティの常設は SHOULD。
- free-busy の意味写像(TRANSP/STATUS → FBTYPE、coalesce)は SHOULD。
- **GET / multiget のデフォルト calendar-data は展開しない**(master + overrides を
  生で返す)— 通常取得での解釈はクライアントに委ねられている(§7.6)。
  「クライアント任せ」が許されるのはここだけで、クエリ評価の文脈では許されない。

## 2. 競合実装の実態(deepwiki 調査)

| 実装 | time-range の RRULE 評価 | CALDAV:expand | free-busy-query | TZ の正 | エンジン |
|---|---|---|---|---|---|
| sabre/dav | ○(**PUT 時に first/last occurrence を索引化** + クエリ時展開) | ○ | ○ | TZID→IANA マップ(VTIMEZONE は推測ヒント) | 自前(sabre/vobject) |
| Stalwart | ○ | ○ | ○ | IANA + VTIMEZONE 両対応 | 自前(calcard) |
| Xandikos | ○(例外・VTODO にバグ自認) | ○ | ○ | IANA(zoneinfo) | 外部(dateutil.rrule) |
| Google CalDAV | ○ | ○ | **×(意図的未実装)** | — | — |

- ミニマル志向の Xandikos ですら time-range 展開は「やらない」を選べなかった
  (正しく答えないと繰り返しイベントがクエリ窓から消える。Nextcloud #20191 が実事故例)。
- 一方 **CALDAV:expand と free-busy-query を実クライアントはほぼ使わない**
  (iOS/Thunderbird はフル ICS を取得してクライアント展開。DAViCal wiki
  「free-busy-query を投げるクライアントは観測されていない」。Google は未実装のまま
  Apple Calendar と互換)。→ RFC 上は MUST でも実利用は薄い =「iOS のためではなく
  RFC 準拠と agentic のために作る」機能。
- **sabre の「PUT 時に first/last occurrence を計算して索引化」は D1 と相性が良い**
  (time-range クエリの一次絞り込みを SQL で行い、境界だけ展開評価)。

## 3. タイムゾーン処理の深さ(ドメインエキスパート観点)

### 流派の決着: IANA tzdb を正とする

- RFC 7809 自身が明記する現実: 「クライアントはサーバーの送る VTIMEZONE を無視して
  内蔵 tzdb で解釈するのが通例」— iOS も Apple 内蔵 tzdb で解釈する。
- sabre/vobject の TimeZoneUtil は ①IANA 名直引き → ②Windows/Lotus 名マップ →
  ③オフセット推測 → ④VTIMEZONE の X-LIC-LOCATION からの推測、の順で、
  **VTIMEZONE 内の RRULE から直接オフセット計算は決してしない**。
- 「VTIMEZONE を正」派は古い VTIMEZONE(古い iOS/Outlook が送る)とクライアント内蔵
  tzdb の食い違いで DST 後の occurrence が1時間ズレる事故を起こす
  (Outlook の Berlin→West-Central Africa 誤マップ等)。
- **本作の方針: 解釈は IANA tzdb、保存は原文そのまま**(生値保持の既存設計と両立)。
  I8(TZID 参照整合)は「参照が壊れていない」ことの検証として維持し、
  解釈時に VTIMEZONE の中身は使わない。
- RFC 7809 / TZDist(7808)は実装しない(普及は Cyrus/Apple 系のみ)。
  「クライアントは内蔵 tzdb で解釈する」という前提だけ借りる。

### 落とし穴リスト(実装時のチェックリスト)

- floating time の解決チェーン(§7.3)を暗黙フォールバックにしない
  (Home Assistant の「終日イベントが EST で前日 20 時開始」事故の型)。
  ③の「サーバー任意」は **UTC と明示** し、テストで固定する。
- VALUE=DATE: DTEND 無しは +P1D、DTEND は非包含(off-by-one の定番)。
- DST 境界の展開順序: **「ローカル時刻で反復 → 各 occurrence を tzdb で UTC 化」**
  の順を守る(先に UTC 化すると DST 跨ぎで壁時計時刻がズレる)。
- Workers ランタイム: Intl.DateTimeFormat は ICU tzdb 込みで使える(週次更新)。
  Temporal はネイティブ未対応(workerd discussion #6716)、必要ならポリフィル。
  **本番は TZ=UTC、wrangler dev はローカル TZ**(workerd #2328)— dev/prod 差異を
  テストで潰すこと。

## 4. agentic 観点(なぜサーバー側解釈が必須か)

- LLM の日時演算能力(Test of Time, arXiv:2406.09170): Schedule 問題 GPT-4 43.6% /
  Claude-3-Sonnet 29.6%、Duration 計算 13〜16%。RRULE の COUNT/UNTIL/BYDAY 暗算を
  LLM にやらせる設計は不可。エージェントでは初期誤りが後続に伝播する。
- 先行例(nspady/google-calendar-mcp ほか): 展開済み構造化データ + `get-freebusy` +
  **`get-current-time`(LLM に「今」を与えるツール)** + 繰り返し操作のスコープ指定
  (thisEvent / all / thisAndFollowing)。生 ICS を LLM に渡す先行例は無い。
- ペルソナ確認(2026-07-11): agent には「CalDAV client ができることほぼ全部」を
  持たせたい → 照会(展開・free-busy)だけでなく **書き込み(「毎週の定例をずらして」=
  オーバーライド生成)** まで視野。書き込み側は semantics 層に書き込みアクセサが
  未実装なので、これも意味計算スコープの一部になる。

## 5. エンジン候補の評価(deepwiki 調査)

### rrule.js(jkbrzt/rrule)— ❌ 不採用

- RFC 逸脱: DTSTART がルール合致時しか初回にならない / BYWEEKNO を全 FREQ で許す。
- RECURRENCE-ID オーバーライドの概念なし(iOS が実際に送る — 06 A5)。
- JS Date + Intl ベースで「UTC 偽装 Date」規約が必要 — values 層の判別ユニオン設計と
  相性最悪。最終コミット 2023-11 で停滞。

### ical.js(kewisch/ical.js、Mozilla)— ✅ RRULE 反復エンジンとして第一候補

- libical 由来。BYSETPOS 含む BY 系フル実装(EXPAND/CONTRACT 方式)。
- `ICAL.Event.getOccurrenceDetails()` が RECURRENCE-ID オーバーライド込みで解決 —
  03 §1-4 の `expand(master, overrides, range)` とほぼ一対一。
- 依存ゼロ・ES Modules・活発メンテ・イテレータ状態を JSON 化可能(Workers の CPU
  制限との相性、sabre 式 first/last 索引の途中再開にも使える)。
- **注意(当初評価の修正)**: ical.js の TimezoneService は VTIMEZONE ベース解決で、
  これを「本作と噛み合う利点」と当初書いたが、§3 の結論(IANA 正)により
  **TZ 解決には使わない**。採用するのは RRULE 反復(ローカル時刻の列挙)のみで、
  UTC 化は自前の TZ 解決層(Intl/ICU)が行う。
- コスト: 本作 Component → ICS 文字列 → ICAL.Component の二重パース。展開対象は
  繰り返し持ち VEVENT のみなので軽い見込みだが要実測。

## 5.5 スケール・コスト(Workers/D1 の課金特性、2026-07-11 追加調査)

一次情報: developers.cloudflare.com の Workers/D1/KV pricing・limits。

- **Workers は CPU-ms 課金**(duration 課金ではない。I/O 待ちは CPU に乗らない)。
  Paid: 3000 万 CPU-ms/月込み、超過 $0.02/百万 CPU-ms = **1 CPU 秒 $0.00002**。
  数千 occurrence の展開(数十〜数百 ms)は課金上ほぼゼロ。
- **本当の制約は Free プランの 10 ms/req 上限**(超過は Error 1102 で途中結果なし →
  iOS には同期失敗に見える)。本作は Paid 前提(デフォルト 30 秒、5 分まで拡張可)。
  OSS キットの README には「Free プランでは繰り返しの多いカレンダーで 1102 になり得る」
  と明記する(利用者がまず踏む罠)。
- **D1 の rows read は「スキャン行数」課金**。非インデックス列フィルタは全行課金。
  「カレンダー全読み → Worker で展開・フィルタ」は最悪パターン(個人規模では絶対額は
  誤差だが、スケール意識とは逆行)。
- **sabre 式 first/last occurrence 索引が D1 と好相性**: PUT 時に firstoccurence /
  lastoccurence の 2 カラムを計算・索引化 → time-range は
  `lastoccurence > :start AND firstoccurence < :end` で SQL 絞り込み → ヒット行のみ
  リクエスト時展開。write 増は PUT あたり索引 +1 row で誤差。無限反復は MAX_DATE
  相当でキャップ(sabre 実績)。
- **展開済み occurrence テーブルは不採用**(イベント1件→数百行 INSERT で rows written が
  跳ね、更新時の DELETE+再INSERT も課金。first/last 方式への優位なし)。
- **KV / Cache API キャッシュも不採用**: KV は結果整合で「PUT 直後の REPORT」に stale を
  返し得る(iOS は PUT→即再取得するのでバグ源)。Cache API は DC ローカルで PUT 時の
  確実な無効化が不可能。**PUT と原子的に整合を保てるのは D1 だけ** = sabre 式索引が
  キャッシュの最小形を兼ねる。Durable Objects は現段階では過剰(将来カレンダー単位の
  sync-token 直列化が要る規模で再検討)。
- 概算(1ユーザー、イベント500件、iOS 15分毎 sync + 50 REPORT/日): リクエスト・CPU・
  D1 とも Paid 込み枠の 0.1% 未満 = **実質 $5/月の基本料のみ**。100 ユーザーでも
  オーダー不変。
- ライブラリ性能の傍証: rrule.js は TZID 付き `between` が v2.7.0+ で 10 倍遅い既知
  退行(#580)— 不採用の追加理由。ical.js は maxTries=500 等の暴走ガード内蔵 +
  イテレータ状態の直列化で中断再開可(1102 対策にも使える)。

## 6. 設計判断(2026-07-11)

1. **スコープ3層**:
   - **Tier 1(RFC 準拠の義務)**: calendar-query の time-range フィルタ +
     floating 解決チェーン + 実効値算出。sabre 式「PUT 時 first/last occurrence 索引」を
     D1 スキーマに織り込む(A-1 のスキーマ設計と同時に決める)。
   - **Tier 2(agentic の本命)**: application 層の第一級ユースケースとして
     「期間指定 occurrence 展開」「free-busy 計算」を実装。CalDAV の
     expand / free-busy-query REPORT と MCP ツール(list-events-expanded /
     get-freebusy / get-current-time)の**共通ユースケース**にする(複数入口ビジョン)。
   - **Tier 3(やらない)**: RFC 7809 / TZDist、VTIMEZONE 逐語評価エンジン、
     歴史的 tzdb バージョン管理。
2. **TZ 解決層は自前**(IANA 名直引き → Windows 名マップ → VTIMEZONE からの推測 →
   明示エラー。実装は Workers の Intl/ICU)。**RRULE 反復は ical.js** をアダプタの
   内側に隠して採用(将来の自前化・差し替えを構造で担保)。
3. **展開上限を最初から API に組み込む**(Radicale の max_freebusy_occurrence 先例。
   DoS 対策。ServerPolicy = 方向性 F と接続)。
4. 書き込み側(オーバーライド生成等)は semantics 層の書き込みアクセサとして別途設計
   (agent 向け「ほぼ全部」スコープの後半。まず照会系から)。

## 7. 未確定・次の宿題

- ical.js の二重パースコスト実測 / bun test・Workers 上での動作確認。
- sabre 式 first/last occurrence 索引のスキーマ設計(A-1 と統合するか、意味計算側で
  独立マイグレーションにするか)。
- 方向性の順序: A(マルチユーザー)と意味計算のどちらを先にするかはユーザー判断。
  ドッグフーディング優先なら「意味計算 → E の MCP 照会系(自分の iOS カレンダーを
  agent から読む)」を A より先に置く線が有力(単一ユーザーのままで完結する)。
