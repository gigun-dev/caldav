# 障害監視の改善と所有境界（2026-10-03）

## 現行状態（2026-10-04）

CalDAVのWorkerはIssues有効。専用メール通知policyと、CalDAV限定の初回1件・
1時間以上の無活動後再発のautomationを有効化した。既存budget通知のメール宛先だけを
メモリ内で再利用し、budget policyやhub/Barkは変更していない。
現行設定とIDは[通知設定](verification/2026-10-03-issues-notification-plan.json)に残す。
設定前の手順・旧版へのrollback案はGit履歴を参照する。

本番と独立した、DB・認証・秘密のbindingを持たない検証Workerで確認した。

| 合成入力 | HTTP | Issuesの実測 |
|---|---:|---|
| health | 200 | エラーなし |
| 未処理例外2回 | 500 / 1101 | exception、handled=false、1グループ・count=2 |
| 503応答 | 503 | HttpServerError、mechanism=http-status、count=1 |
| 処理済みerrorログ | 200 | mechanism=error-log、handled=true、count=1 |

HTTP結果は[fixture結果](verification/2026-10-04-issues-fixture-http.json)。
occurrences APIで例外stack、HTTP503、処理済みerrorの区別も読み戻した。
fixtureは検証後に削除済み。再実行は、対象accountを明示して
`bunx wrangler deploy --config scripts/verification/issues-fixture.jsonc`、
`/health`・`/exception`・`/status-503`・`/handled-error`を呼び出し、Issues APIで照合する。
終了時は同じaccountで `bunx wrangler delete --config scripts/verification/issues-fixture.jsonc --force`。
fixtureを本番CalDAVのconfigからdeployしない。

本番は読み取り専用の不正範囲を1回のみ送信し、HTTP200/isError=trueを確認。
正常get-current-timeはHTTP200/isError=false。既存Issue
`aa455cad-445e-47cf-a519-c651f7910a73`はcount=2→3へ増えた。
1時間以上の無活動後再発automationが自動発火し、run
`d3dfcf5e-2d97-4be1-bd73-d9ee10c478d8`は`initiatedBy=automatic/status=succeeded/lastError=null`。
これはCloudflare Notificationsの受付成功であり、メール受信箱・端末表示の到達確認ではない。
初回threshold設定は読み戻し済みだが、新規本番Issueの自然な初回発火は未観測。
正常要求と不正要求の[HTTP結果](verification/2026-10-04-issues-production-http.json)に本文・認証値は保存しない。

Workers IssuesはWorker内の例外・5xx・errorログを扱う。Mac/VM/Tunnel停止はdots側の
外形監視、iPhoneのURLSession切断はSwift側のトレースで観測する。

### WorkerログとOTelの相関（2026-10-05）

標準のObservability APIで、上記2要求の同じ時間帯をdry queryした。
正常get-current-timeはHTTP境界span・ツールログのtraceId/spanId/invocationIdが一致。
不正list-events-expandedはさらにerrorログ・real-time-issuesにも同じIDが付いていた。
アプリ独自requestIdはツールログとerrorログで一致し、CloudflareのinvocationIdとは別物。
公開証拠は[相関結果](verification/2026-10-05-worker-log-trace-correlation.json)。
HTTPヘッダー・送信元IP・本文・認証値は証拠へ含めない。

既存のWrangler traces設定とCloudflare標準計測でWorker境界の相関は実現済み。
追加SDK・新たな送信先は不要。個別ツールやD1操作の独自span、Swift/Langfuseからの
親trace伝播、ChatGPT内部モデルspanまでの相関を保証した結果ではない。
ChatGPT受け入れの0055は、当該ホストの実行記録との照合を別途残す。

### ツール時間の再計測（2026-10-05）

