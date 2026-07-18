// =============================================================================
// presentation/mcp/ui/agenda-app.ts — list-events-expanded 用 MCP Apps(ui://)HTML(自己完結バンドル版)
// =============================================================================
// 【位置づけ】todos-app.ts と同じ役割の agenda 版。ui:// リソースの HTML 静的骨格 + CSS を持ち、
//   動的な中身は agenda-entry.ts(→ agenda-bundle.ts)が DOM API で組み立てる。なぜ presentation/mcp/ui に
//   置くか・なぜ自己完結バンドルか・なぜ内部スクロールコンテナを作らないか・テーマ変数の方針は
//   todos-app.ts 冒頭コメントと完全に同一なので、詳細はそちらを参照(重複させない)。
//
// 【デザインの語彙(モック docs/modeling/ui-mockups/agenda-v1.html。ユーザー GO 済み)】
//   todos v3 の静かなヘアライン言語を継承し、差分だけが新しい:
//   - 行 = [時刻列(開始/終了2段・終日は「終日」)] [タイトル + meta]。アジェンダの走査は「いつ」が
//     第一キーなので時刻を先頭列(行の錨)に置く(todos の丸チェック位置に相当)。
//   - セクション = 日付見出し(今日 / 明日 / M/D(曜))。完了概念なし。becoming は 追加/日時変更/削除/同期。
//   - now バー = 進行中の1本だけ accent の左バー(色は増やさない)。
//   - 詳細ページ: 参加行(URL video)・終日トグル・開始/終了(裸 input)・繰り返し/通知/移動時間/場所/URL。
//   テーマは todos-app.ts と同じホスト注入変数 + fallback 戦略へ写像する(要素側は自前変数だけを見る)。
// =============================================================================

import { AGENDA_BUNDLE_JS } from "./agenda-bundle";
import { fnv1aHex } from "./content-hash";

/**
 * list-events-expanded の structuredContent(EventsViewModel)を受け取り、アジェンダとして描画する HTML。
 * 静的骨格(ヘッダ・バナー・ステータス行・#root・FAB・aria-live)はここ、動的な中身は agenda-entry.ts。
 */
