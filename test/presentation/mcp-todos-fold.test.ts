// =============================================================================
// test/presentation/mcp-todos-fold.test.ts — inline 畳み判定(todos-fold.ts)の境界値テスト
//                                             (P4-DM C1+C2・swift-mcp-app 側設計 04 §5)
// =============================================================================
// 【何を保証するか(What)】本アプリ(swift-mcp-app)相当(maxHeight 未送信 or 4000 の安全網)で
// 畳みが一切発火しない(不活性が既定)ことと、claude.ai 相当(有限 maxHeight を送るホスト)では
// 実高さが上限を超えたときだけ固定 N 件へ畳むことを、DOM 無しの純関数レベルで固定する。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { FOLD_VISIBLE_COUNT, canRequestFullscreen, decideFoldedVisibleCount } from "../../src/presentation/mcp/ui/todos-fold";

describe("decideFoldedVisibleCount", () => {
	test("maxHeight 未送信(null)は不活性(本アプリの現状=退行ゼロ)", () => {
		expect(
			decideFoldedVisibleCount({
				maxHeightPx: null,
				displayMode: "inline",
				actualHeightPx: 9999,
				totalCount: 20,
				foldToCount: FOLD_VISIBLE_COUNT,
			}),
		).toBeNull();
	});

	test("maxHeight=4000(現行の安全網値)でも実高さがそれ以下なら不活性", () => {
		expect(
			decideFoldedVisibleCount({
				maxHeightPx: 4000,
				displayMode: "inline",
				actualHeightPx: 1200, // todos 9件程度は 4000px を超えない
				totalCount: 9,
				foldToCount: FOLD_VISIBLE_COUNT,
			}),
		).toBeNull();
	});

	test("displayMode が inline でない(fullscreen 等)なら maxHeight を超えていても畳まない", () => {
		expect(
			decideFoldedVisibleCount({
				maxHeightPx: 300,
				displayMode: "fullscreen",
				actualHeightPx: 900,
				totalCount: 20,
				foldToCount: FOLD_VISIBLE_COUNT,
			}),
		).toBeNull();
	});

	test("有限 maxHeight を実高さが超え、totalCount が foldToCount を上回るときだけ固定 N 件に畳む(claude.ai 相当)", () => {
		expect(
			decideFoldedVisibleCount({
				maxHeightPx: 300,
				displayMode: "inline",
				actualHeightPx: 900,
				totalCount: 20,
				foldToCount: FOLD_VISIBLE_COUNT,
			}),
		).toBe(FOLD_VISIBLE_COUNT);
	});

	test("totalCount が foldToCount 以下なら超過していても畳む意味が無いので不活性", () => {
		expect(
			decideFoldedVisibleCount({
				maxHeightPx: 100,
				displayMode: "inline",
				actualHeightPx: 500,
				totalCount: 5, // FOLD_VISIBLE_COUNT(6) 以下
				foldToCount: FOLD_VISIBLE_COUNT,
			}),
		).toBeNull();
	});
});

describe("canRequestFullscreen", () => {
	test("availableDisplayModes 未受信(null)は受動表示のまま(死にボタンを出さない)", () => {
		expect(canRequestFullscreen(null)).toBe(false);
	});

	test("availableDisplayModes に fullscreen が無いホスト(inline のみ広告)は受動表示のまま", () => {
		expect(canRequestFullscreen(["inline"])).toBe(false);
	});

	test("availableDisplayModes に fullscreen があるホストはボタン化してよい", () => {
		expect(canRequestFullscreen(["inline", "fullscreen"])).toBe(true);
	});
});
