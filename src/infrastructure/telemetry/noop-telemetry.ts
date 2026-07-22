// =============================================================================
// NoopTelemetryAdapter — TelemetryPort の何もしない実装(OSS キット配布時の差し替えリファレンス)
// =============================================================================
//
// 【なぜ要るか】
// CLAUDE.md 長期ビジョン2「OSS『CalDAV サーバーキット』」: 永続化・認証はポート&アダプタで
// 差し替え可能にする方針を TelemetryPort にも適用する。Workers Analytics Engine は
// Cloudflare 固有のバインディングなので、他ランタイム/自前ホスティングで動かす利用者は
// AnalyticsEngineTelemetryAdapter を使えない。このアダプタを「何もしないデフォルト」として
// 用意しておくことで、利用者は「TelemetryPort を実装した何か」を必ず用意しなくても動く
// (record() を空にするだけの最小実装を自分で書く手間を省く = キットの seam が動くことの
// 実例にもなる)。
//
// 【bun test での使いどころ】
// env.TELEMETRY(AnalyticsEngineDataset)は wrangler.jsonc の binding だが、bun test の
// 素の env オブジェクト(`as unknown as CloudflareBindings` キャスト)には実体が無いことが
// 多い。app.ts の depsFactory は「env.TELEMETRY があれば AE アダプタ、無ければこの no-op」を
// 選ぶ(app.ts のコメント参照)ので、テストは自然に no-op 経由になり AE 書き込みを一切
// 気にせず既存のツール挙動テストを書ける。
// =============================================================================

import type { TelemetryEvent, TelemetryPort } from "../../application/ports/telemetry";

export class NoopTelemetryAdapter implements TelemetryPort {
	record(_event: TelemetryEvent): void {
		// 意図的に何もしない。
	}
}
