---
name: mcp-inspector-verify
description: caldavのMCPツールとMCP AppsをInspectorでE2E検証し、OAuth、ui://カード、callServerTool、保存結果のD1生ICSまで裏取りする。MCPの本番検証、確認カード、カード内操作、生成UI、OAuth付きtools/call、D1保存内容の確認を頼まれたときに使う。
---

# MCP Inspector E2E検証

サーバー応答だけで合格にせず、必要な層を順に通して証拠を残す。秘密値をコマンド出力、ログ、
スクリーンショット、回答へ載せない。

## 1. 検証範囲を決める

- tool契約だけなら Inspector の Tools タブまで。
- `ui://`、`App.callServerTool`、カード再描画は Apps タブまで。
- iCalendarの意味論を含む変更は、最後にremote D1の `calendar_objects.ics` を読む。
- claude.ai固有のmodel visibilityや会話transcript分離はInspectorだけでは証明できない。別検証にする。

変更に対応する設計の正典を先に読む。確認カードなら
`docs/modeling/14-confirmation-card.md`、MCP Appsの契約ならserver実装と該当modelingを読む。

## 2. Inspectorへ接続する

1. repo rootで `bunx @modelcontextprotocol/inspector` を起動する。既存プロセスがある場合は、
   そのターミナルに表示されたInspector URLを使う。
2. 表示された認証token付きURLをbrowser automationで開く。tokenをprocess envから採取したり、
   回答へ転記したりしない。
3. TransportをStreamable HTTP、URLを検証対象のMCP endpointにする。本番既定は
   `https://caldav.gigun-dev.workers.dev/mcp`。versioned endpointを検証するときだけ `/mcp/vN` を使う。
4. OAuthを完了する。既存profileの認可状態を無条件に前提にせず、接続済みprincipalとscopeを確認する。

## 3. Toolを検証する

1. List Toolsを更新し、tool名・description・input schema・`_meta.ui.resourceUri`を確認する。
2. 既存データと衝突しない一意なUID/titleを使う。破壊的操作は専用の検証データだけを対象にする。
3. Run Tool後、text、structuredContent、`_meta`、error状態を記録する。
4. mutationは成功応答だけでなく、再取得したview modelとD1保存値まで確認する。

確認カードS1では最低限、次を分けて確認する。

- confirmToken無しの `delete-*` が安全側で拒否される。
- `propose-delete-*` 自体は削除せず、tokenとpreviewをmodel-visible contentではなく
  `_meta.confirm` に載せて確認カードを開く。
- カードの承認操作だけが対応する `delete-*` を実行し、取消は副作用を起こさない。
- 既存todos/agendaカード内の明示的deleteは、card tokenにより二重確認なしで動く。
- 別tool、別UID、失効token、secret未設定を受理しない。

## 4. MCP Appを検証する

1. AppsタブでRefresh Appsし、対象AppをOpen Appする。
2. sandbox iframeの描画はaccessibility snapshotだけに頼らずscreenshotで確認する。
3. カード内操作を行い、`App.callServerTool`の成功、再描画、エラー表示を確認する。
4. OAuth principalがカード内callにも維持されていることを、対象データと応答で確認する。

## 5. D1の生ICSを裏取る

database名やIDをmemoryから写さず、`wrangler.jsonc` の `d1_databases` から現在値を確認する。
検証用に自分で生成したUIDだけをSQLへ使い、remote DBをread-only queryする。

```bash
bunx wrangler d1 execute DB --remote --command "SELECT uri, ics FROM calendar_objects WHERE uri LIKE '%検証UID%'"
```

必要に応じて `DTSTART;TZID`、`VTIMEZONE`、`VALARM`、`RRULE`、`EXDATE`、URL、独自propertyを
バイト列で照合する。既存ユーザーデータを更新・削除しない。検証データの後始末も、確認対象の
正規tool経路で行う。

## 6. 結果を残す

- 事実を `tool response / App UI / callServerTool / D1 raw ICS` の層ごとに分ける。
- 実施できなかった層は未検証と明記する。
- 作業の区切りで `docs/next-directions.md` の最新状態を更新し、時系列詳細を`docs/log.md`へ追記する。
- deployを伴う場合は、続けて`deploy-verify` skillを使う。
