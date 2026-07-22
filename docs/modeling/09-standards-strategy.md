# 標準の戦略的取捨と API 表面の設計(2026-07-11 調査)

> **位置づけ**: 08(意味計算エンジン)の続編。発端はユーザーの問い
> 「RFC に盲目に従うことだけが価値ではない(VJOURNAL はあまり使われていない)。
> expand / free-busy-query が実プロダクトで使われていないなら、同等機能を OSS は
> どの表面で実現しているのか。採択途中の RFC に可能性は無いか。戦略的に考えたい」。
> subagent 3本(①モダン API の表面 + RFC 取捨の実態 ②プラットフォーム能力マトリクス
> ③採択途中 RFC の将来性)の調査結果を統合。詳細な出典は各節末尾。

## 1. 「展開」と「availability」はモダン API の第一級機能(調査①)

CalDAV の expand / free-busy-query REPORT は使われていないが、**同じドメイン能力は
全モダン API が第一級で提供している**:

| API | 展開済み列挙 | free-busy / availability |
|---|---|---|
| Google Calendar REST | `events.list?singleEvents=true`(クエリフラグ) | 専用 `POST /freeBusy`(busy 区間の JSON 配列) |
| Microsoft Graph | `calendarView`(展開専用リソースパス) | `getSchedule`(busy 区間 + スロット離散化 "000220130" + 勤務時間) |
| JMAP for Calendars | `CalendarEvent/query` の `expandRecurrences`。**合成 occurrence id を get/set にそのまま使える**(単一回編集まで id 体系に統合) | `Principal/getAvailability`(BusyPeriod[]) |

共通の設計形(本作の MCP/REST 入口設計の雛形にする):
- **時間窓必須**(timeMin/timeMax 等)— 無限展開ガードとして全員が必須化。
  JMAP は `maxExpandedQueryDuration` を capability で宣言。
- TZ は「入力は UTC/offset 付き、**応答の TZ は別パラメータ**」で分離。
- free-busy の応答は iCalendar でなく**構造化 JSON(busy 区間配列)**。

さらに決定的なのは実装の置き場所: **Nextcloud(Appointments)も Cal.com も、
「本気の availability 計算」はプロトコルでなくアプリケーション層のドメインサービス**
(Cal.com: 勤務時間 − busy の減算パイプライン + Redis)。本作の
「application 層のユースケースを DAV 専用にしない」方針の実例そのもの。

出典: developers.google.com(events.list / freebusy)、learn.microsoft.com
(calendarView / getSchedule)、draft-ietf-jmap-calendars-26、deepwiki
(nextcloud/calendar の AvailabilityGenerator 系、calcom/cal.com の AvailableSlotsService)。

## 2. RFC の取捨: 正規の絞り方と「死んでいる」機能(調査①)

- **`supported-calendar-component-set` が RFC 公認のオプトアウト機構**(RFC 4791 §5.2.3、
  docs/rfc/rfc4791.txt L768–)。宣言すれば列挙外コンポーネントの PUT は
  「MUST result in an error」(precondition §5.3.2.1)。**宣言しないと「全コンポーネント
  MUST accept」になる** — 絞るなら宣言は必須。
- 前例: **iCloud はカレンダーに VEVENT のみ、Google も VEVENT のみを宣言**。
  sabre はデフォルト VEVENT/VTODO/VJOURNAL。
- **CALDAV:expand は REQUIRED ではない**(独立 REPORT でなく calendar-data の子要素。
  08 §1 の当初整理を粒度補正)。iOS はクライアント展開するので優先度を下げる正当な根拠。
  free-busy-query は REQUIRED だが iOS 単独利用では叩かれない → 実装順は後ろでよい。
- Apple の適合テスト(CalDAVTester)自体が **feature 宣言ベースの条件付きテスト**。
  「全部必須」文化はテスト側にも無い。
- 実質死んでいる機能: VALARM の EMAIL action(サーバー送信を実装した汎用サーバー皆無)、
  RFC 8607 Managed Attachments(Apple 専用)、VPOLL / Series / Subscription Upgrades
  (draft expired)。

