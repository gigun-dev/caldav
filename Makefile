# =============================================================================
# caldav 開発タスク集約(M1 足場固め)
# =============================================================================
# よく使う操作を1か所に集約する。CI(.github/workflows/ci.yml)と同じチェックを
# ローカルからも `make check` 一発で回せるようにし、CI とローカルの乖離を防ぐ。
#
# iOS 実機検証の3プロセス構成(別々のターミナルで起動する):
#   1) make dev     — wrangler dev(Worker + ローカル D1)          :8787
#   2) make proxy   — MKCALENDAR 書き換え proxy(proxy/server.ts)  :8080
#   3) make tunnel  — cloudflared named tunnel(固定 URL で公開)
#   起動後、別ターミナルで `make seed` を叩くと検証データが入る。
#
# 注意: このリポジトリの環境では上記の常駐プロセスは動かさない(実装のみ)。
#   実機検証を行う各自の環境で起動する手順として整備している。
# =============================================================================

# .dev.vars(gitignore 対象)からローカル用の秘密を proxy に渡すための取り込み。
# 存在しなくてもエラーにしない(-include)。CALDAV_PASSWORD / PROXY_SHARED_SECRET を定義。
-include .dev.vars
export

.DEFAULT_GOAL := help

.PHONY: help install dev proxy tunnel seed test typecheck boundaries check deploy migrate-local reset-local mobileconfig

help: ## このヘルプを表示
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## 依存をインストール(lockfile 固定)
	bun install --frozen-lockfile

# --- 常駐プロセス(iOS 検証の3点セット)------------------------------------
dev: ## wrangler dev を起動(Worker + ローカル D1, :8787)
	bun run dev

proxy: ## MKCALENDAR 書き換え proxy を起動(:8080 → :8787)
	UPSTREAM_URL=http://localhost:8787 \
	PROXY_SHARED_SECRET=$(PROXY_SHARED_SECRET) \
	PORT=8080 \
	bun run proxy/server.ts

tunnel: ## cloudflared named tunnel を起動(cloudflared/config.yml が必要)
	cloudflared tunnel --config cloudflared/config.yml run

# --- データ ----------------------------------------------------------------
migrate-local: ## ローカル D1 にマイグレーションを適用
	bunx wrangler d1 migrations apply DB --local

seed: ## ローカル D1 に検証データを投入(要 make dev 起動中)
	bun run scripts/seed-local.ts

reset-local: ## ローカル D1 を破棄(.wrangler の状態を消す。次回 dev で作り直し)
	rm -rf .wrangler/state/v3/d1
	@echo "ローカル D1 を削除しました。make dev → make migrate-local → make seed で再構築します。"

mobileconfig: ## iOS 用 .mobileconfig を生成(CALDAV_HOST 等は env で上書き可)
	bun run scripts/make-mobileconfig.ts

# --- 品質チェック(CI と同一)-----------------------------------------------
test: ## テストを実行
	bun test

typecheck: ## tsc --noEmit
	bun run typecheck

boundaries: ## 層境界チェック(dependency-cruiser)
	bun run boundaries

check: boundaries typecheck test ## CI と同じ順(境界→型→テスト)で全チェック

deploy: ## 本番デプロイ(通常は Cloudflare Workers Builds が main push で自動実行)
	bun run deploy
