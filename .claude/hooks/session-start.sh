#!/usr/bin/env bash
# harness-template v0.2.1 (配布元: gigun-dev/claude-code plugins/harness。配布先の世代確認はこの行を grep)
# SessionStart フック: セッション開始時にプロジェクトの「現在地」を確定的に注入する。
#
# 設計意図(caldav で確立した方式 + 2026-08-05 敵対的検証での補強):
#   - docs/next-directions.md は「頭(現在地・着手順)」+「方向性カタログ」の2部構成。
#     頭だけを注入する(全文注入は毎セッション高コストなアンチパターン)。境界は行頭の
#     `<!-- session-head-end` マーカー1行。
#   - マーカーが見つからない場合は全文注入へフォールバックせず、警告だけ注入して止める
#     (fail-closed。旧版はマーカー消失で「全文注入+肥大化警告の同時無効化」が起きた)。
#   - 肥大化(カタログ・頭)と鮮度(現在地の日付 vs 最終コミット日)は機械計測する。
#     放置に人間の裁量で気づくのは遅い/不確実。
set -euo pipefail

# フックの cwd はプロジェクトルート。CLAUDE_PROJECT_DIR があればそれを優先(堅牢化)。
doc="${CLAUDE_PROJECT_DIR:-.}/docs/next-directions.md"
[ -r "$doc" ] || exit 0  # 正典が無い/読めないなら無言で終了(フックはセッションを止めない)

# 閾値は目安。ただし警告を消すために上げるのは禁止(棚卸しが正)。棚卸し後に現況へ
# 「下げ直す」方向のみ調整してよい(上げ方向の調整を許すと検知がラチェット式に死ぬ)。
CATALOG_MAX_LINES=250
UPDATE_BLOCK_MAX=12
HEAD_MAX_LINES=80

# マーカーは行頭アンカーで検出(散文中の "session-head-end" 言及で頭が切断される誤爆を防ぐ)。
marker_line=$(grep -n -m1 '^<!-- session-head-end' "$doc" | cut -d: -f1 || true)
if [ -z "$marker_line" ]; then
  echo '⚠️ docs/next-directions.md に session-head-end マーカーが見つかりません(頭の注入を停止中)。'
  echo '   現在地・着手順の直後に行頭から `<!-- session-head-end -->` の1行を復元してください。'
  echo '   それまでは docs/next-directions.md を直接読むこと。'
  exit 0
fi

echo '=== docs/next-directions.md の頭(現在地・着手順)。詳細カタログは該当節をそのとき読む。更新は「> **YYYY-MM-DD 更新:**」を積層・計画は消さない ==='

# 頭(マーカー手前まで)を注入し、カタログ(マーカー以降)は行数と更新ブロック数を計測。
# 更新ブロックのパターンは寛容に取る(太字省略・スラッシュ日付も数える)。教える正書式は
# 太字だが、書式が少しズレただけで計測が静かに死ぬ設計にしない(敵対的検証の指摘)。
awk -v marker="$marker_line" -v maxlines="$CATALOG_MAX_LINES" -v maxblocks="$UPDATE_BLOCK_MAX" -v maxhead="$HEAD_MAX_LINES" '
  NR < marker { print; next }
  NR == marker { next }
  {
    catalog++
    if ($0 ~ /^[[:space:]]*> (\*\*)?20[0-9][0-9][-\/].*更新(:|：)/) updates++
  }
  END {
    head = marker - 1
    if (head > maxhead) {
      printf "\n⚠️ 頭が %d 行あります(目安 %d 行)。現在地・着手順は要約し、経緯の積層はカタログ側か git 履歴へ。\n", head, maxhead
    }
    if (catalog > maxlines || updates > maxblocks) {
      printf "\n⚠️ next-directions.md のカタログが肥大化しています(%d 行 / 更新ブロック %d 個、閾値 %d 行 / %d 個)。\n", catalog, updates, maxlines, maxblocks
      printf "   棚卸し(次版)を実施してください — 「> 日付 更新:」積層を本文へ溶かし込み、頭を最新の現在地に更新する。\n"
      printf "   ⚠️ 閾値を上げて警告を消すのは禁止。棚卸し後に現況へ下げ直すのは可。\n"
    }
  }
' "$doc"

# 鮮度検査: 頭の「## 現在地(YYYY-MM-DD)」の日付より新しいコミットがあれば、更新漏れの可能性を警告。
# 日付粒度の比較なので当日中の連続作業では鳴らない(緩い検査。強制機構ではなく検知器)。
# 括弧は全角/半角の両方を許容する(caldav 第5版棚卸しで、全角「現在地（…）」が読めず
# 鮮度検査が一度も効いていなかったことが判明。計測は寛容に・教える書式は半角で統一)。
head_date=$(sed -n "1,${marker_line}p" "$doc" | grep -oE '# 現在地[(（]20[0-9]{2}-[0-9]{2}-[0-9]{2}[)）]' | head -1 | grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' || true)
if [ -n "$head_date" ] && command -v git >/dev/null 2>&1; then
  last_commit=$(git -C "${CLAUDE_PROJECT_DIR:-.}" log -1 --format=%cs 2>/dev/null || true)
  if [ -n "$last_commit" ] && [ "$last_commit" \> "$head_date" ]; then
    printf '\n⚠️ 現在地の日付(%s)より新しいコミット(%s)があります — 頭の更新漏れの可能性。作業前に現在地を最新化してください。\n' "$head_date" "$last_commit"
  fi
fi
