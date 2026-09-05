# MCP Apps カードの配色・CSS 変数監査(2026-08-02)

> **2026-09-06 更新:** A-1〜A-3/B-1〜B-3の実装を是正(未コミット・未デプロイ)。
> A-4の未使用トークンは設計意図の確認が必要なため保留。以下の監査原文は変更前の記録として残す。
> 初期/更新ホストテーマを公式helperで反映、data-themeとOS fallbackを接続。border-primary/ring-primary/
> border-hair/radiusを正規化し、補助文字と白文字用塗り色を調整した。
> 内蔵ブラウザのローカルhost harnessが実際のHTML/entry bundleを読み込み、両カードの
> light→dark、部分variables、空variables、theme/styles省略による維持、初期themeなしを確認。
> タイトル/塗りボタン比: todos light=17.27/6.29、dark=16.25/5.24、
> agenda light=17.27/6.73、dark=16.25/6.39。測定した補助日付/時刻・更新時刻・meta/dueも4.5以上。
> OSはlight。OS dark環境とWKWebView/Claude固有の全画面不具合は未検証。
> make checkはbun 1105/worker 42・型3レーン・層境界がPASS。


**すべて採点者(main セッション)が独立に再検証した実測値。** 出所は `ios-simulator` スキルの
eval(`plugins/ios-skills/skills/ios-simulator/evals/`)で、手引きの有無を変えた3本の run が
それぞれ見つけたものを突き合わせ、最後に全件を機械的に数え直した。

**Simulator は一切使っていない。** 配信される最終 HTML(`AGENDA_APP_HTML` / `TODOS_APP_HTML`)を
`bun` で実体化し、`file://` をブラウザで開いて computed style を読む方法で測っている
(WebView の中身をブラウザへ逃がす経路。詳細は共有スキルの `references/webview-offload.md`)。

---

## A. 配線が壊れている(色の値を見るだけでは出てこない)

### A-1. 🔴 ホスト注入テーマが一度も適用されていない

`swift-mcp-app` の `HostThemeBuilder.styles(for:)` は iOS の意味カラーから **6変数**を作って
`initialize` / `notifyThemeChanged` に載せて**送っている**。ところがカード側で
`setProperty` しているキーは **3本だけ**:

```
"--host-safe-top" / "--host-safe-bottom" / "--host-max-height"
```

**`--color-*` を `setProperty` するコードが存在しない**(`*-entry.ts` を検索して確認)。
結果、CSS 中の `var(--color-…, fallback)` は**全参照がフォールバックに落ちている**。

見た目が破綻していないのは、ホストが `webView.overrideUserInterfaceStyle` を設定していて
`prefers-color-scheme` が正しく解決されるため。**つまりカードの配色は iOS のシステムカラーに
追従しておらず、カード自前のパレットだけで動いている。**

### A-2. 変数名の綴り違い(A-1 を直しても境界色だけ直らない)

| | カード側の参照 | ホストが送るキー |
|---|---|---|
| 境界 | `--color-border-secondary` を **7箇所** | `--color-border-primary` |
| リング | `--color-ring-primary` を **0箇所** | `--color-ring-primary` を送っている |

**断線が二重。** A-1 を直しても、境界とフォーカスリングは黙ってフォールバックのまま。

### A-3. 未定義なのに参照されている変数(静かにフォールバックする)

| 変数 | 定義 | 参照 | 影響 |
|---|---|---|---|
| **`--hairline`** | **0** | 2(`agenda-app.ts:460` / `todos-app.ts:899` の `.card-stale-notice`) | 常に `rgba(0,0,0,0.08)`。**ダークで 1.03:1 = 事実上不可視**(ライト 1.20:1)。他の罫線は `--border` / `--border-hair` でダーク値を持つのに、ここだけ素の黒 |
| **`--border-radius-md`** | **0** | 2(`agenda-app.ts:55` の `--radius: var(--border-radius-md, 8px)`) | 常に `8px`。意図した設計トークンが効いていない |

> ⚠️ **綴り違いはエラーにならない。** `--border-hair` は 15 箇所で使われており、
> `--hairline` はその綴り違いの可能性が高い。

### A-4. 定義されているのに一度も使われない(dead token)

| 変数 | 定義 | 参照 |
|---|---|---|
| `--accent-soft` | 4(light/dark × 2カード) | **0** |
| `--dv-hour` | 1 | **0** |

