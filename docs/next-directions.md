# 次セッションの方向性(2026-09-06 棚卸し・第6版)

> **位置づけ**: 恒久ドキュメント（セッション引き継ぎの正典）。セッション開始時にまず読む。
> **更新ルール**: 計画は消さない。完了は打ち消し線 + ✅、状況変化は該当箇所の直下に
> `> **YYYY-MM-DD 更新:** ...` を積層する。詳細な計画・経緯・ボツ案は専門カタログへ分離し、
> 時系列の生記録は `docs/log.md` に追記する。
> **頭(マーカーより上)は「現在地」+「着手順」だけを80行以内に保つ**。見出し
> `## 現在地(...)` の括弧は SessionStart フックの鮮度検査のため半角にする。

## 現在地(2026-09-06)

**本番の主スライスは受け入れ完了済み**。MCPツール群、todos/agendaカード、ゴミ箱、場所検索、
CSP、nullable入力、outputSchemaまで反映・検証済みで、焦点はプロトコル適合とカード品質の残課題に移った。

- e905642 / 6394a1b / 0440b7b を本番反映済み。`make check` と CI / Workers Builds は `bun 1111 + worker 42` PASS。
- outputSchema は25/25ツールで公開され、ChatGPTの「出力スキーマ推奨」は消失。`refresh-todos`・`refresh-events`・`report-card-telemetry` は visibility=`[app]` のまま、通常カード操作と本番ログで全件成功を確認済み。
- CalDAV是正5件は実装・反映済み。本番確認はwell-known以外の4件が未確認で、RFC適合の未着手課題と合わせてカタログに保持する。
- 既知のカード実機バグ2件（fullscreen FABがcomposerに隠れる／⊕→fullscreenでキーボードが一瞬起動して閉じる）と、iOS実機・Simulatorの残項目は未解決のまま残す。
- IADレイテンシはcolo別サンプルの蓄積待ちで判定保留。hubのH0検証WorkerはOpenTofuで公開済み（31テスト、D1永続化、APNsの無効端末応答、再plan No changesを確認）。iPhoneの通常/AES通知表示は未確認で、H0全体は未完了。[hub現在地](../../hub/docs/next-directions.md)を参照。
- 正典の順序: instructions → この頭 → 該当カタログ / modeling / RFC原文 → project skill → `docs/log.md`。

## 着手順

**現在のユーザー指示はhub H0/R0の続行**。以下はcaldavへ戻る際の残作業の順序であり、hubの作業を中断する指示ではない。

1. **CalDAV本番確認の残り4件**を実施し、続けてカタログ記載の未着手RFC課題（principal REPORT、PROPPATCH、Depth、sync、object宛など）を優先度順に再評価する。
2. **カード UI と iOS実機確認**を進める。既知のfullscreen/FAB・キーボードの2件、カード内操作、agenda/月日ビュー、場所・通知・移動時間、J-4非回帰を残課題として扱う。
3. **IADレイテンシを再計測**し、coloタグ付きサンプルで次段最適化の要否を決める。
4. **MCP 2026-07-28移行**は互換性調査を踏まえ、発表後の影響と新旧SDKの両対応を再評価してから着手する。
5. **A(M2マルチユーザー)**を次の大きな実装候補とし、identity / principal / App Passwordの未確定点を先に詰める。
6. **hub H0/R0**は別リポで継続する。caldav側の本番完了とは混ぜず、成立性・所有境界・検証環境を分けて記録する。

<!-- session-head-end: ここまでが SessionStart フックで自動注入される「頭」(現在地・着手順)。
     以降は専門カタログへの索引。計画は各カタログと git 履歴に保持する。 -->

## 詳細カタログ

- [agentic / カード UI](next-directions-agentic-ui.md): E、カードの確定原則、HITL、D4、場所モデル。
- [CalDAV / iOS](next-directions-caldav-ios.md): RFC適合の是正・未着手課題、AppleクライアントとSimulatorの検証。
- [観測 / MCP / 運用](next-directions-operations.md): レイテンシ、MCP仕様移行、swift-mcp-app移管、反映運用。
- [前提 / ロードマップ](next-directions-roadmap.md): 完了前提、A〜K、別リポ、レビュー残、細かな残タスク、長期順序。

各カタログの節に状況変化を積層し、作業の区切りではこの索引と `docs/log.md` の追記だけを更新する。
