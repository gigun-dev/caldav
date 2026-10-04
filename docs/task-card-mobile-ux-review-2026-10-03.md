# タスクカードのモバイル操作改善

2026-10-03のユーザー提供メモを、認証改善とは独立した検討対象として記録する。
以下は検討する問いであり、すべてを実装する指定や既存方針の撤回ではない。

## 入力と編集の遷移

- 下部のタスク編集時にキーボードが対象を隠さないか。スクロール位置、ホストsafe area、フォーカス保持を確認する。
- 確定ボタン・外側タップ・別アイテム選択・戻るで保存する条件と、失敗時の復帰を揃える。
- 毎回モーダルを出す操作負担と、インライン編集の扱いやすさを比較する。
- 常設入力欄とタップ時の差し替えを比較し、高さ・位置ががたつかない条件を決める。
- 新規空ドラフトと既存タスクを空にした場合を分け、破棄・復元・削除を誤操作の観点で決める。

## 作成・表示・操作

- タスク間への追加、複数タスクの連続入力を必要性から評価する。
- 完了タスクの取消線・減光・移動・非表示の時点を確認する。
- 長押しでメニューと並べ替えが衝突しないかを確認する。
- 改行・1,000字貼り付け時の行数上限と全文への導線を確認する。

## 保存・同期・並べ替え

- PC/スマホの保存先・同期タイミング、送信中・失敗・オフライン時の表示を確認する。
- 同一タスクの同時編集を検知し、編集内容を黙って失わない振る舞いを決める。
- 手動順序の保存と複数端末の同時並べ替えを分けて設計する。

## 既存方針と検証の境界

現行方針は `docs/modeling/12`・`15` と該当ADRを読む。
過去の判断経緯は Git 履歴を参照する。
既定の追加は単発、戻るでも編集保存、完了直後は位置を保持する方針がある。
連続入力や完了時移動は、このメモだけで既定を変更しない。

既存todo0016は実機UIの機能確認、0058は本人による使いやすさの評価、0033/0034/0051は並べ替えの観測・設計を扱う。
新しい監査では既存タスクへ結果を接続し、二重実装を避ける。
UI/ホストの問題と、CalDAVサーバーの競合制御・永続化の問題を区別する。

まず現行カードを項目ごとに「対応済み／不具合再現／仕様未決／端末未確認」に分類し、
優先する改善スライスとユーザー実機受け入れ手順を作る。
本人確認が必要なものは操作・期待結果・確認したい差異を短く示す。

## 2026-10-03 監査と試用準備（0058）

使いやすさと体験の流れは本人が判断する。この監査で確認したのは実装の経路、既存の純関数回帰、本番MCPの保存結果までである。実端末のキーボード、カードホストの表示、オフライン時の画面は操作していない。以下の「実装あり」はUX受け入れ済みを意味しない。

照合対象は modeling [12](modeling/12-vevent-agentic.md)・[15 §C-7](modeling/15-hitl-and-card-ui-principles.md)、[ADR 0003](adr/0003-delegate-confirmation-to-hosts.md)、`todos-entry.ts` / `todos-app.ts` / `update-todo.ts`、todo0016/0058/0033/0034/0051。12の過去の既存行インライン編集・連続Enterの記述より、15 §C-7の既存行fullscreen・新規行safe topと現行コードを採用した。既定の撤回や新しい仕様決定は行っていない。

