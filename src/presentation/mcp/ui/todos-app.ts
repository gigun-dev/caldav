// =============================================================================
// presentation/mcp/ui/todos-app.ts — list-todos 用 MCP Apps(ui://)HTML(自己完結バンドル版)
// =============================================================================
// 【なぜ presentation/mcp/ui に置くか】
//   MCP のプロトコル知識(ツールスキーマ・structuredContent・ui:// リソース)は
//   presentation/mcp に閉じ込める方針(server.ts 冒頭コメント / CLAUDE.md「XML・プロトコル
//   知識のハンドラ漏れ」の反省)。ui:// リソースの HTML はまさに「MCP Apps という
//   プロトコル拡張の presentation 詳細」なので、presentation/mcp 配下に置くのが層として正しい。
//   さらに ui/ サブディレクトリを切って「ブラウザで実行される末端コード」を隔離し、
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' ルールで src/ 内の他コードへの import を
//   機械的に禁止する(ブラウザバンドルに domain/application/worker コードを巻き込まないため)。
//
// 【この層の依存ルール】
//   ここは定数(URI 文字列 + HTML 文字列)だけを export し、生成物 todos-bundle.ts 以外は
//   何も import しない。structuredContent の形(Task[])は todos-entry.ts 側にコメントで
//   契約として書くだけに留め、application 層の Task 型は import しない(ui は末端)。
//
// 【なぜ SEP-1865(MCP Apps)の resourceUri 方式か】
//   2026-07 時点で Claude(claude.ai/iOS)・ChatGPT(Developer mode)双方が実装している
//   generative UI の標準は MCP Apps(SEP-1865)。ツールの _meta.ui.resourceUri でこの ui://
//   リソースを紐付け、ホストがサンドボックス iframe/WKWebView にこの HTML を描画し、ツール
//   呼び出し結果(structuredContent)を postMessage 経由で app に渡す仕組み。server.ts の
//   登録コード(registerAppResource / registerAppTool)と本ファイル・todos-entry.ts の
//   コメントを併せ読めば一連の流れが分かるようにしてある。
//
// 【なぜ esm.sh 外部 import でなくバンドルするか】
//   姉妹プロジェクト tdr-concierge が実行時 esm.sh import で Claude iOS の「SDK 読込失敗」を
//   踏んだため(詳細は todos-entry.ts 冒頭コメント)。caldav は最初から自己完結バンドル方式に
//   する。scripts/build-ui-bundle.ts が todos-entry.ts を bun build で単一 ESM にバンドルし、
//   結果を todos-bundle.ts(自動生成・コミット対象)へ書き出す。このファイルはその生成物
//   TODOS_BUNDLE_JS を <script type="module"> の本体にテンプレートリテラル補間で埋め込むだけ。
//   実行時のネットワーク越し import が一切無くなり、CSP の resourceDomains 許可も不要。
//
// 【なぜ内部にスクロールコンテナを作らないか(tdr の知見を踏襲)】
//   MCP Apps はモバイルではホストの会話スクロールの中にインライン表示される(Claude iOS は
//   WKWebView インライン描画で全画面非対応)。iframe 内に固定高さ+overflow の箱を作ると
//   「会話をスクロールしたいのに UI 内スクロールに奪われる」体験になるため、高さはコンテンツに
//   フィットさせスクロールはホスト側に委ねる(固定 height を置かない)。
//
// 【検証方法(重要な制約)】
//   Claude Code(CLI)では ui:// の描画確認ができない。claude.ai(Web版)/iOS に
//   Connector として本サーバーを再接続し、list-todos を呼び出して実機確認する
//   (接続文字列・手順は親への報告 / docs/next-directions.md 参照)。
// =============================================================================

import { TODOS_BUNDLE_JS } from "./todos-bundle";

/** list-todos ツールが描画する MCP Apps リソースの URI。
 *  server.ts の _meta.ui.resourceUri と registerAppResource(uri) の両方に同じ文字列を
 *  使う必要があるため、定数として一箇所にまとめている(タイポ事故防止)。 */
export const TODOS_UI_URI = "ui://caldav/todos.html";

/**
 * list-todos の structuredContent(`{ tasks: Task[], calendarId, timeZone }`)を受け取り、
 * リマインダー一覧として描画する HTML。
 *
 * <script type="module"> の本体には自己完結バンドル(TODOS_BUNDLE_JS)を通常の変数補間
 * `${...}` で埋め込む。変数補間なので中身の文字がテンプレート構文として再解釈されることは
 * 無く安全(バンドル側の `</script>` エスケープは scripts/build-ui-bundle.ts が生成時に処理済み)。
 */
export const TODOS_APP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  /*
   * host が iframe に注入する CSS 変数(--color-text-primary / --color-background-primary 等)と
   * color-scheme: light dark を使い、ホスト固有のテーマ切り替え API には依存しない。
   * 変数が未注入の環境(MCP Inspector 単体確認時など)でも壊れないよう、素朴な
   * フォールバック値を必ず添える。
   */
  :root {
    color-scheme: light dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* 320px 幅からの崩れ防止: 固定 px の横幅指定を使わず padding も clamp() で
     * コンテナ幅に自然フィットさせる。 */
    padding: clamp(8px, 3vw, 16px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    color: var(--color-text-primary, #1a1a1a);
    background: var(--color-background-primary, #ffffff);
    /* 内部スクロールコンテナを作らない方針(上記コメント参照)なので body 自体の高さは
     * コンテンツに自然フィットさせる(固定 height 指定なし)。 */
  }
  @media (prefers-color-scheme: dark) {
    body {
      color: var(--color-text-primary, #f2f2f2);
      background: var(--color-background-primary, #1c1c1e);
    }
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--color-border-secondary, rgba(128, 128, 128, 0.25));
  }
  li:last-child { border-bottom: none; }
  /* 完了済みはタイトルに取り消し線 + 減色して「済み」を一目で分かるようにする。 */
  li.done .title {
    text-decoration: line-through;
    color: var(--color-text-secondary, #767676);
  }
  .main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0; /* 長いタイトルでも flex 子要素が縮んで折り返せるように */
  }
  .check { flex-shrink: 0; line-height: 1.3; }
  .texts { min-width: 0; }
  .title { overflow-wrap: break-word; }
  .notes {
    margin-top: 2px;
    font-size: 12px;
    color: var(--color-text-secondary, #767676);
    overflow-wrap: break-word;
  }
  .meta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    white-space: nowrap;
  }
  .due { font-size: 12px; color: var(--color-text-secondary, #767676); }
  .pri {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    /* 優先度はテキストだけだと見落としやすいので薄い塗りバッジにする。色は控えめに。 */
    background: var(--color-background-secondary, rgba(128, 128, 128, 0.15));
  }
  .pri-高 { color: #c0392b; }
  .pri-中 { color: #b8860b; }
  .pri-低 { color: var(--color-text-secondary, #767676); }
  .empty {
    color: var(--color-text-secondary, #767676);
    padding: 8px 4px;
  }
</style>
</head>
<body>
  <!-- ontoolresult 発火前でも壊れないよう初期表示を出す。以降は診断メッセージで
       上書きされ、成功すればリストに置き換わる。 -->
  <div id="root" class="empty">読み込み中…</div>

<script type="module">
${TODOS_BUNDLE_JS}
</script>
</body>
</html>
`;
