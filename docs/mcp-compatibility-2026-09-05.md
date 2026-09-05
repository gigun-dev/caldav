# MCP 互換性確認(2026-09-05)

## 判定

Inspector 2.5.0は現行サーバーへのOAuth接続・タスクカード描画・カード内再取得まで実測PASS。サーバーの新仕様移行は旧仕様との両対応を維持する。
Swift SDK と MCP Apps の依存条件から、一括更新だけで移行完了とは判断できない。
公開パッケージ・公式ソースと固定依存の照合に加え、現行本番に対するInspectorの限定E2Eを実施。新仕様移行後の合格とは区別する。

| 対象 | 手元 | 公開最新版 | 判定 |
| --- | --- | --- | --- |
| Inspector | プロジェクト依存には固定なし | 2.5.0 (9/2公開) | TS SDK v2採用。Web/CLI/TUIとAppsレビュー導線あり |
| caldav TS SDK | sdk 1.29.0 | server 2.0.0 | パッケージ/API移行が必要 |
| Hono MCP | @hono/mcp 0.3.1 | @modelcontextprotocol/hono 2.0.0 | 別パッケージ。単純な版更新ではない |
| MCP Apps | ext-apps 1.7.4 | 1.7.5 | 最新もpeerDependenciesはsdk ^1.29.0。server helperのv2型互換は未検証 |
| swift-mcp-app | swift-sdk 0.12.1 | 0.12.1 | 対応プロトコルの最新は2025-11-25。2026専用サーバーには移行しない |

## Inspectorを使った実装中の確認

- JSONで検証できる項目はCLI: tools/list、tools/call、resources/read。
- `--app-info`でUI URI/CSP/permissionsを確認。公式ガイドではtools/listにも指定でき、toolを実行せず調査できる。
- Webで一度OAuthを完了し、CLIでは`--use-stored-auth`で正規に再利用する。
- WebのAppsで実描画とカード内tools/callを確認。自動接続・カード選択のdeep linkと安定したdata-testidが用意されている。
- iOS固有のテーマ・キーボード・全画面・タッチはswift-mcp-appを指定Simulatorへinstallして確認する。
- Claude iOSで報告された全画面の2不具合はClaudeホストでも再検証する。
- 保存変更は再取得、意味論が関係する場合は検証データのD1生ICSまで確認する。

## 移行時の確認項目

実行確認: Node 24.19.0でInspector 2.5.0のCLI起動と上記オプションの存在を確認。
本番`/mcp`へ`--stored-auth-only --method tools/list --app-info`で読み取り接続を試したが、
`auth_required`(exit 3、Missing or invalid access token)で停止した。
有効な保存済みOAuth認証による接続を確立できていないため、ツール一覧・Apps描画・カード操作は未検証。
新しいOAuth認証後に再開する。プロジェクト依存と本番構成は変更していない。

1. SDK v2の`createMcpHandler`で新旧両対応を試す。公式ガイドでは既定で2025側も扱う。
2. 現在多数利用している`registerAppTool`/`registerAppResource`とv2 McpServerの型・実行互換を隔離環境で確認する。
3. 新旧それぞれでtools/list → resources/read → tools/call → Apps描画 → カード内操作を確認する。
4. Swift 0.12.1経路では旧仕様が維持されることを確認する。
5. OAuth provider、Apps capability宣言、エラー応答も検証する。SDK更新のみでは新仕様は有効にならない。

## 根拠

- npm registryのdist-tags、dependencies、peerDependencies、公開日時を直接取得(9/5)。
  [Inspector](https://registry.npmjs.org/@modelcontextprotocol/inspector)、[ext-apps](https://registry.npmjs.org/@modelcontextprotocol/ext-apps)、[server](https://registry.npmjs.org/@modelcontextprotocol/server)、[hono](https://registry.npmjs.org/@modelcontextprotocol/hono)。
- [Inspector Apps review](https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-app-review.md)
- [Inspector v1→v2](https://github.com/modelcontextprotocol/inspector/blob/main/docs/v1-to-v2-migration.md)
- [SDK v2 protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Swift 0.12.1対応版の定義](https://github.com/modelcontextprotocol/swift-sdk/blob/0.12.1/Sources/MCP/Base/Versioning.swift)
- [Swift最新release](https://github.com/modelcontextprotocol/swift-sdk/releases/latest)
- 手元: caldav `bun.lock`、`src/presentation/mcp/server.ts`、swift-mcp-app `Package.resolved`。

## OAuth再認証後の実測(同日追記)

- Codex内蔵ブラウザから正規OAuthを完了(読み取り・書き込みscope)。秘密値は記録しない。
- Inspector 2.5.0 Web: Connected、MCP 2025-11-25 / LEGACYを確認。initialize、tools/list、resources/list成功。
- 同じOAuthをCLI `--stored-auth-only`で再利用しtools/list --app-infoがexit 0。25ツール、UI付き18ツール。
- Web Apps → list-todos(timeZone=Asia/Tokyo): resources/read、tools/call成功。sandbox内のタスクカード描画をスクリーンショットで確認。
- カード内部のlist-calendarsが260msでOK。完了済みを開く操作でfullscreen表示とrefresh-todosを確認(1159ms、OK)。通常表示へ戻り最終更新が進むことも確認。
- 既存タスクへの作成・編集・完了・削除操作なし。カードの通常動作によるtelemetry送信は発生。
- 未検証: agenda実描画、書き込み/D1照合、Swift Simulator、2026-07-28新仕様の実動作、SDK v2とext-apps server helperの型互換。

## ChatGPT接続の追加調査(2026-09-06)

- 公式ドキュメントは標準MCP Appsのui.resourceUri、text/html;profile=mcp-app、postMessageブリッジを案内。caldavはこれらとopenai/outputTemplate互換キーを実装済み。window.openai専用実装への置換を必須とは判断しない。
- 開発用接続はChatGPTのDeveloper modeが必要(アカウント/ワークスペースの方針に依存)。接続作成後に新しい会話でMCPを選択。メタデータ変更後はChatGPT側の更新も確認する。
- 以前の失敗段階(接続/OAuth、カード描画、カード内操作)は未特定。Inspector PASSだけではChatGPT固有の互換性を証明しない。
- [公式接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt) / [公式UI仕様](https://developers.openai.com/plugins/build/chatgpt-ui) / [ユーザー指定ヘルプ](https://help.openai.com/en/articles/11487775-apps-in-chatgpt)。Apps SDKの旧URLは確認時にplugins配下へ転送された。
