// =============================================================================
// test/presentation/mcp-todos-input.test.ts — todos 受信 DTO の nullable 正規化
// =============================================================================
// 【What】カードが描画へ渡す前に、structuredContent.tasks の nullable fields を null へ揃える
// 契約を純粋な helper で固定する。DOM を起動するテストではなく、省略時の再発条件を最小入力で検証する。

import { describe, expect, test } from "bun:test";
import { normalizeTodoTask } from "../../src/presentation/mcp/ui/todos-input";

describe("normalizeTodoTask", () => {
	test("nullable キー省略を null に補い、必須値を補完しない", () => {
		expect(normalizeTodoTask({ id: "no-due", title: "期日なし" })).toEqual({
			id: "no-due",
			title: "期日なし",
			status: null,
			due: null,
			percentComplete: null,
			completedAt: null,
			notes: null,
			sortOrder: null,
			location: null,
			recurrence: null,
			structuredLocation: null,
			proximityAlarm: null,
		});
	});

	test("正常な due 文字列はそのまま維持する", () => {
		expect(normalizeTodoTask({ id: "dated", due: "2026-09-06" }).due).toBe("2026-09-06");
	});

	test("明示的な due:null もそのまま維持する", () => {
		expect(normalizeTodoTask({ id: "explicit-null", due: null }).due).toBeNull();
	});

	test("他の nullable 値は保持し、未設定のものだけ null にする", () => {
		const recurrence = { frequency: "weekly", interval: 1, weekdays: ["MO"], count: null, until: null };
		const task = normalizeTodoTask({ id: "preserved", notes: "メモ", recurrence });
		expect(task).toMatchObject({
			status: null,
			due: null,
			notes: "メモ",
			recurrence,
			structuredLocation: null,
			proximityAlarm: null,
		});
	});
});
