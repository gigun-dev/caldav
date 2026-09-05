// =============================================================================
// test/presentation/mcp-todos-input.test.ts — todos 受信 DTO の nullable 正規化
// =============================================================================
// 【What】カードが描画へ渡す前に、structuredContent.tasks の due を「文字列 | null」へ揃える契約を
// 純粋な helper で固定する。DOM を起動するテストではなく、due 省略時の再発条件を最小入力で検証する。

import { describe, expect, test } from "bun:test";
import { normalizeTodoDue } from "../../src/presentation/mcp/ui/todos-input";

describe("normalizeTodoDue", () => {
	test("due キー省略を null に補い、描画へ undefined を流さない", () => {
		expect(normalizeTodoDue({ id: "no-due", title: "期日なし" })).toEqual({
			id: "no-due",
			title: "期日なし",
			due: null,
		});
	});

	test("正常な due 文字列はそのまま維持する", () => {
		expect(normalizeTodoDue({ id: "dated", due: "2026-09-06" })).toEqual({
			id: "dated",
			due: "2026-09-06",
		});
	});

	test("明示的な due:null もそのまま維持する", () => {
		expect(normalizeTodoDue({ id: "explicit-null", due: null })).toEqual({
			id: "explicit-null",
			due: null,
		});
	});
});
