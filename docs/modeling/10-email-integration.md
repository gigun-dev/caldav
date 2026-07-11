# メール統合(iMIP・予定抽出・Apple マークアップ)の調査(2026-07-11)

> **位置づけ**: 08/09 と同じ一次調査記録。発端はユーザーの
> 「iOS のメール→予定提案のような機能、Cloudflare のメール送受信、CalDAV の招待
> (メールアドレス)— agentic 管理では切り離せない関係では」。
> subagent 2本(①Cloudflare メール基盤 + iMIP 仕様 ②Apple 公式の開発者向け仕様)。

## 0. 結論サマリ

1. **「メール ⇄ カレンダー」は仕様レベルで本作と不可分**: `calendar-user-address-set` は
   mailto: が実質標準(RFC 6638 原文確認)、外部招待の完結には REPLY メールの受信処理が必須。
2. **Cloudflare は送受信両方が揃った**(受信 = Email Routing/Workers は GA・無料、
   送信 = Email Service が 2026-04 public beta)。**sabre/dav ですら受信側は外部
   ゲートウェイ任せ**だった「REPLY 受信 → iTIP 処理」をプラットフォーム内で完結できるのは
   OSS CalDAV サーバーキットとして明確な差別化。
3. **メールからの予定抽出は3レベル**(①ICS 添付 = 決定的 ②schema.org HTML = 決定的
   ③自然文 = LLM)。iOS の Mail 検出 API は非公開だが、**送信側マークアップ
   (Siri Event Suggestions Markup)は公式に存在**する — ただし予約8種限定 +
   Apple への申請制で、汎用の予定通知には **iMIP のほうが登録不要で確実**。

## 1. Cloudflare のメール基盤(2026-07 時点)

### 受信: Email Routing + Email Workers(GA・無料)

- 前提: **Cloudflare にゾーンがあるドメイン宛のみ**(1ゾーン 30 ドメインまで)。
  既存の Gmail 等は「Gmail 側の自動転送で CF アドレスに送る」が定石
  (転送で SPF/DKIM は崩れ ARC 依存になる点に注意)。
- Email Workers: `email()` ハンドラで raw MIME ストリームにアクセス可。
  postal-mime 等でパースすれば **ICS 添付も本文も読める**。受信上限 25 MiB。
  操作は forward / reply(DMARC pass の元送信者宛のみ)/ setReject。

### 送信: Email Service(2026-04 public beta)

- Worker の **`send_email` binding(資格情報レス)** / REST / SMTP(smtp.mx.cloudflare.net:465)。
  DKIM/ARC 自動署名。wrangler でローカルエミュレート可。
- 送信ドメインをオンボード(CF ゾーンなら DNS 自動設定)すれば**任意の外部宛先に送信可**。
  要 Workers Paid。**月 3,000 通込み、以後 $0.35/1,000 通** — iMIP 用途(数 KB の
  ICS 添付・低ボリューム)には十分。送信上限 5 MiB、宛先 50/通。
- **beta リスクのヘッジ**: 送信はポート化して Resend 等のアダプタに差し替え可能にする
  (本作のポート&アダプタ方針どおり)。iMIP の送信は受信 Worker の reply ではなく
  send_email binding で行う(reply は DMARC 制約があるため)。

## 2. CalDAV スケジューリングとメール(仕様確認)

- **RFC 6638 §2.4.1**(docs/rfc/rfc6638.txt で原文確認): `calendar-user-address-set` は
  REQUIRED。mailto: は必須ではない(principal URI も可)が、規格の例は全て mailto: で
  iOS との相互運用の実質標準。未設定ユーザーはスケジューリング無効。
- **iMIP(RFC 6047)**: iTIP メッセージ(METHOD:REQUEST 等)を
  `text/calendar; method=REQUEST` の MIME でメール送付するバインディング。
  外部 attendee の PARTSTAT 反映には **REPLY メールの受信・パースが必須**。
  ⚠️ **RFC 6047 の原文が docs/rfc/ に未収録 — 方向性 B 着手前にスナップショット追加**。
- 前例: sabre/dav は送信(IMipPlugin、PHP mail())のみで**受信は外部ゲートウェイ任せ**。
  Radicale は 6638 自体を非実装。→ 受信までキットで完結させる価値が大きい。

## 3. メールからの予定抽出(iOS「提案」の同等機能)

