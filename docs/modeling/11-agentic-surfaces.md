# 11. agentic 入口の露出面調査(MCP Apps / WebMCP)+ 着手順の戦略設計

> **位置づけ**: 方向性 E(agentic 入口)の一次資料。2026-07-11 の Web 調査
> (MCP Apps / WebMCP の標準化状況)と、同日に行った着手順の DDD 戦略設計の記録。
> next-directions.md の着手順・E の節はここを根拠とする。

## 1. 着手順の戦略設計(DDD コアドメイン蒸留)

松岡 DDD の戦略的設計(コアドメイン蒸留・サブドメイン分類)で方向性 A〜K を分類した。
長期ビジョン(agentic タスク管理 + OSS キット)に照らした分類:

| 分類 | 方向性 | 理由 |
|---|---|---|
| **コアドメイン**(差別化の源泉) | G(意味計算)、J(採択途中 RFC)、E(agentic 入口) | 「イベントの理解・free-busy・タスクグラフ状態モデル」は競合実装がほぼ皆無。蒸留すべき本丸 |
| **支援サブドメイン** | B(スケジューリング)、K(メール統合)、C(他クライアント)、H/I(集約・連絡先) | コアを活かすために必要だが、それ自体は差別化しない |
| **汎用サブドメイン** | A(認証・マルチユーザー)、F(運用)、K-2(メール送信ポート) | 業界デファクトをなぞれば良い領域。独自性を出す場所ではない |

原則「コアドメインに最初に投資し、汎用はデファクトをなぞって薄く済ませる」から、
従来の A 先頭を改め **G → J → A → E → K → B → …** に改訂(確定順序は next-directions.md 参照)。

個別の判断根拠:

- **G 先頭**: RFC 4791 MUST 違反(time-range の RRULE 展開)の解消 = コア価値に直結。
  A に依存せず単一ユーザーで完結し、ドッグフーディング可能。G-5 が E の最小実証になる。
- **J を G 直後**: G でドメイン層(`@caldav/ical`)が熱いうちに VJOURNAL + ical-tasks の
  語彙を織り込む。同一の境界づけられたコンテキスト内でコンテキストスイッチ最小。
  ical-tasks draft が数ヶ月で RFC 化する時間的制約も支持。
- **E を B より先**(ユーザー判断で確定): E はコアドメイン、B は支援サブドメイン。
  G-5 で MCP の先鋒が立つため E の増分は小さい。B は A に加えて K-1/K-2 も前提に持ち
  依存の鎖が長い。
- **C の tsdav CI ハーネスだけ G-3 完了時点に前倒し**: calendar-query が入り次第
  回帰検知に使える。汎用テスト基盤は早いほど利く。
- **H は E に吸収**: (c) agent 側横断案(09 §3 で裏付け済み)は E の設計の一部になる。
- **F は横断関心事**: フェーズではなく、各マイルストーンの DoD に該当分を含める。

## 2. MCP Apps(ext-apps / SEP-1865)

MCP サーバーがツール応答として**対話的 UI(sandboxed iframe の HTML)を
チャットクライアント内に描画させる**公式拡張。

- **状況(2026-07 時点)**: 2026-01-26 に安定版仕様。**最初の公式 MCP 拡張**で、
  MCP-UI と OpenAI Apps SDK の統合形。SEP-1865 は Final。
  Claude / ChatGPT / VS Code / Goose がホスト対応済み。
  2026-07-28 の MCP 本体大型改訂(RC 公開中)にも拡張として同梱予定。
- **技術要点**: `ui://` URI スキームで UI リソースを宣言しツールにメタデータで関連付け。
  コンテンツは `text/html;profile=mcp-app`、必ず sandboxed iframe で描画、
  通信は postMessage 経由の MCP JSON-RPC(監査可能)。
- **本作との相性**: free-busy の空き時間ピッカー / K-4 提案 inbox の承認 UI / 週ビュー。
  カレンダーという GUI ありきのドメインと generative UI は好相性。
- **アクション**: E 設計前に一次資料(ext-apps spec)を読む。
- 参照: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/ /
  https://github.com/modelcontextprotocol/ext-apps/

## 3. WebMCP(navigator.modelContext)

**Web ページ側がブラウザ内エージェントにツールを公開する** API(MCP Apps とは方向が逆)。

- **状況(2026-07 時点)**: W3C Community Group Draft(2026-04-23 版、
  Microsoft + Google が編集)。**標準化トラック未満**の incubation 段階。
  Chrome 149 でオリジントライアル中(主な消費者は Gemini in Chrome)。
  Edge は未確定、Firefox/Safari はコミットなし。API はまだ動く
  (`window.agent` 廃止、`provideContext()` 削除など破壊的変更が現に起きている)。
  2026-05 時点で Claude / ChatGPT 等の主要エージェントは navigator.modelContext 未対応。
- **評価の経緯**: 当初「ウォッチのみ」と評価したが、ユーザー判断
  「**CalDAV は GUI ありきのプロダクトで、iOS クライアントだけでなく WebUI を独立に持つ**」
  により上方修正。WebUI を持つ前提なら:
  - **配布問題の解消**: MCP サーバーはクライアント側の接続設定が必要だが、WebMCP なら
    ブラウザ常駐エージェントが「ページを開いただけ」でツールを発見。到達範囲が違う。
  - **認証の相乗り**: ページの JS として動くので WebUI のログインセッションをそのまま使える。
  - **リスク限定**: 投資の大半は「WebUI + application 層の語彙」に落ち、WebMCP 固有部分は
    `registerTool()` の薄い皮だけ。仕様が動いても被害は表皮に限定される。
- **アクション**: WebUI が立った時点で Chrome オリジントライアルで実験
  (方向性 J と同じ「採択途中標準への先行投資」の思想)。
- 参照: https://developer.chrome.com/docs/ai/webmcp /
  https://patrickbrosset.com/articles/2026-02-23-webmcp-updates-clarifications-and-next-steps/

## 4. 構造上の結論: 三面露出

**MCP サーバー / MCP Apps / WebMCP は排他ではなく、同じ application 層ユースケースの別露出面。**

get-freebusy / create-event といったツールの「語彙」(名前・引数・応答形)を
application 層で一度設計すれば:

1. **MCP サーバー**(G-5 → E)— Claude 等の汎用エージェントから
2. **MCP Apps** — チャット内 generative UI から
3. **WebMCP** — WebUI を開いたブラウザエージェント(Gemini in Chrome 等)から

の三面に露出できる。長期ビジョン1「application 層のユースケースを複数入口から呼ぶ」の
入口が増えるだけで、ドメイン・application 層への影響はゼロ(presentation 層の表現)。
**G-5 で設計するツールインターフェースがこの語彙の原型になる**ため、G-5 の時点で
特定の入口に依存しない形を意識する(next-directions の G-5 に注記済み)。

WebUI 自体の設計論点(tsdav 直 CalDAV か REST アダプタ経由か。直なら Worker に
CORS + DAV メソッドの preflight 対応が必要)は E 着手時に判断する。