| 問い | 現行機能と根拠 | 自動確認・未確認 | 本人の受け入れ／仕様未決・既存todo |
|---|---|---|---|
| 下部行とキーボード | 既存行は詳細fullscreen。host safe areaをrootのpaddingへ適用、入力中FABを隠す。入力中の破壊的再描画を抑止。`todos-entry.ts:2163,4579`、`todos-app.ts:1065,1214` | safe-area / render-gate回帰成功。実端末の見切れは未確認 | 下部24番を編集し、入力欄・確定ボタンが見えるか。0016・0058 |
| 確定・外側・別行・戻る・失敗 | 新規draftは✓/Enter、外側tap、選択解除で非空なら作成。既存詳細は「完了」「保存して戻る」で保存。詳細表示中は外側tapの一覧ハンドラを除外。失敗は楽観更新を戻し、同じ変更の再試行バナー。`todos-entry.ts:1807,1894,2369,5286,5874` | MCP更新・メモ空への更新成功。UIクリック経路・失敗バナーは実端末未確認 | 「完了」がタスク完了と紛らわしくないか、詳細で外側tapと戻るの差が分かるか。保存条件の統一は未決。0016 |
| 詳細とインラインの負担 | 既存編集fullscreen・新規のみinlineは15 §C-7の現行方針。到着時に既存入力へ自動focusしない | 経路のコード照合のみ | 01を何度か編集し、往復が負担か判断。方針変更は本人の評価後。0016 |
| 常設欄・差し替え・がたつき | 常設入力欄は無く、⊕で最上部draftを差し込む。表示・入力16px。fullscreen移行はホストに依存 | render-gate回帰成功。位置の変化は未計測 | ⊕前後、keyboard開閉、一覧と詳細の往復で何が動くと困るか。0016・0058 |
| 新規空と既存空 | 新規空draftは作成せず消す。既存titleを空にすると更新引数に含めず旧titleを保持。notesは空で消せる。削除は別操作。`todos-entry.ts:1807,2421,2972` | 空リスト・メモ消去の永続化成功。title空のUI挙動は静的照合 | 02のtitleを空にして戻る。旧値保持が意図に合うか、説明が必要か。破棄・削除の変更は未決 |
| 行間追加・連続入力 | 追加位置は上部、Enter確定後はdraftを閉じる単発。行間挿入・連続入力は現行UIにない。`todos-entry.ts:1848,1894` | 本番batch24件作成成功はMCP APIの機能であり、カード連続入力の証明ではない | ⊕→Enterを2回行い、繰り返し⊕が負担か評価。既定変更は未決 |
| 完了の取消線・減光・移動 | 取消線・muted色。操作したカード内では位置保持、fresh render/リスト切替で完了セクションへ。inlineは完了件数からfullscreenへ、fullscreenは折り畳み。`todos-app.ts:616`、`todos-entry.ts:3735` | 完了→未完了の本番永続化、toggle-coalesce回帰成功 | 01を完了・戻す、リスト切替・再表示して位置と見え方を評価。0016 |
| 長押しと並べ替え | contextmenuは削除ボタン露出、左右swipeでも露出/収納。ドラッグ並べ替えは現行UIにない。`todos-entry.ts:1909` | 実端末gesture未確認。並べ替え衝突は未再現 | 検証行を長押し・左swipeし、削除の誤操作を確認。0016。並べ替えは0033→0034→0051 |
| 改行・1000字・全文 | titleは一覧で折り返し、行数capなし。詳細titleは単一行input。notes一覧は1行ellipsis、詳細はtextareaで全文。`todos-app.ts:603,633,1578` | title/notes各1000文字、改行notesを本番往復で保持 | 03/04/05の一覧高さ、詳細で末尾へ到達、コピー/貼付けを評価。title行数capやmultiline入力は未決 |
| PC/スマホ保存・同期・pending/失敗/offline | 同じcalendarIdへMCP保存、楽観表示後に確定一覧を反映。復帰visibility/focus/pageshowで再取得（2.5秒ガード、pending中は抑止）。自動再取得失敗は既存表示を維持。offline永続キューはない。`todos-entry.ts:5151,5286,5900` | 本番MCP CRUDと再読込成功。PC/スマホ間のホスト復帰・offline画面は未確認 | 01を片方で変更し、もう片方へ戻った時の反映を確認。offlineの入力保持/再試行も本人確認。0016 |
| 同一タスク同時編集 | サーバーは意味的patch・書込み時の競合を1回再読込して再適用。MCP update-todoには編集開始時etag/version引数がない。同じfieldの古い編集を明示検知するUIは確認できない。`update-todo.ts:313`、本番tools/listのschema | **機能上の不足を静的確認**。別端末の同時編集E2Eは未実施。DAVのIf-Match保護とMCPの編集開始時競合は別 | 黙って失わない条件、同一field競合の通知・選択方法は仕様未決。一般的な競合検知済みとは扱わない |
| 手動順序の保存・同時並べ替え | manualモードのpositionMemoryはカードインスタンスの位置保持。sortOrder値の読取りはあるがドラッグUI・並べ替え更新MCP引数はない。`todos-entry.ts:767,1076` | 現行UIで手動並べ替え可能という前提は成立しない | 保存形式・同時操作の扱いは0033の通信観測を先に行い0034/0051へ接続。今回裁定しない |

今回、新たな画面不具合を実端末で再現した項目はない。titleの行数cap、行間挿入、連続入力、ドラッグ並べ替え、編集開始時の同一field競合通知は現行実装の機能として確認できないが、このメモだけで実装義務や不具合認定は決めない。

