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

.PHONY: help install hooks up dev proxy tunnel seed test test-worker typecheck boundaries check deploy deploy-proxy deploy-migrations migrate-local reset-local mobileconfig typegen

help: ## このヘルプを表示
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: hooks ## 依存をインストール(lockfile 固定)+ git hooks 配線
	bun install --frozen-lockfile

hooks: ## git hooks を有効化(.githooks を core.hooksPath に設定)
	# .git/hooks は git 管理外なので、commit 済みの .githooks を指すよう配線する。
	# clone 直後や hook 追加時に `make hooks`(または `make install`)で有効化。
	git config core.hooksPath .githooks
	@echo "core.hooksPath = .githooks(pre-push で main への push 前に make check)"

# --- 常駐プロセス(iOS 検証の3点セット)------------------------------------

# DUMP_DAV_REQUESTS(iOS デバッグ用の全リクエスト/レスポンスダンプ。旧 CAPTURE_LOG、
# Xandikos の DUMP_DAV_XML に倣い改名)は .dev.vars ではなくコマンドで切り替える:
# `make dev DUMP=1` / `make up DUMP=1`。
# 理由: .dev.vars 編集はプロセス再起動が必要な上に「戻し忘れて常時ON」事故が起きる。
# wrangler の --var は wrangler.jsonc の vars を起動時にだけ上書きするので使い捨てに向く。
DUMP ?= 0

up: ## dev + proxy + tunnel を1ターミナルでまとめて起動(DUMP=1 でリクエストダンプ)
	# concurrently のプレフィックス([dev] [proxy] [tunnel])で出力元を判別できる。
	# 特定プロセスのログだけ見たいときは従来どおり make dev / make proxy / make tunnel を
	# 個別ターミナルで起動するか、`make up | grep '\[dev\]'` で絞る。
	# -k(kill-others): どれか1つが死んだら全部止める(片肺で気づかず動き続ける事故防止)。
	bunx concurrently -k -n dev,proxy,tunnel -c blue,magenta,yellow \
		"make dev DUMP=$(DUMP)" "make proxy" "make tunnel"

dev: ## wrangler dev を起動(Worker + ローカル D1, :8787)。DUMP=1 でリクエストダンプ
	bun run dev -- --var DUMP_DAV_REQUESTS:$(DUMP)

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
#
# テストランナーが2レーンに分かれている理由(2026-07-12 vitest-pool-workers 導入
# スライス1):
#   - bun test(test)  — 従来どおりの主レーン。test/domain 等、Bun の Node ライク
#     環境で完結するユニット/結合テストの大半をここで回す。
#   - vitest run(test-worker) — `cloudflare:workers` / `cloudflare:test` を
#     import する、または src/index.ts の provider 本体(OAuthProvider の
#     default export)を実際に fetch で叩く検証だけを test/worker/ に隔離し、
#     実 workerd(Miniflare)上で回す(vitest.config.ts 参照)。Bun の Node ライク
#     環境には `cloudflare:*` の仮想モジュールが存在しないため、この種のテストは
#     bun test では原理的に書けない。
# 振り分け基準: 新しいテストを足すとき、上記の import/検証対象に該当するかどうかで
# test/ 配下(bun)と test/worker/ 配下(vitest)のどちらに置くかを決める。
test: ## テストを実行(bun レーン。test/worker/ は拾わない — test-worker 参照)
	# `bun test`(引数なし)ではなく `bun run test`(package.json の test script)を
	# 呼ぶ。script 側でテスト対象ディレクトリを明示列挙しており、それにより
	# test/worker/(cloudflare:workers 依存で bun からは import できない)を
	# 除外している。ここで素の `bun test` を呼ぶと全 test/ 配下を再帰的に拾って
	# しまい、test/worker/spike.test.ts の import で落ちる(実際に踏んだ)。
	bun run test

test-worker: ## テストを実行(vitest-pool-workers レーン、実 workerd 上)
	bun run test:worker

