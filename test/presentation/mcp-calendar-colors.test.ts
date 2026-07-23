// =============================================================================
// presentation/mcp/ui/calendar-colors のテスト(2026-07-22 agenda カード色ドット)
// =============================================================================
// What(このテストが固定する仕様):
//   ①決定性 — 同じ calendarId は常に同じ色(refetch/再描画を跨いだ凡例の一貫性の根拠)。
//   ②色域 — 返す色は必ず CALENDAR_PALETTE の要素(未定義色や undefined を返さない)。
//   ③分布 — 多数の異なる id を投げたとき全パレット色がまんべんなく使われる(ハッシュが1色に
//     偏っていない = 凡例として塗り分けられる)。
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
	CALENDAR_PALETTE,
	colorForCalendarId,
	resolveCalendarColor,
} from "../../src/presentation/mcp/ui/calendar-colors";

describe("colorForCalendarId", () => {
	test("同じ id からは常に同じ色を返す(決定性)", () => {
		expect(colorForCalendarId("calendar")).toBe(colorForCalendarId("calendar"));
		expect(colorForCalendarId("work")).toBe(colorForCalendarId("work"));
	});

	test("返す色は必ずパレット内の色", () => {
		for (const id of ["calendar", "work", "tasks", "reading-list", "personal", "家族", ""]) {
			expect(CALENDAR_PALETTE).toContain(colorForCalendarId(id));
		}
	});

	test("多数の異なる id を投げると全パレット色が使われる(分布に偏りが無い)", () => {
		// 200 個の合成 id を割り当て、出現した色の種類がパレット全色(8色)を網羅することを確認する。
		// 完全一意は保証しない設計(id ハッシュ % 8)だが、十分な件数を投げれば全色が現れるはず。
		const used = new Set<string>();
		for (let i = 0; i < 200; i++) used.add(colorForCalendarId(`cal-${i}`));
		expect(used.size).toBe(CALENDAR_PALETTE.length);
	});
});

// 2026-07-23 K2-UI①: 実色(AppleColor)→ 無ければハッシュパレットへフォールバックする合成規則。
describe("resolveCalendarColor", () => {
	test("実色が指定されていればそれをそのまま返す(パレット色に丸めない)", () => {
		expect(resolveCalendarColor("#112233", "work")).toBe("#112233");
	});

	test("8桁(アルファ付き)実色もそのまま透過する", () => {
		expect(resolveCalendarColor("#11223344", "work")).toBe("#11223344");
	});

	test("実色が undefined ならパレットのフォールバック色(colorForCalendarId と一致)を返す", () => {
		expect(resolveCalendarColor(undefined, "work")).toBe(colorForCalendarId("work"));
	});

	test("実色が空文字列なら未設定扱いでフォールバックする(誤った透明色描画を避ける安全側判定)", () => {
		expect(resolveCalendarColor("", "work")).toBe(colorForCalendarId("work"));
	});
});
