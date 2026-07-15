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
// 【デザインの語彙は iOS リマインダーに寄せる(E-2 スライス①の設計判断)】
//   プライマリクライアントが iOS リマインダーである以上、chat 内 UI でも同じデータが
//   「同じ見た目の言語」で現れるべき(丸チェック・優先度 ! 記号・期限切れの赤)。ユーザーが
//   2つの UI の対応関係を学習し直さなくて済む。ただしレイアウトは chat カード幅
//   (最小 320px・単一カラム)に最適化し、iOS のグループ別カラーバッジ等は持ち込まない
//   (①のスコープは単一コレクション tasks なのでグループ概念自体が不要)。
//
// 【テーマ変数の方針(SEP-1865 のテーマ注入は未確認 → 「あれば乗る」形)】
//   自前の CSS 変数を一枚(--bg/--fg/--muted/--accent/--danger/--pri/--border)定義し、
//   その値としてホスト注入が観測されている変数(--color-text-primary 等)を
//   `var(--host-var, fallback)` で参照する。ホストが変数を注入すればテーマが差し替わり、
//   未注入(MCP Inspector 単体等)でもフォールバックで成立する。SEP-1865 に公式のテーマ
//   注入仕様が確定したらこの一枚だけ書き換えれば全体が追従する(要素側は自前変数しか見ない)。
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
 * 静的な骨格(ヘッダ・バナー・ステータス行・#root)はここに置き、動的な中身は
 * todos-entry.ts が DOM API で組み立てる。ヘッダを HTML 側に置くのは、#root が
 * 再描画のたびに innerHTML で作り直される破壊的更新であるのに対し、ヘッダは
 * 「一覧の状態に依らず常時ある操作面」だから(スパイク時代に entry 側で
 * createElement していたのを、静的なものは静的に、へ整理した)。
 *
 * <script type="module"> の本体には自己完結バンドル(TODOS_BUNDLE_JS)を通常の変数補間
 * `${...}` で埋め込む。変数補間なので中身の文字がテンプレート構文として再解釈されることは
 * 無く安全(バンドル側の `</script>` エスケープは scripts/build-ui-bundle.ts が生成時に処理済み)。
 */
export const TODOS_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  /* ---------------------------------------------------------------------------
   * テーマ変数一枚(ファイル冒頭「テーマ変数の方針」参照)。
   * 要素側はこの自前変数だけを見る。ホスト注入変数(--color-*)は「あれば乗る」。
   * 色の選定は iOS システムカラーに寄せる: accent=systemBlue(#007aff)、
   * danger=systemRed(#ff3b30)、pri(優先度 ! 記号)=systemOrange(#ff9500)。
   * iOS リマインダーの優先度記号がオレンジ系で描かれる語彙に合わせるため、accent とは
   * 別変数にしている(accent 流用だとチェック円と ! が同色になり意味の区別が消える)。
   * ------------------------------------------------------------------------- */
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --fg: var(--color-text-primary, #1a1a1a);
    --muted: var(--color-text-secondary, #767676);
    --border: var(--color-border-secondary, rgba(128, 128, 128, 0.25));
    --surface: var(--color-background-secondary, rgba(128, 128, 128, 0.12));
    --accent: #007aff;
    --danger: #ff3b30;
    --pri: #ff9500;
    --radius: var(--border-radius-md, 8px);
    /* --- becoming(変化の中間状態)用の補助トーン(E-2 スライス② 差分表現)-----------
     * 差分は form(輪郭・線・構造)を主役にし、色は補助に留める方針(モック
     * scratchpad/todos-refined.html の設計)。Why not 色ハイライト主体: 色だけの差分は
     * 「何が起きたか」を語らず、ダーク/ライト双方でのコントラスト管理も脆い。
     *   accent-soft : completed の「凍結した波紋リング」(box-shadow 1枚)
     *   add/add-wake: added の左端バーと右へ減衰する wake
     *   edit        : edited の新値強調(琥珀。accent/danger/pri と衝突しない第4色)
     *   del-border  : removed ゴーストの破線(彩度ゼロ = もう意味を持たない行) */
    --accent-soft: rgba(0, 122, 255, 0.14);
    --add: #2f9e63;
    --add-wake: rgba(47, 158, 99, 0.07);
    --edit: #b07300;
    --del-border: #c9c9ce;
  }
  /* ダークはフォールバック値だけ差し替える(ホスト変数が来ていればそちらが勝つ構造は同じ)。
   * systemRed/Blue/Orange はダークで僅かに明度が上がる iOS 定義に合わせる。 */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--color-background-primary, #1c1c1e);
      --fg: var(--color-text-primary, #f2f2f2);
      --muted: var(--color-text-secondary, #98989e);
      --accent: #0a84ff;
      --danger: #ff453a;
      --pri: #ff9f0a;
      /* becoming 補助トーンのダーク版。リング/wake は暗地で沈むため不透明度を上げ、
       * edit の琥珀は明度を上げる(モックの theme-dark 実測値)。 */
      --accent-soft: rgba(10, 132, 255, 0.2);
      --add: #55b884;
      --add-wake: rgba(85, 184, 132, 0.1);
      --edit: #d9a441;
      --del-border: #55555a;
    }
  }
  * { box-sizing: border-box; }
  /* HTML の hidden 属性を確実に効かせる。.banner/.status は display:flex/block を持つため、
   * その display 指定が hidden 属性(既定 display:none)を上書きしてしまい「中身が空でも
   * 赤い長方形が常時出る」バグが起きる(CSS の display が HTML hidden より優先される古典的な罠)。
   *
   * 【2026-07-13 再修正: 前回の [hidden]{display:none} は無効だった】
   * 前コメントは「属性セレクタは要素セレクタより詳細度が高いので勝つ」としていたが誤り。
   * 競合相手は要素セレクタではなく **クラスセレクタ** .banner(詳細度 0,1,0)で、[hidden] も
   * 属性セレクタ=同じ 0,1,0。**詳細度が同着**のときはソース順で後方が勝つため、後ろにある
   * .banner{display:flex} が前方の [hidden] を上書きし、hidden でも表示されてしまっていた
   * (本番 Inspector で空の赤バナー残留を実測 → 特定)。!important で確実に優先させる —
   * hidden ユーティリティの一枚上書きは !important の正当な用途(状態切替は JS の .hidden で行い、
   * 表示/非表示の最終権限をこの1行に集約する)。 */
  [hidden] { display: none !important; }
  body {
    margin: 0;
    /* 320px 幅からの崩れ防止: 固定 px の横幅指定を使わず padding も clamp() で
     * コンテナ幅に自然フィットさせる。 */
    padding: clamp(8px, 3vw, 16px);
    /* 2026-07-14 UI フィードバック対応: 右下固定 FAB(56px + 余白)が最終行に被らないよう下余白を確保
     * (FAB は position:fixed で通常フローに場所を取らないため、body 側で退避スペースを空ける)。 */
    padding-bottom: 88px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    color: var(--fg);
    background: var(--bg);
    /* 内部スクロールコンテナを作らない方針(冒頭コメント参照)なので body 自体の高さは
     * コンテンツに自然フィットさせる(固定 height 指定なし)。 */
  }

  /* --- ヘッダ(タイトル + 最終更新)---------------------------------------------
   * 手動「再読込」ボタンは廃止した(refetchOnWindowFocus 化。理由は todos-entry.ts の
   * 自動再取得コメント参照)。ヘッダには「いつのデータか」を示す最終更新だけ残す。 */
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .bar-left { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .app-title { font-size: 16px; font-weight: 700; }
  .updated { font-size: 11px; color: var(--muted); white-space: nowrap; }

  /* --- 診断/エラーバナー -------------------------------------------------------
   * iOS WebView にはコンソールが無く「画面表示でしか」切り分けられない(スパイク時代の
   * show() の思想を継承)。接続フェーズの進行は #status、操作失敗は #banner に出す。
   * バナーは #root を壊さない(リストを保ったままエラーを重ねられる)ことが要点。 */
  .status { font-size: 12px; color: var(--muted); padding: 4px 0; }
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 4px 0;
    padding: 8px 10px;
    font-size: 12px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
  }
  .banner button {
    flex-shrink: 0;
    min-height: 32px;
    padding: 2px 10px;
    font-size: 12px;
    font-family: inherit;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  /* --- セクション --------------------------------------------------------------
   * 期限切れ/今日/今後/期日なし/完了済み。見出しは h2(スクリーンリーダーの
   * ランドマークとして機能させる)。期限切れ見出しだけ danger 色にして
   * 「まず目が行く」構造にする(iOS リマインダーの期限切れ赤の語彙)。 */
  section { margin-top: 10px; }
  section:first-child { margin-top: 0; }
  h2 {
    margin: 0 0 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: none;
  }
  section.sec-overdue h2 { color: var(--danger); }
  /* 完了済みは <details> で折り畳み(既定閉)。summary をセクション見出しと同格の見た目に。 */
  details > summary {
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 4px 0;
    /* summary もタップ対象なので最低限の当たり判定を確保する。 */
    min-height: 32px;
    display: flex;
    align-items: center;
  }

  ul { list-style: none; margin: 0; padding: 0; }
  /* 【2026-07-14 UI フィードバック対応: li を縦積みに】row-main(横並び: check + header + ⓘ)を
   * 1つ目の子、詳細展開パネル(.detail)を2つ目の子にする。以前は li 自身が横 flex で check と
   * texts を並べ、detail は texts 内にあったため、チェック円が texts 全体(header + detail)基準で
   * 垂直配置されてタイトル行とズレていた。row-main に横並びを閉じ込めることで円がタイトル行と
   * センタリングされ、detail は下に素直に開く。 */
  li {
    display: flex;
    flex-direction: column;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  li:last-child { border-bottom: none; }
  /* 行の主部(チェック円・タイトル/メタ・ⓘ・becoming タグ)。align-items:center でチェック円が
   * タイトル行に対して垂直センタリングされる(フィードバック①の修正。detail は li 直下の別の子なので
   * この centering には巻き込まれない)。 */
  .row-main {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* ⓘ(info)アイコン: 詳細展開の主 affordance(フィードバック②)。44px 平方でタップ領域を確保
   * (見た目の字は小さめ・muted)。塗り無し・枠無しで控えめに置き、押下・展開中は fg 色にする。 */
  button.info {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 18px;
    line-height: 1;
    color: var(--muted);
    background: none;
    border: none;
    cursor: pointer;
  }
  button.info[aria-expanded="true"] { color: var(--fg); }

  /* --- チェックボタン(実 <button> + aria-pressed)------------------------------
   * 見た目は 22px の丸(iOS リマインダーの円形チェックの語彙)だが、ボタン自体は
   * 44px 平方でタップ領域を確保する(円だけをボタンにすると老眼・移動中の誤タップ地獄)。
   * 円は擬似要素ではなく span で描く(spinner への差し替えを DOM で素直にやるため)。 */
  button.check {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    /* フォーカスリングは消さない(アクセシビリティ要件)。ブラウザ既定の
     * outline をそのまま使う — outline:none は書かない。 */
  }
  button.check:disabled { cursor: default; }
  .circle {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1.5px solid var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    line-height: 1;
    color: transparent;
  }
  /* 完了状態: accent 塗り + 白チェック(iOS の完了円と同じ)。 */
  li.done .circle {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }
  /* 【2026-07-14 ドクトリン改訂: pending スピナーを廃止】
   * 旧実装はタップ〜サーバー確定の間、チェック円を「上弧だけ accent の回転スピナー」にして
   * 「送信したが未確定」を悲観的に表現していた(楽観確定しない設計)。この li.pending .circle
   * 回転 CSS と @keyframes spin・reduced-motion 分岐は削除した。
   * 【なぜ覆したか(Why not 悲観 UI)】①手本の iOS リマインダー自身が楽観更新で、悲観 UI は
   * 「iOS 準拠」基準と矛盾する ②実測レイテンシ(update 約 600ms〜)で回転スピナーは
   * 「タップが効いていない/クラッシュした?」体験になると実機で確認した ③失敗は稀で、
   * 稀な失敗のために毎回を遅く見せるのは配分が逆。以後トグルは楽観適用(その場で塗り丸/破線に
   * becoming を即時に乗せる)し、失敗時だけロールバック+エラーバナーで告知する
   * (entry 側 toggleTask のコメント参照)。pending 概念自体は entry の pendingIds に in-flight
   * の二重送信ガードとして残すが、見た目のブロッキング(disabled・スピナー)はしない。 */

  /* --- 行テキスト --------------------------------------------------------------
   * 1行目: タイトル。2行目: 優先度 ! 記号 + due(あるものだけ)。
   * meta を右端に寄せず title の下に置くのは、320px 幅で右カラム型にすると
   * タイトルの折り返し余地が消えて窮屈になるため(スパイク実装からの変更点)。 */
  /* 旧 .texts(check の隣の縦積みラッパ)は 2026-07-14 UI フィードバック対応で廃止し、header を
   * row-main 直下に置いた(flex:1/min-width:0/padding は .row-head へ移設)。 */
  .title { overflow-wrap: break-word; line-height: 1.35; }
  li.done .title {
    text-decoration: line-through;
    color: var(--muted);
  }
  .meta { margin-top: 1px; font-size: 12px; color: var(--muted); display: flex; gap: 6px; }
  /* 優先度は iOS リマインダーと同じ「!」記号(!=低 / !!=中 / !!!=高)+オレンジ。
   * バッジや文字ラベルにしない理由: iOS ユーザーが既に学習済みの記号をそのまま使う方が
   * 認知コストゼロ(冒頭「デザインの語彙」コメント)。 */
  .pri { color: var(--pri); font-weight: 700; letter-spacing: 1px; }
  .due { }
  .due.overdue { color: var(--danger); }
  .notes {
    margin-top: 1px;
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: break-word;
  }

  /* --- becoming(変化の中間状態)------------------------------------------------
   * 直前の操作で変化した行に「いま変わった」の静的な form を1回の描画だけ与える
   * (ステートレス: 次に affected/removed の無い応答が来れば自然に平常へ戻る)。
   * アニメーションは使わない — 会話ログ内の従属カードが勝手に動くのはノイズだし、
   * fresh-instance 描画のたびに再生されて「また今起きた」ように誤読させるため。
   *
   * 【2026-07-14 例外: 不確定進行(in-flight)の状態通信だけは Shimmer を許す】
   * 上の「becoming はステートレスな静的 form」は"もう起きたこと"の表現規律であって、
   * "いま結果が未確定で進行中"を伝える手段が無いこと自体は別の穴だった(quick-add の仮行が
   * 確定/失敗までの間、見た目上は追加済み行と区別が付かない)。装飾・遷移アニメの禁止は
   * 不変だが、進行中であること自体をユーザーに伝える通信目的の動きは対象外とする —
   * 「動きが情報を運ぶか(進行中の告知)/ノイズか(ただの演出)」で線を引く。適用は
   * 仮行(.inflight、優待生成される optimistic: 行)限定・CSS アニメーションのみ
   * (linear・約1.2s ループ・background-position だけを動かし layout は起こさない。
   * 詳細根拠は li.becoming-in.inflight のコメント参照)。 */

  /* becoming マイクロラベル(行右端。「完了/追加/期日変更/削除」等の短い日本語)。
   * 語彙をアイコンでなく文字にするのは、変化の種別が4つ以上あり記号の学習コストが
   * 見合わないため(形は行側が語る。ラベルは確認の一言)。 */
  .tag {
    flex-shrink: 0;
    align-self: center;
    font-size: 10.5px;
    letter-spacing: 0.03em;
    color: var(--muted);
    padding-left: 4px;
    white-space: nowrap;
  }

  /* completed: その場に留まり「いま完了した」を凍結表示。
   * form = 丸の外に静止した同心リング(波紋の1フレーム = box-shadow 1枚)。
   * 取消線・減光は li.done の恒久記号をそのまま使う(becoming 側では足さない)。
   * Why not 行ごと薄緑ハイライト: 面のハイライトは「移動した/選択された」と
   * 誤読されやすい。変化の主体は丸チェックなので、リングを丸に局在させる。
   * Why not 完了セクションへ即移動: 押した場所から行が消えると操作の因果が切れる。
   * 行はその場(元のセクション)に留め、次回描画で完了欄へ移る(entry の sectionize)。 */
  li.becoming-done .circle { box-shadow: 0 0 0 4px var(--accent-soft); }
  li.becoming-done .tag { color: var(--accent); }

  /* reopened: completed の逆再生の1フレーム。form = 塗りが抜けて破線に戻りかけた丸
   * (accent 色の破線)+ 同じ凍結リング。取消線は既に無い(li.done が外れる)ので、
   * 丸の質感だけで「いま未完了に戻った」を語る。completed(実線塗り+リング)と
   * reopened(破線空+リング)が同じリングを共有することで「同じ操作の往復」だと分かる。 */
  li.becoming-undone .circle {
    border-style: dashed;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  li.becoming-undone .tag { color: var(--accent); }

  /* added: becoming-in。form = 左端 2px バー + 右へ減衰する淡い wake(入射の残像)。
   * バーは inset box-shadow で角丸内側に収め、行構造は通常行と同一のまま
   * (次の描画で装飾だけ消え、すぐ日常に溶ける)。位置は本来のソート位置。 */
  li.becoming-in {
    box-shadow: inset 2px 0 0 var(--add);
    background: linear-gradient(to right, var(--add-wake), transparent 55%);
  }
  li.becoming-in .tag { color: var(--add); }

  /* in-flight シマー(quick-add 仮行限定・.inflight は renderRow が isOptimisticId(task.id) の
   * ときだけ付与)。新しい色は導入せず、既存の wake グラデ(--add-wake)を横に掃くだけ:
   * background-size を 200% に広げて同じグラデを敷き詰め、background-position を動かして
   * 「帯が左→右に流れる」錯覚を作る(グラデ自体の形・色は変えない = 「動きだけ足す」の実現方法)。
   * 【技術指針の根拠(emil-design-eng skill 準拠)】
   *   - easing は linear: 定常的にループし続ける運動なので、ease だと毎周期の減速/加速が
   *     ノイズになる(linear = 「継続中である」ことだけを均等に伝える)。
   *   - 周期は 1.2s: 完了操作の box-shadow パルス(.skel の pulse も同じ 1.2s)に速度感を揃えつつ、
   *     「速めのほうが知覚上テキパキ感が出る」指針に合わせ skeleton より詰めた帯にはしていない
   *     (帯自体の見た目は同じグラデを流用するので周期だけで速さを作る)。
   *   - CSS アニメーションのみで JS 駆動にしない: create-todo 応答待ち中はメインスレッドで
   *     fetch/JSON 処理が走る。JS の rAF 駆動だとそこでコマ落ちし「固まった」ように見えるが、
   *     CSS アニメーションはコンポジタスレッドで進行するため無関係に滑らかに動き続ける。
   *   - 動かすプロパティは background-position のみ(transform 系ではなく background なのは、
   *     このグラデ自体が background-image なため。position の変更はレイアウトにもペイントの
   *     再計算対象領域拡大にも影響しない = リフローを起こさない)。 */
  li.becoming-in.inflight {
    background-size: 200% 100%;
    animation: wake-sweep 1.2s linear infinite;
  }
  @keyframes wake-sweep {
    from { background-position: -100% 0; }
    to { background-position: 100% 0; }
  }
  /* reduced-motion: シマーを止め、becoming-in 本来の静的 wake(帯の先頭が見える位置)に戻す。
   * background-position: 0 0 は通常の li.becoming-in と同じ描画結果になる。 */
  @media (prefers-reduced-motion: reduce) {
    li.becoming-in.inflight { animation: none; background-position: 0 0; }
  }

  /* edited: 変更フィールドの旧値→新値をインラインで凍結表示(例: 7/14 → 7/18)。
   * 旧値は取消線ではなく減光のみ — 取消線=完了の恒久記号、という一貫性を守るため。 */
  li.becoming-edit .tag { color: var(--edit); }
  .meta .old { color: var(--muted); opacity: 0.6; }
  .meta .arrow { color: var(--muted); opacity: 0.6; padding: 0 2px; }
  .meta .new { color: var(--edit); font-weight: 600; }
  .meta .more { color: var(--muted); }

  /* removed: becoming-gone(削除ゴースト)。contract の removed:[{id,title,due?}] から
   * その場描画する「もう存在しない行」。form = 中身が抜け輪郭だけが残る:
   * 破線ボックス + 45% 減光 + 破線丸。縦寸をわずかに詰め「畳まれつつある途中」を示す。
   * 取消線は使わない(取消線=完了の恒久記号 → completed と form で厳密に区別)。
   * min-height 44px の例外: 操作対象外(既に消えた行、チェックボタンも持たない)。 */
  li.becoming-gone {
    margin: 4px 0;
    padding: 3px 8px;
    min-height: 38px;
    align-items: center;
    border: 1px dashed var(--del-border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  /* ゴーストはチェックボタン(44px)を持たないため、丸の水平位置を通常行に揃える
   * (44px ボタン内の 22px 円は左から 11px。8px はボックス内 padding で消化済み)。 */
  li.becoming-gone .circle { border-style: dashed; opacity: 0.45; margin: 0 4px 0 3px; }
  /* ゴースト行は row-main 直下の row-head を減光する(2026-07-14 UI フィードバック対応で .texts 廃止)。 */
  li.becoming-gone .row-head { opacity: 0.45; padding: 6px 0; }

  /* --- 操作結果の読み上げ(視覚非表示の aria-live)-------------------------------
   * becoming は視覚専用の表現なので、スクリーンリーダー向けには #live に
   * 「「牛乳を買う」を完了しました」等のテキストを別途流す(entry が組み立てる)。
   * 定番の visually-hidden パターン(display:none だと aria-live が読まれない)。 */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* --- 空/スケルトン ----------------------------------------------------------- */
  .empty { color: var(--muted); padding: 12px 0; }
  /* スケルトン: 接続〜初回 tool-result の間に出す「行の影」3本。テキストの点滅より
   * 「リストが来る場所」を予告できるので体感が安定する。shimmer は opacity パルスで
   * 表現(グラデーション移動より実装が軽く、reduced-motion で単純に止めやすい)。 */
  .skel { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
  .skel-circle { width: 22px; height: 22px; border-radius: 50%; background: var(--surface); margin: 0 11px; }
  .skel-line { height: 12px; border-radius: 6px; background: var(--surface); }
  .skel, .skel * { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) {
    .skel, .skel * { animation: none; }
  }

  /* --- quick-add(E-2 スライス③: タイトル1行の素早い追加)-------------------------
   * 一覧の末尾に常設する入力行。iOS リマインダーの「新規リマインダー」入力に語彙を寄せる
   * (プレースホルダ・末尾配置)。入力とボタンはどちらも 44px 高でタッチターゲットを確保する。
   * 【2026-07-14 ドクトリン改訂: 送信中も入力可能のまま維持】
   * 旧実装は create-todo 応答待ちの間 input/button を disabled にして二重送信を防いでいた。
   * 楽観更新へ転換したので、送信即・入力をクリアして入力可能のまま維持し、仮タスクを
   * その場に挿入する(連続投入できる)。disabled による見た目のブロックはしない
   * (:disabled スタイルは失敗ロールバック等の将来用途に残すが、通常フローでは当たらない)。 */
  /* 【E-2 スライス⑥前半: 段階的開示】1行目(入力+詳細トグル+追加)を .quick-add-row に包み、
   * その下に詳細パネル(#quick-add-detail)を縦に積む構造へ変えた。既定は1行目だけ表示=高速パス。
   * 詳細を開いても入力欄の位置(会話に一番近い操作面)は動かない。 */
  /* 2026-07-14 UI フィードバック対応: quick-add をボトムシート化(FAB で開閉)。以前はカード下端に
   * 常時インラインで置いていた(margin-top/border-top)。常時表示の「詳細」トグルが行の詳細表示と
   * 誤認される原因だったため、既定 hidden にして FAB タップ時だけ position:fixed の下部シートとして
   * 開く。開閉アニメは無し(ドクトリン)= hidden 属性の有無だけ。z-index はシート 40 / FAB 50 で、
   * becoming 装飾や詳細展開(#root 内の通常フロー)より前面に出す。 */
  .quick-add {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.18);
  }
  .quick-add-row { display: flex; gap: 8px; }
  /* 追加 FAB。56px 円(≥44px タップ)。カード右下固定。開いている間は entry が hidden にする。 */
  .fab {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 50;
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-family: inherit;
    font-size: 30px;
    line-height: 1;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 50%;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
    cursor: pointer;
  }
  .quick-add-input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0 10px;
    font-family: inherit;
    font-size: 14px;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  /* フォーカスリングはブラウザ既定を残す(outline:none は書かない — アクセシビリティ要件)。 */
  .quick-add-input:disabled { opacity: 0.5; }
  .quick-add button {
    flex-shrink: 0;
    min-height: 44px;
    min-width: 44px;
    padding: 0 14px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .quick-add button:disabled { opacity: 0.5; cursor: default; }

  /* --- 優先度インライン記号(E-2 スライス③: タイトル前に表示)-----------------------
   * iOS リマインダーは優先度の「!」記号をタイトルの左に置く。このプロトタイプは以前 meta 行
   * (2行目)に出していたが、iOS の語彙(タイトル前・オレンジ)に合わせて title 先頭へ移した。
   * becoming の優先度差分(旧→新の語表示)は引き続き meta 行に出す(一過性の差分は差分の言語で
   * 語る、という既存方針。todos-entry.ts の planEdit / priChange コメント参照)。 */
  .title .pri-inline {
    color: var(--pri);
    font-weight: 700;
    letter-spacing: 1px;
    margin-right: 4px;
  }

  /* --- 繰り返しバッジ / メモ有りインジケータ(E-2 スライス⑤)---------------------------
   * どちらも「一覧の走査を妨げない控えめな記号」を狙う(iOS リマインダーのサブ情報の密度に寄せる)。
   * 繰り返しは meta 行(due の隣)に ⟳ + 短い日本語。メモ有りはタイトル末尾に ≡ を薄く。 */
  .recur { color: var(--muted); white-space: nowrap; }
  /* メモ有り記号「≡」。タイトル本文と隣接するので少し間を空け、色を落として主張を抑える。 */
  .note-mark {
    margin-left: 6px;
    color: var(--muted);
    font-size: 12px;
    /* 記号だけがベースラインで浮かないよう、行の他要素と縦位置を揃える。 */
    vertical-align: baseline;
  }

  /* --- 行タイトルのタップ開閉領域(E-2 スライス⑤・詳細展開)-----------------------------
   * texts(flex:1 の縦積み)の中の header がタップ対象。align-self:stretch で li の高さ
   * (チェックボタン 44px)まで伸ばし、タイトルが短くてもタップ面が 44px 確保される
   * (44px タッチターゲット維持の要件)。cursor:pointer で押せることを示す。 */
  /* row-head(タイトル+メタのタップ開閉領域)。2026-07-14 UI フィードバック対応で texts ラッパを
   * 廃し header を row-main 直下に置いたので、旧 .texts が持っていた flex:1 / min-width:0 をここへ移す
   * (行の余白いっぱいにタイトルを広げ、長文が check/ⓘ を押し出さないよう min-width:0 で縮小を許可)。 */
  .row-head {
    flex: 1;
    min-width: 0;
    cursor: pointer;
    min-height: 44px;
    padding: 8px 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  /* フォーカスリングはブラウザ既定を残す(role=button のキーボード操作可視化。outline:none は書かない)。 */

  /* --- 詳細展開パネル(E-2 スライス⑤)--------------------------------------------------
   * header の下(texts 内)に開くインライン詳細。開閉アニメは無し(ドクトリン)= DOM の
   * 有無だけで表現する。左に薄い罫線を引いて「この行に属する詳細」であることを示す。 */
  .detail {
    /* 2026-07-14 UI フィードバック対応: detail は li 直下(row-main の下)に移ったので、check の幅
     * (44px)ぶん左インデントして「タイトルに属する詳細」であることを示す(以前は texts 内にあり
     * 自然に字下げされていた)。 */
    margin: 4px 0 8px 44px;
    padding: 8px 0 4px 10px;
    border-left: 2px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--fg);
  }
  /* メモ全文: 改行を保持(pre-wrap)し、長文は max-height + 縦スクロールで畳む
   * (カード全体が長大化してホストの会話スクロールを圧迫しないため)。 */
  .detail-notes {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    max-height: 200px;
    overflow-y: auto;
    color: var(--muted);
  }
  .detail-row { color: var(--muted); overflow-wrap: anywhere; }
  .detail-label { color: var(--fg); }
  /* 削除ボタン: danger 系。展開内のみに置くこと自体が確認段階(confirm ダイアログは出さない)。
   * 幅は内容ぴったり(align-self:flex-start)にして、行いっぱいの赤帯で威圧しない。44px 高で
   * タッチターゲットを確保する。塗りつぶしではなく danger 枠 + danger 文字にして、破壊操作だが
   * 「一段深い場所に自分で降りてきて押す」前提の落ち着いた見た目にする。 */
  .detail-delete {
    align-self: flex-start;
    min-height: 44px;
    padding: 0 16px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .detail-delete:disabled { opacity: 0.5; cursor: default; }

  /* --- 段階的開示・共通フォーム部品(E-2 スライス⑥前半)-------------------------------
   * quick-add の詳細パネルと詳細展開の編集フォームで同じ入力部品(日付 input・優先度
   * セグメント・textarea)を使い回す。iOS リマインダーの新規/編集フォームが同じ見た目の
   * 語彙で date/優先度/メモを出す語彙に寄せる。全部品 44px 高でタッチターゲットを確保する。
   * 【なぜカスタム日付ピッカーを作らないか】ネイティブ input(type="date"/"datetime-local")に
   * 委ねる。自前ピッカーはタイムゾーン/ロケール/アクセシビリティ/reduced-motion を全部
   * 自前で背負う羽目になり、サンドボックス iframe 内での品質保証コストが見合わない
   * (iOS/各ホストのネイティブピッカーの方が学習コストもゼロ)。 */
  .field-date, .field-text {
    min-height: 44px;
    padding: 0 10px;
    font-family: inherit;
    font-size: 14px;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    /* iOS Safari が date/datetime-local を独自スタイルで潰さないよう最低限の見た目を担保する。 */
    min-width: 0;
  }
  .field-text { flex: 1; }
  .field-textarea {
    min-height: 66px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.4;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    /* 縦方向だけリサイズ可(横に広げるとカード幅を壊すため)。 */
    resize: vertical;
  }
  /* フォーカスリングはブラウザ既定を残す(outline:none は書かない — アクセシビリティ要件)。 */

  /* 詳細トグル / 時刻指定トグル等の控えめな2次ボタン(塗りつぶさない・muted 文字)。 */
  .mini-toggle {
    flex-shrink: 0;
    min-height: 44px;
    min-width: 44px;
    padding: 0 10px;
    font-family: inherit;
    font-size: 12px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    white-space: nowrap;
  }
  /* 開いている/有効化している状態は文字色を上げて示す(塗りつぶしにはしない=控えめさを保つ)。 */
  .mini-toggle[aria-expanded="true"], .mini-toggle[aria-pressed="true"] { color: var(--fg); }

  /* 優先度セグメント(なし・!・!!・!!!)。iOS のセグメンテッドコントロールに寄せる。
   * 選択中は accent 塗り+白字。! 系(seg-pri)は未選択時にオレンジ文字(優先度=オレンジの語彙)。 */
  .seg {
    display: flex;
    align-self: flex-start;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    min-height: 44px;
    min-width: 44px;
    padding: 0 12px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    background: var(--bg);
    border: none;
    border-left: 1px solid var(--border);
    cursor: pointer;
  }
  .seg button:first-child { border-left: none; }
  .seg button.seg-pri { color: var(--pri); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }

  /* quick-add 詳細パネルと詳細編集フォームの1フィールド(ラベル + 入力を縦積み)。 */
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 12px; color: var(--muted); }
  /* 期日フィールドの行(日付 input + 時刻トグルを横並び。狭幅で折り返す)。 */
  .due-field-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  /* quick-add 詳細パネル本体。開閉アニメは無し(ドクトリン)= hidden 属性の有無だけで表現する。 */
  .qa-detail { display: flex; flex-direction: column; gap: 10px; padding: 2px 0; }

  /* 詳細展開内の編集フォーム(E-2 スライス⑥前半・仕様B)。読み取り行(繰り返し/場所/完了時刻)と
   * 削除ボタンの上に置く。保存ボタンは accent 塗り(quick-add の「追加」と同じ確定色)。 */
  .detail-edit { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
  .detail-save {
    align-self: flex-start;
    min-height: 44px;
    padding: 0 16px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .detail-save:disabled { opacity: 0.5; cursor: default; }

  /* ===========================================================================
   * v2(選択モデル + 詳細セミモーダル + スワイプ削除)追加スタイル。
   * 正 = scratchpad/todos-refined-v2.html。既存のテーマ変数戦略(ホスト注入 var + fallback)に
   * 合わせるため、モックの theme-light/theme-dark クラス変数はここで :root + prefers-color-scheme に
   * 落とし込む。要素側はこの自前変数だけを見る(冒頭「テーマ変数の方針」と一貫)。
   * ------------------------------------------------------------------------- */
  :root {
    /* 選択行の淡い背景・シート面・入力インセット・細い罫線・第3テキスト色・トグル色・scrim。
     * bg-subtle/inset はホスト注入 secondary 背景に乗れるものは乗せ、無ければ iOS 実測値。 */
    --bg-subtle: var(--color-background-secondary, #f7f7f8);
    --bg-inset: #f2f2f4;
    --sheet-bg: #f2f2f6;
    --border-hair: var(--color-border-secondary, #eeeef0);
    --text-3: #b4b4b8;
    --scrim: rgba(0, 0, 0, 0.28);
    --toggle-on: #34c759; /* iOS システムグリーン(トグル ON) */
    --toggle-off: #d1d1d6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-subtle: var(--color-background-secondary, #27272a);
      --bg-inset: #2a2a2e;
      --sheet-bg: #161618;
      --border-hair: var(--color-border-secondary, #2e2e32);
      --text-3: #5c5c62;
      --scrim: rgba(0, 0, 0, 0.5);
      --toggle-on: #30d158;
      --toggle-off: #4a4a4f;
    }
  }

  /* --- 行 head(タイトル2行の縦積み領域)。row-head は ghost 行が使うので温存し、新設 .head を足す。 */
  .head { flex: 1; min-width: 0; }
  /* meta を1行に保ち(nowrap)、becoming ラベルを右端へ押し出す(margin-left:auto。モック要件1・④修正)。 */
  .meta { align-items: baseline; flex-wrap: nowrap; min-width: 0; }
  .meta .loc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .meta .tag { margin-left: auto; padding-left: 8px; flex: none; }
  /* meta が実質空(due/⟳/📍 無し)の行では、becoming ラベルを rowMain 直下に置いて
   * タイトル行と同じ高さで右端に出す(2026-07-15: due 無しタスクの完了/再開でラベルが
   * 2段目に落ちて上下がずれる実機フィードバックの修正。entry の tagEl 配置分岐と対)。 */
  .row-main > .tag { margin-left: auto; padding-left: 8px; flex: none; }

  /* --- 選択状態(iOS: 行タップでタイトルが input 化・メモ行と ⓘ 出現)------------------------
   * 下線は出さない(ユーザー判断 2026-07-15。選択は bg-subtle 背景とメモ行・ⓘ の出現で十分伝わり、
   * キャレット(ネイティブカーソル)が担う情報の二重表現を避ける)。 */
  li.selected .row-main { background: var(--bg-subtle); border-radius: 10px; }
  .title-edit {
    display: block;
    width: 100%;
    font: inherit;
    color: var(--fg);
    border: none;
    background: none;
    outline: none;
    padding: 2px 0;
  }
  .memo-line {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 12px;
    color: var(--muted);
    border: none;
    background: none;
    outline: none;
    padding: 2px 0;
  }
  .title-edit::placeholder, .memo-line::placeholder { color: var(--text-3); }
  /* 選択行の ⓘ は accent 色で出す(存在自体が「詳細へ」の主導線)。 */
  li.selected button.info { color: var(--accent); }

  /* --- スワイプ削除(iOS 準拠。左スワイプ/長押しで右端に赤ボタンを露出)------------------------ */
  li.swiping { position: relative; overflow: hidden; }
  li.swiping .row-main {
    transform: translateX(-76px);
    position: relative;
    z-index: 1;
    background: var(--bg);
  }
  .swipe-del {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 76px;
    border: none;
    background: var(--danger);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  /* --- 詳細セミモーダル(ボトムシート)-----------------------------------------------------
   * quick-add FAB シートと同じ position:fixed の重ね方に倣う(内部にスクロールコンテナを作らない
   * ドクトリンとは別枠 — モーダルは会話フローの上に重なる面で、本文は sheet-body が内部スクロールする)。
   * height は max-height:88vh でコンテンツに応じて伸び、超えたら本文が内部スクロール(iframe が短くても破綻しない)。 */
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 60; }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 88vh;
    z-index: 61;
    display: flex;
    flex-direction: column;
    background: var(--sheet-bg);
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.18);
  }
  .grabber { width: 36px; height: 4px; border-radius: 2px; background: var(--text-3); opacity: 0.5; margin: 8px auto 2px; }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 12px 8px; }
  .sheet-head .h-title { font-size: 14px; font-weight: 600; color: var(--fg); }
  .icon-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .btn-x { background: var(--bg-inset); color: var(--muted); }
  .btn-ok { background: var(--accent); color: #fff; font-weight: 700; }
  .sheet-body { flex: 1; overflow-y: auto; padding: 4px 12px 16px; display: flex; flex-direction: column; gap: 12px; }
  .group { background: var(--bg); border-radius: 12px; overflow: hidden; }
  .g-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 12px; font-size: 13.5px; color: var(--fg); }
  .g-row + .g-row { border-top: 1px solid var(--border-hair); }
  .g-row .g-icon { flex: none; width: 20px; text-align: center; color: var(--muted); }
  .g-row .g-label { flex: 1; min-width: 0; display: flex; align-items: center; }
  .g-row .g-value { flex: none; color: var(--muted); display: flex; align-items: center; gap: 4px; cursor: pointer; }
  /* 値=メニュー(pull-down)の行には小さな ⌵ を添える(iOS の値メニューの記号)。 */
  .g-row .g-value.menu::after { content: "⌵"; font-size: 11px; color: var(--text-3); }
  .g-value.readonly { color: var(--text-3); cursor: default; }
  /* タイトル+メモ グループ(大きめタイトル入力 + メモ placeholder)。 */
  .title-input {
    font: inherit;
    font-size: 17px;
    font-weight: 600;
    color: var(--fg);
    width: 100%;
    border: none;
    background: none;
    padding: 12px 12px 2px;
    outline: none;
  }
  .notes-input {
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    width: 100%;
    border: none;
    background: none;
    padding: 2px 12px 12px;
    outline: none;
    resize: none;
    min-height: 34px;
  }
  .notes-input::placeholder, .title-input::placeholder { color: var(--text-3); }
  /* iOS 風トグル。 */
  .toggle { flex: none; width: 44px; height: 26px; border-radius: 13px; background: var(--toggle-off); position: relative; cursor: pointer; }
  .toggle::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .toggle.on { background: var(--toggle-on); }
  .toggle.on::after { left: auto; right: 2px; }
  /* 値=入力の一本化(枠なし・accent 色のネイティブ input を「値の位置」に置く)。カレンダー/時計
   * ピッカーはネイティブ(iOS ホイール等)にそのまま委ねる。::-webkit-calendar-picker-indicator は
   * 非表示にして「値テキストだけ」に見せる(モック要件3)。 */
  .value-input {
    font: inherit;
    font-size: 12.5px;
    color: var(--accent);
    border: none;
    background: none;
    padding: 0;
    outline: none;
    margin-left: 8px;
  }
  .value-input::-webkit-calendar-picker-indicator { display: none; }
  /* 場所などテキスト系はトグル ON 時に枠付き入力行を出す(自由入力は枠の方が編集可能性が伝わる)。 */
  .g-input { display: flex; align-items: center; gap: 8px; padding: 6px 12px 10px 42px; }
  .g-input input[type="text"] {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }
  /* 曜日チップ(繰り返し=毎週/隔週のとき)。 */
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 2px 12px 10px 42px; }
  .chips button {
    font: inherit;
    font-size: 12px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-inset);
    color: var(--muted);
    cursor: pointer;
  }
  .chips button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }

  /* --- 繰り返し/終了/優先度のポップアップメニュー(iOS pull-down)。fixed 配置(JS が座標を書く)。 */
  .menu-pop {
    position: fixed;
    width: 200px;
    z-index: 70;
    background: var(--bg);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
    border: 1px solid var(--border-hair);
  }
  .menu-pop .m-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 13.5px; cursor: pointer; color: var(--fg); }
  .menu-pop .m-row + .m-row { border-top: 1px solid var(--border-hair); }
  .menu-pop .m-row .m-check { width: 14px; color: var(--accent); font-weight: 700; }
  .menu-pop .m-row.m-sep { border-top: 6px solid var(--bg-inset); }
  .menu-pop .m-row.m-disabled { color: var(--text-3); cursor: default; }
</style>
</head>
<body>
  <header class="bar">
    <div class="bar-left">
      <!-- E-2 スライス③: 見出しを「対象リスト名」にする。以前は固定文言「リマインダー」で、どの
           コレクションを見ているかが曖昧だった(複数リスト運用・quick-add の作成先が不明)。entry が
           vm.calendarId を書き込む。データ到着前のプレースホルダとして「リマインダー」を初期表示する。
           【将来課題】いまは calendarId(コレクションの内部 ID 文字列)をそのまま出す。iOS リマインダーの
           リスト名に相当する displayname(CalDAV の DAV:displayname プロパティ)取得は未実装なので、
           人間可読名が要るなら別途 principal→コレクション displayname を引く経路を足す(このスライス外)。 -->
      <span id="app-title" class="app-title">リマインダー</span>
      <!-- 最終更新 HH:mm。entry が成功データ受領のたびに書く(空のうちは非表示同然)。 -->
      <span id="updated" class="updated"></span>
    </div>
    <!-- 手動「再読込」ボタンは廃止(refetchOnWindowFocus 化。todos-entry.ts 参照)。 -->
  </header>
  <!-- 操作失敗・接続失敗を「リストを壊さずに」重ねるバナー(既定 hidden)。 -->
  <div id="banner" class="banner" hidden></div>
  <!-- 接続フェーズの診断行(iOS WebView にコンソールが無いための画面デバッグ導線)。 -->
  <div id="status" class="status" hidden></div>
  <!-- 一覧本体。entry が skeleton → sections で書き換える。 -->
  <div id="root"></div>
  <!-- quick-add(E-2 スライス③): タイトル1行だけの素早い追加口。#root の外(常時ある操作面)に
       置くのはヘッダと同じ理由 — #root は再描画のたびに innerHTML で作り直されるので、その中に
       入力欄を置くと再描画のたびに未確定の入力文字が消える。ここに置けば描画に巻き込まれない。
       【役割分担】quick-add はタイトルのみ。due/優先度/メモ/反復の指定はチャット(create-todo を
       LLM が呼ぶ)の領分にする — フォームに詰め込むと timeZone 選択・日付ピッカー等①の外の複雑さを
       一気に抱える(todos-entry.ts の「作成フォームを持たない理由」も同旨)。素早い1行投入だけを担う。
       form 要素にするのは Enter 送信を素直に拾うため(submit を entry が listen し、IME 変換確定の
       Enter は isComposing で弾く)。 -->
  <!-- E-2 スライス⑥前半: quick-add に段階的開示を足す。1行目(.quick-add-row)は従来どおりの
       高速パス(タイトル+追加)。その脇に小さな「詳細」トグルを置き、押すと #quick-add-detail
       (期日/優先度/メモ)が下に開く。詳細パネルの中身(ネイティブ日付 input・優先度セグメント・
       メモ textarea)は entry 側が JS で1回だけ組み立てて append する — 静的 HTML で書かず JS 構築に
       するのは、日付 input の type 切替(date⇄datetime-local)や優先度セグメントの選択状態を
       素直に扱うため。#quick-add は #root の外なので再描画に巻き込まれず、組み立てた部品の
       入力値・展開状態は list 再描画で消えない(ヘッダと同じ理由)。 -->
  <!-- 2026-07-14 UI フィードバック対応: quick-add を FAB 化。フォームは既定で hidden の「ボトムシート」。
       カード右下固定の ＋ FAB(#quick-add-fab)をタップしたときだけ開き(入力へ自動フォーカス)、
       送信 or 外側タップで閉じる(iOS リマインダーの作法)。仮行の楽観挿入・シマー・IME ガード等の
       既存挙動は不変(submitQuickAdd はそのまま)。「詳細」トグルはフォーム内に残す(常時表示だった
       ことが「quick-add の詳細ボタン=行の詳細表示」との誤認の原因だったので、開いたときだけ見える)。 -->
  <form id="quick-add" class="quick-add" hidden>
    <div class="quick-add-row">
      <input
        id="quick-add-input"
        type="text"
        class="quick-add-input"
        autocomplete="off"
        placeholder="新しいリマインダー"
        aria-label="新しいリマインダーのタイトル"
      />
      <!-- 詳細トグル(disclosure)。type="button" で form の暗黙 submit を起こさない。 -->
      <button
        id="quick-add-detail-toggle"
        type="button"
        class="mini-toggle"
        aria-expanded="false"
        aria-controls="quick-add-detail"
      >詳細</button>
      <button id="quick-add-btn" type="submit">追加</button>
    </div>
    <!-- 詳細パネル(既定 hidden)。中身は entry の buildQuickAddDetail() が append する。 -->
    <div id="quick-add-detail" class="qa-detail" hidden></div>
  </form>
  <!-- 追加 FAB(2026-07-14 UI フィードバック対応)。カード右下固定。タップで上の quick-add シート
       を開く。開いている間は entry が hidden にして重なりを避ける。type="button" で暗黙 submit を防ぐ。 -->
  <button id="quick-add-fab" class="fab" type="button" aria-label="リマインダーを追加">＋</button>
  <!-- v2 詳細セミモーダル(ボトムシート)の描画先。#root(一覧)とは独立した常設コンテナで、
       一覧再描画(renderAll の innerHTML)に巻き込まれない。todos-entry.ts の openSheet/closeSheet が
       この中に scrim + sheet を出し入れする(空のうちは何も描かれない)。 -->
  <div id="sheet-root"></div>
  <!-- 操作結果の読み上げ専用(視覚非表示)。becoming の視覚表現と対になる音声版で、
       entry が affected/removed から「〜を完了しました」等を組み立てて書き込む。
       role="status" = aria-live:polite 相当(一覧の再描画を遮らずに読み上げる)。 -->
  <div id="live" class="sr-only" role="status"></div>

<script type="module">
${TODOS_BUNDLE_JS}
</script>
</body>
</html>
`;