## 本人がすぐ試すためのデータ

本番MCPへ以下の**専用3リスト**を作成した。既存4リストのオブジェクトは変更していない。全件合成データ、期日は2030年の1件のみ、アラームなし。

| calendarId | 表示名 | 保持件数 |
|---|---|---:|
| `ux0058-20261003` | `[UX0058] 操作検証` | 24（未完了22・完了2） |
| `ux0058-20261003-empty` | `[UX0058] 空リスト` | 0 |
| `ux0058-20261003-move` | `[UX0058] 移動先` | 0 |

評価対象は **VTODO（タスク／リマインダー）**。Swift MCP Hostのcaldav接続と `list-todos` を有効にしたチャットで、次の文をそのまま送る。

> caldavのlist-todosをcalendarId「ux0058-20261003」で実行して、タスクカードを表示して。

ツール行が `list-todos`、リスト名が `[UX0058] 操作検証` なら評価対象に到達している。「今日の予定」は `list-events-expanded` を使う **VEVENT（予定）** の別カードで、ここでのタスク編集評価とは異なる。空リストを直接開く場合は `ux0058-20261003-empty`、移動先は `ux0058-20261003-move` に置き換える。既存カードのリスト選択から `[UX0058] 操作検証` を選んでもよい。完了2件は「完了済み」から開く。カードが出ない場合は、そのホストのMCP Apps表示対応を別途切り分ける。

1. **下部編集**：fullscreenの一覧から24番を開き、メモ入力→「保存して戻る」。keyboard・FAB・確定ボタンが隠れないか、位置が飛ばないかを見る。
2. **保存の流れ**：01を変更→「完了」、もう一度変更→「保存して戻る」。新規⊕ではEnter、別行tap、外側tapを比較する。空の新規draftも試し、作成されないことを見る。
3. **空への変更**：02のtitleだけ全消去→戻る。旧titleが残る現行挙動が意図に合うか確認する。notes全消去は保存される。削除したい場合は長押し/左swipeの別操作を試す。
4. **長文**：03の改行、04の1000字title、05の1000字notesを開く。末尾へ到達し、全文コピー・貼付けを試す。一覧の長さ/詳細の読みやすさを本人が判断する。
5. **完了と追加**：01を完了→戻す、他リストへ移動して戻る。位置保持と完了セクションへの移動が自然かを見る。⊕→Enterを2回繰り返し、単発追加の負担を評価する。
6. **空・移動・同期**：空リストを選び⊕で1件追加する。操作検証の1件を移動先へ移す。PC/スマホ双方で01を開き、片方の保存後、もう片方へ戻って反映を確認する。offlineを試す場合は専用行だけで実施し、復帰後に保存結果も読む。

記録は「端末/ホスト」「操作」「期待していたこと」「実際」「困る程度」で十分。UIの良否は本人記録が揃うまで未受け入れ。最初の改善候補はkeyboard/FABと保存語彙。機能検証は0016、使いやすさの本人評価は0058へ記録する。続いて長文・空title・同期競合の意図を確認する。実装の優先順・仕様変更は本人の結果から決める。

## 自動機能検証と再実行

- カード周辺9ファイルの既存回帰：**96成功、0失敗**。safe area、focus中render-gate、完了coalescing、折り畳み、リストfilter、入力DTO、collection保存差分、detail/copy helperを確認。DOM/実端末E2Eではない。
- 本番MCP：**17チェック成功**。専用リスト照合、24件とtitle集合、title/notes1000文字、改行、完了2、空リスト2、更新とメモ消去、完了/戻す、移動元消失と移動先存在、一時行cleanup。本人用24件は保持した。証跡：[機能結果JSON](verification/2026-10-03-task-card-functional.json)。
- 入力データ：[合成fixture](../test/fixtures/task-card-mobile-ux-20261003.json)。スクリプト：[task-card-ux.py](../scripts/verification/task-card-ux.py)。認証値は `.dev.vars` からメモリ内だけで使い、fixture/証跡へ保存しない。

```sh
# 作成済みなので通常は実行しない。専用リストが一つでも存在すればseedは停止する。
python3 scripts/verification/task-card-ux.py seed
# 本人が編集する前の初期データを検証。一時タスク1件のみCRUDして削除する。
python3 scripts/verification/task-card-ux.py verify
# 試用終了後のcleanup。上記3リストとその配下だけを削除する（本人追加分も含む）。
python3 scripts/verification/task-card-ux.py cleanup
```

