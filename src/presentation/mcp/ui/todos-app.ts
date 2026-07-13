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
   * 要素セレクタの display 指定が hidden 属性(既定 display:none)を上書きしてしまい
   * 「中身が空でも赤い長方形が常時出る」バグが起きていた(CSS の display が HTML hidden より
   * 優先される古典的な罠)。属性セレクタ [hidden] を一枚効かせて「hidden なら常に消える」を
   * 保証する(!important は使わず、属性セレクタは要素セレクタより詳細度が高いので素直に勝つ)。 */
  [hidden] { display: none; }
  body {
    margin: 0;
    /* 320px 幅からの崩れ防止: 固定 px の横幅指定を使わず padding も clamp() で
     * コンテナ幅に自然フィットさせる。 */
    padding: clamp(8px, 3vw, 16px);
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
  li {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  li:last-child { border-bottom: none; }

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
  /* 操作中(pending): 円の上弧だけ accent にして回す = スピナー化。
   * 楽観確定はしない設計(entry 側コメント参照)なので、pending の間チェックは
   * 前の状態のまま・円だけ回るのが正しい表現(「送信したが確定していない」)。 */
  li.pending .circle {
    border-color: var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
    color: transparent;
    background: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* reduced-motion では回転を止め、代わりに点滅なしの半透明で「処理中」を示す
   * (動きの代替は透明度: WCAG の prefers-reduced-motion 対応の定石)。 */
  @media (prefers-reduced-motion: reduce) {
    li.pending .circle { animation: none; opacity: 0.4; border-top-color: var(--border); }
  }

  /* --- 行テキスト --------------------------------------------------------------
   * 1行目: タイトル。2行目: 優先度 ! 記号 + due(あるものだけ)。
   * meta を右端に寄せず title の下に置くのは、320px 幅で右カラム型にすると
   * タイトルの折り返し余地が消えて窮屈になるため(スパイク実装からの変更点)。 */
  .texts { min-width: 0; flex: 1; padding: 10px 0; }
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
   * fresh-instance 描画のたびに再生されて「また今起きた」ように誤読させるため。 */

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
  li.becoming-gone .texts { opacity: 0.45; padding: 6px 0; }

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
</style>
</head>
<body>
  <header class="bar">
    <div class="bar-left">
      <span class="app-title">リマインダー</span>
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
