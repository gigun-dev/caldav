// =============================================================================
// AnalyticsEngineCardTelemetryAdapter — CardTelemetryPort の Workers Analytics Engine 実装(#52)
// =============================================================================
//
// 【AE の1データポイント制約(analytics-engine-telemetry.ts と同じ前提)】
// writeDataPoint は1呼び出しにつき index1×1 / blobs×20(最大)/ doubles×20(最大)、かつ
// **1データポイント全体で 96 バイト以内**という強い制約がある(Cloudflare 公式ドキュメント)。
// CardTelemetryEvent は kind によって持つフィールドが違う判別共用体なので、AE 側では
// 「kind 別に意味を変える固定スロット」に写像する(スロット数を可変にすると kind ごとに
// blob/double の対応がズレて SQL 側が事故る — analytics-engine-telemetry.ts と同じ理由)。
//
// 【マッピング表(1イベント=1データポイント)】
//   - index1: kind("error" / "focus-probe" / "safe-area")。「特定 kind だけ集計する」クエリが
//     主用途になる想定(3種の性質がまったく違うため、まず kind で絞ってから見るのが自然)。
//   - blobs[0..5]: [cardType, uiHash(8桁), instanceId(8桁), host, detail1, detail2]。
//     detail1/detail2 は kind 別に意味が変わる(空文字 "" は「この kind では使わない」):
//       - error       : detail1=name(Error クラス名) / detail2=frame(コード座標。無ければ "")
//       - focus-probe : detail1=phase("before"/"after") / detail2=activeElementId(無ければ "")
//       - safe-area   : detail1="" / detail2=""(safe-area は数値のみで detail は使わない)
//   - doubles: [dt, kind別数値…]。kind ごとに要素数が変わる(AE は doubles の要素数固定を
//     要求しない。blobs と違い「位置の意味」は index1=kind で既に一意に定まっているので、
//     kind をまたいで同じ位置を比較する SQL クエリは書かれない前提で可変長のままにする):
//       - error       : [dt, count]
//       - focus-probe : [dt, sheetInputConnected(0/1), sheetInputActive(0/1)]
//       - safe-area   : [dt, top, right, bottom, left]
//     fallbackTopApplied/fallbackBottomApplied は AE には積まず、詳細な監査は console.log 側の
//     構造化ログ(server.ts の report-card-telemetry handler)に残す(analytics-engine-telemetry.ts
//     の「argsDigest / colo を AE に送らない判断」と同じ役割分担 — AE は高頻度・低カーディナリティの
//     定量集計、構造化ログは詳細な1件監査)。
//
// 【sessionId / receivedAt を AE に積まない判断】cardType/uiHash/instanceId/host だけで
// 「どのカードのどのインスタンスで何が起きたか」の分析には十分足りる。sessionId は
// TelemetryEvent 側(通常のツール呼び出し計測)で既に相関を取れるため重複させず、receivedAt は
// AE がデータポイントに自動でタイムスタンプを付与する(Cloudflare 公式ドキュメント)ため不要。
// 96B 予算をより分析価値の高いフィールド(uiHash/instanceId 等)に割り当てる判断は
// analytics-engine-telemetry.ts の「argsDigest / colo を送らない判断」と同型。
// =============================================================================

import type { CardTelemetryEvent, CardTelemetryPort } from "../../application/ports/card-telemetry";

export class AnalyticsEngineCardTelemetryAdapter implements CardTelemetryPort {
	constructor(private readonly dataset: AnalyticsEngineDataset) {}

	record(event: CardTelemetryEvent): void {
		// try/catch で握りつぶす: CardTelemetryPort.record は fire-and-forget 契約(呼び出し側は
		// await しない)。AE 書き込みが同期的に例外を投げても(バインディング未初期化等)
		// カード操作自体を壊してはならない(analytics-engine-telemetry.ts と同じ理由。
		// bun test 環境のフェイク実装が投げるケースの防御も兼ねる)。
		try {
			// detail1/detail2/doubles は kind ごとに埋める位置と意味が違う(冒頭マッピング表参照)。
			// switch で kind を narrow してから組み立てることで、TypeScript の判別共用体の絞り込みを
			// そのまま活かし、存在しないフィールドへの誤アクセスをコンパイル時に防ぐ。
			let detail1 = "";
			let detail2 = "";
			let doubles: number[] = [event.dt];
			switch (event.kind) {
				case "error":
					detail1 = event.name;
					detail2 = event.frame ?? "";
					doubles = [event.dt, event.count];
					break;
				case "focus-probe":
					detail1 = event.phase;
					detail2 = event.activeElementId ?? "";
					doubles = [event.dt, event.sheetInputConnected ? 1 : 0, event.sheetInputActive ? 1 : 0];
					break;
				case "safe-area":
					doubles = [event.dt, event.top, event.right, event.bottom, event.left];
					break;
			}
			this.dataset.writeDataPoint({
				indexes: [event.kind],
				blobs: [event.cardType, event.uiHash, event.instanceId, event.host, detail1, detail2],
				doubles,
			});
		} catch {
			// 意図的に無視(fire-and-forget)。同一イベントは console.log 側の構造化ログ
			// (server.ts の report-card-telemetry handler)に既に出ているため実害は小さい
			// (analytics-engine-telemetry.ts の同種コメントと同じ判断)。
		}
	}
}