本人編集後は24件・内容一致チェックが失敗し得るため、`verify` の失敗をサーバー不具合と即断しない。cleanupは表示名と識別子の一致を検証してから行う。本人用データは今回削除していない。

## 予定カードの初期凡例（2026-10-03 本人報告）

予定なしの初期画面で右上が0、タップ後に2色へ変わる原因は、背景のlist-calendars取得完了時に凡例を更新していなかったこと。取得完了後に凡例だけを更新し、未取得・全選択の間は「…」で表示する。connect解決より先にtool-resultが届いた場合も背景取得を開始する。入力欄や一覧DOMの再描画は増やさない。

実際のagenda HTMLとext-apps SDKをChromiumのiframeに読み込み、予定0件・カレンダー2件の応答を700ms遅延させたホストで検証した。クリック0回で「…」から色ドット2件へ更新。Swift実機での本人の使いやすさ判断とは分ける。

## 2026-10-05 Swift実ホストでの機能確認（0016）

iPhone 17 / iOS 27.0 の専用Simulator（402×874pt）で、署名済みSwift MCPHostから本番CalDAVのMCP Appsカードを操作した。今回の合成専用リストは A（id=`functional-verification-0016`、displayName=`Functional verification 0016`）で、初期3行と下部スクロール用14行を準備した。0058の本人評価用データは変更していない。

| 操作 | 実経路の結果 |
|---|---|
| fullscreen / FAB | 最大化後の追加ボタンが画面内でhittable。通常composerと重ならず、縮小後のcomposerもhittable |
| 追加 / フォーカス / 確定 | タイトル入力へフォーカスし、Doneで追加表示。本番MCPを別接続で読み、`0016 Added fixture` の保存を確認 |
| 既存編集 / 保存 | 詳細ページのtitleを全選択で変更し、ページの「完了」で一覧へ復帰。別MCP readで `0016 Edited fixture` の保存を確認 |
| コピー | 詳細のtitleを全選択→iOS編集メニューCopy。Simulator内clipboardを `simctl pbpaste` で別readし `0016 Copy fixture` と一致（統合XCUITest内にはclipboard内容assertを含めていない） |
| リスト切替 | `Tasks` 選択で専用行が消え、専用リスト選択で復帰。切替先の既存タスクは変更していない |
| swipe削除 | 専用行の左swipeで削除ボタンを露出し、タップ後に行が消失。別MCP readでも削除済み |

画面操作はXCUITestを用いた。通常ChatHomeViewで検証用loopback Chat Completions応答を使い、`list-todos`の選択だけを固定した。MCPのOAuth・本番tool call・HTML resource・bridge・保存は実経路である。検証用providerはSwift repoの `scripts/verification/caldav-card-provider.py`、試験入口は `UITests/CardFunctionalVerificationTests.swift`（opt-in）。製品ルートの追加やツール機能の縮小は行っていない。

専用SimulatorをDevice Hubで選択した状態ではソフトキーボードの実表示を取得できた。新規入力はtitle=(60,268,283,22)、詳細入力はtitle=(12,270.2,379,35)、keyboard=(0,583,402,233)で、入力欄の下端がkeyboard上端より上にあることをassertし、スクリーンショットをxcresultへ保存した。下部行 `ZZ 0016 scroll fixture 13` はframe=(60,797,176,21)までスクロールした後に詳細を開き、title=(12,270.2,379,35)へフォーカスした。keyboard=(0,583,402,233)より入力欄が上にあることを単独XCUITestで確認した（8.5秒、成功）。証拠は `/tmp/swift-delete-verification/lower-single.log` と Swift repoの `.build/xcode/Logs/Test/Test-MCPHost-2026.10.05_01-11-24-+0900.xcresult` の `lower-row-input` 添付である。使いやすさ・操作の流れの良し悪しは0058で本人が判断する。

再実行には専用リストAをdisplayName=`Functional verification 0016`（VTODO）で作り、未完了の `0016 Edit fixture` / `0016 Copy fixture` / `0016 Swipe fixture` を1件ずつseedする。下部行用に `ZZ 0016 scroll fixture 00`〜`13` を追加する。Bは不要。OAuth済みの通常hostを次の検証用設定で起動し、任意の発話を1回送って専用カードを準備する。キーは実credentialではなくfixture文字列である。

