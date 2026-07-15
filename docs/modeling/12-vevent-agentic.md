# 12. E-3: VEVENT の agentic 入口(設計・2026-07-15 Fable)

> 位置づけ: E-3(VEVENT ツール+アジェンダカード)の設計の正。実装が図と乖離したら
> 先にこちらを直す(CLAUDE.md)。E-2(todos)で確立した契約・UI 文法・楽観更新を
> **最大限流用**し、新規の発明を最小にするのが本設計の基本姿勢。

## §1 スコープと非スコープ

- スコープ: **自分の予定の CRUD**(create/update/delete/list)+ アジェンダカード。
- 非スコープ(理由つき):
  - **ATTENDEE/ORGANIZER(招待)** — 方向性 B の管轄。A(マルチユーザー)・K-1(iMIP)の
    依存を引き込むため混ぜない(next-directions の E-3 起票時に確定済み)。
  - **occurrence 単位の編集/削除**(この回だけ変更・EXDATE・detached override)— iOS の
    「このイベントのみ/以降すべて」ダイアログ相当。RECURRENCE-ID 書き込み経路が必要で
    複雑度が一段上がる。MVP は**マスター(系列)単位の CRUD のみ**とし、UI は反復
    occurrence の詳細に「繰り返し全体を編集」であることを明示する。実需が出たら別スライス。
  - **VALARM 付き作成** — VALARM 管理スライス(据え置き中)と同じテーマなので束ねる。
    MVP の create-event は VALARM を書かない(todo と違い、イベント通知の既定は
    クライアント設定側にもあるため優先度が低い)。
  - **get-event 詳細カード** — todos v3 でカード内詳細ページが確立したため、
    独立の詳細カードの必要性は下がった。起票のみ残す。
  - **「参加」ボタン(ビデオ通話)** — iOS は URL/CONFERENCE から参加 UI を合成する。
    カード内から外部リンクを開けるかは MCP Apps ホストの openLink 能力に依存するため、
    URL の保持・表示(下記スコープ入り)までを今回とし、参加アフォーダンスは起票。
  - **CONFERENCE(RFC 7986)** — 読み取り保持(lossless)は自然に満たすが、DTO 露出・
    書き込みは起票(7986 は docs/rfc 原文照合を先に行う規律の対象)。
  - **移動時間(X-APPLE-TRAVEL-DURATION)・通知(VALARM・予備の通知)** — 起票のみ
    (VALARM は既存の据え置きスライスと同束。移動時間は Apple 拡張で iOS 側の意味論調査が先)。

> **2026-07-15 更新(ユーザーフィードバック: iOS カレンダー編集画面との突き合わせ)**:
> **URL(RFC 5545 §3.8.4.6)をスコープに追加** — DTO に `url: string | null`、
> create-event に `url?: string`、update-event に `url?: string | null`(三値)、
> 詳細ページに URL 行(場所の下)。実装時は docs/rfc/rfc5545.txt の §3.8.4.6 原文を確認。

> **2026-07-15 更新2(ユーザー「全部欲しい」)**: 上の起票群を **S1.5(S1 直後の
> サーバースライス)+ S2 反映**へ昇格する。
> - **通知(VALARM)+ 予備の通知**: `alarms?: Array<{minutesBefore:number}>`(最大2件。
>   0=開始時刻・iOS プリセット語彙 5/10/15/30/60/120/1440/2880/10080 分前に UI が丸める)。
>   DTO は `alarms: number[]`(minutesBefore 列・表示順)。update は配列全置換 or null=全除去。
>   VEVENT の VALARM は相対 TRIGGER(-PT{n}M)で書く(todo の絶対 UTC トリガーとは意図的に
>   異なる — イベントは開始相対が iOS の語彙。実装時に docs/rfc 原文で TRIGGER 既定を確認)。
> - **移動時間**: `travelMinutes?: number | null`(X-APPLE-TRAVEL-DURATION、ISO 8601
>   duration で書く)。Apple 拡張のため iOS 実機での受理・通知連動は検証項目。
> - **参加(ビデオ通話)アフォーダンス(S2)**: URL があれば詳細ページ先頭に「参加」行
>   (lucide `video`)。開く手段は ext-apps の外部リンク API を調査し、不可なら URL テキスト
>   表示+コピーに degrade。iOS 自身も URL から参加 UI を合成するため CONFERENCE 書き込みは
>   引き続き起票のみ(読み取りは lossless 保持)。
> - **詳細ページの編集モデル**: iOS は閲覧画面でもカレンダー/通知を直接変更できるが、
>   我々の詳細ページは v3 で全フィールド編集ありき(read/編集の分離なし)なので**既に満たす**。

## §2 ツール語彙(todo 5 ツールと完全対称)

| ツール | 入力(要点) | 備考 |
|---|---|---|
| `create-event` | title 必須、start 必須、end?、isAllDay?、timeZone?、location?、notes?、recurrence?、calendarId?(既定 "calendar") | vevent-write ビルダー(vtodo-write と同型)。時刻付きは VTIMEZONE 生成(V6 と同経路・固定オフセット限定) |
| `create-events` | items: 上記の配列(≤25) | create-todos と同じバッチ規律・同じ validation 共有 |
| `update-event` | id + 部分更新(title/notes/location は 3値、start/end は due と同じ判別 union、recurrence は none=除去/全置換) | update-todo と同じパッチ経路(lossless read→patch・must-match PUT・孤立 VTIMEZONE 掃除) |
| `delete-event` | id, calendarId? | delete-todo と対称 |
| 照会 | 既存 `list-events-expanded` / `get-freebusy` | list-events-expanded に view echo(range)+ ui:// を追加 |

