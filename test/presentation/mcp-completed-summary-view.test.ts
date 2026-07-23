// =============================================================================
// test/presentation/mcp-completed-summary-view.test.ts — ① completedSummary の
//   「今表示中のリスト」スコープ絞り込みを固定(2026-07-24)
// =============================================================================
// 【何を保証するか(What)】scopeCompletedSummary(completed-summary-view.ts・純関数)を固定する。
// これは todos カードの renderAll(sec-completed 構築部)が「単一リスト表示ではそのリスト由来だけの
// 完了サマリを見せる/『すべて』表示では owner 全体を見せる/0件ならセクション非表示」を決める唯一の
// 導出。symptom B の治療原則(completedSummary 自体は owner 横断で不変)を壊さず、表示スコープだけを
// カード側で絞れることを固定する。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { scopeCompletedSummary } from "../../src/presentation/mcp/ui/completed-summary-view";
import { ALL_CALENDARS_ID } from "../../src/presentation/mcp/ui/todos-calendar-filter";

const summary = {
	total: 5,
	// recent は owner 横断の直近スナップショット(由来 calendarId 付き)。
	recent: [
		{ id: "r1", calendarId: "reading" },
		{ id: "t1", calendarId: "tasks" },
		{ id: "r2", calendarId: "reading" },
	],
	byCalendar: { reading: 2, tasks: 3 },
};

describe("scopeCompletedSummary(① 表示スコープ絞り込み)", () => {
	test("summary が null(未受領)なら null を返す", () => {
		expect(scopeCompletedSummary(null, "reading")).toBeNull();
	});

	test("単一リスト表示: total は byCalendar[id]・recent はその出身のみへフィルタ", () => {
		const scoped = scopeCompletedSummary(summary, "reading");
		expect(scoped).not.toBeNull();
		expect(scoped!.total).toBe(2); // byCalendar["reading"]
		expect(scoped!.recent.map((r) => r.id)).toEqual(["r1", "r2"]); // tasks 由来の t1 は落ちる
	});

	test("単一リスト表示でそのリストに完了が無ければ total:0(呼び出し側はセクション非表示にする)", () => {
		const scoped = scopeCompletedSummary(summary, "empty-list");
		expect(scoped!.total).toBe(0); // byCalendar に無いキー → 0
		expect(scoped!.recent).toEqual([]); // その出身の行も無い
	});

	test("「すべて」表示(ALL_CALENDARS_ID)は owner 全体をそのまま返す", () => {
		const scoped = scopeCompletedSummary(summary, ALL_CALENDARS_ID);
		expect(scoped!.total).toBe(5);
		expect(scoped!.recent.map((r) => r.id)).toEqual(["r1", "t1", "r2"]);
	});

	test("未選択(null)も owner 全体をそのまま返す", () => {
		const scoped = scopeCompletedSummary(summary, null);
		expect(scoped!.total).toBe(5);
		expect(scoped!.recent).toHaveLength(3);
	});

	test("byCalendar 欠落の旧応答は単一リスト表示で total:0 に degrade(壊れない)", () => {
		const legacy = { total: 3, recent: [{ id: "x", calendarId: "tasks" }] };
		const scoped = scopeCompletedSummary(legacy, "tasks");
		expect(scoped!.total).toBe(0); // byCalendar?.[id] ?? 0
	});

	test("『すべて』表示は元の recent 配列参照を返さない(呼び出し側の破壊的操作から元 state を守る)", () => {
		const scoped = scopeCompletedSummary(summary, ALL_CALENDARS_ID);
		expect(scoped!.recent).not.toBe(summary.recent);
	});
});
