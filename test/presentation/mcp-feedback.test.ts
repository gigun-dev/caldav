// =============================================================================
// test/presentation/mcp-feedback.test.ts — 操作フィードバック統一ドクトリン v2 の
//                                          共有カーネル(feedback.ts)の境界値テスト
//                                          (docs/modeling/12 §7.8)
// =============================================================================
// 【何を保証するか(What)】isCommitting の寿命境界(cycleMs × animCycles = 1200ms)が
// 半開区間 [startedAt, startedAt+1200) であること。境界ちょうど(+1200ms)で committing が
// 終わり静的表現へ収束する、という §7.8 の「満了で即座に収束」を数値で固定する。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { FEEDBACK, isCommitting } from "../../src/presentation/mcp/ui/feedback";

describe("isCommitting", () => {
	const startedAt = 1_000;

	test("経過 0ms(直後)は committing", () => {
		expect(isCommitting(startedAt, startedAt)).toBe(true);
	});

	test("経過 1199ms(寿命の1ms手前)は committing のまま", () => {
		expect(isCommitting(startedAt + 1199, startedAt)).toBe(true);
	});

	test("経過 1200ms(寿命ちょうど)は committing ではない(満了・収束済み)", () => {
		expect(isCommitting(startedAt + 1200, startedAt)).toBe(false);
	});

	test("経過 1201ms(寿命超過)も committing ではない", () => {
		expect(isCommitting(startedAt + 1201, startedAt)).toBe(false);
	});

	test("定数は §7.8 確定値どおり(cycleMs=1200 / animCycles=1 / hardTimeoutMs=10000)", () => {
		expect(FEEDBACK.cycleMs).toBe(1200);
		expect(FEEDBACK.animCycles).toBe(1);
		expect(FEEDBACK.hardTimeoutMs).toBe(10_000);
	});
});
