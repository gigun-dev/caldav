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

## 方向性 F: M7 運用

- 上限系 precondition(max-resource-size 等の ServerPolicy 実装)、監視、バックアップ、rate limit。

## 小粒の残タスク(方向性に属さない申し送り)

- proxy の Content-Length 修正(2026-07-11、log.md)の Cloud Run 反映 `make deploy-proxy` が未実施
  (このマシンに gcloud CLI が無い。本番は GFE が CL を付与するため急ぎではない)。
- iOS 検証 A7(status 6868)が未誘発のまま(docs/modeling/06)。再現したら 06 に記録。

## 着手順の推奨

1. 方向性 A(M2 マルチユーザー)— A-1 のスキーマ設計から。権限表の織り込みを忘れない。
2. その途中で gcloud が使える環境になったら `make deploy-proxy` を消化。
3. A 完了後、B(招待)か E(agentic)かをユーザーに確認。