- **recurrence 入力は todo と同一 shape**(frequency none/daily/weekly/monthly/yearly +
  interval/weekdays/count/until、strict)。判別ロジックは normalize 関数を共有する。
- **start/end の形式は Task.due と同じ規約**: 終日 "YYYY-MM-DD" / 時刻付き
  "YYYY-MM-DDTHH:MM:SS"+timeZone。**end は iCalendar DTEND 準拠の排他的終端**
  (終日1日イベントは end 省略可 = DTSTART のみ。end 省略時の時刻付きは DTEND を書かない)。
  start > end は入力エラー。
- move(コレクション移動)は move-todo が VTODO 前提でないなら共用、前提が固ければ
  `move-event` を対称に(実装時判断。UC はコンポーネント非依存にできるはず)。

## §3 Event DTO(UI-ready・Task DTO と同じ規律)

```ts
Event = {
  id: string                 // マスター UID
  recurrenceId: string | null// 展開 occurrence の識別(この回の開始。マスター行は null)
  title: string
  start: string              // "YYYY-MM-DD"(終日) | offset ISO(イベント自身のゾーン)
  end: string | null         // 同形式・排他的終端。無し=null
  isAllDay: boolean
  location: string | null
  notes: string | null
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | null
  recurrence: TodoRecurrence 同型 | null   // chat 語彙 + degrade(生値)規約も同一
}
```

- `EventsViewModel = { events: Event[], calendarId, timeZone,
  range: { from, to }, affected?, removed? }` — TodosViewModel と同じ additive 契約。
  `range` は view echo(todos の view と同役割: 「この一覧はどの期間か」。mutate 応答は
  range を名乗らない = 防御の判別シグナル、の意味論も踏襲)。
- 展開は既存 RecurrenceExpansion(list-events-expanded の経路)を使い、
  **カードに渡すのは展開済み occurrence 列**(アジェンダは「いつ何があるか」の面であり、
  マスター行の面ではない)。mutate は id(マスター)単位。

## §4 アジェンダカード(ui://caldav/agenda.html)

- **意図**: 「期間の予定を俯瞰し、軽い CRUD をその場で行う」。1意図=1ツール=1テンプレの
  原則どおり list-events-expanded に紐付ける(todos カードとは別テンプレ・N:1 は mutate 系)。
- **構成**: todos v3 の文法を丸ごと流用 —
  - 一覧 = 日付見出しセクション(今日/明日/以降は「7/17(金)」形)。行 =
    [時刻帯(HH:MM–HH:MM / 終日)] タイトル 📍場所。becoming ラベルは meta 右端。
  - 行タップ=選択(タイトルインライン編集・選択解除=自動保存)/ ⓘ=カード内詳細ページ
    (‹ 戻る/保存・開始/終了の裸 input・終日トグル・繰り返し chips・場所・リスト›)。
  - FAB=インラインドラフト行(既定: 今日・終日)。Enter 連続追加。ⓘ で作成モード詳細。
  - 削除=行の左スワイプ。
  - 楽観更新・失敗ロールバック・バナー・位置記憶・sync レンズ(added/removed/completed 相当は
    added/removed のみ — イベントに完了は無い)も同じ機構。
- **実装配置**: `ui/agenda-entry.ts` + `ui/agenda-app.ts` を新設し、todos と共有できる
  純関数(日付整形・recurrence 整形・差分)は ui/ 内共有モジュールへ抽出
  (mcp-ui-is-terminal は ui/→ui/ を許容済み)。**共有カーネル戦略の実践第1号**
  (この抽出は将来の WebUI/Swift が使う contract 整形関数の種になる)。
- **アイコンは絵文字・文字グリフ禁止(2026-07-15 ユーザー確定)**: lucide のインライン SVG
  (`ui/icons.ts`・自己完結バンドルに埋め込み)を使う。例外は優先度の `!` 記号
  (iOS リマインダーの語彙 — ただし VEVENT に優先度行は無い)。todos カードも同基準に統一済み。

## §5 実装スライス

1. **S1(サーバー)**: vevent-write ビルダー + create-event(+s) / update-event / delete-event +
   Event DTO + EventsViewModel + list-events-expanded の view echo。ツール本数 14→18(+4)
   assert 3箇所。テストは update-todo/create-todo のテスト群と対称に。
2. **S2(カード)**: agenda テンプレ + entry(v3 文法流用)。S1 の契約に依存。
3. 起票のみ: occurrence 単位編集 / VALARM / get-event 詳細カード / move-event(S1 で
   共用できなければ)。

## §6 Swift コンパニオン(caldav-companion)との関係

- Event DTO / EventsViewModel は claude.ai カードと SwiftUI の**両方の消費者**を持つ前提で
  語彙を決めた(§3 は UI 技術非依存)。サーバー側に Swift 専用の変更は不要。
- R-6(OAuth scope 分離)は第三者クライアントが繋がる前提整備として優先度が上がった。
