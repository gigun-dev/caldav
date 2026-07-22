# 15. HITL 境界とカード UI の原則(2026-07-23 方向転換の正典)

> 位置づけ: human-in-the-loop(確認 UI)の責務分界、および MCP Apps カード UI の
> レイアウト原則の**設計の正**。docs/modeling/14 が定めたサーバー側確認強制(S1)は
> 本文書により凍結・撤去する。実装が図と乖離したら先にこちらを直す(CLAUDE.md)。
> 2026-07-23 に Fable architect が MCP spec / MCP Apps 仕様 / OpenAI Apps SDK の一次資料を
> 調査・裏取りした上でユーザー承認済み。

## §1 このドキュメントが生まれた経緯(Why)

docs/modeling/14 は「LLM の誤爆・早合点で delete が即実行される」問題への対策として、
サーバー側でワンタイムトークンの検証をハード強制する S1(Tier A)を設計・実装した
(2026-07-22)。しかしその後、claude.ai カスタムコネクタが per-tool 許可
(Always allow / 毎回確認(デフォルト)/ Block)を既に備えていることが判明し、
S1 のサーバー側強制はこのホスト機構と**二重に確認を課す**ことになっていた。

同時に、MCP spec を読み直すと確認 UI の提示責務は明文でホスト側(Applications)に
割り当てられており、サーバーがその責務を肩代わりする設計は仕様の役割分担と衝突する。
ここから「HITL はどこの責務か」を再整理し、サーバー側にできる・すべきことを
annotations の申告と可逆性の提供に絞り直したのが本文書の§A。

