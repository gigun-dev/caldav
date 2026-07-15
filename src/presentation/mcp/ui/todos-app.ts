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
  /* lucide アイコン共通(2026-07-15 絵文字/文字グリフからの置換)。svg は既定 inline で
   * ベースラインが文字より下に沈むため、テキストと同じ行に混在する箇所(.loc/.recur 以外の
   * 素朴な inline 配置箇所)向けに軽い引き上げをデフォルトにしておく。flex コンテナ側で
   * align-items:center している箇所(button.check/.info 等)ではこの vertical-align は無効なので
   * 副作用は無い。 */
  .lucide-icon { vertical-align: -0.125em; }
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
    /* 2026-07-14 UI フィードバック対応: 右下固定 FAB が最終行に被らないよう下余白を確保
     * (FAB は position:fixed で通常フローに場所を取らないため、body 側で退避スペースを空ける)。
     * 2026-07-15: FAB を 56px→40px に縮小したのに合わせて退避量も比例して詰める。 */
    padding-bottom: 64px;
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

  /* --- 追加 FAB(+)。カード右下固定の円(2026-07-15 に 56px→40px へ縮小・下記フィードバック参照)---
   * タップで一覧末尾に空のドラフト行を選択状態で生やす(entry の startDraft)。詳細/リスト選択ページ
   * 表示中は entry が hidden にして重なりを避ける。
   * 【v2→v3 で覆した点(経緯・財産)】v2 はこの FAB が position:fixed の quick-add ボトムシート
   * (.quick-add / .quick-add-row / .quick-add-input / .quick-add button + 段階的開示パネル)を開いていた。
   * それら quick-add シートの CSS はすべて削除した — 詳細シートと同じ fixed+vh の実機バグ(iframe 高さ
   * 自動リサイズと噛み合わず本文がスクロールできない/下部が見切れる)を quick-add シートも抱えており、
   * かつ「シートを開く」より「行末に空行が生えて即入力」の方が iOS のトーンに合うとのユーザー確定による。
   * 新規行は既存の選択状態 CSS(li.selected / .title-edit / .memo-line / .info)をそのまま流用するので、
   * 追加専用の入力欄 CSS は不要になった。FAB の色(accent)・右下固定・円形は v2 から不変、サイズのみ
   * 2026-07-15 に縮小した。 */
  /* 【2026-07-15 実機フィードバック: FAB が大きすぎる】56px の円は「常時目に入る主張の強すぎる
   * ボタン」に見えるとの評価。新規追加は頻度の低い操作(既存行の操作の方が高頻度)なので、
   * 存在は分かるが控えめな「静かな追加口」へ 40px に縮小する(44px タップ推奨をわずかに割るが、
   * 円形の余白込みで実タップ領域はほぼ変わらず、かつ FAB は唯一の独立操作面で誤タップの実害が
   * 小さいため許容)。アイコンも 30px 相当の主張から 18px へ絞る。 */
  .fab {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 50;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-family: inherit;
    font-size: 18px;
    line-height: 1;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 50%;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
    cursor: pointer;
  }

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
   * 繰り返しは meta 行(due の隣)にアイコン + 短い日本語。メモ有りはタイトル末尾にアイコンを薄く。
   * 2026-07-15: 絵文字(⟳ ≡)から lucide の svg へ置換したので、inline-flex + gap で
   * アイコンとテキストの縦位置を揃える(絵文字は文字扱いでベースライン整列が自動だったが、
   * svg は既定 inline で下端が微妙にズレるため明示的に align-items:center する)。 */
  .recur { display: inline-flex; align-items: center; gap: 3px; color: var(--muted); white-space: nowrap; }
  /* メモ有りアイコン。タイトル本文と隣接するので少し間を空け、色を落として主張を抑える。 */
  .note-mark {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: 6px;
    color: var(--muted);
    font-size: 12px;
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

  /* --- 旧・行内インライン詳細 + quick-add/編集フォーム共通部品(v3 で全廃)---------------------
   * 【v2→v3 で覆した点(経緯・財産)】ここには2世代ぶんの死んだ CSS があったので削除した:
   *   ① E-2 スライス⑤の行内インライン詳細(.detail / .detail-notes / .detail-row / .detail-label /
   *      .detail-delete)— 行の下に開く詳細展開。v2 で「行選択 → ⓘ で詳細シート」へ作り替えた時点で
   *      既に未使用になっていた(整理漏れ)。
   *   ② E-2 スライス⑥前半の共通フォーム部品(.field-date/.field-text/.field-textarea/.mini-toggle/
   *      .seg/.seg-pri/.field/.field-label/.due-field-row/.qa-detail/.detail-edit/.detail-save)—
   *      quick-add 詳細パネルと v2 詳細フォームで共用していた入力部品。v3 で quick-add シートを廃止し
   *      (FAB→ドラフト行)、詳細ページを裸 input + 行内 chips の素の DOM に作り替えたため全て未使用に。
   * v3 の詳細ページの見た目は上の「v3 詳細ページ / リスト選択ページ」ブロック(.f-row/.naked/.sw/
   * .chips/.f-expand 等)に集約した。新規行は既存の選択状態 CSS(li.selected / .title-edit /
   * .memo-line)を流用するので、追加専用の入力部品 CSS も要らなくなった。 */

  /* ===========================================================================
   * v2(選択モデル + スワイプ削除)追加スタイル(一覧行が使う。詳細セミモーダル系は v3 で別ブロックへ)。
   * 正 = scratchpad/todos-refined-v2.html。既存のテーマ変数戦略(ホスト注入 var + fallback)に
   * 合わせるため、モックの theme-light/theme-dark クラス変数はここで :root + prefers-color-scheme に
   * 落とし込む。要素側はこの自前変数だけを見る(冒頭「テーマ変数の方針」と一貫)。
   * ------------------------------------------------------------------------- */
  :root {
    /* 選択行の淡い背景・細い罫線・第3テキスト色。bg-subtle はホスト注入 secondary 背景に乗れれば
     * 乗せ、無ければ iOS 実測値。
     * 【v2→v3 で覆した点】--bg-inset / --sheet-bg / --scrim / --toggle-on(iOS システムグリーン)/
     * --toggle-off は v2 のボトムシート + 緑トグル + inset 白箱 + scrim 専用だったので削除した
     * (v3 はカード内ページ遷移で scrim もシート面も不要、トグルは accent の button.sw に統一。
     * 廃止理由の詳細は下の v3 詳細ページ CSS のヘッダコメント参照)。 */
    --bg-subtle: var(--color-background-secondary, #f7f7f8);
    --border-hair: var(--color-border-secondary, #eeeef0);
    --text-3: #b4b4b8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-subtle: var(--color-background-secondary, #27272a);
      --border-hair: var(--color-border-secondary, #2e2e32);
      --text-3: #5c5c62;
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
  /* 【2026-07-15 実機フィードバック修正】選択時に優先度 !記号(pri-inline)とメモ有りアイコン
   * (note-mark)が消えていたバグの修正で新設。非選択時の .title(pri-inline + テキスト + note-mark)と
   * 同じ横並びを input と共存させるための行ラッパ(pri-inline はそのまま流用、真ん中の input だけ
   * flex:1 で伸ばす)。 */
  .title-edit-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .title-edit {
    display: block;
    flex: 1;
    min-width: 0;
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

  /* --- 確定ボタン(選択行の trailing。info と並ぶ)------------------------------------------------
   * 【2026-07-15 実機フィードバック】選択解除=確定(auto-save)には「行外タップ / Enter」という
   * 不可視の操作しか無く、可視の確定アフォーダンスが要る、との指摘への対応。info(44px タップ・
   * 装飾なし)とは役割を分け、こちらは「押せば確定する」ことが一目で分かるよう accent 塗りの
   * 28px 円形ボタンにする(タップ判定は視覚サイズと同じ 28px — info ほど押下頻度が高くない
   * 補助操作であり、行外タップ/Enter という主経路が既にあるため 44px 未満を許容する判断)。 */
  button.confirm {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 14px;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

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

  /* ===========================================================================
   * v3 詳細ページ / リスト選択ページ(カード内ページ遷移)。
   * 正 = scratchpad/todos-refined-v3.html(ユーザー承認済みモック)。
   * 【v2→v3 で覆した点(経緯・財産として残す)】v2 は詳細を position:fixed + max-height:88vh の
   * ボトムシート(.scrim / .sheet / .grabber / .sheet-body 内部スクロール)+ 浮遊ポップオーバー
   * (.menu-pop を fixed 座標で配置)+ iOS 設定画面パスティーシュ(.group 白箱 / 緑 .toggle /
   * 絵文字 .g-icon / .value-input)で作っていた。これらは本番 claude.ai の実機で次の実害を出したため
   * 全廃した(docs/log.md の実機検証):
   *   ① MCP Apps の iframe はホストがコンテンツ高さに自動リサイズするため vh が信用できず、
   *      max-height:88vh のシート本文が内部スクロールできない/下部の行(優先順位・場所)が見切れる。
   *   ② menu-pop(fixed 座標のポップオーバー)が出ない/画面外に描かれる。
   *   ③ 緑トグル・絵文字アイコン・inset 白箱は「iOS 設定画面の借景」で、会話ログ内の従属カードの
   *      トーン(v1 = todos-refined の静かなヘアライン言語)と衝突する、とのユーザー評価。
   * v3 はオーバーレイをやめ、詳細/リスト選択を #root(通常フロー)へ描く「カード内ページ遷移」にした。
   * 通常フローなので高さ=コンテンツで iframe 自動リサイズと常に整合し(①解消)、浮遊レイヤーが
   * ゼロになり(②解消)、トーンは v1 言語(ヘアライン・静かなタイポ・accent 最小・絵文字/緑トグル無し)で
   * 一貫する(③解消)。保存モデル(変更フィールドだけ update-todo・楽観適用・失敗ロールバック)は不変。
   * 変数はモックの theme-light/dark を既存のテーマ変数(--fg/--muted/--accent/--border/--bg/--bg-subtle/
   * --border-hair/--text-3)へ写像している(要素側は自前変数だけを見る方針を維持)。
   * ------------------------------------------------------------------------- */

  /* ヘッダ:「戻る(破棄)/ 保存」のテキストリンク2つ(v2 の丸ボタン ✕/✓ をやめ会話ログのトーンへ)。 */
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-hair);
  }
  .link {
    display: inline-flex;
    align-items: center;
    /* 2026-07-15: 絵文字 "‹" から lucide "chevron-left" へ置換したため、アイコンとテキストの
     * 間隔を gap で管理する(以前は絵文字直後に半角スペースを直書きしていた名残の詰め方だった)。 */
    gap: 2px;
    font: inherit;
    font-size: 13px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 4px 2px;
  }
  .link-back { color: var(--muted); }
  .link-save { color: var(--accent); font-weight: 600; }

  .detail-body { padding: 2px 0 6px; }
  /* タイトル・メモ: 枠なし入力。ヘアラインで区切るだけ(inset 箱は作らない)。 */
  .d-title {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    color: var(--fg);
    border: none;
    background: none;
    outline: none;
    padding: 12px 0 2px;
  }
  .d-notes {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    border: none;
    background: none;
    outline: none;
    resize: none;
    min-height: 30px;
    padding: 2px 0 12px;
  }
  .d-notes::placeholder, .d-title::placeholder { color: var(--text-3); }

  /* フィールド行: [ラベル][値(入力)…][操作子]。絵文字アイコンなし・フラット・ヘアライン区切り。 */
  .f-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 42px;
    padding: 4px 0;
    border-top: 1px solid var(--border-hair);
    font-size: 13.5px;
  }
  .f-label { flex: none; width: 5em; color: var(--muted); }
  .f-value { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  /* 裸のネイティブ input(値表示=入力の一本化は v2 から継承)。picker-indicator を隠して値だけ見せる。 */
  .naked {
    font: inherit;
    font-size: 13.5px;
    color: var(--accent);
    border: none;
    background: none;
    padding: 0;
    outline: none;
  }
  .naked::-webkit-calendar-picker-indicator { display: none; }
  .f-value .placeholder { color: var(--text-3); }
  /* 操作子: 小型トグル。OS 緑ではなく accent(v1 言語の唯一の彩度)で統一。 */
  .sw {
    flex: none;
    width: 34px;
    height: 20px;
    border-radius: 10px;
    background: var(--border);
    position: relative;
    border: none;
    cursor: pointer;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .sw.on { background: var(--accent); }
  .sw.on::after { left: auto; right: 2px; }
  /* 値行(繰り返し)→ タップで下にインライン展開(chevron の向きで開閉を示す)。 */
  .f-value .val { color: var(--accent); }
  /* 2026-07-15: 絵文字 "⌄/⌃"・"›" から lucide svg へ置換したので display:flex で中央揃えする
   * (font-size 指定だった名残りは 1em 基準の svg サイズ指定に読み替え)。 */
  .f-value .chev { display: flex; align-items: center; color: var(--text-3); font-size: 13px; }
  .f-value .muted { color: var(--text-3); }
  .f-row.readonly .f-value { color: var(--text-3); }
  .f-row .goto { display: flex; align-items: center; margin-left: auto; color: var(--text-3); }

  /* インライン展開部(繰り返しプリセット・曜日・終了)。浮遊させず行の下に流す(モック C)。
   * ラベル幅(5em)+ gap(10px)ぶん左インデントして「値に属する展開」であることを示す。 */
  .f-expand {
    padding: 2px 0 12px 0;
    margin-left: calc(5em + 10px);
  }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips button {
    font: inherit;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--muted);
    cursor: pointer;
  }
  .chips button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  /* カスタム(語彙外)や既存 count は disabled 破線チップ(選択状態表示だけで送信はしない第3状態)。 */
  .chips button:disabled { color: var(--text-3); border-style: dashed; cursor: default; }
  .chips + .chips { margin-top: 8px; }
  .chips .chips-label { font-size: 11px; color: var(--text-3); align-self: center; padding-right: 2px; }
  /* 曜日は丸チップ(意味の違い=単一選択でなく複数選択、を形で分ける)。 */
  .chips.wd button { width: 28px; height: 28px; padding: 0; border-radius: 50%; }
  /* 場所などのテキスト入力(展開内)。 */
  .f-expand input[type="text"] {
    width: 100%;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }

  /* リスト選択ページ(詳細からの2段目。同じくページ差し替え。モック D)。 */
  .pick-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 42px;
    padding: 4px 0;
    border-top: 1px solid var(--border-hair);
    font-size: 13.5px;
    cursor: pointer;
  }
  .pick-row:first-of-type { border-top: none; }
  /* 2026-07-15: 絵文字 "✓" から lucide "check" svg へ置換。 */
  .pick-row .check { display: flex; align-items: center; margin-left: auto; color: var(--accent); }

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
  <!-- 一覧 / 詳細ページ / リスト選択ページ本体(v3 カード内ページ遷移)。entry が sheetState に応じて
       skeleton / sections / 詳細ページ / リスト選択ページのどれかを innerHTML で書き換える。
       【v2→v3 で覆した点】v2 は詳細を #sheet-root への position:fixed ボトムシートで重ねていたが、
       MCP Apps の iframe 高さ自動リサイズと vh が噛み合わず実機で内部スクロール不能・下部見切れの
       バグが出たため全廃し、詳細も #root に通常フローで描く(entry の renderAll コメント参照)。 -->
  <div id="root"></div>
  <!-- 追加 FAB(+)。カード右下固定。タップで一覧末尾に空のドラフト行を選択状態で生やす(entry の
       startDraft)。詳細/リスト選択ページ表示中は entry が hidden にして重なりを避ける。
       【v2→v3 で覆した点】v2 は FAB タップで position:fixed の quick-add ボトムシート(#quick-add
       フォーム + 段階的開示パネル)を開いていたが、詳細シートと同じ fixed+vh の実機バグとトーン
       不一致のため全廃し、iOS 準拠の「行末に空行が生えて即入力」へ置換した(entry の draft コメント参照)。
       type="button" で暗黙 submit を防ぐ(周囲に form は無いが規律として明示)。 -->
  <!-- 2026-07-15: 絵文字 "＋" から lucide "plus" のインライン SVG へ置換(ユーザーフィードバック。
       icons.ts と同じ path データを直書き — このファイルはサーバー側の静的文字列で DOM を持たないため
       icons.ts の createIcon(DOM 生成関数)は使えず、生 SVG マークアップを直接埋め込む)。 -->
  <button id="quick-add-fab" class="fab" type="button" aria-label="リマインダーを追加"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg></button>
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
