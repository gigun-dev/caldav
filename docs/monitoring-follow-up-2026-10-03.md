# 障害監視の改善と所有境界（2026-10-03）

## 確認済みの障害

日本時間9/28 22:05の外形監視ではCodex/Langfuseとも200、22:10にともに530、22:15に2回連続失敗としてBarkへPOSTし200で受理。実端末での表示は未確認。Macは10/3 00:14:04起動、VM/Kumaは00:15頃再開。外形監視はCodex00:20、Langfuse00:25にupへ遷移。Macの正確な停止原因は未確定。

KumaはVM内SQLiteをbind mountし保持180日、Beszelもディスク保存。再起動前の記録は残るが同居監視は停止中の記録が欠損し、Kuma画面は100%に見える。外部Workerは5分間隔・2回失敗通知、KVは最新状態のみ上書き。Workers Observabilityから過去のfetch HTTPコードとBark受理を読めた。

## 担当境界

- hub: 外部でのheartbeat/外形観測の受付・判定、永続的な停止/復旧履歴、通知・再通知・監視自体の失敗検知。既存H1/H1bを読んで重複実装を避ける。
- dotfiles: MacとVMの観測元、boot ID/起動時刻/最終成功の送信、設定と秘密管理。hubのWorker/D1をここに再定義しない。
- caldav: Workers Issuesの導入準備、MCP toolの引数/エラー契約。calendar/task serverのRFC/同期課題は既存todoとして別管理。
- swift-mcp-app: UIの論理エラー表示、反復上限span、LLMへ戻す結果と会話ループ。bridge固有の変換はdotfiles側と連携して切り分ける。

## 方針と受け入れ

Mac/VM/公開経路/service health/機能試験の観測を区別。相関できる証拠が不足した原因はunknownとする。構成を増やしすぎず最小実装を先に検証。Mac停止、VMだけ停止、Tunnelだけ障害、serviceだけ障害、health正常だが機能失敗、監視Cron自体の失敗で期待判定と履歴を検証。強制停止はローカルfixtureで先行し、実ホスト停止や本番cutoverは具体的手順を準備してユーザーの承認後。push/main変更はdeployを起動し得るため未承認で行わない。

Workers Issues公式 https://developers.cloudflare.com/workers/observability/issues/ 。Worker例外/失敗/5xx/エラーログを集約する。HTTP200のMCP isErrorは自動検知前提にしない。SDK大量追加やprivate tool引数のログ化は避ける。

Swiftの実端末trace d7a55ab2b23e2df0e3a015f74fb93e91でlist-events-expanded6件がrange=todayと空timeMin/timeMaxを併記し拒否され、最後は-1005。ChatGPT同サーバー比較は予定取得とカード表示成功。短いstreamはloopback/公開URL/Swift URLSession各3件完了、長時間/実端末切断原因は未確定。Swiftには2 known issuesを検出する新規テストがあり、既存dirtyを保護すること。

## caldav の準備と検証（2026-10-03）

### Workers Issues の設定所有

