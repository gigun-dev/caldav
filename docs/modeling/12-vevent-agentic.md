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
>   > **2026-07-16 訂正(実機フィードバックで発覚・§7 参照)**: 「iOS 自身も URL から参加 UI を
>   > 合成する」は**実機未検証の仮定**だった(modeling/06 に実測項目なし)。実機で URL 付き
>   > イベントを開いても表示されない報告あり。RFC 5545 §3.8.4.6 も URL の form を標準化せず、
>   > 参加バナー化は Apple 非公開解釈。**iOS が何をトリガーにするか(URL 単体 / 特定ドメイン /
>   > RFC 7986 CONFERENCE)は実機検証が先**(§7・modeling/06 へ)。この行の断定は保留。
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

## §7 実機フィードバック反映(2026-07-16・アジェンダ/todos カード)

> 実機(claude.ai コネクタ + iOS ネイティブホスト swift-mcp-app)のフィードバックで、
> アジェンダカードのデータ整合の異常が複数報告された。3調査(Explore)で機序を特定し、
> Fable architect が統合修正を設計。**本番 D1 の生データは完全に正常**(単一マスター VEVENT +
> 平日 RRULE、重複/override/EXDATE なし)で、**バグは全てカード側の表示状態管理**だった。
> 以下は §3/§4 の実装規約を確定するもの(設計の正)。

### §7.1 UI の行同一性(id 単独キーの是正)

**症状**: 単発イベントを平日 RRULE に update-event で変更したら、展開された各日
(7/16・17・20・21)の occurrence 行が**全て「編集済み」バッジ**を帯び、しかも 🔁 が消えて
各日が別イベントの羅列に見えた。URL を足すと表示が正常に戻る(実装ムラ)。

**機序**: 展開 occurrence の id は全行マスター UID(event-dto.ts の eventFromOccurrence、
occurrence 識別は recurrenceId — §3 どおり)。だがカードが becoming/pending/楽観更新を
`id` 単独キーで引いていた(affectedById / pendingIds / optimisticEdits / optimisticDeletes、
events-diff-client の Map も同一 id を最後の1件に潰す)。→ affected はマスター UID 1件でも
同じ id の全 occurrence 行にヒット。

**確定規約(二層に分離)**:
- **行の同一性** = 合成キー `rowKey = id + "\0" + (recurrenceId ?? "")`。DOM の dataset・
  selectedId/swipeId の比較・描画の一意性はこのキー。ui/ 共有の純関数として新設(将来 todos は
  recurrenceId=null で同関数を使える — §4 共有カーネル方針)。
- **mutate・in-flight 状態** = マスター `id` 単位のまま(pendingIds / optimisticEdits /
  optimisticDeletes / affectedById)。**Why not 合成キー化**: mutate 粒度はマスター単位
  (§3「mutate は id(マスター)単位」)。系列への並行編集はサーバー上も同一リソースなので、
  pending がマスター単位で直列化するのは正しい。バグは「無言 no-op」の UX であってキーではない。
  → pending 中に系列の別 occurrence をタップしたら「保存中です」バナーで可視化する。
- **楽観適用のルール**: title/location/notes/url/alarms/travelMinutes(系列共通フィールド)は
  全 occurrence 行に適用。**start/end/recurrence の楽観適用は反復イベントではスキップ**
  (occurrence ごとに日時が違い、マスターの新値を全行に貼ると壊れる)。pending 表示のみで
  refresh 確定を待つ。
- **edited バッジの系列集約**: renderAll の1パスで `seenEditedIds: Set` を持ち、
  affected がヒットしても**最初の可視行にだけ**タグ/becoming-edit を付ける。他 occurrence 行は
  完全無装飾(最小・親裁定 2026-07-16)。
- **🔁 バッジ併記**: editPlan 中も繰り返しバッジを描く(agenda-entry.ts:563 の
  `&& editPlan == null` を recur バッジ条件から外す)。「系列が別イベントに見誤られる実害」の方が
  「編集中の情報過多」より大きい。

### §7.2 becoming の寿命

becoming(serverAffectedBase)は「導入した応答から、**次のユーザー起点更新**(手動 refresh・
range/calendar 切替・別 mutate・LLM 起点の ontoolresult)でクリア」と規定する。**mutate 成功
直後の自動 refresh-events では保持**(クリア経路を fetchLatest/ontoolresult に限定)。
→ 症状3(URL 追加後に affected 無し refresh が挟まってバッジ全消え→🔁 復活)の実装ムラを解消。

