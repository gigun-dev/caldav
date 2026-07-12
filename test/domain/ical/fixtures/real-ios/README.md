# real-ios フィクスチャ(iOS 26.5 実機キャプチャの生 ICS)

これらは **iOS 26.5 実機**(Cloud Run プロキシ経由の前作サーバー)へ PUT された
**生の iCalendar データをバイト列そのまま** 採取したもの。ICS は生データなので
ファイル冒頭にコメントを入れられない(コメント自体が ICS を壊す)。由来はここに記す。

- キャプチャ日: 2026-07-10(wrangler tail の `[CAP][req]` ログ 114 リクエストより)
- 発生元: iOS 26.5 の dataaccessd / remindd(User-Agent より)
- 検証計画: `docs/modeling/06-ios-behavior-verification.md`(A1〜A9)
- `.gitattributes` の `*.ics -text` で CRLF・折り畳みをオクテット単位で保持している。
  git の改行変換が入るとロスレス往復テスト(バイト一致)が壊れるため。

## ロスレス往復の2群

`roundtrip.test.ts` で検証。iOS の折り畳みアルゴリズムは本作 serializer と**位置が異なる**
(下記「折り畳みの実態」)ため、非 ASCII を含む長い行は parse→serialize でバイトが変わる。
そこでフィクスチャを2群に分けている:

- **オクテット等価群**(CANONICAL_REAL_IOS): 長い非 ASCII 行を含まず、iOS と本作の
  折り畳み結果が一致するもの。parse→serialize がバイト完全一致する。
- **冪等群**(FOLDED_REAL_IOS): 116B の日本語 SUMMARY 等、iOS が本作と違う位置で折る
  (または折らない)行を含むもの。バイト等価は不成立だが、
  parse→serialize→parse が構造 deepEqual(=意味論は保存、生値は保持)であることを検証する。

## 折り畳みの実態(A2、2026-07-10 実測)

iOS は物理行を**文字境界**で折る(マルチバイト UTF-8 を分割しない = RFC 5545 §3.1 推奨に準拠)。
ただし折る**しきい値・位置が本作 serializer(75 オクテット厳守)と一致しない**:

- `japanese-long-event.ics` の `SUMMARY`(116 オクテット、全て日本語)を iOS は**折らずに 1 行**で送った。
  本作 serializer は 75 で折る → ここでバイトが分岐する。
- 一方 `X-APPLE-STRUCTURED-LOCATION`(164B / 723B など ASCII 主体の長い行)は iOS も折る。
  観測した物理セグメントは 88B / 90B から始まり以降 73B 前後 — 75 厳守でもない。
- 結論: **iOS の折り畳みは「非 ASCII を含む値は折らない/寛容、ASCII 主体は折る」傾向**で、
  正確なしきい値は 75 固定ではない。本作は「格納時は生バイト保持、生成時のみ 75 で折る」設計
  なので実害はない(ロスレス往復は冪等性で担保。バイト等価は生成しない限り要求されない)。

## 各ファイルの由来と操作対応

| ファイル | 操作 | 内容 | 往復 |
|---------|------|------|------|
| `japanese-long-event.ics` | ① | 日本語長文 SUMMARY(116B)+ LOCATION 複数行 + X-APPLE-STRUCTURED-LOCATION + VALARM(-P1D)+ VTIMEZONE(Asia/Tokyo) | 冪等 |
| `weekly-recur-event.ics` | ③ | `RRULE:FREQ=WEEKLY;UNTIL=...`(FREQ 先頭)+ X-APPLE-TRAVEL-DURATION + VTIMEZONE | オクテット等価 |
| `attendee-invite-event.ics` | ⑦ | iOS の「出席者を追加」UI から作成したが **ATTENDEE / ORGANIZER / METHOD が一切付かない**(B9 の一次データ) | オクテット等価 |
| `vtodo-date-only.ics` | ⑩ | 期限日付のみリマインダーの初回 PUT。DUE すら無い最小 VTODO(STATUS:NEEDS-ACTION のみ) | オクテット等価 |
| `vtodo-completed.ics` | ⑫ | 完了操作。`STATUS:COMPLETED` + `COMPLETED:<UTC>` + `PERCENT-COMPLETE:100`。RFC 9074 の ACKNOWLEDGED は**使われない** | オクテット等価 |
| `vtodo-proximity-alarm.ics` | ⑬ | 位置情報リマインダー。VALARM に `X-APPLE-PROXIMITY:ARRIVE` + X-APPLE-STRUCTURED-LOCATION(geo)。TRIGGER は過去日時のダミー | 冪等 |
| `dquote-location-event.ics` | A7 第3ラウンド(2026-07-11) | 場所名に ASCII DQUOTE(スマート句読点オフで入力)。LOCATION 値には**生 DQUOTE がそのまま**、X-TITLE パラメータでは **iOS が DQUOTE を黙って除去**(RFC 6868 `^` は使わない)。キャプチャ経路は本作サーバー(caldav-dev.097969.xyz → wrangler dev) | 冪等 |
| `vtodo-recurring-master.ics` | D4 第3ラウンド(2026-07-12) | 反復 VTODO のマスター。`RRULE:FREQ=WEEKLY;UNTIL=...;BYDAY=SU,SA` + `DTSTART;TZID=Asia/Tokyo=DUE;TZID` + 時刻 VALARM + VTIMEZONE。反復完了で iOS が DTSTART/DUE を前進させる(06 D4) | 冪等 |
| `vtodo-recurring-completed-instance.ics` | D4 第3ラウンド(2026-07-12) | 反復 VTODO の完了スナップショット。**新 UID・RRULE 除去**・STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100 + その回の DTSTART/DUE + VALARM コピー。iOS の「マスター前進+スナップショット分離」モデルの片割れ | 冪等 |

**補足(第3ラウンド 2026-07-12)**: `vtodo-recurring-*` の2本は VTODO/リマインダー挙動検証
(docs/modeling/06 §D)で採取。キャプチャ経路は本作 dev サーバー(caldav-dev.097969.xyz →
wrangler dev)。位置情報を含まない(時刻アラームのみ)ため伏せ字化は不要。

## 伏せ字化(個人情報)

生キャプチャに含まれていた実在の位置情報を伏せ字化した(それ以外はバイトそのまま):

- `japanese-long-event.ics`: 末尾の `geo:35.463012,136.737202`(実在の緯度経度)→ `geo:0.000000,0.000000`。
- `vtodo-proximity-alarm.ics`: `geo:35.017639,136.954547`(自宅の実座標)→ `geo:0.000000,0.000000`、
  `X-TITLE=福登の自宅` → `X-TITLE=自宅`。
- メールアドレス(`gu.univ.morita@gmail.com`)は ICS ボディには現れず、CalDAV パスにのみ出るため
  ここでは対象外。
- `dquote-location-event.ics`(2026-07-11 追加): 末尾の `geo:35.461091,136.732539`(実在店舗の座標)
  → `geo:0.000000,0.000000`。店舗名・住所テキストは A7 の観測対象(DQUOTE の位置)そのものなので残置。
  X-APPLE-MAPKIT-HANDLE(base64、住所情報を内包)は前例どおり残置。

※ 伏せ字により冪等群 2 ファイルはバイト位置が変わったが、往復の検証レベルは元々「冪等」なので
  影響しない(オクテット等価は要求していない)。