```sh
python3 scripts/verification/caldav-card-provider.py
SIMCTL_CHILD_MCPHOST_LLM_KEY=fixture \
SIMCTL_CHILD_MCPHOST_LLM_BASEURL=http://127.0.0.1:18464/v1 \
SIMCTL_CHILD_MCPHOST_LLM_MODEL=verification \
xcrun simctl launch --terminate-running-process "$SIMULATOR_UDID" dev.gigun.mcphost
```

iPhone 17専用Simulator（402×874pt）を明示し、`build-for-testing`後の `.xctestrun` の `MCPHostUITests.EnvironmentVariables.MCPHOST_CALDAV_FUNCTIONAL_E2E` に `1` を設定して `test-without-building -only-testing:MCPHostUITests/CardFunctionalVerificationTests` を実行する。試験は画面内・画面幅・hittableに合うfullscreen WebViewを選び、専用リスト選択と初期3行を変更前に照合する。固定座標はこのviewport専用である。WKWebView AXは非表示行を残すので、リスト切替／削除の画面消失はhittableで判定し、保存・削除は別MCP readで照合する。clipboard内容は `simctl pbpaste` による別検証（test内assertではない）。認証値や署名鍵を記録へ保存しない。


統合試験0064は2026-10-05 02:02:51開始の一括XCUITestで成功した（80.731秒、0 failures）。追加→既存編集→コピー→Tasks切替→専用リスト復帰→swipe削除→下部行入力→fullscreen縮小→通常composer復帰まで、通常hostと実MCPを通した。同試験中のsoftware keyboardは全入力phaseで(0,583,402,233)、下部行は(60,797,176,21)、開いた詳細titleは(12,270.2,379,35)で遮蔽なし。終了後の別MCP readでAdded/Edited保存・Swipe削除・下部専用14行保持を確認し、`simctl pbpaste` も `0016 Copy fixture` と一致した。

試験コードはsticky headerの実AX labelをtypeに依存せず照合し、行の可視topをheader.maxY+8で取る。戻すdragはcard content中央内に限定する。専用リスト初期3行・画面内fullscreen WebView・402×874ptの事前条件を守って実行する。製品UIの変更はない。

成功ログは `/tmp/swift-delete-verification/r2-last-full-functional.log`、xcresultは `/Users/gigun/Library/Developer/Xcode/DerivedData/MCPHost-axzytqizkcazmxazuxjstzuhsmyw/Logs/Test/Test-MCPHost-2026.10.05_02-02-51-+0900.xcresult`。新規・詳細・下部行keyboardのスクリーンショットを添付として保存した。clipboard内容は統合test内のassertではなく終了後の別readである。使いやすさの本人評価0058とは別の、機能経路の確認である。

01:16の別の一括試験では、カード発 `update-todo` の実通信失敗を観測した。2026-10-05 01:16:06.509 JSTに開始し、01:16:12.828に `NSURLErrorDomain -1005` / `CFNetwork -1005`（stream code -4）で失敗した。公開endpointは `https://caldav.gigun-dev.workers.dev/mcp`、URLSession taskは `6D1F7645-733B-4ABF-8050-ADF3348B4318` の87。カードには「変更を保存できませんでした」が出た一方、別MCP readではEditedの保存を確認した。Worker側は01:16:06.565〜01:16:07.088、HTTP200 / ok=true / 523msで正常終了し、server traceは `218802cca679ff753151565b211366b4`。client側のrequest/trace IDはログにないため、これは時刻と操作の相関である。

失敗実recordはAppsServerProxy / AppsBridgePassthroughDispatcherのOSLogにあり、01:16の実行版では通常カードのproxy tools/callに既存TelemetryPort/spanが渡されていなかった。LLM generation失敗計測とは別経路で、今回のカード失敗をOTLPで取得した証拠はない。Workerが正常終了しているためWorkers Issuesだけでこの接続断を取得できるとは言えない。raw NSErrorのpeer情報・認証値は記録へ保存していない。

実hostのOSLogでも新しい `card.tool.finished` が出た。02:03:17.651のcreate-todoは528ms / operationID=`DC2F00B8-B715-46BC-9A91-595D092A2BF0`、02:03:36.975のupdate-todoは630ms / operationID=`C406CE5C-472E-40D9-ACBB-3C75E79CA9F0`、02:04:02.858のdelete-todoは647ms / operationID=`30263126-AA5E-47DB-B845-6ED8847ED6D4`で、全てsuccessだった。通常Featuresからbridgeへの注入が動く証拠であり、実hostからremote OTLP保存までの検証ではない。実hostのremote保存は未確認のままで、設定の準備だけを保存成功に数えない。

