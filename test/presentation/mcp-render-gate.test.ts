// =============================================================================
// test/presentation/mcp-render-gate.test.ts — シート表示中の破壊的 renderAll() 抑止判定の固定
// =============================================================================
// 【何を保証するか(What)】render-gate.ts の shouldSkipDestructiveRender(純関数)を固定する:
//   - sheetState が null(シート閉)なら抑止しない(通常どおり renderAll してよい)。
//   - sheetState が非 null(シート表示中。todos/agenda で型が違うので unknown で受ける)なら抑止する。
// この純関数は「iOS fullscreen で入力にフォーカス中に renderAll が DOM を全消しし、フォーカス要素が
// 消えてキーボードが閉じる」実機バグ(2026-07-23)の根治策の判定式そのもの。todos-entry.ts /
// agenda-entry.ts 側の guardedRenderAll/setSheetState は DOM/module state に依存するためここでは
// 固定できない(この2ファイル固有の薄い配線コードとして両ファイルへ個別実装した)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { shouldSkipDestructiveRender } from "../../src/presentation/mcp/ui/render-gate";

describe("shouldSkipDestructiveRender", () => {
	test("sheetState が null(シート閉)なら抑止しない", () => {
		expect(shouldSkipDestructiveRender(null)).toBe(false);
	});

	test("sheetState が非 null(agenda 型: key/page)なら抑止する", () => {
		expect(shouldSkipDestructiveRender({ key: "abc", page: "detail" })).toBe(true);
	});

	test("sheetState が非 null(todos 型: id/page)なら抑止する", () => {
		expect(shouldSkipDestructiveRender({ id: "abc", page: "detail" })).toBe(true);
	});

	test("create:true のシートも抑止対象(型の違いに関わらず null かどうかだけを見る)", () => {
		expect(shouldSkipDestructiveRender({ id: "draft:1", page: "detail", create: true })).toBe(true);
	});
});
