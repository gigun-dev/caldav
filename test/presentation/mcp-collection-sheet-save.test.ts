// =============================================================================
// test/presentation/mcp-collection-sheet-save.test.ts
//   — コレクション詳細ページ「保存」の update-calendar 呼び出し判定を固定する
// =============================================================================
// 【何を保証するか(What)】collection-sheet-save.ts の buildCollectionSheetUpdateArgs(純関数)を
// 固定する:
//   - displayName/color のどちらも変わっていなければ null(=update-calendar を呼ばない no-op)。
//   - どちらか一方でも変わっていれば、draft の値で update-calendar 引数を返す。
//   - color の比較は大文字小文字を無視する(#RRGGBB の表記揺れで誤検知しない)。
// 【回帰させたいバグ】保存ボタンが update-calendar の callServerTool を一切発行しない不具合
// (本体原因は listMenuEl/menuOutsideEl の消し忘れによるクリック横取りだったが、合わせて
// 「差分が無いのに毎回送る」無駄な副作用も本タスクで削った — todos-entry.ts saveCollectionSheet
// の update-calendar 分岐コメント参照)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { buildCollectionSheetUpdateArgs } from "../../src/presentation/mcp/ui/collection-sheet-save";

describe("buildCollectionSheetUpdateArgs", () => {
	test("displayName/color どちらも未変更なら null(no-op)", () => {
		const current = { displayName: "買い物", color: "#FF3B30" };
		const draft = { displayName: "買い物", color: "#FF3B30" };
		expect(buildCollectionSheetUpdateArgs(current, draft)).toBeNull();
	});

	test("color の大文字小文字だけが違う場合も未変更扱い(null)", () => {
		const current = { displayName: "買い物", color: "#ff3b30" };
		const draft = { displayName: "買い物", color: "#FF3B30" };
		expect(buildCollectionSheetUpdateArgs(current, draft)).toBeNull();
	});

	test("displayName だけ変更されていれば draft の値で引数を返す", () => {
		const current = { displayName: "買い物", color: "#FF3B30" };
		const draft = { displayName: "買い物リスト", color: "#FF3B30" };
		expect(buildCollectionSheetUpdateArgs(current, draft)).toEqual({
			displayName: "買い物リスト",
			color: "#FF3B30",
		});
	});

	test("color だけ変更されていれば draft の値で引数を返す", () => {
		const current = { displayName: "買い物", color: "#FF3B30" };
		const draft = { displayName: "買い物", color: "#34C759" };
		expect(buildCollectionSheetUpdateArgs(current, draft)).toEqual({
			displayName: "買い物",
			color: "#34C759",
		});
	});

	test("両方変更されていれば draft の値で引数を返す", () => {
		const current = { displayName: "買い物", color: "#FF3B30" };
		const draft = { displayName: "日用品", color: "#34C759" };
		expect(buildCollectionSheetUpdateArgs(current, draft)).toEqual({
			displayName: "日用品",
			color: "#34C759",
		});
	});
});
