# 14. 書き込み前 human-in-the-loop「確認カード」設計

> **2026-07-23 方向転換:** 本文書が定めるサーバー側確認強制(§4 Tier A の「サーバー側で
> トークン検証をハード強制」= S1)は方向転換により**凍結**する。S1 実装(`confirm-token.ts` /
> `propose-delete-*` 3種 / delete 系 UC 手前のトークン検証)は**撤去予定**。理由は
> MCP spec の User Interaction Model 上、確認 UI の提示責務はホスト(Applications)側にあり、
> サーバー側でのトークン強制はホストの確認機構(例: claude.ai の per-tool 許可)との
> **二重確認**になるため。新しい正典は **docs/modeling/15-hitl-and-card-ui-principles.md**。
> 本文書は以後書き換えず、**「なぜサーバー側確認強制を採らないことにしたか」の Why not 資料**
> として全文保存する(§5 ボツ案・§3 根拠は転換後も参照価値がある)。
>
> 位置づけ(凍結前の記述・履歴として保持): 破壊的操作(delete 系・recurrence:null 系
> update)の確認フローの**設計の正**。実装が図と乖離したら先にこちらを直す(CLAUDE.md)。
> 2026-07-22 に Fable architect が調査・設計し、main レビュー済み(承認済み・実装は S1 から
> 着手)。E-2/E-3 で確立した MCP Apps の契約・機構(content-hash 化 ui://・callServerTool・
> 共有カーネル)を最大限流用し、新規発明を最小にするのが本設計の基本姿勢(12・13 と同じ姿勢)。

## §1 このドキュメントが生まれた経緯(Why)

E-3 でイベント/todo の書き込みツールが出揃い、LLM 経由での delete/update が実運用に乗った。
delete 系は取り消しできない操作であり、agentic 基盤(CLAUDE.md 長期ビジョン1)を前提にする
以上、モデルの誤爆・早合点で即実行されてしまう経路を塞ぐ必要が出た。一方で「確認」を
どこに置くかは selection space が広い(MCP elicitation・ホスト側実装・サーバー側 pending
レコード・propose ツール)。次直下の優先順位(docs/next-directions.md 2026-07-22 更新)で
起票し、本ドキュメントで確定する。

## §2 採用方式: propose-* + `_meta` 限定の確認トークン + カード内 callServerTool 実行

**確認を要する書き込みは「propose-*(副作用なし・確認カードを返す)」→ カード内
`callServerTool` で既存の書き込みツールを実行する。サーバー側はステートレス。**

```
モデル: delete-event(id) を呼ぼうとする
   │
   ▼
propose-delete-event(id) ─ 副作用なし。DB を読んで確認カード(何を消すか)を構築
   │
   ├─ 結果.content: モデルへの短いテキスト(「確認カードを表示しました」程度)
   └─ 結果._meta: { token: HMAC署名付きワンタイムトークン, ...カード表示用データ }
        │
        ▼ ホストが _meta を iframe(ui://)へ渡す(モデルのコンテキストには入らない)
   確認カード(ui://caldav/confirm.html)がユーザーへ表示
   │
   │ ユーザーがカード内の「削除する」ボタンをタップ
   ▼
callServerTool("delete-event", { id, confirmToken: token })
   │
   ▼
delete-event UC 実行前に confirmToken を検証(HMAC 再計算 + TTL + payload hash 一致)
   → 検証成功時のみ実際に削除
```

- **素通し防止の要**: propose がペイロードの canonical JSON hash への HMAC 署名付き
  ワンタイムトークン(TTL 5分・secret は Workers secret)を**結果の `_meta` にのみ**載せる。
  `_meta` は MCP Apps ホストが iframe に渡す UI 専用チャネルであり、**モデルのコンテキストに
  入らない**(SEP-1865 の contract。カード側は `window.openai`/`callServerTool` 経由で
  `_meta` を読めるが、モデルは `content` しか読めない)。
  → **LLM はトークンを知り得ない** = 確認済み実行は必ずユーザーのタップを経由してしか
  起こせない。モデルが `delete-event` を「確認済みのふりをして」直接叩いても、正しい
  `confirmToken` を持たないので検証で弾かれる。
- **D1 スキーマ変更ゼロ**。トークンはステートレス(署名検証のみ・DB に保存しない)。
- **可逆性が高い**: propose は既存ツール契約に対して加算的(新ツールを足すだけ)。将来
  D1 pending 化や elicitation 併用へ移行しても propose-* の外側インターフェースは保てる。

## §3 根拠(一次資料)

- **MCP elicitation(2025-06-18 spec)は flat primitive schema 限定**で、リッチな削除対象
  プレビュー(diff・複数件のチェックボックス選択など)を表現できない。加えて
  **claude.ai は 2026-07 時点で未対応**(`anthropics/claude-ai-mcp#153`)。対応済みは
  Claude Code v2.1.76 のみ(`anthropics/claude-code#7108`)。当プロダクトの主戦場が
  claude.ai コネクタである以上、elicitation を主軸にはできない。
- **MCP Apps + `callServerTool` は本リポジトリで claude.ai / swift-mcp-app(iOS ネイティブ
  ホスト)両方で実運用済み**(E-2 todos カード・E-3 agenda カード)。実績のある機構に
  乗るほうがリスクが低い。
- **ステートレストークンは可逆**: 将来 D1 pending レコード化・elicitation 併用へ移行する
  際も、propose-* という外側の形は変えずに内部実装だけ差し替えられる。

