# D1 マイグレーション運用

このディレクトリの `.sql` は本番 D1(`caldav-production`)のスキーマ変更を時系列で積む。
**この README は「なぜこの運用にしたか」を含めて厚く書く**(リポジトリのコメント方針
= CLAUDE.md の「コメント方針」節に準拠。コードだけでなく運用文書も同じ密度で残す)。

## 経緯(2026-07-12 発生したインシデント)

0002(`0002_occurrence_index.sql`, occurrence 索引)と 0003(`0003_vjournal.sql`, VJOURNAL)を
実装 → deploy したところ、**D1 マイグレーションは Workers Builds の自動 deploy に含まれておらず**
(deploy command は既定の `npx wrangler deploy` のみで、`wrangler d1 migrations apply` を含まない)、
手動 apply を忘れたまま本番稼働してしまった。結果、`last_occurrence` カラムが本番 DB に存在せず
`list-events-expanded` / `get-freebusy`(occurrence 索引に依存するユースケース)がエラーで落ちた。
`get-current-time` は DB に触れないため無傷だった(=気づきにくい部分的な障害だった)。

この「コードは deploy 済みだが DB は追従していない」というウィンドウが自動化なしでは
毎回発生しうる。恒久的に塞ぐため、以下の2本立てで対処する。

1. **前方互換(expand/contract)規律** — migrate と deploy の順序に依存しない設計にする。
2. **Workers Builds の deploy command で migrate → deploy を自動化** — 順序の自動保証。

なお、これは **Cloudflare 公式に確立されたベストプラクティスではない**。調査した限り
「デプロイパイプラインに D1 マイグレーションを組み込む」公式のお作法は見当たらず、
以下の一次情報を組み合わせた自前設計である:
- Workers Builds の deploy command はダッシュボードでカスタマイズ可能(任意コマンド/npm script)。
- `wrangler d1 migrations apply <db> --remote` は CI/非対話環境を自動検知し、確認プロンプトを
  スキップしつつ適用前に自動バックアップを取得する(`--yes` フラグ不要)。
- 順序(migrate 先か deploy 先か)についての公式指針は無い。一般原則として
  「追加(expand)は migrate 先行」「破壊(contract)は deploy 先行」が安全とされる。

## 前方互換(expand/contract)規律【必須ルール】

**マイグレーションは常に「現在デプロイ済みのコード」と後方互換であること。**
これを守れば migrate と deploy のどちらが先に走っても(Workers Builds のビルド環境で
両方が1コマンドの中で実行されるとはいえ、万一の失敗・リトライ・手動運用でも)壊れない
= 順序問題そのものが消える。

具体的なルール:

- **ADD COLUMN** は必ず `NULL` 許可 or `DEFAULT` 付きにする。`NOT NULL` を新規追加カラムに
  即座に課さない(旧コードが INSERT 時にそのカラムを知らないため失敗する)。
- **新テーブル / 新インデックスの追加のみ**を1マイグレーションで行う。既存カラムの型変更や
  リネームと同居させない。
- **破壊的変更(DROP COLUMN / DROP TABLE / NOT NULL 化 / RENAME)は分離する。**
  「コードがその列 / テーブルを参照しなくなった後」の別マイグレーションでのみ行う
  (= まずコードを移行してデプロイ → その後の別マイグレーションで安全に消す、という
  expand フェーズ → contract フェーズの2段階)。

この規律を破ってよい例外は「破壊的変更のときの運用」節を参照。

## 自動適用の仕組み

Workers Builds の **deploy command** を `bun run deploy` に設定する(既定値の
`npx wrangler deploy` から変更)。`package.json` の `deploy` script は以下の通り:

```json
"deploy": "wrangler d1 migrations apply caldav-production --remote && wrangler deploy --minify"
```

- `wrangler d1 migrations apply --remote` を **先に** 実行する。前方互換規律を守っている限り
  「新カラムがあるがコードがまだ参照しない」状態は無害なので、migrate 先行で安全側に倒す。
- `--remote` は CI/非対話環境を自動検知してプロンプトを自動スキップし、適用前に自動バックアップを
  取得する(`--yes` は不要)。
- `&&` なので migrate が失敗すれば deploy されない(=スキーマ不整合のまま新コードが動く事故を防ぐ)。

これにより **push だけで migrate → deploy が自動で回る**。

## 非本番ブランチ(preview)はマイグレーションを当てない【重要・事故防止】

Workers Builds には「本番ブランチのデプロイ コマンド」とは別に
**「非本番ブランチのデプロイ コマンド」**(既定 `npx wrangler versions upload`)がある。
こちらには **`wrangler d1 migrations apply` を絶対に足さない**。本番ブランチ側だけに
マイグレーション適用を閉じ込める。

理由(2026-07-12 判断):

- このプロジェクトは **preview 専用の D1 を分けていない**(`wrangler.jsonc` の
  `d1_databases` は `caldav-production` 1本のみ)。よって preview 版(`versions upload` で
  上がる、本番トラフィックを取らないバージョン)も**実行時は本番 D1 を見る**。
