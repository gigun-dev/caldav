# 次セッションの方向性(2026-07-11 時点の棚卸し)

> **位置づけ**: 恒久ドキュメント(セッション引き継ぎの正典)。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` の引用ブロックを積層する。大きな節目でタイトルの日付を更新し
> 全体を棚卸しする。時系列の詳細ログ(何をしたかの生記録)は docs/log.md に追記する(そちらは追記専用アーカイブ)。

M1「足場固め」が完了した時点。検証フェーズは完了しており、プロダクトとしては序盤。
次のセッションは方向性 A(M2 マルチユーザー)から拾う。

## 今日までに完成しているもの(前提)

- **iCalendar ドメイン層**(RFC 5545): 構造層 + 値型コーデック + 意味論レンズ + 不変条件 I1〜I10。ロスレス往復。
- **CalDAV リソース層**: 3集約(Principal / CalendarCollection+SyncChange / CalendarObjectResource)+ put-preconditions R1〜R7。
- **フルスタック稼働**: application / infrastructure(D1) / presentation(DAV XML + Basic Auth)。
  本番 = Worker `caldav.gigun-dev.workers.dev` + Cloud Run 書き換えプロキシ(iOS 正式入口・恒久構成)。
- **iOS 実機検証 2ラウンド完了**(docs/modeling/06)。残 🔶 は A7(6868 未誘発)のみ。
- **M1 足場固め**: CI(境界→tsc→test)/ Workers Builds 自動 deploy / ETag 412 テスト /
  ローカル開発環境(Makefile + cloudflared tunnel + iPhone 実機接続実証)/ pre-push hook で main 保護。
- 203+ tests / tsc green。認証方式の調査済み(docs/modeling/07 が M2 一次資料)。

## 方向性 A: M2 マルチユーザー(次の本命)

- **発端**: 現状は単一ユーザー Basic(secrets 直)。スケジューリング(方向性 B)の前提。
  secret 消失障害(2026-07-10、log.md)の本質解決でもある(D1 salt付きハッシュへ移行)。
- **確定した方針**(docs/modeling/07): Basic over HTTPS + App Password が業界デファクト。
  32文字級サーバー生成 → Argon2id/bcrypt で D1 保存 + レート制限。OAuth は方向性 E まで持ち越し。
  iOS アカウント追加は .mobileconfig 配布を正式ルート(App Password 発行 → ワンタイム URL で
  プロファイル DL。平文が入るので HTTPS + 使い捨て URL 必須、署名は後回し可)。
- **タスク分解**:
  - A-1: ユーザー / App Password の D1 スキーマ + principal 複数化。
    **方向性 D の先行準備を織り込む**: コレクション×principal の権限表
    (current-user-privilege-set を実データ化 — ここを逃すと D で手戻り)。
  - A-2: 認証ミドルウェアの差し替え(Argon2id 検証 + レート制限)。
  - A-3: App Password 発行フロー + .mobileconfig ワンタイム配布。
  - A-4: プロキシ内部認証を共有シークレット → HMAC 署名へ格上げ(OSS 公開時までに)。

## 方向性 G: 意味計算(RRULE 展開・TZ 解決・free-busy)— A と同格以上の新本命

> **2026-07-11 起票**: agentic 入口(E)の中核能力は「イベントの理解」と「free-busy」
> というユーザー判断により、A と同等かそれ以上のスコープに昇格。
> 一次資料は **docs/modeling/08**(RFC 義務・競合実態・TZ 流派・コスト試算まで調査済み)。

- **発見**: time-range フィルタの RRULE 展開は RFC 4791 の MUST(calendar-query 自体が
  REQUIRED、非対応表明は不可)。現状は厳密には RFC 非準拠 = コア価値に照らしいずれ必須だった。
  一方 CALDAV:expand / free-busy-query は実クライアントがほぼ使わない(Google すら
  free-busy 未実装)— 「iOS のためでなく RFC 準拠と agentic のために作る」機能。
- **確定した設計判断**(08 §6): TZ は IANA tzdb を正・VTIMEZONE は保存のみ /
  RRULE 反復は ical.js をアダプタ内側に採用(rrule.js は不採用)/
  sabre 式 first/last occurrence 索引を D1 に(PUT 時計算)+ REPORT 時にヒット行のみ展開 /
  展開済みテーブル・KV/Cache キャッシュ・DO は不採用 / 展開上限を API に組み込む。
  コストは実質 $5/月の基本料のみ(CPU-ms 課金、詳細試算は 08 §5.5)。
- **タスク分解**:
  - G-1: TZ 解決層(IANA 名直引き → Windows 名マップ → VTIMEZONE 推測 → 明示エラー。
    Workers の Intl/ICU 利用)+ floating/DATE の実効値算出(§9.9 の表)。
  - G-2: RecurrenceExpansion ドメインサービス(03 §1-4 の輪郭どおり、ical.js アダプタ +
    オーバーライド解決 + 展開上限)。
  - G-3: first/last occurrence 索引(D1 スキーマ。A-1 と統合するか要判断)+
    calendar-query の time-range フィルタ(方向性 C の中核が前倒しでここに来る)。
  - G-4: free-busy 計算ユースケース + free-busy-query REPORT(TRANSP/STATUS → FBTYPE)。
  - G-5: MCP 照会ツール(list-events-expanded / get-freebusy / get-current-time)—
    E の先鋒。application 層の共通ユースケースを DAV と MCP の両入口から呼ぶ実証。
- 単一ユーザーのままで完結する(A に依存しない)。ドッグフーディング優先なら A より先。

> **2026-07-11 更新(docs/modeling/09 起草)**: 標準戦略の調査により優先度を補正 —
> ①CALDAV:expand は実は REQUIRED でない(calendar-data の子要素)+ iOS はクライアント
> 展開する → 優先度低。②free-busy-query は REQUIRED だが実クライアントは叩かない →
> 後回し可。③「展開・availability」はモダン API(Google/Graph/JMAP)の第一級機能で、
> Nextcloud/Cal.com も本気の計算はアプリ層でやっている → G-5(MCP 表面)の設計は
> 09 §1 の共通形(時間窓必須 + 応答TZ分離 + JSON busy区間)に従う。
> ④supported-calendar-component-set の明示宣言を G のタスクに追加(宣言しないと
> 「全コンポーネント MUST accept」— VJOURNAL を**含めて**宣言する。09 §4a 参照)。

## 方向性 J: 採択途中 RFC への先行投資(agentic タスク管理の本丸)

> **2026-07-11 起票**: 「使われていない RFC を切る」だけでなく「採択途中の RFC で
> 先行者になる」逆張り(ユーザー方針)。一次資料は **docs/modeling/09 §4**。

- **VJOURNAL**: 実装コストほぼゼロでサーバー側対応の薄さが生態系のボトルネックそのもの。
  「agent の実行ログ・日誌を時系列に置き RELATED-TO でタスクに紐づける」— 長期ビジョン
  「agentic なタスク管理の基盤」の本丸。検証クライアントは jtx Board + DAVx⁵。
- **ical-tasks draft(RFC Editor Queue 入り、数ヶ月で RFC 化)+ RFC 9253**:
  SUBSTATE(OK/ERROR/SUSPENDED)・STATUS:PENDING/FAILED・REASON・ESTIMATED-DURATION・
  DEPENDS-ON・REFID は agent のタスクグラフ実行ランタイムの状態モデルそのもの。
  競合実装ほぼ皆無 = 差別化。ドメイン層(vtodo.ts 系)に先取りで織り込む。
- RFC 9074 ACKNOWLEDGED は生値保持で既に充足(06 A9)— 壊さない状態を維持。
- VAVAILABILITY(7953)は G-4/B のタイミングで、JSCalendar は変換 draft の RFC 化後に
  MCP/REST の JSON 表現として検討(09 §4b)。

## 方向性 B: M3 スケジューリング(招待)

- RFC 6638/5546。schedule-inbox/outbox、calendar-user-address-set、iTIP 処理、auto-schedule。
  B9 実測どおり、これが無いと iOS は招待 UI を出さない。方向性 A が前提。
- サーバー内ユーザー間 → 外部宛は iMIP(RFC 6047、メール送信)。ドメインの輪郭は docs/modeling/03 §3 に定義済み。

## 方向性 C: M4 他クライアント対応

- calendar-query REPORT + RecurrenceExpansion(iOS は sync-collection だけで足りるが
  Thunderbird / tsdav 系は query を使う)。
- **tsdav は CI にも使える**: 探索→作成→同期→削除の互換性テストハーネスにすれば
  iOS 実機なしで回帰検知できる(方向性 E の Web フロント採用予定とも噛み合う)。

## 方向性 D: M5 共有・委任

- caldav-proxy / calendarserver-sharing(非 RFC の Apple 拡張)。方向性 A が前提。
- 先行準備: ①draft 原文を docs/specs/ に常備(docs/rfc と同じ思想)
  ②権限表スキーマは A-1 に織り込み済み ③read-only privilege 時の iOS 挙動検証は単一ユーザーのままでも可能。

## 方向性 E: M6 agentic 入口(長期ビジョン本命)

- MCP / REST アダプタ(application 層は DAV 非依存済み)、Web フロント(tsdav 採用想定 —
  ブラウザ直 CalDAV なら Worker に CORS + DAV メソッドの preflight 対応が必要)、メール起点のタスク追加。
- OAuth(Bearer)はここで導入(docs/modeling/07)。
- A の後に B と E のどちらを先にするかはユーザー判断(招待 vs agentic)。

## 方向性 H: フルカレンダーアクセス / 外部データ集約(構想段階)

> **2026-07-11 起票(ユーザー構想)**: 本質は「**カレンダーを極める(free-busy を本気で
> 提供する)なら、ユーザーの現実のカレンダー全体へのアクセスが要る**」という製品上の
> 現実的制約。本作サーバー上のイベントだけの free-busy は、生活が iCloud/Google にも
> 分散しているユーザーには**嘘の空き時間**を返す。プロダクトにするなら欲しい視点。

- 選択肢の整理(2026-07-11 時点):
  - (a) ユーザーの完全移行前提 — ドッグフーディングでは現実的、プロダクトでは高いハードル。
  - (b) サーバー側集約 — 本作が CalDAV クライアントとして外部(iCloud/Google)を購読し
    free-busy を合成。calendarserver:source / subscribed(06 B2 で iOS が問い合わせて
    くるのを実測済み)とも接続しうる。
  - (c) **agent 側横断** — 「CalDAV client for agent」(ペルソナ確認済み)を任意のサーバーに
    向けられる汎用クライアントにし、本作 + iCloud + Google を agent が横断して合成。
    E の設計と最も自然に噛み合う。OS の カレンダー権限(iOS/Android)に依存しない
    プロトコルレベルのアクセスという利点も。
    > **2026-07-11 更新(09 §3)**: プラットフォーム調査で (c) の裏付けが取れた。
    > web/PWA には標準カレンダー API が存在せず(W3C 提案は 2011 年頓挫)、
    > **iCloud は CalDAV + app-specific password で外部からフルアクセス可**(Apple 公式の
    > 正規手段)。web/MCP から現実のカレンダー全体に届く汎用経路はプロトコルアクセスのみ。
> **2026-07-11 更新:** CardDAV は当初ここに同居させたが、別の関心事なので方向性 I に分離
> (ユーザー指摘)。H は「ユーザーの現実の予定全体を見る」問題、I は「連絡先という別
> ドメインの解釈」問題。

## 方向性 I: CardDAV / 連絡先(構想段階)

> **2026-07-11 起票(ユーザー構想、H から分離)**

- 動機: ①マルチユーザー/スケジューリングで招待相手の解決に連絡先が欲しくなる
  ②iOS は vCard の誕生日は自動でカレンダーに拾うが**記念日は拾わない** — CardDAV を
  解釈できれば記念日も把握できる(vCard 解釈 → 仮想イベント生成は方向性 G の親戚)。
- 追い風: CardDAV(RFC 6352)は WebDAV 基盤(4918/principal/sync 6578)を CalDAV と共有、
  vCard は content-line 文法が iCalendar と同族 — structure 層・DAV XML はかなり流用可。
  OSS キットの「DAV サーバーキット」への一般化と整合。
- 論点: iOS の連絡先は Apple 拡張(X-ABDATE + X-ABLabel の記念日表現等)が濃い。
- 位置づけ: B/E より後。着手前に 08 と同様の一次調査(RFC 6352 スナップショット +
  iOS 実機の CardDAV 挙動観測)を行う。

- 追い風: CardDAV(RFC 6352)は WebDAV 基盤(4918/principal/sync-collection 6578)を
  CalDAV と共有し、vCard の content-line 文法は iCalendar と同族(BEGIN:VCARD、折り畳み、
  パラメータ)— **本作の structure 層・presentation の DAV XML はかなり流用できる**見込み。
  OSS キットの「DAV サーバーキット」への一般化と整合。
- 論点: iOS の連絡先は Apple 拡張(X-ABDATE + X-ABLabel の記念日表現等)が濃い。
  誕生日/記念日 → カレンダー化は「vCard を解釈して仮想イベントを生成する」意味計算
  (方向性 G の親戚)になる。
- 位置づけ: B/E より後の検討。着手前に 08 と同様の一次調査(RFC 6352 スナップショット +
  iOS 実機の CardDAV 挙動観測)を行う。

## 方向性 F: M7 運用

- 上限系 precondition(max-resource-size 等の ServerPolicy 実装)、監視、バックアップ、rate limit。

## 小粒の残タスク(方向性に属さない申し送り)

- ~~proxy の Content-Length 修正(2026-07-11、log.md)の Cloud Run 反映 `make deploy-proxy` が未実施
  (このマシンに gcloud CLI が無い。本番は GFE が CL を付与するため急ぎではない)。~~ ✅
  > **2026-07-11 更新:** gcloud CLI 導入により `make deploy-proxy` 実施。リビジョン
  > `caldav-proxy-00003-dsz` へ切替済み、OPTIONS 疎通確認 OK(DAV ヘッダが Worker まで貫通)。
- ~~iOS 検証 A7(RFC 6868)が未誘発のまま(docs/modeling/06)。再現したら 06 に記録。~~ ✅
  > **2026-07-11 更新:** 第3ラウンドで決着(06 の A7 参照)。iOS はパラメータ値の DQUOTE を
  > **黙って除去**し RFC 6868 `^` エンコードは使わない。6868 実装は不要と確定。

## 着手順の推奨

1. 方向性 A(M2 マルチユーザー)— A-1 のスキーマ設計から。権限表の織り込みを忘れない。
2. その途中で gcloud が使える環境になったら `make deploy-proxy` を消化。
3. A 完了後、B(招待)か E(agentic)かをユーザーに確認。