## §4 破壊度3層(製品判断)

操作の破壊度で確認の強制レベルを分ける。全操作を一律に確認必須にするのは agentic 基盤の
価値(長期ビジョン1)を殺すため、层別化する。

| Tier | 対象 | 確認の強制レベル |
|---|---|---|
| **A(確認必須)** | `delete-event` / `delete-todo` / `delete-calendar`・recurrence:null 系
  update(RRULE 全除去=反復系列の展開全体が消える操作。§ の「recurrence:null で EXDATE/
  RDATE と孤児 override も掃除する」= dd56d30 系の操作) | **サーバー側でトークン検証を
  ハード強制**。`confirmToken` が無い/不正な呼び出しは UC 実行前に拒否(isError)。
  モデルが propose を経由せず直接呼んでも実行されない。 |
| **B(propose 誘導・直接も可)** | `update-event` / `update-todo` / `move-todo`。バッチ
  (`create-events` / `create-todos`)も Tier B 扱いで**部分承認**(カード内チェックボックス
  で対象を絞ってから実行)。 | propose-* ツールを用意し、ツール description で
  「まず propose を呼ぶ」よう誘導する。ただし**サーバー側の強制はしない**(直接呼び出しも
  許容 — 誤操作の被害が delete ほど大きくなく、diff プレビュー無しの直接更新にも正当な
  ユースケースがある)。diff レンズ(§7.8 の feedback ドクトリンで確立した becoming 差分の
  仕組み)をプレビューに再利用する。 |
| **C(直接のまま)** | create 単発・`complete-todo` | 確認フロー無し。create は取り消し
  (delete)が容易・`complete-todo` は再オープン可能(可逆)なため、確認コストを課さない。 |

## §5 ボツ案(Why not)

- **案2: サーバー側 pending レコード**(propose 時に D1 へ「保留中の操作」を書き、確認後に
  その pending レコードを id で実行)。却下理由: D1 migration が要る + TTL 掃除 cron が要る +
  「pending レコードと実際の対象が食い違っていないか」の冪等性検証が要る。**不可逆コストが
  最大**な割に、§2 のステートレストークン方式と得られる安全性が同等。将来 propose の再実行
  や監査ログが要件化したら再検討(§2 で外側インターフェースを揃えているので移行は可逆)。
- **案3: elicitation 単独**。却下理由は §3 のとおり(flat schema 限定・claude.ai 未対応)。
  ただし**将来の S4 フォールバック**(elicitation 対応ホスト向けの代替経路)として設計の
  片隅に温存する。
- **案4: ホスト側(swift-mcp-app)実装**(確認 UI をサーバー非依存でホストネイティブに
  作る)。却下理由: claude.ai には効かない(ホストごとに実装が要る) + 「OSS CalDAV
  サーバーキット」の価値(CLAUDE.md 長期ビジョン2 — マウント可能な Hono アプリとして
  完結する)に反する(確認ロジックがキットの外に漏れる)。
- **全書き込みを確認必須にする案**。却下理由: agentic なタスク管理基盤(CLAUDE.md 長期
  ビジョン1)の否定。todos/agenda カードで確立した「楽観更新でその場完結する」体験
  (docs/modeling/12 §7.8)と正面衝突する。

## §6 実装スライス

1. **S1**: `presentation/mcp/confirm-token.ts`(HMAC 署名/検証・canonical JSON hash・TTL）+
   汎用確認カード `ui://`(既存の content-hash 方式 — `src/presentation/mcp/ui/
   content-hash.ts` をそのまま流用)+ `propose-delete-event` / `propose-delete-todo` /
   `propose-delete-calendar` の3種 + delete 系 UC 呼び出し前のトークン検証追加。
   **`application` 層は無変更**(検証は presentation/mcp に閉じる。§8 参照)。
   > **2026-07-22 更新:** 実装・main review・`make check`完了 ✅。843 bun tests / 28 worker
   > tests green。ステートレスtokenはnonceにより発行ごとに異なるが、使用済み記録を持たないため
   > TTL内replay可能という意味で「厳密なone-time」ではない。残る完了条件は本番secret設定後の
   > Inspector/実カードE2E(propose→確認card→delete、既存todos/agenda内delete、event/calendar)。
2. **S2**: update 系(`update-event` / `update-todo` / `move-todo`)の propose ツール +
   diff プレビュー(§7.8 の becoming/差分レンズを再利用)+ ツール description による誘導。
3. **S3**: バッチ(`create-events` / `create-todos`)の propose + カード内チェックボックス
   による部分承認。
4. **S4(任意)**: elicitation 対応ホスト向けのフォールバック経路(§5 案3 の温存分)。

## §7 整合

- **§7.8 操作フィードバックドクトリン(docs/modeling/12)は確認カードの実行ボタンにも
  適用する**: 楽観 UI ではなくボタン押下後の committing 状態表示(in-flight シマー等)を
  同じ作法で実装する。確認カードだからといって独自のアニメーション語彙を新設しない。
- **CLAUDE.md の層規律**: 確認フローは `presentation/mcp` に閉じる。`application` 層は
  DAV / REST / MCP のどの入口からも中立に呼べる状態を保つ(長期ビジョン1)。トークン検証は
  UC 呼び出しの**手前**(presentation)で行い、UC 自体は「確認された書き込み」という前提を
  知らない(UC のシグネチャに `confirmToken` を持ち込まない)。