### §7.3 sync レンズ(computeSyncDiff)の粒度

diff は **id 単位グルーピング**に変更する。prev/next を `Map<id, occurrence[]>` にまとめ、
id の新規出現= added(代表 occurrence 1件)、id の消滅= removed、既存 id は edited(消費側で
捨てる規約は不変)。**Why not occurrence 単位 diff**: RRULE 変更で occurrence が大量増減すると
added/removed がノイズの洪水になる。系列単位の方がシグナルが高く、Map 潰しバグも同時に解消。

### §7.4 R-7 CAS の作り直し(§2 の must-match を訂正)

**§2 の update-event「must-match PUT」は ETag(リソース単位・If-Match 相当)を唯一の前提条件と
する。R-7 で入れたコレクション `sync_counter` の baseline 比較 CAS は廃止**し、採番は
`UPDATE ... SET sync_counter = sync_counter + 1` のアトミックインクリメントにする。
- **根拠**: RFC 6578 §3.2/§3.3(docs/rfc/rfc6578.txt 原文確認済)が要求するのは「sync-token は
  コレクションのプロパティで、応答は必ず新トークンを返す」こと。**トークンの単調性は counter の
  単調増加で保たれ、書き込みの CAS 比較粒度とは独立**。コレクション CAS は 6578 由来でなく
  実装都合の過剰ガードで、別リソースへの並行書き込みまで 412 にしていた(症状4=「変更を保存
  できません」トースト)。ETag 条件の意味論は RFC 7232。
- 同一リソース競合で 412 が出た場合、update-event UC 内で**1回だけ自動 re-read→re-patch**
  (パッチは意味的差分なので再適用安全)。2回目失敗は isError(R-7「素の 412」を最後の砦に残す)。
- modeling/13 §7(R-7 記述)も同時に訂正する。

### §7.5 iOS 実機検証に切り出す項目(実装より先)

1. **URL から参加バナーが合成されるか**(https / スキームなし `x.com` / meet URL で差があるか)。
2. **CONFERENCE(RFC 7986 §5.11・スナップショット照合済)** を書いた場合の iOS 表示(1 の結果次第)。
3. X-APPLE-TRAVEL-DURATION の受理・通知連動(既存起票の再掲)。
結果は modeling/06 へ記録。

### §7.6 サーバー小修正 + 運用

- **URL バリデーション**: create/update-event で `new URL()` parse 可能 + scheme 必須のみ
  要求(http/https に限定しない — §3.8.4.6 は URI の form を標準化しない)。既存の `URL:x.com` は
  不正データとして残す(lossless 保持・修正は手動)。