並行して、todos ⊕ フローの scrollIntoView 撤去(becc39 等の履歴)や agenda カードの
有界化(タスク #35)など、カード UI のレイアウトについても場当たり的なホスト差分吸収
(遅延 focus・自動スクロール依存)が積み重なっていた。これを一般原則として言語化した
のが§B。両者は「ホストの責務とサーバー/カードの責務を混同しない」という同じ筋の
判断であるため、1本の文書にまとめる。

## §A HITL 境界の新原則

### A-1 主語はホスト(Applications)

MCP spec 2025-06-18 の tools ページ、User Interaction Model は次のように定める:

> "there SHOULD always be a human in the loop with the ability to deny tool
> invocations... Applications SHOULD: ... Present confirmation prompts to the
> user for operations"

主語は **Applications = ホスト**。確認プロンプトの提示はホストの責務として明記されて
おり、サーバー(本プロダクトの MCP サーバー)の責務ではない。

claude.ai のカスタムコネクタは per-tool 許可(Always allow / 毎回確認(デフォルト)/
Block)を既に持つ。ユーザーが一度「毎回確認」を選んでいれば、delete 系ツール呼び出しの
たびにホストが確認 UI を出す。ここへ docs/modeling/14 の S1(サーバー側トークン強制)を
重ねると、ユーザーは「ホストの確認 → カードの確認」を二重に踏まされる。

### A-2 サーバーの責務は annotations の申告 + 可逆性の提供

ホストが確認要否を正しく判断するための材料を渡すのがサーバーの責務であり、それは
**tool annotations**(`destructiveHint` / `openWorldHint` 等)を通じて行う。

- 現状、本プロダクトの MCP ツールは annotations を**一切付与していない**。
- ToolAnnotations のデフォルトは性悪説側(`destructiveHint` は既定 `true`、
  `openWorldHint` も既定 `true`)。つまり `list-todos` のような読み取り専用ツールすら
  ホストからは「破壊的」として扱われ得る。annotations 未申告はホストの確認判断を
  実質的に阻害している。
- annotations の付与は「あれば親切」ではなく**未履行の仕様義務**として扱う。
- ただし annotations は spec 上 **untrusted hint**(信頼できないヒント)であり、
  ホストが自動的に許可を出すことを保証しない。サーバー側で「annotations を付ければ
  確認が要らなくなる」という設計はしない — あくまでホストの判断材料を正しくする、
  という範囲にとどめる。

もう一つのサーバー側の責務は**可逆性の提供**。確認 UI で誤って許可されても、操作を
取り消せるなら実害は限定される。ソフトデリート・バージョン履歴はこの実装。

### A-3 実装スライス

| スライス | 内容 |
|---|---|
| **R1** | 全 MCP ツールへの tool annotations 付与(`destructiveHint` / `openWorldHint` の正しい申告)。docs/modeling/14 の `propose-delete-*` は confirmToken 検証込みで **optional 降格**(呼ばなくても `delete-*` を直接叩ける状態に戻す)し、猶予期間後に撤去する。propose ツールは可逆性(R2)導入後は存在理由が薄い — annotations 経由でホストが確認を出せるなら、サーバー側に確認専用ツールを並べるノイズは正当化されない。 |
| **R2** | ソフトデリート。`calendar_objects.deleted_at` を追加し、`WHERE deleted_at IS NULL` の partial unique index で一意性制約を保つ。`sync_changes` への `'deleted'` 記録は既存どおり不変(iOS からの見え方は現状と同一 — sync report の挙動を変えない)。復元(`restore-*`)は sync 上 `'created'` として記録する。30日 TTL の物理掃除は別途 cron/バッチで行う。 |
| **R3** | `object_versions`(append-only)+ `revert-*` 系ツール。update の取り消しをカバーする。delete 側(R2)より優先度を落とす(§A-4 のボツ案参照)。 |
| **R4** | swift-mcp-app 側の許可ゲート実装(annotations 駆動の確認 UI)。本リポジトリの外(別リポジトリ)。 |

### A-4 ボツ案(Why not)

- **S1(docs/modeling/14 のサーバー側トークン強制)を維持する案**。却下理由: 上記の
  とおり仕様の責務分界(確認提示はホスト責務)に反する。claude.ai の確認機構と二重に
  なる。かつ swift-mcp-app 以外の将来ホストが増えるたびに「本プロダクト固有の
  propose→callServerTool プロトコル」を学習させるコストが乗る — annotations という
  MCP 標準の語彙に乗るほうが「OSS CalDAV サーバーキット」(CLAUDE.md 長期ビジョン2)の
  価値に合致する。
- **propose-* ツールを恒久維持する案**。却下理由: R2 で delete が可逆になれば
  「取り消せない操作だから確認カードを挟む」という propose の存在理由自体が消える。
  ツール一覧のノイズ(propose 版と実行版が両方並ぶ)を恒久化する理由がない。
- **R3(バージョン履歴)を R2 より先に着手する案**。却下理由: delete の不可逆性の方が
  実害が大きい(消えたイベント/todo は復元手段が今は一切ない)。update の取り消しは
  「元に戻すのが少し手間」程度の実害であり、優先度は delete 側が先。

### A-5 出典

- MCP spec, tools ページ(User Interaction Model): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- ToolAnnotations schema(`destructiveHint` / `openWorldHint` のデフォルト値含む):
  https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts

## §B カード UI 原則(限定採用 (b))

### B-1 原則

- **inline カードは有界高**: プレビュー N 件 + 「他 n件」フッタのような要約表示に留める。
  **inline カード内部でのスクロールは禁止**。深いナビゲーション(カード内で別ビューへ
  遷移する多段 UI)も禁止。
- 全件表示・詳細表示が必要なら **fullscreen へ昇格**する。fullscreen は「単一の内部
  スクロールコンテナ」のみを許容する(fullscreen 内で複数のスクロール領域を作らない)。
- **プログラム的スクロール(`scrollIntoView` 等)を UX の成立条件にしない。**
  対象へ視線を誘導したいときは「対象を安全先頭(safe top)に置いた状態で遷移する」
  ことで実現する(遷移後に JS でスクロールを追いかけさせない)。

### B-2 根拠

1. **MCP Apps 仕様(ext-apps `apps.mdx`)**: iframe のサイズ決定権はホストにある
   (`containerDimensions`: `fixed` / `flexible` / `unbounded`、
   `ui/notifications/size-changed`)。inline 展開時にホストがスクロール追従するかは
   **仕様外・ホスト実装依存**。claude.ai iOS は inline カードを自動スクロールしない一方、
   swift-mcp-app は追従が過剰、というばらつきは「仕様上正当な差」であり、サーバー/カード
   側で吸収しようとする(scrollIntoView の遅延実行等)のは対症療法にしかならない。
2. **OpenAI Apps SDK UI guidelines** に明文の指針がある:
   > "Cards should auto-fit their content and prevent internal scrolling."
   > "No deep navigation or multiple views within a card."
   fullscreen は "browsing detailed content" のための場、と役割が分けられている。
3. **fullscreen 内部スクロールはホスト差分の事故源にならない。** `containerDimensions:
   fixed` の下では iframe 内の overflow はカード側 CSS の完全管轄であり、ホストごとの
   挙動差が入り込む余地がない。inline の「ホストがどこまで自動でスクロールするか」より
   制御可能性が高い。

### B-3 安全先頭(safe top)規約

fullscreen カードの上部は、ホストのクローム(例: claude.ai iOS の liquid glass ヘッダ)
に物理的に削られる。これを吸収する優先順位は次のとおり:

1. **第一優先**: `HostContext.safeAreaInsets`(MCP Apps 仕様に存在するフィールド)を
   読み、CSS 変数 `--host-safe-top` に落として fullscreen コンテナの `padding-top` へ
   一元適用する。ただし `safeAreaInsets` が「ホストクローム分まで含めて申告する」ことは
   仕様上の mandate ではなく、claude.ai がクローム分込みで申告しているかは未実測。
2. **フォールバック**: `safeAreaInsets` が未申告のときのみ、モバイル fullscreen 限定の
   実測値によるフォールバックを使う。この実測フォールバックは**1関数に隔離**し、将来
   ホスト側の `safeAreaInsets` 申告がクローム込みで来るようになった時点でその関数だけ
   削除できる形にする。
3. CSS の `env(safe-area-inset-*)` は **iframe 内では効かない**(ブラウザの safe-area
   はトップレベルドキュメント基準)ため、依存しない。

個々のビュー/遷移コードは inset を意識しない設計にする — `padding-top` で一元的に
吸収した結果、「スクロール位置 top=0 が安全先頭」という単純な前提の上でビュー側を
書けるようにする。

### B-4 ボツ案(Why not)

- **(a) 全面採用**: fullscreen も含めて全てのスクロールを廃止する案。却下理由:
  agenda の日タイムライン(24時間分)のような本質的に縦に長いビューを再設計する
  コストが見合わない。fullscreen の単一スクロールコンテナは許容する「限定採用 (b)」
  を採る。
- **(c) 現状維持(原則を明文化しない)**。却下理由: 原則がない状態では新しいホストが
  増えるたびに `scrollIntoView` 型のワークアラウンドが個別に積み上がる。実際に
  「昇格フローのドラフト focus をズーム遷移後(450ms)へ遅延」(becec39)のような
  ホスト差分吸収コードが履歴に残っており、これは原則不在の症状そのものと見なす。
- **`env(safe-area-inset-*)` 依存**。却下理由: B-3 のとおり iframe 内で機能しない。
- **`safeAreaInsets` を読まずに一律 padding を決め打ちする案**。却下理由: 申告済み
  ホスト(将来クローム込みで正しく申告するホストが出た場合)で二重余白になる。
  `HostContext` を第一優先で読む設計にしておけば、ホスト側の実装改善にただ乗りできる。

### B-5 既存実装との対応

- `fold.ts` の `INLINE_PREVIEW_MAX = 5` + `computeInlineFit` は**既に本原則に適合**して
  いる(prior art として §B の原則を裏付ける実例)。
- `completedSummary`(総件数 + 直近5件のみ表示)も本原則の適用例。
- 違反是正として残っている作業: todos ⊕ フローの `scrollIntoView` 撤去、および agenda
  `buildDayPanel` の有界化(タスク #35)。これらは B-3 の安全先頭規約への置き換え対象。

### B-6 出典

- MCP Apps 仕様(ext-apps, `apps.mdx`): https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
- MCP Apps PR(`containerDimensions` / `HostContext` 等の議論): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865
- OpenAI Apps SDK UI guidelines: https://developers.openai.com/apps-sdk/concepts/ui-guidelines
- OpenAI Apps SDK UX principles: https://developers.openai.com/apps-sdk/concepts/ux-principles
