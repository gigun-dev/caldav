// =============================================================================
// NoopCardTelemetryAdapter — CardTelemetryPort の何もしない実装(#52)
// =============================================================================
//
// 【なぜ要るか】noop-telemetry.ts(TelemetryPort の no-op)と同じ理由: OSS「CalDAV サーバー
// キット」方針(CLAUDE.md 長期ビジョン2)で、Workers Analytics Engine バインディングを持たない
// 利用者(自前ホスティング等)でも CardTelemetryPort を実装した何かを必ず用意しなくても動くように
// する。composition root(app.ts)は env.CARD_TELEMETRY(wrangler.jsonc の binding)が無ければ
// このアダプタへフォールバックする(env.TELEMETRY の判定と同じ形。app.ts のコメント参照)。
//
// 【bun test での使いどころ】noop-telemetry.ts と同じく、bun test の素の env には AE バインディングの
// 実体が無いため、テストは自然にこの no-op 経由になる(report-card-telemetry の zod/振る舞いテストは
// AE 書き込みを一切気にせず書ける)。
// =============================================================================

import type { CardTelemetryEvent, CardTelemetryPort } from "../../application/ports/card-telemetry";

export class NoopCardTelemetryAdapter implements CardTelemetryPort {
	record(_event: CardTelemetryEvent): void {
		// 意図的に何もしない。
	}
}