抽出は3レベルで整理する(下に行くほど信頼度が下がる):

| レベル | 内容 | 手段 |
|---|---|---|
| 1 | **ICS 添付 / text/calendar パート**(iMIP 含む、予約確認メールの多く) | 決定的パース。`@caldav/ical` がそのまま使える |
| 2 | **schema.org マークアップ付き HTML**(航空会社・ホテル等の確認メール) | JSON-LD/Microdata 抽出。決定的 |
| 3 | **自然文** | LLM(Workers AI / 外部)。信頼度低 → **「提案 inbox」承認制**にする(iOS の UX と一致。iOS 26 では検出イベントが Calendar inbox に集約される方向) |

- iOS Mail の検出(NSDataDetector 系)は**オンデバイスで API 非公開** — 任意の受信
  メールを iOS に解析させる口はない。自前で作るならメール転送 → Email Worker → 抽出。
- 完成品 OSS は不在(x.ai の Amy は 2021 終了)。設計指針の先行知見:
  「ルールベース抽出を主、LLM は狭いフォールバック。UID 固定 + list-before-write で
  重複防止」(Scalekit のチュートリアル)。

## 4. Apple 公式: Siri Event Suggestions Markup(送信側)

- **存在する**: developer.apple.com/documentation/sirieventsuggestionsmarkup/。
  メール HTML に schema.org の **JSON-LD / Microdata** を埋めると、iOS 14+ の Mail が
  バックグラウンド検出してカレンダー追加を提案。**送信側(本作)が実装するもの**で、
  受信側アプリの実装は不要。
- **制約が重い**:
  - 対応は**予約8種のみ**(Flight/Train/Bus/Boat/RentalCar/FoodEstablishment/Lodging/
    EventReservation)。**汎用 Event 型は無い**。
  - **Apple の Allow List への申請制**(developer.apple.com/contact/request/siri-events/)+
    **DKIM 必須・From ドメイン一致**。個人開発ドメインが通る基準は非公開。
  - 実機の Developer Settings で登録前のローカル検証は可能。
- 同一 `reservationId` の再送で更新、`ReservationCancelled` でキャンセル反映。
  Gmail の schema.org マークアップと語彙は同じで、フィールド差
  (Apple: reservationId / Gmail: reservationNumber 等)を併記すれば1つの JSON-LD で
  両対応可能(公式言及なしの実装知)。
- **本作での位置づけ**: 汎用の予定・招待は **iMIP(text/calendar 添付)が正道**
  (iOS Mail はこれもネイティブ処理し、登録不要で確実)。マークアップは「予約の体裁を
  持つ通知」を送る将来ユースケース(レストラン予約 agent 等)での加点要素。
  登録不要のフォールバック: 本文に明確な平文日時を書けばデータ検出は無登録で発火する。

## 5. 構成の絵(全部つながった場合)

```
外部ユーザー / Gmail転送
  ──メール──▶ Email Routing ──▶ Email Worker(email() ハンドラ)
                                  ├─ text/calendar(REPLY/REQUEST)
                                  │    → ProcessIMipMessage UC(iTIP → 予定更新)
                                  ├─ schema.org HTML → 決定的抽出 UC
                                  ├─ 自然文 → LLM 抽出 UC → 提案 inbox(承認制)
                                  └─ 不明 → reject / forward

CalDAV PUT(ORGANIZER+ATTENDEE)──▶ Scheduling UC ──▶ send_email binding
                                     (METHOD:REQUEST の iMIP 招待 + 平文日時
                                      + 将来: Siri マークアップ)──▶ 外部宛
```

application 層のユースケース(ProcessIMipMessage / 抽出 UC)を DAV 非依存に作れば、
MCP/REST 入口とも共存 — 長期ビジョン1(複数入口)と完全に整合する。

## 6. 未確定・次の宿題

- RFC 6047 の原文スナップショットを docs/rfc/ に追加(B 着手前)。
- ユーザーの受信用アドレス設計: calendar-user-address-set に CF 側 mailto: を置くか、
  Reply-To を CF アドレスにするか(A のユーザーモデルと絡む)。
- Email Service の GA タイミングを監視(beta 中は送信ポートの差し替え可能性を維持)。
- Siri マークアップの Allow List に個人開発ドメインで申請が通るかは、実際に
  送信ユースケースができた段階で試す(それまでは iMIP + 平文日時で足りる)。
