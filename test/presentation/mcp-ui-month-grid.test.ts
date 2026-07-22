// =============================================================================
// presentation/mcp/ui/format の月グリッド純関数テスト(agenda 月ビュー・2026-07-22)
// =============================================================================
// 【何を保証するか(What)】月ビューのグリッド算術が「月またぎ・年またぎ・うるう年」で壊れない
// こと。日付キー列は TZ 非依存の UTC 算術(addDaysToDateKey)で組むので、実行環境の TZ に依らず
// 期待値を絶対値で固定できる(offset ISO を返す localMidnightIso だけは環境依存なのでテスト対象外 —
// format.ts の当該関数コメント参照)。
// 【なぜ独立ファイルか】mcp-format.test.ts は presentation/mcp/format.ts(別モジュール)のテスト。
// ここは ui/format.ts の月グリッド群を対象にするので混ぜない。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { addMonths, monthGridDays, weekdayIndexOf, yearMonthOf } from "../../src/presentation/mcp/ui/format";

describe("addMonths", () => {
	test("同年内の加減", () => {
		expect(addMonths({ year: 2026, month: 7 }, 1)).toEqual({ year: 2026, month: 8 });
		expect(addMonths({ year: 2026, month: 7 }, -1)).toEqual({ year: 2026, month: 6 });
	});
	test("年またぎ(12→翌年1・1→前年12)", () => {
		expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
		expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
	});
	test("複数年ぶんの大きな delta", () => {
		expect(addMonths({ year: 2026, month: 3 }, 25)).toEqual({ year: 2028, month: 4 });
		expect(addMonths({ year: 2026, month: 3 }, -25)).toEqual({ year: 2024, month: 2 });
	});
});

describe("yearMonthOf", () => {
	test("日付キーから年月を取り出す", () => {
		expect(yearMonthOf("2026-07-22")).toEqual({ year: 2026, month: 7 });
		expect(yearMonthOf("2025-12-01")).toEqual({ year: 2025, month: 12 });
	});
});

describe("monthGridDays", () => {
	test("常に 42 セル・日曜始まり", () => {
		const days = monthGridDays({ year: 2026, month: 7 });
		expect(days.length).toBe(42);
		expect(weekdayIndexOf(days[0]!)).toBe(0); // 左上は必ず日曜
		expect(weekdayIndexOf(days[41]!)).toBe(6); // 右下は必ず土曜
	});

	test("2026年7月(1日=水): 6/28(日)始まり・当月全日を含む", () => {
		const days = monthGridDays({ year: 2026, month: 7 });
		// 7/1 は水曜(getDay=3)。前月にはみ出す日曜 = 6/28。
		expect(days[0]).toBe("2026-06-28");
		expect(days).toContain("2026-07-01");
		expect(days).toContain("2026-07-31");
		// 7 月は 31 日・6/28 始まりで leading=3 → 3+31=34 日ぶんが 7 月末まで。残り 42-34=8 日は 8 月頭。
		expect(days).toContain("2026-08-07");
	});

	test("うるう年 2024年2月: 2/29 を含む", () => {
		const days = monthGridDays({ year: 2024, month: 2 });
		expect(days).toContain("2024-02-29");
		// 2/1 は木曜 → 前月はみ出し 1/28(日)始まり。
		expect(days[0]).toBe("2024-01-28");
	});

	test("平年 2025年2月: 2/29 は無い(2/28 まで)", () => {
		const days = monthGridDays({ year: 2025, month: 2 });
		expect(days).not.toContain("2025-02-29");
		expect(days).toContain("2025-02-28");
	});

	test("年またぎ 2025年12月: 12/31 と翌年 1 月頭を跨ぐ", () => {
		const days = monthGridDays({ year: 2025, month: 12 });
		expect(days).toContain("2025-12-31");
		expect(days).toContain("2026-01-01");
	});
});
