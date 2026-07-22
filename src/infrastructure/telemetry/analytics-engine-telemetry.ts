// =============================================================================
// AnalyticsEngineTelemetryAdapter — TelemetryPort の Workers Analytics Engine 実装(観測基盤 v1)
// =============================================================================
//
// 【AE の1データポイント制約(設計の前提)】
// Workers Analytics Engine の writeDataPoint は1呼び出しにつき最大 index1×1 / blobs×20 /
// doubles×20 を書け、かつ**1データポイント全体で 96 バイト以内**という強い制約がある
// (Cloudflare 公式ドキュメント。blobs は文字列を UTF-8 として数える)。TelemetryEvent の
// フィールドをすべて blobs に積むと 96B を軽く超える(requestId/sessionId が UUID だけで
// 各36B)ため、この設計では:
//   - index1: mcpTool 固定(AE のクエリは index1 で GROUP BY/WHERE するのが最速経路 —
//     公式ドキュメントが「高頻度フィルタ列を index1 に」と推奨)。「create-calendar の呼び出し
//     履歴を引く」のような "ツール別に絞る" クエリが主用途になる想定と合致する。
//   - blobs[0..4]: principal, host, errKind, requestId, sessionId(文字列。空/undefined は
//     空文字 "" にして5要素固定にする — AE は blobs のインデックス位置で意味を持たせる設計
//     なので、要素数を可変にすると SQL 側で blob1/blob2... の対応がイベントごとにズレる)。
//   - doubles[0..1]: ms, ok(0/1。AE に真偽型は無いので数値化。SQL 側で `WHERE double2 = 0`
//     が「失敗のみ」フィルタになる)。
// 96B に収まるかは principal/requestId/sessionId の実際の長さ次第で厳密には保証できない
// (crypto.randomUUID() は36文字、principal パスは可変長)。AE は 96B 超のデータポイントを
// **エラーにはせず黙って truncate/破棄する**(公式ドキュメント言及)ため、このアダプタは
// 「書けたら書ける・書けなくても例外にしない」の設計でよい(TelemetryPort.record の
// fire-and-forget 契約どおり)。将来 96B が窮屈になったら requestId を先頭8桁に短縮する等の
// 対応をこのファイル内に閉じて行える(呼び出し側の TelemetryEvent 契約は変えずに済む)。
//
// 【argsDigest / colo を AE に送らない判断】
// argsDigest はキー名の列挙等の構造化データで、blobs の1文字列に押し込めると 96B 制約を
// 即座に食い潰す。かつ AE 側での argsDigest の集計ニーズ(SQL での GROUP BY 対象)は薄い
// (「どんな引数が来たか」の分布分析より「引数漏洩していないか」の監査が主目的で、それは
// console.log の構造化ログ側(TelemetryEvent 全体を JSON で1行出力)で十分)。よって AE には
// 積まず、console.log 側にだけ argsDigest を残す(server.ts の計測点コメント参照)。colo も
// 同じ理由(SQL 側での colo 別集計ニーズが薄く、96B 予算を principal/errKind 等より優先)。
// 両方とも「無くした」のではなく「構造化ログ側に残る」ことに注意(情報の書き分け:
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
				blobs: [event.principal, event.host, event.errKind ?? "", event.requestId, event.sessionId ?? ""],
				doubles: [event.ms, event.ok ? 1 : 0],
			});
		} catch {
			// 意図的に無視(fire-and-forget)。ログにすら出さない — 計測の計測を始めると
			// 再帰的にノイズが増えるだけで、AE 書き込み失敗は console.log 側の構造化ログ
			// (server.ts の計測点)が既に同一イベントを出しているため実害が小さい。
		}
	}
}
