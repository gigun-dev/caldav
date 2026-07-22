// =============================================================================
// presentation/mcp/ui/day-timeline の重なりレイアウト純関数テスト(agenda 日ビュー・2026-07-22 ③)
// =============================================================================
// 【何を保証するか(What)】日ビューの列分割が iOS 準拠で壊れないこと:
//   - 隣接(終端一致)は非重複 = 同じ列を再利用する(半開区間 [s,e))。
//   - 完全/部分重複は等幅の列へ分割し、colCount は「クラスタ内の同時刻最大重なり数」で統一する。
//   - col < colCount が常に成り立つ(greedy が最適彩色を達成する不変)。
//   - 日跨ぎは [0,1440] へ clamp・0分イベントは最小幅(MIN_BLOCK_MIN)へ広げる。
//   - nowLineTopMin は今日以外で null。
// 【なぜ独立ファイルか】mcp-ui-month-grid.test.ts(format.ts の月グリッド)とは別モジュール(day-timeline.ts)。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { DAY_MIN, MIN_BLOCK_MIN, layoutOverlaps, nowLineTopMin } from "../../src/presentation/mcp/ui/day-timeline";
import { localDateKey } from "../../src/presentation/mcp/ui/format";

/** テスト補助: key で LaidOutBlock を引く。 */
const byKey = (out: ReturnType<typeof layoutOverlaps>, key: string) => out.find((b) => b.key === key)!;

describe("layoutOverlaps", () => {
	test("空配列は空配列", () => {
		expect(layoutOverlaps([])).toEqual([]);
	});

	test("単一ブロックは col=0・colCount=1", () => {
		const out = layoutOverlaps([{ key: "a", startMin: 600, endMin: 660 }]);
		expect(out).toHaveLength(1);
		expect(byKey(out, "a").col).toBe(0);
		expect(byKey(out, "a").colCount).toBe(1);
	});

	test("隣接(終端一致 = 非重複)は同じ列を再利用・別クラスタ(各 colCount=1)", () => {
		// [0-60] と [60-120]: 半開区間なので 60 は重ならない → col は両方 0、colCount は各 1。
		const out = layoutOverlaps([
			{ key: "a", startMin: 0, endMin: 60 },
			{ key: "b", startMin: 60, endMin: 120 },
		]);
		expect(byKey(out, "a").col).toBe(0);
		expect(byKey(out, "b").col).toBe(0);
		expect(byKey(out, "a").colCount).toBe(1);
		expect(byKey(out, "b").colCount).toBe(1);
	});

	test("完全重複 2 件は 2 列・colCount=2", () => {
		const out = layoutOverlaps([
			{ key: "a", startMin: 0, endMin: 60 },
			{ key: "b", startMin: 0, endMin: 60 },
		]);
		expect(new Set([byKey(out, "a").col, byKey(out, "b").col])).toEqual(new Set([0, 1]));
		expect(byKey(out, "a").colCount).toBe(2);
		expect(byKey(out, "b").colCount).toBe(2);
	});

	test("完全重複 3 件は 3 列・colCount=3", () => {
		const out = layoutOverlaps([
			{ key: "a", startMin: 0, endMin: 60 },
			{ key: "b", startMin: 0, endMin: 60 },
			{ key: "c", startMin: 0, endMin: 60 },
		]);
		expect(new Set(out.map((b) => b.col))).toEqual(new Set([0, 1, 2]));
		for (const b of out) expect(b.colCount).toBe(3);
	});

	test("鎖状部分重複: A[0-60] B[30-90] C[60-120] は 1 クラスタ・colCount=2(同時刻最大 2)", () => {
		// A-B 重複、B-C 重複、A-C は 60 で隣接=非重複。同時刻の最大同時本数は 2(3 ではない)。
		const out = layoutOverlaps([
			{ key: "a", startMin: 0, endMin: 60 },
			{ key: "b", startMin: 30, endMin: 90 },
			{ key: "c", startMin: 60, endMin: 120 },
		]);
		for (const b of out) expect(b.colCount).toBe(2); // greedy が使う列数(仮に 2)でなく同時刻最大でも 2
		// C は A の終端で空いた col0 を再利用できる(A-C 非重複)。
		expect(byKey(out, "a").col).toBe(0);
		expect(byKey(out, "b").col).toBe(1);
		expect(byKey(out, "c").col).toBe(0);
	});

	test("col は常に colCount 未満(最適彩色の不変)", () => {
		const out = layoutOverlaps([
			{ key: "a", startMin: 0, endMin: 120 },
			{ key: "b", startMin: 10, endMin: 40 },
			{ key: "c", startMin: 20, endMin: 90 },
			{ key: "d", startMin: 200, endMin: 260 },
		]);
		for (const b of out) expect(b.col).toBeLessThan(b.colCount);
	});

	test("日跨ぎは [0,1440] へ clamp", () => {
		const out = layoutOverlaps([{ key: "a", startMin: -120, endMin: 1560 }]);
		expect(byKey(out, "a").startMin).toBe(0);
		expect(byKey(out, "a").endMin).toBe(DAY_MIN);
	});

	test("0分イベントは最小幅(MIN_BLOCK_MIN)へ広げる", () => {
		const out = layoutOverlaps([{ key: "a", startMin: 600, endMin: 600 }]);
		expect(byKey(out, "a").endMin - byKey(out, "a").startMin).toBe(MIN_BLOCK_MIN);
	});

	test("日末に貼り付いた 0分は start を引き上げて最小幅を確保", () => {
		const out = layoutOverlaps([{ key: "a", startMin: DAY_MIN, endMin: DAY_MIN }]);
		expect(byKey(out, "a").endMin).toBe(DAY_MIN);
		expect(byKey(out, "a").startMin).toBe(DAY_MIN - MIN_BLOCK_MIN);
	});
});

describe("nowLineTopMin", () => {
	test("表示日が今日なら深夜からの経過分を返す", () => {
		const now = new Date(2026, 6, 22, 10, 30, 0); // ローカル 10:30:00
		const todayKey = localDateKey(now);
		expect(nowLineTopMin(now, todayKey)).toBe(630); // 10*60+30
	});

	test("秒は分の小数として残す", () => {
		const now = new Date(2026, 6, 22, 0, 0, 30); // 00:00:30
		expect(nowLineTopMin(now, localDateKey(now))).toBe(0.5);
	});

	test("今日以外は null", () => {
		const now = new Date(2026, 6, 22, 10, 30, 0);
		expect(nowLineTopMin(now, "2026-07-23")).toBeNull();
		expect(nowLineTopMin(now, "2026-07-21")).toBeNull();
	});
});
