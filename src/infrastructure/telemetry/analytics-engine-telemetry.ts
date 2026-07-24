// =============================================================================
// AnalyticsEngineTelemetryAdapter — TelemetryPort の Workers Analytics Engine 実装(観測基盤 v1)
// =============================================================================
//
// 【AE の1データポイント制約(設計の前提)】
// Workers Analytics Engine の writeDataPoint の実際の制限(公式ドキュメント
// https://developers.cloudflare.com/analytics/analytics-engine/limits/ を 2026-07-24 に
// docs/rfc の原文確認ルール(.claude/rules/rfc-primary-sources.md)に準じて一次資料で確認):
//   - indexes: 1データポイントにつき1個・**96 バイト以内**という強い制約があるのは index だけ。
//   - blobs: 最大20個・**合計16 KB**(2025-06-20 に 5KB→16KB へ拡張された)。
//   - doubles: 最大20個。
//   - 1 invocation(呼び出し)あたり最大250データポイント。
// 旧コメントは「1データポイント全体で96B以内」「requestId/sessionId が UUID(各36B)だけで
// 96Bを超えるので blobs を切り詰める」と書いていたが、これは**事実誤認**だった
// (96B制約は index1 だけにかかり、blobs は16KBの別枠を持つ)。この設計は今:
//   - index1: mcpTool 固定(AE のクエリは index1 で GROUP BY/WHERE するのが最速経路 —
//     公式ドキュメントが「高頻度フィルタ列を index1 に」と推奨)。mcpTool は短い文字列なので
//     96B 制約の対象になっても問題ない。「create-calendar の呼び出し履歴を引く」のような
//     "ツール別に絞る" クエリが主用途になる想定と合致する。
//   - blobs[0..5]: principal, host, errKind, requestId, sessionId, colo(文字列。空/undefined
//     は空文字 "" にして6要素固定にする — AE は blobs のインデックス位置で意味を持たせる設計
//     なので、要素数を可変にすると SQL 側で blob1/blob2... の対応がイベントごとにズレる)。
//     6要素を合算しても数百バイト程度で 16KB 枠に対し十分余裕がある。
//   - doubles[0..1]: ms, ok(0/1。AE に真偽型は無いので数値化。SQL 側で `WHERE double2 = 0`
//     が「失敗のみ」フィルタになる)。
// AE は制限超過のデータポイントを**エラーにはせず黙って truncate/破棄する**(公式ドキュメント
// 言及)ため、このアダプタは「書けたら書ける・書けなくても例外にしない」の設計でよい
// (TelemetryPort.record の fire-and-forget 契約どおり)。
//
// 【argsDigest を AE に送らない判断 / colo は送る判断(2026-07-24 更新)】
// argsDigest はキー名の列挙等の構造化データで、SQL での GROUP BY 対象としての集計ニーズが薄い
// (「どんな引数が来たか」の分布分析より「引数漏洩していないか」の監査が主目的で、それは
// console.log の構造化ログ側(TelemetryEvent 全体を JSON で1行出力)で十分)。よって AE には
// 積まず、console.log 側にだけ argsDigest を残す(server.ts の計測点コメント参照。この判断は
// blobs の容量とは無関係で維持する)。
// colo はかつて「96B 予算を principal/errKind 等より優先する」という理由で AE から除外して
// いたが、その前提(96B が blobs 全体にかかる)自体が事実誤認だったため撤回する。colo 別の
// ツールレイテンシ集計(IAD 等の遠い colo が D1 直列往復で遅い、という仮説の SQL 検証)は
// 繰り返し必要になる主要クエリであり、colo(3〜4文字)を blobs の16KB枠に積むコストは
// 無視できるほど小さい。よって colo は blob6 として AE に送る(下記 writeDataPoint 参照)。
// argsDigest は「無くした」のではなく「構造化ログ側に残る」ことに注意(情報の書き分け:
// AE=高頻度・低カーディナリティの定量集計、構造化ログ=詳細な1件ずつの監査)。
// =============================================================================

import type { TelemetryEvent, TelemetryPort } from "../../application/ports/telemetry";

export class AnalyticsEngineTelemetryAdapter implements TelemetryPort {
	constructor(private readonly dataset: AnalyticsEngineDataset) {}

	record(event: TelemetryEvent): void {
		// try/catch で握りつぶす: TelemetryPort.record は fire-and-forget 契約(呼び出し側は
		// await しない)なので、AE 書き込みが同期的に例外を投げても(バインディング未初期化等)
		// tool call 自体を壊してはならない。writeDataPoint 自体は Workers ランタイムでは
		// 例外を投げない実装のはずだが、bun test 環境のフェイク実装やモックが投げるケースも
		// 想定して防御的に囲む(テスト「telemetry 失敗が tool call を壊さない」の対象)。
		try {
			this.dataset.writeDataPoint({
				indexes: [event.mcpTool],
				blobs: [
					event.principal,
					event.host,
					event.errKind ?? "",
					event.requestId,
					event.sessionId ?? "",
					// blob6: colo(2026-07-24 追加)。既存 blob1..blob5 の位置は不変のまま末尾に追記する
					// (過去に書き込まれた AE データポイントの blob1..blob5 の意味を崩さないため)。
					event.colo ?? "",
				],
				doubles: [event.ms, event.ok ? 1 : 0],
			});
		} catch {
			// 意図的に無視(fire-and-forget)。ログにすら出さない — 計測の計測を始めると
			// 再帰的にノイズが増えるだけで、AE 書き込み失敗は console.log 側の構造化ログ
			// (server.ts の計測点)が既に同一イベントを出しているため実害が小さい。
		}
	}
}
