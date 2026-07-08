# O: オブジェクト図

> SUDO モデリングの「O」。ドメインモデル図(03)の妥当性を、具体的なインスタンスで検証する図。
> 「モデルが実データを表現できるか」をここで確かめてから実装に入る。
> 題材は iOS 実機が実際に送ってくるデータに寄せている(前作の E2E テストで観測済みのパターン)。

## ケース1: iOS リマインダーが作った期限付きタスク

iOS リマインダーで「牛乳を買う(明日期限・優先度高)」を作ると、おおよそ次の ICS が PUT される:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iOS 18.0//EN
BEGIN:VTODO
UID:9A0C…-….ics
DTSTAMP:20260708T001000Z
DUE;TZID=Asia/Tokyo:20260709T090000
SUMMARY:牛乳を買う
PRIORITY:1
STATUS:NEEDS-ACTION
X-APPLE-SORT-ORDER:740609730
END:VTODO
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
…
END:VTIMEZONE
END:VCALENDAR
```

```mermaid
graph TB
    res["<b>CalendarObjectResource</b><br/>uri = '9A0C….ics'<br/>etag = ETag('sha256:…')<br/>componentKind = VTODO"]
    ical["<b>ICalendarObject</b><br/>prodid = '-//Apple Inc.//iOS 18.0//EN'<br/>version = '2.0'"]
    vtodo["<b>VTodo</b>(意味論レンズ)<br/>uid = Uid('9A0C…')<br/>due = CalDateTime(TZID=Asia/Tokyo, 2026-07-09 09:00)<br/>priority = 1 / status = NEEDS-ACTION"]
    xprop["<b>Property</b>(汎用構造のまま保持)<br/>name = 'X-APPLE-SORT-ORDER'<br/>value = '740609730'<br/>※意味は解釈しないが往復で返す"]
    vtz["<b>VTimezone</b><br/>tzid = 'Asia/Tokyo'<br/>※不変条件 I8: DUE の TZID の参照先"]
    res --> ical
    ical --> vtodo
    ical --> vtz
    vtodo --> xprop
```

**検証ポイント**: `X-APPLE-SORT-ORDER` のような未知プロパティが、型付きレンズ(`VTodo`)の
下にある汎用構造(`Property`)として生き残ること。これが表現できないモデルは iOS 対応で破綻する。

## ケース2: 繰り返し予定+1回だけ時間変更(同一 UID の複数コンポーネント)

「毎週火曜 10:00 の定例。ただし 7/14 の回だけ 14:00 に変更」。
1つのリソース(1 UID)に VEVENT が **2つ** 入る — マスターとオーバーライド。

```mermaid
graph TB
    res["<b>CalendarObjectResource</b><br/>uri = 'weekly-sync.ics'"]
    ical["<b>ICalendarObject</b>"]
    master["<b>VEvent(マスター)</b><br/>uid = 'weekly-sync'<br/>dtstart = TZID=Asia/Tokyo 2026-07-07 10:00<br/>rrule = RecurrenceRule(FREQ=WEEKLY;BYDAY=TU)<br/>sequence = 0"]
    override["<b>VEvent(オーバーライド)</b><br/>uid = 'weekly-sync' ※同一 UID(不変条件 R3)<br/>recurrenceId = RecurrenceId(2026-07-14 10:00)<br/>dtstart = 2026-07-14 <b>14:00</b><br/>sequence = 1"]
    res --> ical
    ical --> master
    ical --> override
```

`RecurrenceExpansion.expand(master, [override], 7月の範囲)` の結果:

| occurrence | recurrenceId | 実効 start | 出どころ |
|-----------|--------------|-----------|---------|
| 1 | 07-07 10:00 | 07-07 10:00 | マスターの RRULE 展開 |
| 2 | 07-14 10:00 | **07-14 14:00** | オーバーライドが差し替え |
| 3 | 07-21 10:00 | 07-21 10:00 | マスターの RRULE 展開 |

**検証ポイント**: 「同一 UID のコンポーネントが複数」はモデル上の異常ではなく正規の状態。
`recurrenceId` の有無でマスター/オーバーライドを判別できる。

## ケース3: sync-collection による差分同期(集約横断の整合性)

初回同期後(syncToken=3)に、iOS がタスクを1件完了にし(PUT)、1件削除(DELETE)した状態:

```mermaid
graph TB
    cal["<b>CalendarCollection</b><br/>id = 'reminders'<br/>supportedComponents = [VTODO]<br/>syncToken = SyncToken(5) ※2操作で 3→5<br/>ctag = CTag('…') ※syncToken と同時に更新"]
    c1["<b>SyncChange</b><br/>uri = 'buy-milk.ics'<br/>kind = modified / at token 4"]
    c2["<b>SyncChange</b><br/>uri = 'old-task.ics'<br/>kind = deleted / at token 5"]
    obj1["<b>CalendarObjectResource</b><br/>uri = 'buy-milk.ics'<br/>payload.vtodo.status = COMPLETED<br/>etag = ETag('sha256:新しい値') ※R5"]
    obj2["(old-task.ics は既に存在しない。<br/>SyncChange だけが削除の証拠として残る)"]
    cal --> c1
    cal --> c2
    c1 -.-> obj1
    c2 -.-> obj2
```

クライアントが token 3 の sync-token で REPORT すると: `buy-milk.ics`(200 + 新 etag)と
`old-task.ics`(**404**)が返り、token 5 を表す新しい sync-token を受け取る。
※RFC 6578 §3.2 原文照合済み — 削除済みメンバーのステータスは 404(前作の 410 は誤りと確定)。
※sync-token の公開形式は URI であることが MUST(§3.2)。内部整数 5 は
`https://{host}/ns/sync/5` のような URI にラップして返す。初回同期は「空の DAV:sync-token 要素」。

**検証ポイント**: 「PUT/DELETE の1操作 = syncToken の1増分 + SyncChange 1件 + ctag 更新」が
アプリケーション層の1トランザクションで成立すること(集約横断整合性の設計決定の確認)。

## ケース4: iOS のアカウント追加時の探索(Principal まわり)

```mermaid
graph LR
    wk["GET /.well-known/caldav<br/>→ 301 /dav/"]
    root["PROPFIND /dav/<br/>→ current-user-principal =<br/>/dav/principals/alice/"]
    prin["<b>Principal</b><br/>principalPath = '/dav/principals/alice/'<br/>calendarHomeSet = '/dav/calendars/alice/'"]
    home["PROPFIND /dav/calendars/alice/ Depth:1<br/>→ CalendarCollection 一覧<br/>(VEVENT 用 / VTODO 用)"]
    wk --> root --> prin --> home
```

**検証ポイント**: Principal は認証コンテキストが解決したユーザーと 1:1 で、
CalDAV コンテキストからは URL(principalPath)と calendarHomeSet しか見えない。
認証方式(better-auth か否か)がこの図に一切現れないことを確認。