- ここで非本番ブランチのデプロイ コマンドに migrate を足すと、**フィーチャーブランチの
  未マージ・WIP マイグレーションが本番 D1 に適用されてしまう** — 最も避けたい事故。
  マイグレーションは main(= 本番ブランチ)にマージされたものだけが本番 D1 に当たるべき。
- 前方互換(expand/contract)規律を守っている限り、preview 版のコードは「まだ main に
  マージされていない新マイグレーション」を必要とせず、現行の本番スキーマで動く。
  (もし preview が未マージのスキーマを必要とするほど乖離しているなら、それは
  preview を本番 D1 から隔離すべきサイン = 下記「将来」の検討事項。)

まとめ:
- 本番ブランチのデプロイ コマンド … `bun run deploy`(migrate → deploy)
- 非本番ブランチのデプロイ コマンド … `npx wrangler versions upload`(**触らない**)

**将来**: preview を本番から隔離したくなったら「preview 用 D1 を別途用意 +
`wrangler d1 migrations apply <preview-db> --preview`」という構成になる(別スコープ)。

## 【ダッシュボード設定】Workers Builds の deploy command を変更する(2026-07-12 設定済み)

**2026-07-12 に本番ブランチのデプロイ コマンドを `bun run deploy` に変更済み**(初回ビルド
`afecc023` で自動 migrate → deploy が稼働することを実測)。以下は再設定・別環境構築時の手順。

**リポジトリのファイル変更だけでは有効にならない。** Cloudflare ダッシュボードで
以下の手順が必要(ダッシュボード or 編集権限付きトークンでの Builds API `PATCH
/accounts/{account_id}/builds/workers/{script_tag}` で `production_settings.deploy_command`
を更新。読み取り専用トークンでは 10000 認証エラーになる):

1. Cloudflare ダッシュボード → Workers & Pages → `caldav` Worker → **Settings → Builds**
2. **Deploy command**(本番ブランチ用)の欄を既定の `npx wrangler deploy` から
   `bun run deploy` に変更して保存。(`npm run deploy` でも同義。PM は Bun なので推奨。)
   **「非本番ブランチのデプロイ コマンド」は `npx wrangler versions upload` のまま触らない**
   (上の「非本番ブランチはマイグレーションを当てない」節の理由による)。
3. 次回 main push で自動ビルドが走ったら、ビルドログで
   `wrangler d1 migrations apply caldav-production --remote` の出力を確認する
   (次節「認証の注意」参照)。

## 認証(2026-07-12 実測済み: 追加トークン不要)

当初「Workers Builds のビルド環境が暗黙トークンでリモート D1 に apply できる権限を持つか」は
公式ドキュメントに明記がなく未確定だったが、**deploy command 変更後の初回ビルドで実測して
解決した**:

- ビルド `afecc023`(commit `a6c0e03`, 2026-07-12)のログで
  `wrangler d1 migrations apply caldav-production --remote` が **認証エラーなしで実行され**、
  `✅ No migrations to apply!`(0002/0003 は既適用だったため)→ `wrangler deploy --minify` 成功。
- つまり **Workers Builds の暗黙トークンはそのままリモート D1 に届く。
  `CLOUDFLARE_API_TOKEN` を build variables に追加する必要は無い。**

もし将来この前提が崩れ(例: Cloudflare 側の権限モデル変更で)`migrations apply` が権限エラー
(403 等)で失敗するようになったら、そのときは Workers Builds の **build variables(secret)** に
`CLOUDFLARE_API_TOKEN`(D1 Edit + Workers 権限)を追加する。それまでのフォールバックは
`make deploy-migrations`(後述)での手動適用。

## 破壊的変更のときの運用

expand/contract を守れない「一度きりの破壊的変更」がどうしても必要な場合
(例: 誤って作った列を消す、型を根本的に変える等)は、**自動パイプラインに乗せず**
その回だけ手動で扱う:

1. `make deploy-migrations` でローカルから人がレビューしながら適用する
  (自動 deploy の `&&` チェーンに混ぜない = 何が起きたか目視確認できる状態で実行する)。
2. 適用前に D1 **Time Travel**(有料プランの30日巻き戻し機能)で復旧可能なことを
   確認しておく。想定外の破損があれば Time Travel で当該マイグレーション適用前の
   タイムスタンプに戻せる。
3. 落ち着いたら次回以降の自動デプロイに戻す。

## 手動適用手段

```
make deploy-migrations
```

内部では `CLOUDFLARE_ACCOUNT_ID=<gigun-dev のアカウントID> wrangler d1 migrations apply
caldav-production --remote` を実行する(Makefile 参照)。account_id を環境変数で明示している
理由: ローカル環境には複数の Cloudflare アカウントが紐づいており、wrangler.jsonc に
account_id を書いていても `--remote` 実行時にそれを拾わない事象が実測されているため
(2026-07-12)。
