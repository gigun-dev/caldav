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

.PHONY: help install up dev proxy tunnel seed test typecheck boundaries check deploy deploy-proxy migrate-local reset-local mobileconfig typegen

help: ## このヘルプを表示
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## 依存をインストール(lockfile 固定)
	bun install --frozen-lockfile

# --- 常駐プロセス(iOS 検証の3点セット)------------------------------------

# CAPTURE_LOG(iOS デバッグ用の全リクエスト/レスポンスダンプ)は .dev.vars ではなく
# コマンドで切り替える: `make dev CAP=1` / `make up CAP=1`。
# 理由: .dev.vars 編集はプロセス再起動が必要な上に「戻し忘れて常時ON」事故が起きる。
# wrangler の --var は wrangler.jsonc の vars を起動時にだけ上書きするので使い捨てに向く。
CAP ?= 0

up: ## dev + proxy + tunnel を1ターミナルでまとめて起動(CAP=1 でキャプチャログ)
	# concurrently のプレフィックス([dev] [proxy] [tunnel])で出力元を判別できる。
	# 特定プロセスのログだけ見たいときは従来どおり make dev / make proxy / make tunnel を
	# 個別ターミナルで起動するか、`make up | grep '\[dev\]'` で絞る。
	# -k(kill-others): どれか1つが死んだら全部止める(片肺で気づかず動き続ける事故防止)。
	bunx concurrently -k -n dev,proxy,tunnel -c blue,magenta,yellow \
		"make dev CAP=$(CAP)" "make proxy" "make tunnel"

dev: ## wrangler dev を起動(Worker + ローカル D1, :8787)。CAP=1 でキャプチャログ
	bun run dev -- --var CAPTURE_LOG:$(CAP)

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

typegen: ## worker-configuration.d.ts を再生成(wrangler.jsonc / .dev.vars 変更後に実行)
	# 素の `wrangler types` は禁止: インターフェース名が Env になり、Hono テンプレートが
	# 参照する CloudflareBindings と食い違って tsc が全滅する(2026-07-11 に実際に発生)。
	bun run cf-typegen

deploy: ## 本番デプロイ(通常は Cloudflare Workers Builds が main push で自動実行)
	bun run deploy

deploy-proxy: ## MKCALENDAR 変換 proxy を Cloud Run へデプロイ(proxy/ 変更時のみ手動)
	# proxy はめったに変わらないので CI 化せず手動デプロイ(2026-07-11 判断)。
	# --source は Cloud Build が proxy/Dockerfile でビルドして新リビジョンを作る。
	# 環境変数(UPSTREAM_URL / PROXY_SHARED_SECRET=Secret Manager 参照)は既存リビジョン
	# から引き継がれるため指定不要。project は caldav-prod-fukuro(サービス名とは別物)。
	gcloud run deploy caldav-proxy \
		--project caldav-prod-fukuro \
		--region asia-northeast1 \
		--source proxy/
