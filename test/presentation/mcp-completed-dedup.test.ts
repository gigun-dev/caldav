// =============================================================================
// test/presentation/mcp-completed-dedup.test.ts — completedSummary 重複排除の所属判定を固定
// =============================================================================
// 【何を保証するか(What)】completed-dedup.ts の completedRowIsInBody(純関数)を固定する。
// この関数は todos-entry.ts の renderAll(sec-completed 構築部)が「completedSummary.recent の
// この行を出すか、本体側(due セクション)に居るので隠すか」を決める唯一の判定。
//
// 【前身との関係(2026-07-23 (d′) 裁定・C0-a′ 撤回)】以前は mcp-done-exit.test.ts が退場タイマー
// (isDoneRowStillInPlace / shouldScheduleDoneExit)を固定していたが、完了行の3秒退場(C0-a′)を
// docs/modeling/12 §7.8 v2.2 item 3 に反する再導入として撤回した。重複排除は「退場タイマーが生きて
// いるか」ではなく「positionMemory でこの id は本体セクションに所属しているか」という時間非依存の
// 所属判定へ置換したので、テストもその新契約へ書き換えた(旧テストは撤去)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { completedRowIsInBody } from "../../src/presentation/mcp/ui/completed-dedup";

describe("completedRowIsInBody(completedSummary の重複排除・所属判定)", () => {
	test("positionMemory に無い(undefined)→ false(本体に居ない・completedSummary が唯一の表示チャンネル)", () => {
		// クリーン再セクショニング後(resetPositionMemory で positionMemory がクリアされた)や、
		// 一度も本体に現れていない完了行はここに来る。completedSummary 側だけに現れる = 完了済みへ移動。
		expect(completedRowIsInBody(undefined)).toBe(false);
	});

	test('section が "completed"(born-completed)→ false(completed バケツは描画に使わない死の経路)', () => {
		// インスタンス誕生時に既に完了だった行(§7.8 v2.2 item 3 ⑥ の completed <details> の受け皿)。
		// 本体側の completed バケツは renderAll がもう描画に使わないので、completedSummary が表示チャンネル。
		expect(completedRowIsInBody("completed")).toBe(false);
	});

	test("due セクション(このインスタンス生存中に done してその場に残る行)→ true(本体に見えるので隠す)", () => {
		// 本体側(取消線付き)に残っているので completedSummary 側の同 id 行は二重表示になる → 隠す。
		expect(completedRowIsInBody("overdue")).toBe(true);
		expect(completedRowIsInBody("today")).toBe(true);
		expect(completedRowIsInBody("upcoming")).toBe(true);
		expect(completedRowIsInBody("noDue")).toBe(true);
	});
});