直近24時間の成功したMCP実行をtool/coloラベルで集計した。
NRTのlist-todosは15件、中央値73ms・p95 139ms。list-events-expandedは
NRT59ms・KIX122msだが各1件のみ。これはアプリのツール計測区間で、
通信往復やモデル生成、カード描画時間を含まない。7秒台の初回モデル応答が
これで改善済みとは扱わない。合成データ準備のcreate-todosは1件1250ms。
[集計](verification/2026-10-05-colo-latency.json)に本文・引数は含めない。
IADラベルの標本は0件。IADの追加最適化を判定できるデータがないため、
0024は未完のまま、IADの実行記録が取れた時点で比較する。新たな計測SDKは追加しない。

## 確認済みの障害

日本時間9/28 22:05の外形監視ではCodex/Langfuseとも200、22:10にともに530、22:15に2回連続失敗としてBarkへPOSTし200で受理。実端末での表示は未確認。Macは10/3 00:14:04起動、VM/Kumaは00:15頃再開。外形監視はCodex00:20、Langfuse00:25にupへ遷移。Macの正確な停止原因は未確定。

KumaはVM内SQLiteをbind mountし保持180日、Beszelもディスク保存。再起動前の記録は残るが同居監視は停止中の記録が欠損し、Kuma画面は100%に見える。外部Workerは5分間隔・2回失敗通知、KVは最新状態のみ上書き。Workers Observabilityから過去のfetch HTTPコードとBark受理を読めた。

## 担当境界

- hub: 外部でのheartbeat/外形観測の受付・判定、永続的な停止/復旧履歴、通知・再通知・監視自体の失敗検知。既存H1/H1bを読んで重複実装を避ける。
- dotfiles: MacとVMの観測元、boot ID/起動時刻/最終成功の送信、設定と秘密管理。hubのWorker/D1をここに再定義しない。
- caldav: Workers Issuesの運用設定・検証、MCP toolの引数/エラー契約。calendar/task serverのRFC/同期課題は既存todoとして別管理。
- swift-mcp-app: カード発MCP操作とLLM生成の障害観測、UIの論理エラー表示、反復上限span、LLMへ戻す結果と会話ループ。

## 方針と受け入れ

Mac/VM/公開経路/service health/機能試験の観測を区別。相関できる証拠が不足した原因はunknownとする。Mac停止、VMだけ停止、Tunnelだけ障害、serviceだけ障害、health正常だが機能失敗、監視Cron自体の失敗で期待判定と履歴を検証。強制停止はローカルfixtureで先行する。

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

## 未確定の性能計測と調査範囲

IAD追加最適化の要否は未判定。2026-07のAE計測は遅いテールを示したがcolo別に分解できず、
その後追加したblob6のcolo付きサンプルで再計測する必要がある。日本経由の改善結果をIADへ一般化しない。
`sync-collection`のhydrateに残るsync_changesのN+1は、実往復数とレイテンシを計測して是正の要否を決める。

OTelの追加調査は既存AEを置き換える指定ではなく、トレースとログを相関する価値とWorkers対応の確認。
Nodeのmodule hookに依存する自動計装がWorkersで使えるという前提は未検証。

本番データの過去の掃除候補は重複テストコレクション2件と2026-07-15の検証由来候補イベント。
今回の資料整理では削除せず、実データを照合して対象を決める。古い件数を現況とは扱わない。

## ChatGPT回答経路の再確認（2026-10-04、0055）

既存の検証会話で予定・未完了todoを読み取り要求した。最初の送信と再試行は
Unknown error、再読込時にCloudflare確認画面を経由したが、その後送信が成功した。
回答とVEVENT/VTODO両カードが表示され、予定0件・未完了32件を回答した。
同日のMCP直接問い合わせも予定0件・VTODO対応5リストの未完了合計32件で一致した。
データの変更操作は行っていない。使い心地やSwift URLSession切断の検証とは区別する。

Langfuse CLI observations v2を検証時間帯の開始時刻から検索しHTTP200・0件・次cursorなし。
CalDAVの現行計測アダプタはAnalytics EngineとWorkers errorログで、
ChatGPTのモデル内部spanがこのLangfuseに自動登録される仕組みはない。
この0件を通信失敗やOTel送信失敗の証拠とは扱わない。
回答の機能確認は成功、Workersのツール実行記録との相関は0038の計測調査に依存して残る。