**方針**: 「RFC 準拠」= 「実装した機能は原文どおり正確に + 対応範囲を capability で
正直に宣言する」と再定義する。盲目的な全部実装ではなく、宣言の正確さで準拠を名乗る。

## 3. プラットフォーム能力マトリクス(調査②)

| | カレンダー全体 | 連絡先 |
|---|---|---|
| iOS ネイティブ | ◎ EventKit フルアクセス(**全アカウント横断**。iOS 17 で フル/書込専用の2段階) | △ iOS 18 で limited access(一部のみ)導入 |
| Android ネイティブ | ◎ CalendarProvider(全アカウント横断、sync adapter で拡張可) | ◎ ContactsContract |
| Web / PWA | **✕ 標準 API 不在**(W3C 提案は 2011 年頓挫、後継なし) | △ Contact Picker(Chrome Android のみ、ワンショット) |
| サーバーサイド / MCP | ◎ プロトコル直 | ◎ CardDAV |

- **iCloud は CalDAV + app-specific password で外部からフルアクセス可**(Apple 公式
  サポート 102654 が正規手段として明記。OAuth 審査不要、ユーザー自身が発行/失効)。
  CardDAV(contacts.icloud.com)も同様。
- Google CalDAV v2 は現役だが OAuth 必須 + 機能制限(VTODO 非対応等)。実用は REST 推奨。
- **含意**: web/PWA/MCP から「ユーザーの現実のカレンダー全体」に届く汎用経路は
  **サーバーサイドのプロトコル/API アクセスだけ**。next-directions 方向性 H の
  (c)「agent 側横断」は iCloud に対して今すぐ実現可能 — 本作の戦略の強い裏付け。

出典: TN3153(EventKit iOS 17)、CNAuthorizationStatus.limited(WWDC24)、
developer.android.com(Calendar/Contacts Provider)、MDN Contact Picker、
w3.org/TR/calendar-api(頓挫の記録)、support.apple.com/102654、
developers.google.com/workspace/calendar/caldav/v2。

## 4. 採択途中 RFC への先行投資(調査③)

calext WG の現在の重心は **JSON 化(JSCalendar/JSContact)+ タスク拡張**。

### (a) 先行実装する価値あり

1. **VJOURNAL** — 実装コストほぼゼロ(コンポーネント1つ + component-set 宣言)なのに、
   **サーバー側対応の薄さが生態系のボトルネック**という構図(Nextcloud は UI どころか
   コレクション作成すら不可)。検証クライアントは jtx Board(Android + DAVx⁵)が存在。
   agentic 的再解釈: **agent の実行ログ・日誌を DTSTART 付きで時系列に置き、
   RELATED-TO でタスクに紐づける** — 長期ビジョン「agentic なタスク管理の基盤」の本丸。
2. **ical-tasks draft + RFC 9253(セットで)** — ical-tasks は **RFC Editor Queue 入り
   (数ヶ月内に RFC 化)** で、「自動化されたシステムによるタスク管理」を明示的にスコープに
   含む。ESTIMATED-DURATION / SUBSTATE(OK, ERROR, SUSPENDED)/ STATUS:PENDING, FAILED /
   REASON は **agent がタスクグラフを実行するランタイムの状態モデルそのもの**。
   9253(DEPENDS-ON / temporal 依存 / REFID / GAP)は単体採用ゼロだが ical-tasks が
   正規参照しており波は来る。競合実装ほぼ皆無 = 差別化。
3. **RFC 9074 ACKNOWLEDGED** — iOS 品質基準として「壊さず保存・往復」は実質必須級
   (現状の生値保持で既に満たしている — 06 A9 で実証済み。維持すること)。

### (b) 様子見

- **VAVAILABILITY(RFC 7953)** — 「agent が予定を入れてよい時間帯」の宣言として
  agentic スケジューリングと相性抜群(Cal.com の稼働時間概念と 1:1)。実装は
  Cyrus / Xandikos / Stalwart のみ、クライアント皆無。free-busy 実装(方向性 G-4 / B)の
  タイミングで一緒に。ドメインモデルが 7953 を排除しない設計だけ先にしておく。
