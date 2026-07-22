// =============================================================================
// presentation/mcp/ui/confirm-app.ts — 汎用「削除の確認」カード(ui://)HTML(自己完結バンドル版)
// =============================================================================
// 【位置づけ】docs/modeling/14-confirmation-card.md(S1)。破壊的操作(delete 系・Tier A)の
//   human-in-the-loop 確認カード。propose-delete-* が結果 _meta にトークン + プレビューを載せて
//   このカードを開き、ユーザーが「削除する」を押すと confirm-entry.ts が callServerTool で本体
//   delete-* を confirmToken 付きで実行する。なぜ presentation/mcp/ui に置くか・なぜ自己完結バンドルか・
//   なぜ content-hash 化 ui:// URI か・テーマ変数の写像方針は todos-app.ts / agenda-app.ts の冒頭
//   コメントと完全に同一なので、詳細はそちらを参照(重複させない)。
//
// 【小さく保つ】このカードは「1対象 · 見出し · プレビュー · 2ボタン」だけ。todos/agenda カードの
//   ような一覧・楽観更新・畳み・詳細ページは持たない(確認は単一目的の即応 UI)。テーマ変数
//   (--bg/--fg/--muted/--border/--danger/--accent 等)は agenda-app.ts と同じホスト注入変数 +
//   fallback を写して、同じ視覚言語(静かなヘアライン + iOS の色)に揃える。
// =============================================================================

import { CONFIRM_BUNDLE_JS } from "./confirm-bundle";
import { fnv1aHex } from "./content-hash";

export const CONFIRM_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<!-- fullscreen 昇格は無いカードだが、todos/agenda と同じズームロック回避の viewport を敷いておく
     (iOS WKWebView の入力フォーカス由来オートズーム対策。詳細は todos-app.ts の同コメント参照)。 -->
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --bg-subtle: var(--color-background-secondary, #f7f7f8);
    --fg: var(--color-text-primary, #1c1c1e);
    --muted: var(--color-text-secondary, #8a8a8e);
    --border: var(--color-border-secondary, #e4e4e7);
    --surface: var(--color-background-secondary, rgba(128, 128, 128, 0.12));
    --accent: #2f6fed;
    --danger: #d64545;
    --radius: var(--border-radius-md, 8px);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--color-background-primary, #1e1e20);
      --bg-subtle: var(--color-background-secondary, #27272a);
      --fg: var(--color-text-primary, #f2f2f4);
      --muted: var(--color-text-secondary, #98989e);
      --border: var(--color-border-secondary, #3a3a3e);
      --surface: var(--color-background-secondary, rgba(128, 128, 128, 0.18));
      --accent: #6f9cf5;
      --danger: #e57373;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  /* WebKit 既定の tap-highlight(灰色矩形)を消す(todos/agenda と同じ理由 — 自前の押下反応を持つ)。 */
  * { -webkit-tap-highlight-color: transparent; }
  .lucide-icon { vertical-align: -0.125em; }
  [hidden] { display: none !important; }
  body {
    padding: clamp(10px, 3vw, 18px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Hiragino Sans", sans-serif;
    font-size: 14px;
    line-height: 1.45;
    color: var(--fg);
    background: var(--bg);
  }

  /* --- 診断行(接続中/失敗。todos/agenda と同じ)--- */
  .status { font-size: 12px; color: var(--muted); padding: 4px 0; }

  /* --- 見出し(警告三角 + 対象種別の問い)--- */
  .head-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .warn-icon { display: inline-flex; color: var(--danger); }
  .warn-icon .lucide-icon { width: 20px; height: 20px; }
  .heading { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }

  /* --- 対象プレビュー(消えるものを1枚のサーフェスで見せる)--- */
  .target-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px 14px; margin-bottom: 14px;
  }
  .target-title { font-size: 15px; font-weight: 550; overflow-wrap: anywhere; }
  .target-meta { font-size: 12.5px; color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
  /* 中身ごと消える警告(calendar 削除で件数 > 0)。danger 色で一段強く。 */
  .target-danger { font-size: 12.5px; color: var(--danger); margin-top: 8px; font-weight: 550; }

  /* --- 失敗バナー --- */
  .banner {
    margin-bottom: 12px; padding: 8px 10px; font-size: 12.5px; color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: var(--radius); overflow-wrap: anywhere;
  }

  /* --- アクション(キャンセル / 削除する)--- */
  .actions { display: flex; gap: 10px; }
  .btn {
    flex: 1; min-height: 44px; padding: 10px 14px; font: inherit; font-size: 15px; font-weight: 600;
    border-radius: 12px; border: 1px solid var(--border); cursor: pointer;
  }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .btn-cancel { color: var(--fg); background: var(--bg-subtle); }
  .btn-cancel:active { background: var(--surface); }
  /* 破壊的ボタンは塗り danger(赤)。iOS の「削除」ボタンと同じ強い色で誤爆しにくくする。 */
  .btn-delete { color: #fff; background: var(--danger); border-color: var(--danger); }
  .btn-delete:active { filter: brightness(0.92); }
  /* §7.8(docs/modeling/12)committing 演出: 実行ボタンの in-flight シマー。楽観 UI ではなく
   * 「確定を待っている」ことをボタン自身が語る(1方向の sweep・独自語彙は新設しない)。 */
  .btn-delete.committing {
    background-image: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.35) 50%, transparent 80%);
    background-size: 200% 100%;
    animation: btn-sweep 1.1s linear infinite;
  }
  @keyframes btn-sweep { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .btn-delete.committing { animation: none; } }

  /* --- 終端結果(削除しました / キャンセルしました)--- */
  .result { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 550; padding: 6px 0; }
  .result.done { color: var(--danger); }
  .result.cancelled { color: var(--muted); }
  .result .lucide-icon { width: 16px; height: 16px; }

  /* --- プレースホルダ(_meta 未着)--- */
  .skel { color: var(--muted); padding: 12px 0; font-size: 13px; }

  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
</head>
<body>
  <div id="status" class="status" hidden></div>
  <!-- カード本体(見出し + プレビュー + ボタン)。confirm-entry.ts が _meta.confirm を受けて組む。 -->
  <div id="root"></div>
  <!-- 操作結果の読み上げ専用(視覚非表示)。 -->
  <div id="live" class="sr-only" role="status"></div>

<script type="module">
${CONFIRM_BUNDLE_JS}
</script>
</body>
</html>
`;

/** propose-delete-* が _meta.ui.resourceUri で参照する確認カード ui:// の URI。
 *  【content-address 化】todos/agenda と同じ理由・方式で CONFIRM_APP_HTML(配信 HTML 全体)の
 *  hash を URI に埋め込む(HTML が変われば URI も変わりホストのキャッシュ TTL を跨いで即伝播する)。
 *  server.ts の _meta.ui.resourceUri と registerAppResource(uri) の両方に同じ文字列を使う。 */
export const CONFIRM_UI_URI = `ui://caldav/confirm.${fnv1aHex(CONFIRM_APP_HTML)}.html`;