- **update-event description** に「通知・繰り返し・URL・移動時間も変更できる」を追記。
- **notifications/tools/list_changed は見送り**(stateless HTTP でデプロイ時に届ける生きた
  セッションが無い)。
  ~~運用手順として「デプロイでツール追加したら claude.ai 側で再接続」を残す。~~
  > 2026-07-17 更新: キャッシュバスティング機構(S1: ui:// の content-address 化 / S2: `/mcp/vN`
  > 版管理エンドポイント)を実装したことで運用フローを確定。通常のデプロイ(ツール追加含む)は
  > 何もしなくてよい(claude.ai のツール定義キャッシュは TTL 約1時間で自動反映され、カード UI
  > は hash 化 URI で自動伝播する)。即時反映が要る/破壊的変更/TTL バグで1時間超 stale が
  > 続く場合のみ、コネクタの接続 URL を `/mcp/vN` → `/mcp/v<N+1>` に差し替えて OAuth 再同意する
  > (「再接続」だけでは直らない報告が claude-ai-mcp#137 にあるため、URL 変更を確実な脱出口とする)。
  > 詳細運用は docs/next-directions.md 参照。

### §7.7 UI/UX 修正(todos/agenda に CSS/DOM 完全重複・共有化は今回見送り)

- 一覧メモ表示(デッドコード `.notes` 復活・非選択行 truncate)/ focus zoom 是正(全入力欄
  16px・表示テキストは据え置き)/ 完了タスクの優先度 `!` に line-through が乗る副作用解消
  (`.pri-inline { text-decoration: none }`)。
- title 垂直ズレ: row-main を `align-items: flex-start` + check に margin-top(head が伸びても
  title の1行目位置固定)。許容基準 =「メモ無し行の選択で『メモを追加』行が下に増える以外、
  title の上下移動ゼロ」。
- Done 位置: 行内 confirm を撤去しカード右上の単一 Done に(選択は常に高々1行)。
- ~~シマー完了合図: no-animation ドクトリンを緩めず、保存完了時にバナーで「保存しました」。~~
  > **2026-07-16 上書き(§7.8 ドクトリン v2):** 本項は撤回。ユーザー FB(done/undo/add の
  > フィードバックを統一・楽観/悲観をレイテンシで決める・指定秒アニメで手応え)を受け、
  > no-animation ドクトリンを「一過性・寿命付き・操作起点」に限り部分解禁する **§7.8** に置換。
  > **成功バナーは出さない**(成功は行の収束が既に語る = 二重通知)方針に変更。無限シマーも是正。
- **CSS/DOM 共有化は今回見送り**(S-A〜S-E で両ファイルが揺れる最中の共有化はレビュー不能な
  巨大差分になる)。今回**新規に書く純関数**(rowKey・系列グルーピング diff)のみ ui/ 共有配置。

## §7.8 操作フィードバック統一ドクトリン v2(2026-07-16・Fable 設計)

> todos v3 / agenda カードの全 mutate 操作フィードバックの設計の正。§7.7「シマー完了合図 =
> 保存完了バナー」項を上書きする。ユーザー FB(done/undo/add の統一・パフォーマンスで楽観/
> 悲観を決める・指定秒アニメで手応え+超過で警告)から生まれ、Fable architect が設計・
> ユーザー裁可済み。実測レイテンシは同日 observability 集計に基づく。

> **【現状ネットサマリ(2026-07-17 時点)— 層状の上書き(v2→v2.1→v2.2)を畳んだ「今の実装」】**
> 以下が現在コードが実際にやっていること。細部の経緯は下の v2.1/v2.2 積層を参照。
>
> - **todos は全操作が純・楽観(悲観パス無し)**: add / done / reopen(undo)/ edit / delete いずれも
>   タップ即・楽観適用。committing アニメは **クライアント固定タイマー(`animUntil` 満了=tap から 1.2s)**
>   で駆動し、**サーバー確定/transport は描画タイミングに一切関与しない**(v2.2 統括原理)。確定 vm は
>   state に載るだけで、満了タイマーの renderAll が一度だけ確定描画へ収束させる。**実失敗のときだけ**
>   ロールバック+エラーバナー。**「保存中…」等の待ち表示は無い**(v2.1 で撤去)。**T_hard 10s バナーも
>   撤去済み**(v2.2 item1・10s 超過は claude.ai transport 起因で Worker は実測 max 4s と判明したため)。
>   安全網は「失敗 → ロールバック+バナー」と「refresh/fresh-instance の確定描画」のみ。
> - **agenda(VEVENT)も見た目は完全に楽観と同一**: 「悲観」の実体は `editingIds`(旧 pessimisticIds)で、
>   **反復イベントの start/end/recurrence 変更のときだけ「その日時フィールドをローカルで楽観書き換えしない」**
>   という内部規律にすぎない(全 occurrence への誤った日時反映を避けるため)。表示語彙・アニメは楽観 edit と
>   完全同一(「変更」タグ・1.2s パルス→静的 becoming-edit タグ→確定 vm で差し替え)で、**ユーザーに悲観/楽観の
>   区別は見せない**(v2.1 E で「保存中…」静的タグを撤去)。title/location/notes/url/alarms/travelMinutes は
>   反復でも全 occurrence に楽観適用する。
> - **done/undo/add の演出**: done/undo = circle ポップ(scale 1→1.12→1)+ ring-pulse(accent≈35%・0→5px→0)を
>   committing 中だけ1周。満了後はリング無しの最終形(done=塗り円/undo=空円)へ収束(v2.2 item2=静的リング撤回)。
>   add = 左端バー+wake シマー(wake-sweep 1.2s)。位置不変(手動モード=既定)で add/done しても行は動かない。
>
> **【既知の未対応 UX(2026-07-17・Fable UX パスで対処予定)】**
> - **undo(reopen)アニメが done より知覚的に弱い**: コードは done と完全対称(同一 `.circle` に同一
>   ring-pulse+circle-pop・committing/resume も対称)で**発火はしている**が、undo の対象が「細い破線の空丸」で
>   視覚的重みが低く「アニメが消えた」ように読める(実機 FB 2026-07-17)。実バグでなく演出強度の設計問題。
> - **タスク詳細ページの「保存」と「完了」ボタンが二重意味で紛らわしい**(保存=編集確定 / 完了=タスク done)。
>   ラベリング/操作モデルの見直しが要る(iOS リマインダー詳細=「完了」はチェック・保存は自動、との整合含む)。
> - **claude.ai コネクタのカード/ツールが古い(キャッシュ)**: 静的 `ui://` URI + tools/list キャッシュで新デプロイが
>   反映されにくい。URI の content-address(hash)化の是非を Fable が web 調査中(別途 §/log 参照)。
>
> **2026-07-16 v2.1 上書き(本番実機 FB → Fable 再設計)**: v2 実装が実機で landing せず、
> 以下5点を上書きする(v2 本文は該当箇所に撤回注記を残す=ボツ案は財産)。核心の誤りは
> **「アニメの寿命」と「in-flight の真実」を同じ pendingIds に同居させたこと**。v2.1 は両者を分離:
> - **A(寿命分離+done 視認性)**: アニメ寿命を `animUntil: Map<id, startedAt+cycleMs>` に分離し、
>   tap から固定 1.2s を**必ず完走**(成功/失敗は pendingIds だけ delete・animUntil は満了タイマー
>   のみ消す)。サーバー確定はアニメを縮めも延ばしもしない(receipt であってインジケータでない —
>   NN/g「1s 未満はインジケータ不要」)。再描画耐性は inline `animation-delay: -経過ms` で途中再開。
>   done/undo の主役を 14% リング(check 円の青塗りに埋もれた)から **circle ポップ(scale 1→1.12→1)
>   + リング accent 約35%不透明 0→5px→0** に移す。
> - **B(add の位置)**: 連続追加は draft 行を**その位置のまま** optimistic 行に変え新 draft を直下に
>   出す(`anchorAfterId` でアンカー挿入・整列は確定後の再描画に委譲)。becoming-done の「押した
>   場所から行が消えると因果が切れる」原則の add への適用。
> - **C(タグ縦位置)**: becoming タグは常に rowMain 直下・**タイトル1行目基準**(check 円と同アンカー)。
>   metaHasContent 二枝(2026-07-15 応急処置)を撤回。
> - **D(優先度色バグ)**: `.title .pri-inline` の色指定を編集時の `.title-edit-row .pri-inline` にも
>   効かせる(編集で ! が orange→黒に落ちる純 CSS バグ)。
> - **E(悲観「保存中…」撤去)**: 判定則②は「**どのフィールドをローカルで書き換えないか**」の内部
>   規律としてのみ残し、**待ち表現(pending-edit「保存中…」)は廃止**。反復の日時/recurrence 変更も
>   表示は楽観と同一語彙(1.2s パルス→静的 becoming-edit タグ→確定描画で差し替え)。ユーザーが
>   要求しておらず(実機 FB)、静的タグが既に操作をマークしているため進行語は情報を足さない。
>   T_hard 10s バナーが唯一の安全網として残る。

### 結論

全 mutate 操作(done/undo/add/edit/delete、event CRUD)を単一ライフサイクルに載せる:
- **楽観パス(既定)**: タップ即、楽観適用 + **寿命1周(1.2s)の有限アニメーション** → 周期満了で
  **即座に静的 becoming へ収束**(overtime なし)。以降はバックグラウンドで確定を待ち、
  **実失敗のときだけ**ロールバック+エラーバナー。楽観は「もう確定した体で見せる」表現なので、
  途中に「保存中…」を挟むのは自己矛盾 — 待ち表示を持たない。
- **悲観パス(結果を予測できない操作のみ)**: 見た目は現状維持 + 1周アニメ → 確定まで静的な
  「保存中…」タグ(= overtime 表現はこちら専用)→ 確定描画。
- **共通**: T_hard = 10s 超過で警告バナー「保存に時間がかかっています」+「再読み込み」導線。
  **fetch の中断もロールバックもしない**(真実は次の refresh に委ねる)。成功トースト/バナーは
  出さない(バナーは失敗・例外専用)。

### 根拠

**一次資料(NN/g・原文確認済み)**:
- *Response Times: The 3 Important Limits*: 0.1s =「即時」限界 / 1.0s = 思考の流れが途切れない
  限界 / 10s = 注意持続の限界。実測分布では悲観 UI は 0.1s を構造的に満たせず p90 で 1.0s も
  超える → **既定は楽観**。10s が T_hard の根拠。
- *Progress Indicators*: 「待ち時間はアクションの瞬間に始まる」「1s 未満はインジケータ不要」
  「ループアニメは 2–10s 向け・終わりの見えない表示は不信を生む」→ **無限シマーは 1s 級操作に
  10s 超級の言語を使う誤り**(実機 FB #3「本当に通信できてる?」はこの違反の直接の帰結)。

**実測レイテンシ(Cloudflare observability・Smart Placement 後・POST /mcp・622件・7/15〜16)**:
p50=287ms / p90=1233ms / p95=1958ms / p99=2985ms。中央値は速いが裾が重い。
(注: 旧 p95≈1.16s(7/14)より高いが E-3 の event mutation(VTIMEZONE 生成)混在で同条件比較で
ない。Smart Placement 単体の改善は断定不可。)
→ 含意: ①0.1s バーを満たすのは楽観のみ = 楽観既定を強く正当化。②楽観は1周(1.2s)後に静的
収束し裾(p95≈2s)の確定は無表示で待てる。③失敗/T_hard 警告は分布の遥か外側でのみ発火。
④悲観パスの「保存中…」は p95 で1周後 約0.8s の表示で済む(許容)。

### 統一状態機械

```
idle
 └ tap ─► committing(0〜1200ms・寿命付きアニメ1周)
     ├ 楽観適用可 → 楽観レイヤ(optimisticToggle/Rows/Edits/Deletes)に積み即時再描画
     └ 楽観適用不可(悲観)→ 見た目現状維持 + in-flight 手掛かりのみ
     pendingIds は Set → Map<id, startedAt> に変更(唯一の構造変更)

── 楽観パス ──
committing 満了(1200ms)─► settled 表現(静的 becoming)に収束。以降は無表示で確定待ち
 ・fetch 成功 → 楽観レイヤ解除・confirmedTasks 再構築(表示は既に一致・becoming 寿命は §7.2)
 ・fetch 失敗 → ロールバック + エラーバナー(再試行付き・既存経路)

── 悲観パス【v2.1 で撤回】──
~~committing 満了 ─► waiting(静的「保存中…」タグ・amber/--muted・アニメなし)~~
（v2.1: 反復の日時/recurrence 変更も committing 満了 → 静的 becoming-edit タグに収束・確定描画で
 差し替え。楽観パスとの差は「optimisticEdits に日時/recurrence を積まない」内部規律だけで、
 表示語彙・待ち表現の分岐は持たない。失敗はバナーのみ・T_hard は共通経路。）

── 共通 ──
T_hard(10s)超過 ─► 警告バナー + 「再読み込み」(fetchLatest)。中断・ロールバックなし
 (中断後にサーバー側で成立していると UI が嘘になる。遅着した成功は既存の確定描画経路が整合)。
 「再試行」(mutate 再送)は二重書き込みリスクのため出さない。
```

**楽観/悲観の判定則(レイテンシ非依存)**:
1. クライアントが確定後の表示を正確に予測できる → 楽観(toggle・add・delete・title/notes/
   location/url 等の系列共通フィールド編集)。
2. 予測できない → ~~悲観(**反復イベントの start/end/recurrence 変更**)~~
   **【v2.1 上書き】** 反復の start/end/recurrence 変更は「ローカルに値を書き換えない」内部規律
   としてのみ残す(§7.1 の楽観スキップ = occurrence 展開はサーバーでしか成立しない技術事実は不変)。
   **表示は楽観と同一語彙**(1.2s パルス→静的 becoming-edit タグ→確定描画で差し替え)。「保存中…」
   等の待ち文言・pending-edit クラスは廃止(下記「悲観パス」ブロック・視覚表現表の最終行も撤回)。
3. LLM 起点の mutate(カード外)→ 対象外(ontoolresult の becoming 表示のみ・現行どおり)。

**視覚表現の対応表**:

| 操作 | committing(1.2s × 1) | 満了後 | 失敗 |
|---|---|---|---|
| add | `wake-sweep 1.2s linear 1`(現行 `infinite` を `1` に) | becoming-in 静的 wake | 仮行除去+バナー |
| done/undo **【v2.1】** | circle ポップ `scale 1→1.12→1` + リング `0→5px→0`(accent 約35%不透明)1.2s ease-out 1 | 静的 4px 凍結リング(既存 14%) | ロールバック+バナー |
| edit(楽観フィールド) | becoming タグ opacity pulse × 1 | becoming-edit 凍結表示(既存) | 同上 |
| delete | ゴースト行 opacity pulse × 1 | ゴースト静的(既存) | 行復活+バナー |
| ~~悲観(反復の日時/recurrence)~~ **【v2.1 撤回】** | (edit と同じ)タグ opacity pulse × 1 | **静的 becoming-edit タグ**(確定まで・「保存中…」は廃止) | バナーのみ |

- `prefers-reduced-motion`: committing のアニメを省き、~~楽観 = 最初から静的 becoming / 悲観 =
  最初から静的「保存中…」~~ **【v2.1】** 全操作で最初から静的 becoming(悲観も becoming-edit 静的)。
- aria-live(#live): 楽観 = settled 文言を即時 / ~~悲観 =「保存中」→確定文~~ **【v2.1】** 反復日時変更も
  becoming-edit 文言 / 失敗 = エラー文(既存)。
- **【v2.1】タグの縦位置**: becoming タグは常に rowMain 直下・タイトル1行目基準(check 円と同アンカー・
  `align-self:flex-start`)。meta の有無で配置を変える 2026-07-15 の二枝は撤回。
- **【v2.1】アニメ寿命 ≠ in-flight**: committing は `animUntil: Map<id, startedAt+cycleMs>` が管理し
  tap から固定 1.2s 完走(満了タイマーのみが消す)。pendingIds は in-flight ガード専用で成功/失敗に
  即 delete(アニメを縮めない)。再描画耐性は inline `animation-delay: -経過ms`。
- **【v2.1】add の位置**: draft 行を in-place で optimistic 行へ変換(`anchorAfterId` でアンカー挿入)・
  新 draft を直下に。整列は確定後の再描画に委譲(becoming-done の「その場に留め次回描画で移す」原則)。
- **浮遊層ゼロ維持**: 全表現が行内 CSS(box-shadow / background-position / opacity)。
  fresh-instance で再インスタンス化されれば pending 状態ごと消えて確定描画に戻る = 安全側。

### 定数(確定)

```ts
// src/presentation/mcp/ui/feedback.ts(共有・純関数 + 定数)
export const FEEDBACK = {
  cycleMs: 1200,        // アニメ1周期。skel pulse / wake-sweep と同一(視覚語彙なので固定)
  animCycles: 1,        // 寿命 = 1200ms(2026-07-16 ユーザー裁可: 2周案を取り下げ)
  hardTimeoutMs: 10_000 // Nielsen「注意持続」限界
} as const;
export const isCommitting = (now: number, startedAt: number): boolean =>
  now - startedAt < FEEDBACK.cycleMs * FEEDBACK.animCycles;
```
将来レイテンシが変わったら `animCycles`(整数)だけ動かす。全定数は可逆。

### ドクトリン v2 の線引き(todos-app.ts:374 付近へ追記)

- **解禁**: ①操作起点(このカード上でユーザーがいま起こした mutate に限る)②一過性
  (iteration-count 有限 = 1周・寿命満了で必ず静的形に収束)③情報を運ぶ(手応え/in-flight 告知)
  — の3条件を全て満たすアニメーション。
- **禁止のまま**: 持続アニメ(infinite)/ 自発アニメ(描画されただけで動く)/ "もう起きたこと"
  (静的 becoming)のアニメ化 / 成功トースト・成功バナー / 浮遊オーバーレイ。
- **楽観と悲観で待ち表現を分ける**: 楽観は待ち表示を持たない(1周→静的収束、失敗時のみバナー)。
  「保存中…」は結果を予測できない悲観操作専用。
- **Why not**: 無限シマー = 10s 超級の言語を 1s 操作に付け不信を生む(#3 実証)/ 成功トースト =
  行の収束が既に語る二重通知(§7.7 案の棄却)/ 楽観パスの「保存中…」= 確定/待機のメッセージ
  矛盾 / 持続アニメ = v1 の理由(ログノイズ + fresh-instance 再生誤読)がそのまま生きる。
- v1 コメント + 2026-07-14 shimmer 例外は**削除せず**「v2 で一般化されるまでの中間形」として残す。

### 実装スライス

- **F-1(共有カーネル)**: `ui/feedback.ts` 新設(FEEDBACK 定数 + isCommitting 純関数 + テスト)。
  CSS/DOM 共有は §7.7 判断を維持し今回もやらない(新規純関数・定数のみ共有 = rowKey と同じ規律)。
- **F-2(todos)**: pendingIds を `Map<string,number>` 化 / wake-sweep `infinite`→`1` / ring-pulse・
  opacity-pulse keyframes 追加 / committing 満了境界の再描画タイマー / T_hard バナー /
  reduced-motion 分岐 / todos-app.ts:374 に v2 コメント追記。**S-E(Done右上/title垂直)と統合**。
- **F-3(agenda)**: 同型移植。悲観パス(反復の日時/recurrence)が「保存中…」で待つこと、系列共通
  フィールドが楽観で1周収束することを確認。
- **F-4(docs)**: 本節配置(済)+ docs/log.md 経緯 + next-directions 更新。

順序 F-1 → F-2 → F-3 → F-4。F-2/F-3 は implementer 分離可。

### 計器 follow-up(本スコープ外・別スライス起票)

`{mcpTool, ms, colo}` console.log は Workers observability で **field クエリできない(未インデックス)**
ことが判明 — ツール別・colo 別レイテンシの計器として機能していない。**Analytics Engine
`writeDataPoint`(mcpTool/colo を blob・ms を double)への載せ替え**を別スライスとして起票。
本ドクトリンの `animCycles` 調整判断(ツール種別ごとの p95 追跡)はこの計器が前提。

## §7.8 v2.2 上書き(2026-07-16 実機FB第3波・Fable 再設計)

> §7.8 v2/v2.1 を上書きする第3波。**統括原理**: フィードバックの振り付け(いつ・何が・どう動くか)は
> すべてクライアントの固定タイマー/固定規則で決め、**サーバー確定・transport は振り付けに一切関与しない**
> (データの真実だけを運ぶ)。計器実測(POST /mcp 1874件: p50=254ms / p95=2069ms / **max=4036ms**)で
> Worker は最大4秒・10s 超過は claude.ai の MCP プロキシ transport 起因と判明。host ごとに transport の
> 桁が違う前提で、時間駆動の視覚イベント(T_hard・確定駆動の移動)を型から排する。

- **item 1 T_hard 廃止**: 「保存に時間がかかっています」(10s)を撤去。10s 超過の実体は transport で、
  楽観で done 済み表示の行に待ち表示を重ねても情報を運ばない(NN/g の 10s は「結果を待つ」文脈の限界で、
  楽観 UI に待ちは無い)。時間で発火する警告は host 非対称の下で原理的に成立しない(どの閾値も特定 host の
  配管を異常と誤報)。安全網=「fetch reject → ロールバック+エラーバナー」+「refresh/fresh-instance の
  確定描画」に一本化。FEEDBACK.hardTimeoutMs 削除・pendingIds は二重送信ガード/差分 degrade 専用に純化。
- **item 2 done リング pulse-out**: 一般則「**committing アニメは 0 で始まり 0 で終わる(定常状態に痕跡を
  残さない)**」。満了後の静的 14% リングを廃止し塗り円+取消線のみへ。ring-pulse は 0→5px(35%)→0。
  リングは進行の言語・塗り円は確定の言語で、確定形に進行記号を残さない。becoming の一過性マークはタグが単独で担う。
- **item 3 位置不変(=iOS「手動」表示順序モード・既定)**: add/done/undo/編集で位置を一切変えない。
  2026-07-14 確定仕様(positionMemory・当時未配線)を表示層の第一原理として完成(sectionizeManual)。
  ①初出時のみ naturalSection+単調採番(初回だけ compareTasks/completedDesc でクリーン整列)②以後は memory
  順のみ・サーバー応答/refresh は位置に作用しない ③done はその場で取消線(未完了ビューから抜けても stickyData
  で描き続ける)④唯一の例外=due 編集のセクション跨ぎ(dueSection で判定・done は completed 無視で不動)
  ⑤delete は消滅 ⑥完了済み <details> は「インスタンス誕生時に既に完了だった項目」専用(選択肢b)⑦クリーン
  再セクショニングはインスタンス境界(fresh render / view・calendar 切替)のみ。**v2.2 初案の linger→fade+
  collapse→完了欄合流は全面撤回**(サーバー確定駆動の移動を温存し本制約に反する。退場が無いので退場アニメ不要)。
  クロスインスタンスの並び安定は X-APPLE-SORT-ORDER(作成時刻・書込済)が担い新規永続化は不要。
  **sortMode="manual" の seam** を設置(将来の表示順序設定=§7.9)。inPlaceDone/pinnedAdded 特例は撤回。
- **item 4 FAB フロー化**: auto-height iframe では viewport 底辺=コンテンツ底辺で `position:fixed;bottom` は
  「固定でない固定」= add 時の一瞬のシフト源。リスト末尾(#root 直後)の通常フロー右寄せ(.fab-row)へ移し
  座標系の位相差を消す。**浮遊層ゼロが例外なしのドクトリンに**。draft/optimistic 行は通常行と同じ高さ骨格で予約。

**要実機検証(item 3)**: 位置不変の体感(done/add で不動)・done sticky が次 refresh で消えないか・FAB のフロー
位置が claude.ai/Swift で「右下」に読めるか・due 編集セクション跨ぎの受容・(b) の summary 件数。

> **2026-07-23 積層注記(C0-a′ 一時再導入 → 同日 (d′) 裁定で再撤回)**: item 3 ③「done はその場で取消線」に
> 反する形で、完了行を「3秒猶予 → 完了済みセクションへ移動」する退場機構(C0-a′・commit 1087c2e/0d6854f・
> `done-exit.ts` / `retiringDoneIds` / `exitingDoneIds` / `scheduleDoneExit` ほか)を一時再導入したが、
> **同日 (d′) 裁定(architect)で再撤回**した。裁定理由: (1) 時間駆動の視覚イベント(タイマー退場)を型から
> 排するのが v2.2 統括原理・item 3 の裁可線であり、C0-a′ はこれと真正面から矛盾する。(2) 「消える」旧 C0-a が
> 生んだ症状A(展開中に <details> ごと消滅)と、C0-a′ 自身が生んだ退行#5(resetPositionMemory がタイマーを
> 道連れにして done 行が3秒後に移動しない)の実績があり、状態機械の複雑さに見合わない。(3) iOS リマインダーの
> 「3秒猶予で完了済みへ移動」の 3000ms は一次資料に根拠が無い観測ベースの模倣で、ドクトリンを曲げる根拠にならない。
> **v2.2 item 3 が正のまま**。completedSummary(常時・有界サマリ)との二重表示排除は、退場タイマーではなく
> `positionMemory` の「所属判定」(`completed-dedup.ts` の `completedRowIsInBody`)= 時間非依存の純関数へ置換。
> 完了行はカードインスタンス生存中その場に留まり(取消線・再タップ undo)、次の fresh render / view・calendar
> 切替のクリーン再セクショニング(`resetPositionMemory`)で初めて completedSummary 側だけの表示へ移る。

## §7.9 表示順序設定(2026-07-16・Fable 設計・フォローアップ G)

> iOS リマインダーの表示順序(手動/期限/作成日/優先順位/タイトル・既定 手動)の対応物。§7.8 v2.2 の位置不変は
> 「手動モードの挙動」であり、他モードではソートキー変更で行が動くのは正常。**位置不変実装(sortMode seam)とは
> 独立の後続スライス**。

**採用(ハイブリッド)**:
- **手動順のデータ = 各 VTODO の `X-APPLE-SORT-ORDER`**(Apple と同一表現・create 時に作成時刻採番済み
  vtodo-stamp.ts・list-todos が第1キーで返済み)。iOS の手動並べ替えと双方向に相互運用。将来のドラッグ並べ替えは
  この値を PUT で書換(iOS 同経路)。
- **表示順序モード = コレクションの独自 dead property** `{https://gigun.dev/ns/caldav}todo-sort-order`
  (値 manual|due|created|priority|title・既定 manual)+ D1 カラム(NULL=manual)。RFC 4918 §4/§9.2 の
  PROPPATCH に乗る。**Apple の CalDAV 語彙にソートモードは無い**(modeling/06 B2 の 38 プロパティ実測に非包含=
  iOS はローカル保持)ため独自で正しく相互運用の損失ゼロ。サーバー(list-todos)は常に手動順で返し、モード別
  ソートは表示側(presentation)の関心。structuredContent に sortMode を additive 露出。
- **設定 UI**: ヘッダの in-flow 開閉パネル(浮遊層ゼロ準拠)で5択。**ドラッグ並べ替えは iOS の再採番挙動の
  実機観測後に別スライス**。
- **却下**: モードも手動順もコレクションプロパティ(iOS と二重管理分岐)/ クライアントローカル(fresh-instance で
  消える・host 間不共有)/ サーバーが mode で並べ替えて返す(位置不変・差分レンズの前提が揺れる)。

**実装スライス**: G-1(実機検証: iOS の手動並べ替え/モード変更が CalDAV にどう出るか・Proxyman)→ G-2(migration:
sort_mode カラム + CalendarCollection 属性 + PROPFIND/PROPPATCH)→ G-3(MCP 露出 + DTO の created 追加)→
G-4(カード設定パネル + モード別クライアントソート)→ G-5(ドラッグ並べ替え・G-1 観測待ち)。
namespace `{https://gigun.dev/ns/caldav}` はキット公開 API になるので切り出し時に再確認。
