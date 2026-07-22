---
name: ios-device-verification
description: iOS 実機(カレンダー/リマインダーアプリ)でこの CalDAV サーバーを検証する手順。実機検証・iPhone 接続・tunnel/proxy/dev の起動・接続情報の組み立てを頼まれたときに使う。
---

# iOS 実機検証

## 実機の前に: iOS Simulator でも検証できる(2026-07-22)

- Simulator の 設定 → カレンダー(またはリマインダー)→ アカウント追加 → その他 → CalDAV で
  本サーバーを登録すれば、標準アプリでのサーバー検証(URL/CONFERENCE 表示・通知・移動時間など)は
  **Simulator で自走できる**(実機必須ではない)。接続情報の組み立ては下記と同じ。
- 実機だけが必要なのは、push 系・実機固有の挙動(省電力・バックグラウンド同期の実タイミング等)を
  見たいときのみ。

## 前提(重要)

- **Claude の実行環境では常駐プロセス(dev/proxy/tunnel)を起動しない**(Makefile 冒頭の注記)。
  起動はユーザーの端末で行う。Claude の仕事は「起動コマンド・接続情報・期待結果」を
  **セットで**ユーザーに渡すこと(「実機で試して」だけで終わらせない)。

## 構成(3プロセス)

```
iPhone → cloudflared named tunnel(固定 URL)→ 書き換え proxy :8080 → wrangler dev :8787
```

proxy は workerd が通せない MKCALENDAR を書き換えるために必須。

## ユーザーに渡す起動手順

1. `make up`(dev+proxy+tunnel を1ターミナルでまとめて起動。個別なら別ターミナルで
   `make dev` / `make proxy` / `make tunnel`)
   - 全リクエストダンプが要る調査なら `make up DUMP=1`
2. 初回またはローカル D1 リセット後: `make migrate-local` → `make seed`(dev 起動中に)
3. iOS アカウント設定を楽にするなら `make mobileconfig` で .mobileconfig 生成

## 接続情報として必ず添えるもの

- サーバー URL: cloudflared/config.yml の named tunnel 固定 URL(https)
- 認証: Basic(ユーザー名 + `.dev.vars` の CALDAV_PASSWORD)
- 検証したい操作の具体的な手順(例: カレンダー追加 → 予定作成 → 同期確認)と**期待結果**
- 失敗時に見るログ(`make up | grep '\[dev\]'` など)

## 結果の記録

- 実機挙動の検証結果は **docs/modeling/06** に記録する(既存3ラウンドの形式に倣う)。
