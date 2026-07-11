---
name: deploy-verify
description: 本番デプロイの流れと、デプロイ後の受け入れ確認(スモークチェック)手順。deploy・本番反映・マイグレーション適用・本番疎通確認を頼まれたときに使う。
---

# 本番デプロイと受け入れ確認

## デプロイの正規ルート

- **main への push → Workers Builds が自動 deploy**(deploy command = `bun run deploy` =
  `wrangler d1 migrations apply --remote && wrangler deploy`。migrate→deploy が一体)。
- push 前に `make check`(pre-push hook でも強制。境界→tsc→test)。
- **D1 マイグレーションは前方互換(expand/contract)規律が必須** — migrations/README.md を読む。
  破壊的変更の contract フェーズだけは `make deploy-migrations` で人がレビューしながら手動適用。
- proxy(Cloud Run)は変更時のみ `make deploy-proxy` で手動デプロイ。

## デプロイ後のスモークチェック

1. **ビルド確認**: Workers Builds のビルドが成功しているか(cloudflare-builds MCP ツールで
   ログ確認可。migrate ステップの成否も見る — 2026-07-12 に「worker だけ deploy され
   マイグレーション未適用で `last_occurrence` カラム無しエラー」が実際に起きた)。
2. **DAV 疎通**: iOS 正式入口 = Cloud Run proxy 経由で OPTIONS / .well-known/caldav が返るか。
3. **MCP 疎通**: `/mcp` に Bearer 無しで 401 + OAuth discovery(well-known)が返るか。
   認証ありで initialize / tools-list / get-current-time(DB 非依存)→
   list-events-expanded(**DB 依存 — マイグレーション適用漏れの検知線**)。
4. 異常時は cloudflare-observability MCP ツールで Worker ログを確認。

## 結果の記録

- 受け入れ結果・障害の経緯は docs/log.md に追記し、docs/next-directions.md の該当箇所に
  `> 日付 更新:` を積層する。