[公式 Issues](https://developers.cloudflare.com/workers/observability/issues/)を当日確認。
`observability.issues.enabled: true` を `wrangler.jsonc` に追加し、Wrangler を対応最小版の
4.134.0 に固定した。dashboard だけで有効化すると次の Wrangler deploy で無効化されるため、
既存の Workers Builds → `bun run deploy`（D1 migrations → minify deploy）をそのまま使う。
CI は検証のみ。新たな Worker・IaC・deploy workflow は追加していない。
互換日付、DAV、Cloud Run proxy、DB/認証/通知先は変更していない。

Issues の対象は未処理例外・invocation失敗・5xx・errorログ。有効化後の新規トラフィックに
適用され、過去traceの遡及検出はしない。MCP の HTTP200 / isError を拾うため、既存の
ツール計測ラッパーで失敗時だけ `mcp_tool_error` の error ログを出す。
追加ログはツール名・種別・requestIdのみで、引数・エラー本文・principal/sessionIdは含めない。
AE/既存レイテンシログは維持する。SDK がハンドラ前に拒否する schema エラーや、ラッパー前に
返す scope エラーはこの追加ログの対象外であり、全JSON-RPCエラーの捕捉とは言わない。

通知は設定していない。[公式 automation](https://developers.cloudflare.com/workers/observability/issues/automations/)
の occurrence threshold は閾値を跨いだとき一度、recurrence は先行occurrenceがあり所定の
無活動時間後に再発したとき発火する。毎回通知ではない。準備案は threshold=1 と
recurrence=1時間。モデル誤入力も対象になるため、実際のgrouping/頻度を見てから承認する。
destinationは既存所有側で管理し、ここからhub/Bark等への直接送信は足さない。
automation成功はCloudflare Notificationsの受理で、端末到達の証明ではない。

承認後の手順（このsessionでは実行しない）:

1. 既存 main/Workers Builds 経路で変更を反映し、deployログ・Worker版・Issues有効を確認。
2. 別の非本番 fixture Worker で未処理例外、5xx、処理済みerrorを発生させ、Issues occurrenceを
   確認する。本番DAVへ障害注入用routeは追加しない。fixtureは既存管理経路に従う。
3. caldavの読み取り専用 `list-events-expanded` に空文字併記を1回だけ送り、HTTP200/isErrorと
   errorログ/requestId、Issuesの検出とgroupingを照合。正しい相対範囲ではerrorログが増えないことを確認。
4. destination/automationを承認後に設定し、閾値超過・反復・1時間後再発のrun履歴と宛先受信を照合。
   実ログにprivate内容が出ていないかも確認。無効化する場合はWranglerのissues設定を戻し既存deploy経路を使う。

### 引数契約とホスト比較

Swift側の実trace取得報告
`swift-mcp-app/docs/benchmarks/2026-10-03-tool-failure-and-stream-verification.md`も読んだ。
同報告のChatGPT成功会話は
[比較会話](https://chatgpt.com/c/6abfd051-d8e0-83ee-98c6-faebf20f242d)。
初回準備時点ではLangfuse原trace再取得・ChatGPT再実行・bridge upstream schema捕捉はしていない。
報告上の成功と失敗はホスト比較であり、model/prompt/schemaが同一という証拠ではない。

serverの公開 `tools/list` では timeMin/timeMax は optional string、null許可や空文字defaultはない。
実行時は `range` と絶対範囲のXORを検証する。空文字もキーがあれば絶対指定として扱う。
既存契約を変えず、rangeと両絶対フィールドの説明に「キーごと省略、空文字/null不可」を
明記し、排他エラーに両キー削除と有効な相対範囲の例を追加した。
特定model名の分岐、空文字/空白/nullの自動補正、引数schemaの強制required化はしていない。

回帰はMCP wire経由で list-events-expanded / refresh-events / get-freebusy の3入口を検証。
空文字の両側/片側併記、null、空白、空の絶対範囲、片側欠落は拒否。
キー省略の相対範囲と従来の絶対範囲は成功しresolvedRangeを返す。
tools/listの型・optional・説明と、HTTP200の論理エラーの追加ログに入力本文が出ないことも検証する。

初回準備時点の未完はbridgeへ送ったschemaとupstream schemaの比較、修正説明を使ったSwift/ChatGPT再試験、
Issues本番検出/grouping/通知到達。誤引数は契約違反だが、モデル単独かbridge変換かは未確定。
-1005の原因や会話反復の修正はSwift/bridge担当の別作業として保つ。

検証結果: `make check` 成功（層境界、Worker/worker-test/UIの型検査、Bun 1140件、
workerd 42件すべて成功）。`wrangler deploy --dry-run --minify` 成功、upload/deployは未実行。
`bun install --frozen-lockfile --ignore-scripts` も成功。
Wrangler更新に伴う runtime型生成物 `worker-configuration.d.ts` の更新を含む。
本番検出・通知・bridge/ホスト受け入れはこれらのローカル結果では保証しない。

## 追検証: 公開schema・upstream HTTP・実モデルの対照

Swift側の更新報告を照合し、bridge v0.2.1 と同じcommit
`12053383bf000940523332173458a4a094f50b0c` の一時checkoutを用意した。
既存プロセス・bridge設定・Swift実装は変更していない。

`scripts/verify-range-schema.ts` で、本番の `tools/list` を実際に取得し、localと保存した。
認証は既存 `.dev.vars` のtokenを明示的に使用した。本番控え `.secrets.prod.json` のtokenは401で、
その値は出力・保存しなかった（控えの同期はこの作業では行わない）。3ツールとも公開schemaと
localのプロパティ名・optional型・required空配列は一致し、差分は修正した説明文のみだった。
証拠: [schema snapshot](verification/2026-10-03-range-schemas.json)。

`scripts/verification/bridge-range-probe_test.go` を一時checkoutへコピーし、bridgeの公開HTTP handler
からbackendのHTTP `/responses` まで通した。ローカルmock upstreamで受信したparametersを
元schemaと比較し、local/本番 × 3ツール × Chat省略/Chat false/Responses falseの18件すべて一致。
Chat省略は省略を保持、false明示はfalseを保持した。関数だけの試験からHTTP送信境界まで確認を拡張した。
これは稼働binaryの実通信captureではなく、稼働版と一致するsourceの実行検証である。

次に実Codex backendへ、同モデル `gpt-5.6-luna`、同じ合成prompt
「今日の予定を取得してください。タイムゾーンは Asia/Tokyo です。変更はしません。」、
`tool_choice:required`、list-events-expandedだけのtool集合を送った。
各条件3試行、合計12試行。モデルが返した引数はfake repositoryのlocal MCPへ渡して契約判定した。
実カレンダーへのtools/callや変更はしていない。

|schema|strict省略|strict:false|
|---|---|---|
|公開schema|3/3で空timeMin/timeMax併記、local MCP拒否|3/3でキー省略、local MCP成功|
|修正後schema|3/3で空timeMin/timeMax併記、local MCP拒否|3/3でキー省略、local MCP成功|

証拠: [モデル引数12件](verification/2026-10-03-range-model-results.ndjson)、
[local MCPの判定12件](verification/2026-10-03-range-model-contract-checks.json)。
省略条件はcalendarId空文字・calendarIds空配列・maxEvents既定値も埋めた。
false条件は全件 `{"range":"today","timeZone":"Asia/Tokyo"}`。
同じ不正tool callを含む合成履歴へ修正エラー全文を返す対照も実施し、strict省略では再び空文字併記、
falseではキー省略だった（各1試行）。**説明文・エラー文だけでは今回の反復を解消しなかった。**

inferred: この条件ではstrict省略とplaceholder生成が再現性を持って対応した。
実端末の全tool集合・system prompt・履歴・binary経路とは異なるため、過去traceの単独原因とは断定しない。
次の修正候補はSwift Chat経路で、意図するnon-strictを標準の `strict:false` によって明示し、
既存Responses経路と揃えること。モデル名分岐やserverの入力補正は不要。この実装・実端末受け入れはSwift担当へ渡す。

ChatGPTは既存の[比較会話](https://chatgpt.com/c/6abfd051-d8e0-83ee-98c6-faebf20f242d)をこのsessionでも開き、
元の完了応答と「予定はありません」のカードを確認した。
読み取り専用の再試験promptも送ったが、`cloudflare_challenge`、通常の再試行後も `Unknown error`。
新しい成功応答は得られておらず、CalDAVツールの不具合と判定する根拠にはしない。
本番には修正説明が未deployなので、ChatGPTでの修正後schema受け入れは反映後に行う。

再現手順（checkoutは一時ディレクトリ、liveは任意・実モデル呼び出しを含む）:

```sh
bun scripts/verify-range-schema.ts /tmp/range-schemas.json --production --token-file .dev.vars
# bridge v0.2.1 checkout の internal/app/ へ bridge-range-probe_test.go をコピー
CALDAV_SCHEMA_FILE=/tmp/range-schemas.json go test ./internal/app -run TestCaldavRangeUpstreamHTTP -v
CALDAV_SCHEMA_FILE=/tmp/range-schemas.json CALDAV_RANGE_LIVE=1 \
  CALDAV_PROBE_AUTH_PATH="$HOME/.codex/auth.json" CALDAV_PROBE_RESULTS=/tmp/range-results.ndjson \
  go test ./internal/app -run 'TestCaldavRange(LiveModel|Correction)' -v -parallel=4 -timeout=3m
bun scripts/verify-range-schema.ts /tmp/range-schemas.json --model-results /tmp/range-results.ndjson
```

## 追確認: 反映・通知設定・rollbackの具体案

Cloudflare読み取りAPIで当日確認:

- 現行WorkerはIssues設定なし。最新100%版は `387aa32a-7b32-4841-971e-7a4040feefb2`。
- Workers Buildsのmain trigger `38fb0a97-491e-48f2-9619-7c604b02e59c` は `bun run deploy`。
  main以外も別triggerが `npx wrangler versions upload` するため、ブランチpushも今回は行わない。
- Issues automation・webhookは0件。email/webhooksはeligibleかつready、PagerDutyは不可。
- 既存のbudget email policyはあるが、Issuesには流用しない。宛先だけ同じにする案。
  live available_alertsで `workers_observability_real_time_issue` を確認した。
  これはstaticなNotifications OpenAPI enumには未掲載であり、payloadのPOST受理は未検証。

秘密・メールアドレスを含まない
[設定案](verification/2026-10-03-issues-notification-plan.json)を準備した。
専用policyをdisabledで作り、budget policyのemail宛先だけを取得して置換する。
caldav限定のautomationは初回1件と3600秒後再発の2件に分け、同じ専用policyへ向ける。
最初は全てdisabled、参照とpayloadを読み戻してから有効化する。新webhook・hub/Bark routeは追加しない。

承認後に使うAPIは `POST /accounts/{account_id}/alerting/v3/policies` と
`POST /accounts/{account_id}/workers/observability/issues/automations`。
automationは `policyId` 必須、`afterOccurrences:1` または `afterInactivitySeconds:3600`、
`service:"caldav"`。同名登録をGETで確認してから作成し、作成IDを記録する。
反映時のbaseline版は再取得する（上の版はこのsessionのsnapshot）。

rollback:

1. 通知ノイズだけなら専用automation 2件をGET→同じfull payloadの `enabled:false` でPUT。
   専用policyも無効化し、budget policy・他宛先は触らない。通知設定だけのrollbackはWorkerをredeployしない。
2. Worker不具合ならbaseline版へ `bunx wrangler rollback <baseline-version-id> --name caldav --message 'rollback Issues preparation'`。
   現時点のbaselineは上記387aa32a…、実行前に再確認する。DB migration差分はないためDBを巻き戻さない。
3. 次のBuildで再導入されないよう、承認済みの本線で今回のIssues/log変更をrevertして既存Buildへ反映する。
   dashboard-onlyの変更では完了としない。rollback後も既存DAV/MCP読み取りsmokeを確認する。

差分レビュー: protocol/RFC/domain/application、D1 migrations、Cloud Run proxyは変更なし。
Wrangler最小対応版・lock・生成runtime型、presentationの説明と失敗ログ、契約回帰、調査用scriptと証拠に限定。
追加errorログの先頭はツール/種別の固定文字列、requestIdは追加属性に分け、毎回変わるIDが
groupingメッセージへ混ざることを避けた。実際のgroupingはCloudflare側の反映後確認が必要。

未承認で保留する実行はpush/Builds/本番deploy、通知policy・automation作成/有効化、外部通知試験。
準備・読み取り・local/実モデル検証は上記のとおり実施済み。

追検証後の最終確認も `make check` 成功（Bun 1140件、workerd 42件、3レーン型検査・層境界）、
更新したlog実装でdeploy dry-run成功、`git diff --check` と `todo check` 成功。
stage/commit/pushなし。本線HEADは `016d23e`、変更はレビュー可能な未コミット差分として残している。
0054は承認後の反映/検出/通知到達、0055はSwift側non-strict明示と反映後のホスト/実端末確認へ残作業を絞った。

## 2026-10-03 main pushと本番受け入れ

`c642bd7`(Wrangler/Issues) + `3b2216b`(MCP契約説明/errorログ/調査)をmainへpush。
pre-pushを含め`make check`成功(Bun1140、workerd42)。Workers Build
`4056ed78-bcdc-40bf-b28d-2ee8fa17ea55`成功、deploy commandは既存の`bun run deploy`。
D1ログは`No migrations to apply!`、本番version
`612f2dd7-9f81-403c-96a6-3670c2f5e471`が100%。settings APIでissues.enabled=true。

正式proxy OPTIONS204、well-known301 + no-cache、MCP未認証401 + Bearer challenge、
OAuth discovery200、initialize/tools-list/get-current-time/DB依存list-events-expanded成功。
25ツールのうち範囲を共有する3スキーマで省略説明の反映を確認。
[非破壊応答記録](verification/2026-10-03-production-readonly.json)。
Python標準UAはCloudflare1010で拒否されたが、検証名をUAへ明示すると正常応答。
最初の403はDAVハンドラの結果と混同しない。

空の絶対範囲とrangeを併記する合成要求2件はHTTP200/isError=true、両キー削除案内あり。
Observabilityのdry queryでerrorログ2件とreal-time-issuesイベント2件を実測。
両イベントはhandled=true/mechanism=error-log、同一fingerprint
`bc007abd44d9bc1b1fb9e9e878d0e8a8`、signature中のrequestIdは`<string>`へ正規化された。
追加errorログのsourceはlevel/message/requestIdのみで引数・予定本文なし。
Issues一覧への集約には待ち時間があり、イベント検出と一覧反映は区別する。
例外/5xxの障害注入・通知policy/automation作成・外部通知送信は未実施。

続く一覧APIでもIssue `aa455cad-445e-47cf-a519-c651f7910a73`、service=caldav、
status=active、count=2、上記fingerprintの1グループを確認した。処理済みMCPエラーの
本番検出と同種2回のgroupingは実証済み。通知到達/例外/5xxは未検証なので0054は閉じない。

本番RFC確認の追加是正として`3364123`(404要求名保持)と`2aa1171`(明示Depth infinity拒否)を
mainへpushし、各Build成功・D1適用待ちなし・正式proxy受け入れ成功。
結果と残8件の優先順位/境界は[modeling/05](modeling/05-rfc-verification.md)に記録。
新しい本番版でもMCP get-current-time/DB読み取り成功。0001〜0005と0008は検証済みで完了。
0054(通知・例外/5xx残)、0055(ChatGPT/Swift実端末)、0056(Depth省略互換性)は未完。