検証終了後、専用リストAをforce削除した。専用Simulator `w-caldav-cards-0064-r2` をshutdown/deleteし、検証provider/receiverのlistener停止も確認した。製品変更はなく、既存`make check`はServices 211件・Kernel 136件成功、lint違反0。一括後のhelperに対するlint違反0・iOS `build-for-testing` 成功も確認した。

### カード発MCP操作の観測（0066）

Swiftの既存TelemetryPortを通常カードのAppsBridgeSessionへ渡し、`tools/call`を独立したclient span `card.tool`として記録する。ツール名・操作ID・bridge request ID・単調時計による経過時間・outcome・NSError domain/code/typeを保存する。引数や結果本文は新しいspanへ含めない。成功はOK、MCPの`isError`とtransport失敗はERROR、画面を閉じた際のcancelledはUNSETとする。closeと遅いproxy応答で二重終了せず、閉じた画面へ応答を配送しない。

既存OTLP exporterが生成したgzip/protobufをloopback HTTPで実受信し、4つのoutcomeを検証した。同じ合成payloadを既存Langfuseへ送信してHTTP200を確認し、Observations APIで4件を読み戻した。transportの`NSURLErrorDomain:-1005`、論理エラー、非エラーのキャンセルを区別できた。安全な読取結果は[観測証拠](verification/2026-10-05-card-tool-otel-readback.json)。新しいSDKや送信先は追加していない。[Langfuseの公式OTLP仕様](https://langfuse.com/integrations/native/opentelemetry)に沿い、既存のHTTP protobuf経路を使った。

これは合成失敗を用いた計測・保存経路の検証である。1時16分に発生した自然な接続断を遡ってOTelで取得した結果や、端末からWorkerへのtrace伝播、接続断の根因解消を示すものではない。

Swift実装commitは`e2de882`。最終`make check`はServices 211件・Kernel 136件成功、lint違反0。iOS全体の`make app`も成功した。

### 配布の残件（0067）

`e2de882`をmainへpushし、pre-pushの`make verify`を通過した。既存asc-mcpのjob `d5e642e4-39c2-4f18-934e-8cab40bc7ebb`（[GitHub run](https://github.com/gigun-dev/asc-mcp-control/actions/runs/37218040705)）はMac miniでDevelopment署名のarchiveまで成功したが、Ad Hocの`release-testing` exportで失敗した。Xcodeはキーチェーンのaccount credentialsに`missing Xcode-Username`、続いて`No signing certificate "iOS Distribution" found`を記録した。

前回run `37151857106`は同じ方式でexport・署名検証・公開まで成功している。再調査ではrunnerはGUIセッションで稼働し、同じGUIセッションの一時診断プロセスでloginキーチェーンの`no-timeout`と有効なDevelopment署名1件を確認した。SSHからの「有効な署名0件」「User interaction is not allowed」はGUIの解除状態の証拠にはならない。単純なキーチェーンロックとは判定しない。

ASCは前回と同じ5.9.2。配布用のローカル署名identityは見つからず、前回のexportログには`Apple Distribution: REALBIND Inc.`とAppleサービスからの`Remote signature`があり、Mac miniでクラウド署名が成功していたことを確認した。今回は同じ経路へ進む前に`missing Xcode-Username`と署名asset解決失敗を記録している。[Appleの説明](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/)では、クラウド管理の証明書と秘密鍵はリモートで管理されるため、ローカルidentity不在だけで証明書失効とは判定できない。アカウント情報を読めなくなった原因は未確定。本人の画像ではXcodeのDevelopment署名・チームAdmin権限・19台の登録端末が正常に表示されている。現在のアカウント状態でjob `f1e1b884-dd21-4473-a5c6-aae84a98ec7f`（[GitHub run](https://github.com/gigun-dev/asc-mcp-control/actions/runs/37221798765)）を開始し、最新版`d59c883`の同じAd Hoc配布を再検証中。証明書の新規作成・失効やApple開発者ダッシュボードの操作は行っていない。Macの起動は10月3日0時14分のままで、再起動も行っていない。今回jobは公開工程へ到達せず、固定URLの既存配布物は更新されていない。新しい観測コードの端末適用は未完である。