`swift-mcp-app/docs/design/mocks/inline-preview.html:77` には
`box-shadow: 0 0 0 3px var(--accent-soft)` がある。**モックにある「完了チェックの余韻リング」が
実装に無い**、ということ(`todos-app.ts:117` のコメントもその演出を説明している)。

---

## B. コントラスト(WCAG 相対輝度で算出・全件再計算済み)

### B-1. 🔴 `--text-3` は**両モードで**落第

| モード | 値 | 背景 | 比 |
|---|---|---|---|
| light | `#b4b4b8` | `#ffffff` | **2.07** |
| dark | `#5c5c62` | `#1e1e20` | **2.51** |

AA(4.5)どころか非テキスト UI の最低線 3:1 も割っている。当たっている要素:
`.updated`(11px 最終更新)/ `.section .sub` / `.time .en`(11px)/
**`.meta .old` `.meta .arrow`(差分表示の「変更前の値」)** / `.chips button:disabled` /
`.f-value .placeholder .muted .chev` / 各種 `::placeholder`。

**読ませるべき旧値が 2.07 で出ている**のは実害が大きい。

### B-2. 🔴 白文字 on アクセント塗りが**ダークだけ**落第

`--accent` は暗地向けに**明るく**振ってあるのに、その上の文字は `#fff` 固定。

| カード | ライト | ダーク |
|---|---|---|
| agenda | `#fff` on `#2f6fed` = 4.55 ✅ | `#fff` on `#6f9cf5` = **2.71** ❌ |
| todos | `#fff` on `#007aff` = **4.02** ❌ | `#fff` on `#0a84ff` = **3.65** ❌ |

該当規則(agenda): `.fab` / `button.confirm` / `.cal-new-confirm` /
`.mv-cell.selected .mv-num` / `.chips button[aria-pressed="true"]` /
`.loc-chip[aria-pressed="true"]` / `.loc-chip-url-confirm`。
**`.fab` と確定ボタンという最も押される要素**が 2.71。

### B-3. 「ダークが読みにくい」は半分だけ正しい — **ライトの方が弱い項目が複数ある**

| トークン | light | dark |
|---|---|---|
| todos `--pri`(優先度 `!`) | **2.20** ❌ | 8.28 ✅ |
| agenda `--muted`(`.range` 12px 等) | **3.44** ❌ | 5.80 ✅ |
| `--add` / `--edit` | **3.39** / **3.96** ❌ | 6.80 / 7.56 ✅ |
| `--danger` | **4.38** ❌ | 5.57 ✅ |

⚠️ **同じ `--muted` が agenda 3.44 / todos 4.54 とカード間で割れている**(基準が統一されていない)。

---

## 直すときの順序(影響の大きさ順)

1. **B-2**(`.fab` 等の 2.71)— 最も押される要素で、非テキスト最低線 3:1 も割っている。
   塗り用のトークンを文字色用と分ける(例: `--accent-fill` を暗く保つ)か、上の文字を `#fff` 固定にしない。
2. **B-1**(`--text-3` 両モード落第)— 影響範囲が広く、差分の旧値という読ませたい情報に当たっている。
3. **A-3 `--hairline`**(ダーク 1.03 = 不可視)— 1行の綴り修正で直る可能性が高い。
4. **A-1 + A-2**(ホストテーマ未適用)— 見た目は壊れていないので緊急ではないが、
   **設計意図(iOS のシステムカラーに追従)が丸ごと死んでいる**。直すなら A-2 も同時に。
5. **B-3**(ライト側)/ **A-4**(dead token)— 影響は小さい。A-4 は「実装漏れか、意図的な撤去か」の判断が要る。

---

## この監査の限界(確かめていないこと)

- **`<script>` を剥がした状態で測っている**ので、`*-entry.ts` が JS で inline 設定する色
  (`calendar-colors.ts` 由来のカレンダー別ドット色など)は**未検証**。
- **Chrome で測っており WKWebView ではない。** フォントレンダリングや `backdrop-filter` 等の
  WebKit 固有差は再現していない(コントラスト比の算出には影響しない)。
- 罫線系(`--border` light 1.27 / dark 1.47、`--border-hair` 1.16 / 1.23)は**非テキストなので
  即断していない**。ヘアラインとして意図的に薄い可能性がある。
