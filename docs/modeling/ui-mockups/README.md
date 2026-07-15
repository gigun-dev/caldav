# UI モック(MCP Apps / todos カード)

E-2(agentic 入口 = MCP Apps の generative UI)の設計変遷スナップショット。
静的な HTML モック(単体で `open` すれば描画される)で、**設計の正**ではなく
「その時点で何を検討したか」の記録。実装の正は `src/presentation/mcp/ui/`
(`todos-app.ts` ほか)と、確定仕様は `docs/modeling/11-agentic-surfaces.md`。

> **なぜここに置くか**: これらは元々セッション固有の scratchpad(破棄されると消える)に
> 散在していた。設計変遷は `docs/modeling/` が正典なので、その配下に追跡ファイルとして
> 集約した。図と実装が乖離したら、コードより先にこちら/modeling を直す(CLAUDE.md の方針)。

## 索引(おおむね検討順)

差分(becoming)レンズ系 — 「操作でカードがどう変化したか」の可視化を詰めた系譜:

- `todos-optype.html` — 操作タイプ可視化の比較(A/B/C/D)。最初期の発散。
- `todos-diff-patterns.html` — 差分 UI デザインパターン比較(A/B/C/D)。
- `todos-diff-mockup.html` — git diff 版 操作差分 UI モック。
- `todos-diff-mockup-minimal.html` — ミニマル diff UI(ハイライトのみ)。
- `todos-diff-final.html` — 確定仕様の差分ハイライト比較(H1〜H4)。
- `todos-becoming.html` — 差分の中間状態(becoming)比較。
- `todos-becoming-b.html` — becoming POV B「充填とストロークの文法」。

カード全体系 — 一覧/詳細の UI 刷新:

- `todos-refined.html` — todo card(final refined)。v1 系の到達点。
- `todos-refined-v2.html` — **UI v2 の設計モック(canonical)**。iOS リマインダー準拠に
  再設計(一覧=走査面 / 行タップ=選択インライン編集 / ⓘ=編集ありきセミモーダル /
  左スワイプ削除)。実装は 67d4893 + c4c2e04、本番検証 PASS(next-directions.md 参照)。