export const AGENDA_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<!-- 【2026-07-17 実機FB: fullscreen 昇格時のリサイズでズームロックが外れる事故(todos-app.ts と
     同一の対処。理由・根拠はそちらのコメント参照 — 重複させない)】 -->
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --bg-subtle: var(--color-background-secondary, #f7f7f8);
    --fg: var(--color-text-primary, #1c1c1e);
    --muted: var(--color-text-secondary, #8a8a8e);
    --text-3: #b4b4b8;
    --border: var(--color-border-secondary, #e4e4e7);
    --border-hair: var(--color-border-secondary, #eeeef0);
    --surface: var(--color-background-secondary, rgba(128, 128, 128, 0.12));
    --accent: #2f6fed;
    --accent-soft: rgba(47, 111, 237, 0.14);
    --danger: #d64545;
    --now: #d64545;
    /* becoming 補助トーン(モック agenda-v1 の theme-light 実測値)。 */
    --add: #2f9e63;
    --add-wake: rgba(47, 158, 99, 0.07);
    --edit: #b07300;
    --del-border: #c9c9ce;
    --radius: var(--border-radius-md, 8px);
    --row-min-h: 44px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--color-background-primary, #1e1e20);
      --bg-subtle: var(--color-background-secondary, #27272a);
      --fg: var(--color-text-primary, #f2f2f4);
      --muted: var(--color-text-secondary, #98989e);
      --text-3: #5c5c62;
      --border: var(--color-border-secondary, #3a3a3e);
      --border-hair: var(--color-border-secondary, #2e2e32);
      --accent: #6f9cf5;
      --accent-soft: rgba(111, 156, 245, 0.2);
      --danger: #e57373;
      --now: #e57373;
      --add: #55b884;
      --add-wake: rgba(85, 184, 132, 0.1);
      --edit: #d9a441;
      --del-border: #55555a;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  /* 【2026-07-17 実機FB: checkbox/行タップ時にグレー矩形が一瞬出る(todos-app.ts と同じ WebKit
   * 既定 tap-highlight)】このカードも押下反応(now バー・becoming の一過性アニメ等)を自前で持つ
   * UI アプリであり、iOS ネイティブのカレンダー/リマインダーにこの灰色矩形は無いため無効化する
   * (todos-app.ts の同コメント参照。理由は完全に同一)。 */
  * { -webkit-tap-highlight-color: transparent; }
  .lucide-icon { vertical-align: -0.125em; }
  [hidden] { display: none !important; }
  body {
    padding: clamp(8px, 3vw, 16px);
    /* 【2026-07-17 P4-DM S0: 旧 padding-bottom:64px 退避を撤回(todos-app.ts:168 と同判断)】
     * この 64px は FAB が position:fixed で通常フローに場所を取らないため、最終行に被らないよう
     * body 側で下余白を確保するものだった。FAB をフロー配置(.fab-row)に変えたことで FAB 自身が
     * 通常フローの一部になり最終行の下に自然に並ぶ(重ならない)ため、専用退避は不要になった。
     * 通常の下端余白は上の padding(clamp)で足りる。 */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Hiragino Sans", sans-serif;
    font-size: 14px;
    line-height: 1.4;
    color: var(--fg);
    background: var(--bg);
  }

  /* --- ヘッダ(タイトル + 期間 + 最終更新)--- */
  .bar { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .bar-left { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .app-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
  .range { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .updated { font-size: 11px; color: var(--text-3); white-space: nowrap; }

  /* --- 診断/エラーバナー(todos と同じ)--- */
  .status { font-size: 12px; color: var(--muted); padding: 4px 0; }
  .banner {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin: 4px 0; padding: 8px 10px; font-size: 12px; color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: var(--radius); overflow-wrap: anywhere;
  }
  .banner button {
    flex-shrink: 0; min-height: 32px; padding: 2px 10px; font-size: 12px; font-family: inherit;
    color: var(--fg); background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); cursor: pointer;
  }

  /* --- 日付見出しセクション(今日 / 明日 / M/D(曜))--- */
  .section {
    padding: 7px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    color: var(--muted); border-top: 1px solid var(--border-hair); margin-top: 2px;
  }
  .section:first-of-type { border-top: none; margin-top: 0; }
  .section .sub { font-weight: 400; letter-spacing: 0; color: var(--text-3); padding-left: 6px; }

  /* --- 行 --- */
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; flex-direction: column; }
  li + li .row-main { border-top: 1px solid var(--border-hair); }
  .row-main { display: flex; align-items: center; gap: 12px; min-height: var(--row-min-h); padding: 6px 0; }
  /* 時刻列(行の錨): 開始(上・本文色)/ 終了(下・muted)。終日は1段「終日」。幅固定で縦を揃える。 */
  .time { flex: none; width: 48px; text-align: right; font-variant-numeric: tabular-nums; line-height: 1.25; }
  .time .st { font-size: 12.5px; color: var(--fg); }
  .time .en { font-size: 11px; color: var(--text-3); }
  .time .allday { font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
  /* now バー: 進行中の1本だけ accent の左バー(色は増やさない)。 */
  li.now .row-main { box-shadow: inset 2px 0 0 var(--accent); }
  .head { flex: 1; min-width: 0; }
  /* 【2026-07-16 実機FB(todos と同修正): 編集で字大が変わるのをやめる】表示 .title を編集 .title-edit
   * (iOS auto-zoom 回避で 16px)に合わせて 16px 化。行タップで 14→16px に跳ねる違和感を消す
   * (todos-app.ts の .title コメント参照。両カードで挙動を揃える)。 */
  .title { font-weight: 480; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
  .meta {
    display: flex; align-items: baseline; gap: 0 8px; min-width: 0; flex-wrap: nowrap;
    font-size: 12px; color: var(--muted); margin-top: 1px;
  }
  .meta .loc { display: inline-flex; align-items: center; gap: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .meta .recur { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
  .meta .vid { display: inline-flex; align-items: center; color: var(--muted); }
  .meta .span { white-space: nowrap; }
  /* C2(設計 05 §2): 🎥参加チップ(会議 Join)。accent 色でアクション性を出し、タップで
   * conference.url を開く(agenda-entry.ts appendJoinChip)。旧 .vid(URL の印だけ)の後継。
   * 🔗参照 URL チップ(会議に化けていない独立リンク)は muted のアイコンのみ(参照は控えめに)。 */
  .meta .join-chip { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; color: var(--accent); text-decoration: none; flex: none; }
  .meta .ref-chip { display: inline-flex; align-items: center; color: var(--muted); text-decoration: none; flex: none; }
  /* 【2026-07-18 死コード化(監査#3・todos-app.ts と同型の裁定波及)】agenda-entry.ts の renderRow は
   * もう .tag 要素(tagEl)を生成しない — becoming の視覚は行のシマー(becoming-in)・opacity pulse
   * (becoming-edit)等の非テキスト演出だけに一本化した。以下 .tag 系セレクタ(このブロック〜
   * li.becoming-*.row-main > .tag 系・opacity-pulse keyframes)は DOM に要素が無いため常に無効だが、
   * becoming の縦位置調整史(v2.1 修正C)・pulse 演出の実装史の記録として削除せず残す
   * (コメント規律: 消すのは事実として誤りのときだけ)。 */
  /* 【2026-07-16 v2.1・C(タグ縦位置)】旧実装は tag を「meta に何かあれば meta 右端(.meta .tag)・
   * meta が空なら rowMain 直下(.row-main > .tag)」で出し分けていたが、meta の有無で縦位置が
   * 揺れて見える(agenda-entry.ts の tagEl 組み立てコメント参照)。tag は常に rowMain 直下に統一し、
   * align-self:flex-start + margin-top の縦補正でタイトル1行目の高さに揃える(row-main は
   * align-items:center なので、素の flex-start だとタイトルの上端よりわずかに高い位置に来る —
   * その差分を打ち消す経験的な補正値が margin-top: 2px)。 */
  .row-main > .tag { margin-left: auto; flex: none; font-size: 10.5px; letter-spacing: 0.03em; padding-left: 8px; white-space: nowrap; color: var(--muted); align-self: flex-start; margin-top: 2px; }
  .note-mark { display: inline-flex; align-items: center; margin-left: 6px; color: var(--muted); font-size: 12px; }
  /* 【S-D スライス①: 一覧でもメモを見たい(todos-app.ts と対称・todos 側は元々 .notes 定義済みだが
   * デッドコードだった。agenda 側は定義自体が無かったので新設)】非選択行の head 直下に本文冒頭を
   * 1行 truncate 表示する。note-mark アイコン(「メモがある」目印)とは役割を分けて併存させる
   * (アイコン=走査時に速く気づく合図、本文プレビュー=内容を読む手掛かり)。 */
  .notes { margin-top: 1px; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* --- becoming ---
   * 【2026-07-16 v2(docs/modeling/12 §7.8): 一過性アニメーションの一般解禁。todos-app.ts:374 付近と
   * 同趣旨(重複を避け要旨だけ再掲。全文の Why/根拠は todos-app.ts 側 or §7.8 原文を参照)】
   * 【解禁の3条件(すべて満たすときだけ)】①操作起点(このカード上でユーザーがいま起こした
   * mutate に限る。LLM 起点・外部同期由来の becoming は対象外)②一過性(iteration-count は必ず
   * 有限=1周。寿命満了で JS 側 startCommitting のタイマーが再描画し必ず静的形へ収束・overtime
   * なし)③情報を運ぶ(手応え/in-flight 告知のどちらかを伝える動きに限る)。
   * 【禁止のまま】持続アニメ(infinite)/自発アニメ/"もう起きたこと"のアニメ化/成功トースト・
   * バナー/浮遊オーバーレイ。
   * 【agenda 固有: v2.1 で悲観パスの「待ち表示」を撤去(旧 v2 は保有・todos には元々無い)】
   * 旧実装(F-3)は §7.8 判定則②「反復イベントの start/end/recurrence 変更」を悲観パスとして
   * committing 満了後も確定まで静的「保存中…」タグ(li.pending-edit)を挟んでいたが、「要求
   * されておらず楽観語彙に統合してほしい」というユーザー FB を受け Fable 裁可で撤去した
   * (docs/modeling/12 §7.8 v2.1)。今は反復の日時/recurrence 変更中も becoming-edit と同じ見た目
   * (タグ「変更」)を出す — 待ち表示の語彙を持たないという意味で todos と揃った。値をローカルに
   * 書けない技術事実(occurrence 展開はサーバーでしか成立しない)は不変だが、それはユーザーに
   * 見せる情報ではなく実装内部の都合として editingIds(agenda-entry.ts)に閉じ込める。
   * 【delete は本スライスでも committing アニメ未実装】todos と同じ理由(楽観削除が行を即座に
   * 一覧から除去する既存設計とゴースト演出が両立しない)。agenda-entry.ts renderGhostRow 参照。
   * 【2026-07-16 v2.1: animation-delay 補正】li.becoming-in.inflight の rowMain と
   * li.becoming-edit.committing のタグには、agenda-entry.ts が startedAt から逆算した負の
   * animation-delay を inline style で当てる(再描画のたびにアニメが 0% から巻き戻らないための
   * 補正。animUntil 宣言コメント参照)。CSS 側はアニメの形だけを定義し、進捗位置の管理は
   * entry 側の責務(分業は不変)。 */
  li.becoming-in .row-main { box-shadow: inset 2px 0 0 var(--add); background: linear-gradient(to right, var(--add-wake), transparent 55%); }
  li.becoming-in .row-main > .tag { color: var(--add); }
  /* 【2026-07-16 §7.8 v2: infinite → 1 に是正(todos-app.ts F-2 と同判断)】旧実装は create-event の
   * 確定/失敗までずっとループし続けていた(10s 超級の「まだまだ続く」言語)。寿命1周に絞り、
   * agenda-entry.ts の committing 判定(isOptimisticId && committing)が寿命切れで .inflight を
   * 自然に外す(このファイル側は付いている間だけ動く CSS を書くだけ、という分業は不変)。 */
  li.becoming-in.inflight .row-main { background-size: 200% 100%; animation: wake-sweep 1.2s linear 1; }
  @keyframes wake-sweep { from { background-position: -100% 0; } to { background-position: 100% 0; } }
  @media (prefers-reduced-motion: reduce) { li.becoming-in.inflight .row-main { animation: none; background-position: 0 0; } }
  .meta .old { color: var(--text-3); }
  .meta .arrow { color: var(--text-3); padding: 0 2px; }
  .meta .new { color: var(--edit); font-weight: 560; }
  .meta .diff { display: inline-flex; align-items: baseline; }
  li.becoming-edit .row-main > .tag { color: var(--edit); }
  /* 【2026-07-16 §7.8 v2】opacity-pulse: edit の committing 中だけ becoming タグ自体を1回だけ
   * 明滅させる(手応え)。todos-app.ts の同名 keyframes と完全同一(視覚語彙の統一)。40%→100%→100%
   * (0 に落とし切らないのはタグの文字が一瞬完全に消えると「エラーで消えた」と誤読されうるため)。
   * 【v2.1】反復の日時/recurrence 変更中(editingIds 由来)の強制タグもこのクラスに乗るため、
   * 悲観/楽観の両方でこの1つの opacity-pulse だけを使う(旧 pending-edit の重複定義は不要になった)。 */
  li.becoming-edit.committing .row-main > .tag {
    animation: opacity-pulse 1.2s ease-out 1;
  }
  @keyframes opacity-pulse {
    0% { opacity: 0.4; }
    50% { opacity: 1; }
    100% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    li.becoming-edit.committing .row-main > .tag {
      animation: none;
    }
  }
  /* removed: becoming-gone(削除ゴースト)。 */
  li.becoming-gone { margin: 4px 0; }
  li.becoming-gone .row-main {
    padding: 6px 8px; border: 1px dashed var(--del-border); border-radius: var(--radius);
    background: var(--surface); opacity: 0.7;
  }
  li.becoming-gone .row-main > .tag { color: var(--muted); }

  /* --- 選択状態(iOS: 行タップでタイトルが input 化・メモ行と ⓘ 出現)--- */
  li.selected .row-main { background: var(--bg-subtle); border-radius: 10px; margin: 0 -6px; padding: 6px; }
  /* 【S-D スライス②: focus zoom 是正(todos-app.ts と対称)】iOS Safari/WKWebView は 16px 未満の
   * フォーカス可能入力でオートズームする。.title-edit/.memo-line を 16px 化し、行高が広がらない
   * よう line-height を詰める(選択行だけ文字がわずかに大きく見えるのは親裁定で許容 §7.7)。
   * 【S-D スライス④: padding 統一(2026-07-17 撤回・下記参照)】旧コメント「todos-app.ts と揃えて
   * 0 0 1px に統一済み」は 2026-07-17 実機 FB(選択で title/memo の箱寸法が動く)で todos 側が
   * padding 0(.title に padding 無し)へ変更されたため、この agenda 側 1px も事実として旧判断に
   * なった。ただし agenda はこの FB の対象範囲外(親からの指示は todos-app.ts 限定)のため、
   * ここでは padding は変更せず「todos と揃っていない状態に戻った」ことだけを記録する
   * (agenda 側で同種の 1px 縦ズレが起きていないか要実機確認・親への報告事項)。 */
  .title-edit { display: block; width: 100%; font: inherit; font-size: 16px; font-weight: 480; color: var(--fg); border: none; background: none; outline: none; padding: 0 0 1px; }
  .memo-line { display: block; width: 100%; font: inherit; font-size: 16px; line-height: 1.2; color: var(--text-3); border: none; background: none; outline: none; margin-top: 2px; padding: 0; }
  .title-edit::placeholder, .memo-line::placeholder { color: var(--text-3); }
  button.info {
    flex: none; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    padding: 0; font-size: 16px; color: var(--accent); background: none; border: none; border-radius: 50%; cursor: pointer;
  }
  button.confirm {
    flex: none; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    padding: 0; font-size: 14px; color: #fff; background: var(--accent); border: none; border-radius: 50%; cursor: pointer;
  }

  /* --- スワイプ削除(iOS 準拠)--- */
  li.swiping { position: relative; overflow: hidden; }
  li.swiping .row-main { transform: translateX(-76px); position: relative; z-index: 1; background: var(--bg); }
  .swipe-del { position: absolute; top: 0; right: 0; bottom: 0; width: 76px; border: none; background: var(--danger); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }

  /* --- inline 畳み(P4-DM C2/C3。todos-app.ts の同名クラスを移植・語彙も同一)---
   * 【なぜ agenda にも要るか】agenda は occurrence 行が日付をまたいで増えるため、inline maxHeight
   * を宣言するホスト(claude.ai 等)では todos と同じく「畳んで下端の FAB がクリップされない」保証が
   * 要る。fold.ts(共有カーネル)の computeInlineFit + agenda-entry.ts の applyInlineFold が担い、
   * ここは受動表示(.fold-remaining)/昇格ボタン(.fold-expand)の見た目だけを定義する。 */
  /* C2: inline maxHeight 超過時の「残り n 件」受動表示(タップ不可・情報行)。.empty と同トーンで
   * 「操作行ではない」ことを視覚でも示す。margin-bottom は下 padding 確保 + measureButtonBlockPx が
   * .fold-expand を測って budget に反映する(CSS 定数の二重管理を避ける・todos-app.ts と同方針)。 */
  .fold-remaining { color: var(--muted); padding: 8px 0 0; font-size: 12px; margin-bottom: 12px; }
  /* C3: fullscreen 広告ホストで「残り n 件」の代わりに出す昇格ボタン。押せると分かるよう
   * .fold-remaining の受動 muted とは区別し accent 色のテキストリンク言語に合わせる。タップ領域
   * 最低 32px。margin-bottom:12px は measureButtonBlockPx が実測して budget 先引きに使う。 */
  .fold-expand {
    display: block;
    width: 100%;
    margin: 8px 0 12px;
    padding: 6px 0;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: none;
    text-align: left;
    min-height: 32px;
    cursor: pointer;
  }
  /* C0-b(2026-07-17 inline プレビュー化): フッタ要約行「他 n 件の予定 — 全画面で表示」。
   * 旧「すべて表示」ボタン(.fold-expand)+ 受動「残り n 件」(.fold-remaining)を置換(右上 ⤢ と
   * 役割重複のため廃止・上の2クラスは退行時再利用に残置=死んでも害は無い経緯記録)。モック
   * inline-preview.html の .more 相当(控えめ muted・件数だけ accent)。todos-app.ts と同定義。 */
  .fold-more {
    display: block;
    width: 100%;
    margin: 8px 0 12px;
    padding: 6px 2px 2px;
    font: inherit;
    font-size: 13px;
    color: var(--muted);
    background: none;
    border: none;
    text-align: left;
    cursor: default;
  }
  /* > 2026-07-17 実機 FB1: CTA「— 全画面で表示」を消したので button 版はテキスト全体を accent(リンク色)に
   * してタップ可能を色で示す(todos-app.ts と同判断)。div 版(受動)は上の .fold-more の muted のまま。 */
  button.fold-more { cursor: pointer; min-height: 32px; color: var(--accent); }
  .fold-more-count { color: var(--accent); }
  /* C3: fullscreen 昇格中だけ #root を内部スクロールコンテナにする(設計04 決定2 — sheet は
   * コンテナが1枚だけなので二重スクロール問題が起きない)。--host-max-height は C1(applyHostContext)が
   * containerDimensions.maxHeight から設定する CSS 変数。inline に戻ると applyHostContext がこの
   * クラスを外し通常フロー(内部スクロール無し)へ復帰する。todos-app.ts の同定義と同値。 */
  #root.fullscreen-scroll {
    overflow-y: auto;
    max-height: var(--host-max-height, 100vh);
  }

  /* --- 空/スケルトン --- */
  .empty { color: var(--muted); padding: 12px 0; }
  .skel { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
  .skel-circle { width: 22px; height: 22px; border-radius: 50%; background: var(--surface); margin: 0 11px; }
  .skel-line { height: 12px; border-radius: 6px; background: var(--surface); }
  .skel, .skel * { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .skel, .skel * { animation: none; } }

  /* --- 追加 FAB(+)。#root の直後・通常フローの右寄せに置く円 ---
   * タップで一覧末尾に空のドラフト行を選択状態で生やす(entry の startDraft)。詳細ページ表示中は
   * entry が hidden にして重なりを避ける。
   * 【2026-07-17 P4-DM S0: position:fixed を撤廃し通常フロー右寄せへ(todos-app.ts の同修正を移植)】
   * 旧実装は todos が fixed→フロー化する前の姿をそのまま引き写したもので、position:fixed だった。
   * しかし todos-app.ts:730 が記録するとおり、MCP Apps の auto-height iframe(ホストがコンテンツ
   * 高さに追従リサイズ)では「viewport 底辺 = コンテンツ底辺」になるため fixed は「固定でない固定」
   * になり、行挿入のたびに FAB が一瞬下へずれて戻るシフト源になる。加えて P4-DM の畳み(inline
   * fold)を移植すると、fixed FAB は #root の畳みで生じる高さ変化と無関係に画面下へ張り付くため、
   * measureFabBlockPx が測る「行の下に必ず並ぶ FAB の高さ」という前提(fold の budget 先引き)が
   * 崩れる。todos が同じ理由でフロー化した経緯に倣い、agenda も .fab-row(#root 直後・body 直下の
   * 通常フロー要素)の中に flex + justify-content:flex-end で右寄せする。フロー配置だと行挿入で
   * FAB がその場から1回だけ自然に押し下げられる「流れ」になり、「戻る」動き(fixed の副作用)が消える。 */
  .fab-row {
    display: flex;
    justify-content: flex-end;
    /* 旧 fixed FAB のための body padding-bottom 退避を廃止した(body のコメント参照)ので、
     * FAB とその上の #root の間隔をここで確保する(todos-app.ts の .fab-row と同値)。 */
    margin-top: 8px;
  }
  .fab {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    font-family: inherit; font-size: 18px; line-height: 1; color: #fff; background: var(--accent);
    border: none; border-radius: 50%; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28); cursor: pointer;
  }
  /* 【2026-07-17 追更新: fullscreen だけ FAB を画面右下に固定(todos-app.ts の同修正を移植)】
   * FB「fullscreen で項目が少ないと + が上に詰まる。fullscreen なら + は画面右下でよい」への対応。
   * inline を fixed→フロー化した理由(上の .fab-row コメント)は、auto-height iframe では fixed が
   * 実質固定にならず、行挿入/畳み(inline fold)で #root の高さが変わるたびに FAB が一瞬ずれて戻る
   * ことだった。measureFabBlockPx が「行の下に必ず並ぶ FAB の高さ」を budget の先引きに使う前提
   * (下の measureFabBlockPx コメント参照)も、FAB が通常フローに実在することに依存している。
   * fullscreen ではこの前提がどちらも成立しない: #root.fullscreen-scroll は
   * max-height: var(--host-max-height) の【固定高】の内部スクロールコンテナであり、
   * applyInlineFold は hostDisplayMode !== "inline" で早期 return するため【fold 自体が
   * 起きない】(#root の高さが動かない)。かつ fullscreen は sheet/fullScreenCover 1枚だけの
   * コンテナなので viewport 底辺 = 実際の画面底辺と一致し、fixed が「本当に固定」として機能する。
   * ゆえに fixed の副作用の発生源が構造的に無く、fullscreen 限定で fixed 右下固定に戻して安全
   * (inline のフロー化判断そのものを覆すものではない — 適用範囲を分けるだけ)。
   * "#root.fullscreen-scroll ~ .fab-row" の一般兄弟結合子は、.fab-row が #root の【直後の兄弟】
   * (body 直下、entry.ts 側コメント参照)であることに依存する — DOM 構造を変えたらこのセレクタも
   * 見直すこと。z-index は内部スクロール中のコンテンツより前面に出すだけの用途なので大きい値は
   * 不要(1で足りる)。right/bottom は 16px(iOS の標準的な余白トークンに合わせた経験値。
   * bottom には env(safe-area-inset-bottom) を加算し、fullScreenCover が safe area の外まで
   * 描画されうることに備える(todos-app.ts と同値)。 */
  #root.fullscreen-scroll ~ .fab-row {
    position: fixed;
    right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    margin: 0;
    justify-content: flex-end;
    z-index: 1;
  }
  /* 内部スクロールの最終行が fixed FAB の下に隠れないよう、スクロールコンテナの下端に FAB 分の
   * 余白を予約する(40px の FAB 一辺 + 16px の bottom + 8px の余裕を切り上げ。todos-app.ts と同値
   * — 不足すると FAB が最終行に重なりタップミスを誘発するので安全側に倒す)。 */
  #root.fullscreen-scroll {
    padding-bottom: 72px;
  }

  /* --- 詳細ページ(モック C。todos v3 と同一部品)--- */
  .page-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-hair); }
  .link { display: inline-flex; align-items: center; gap: 2px; font: inherit; font-size: 13px; border: none; background: none; cursor: pointer; padding: 4px 2px; }
  .link-back { color: var(--muted); }
  .link-save { color: var(--accent); font-weight: 600; }
  .detail-body { padding: 2px 0 6px; }
  .d-title { display: block; width: 100%; font: inherit; font-size: 16px; font-weight: 600; color: var(--fg); border: none; background: none; outline: none; padding: 12px 0 2px; }
  /* S-D スライス②: iOS auto-zoom 回避のため 16px 化(todos-app.ts の .d-notes と対称)。 */
  .d-notes { display: block; width: 100%; font: inherit; font-size: 16px; line-height: 1.3; color: var(--fg); border: none; background: none; outline: none; resize: none; min-height: 30px; padding: 2px 0 12px; }
  .d-notes::placeholder, .d-title::placeholder { color: var(--text-3); }
  /* 参加行(URL video)。開けないホストに備えテキスト選択可能に degrade(user-select:text)。 */
  .join-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--accent); }
  .join-link { color: var(--accent); font-size: 13px; text-decoration: none; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
  .f-row { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 4px 0; border-top: 1px solid var(--border-hair); font-size: 13.5px; }
  .f-label { flex: none; width: 5em; color: var(--muted); }
  .f-value { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* S-D スライス②: date/time input(.naked)・URL 入力(.url-input)も iOS auto-zoom 回避で 16px 化
   * (todos-app.ts の .naked と対称)。.f-value .val/.chev は表示専用テキストなので据え置き。 */
  .naked { font: inherit; font-size: 16px; color: var(--accent); border: none; background: none; padding: 0; outline: none; }
  .naked::-webkit-calendar-picker-indicator { display: none; }
  .f-value .placeholder { color: var(--text-3); }
  .f-value .val { color: var(--accent); }
  .f-value .muted { color: var(--text-3); }
  .f-value .chev { display: flex; align-items: center; color: var(--text-3); font-size: 13px; }
  .url-input { width: 100%; font: inherit; font-size: 16px; color: var(--fg); background: none; border: none; outline: none; padding: 0; }
  .url-input::placeholder { color: var(--text-3); }
  .f-expand { padding: 2px 0 12px 0; margin-left: calc(5em + 10px); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer; }
  .chips button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chips button:disabled { color: var(--text-3); border-style: dashed; cursor: default; }
  .chips + .chips { margin-top: 8px; }
  .chips .chips-label { font-size: 11px; color: var(--text-3); align-self: center; padding-right: 2px; }
  .chips.wd button { width: 28px; height: 28px; padding: 0; border-radius: 50%; }
  /* S-D スライス②: 展開内テキスト入力も 16px 化(todos-app.ts と対称)。 */
  .f-expand input[type="text"] { width: 100%; font: inherit; font-size: 16px; color: var(--fg); background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
  .sw { flex: none; width: 34px; height: 20px; border-radius: 10px; background: var(--border); position: relative; border: none; cursor: pointer; }
  .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); }
  .sw.on { background: var(--accent); }
  .sw.on::after { left: auto; right: 2px; }

  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* --- C3(設計05 §4): 作成フォームのセグメント(予定|リマインダー・片方向)---
   * モック create-event-with-semimodal.html の .segment を移植(iOS の segmented control 風)。 */
  .segment { display: flex; margin: 4px 0 0; background: var(--surface); border-radius: var(--radius); padding: 2px; }
  .segment button { flex: 1; border: none; background: none; color: var(--fg); font: inherit; font-size: 14px; padding: 7px 0; border-radius: 6px; cursor: pointer; }
  .segment button[aria-selected="true"] { background: var(--bg); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }

  /* --- C4(設計05 §5): 「場所または会議」統合トリガ行 --- */
  .location-trigger { cursor: pointer; }
  .location-trigger .lt-icon { display: inline-flex; align-items: center; color: var(--muted); }
  .location-trigger .lt-clear { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; background: none; color: var(--muted); cursor: pointer; padding: 0; }

  /* --- C4: 場所/会議セミモーダル(カード内 CSS オーバーレイ。WKWebView 内の純粋な DOM/CSS で、
   * サンドボックスの全通信遮断とは無関係 — 設計05 §5 冒頭コメント参照)。position:fixed で
   * 画面(= #root の実効ビューポート)を覆う。todos/agenda 共通の CSS トークン(--bg/--surface/
   * --border/--accent 等)をそのまま使う。 */
  .loc-dimmer {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.32);
    z-index: 20;
  }
  .loc-semimodal {
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 78vh;
    background: var(--bg); color: var(--fg);
    border-radius: 16px 16px 0 0; box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.25);
    display: flex; flex-direction: column;
    z-index: 21;
  }
  .loc-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--border); margin: 8px auto 4px; flex: none; }
  .loc-sm-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 16px 8px; flex: none; }
  .loc-sm-title { font-size: 15px; font-weight: 600; color: var(--muted); }
  .loc-sm-done { border: none; background: none; color: var(--accent); font: inherit; font-size: 15px; font-weight: 600; padding: 0; cursor: pointer; }
  .loc-sm-body { flex: 1; overflow-y: auto; padding: 0 16px 20px; }
  .loc-sm-search {
    display: flex; align-items: center; gap: 8px; background: var(--surface);
    border-radius: var(--radius); padding: 9px 12px; margin: 4px 0 16px;
  }
  .loc-sm-search input { flex: 1; border: none; background: none; color: var(--fg); font: inherit; font-size: 15px; outline: none; }
  .loc-sm-section { margin-bottom: 18px; }
  .loc-sm-section-title { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
  .loc-sm-empty { font-size: 13px; color: var(--muted); padding: 8px 2px; }
  .loc-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .loc-chip {
    border: 1px solid var(--border); background: var(--surface); color: var(--fg);
    font: inherit; font-size: 14px; padding: 7px 14px; border-radius: 999px; cursor: pointer;
  }
  .loc-chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .loc-chip-url-row { margin-top: 10px; display: flex; align-items: center; gap: 8px; background: var(--surface); border-radius: var(--radius); padding: 9px 12px; }
  .loc-chip-url-row input { flex: 1; border: none; background: none; color: var(--fg); font: inherit; font-size: 14px; outline: none; }
  .loc-chip-url-confirm { flex: none; border: none; background: var(--accent); color: #fff; font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
  .loc-place-list { background: var(--surface); border-radius: var(--radius); overflow: hidden; }
  .loc-place-item {
    display: flex; align-items: flex-start; gap: 10px; padding: 11px 12px; width: 100%;
    border: none; background: none; text-align: left; color: var(--fg); font: inherit; font-size: 14px; cursor: pointer;
  }
  .loc-place-item + .loc-place-item { border-top: 1px solid var(--border); }
  .loc-place-item .lucide-icon { color: var(--muted); flex: none; margin-top: 2px; }
  .loc-pi-text { flex: 1; }
  .loc-pi-title { font-size: 14.5px; }
  .loc-pi-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
</style>
</head>
<body>
  <header class="bar">
    <div class="bar-left">
      <!-- 対象カレンダー名。entry が vm.calendarId を書き込む。データ到着前は「カレンダー」。 -->
      <span id="app-title" class="app-title">カレンダー</span>
      <!-- 期間(M/D〜M/D)。entry が vm.range を書き込む。 -->
      <span id="range" class="range"></span>
    </div>
    <!-- 最終更新 HH:mm。 -->
    <span id="updated" class="updated"></span>
  </header>
  <div id="banner" class="banner" hidden></div>
  <div id="status" class="status" hidden></div>
  <!-- 一覧 / 詳細ページ本体(カード内ページ遷移)。entry が sheetState に応じて書き換える。 -->
  <div id="root"></div>
  <!-- 追加 FAB(+)。#root の直後・通常フローの右寄せ(2026-07-17 P4-DM S0: position:fixed 撤廃)。
       タップで一覧末尾に空のドラフト行を選択状態で生やす(entry の startDraft)。詳細ページ表示中は
       entry が hidden にして重なりを避ける。lucide plus の生 SVG(サーバー側静的文字列なので createIcon は使えない)。
       【2026-07-17 P4-DM S0: DOM 位置は #root の外(body 直下)のまま・.fab-row でラップ】
       renderAll は #root の中身だけを innerHTML で作り直すので、#root の外に置いたこの FAB(と .fab-row)は
       再描画の影響を受けない(entry.ts 側は id #quick-add-fab を hidden 切替 + closest(".fab-row") で
       参照するだけで、DOM 位置の変更に伴う JS 側の改修は不要 — todos-app.ts:1245 と同じ)。 -->
  <div class="fab-row">
    <button id="quick-add-fab" class="fab" type="button" aria-label="予定を追加"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg></button>
  </div>
  <!-- 操作結果の読み上げ専用(視覚非表示)。 -->
  <div id="live" class="sr-only" role="status"></div>

<script type="module">
${AGENDA_BUNDLE_JS}
</script>
</body>
</html>
`;

/** list-events-expanded ツールが描画する MCP Apps リソースの URI。
 *  【2026-07-17 キャッシュバスティング S1】todos-app.ts の TODOS_UI_URI と同じ理由・同じ方式で、
 *  AGENDA_APP_HTML(配信される最終 HTML 全体)から算出した hash を URI に埋め込む
 *  content-address 化。定義順(HTML → hash → URI)・旧静的 URI のエイリアス方針も同一なので
 *  詳細は todos-app.ts の TODOS_UI_URI コメントを参照(重複させない)。
 *  server.ts の _meta.ui.resourceUri と registerAppResource(uri) の両方に同じ文字列を使う。 */
export const AGENDA_UI_URI = `ui://caldav/agenda.${fnv1aHex(AGENDA_APP_HTML)}.html`;