- **JSCalendar(RFC 8984 → 2.0 が IESG 評価中)** — CalDAV 置き換えは5年スパンでも
  来ない(仕様自体が共存前提)が、**MCP/REST 入口の JSON 表現として有力**。
  変換 draft(jscalendar-icalendar)が WGLC 中なので RFC 化(2026 年内見込み)後に採用検討。
- RFC 9073(STRUCTURED-DATA)— 仕様に曖昧さ・errata。パースで壊さない、まで(現状で充足)。

### (c) 無視してよい

RFC 8607 / VPOLL / Series / Subscription Upgrades(expired)、
JMAP for Calendars のプロトコル実装(データモデルだけ借りる)。

出典: datatracker.ietf.org/wg/calext/documents、draft-ietf-calext-ical-tasks(RFC Editor
Queue)、draft-ietf-jmap-calendars-26、RFC 7953/8984/9073/9074/9253、
cyrusimap.org/imap/rfc-support.html、Xandikos README、jtx.techbee.at、
nextcloud/calendar#4436。

## 5. 統合: 本作の標準戦略(2026-07-11)

1. **capability を正直に宣言して絞る**: 全カレンダーコレクションに
   supported-calendar-component-set を明示(VEVENT / VTODO を基本、VJOURNAL は
   (4a) により**あえて含める** — iCloud/Google が切った場所を差別化として拾う)。
2. **意味計算はドメイン/application のユースケースが本体、プロトコルは薄いアダプタ**:
   `ListOccurrences(range, tz)` / `GetAvailability(range)` を第一級ユースケースにし、
   CalDAV expand(優先度低)/ free-busy-query(REQUIRED だが後回し可)/ MCP ツール /
   将来の REST(Google/JMAP 風の形)を同じユースケースの表面として生やす。
3. **agentic タスク管理のドメインモデルには ical-tasks + 9253 を先取りで織り込む**
   (SUBSTATE/REASON/DEPENDS-ON/REFID)。RFC 化前でも draft 準拠の X- なし実装が可能な
   段階(RFC Editor Queue)。
4. web/PWA に標準カレンダー API が無い世界線が続く前提で、**「プロトコルレベルの
   フルアクセス + サーバー側意味計算」を製品価値の核**として押す(09 §3)。

## 6. ユースケースの単一/横断2系統(2026-07-22 レイテンシ案2で追記)

§5-2 の第一級ユースケース `ListOccurrences(range, tz)` / `ComputeFreeBusy(range)` は
**単一コレクション専用**として実装した(DAV の calendar-query / free-busy-query REPORT は
コレクション URL に対して1つ、という RFC 4791 の粒度に素直)。一方 MCP の
list-events-expanded / get-freebusy は「calendarId 省略=カレンダーホーム全体を横断」が既定で、
最初は presentation(server.ts)が単一 UC をコレクション数 N 回呼んでマージしていた。

この N 回呼びは D1 往復を 3 波(①コレクション列挙 findAllByOwner + ②各コレクションの
sync_changes hydrate N+1 + ③各コレクションの time-range 取得 N 並列)に膨らませ、D1 プライマリから
遠い colo でレイテンシ主因になっていた。calendar_objects は owner 列を持つ(migrations/0001)ため、
**全横断はコレクション列挙なしで owner スコープの1クエリに畳める**。そこで横断専用の姉妹 UC を追加した:

- **ListOccurrencesAcrossOwner** — owner 配下の VEVENT を1クエリ展開。occurrence ごとに
  由来コレクション(calendarId)を併記して始点昇順マージ・truncated を OR 畳み込み。
- **ComputeFreeBusyAcrossOwner** — 同じく1クエリで busy を集計し、コレクションをまたいだ
  区間を末尾で横断 coalesce まで内包(旧 server.ts の手動 coalesce を吸収)。

ポートは `findByOwnerTimeRange(owner, kind, start, end, collectionIds?)`(undefined=全横断 /
集合=一部 / []=空)を追加。展開ループは両横断 UC で共有ヘルパー expandOwnerOccurrences に一本化した。
**単一 UC(ListOccurrences / ComputeFreeBusy)は DAV REPORT の第一級実装として不変のまま残す**
(RFC 粒度に対応する表面と、agentic の「全部見せる」表面を別 UC として疎結合に保つ)。
