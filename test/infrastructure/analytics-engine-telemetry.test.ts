// =============================================================================
// AnalyticsEngineTelemetryAdapter のユニットテスト(観測基盤 v1)
// =============================================================================
// 何を保証するか:
//   - TelemetryEvent → AnalyticsEngineDataPoint(index1/blobs/doubles)のフィールドマッピングが
//     analytics-engine-telemetry.ts 冒頭コメントに書いた契約どおりであること。
//   - dataset.writeDataPoint が例外を投げても record() 自体は例外を外へ漏らさないこと
//     (TelemetryPort.record の fire-and-forget 契約 = 「計測失敗が tool call を壊さない」)。
// =============================================================================

import { describe, expect, it } from "bun:test";
import { AnalyticsEngineTelemetryAdapter } from "../../src/infrastructure/telemetry/analytics-engine-telemetry";
import type { TelemetryEvent } from "../../src/application/ports/telemetry";

// writeDataPoint 呼び出しをフェイクで固定する(実 AE バインディングは bun test に存在しない)。
class FakeAnalyticsEngineDataset {
	readonly calls: AnalyticsEngineDataPoint[] = [];
	writeDataPoint(event?: AnalyticsEngineDataPoint): void {
		if (event !== undefined) this.calls.push(event);
	}
}

class ThrowingAnalyticsEngineDataset {
	writeDataPoint(): void {
		throw new Error("AE binding not initialized (simulated)");
	}
}

const BASE_EVENT: TelemetryEvent = {
	requestId: "11111111-1111-4111-8111-111111111111",
	principal: "/dav/principals/admin/",
	host: "claude.ai",
	mcpTool: "create-calendar",
	ok: true,
	ms: 42,
	colo: "NRT",
};

describe("AnalyticsEngineTelemetryAdapter", () => {
	it("mcpTool を index1 に写す(AE の高頻度フィルタ列)", () => {
		const dataset = new FakeAnalyticsEngineDataset();
		new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset).record(BASE_EVENT);
		expect(dataset.calls[0].indexes).toEqual(["create-calendar"]);
	});

	it("blobs を [principal, host, errKind, requestId, sessionId] の固定順で積み、未指定は空文字にする", () => {
		const dataset = new FakeAnalyticsEngineDataset();
		new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset).record(BASE_EVENT);
		expect(dataset.calls[0].blobs).toEqual([
			"/dav/principals/admin/",
			"claude.ai",
			"",
			"11111111-1111-4111-8111-111111111111",
			"",
		]);
	});

	it("errKind/sessionId が指定されたイベントはそれぞれの blob 位置に載る", () => {
		const dataset = new FakeAnalyticsEngineDataset();
		new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset).record({
			...BASE_EVENT,
			ok: false,
			errKind: "CollectionAlreadyExistsError",
			sessionId: "session-xyz",
		});
		expect(dataset.calls[0].blobs).toEqual([
			"/dav/principals/admin/",
			"claude.ai",
			"CollectionAlreadyExistsError",
			"11111111-1111-4111-8111-111111111111",
			"session-xyz",
		]);
	});

	it("doubles を [ms, ok(0/1)] に写す", () => {
		const dataset = new FakeAnalyticsEngineDataset();
		new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset).record({ ...BASE_EVENT, ok: false, ms: 999 });
		expect(dataset.calls[0].doubles).toEqual([999, 0]);
	});

	it("argsDigest / colo は AE データポイントに含めない(96B 予算を principal/errKind 等へ優先する設計)", () => {
		const dataset = new FakeAnalyticsEngineDataset();
		new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset).record({
			...BASE_EVENT,
			argsDigest: { calendarId: "tasks" },
		});
		const point = dataset.calls[0];
		expect(JSON.stringify(point)).not.toContain("tasks");
		expect(JSON.stringify(point)).not.toContain("NRT");
	});

	it("writeDataPoint が例外を投げても record() 自体は例外を外へ漏らさない(fire-and-forget 契約)", () => {
		const dataset = new ThrowingAnalyticsEngineDataset();
		const adapter = new AnalyticsEngineTelemetryAdapter(dataset as unknown as AnalyticsEngineDataset);
		expect(() => adapter.record(BASE_EVENT)).not.toThrow();
	});
});