# typegen を前段に挟む理由(2026-07-11): 公式推奨は「TS を使うタスクの前に wrangler types」。
# 手動 typegen は忘れるので typecheck が毎回自動再生成する(数秒・オフラインで完結)。
# 生成差分は git status に現れたら普通に commit する(生成物もコミットする運用)。
# CI に組み込まない理由: 型には .dev.vars(gitignore 対象)のキーも含まれるため、
# .dev.vars が無い CI で再生成/--check すると偽陽性で落ちる。CI は commit 済みの
# worker-configuration.d.ts をそのまま tsc に使う(bun run typecheck 直呼びで typegen を通らない)。
#
# typecheck:worker を後ろに連結している理由: test/worker/ はルートの tsconfig.json と
# 型セットが共存できず(bun-types vs cloudflare:test の型衝突。tsconfig.json の
# exclude コメント参照)専用 tsconfig(test/worker/tsconfig.json)を持つため、
# tsc の実行自体を2回に分ける必要がある。
# typecheck:ui を3レーン目として連結する理由: src/presentation/mcp/ui/*-entry.ts は
# ブラウザ(DOM あり)で動くソースで、主 tsconfig(Workers 向け・ESNext lib のみ)とは
# 型セットが共存できない(DOM グローバルが Cloudflare 拡張型と衝突する)。専用の
# tsconfig.ui.json(DOM lib を足す)を持つため、test/worker と同じく tsc の実行を分ける。
# make check がこの3レーンをまとめて回すので、UI のブラウザ TS も CI で型検査される。
typecheck: typegen ## tsc --noEmit(worker-configuration.d.ts を自動再生成してから、3レーン分)
	bun run typecheck
	bun run typecheck:worker
	bun run typecheck:ui

boundaries: ## 層境界チェック(dependency-cruiser)
	bun run boundaries

check: boundaries typecheck test test-worker ## CI と同じ順(境界→型→テスト→workerテスト)で全チェック

typegen: ## worker-configuration.d.ts を再生成(wrangler.jsonc / .dev.vars 変更後に実行)
	# 素の `wrangler types` は禁止: インターフェース名が Env になり、Hono テンプレートが
	# 参照する CloudflareBindings と食い違って tsc が全滅する(2026-07-11 に実際に発生)。
	bun run cf-typegen

deploy: ## 本番デプロイ(通常は Cloudflare Workers Builds が main push で自動実行。migrate→deploy を含む。詳細 migrations/README.md)
	bun run deploy

# deploy-migrations: D1 マイグレーションだけをローカルから手動で本番適用するためのターゲット。
# 通常は `bun run deploy`(package.json の deploy script)が Workers Builds 経由で自動適用するので
# 出番はない。使うのは「破壊的変更(expand/contract の contract フェーズ)を人がレビューしながら
# 手で当てたい」ときや、Workers Builds 側の権限不足でビルドが落ちたときの応急対応など
# (migrations/README.md「破壊的変更のときの運用」参照)。
#
# なぜ CLOUDFLARE_ACCOUNT_ID を明示するか(2026-07-12 実測): ローカル環境には複数の
# Cloudflare アカウントが紐づいており、wrangler.jsonc の account_id を書いていても
# `wrangler d1 migrations apply --remote` はそれを拾わず「どのアカウントか」を対話確認
# しようとする(または誤ったアカウントに向く)ことが実測された。環境変数で明示すれば確実に
# 一意に決まる。id は wrangler.jsonc の account_id と同じ値(gigun-dev アカウント)。
deploy-migrations: ## D1 マイグレーションを本番へ手動適用(通常は deploy 経由の自動適用を使う。手動は例外運用)
	CLOUDFLARE_ACCOUNT_ID=4b00d8d779cdc4e8fbc1840248d21722 \
		bunx wrangler d1 migrations apply caldav-production --remote

deploy-proxy: ## MKCALENDAR 変換 proxy を Cloud Run へデプロイ(proxy/ 変更時のみ手動)
	# proxy はめったに変わらないので CI 化せず手動デプロイ(2026-07-11 判断)。
	# --source は Cloud Build が proxy/Dockerfile でビルドして新リビジョンを作る。
	# 環境変数(UPSTREAM_URL / PROXY_SHARED_SECRET=Secret Manager 参照)は既存リビジョン
	# から引き継がれるため指定不要。project は caldav-prod-fukuro(サービス名とは別物)。
	gcloud run deploy caldav-proxy \
		--project caldav-prod-fukuro \
		--region asia-northeast1 \
		--source proxy/
