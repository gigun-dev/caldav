// =============================================================================
// presentation/mcp/ui/diag-app.ts — iOS 描画切り分け用・最小診断カード(ui://)HTML
// =============================================================================
// 【なぜこのファイルがあるか(2026-07-23 iOS レンダリング切り分けスパイク)】
//   claude.ai iOS アプリで caldav の todos/agenda カードだけ「MCPアプリの読み込みに
//   失敗しました サーバーに接続できません」となる(web/Desktop では描画される・他サーバーの
//   カードは iOS でも描画される)。仮説は2つ:
//     (a) OAuth 必須サーバーでの ui:// resource 取得の認証問題
//     (b) UI バンドルサイズ(todos/agenda は自己完結バンドルで 1MB 超)がモバイル上限に当たる
//   この最小カードは todos/agenda と「同じ登録経路(registerAppResource / registerAppTool)・
//   同じ OAuth 保護下」を通りつつ、中身だけを極小(< 2KB・外部依存ゼロ・JS ほぼ無し)にする。
//   iOS でこれが描画されれば (b) サイズ/内容説、失敗すれば (a) 認証説へ切り分けられる
//   (両カードとも同じ resources/read 経路・同じ Bearer を通るので、差分は「中身の大きさ」だけ)。
//
// 【なぜ ui/ に置き・他 src を import しないか】
//   todos-app.ts と同じ理由(ファイル冒頭コメント参照)。ここはブラウザで実行される末端コードで、
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' ルールが src/ 内の他コードへの import を禁じる。
//   このファイルは URI 文字列 + HTML 文字列だけを export し、何も import しない。
//
// 【なぜ静的 URI(hash 無し)か】
//   todos/agenda は HTML から算出した hash 付き URI + legacy エイリアスでキャッシュバスティングを
//   していた(server.ts 参照)。診断カードは一時的で内容も固定・キャッシュ整合を気にする段階に
//   無いので、素直に静的 URI 1本にする(切り分けが済んだら丸ごと撤去できるよう疎に保つ)。
//
// 【なぜ外部依存ゼロ・インライン CSS のみ・JS 最小か】
//   目的は「ui:// resource が iOS レンダラーへ届いて描画されるか」の切り分けだけ。ext-apps の
//   App SDK(ontoolresult 購読・postMessage ブリッジ)は使わない — SDK 読込やブリッジ確立の
//   失敗要因を排除し、「素の HTML すら描画されないのか」を純粋に見たいため。描画時刻と
//   navigator.userAgent の埋め込みにだけ極小のインライン <script> を使う(外部 fetch も
//   import も一切しないので、これが失敗しても resource 配送・HTML パースの成否は枠+チェックの
//   静的部分で判定できる)。
//
// 【なぜ絵文字を使わず素の SVG チェックか】
//   プロジェクト方針(絵文字禁止・lucide 推奨)に従う。ただし lucide の icons.ts に依存すると
//   「外部依存ゼロ」を崩すので、ここでは icons.ts すら使わず素のインライン <svg> で check を描く
//   (診断カードの独立性を最優先)。
// =============================================================================

// 診断カードの ui:// URI(静的)。server.ts が registerAppResource / registerAppTool の
// _meta.ui.resourceUri でこの文字列を参照する。todos/agenda の "ui://caldav/todos.*" と同じ名前空間。
export const DIAG_UI_URI = "ui://caldav/diag.html";

// 最小診断カード本体。外部 URL 参照ゼロ・インライン CSS のみ・合計 2KB 以下(server 側テストで
// バイト数と「http(s):// や //cdn 等の外部参照が無いこと」を機械的に固定する)。
// - 枠 + チェックで「描画に成功した」ことが一目で分かる見た目にする。
// - 描画時刻(renderedAt)と navigator.userAgent は極小 <script> が textContent に流し込む
//   (script が動かなくても "—" のままで枠・見出しは出るので、静的描画の成否は判定できる)。
export const DIAG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>診断カード</title>
<style>
body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;color:#1c1c1e}
.card{border:1.5px solid #34c759;border-radius:12px;padding:14px 16px;margin:8px}
.head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}
.head svg{flex:0 0 auto}
.row{margin-top:10px}
.k{color:#8e8e93;font-size:12px}
.v{margin-top:2px;word-break:break-all;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="card">
<div class="head">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
診断カード(iOS 描画切り分け用)
</div>
<div class="row"><div class="k">描画時刻</div><div class="v" id="t">—</div></div>
<div class="row"><div class="k">navigator.userAgent</div><div class="v" id="ua">—</div></div>
</div>
<script>
document.getElementById("t").textContent=new Date().toISOString();
document.getElementById("ua").textContent=navigator.userAgent;
</script>
</body>
</html>`;
