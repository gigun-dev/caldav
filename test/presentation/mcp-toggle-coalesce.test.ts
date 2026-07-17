// =============================================================================
// test/presentation/mcp-toggle-coalesce.test.ts — 完了トグル coalesce / 楽観復活の判定(純関数)を固定
//                                                   (> 2026-07-17 実機 FB「done→undo で完了状態が残る」の監査)
// =============================================================================
// 【何を保証するか(What)】実機バグ「done を押してすぐ取り消すと完了状態で残る」の再現条件を、
// todos-entry.ts から抽出した2つの純関数レベルで固定する:
//  (1) coalesceAction: done→undo の間にサーバー確定往復が入っても、最新の望み(undo=未完了)が送った
//      内容(完了)と食い違えば必ず補正(reopen)を追送する(= 完了で握りつぶさない)。
//  (2) shouldReviveToggle: 完了確定で未完了ビューから脱落した id への undo(楽観 reopen)を、sticky から
//      復活させて即座に見せる(= 確定行が無くても desired が勝つ)。退場済み/削除中は復活させない。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { coalesceAction, shouldReviveToggle } from "../../src/presentation/mcp/ui/toggle-coalesce";

describe("coalesceAction(追送判定・last-write-wins)", () => {
	test("送った状態と最新の望みが一致 → settle(確定)", () => {
		expect(coalesceAction(true, true)).toBe("settle");
		expect(coalesceAction(false, false)).toBe("settle");
	});

	test("【バグ再現の核】完了を送った往復の間に undo(未完了)されていたら → resend(補正 reopen を追送)", () => {
		// done→undo: sent=完了(true) / latest=未完了(false)。ここで settle してしまうと「完了で残る」バグ。
		expect(coalesceAction(true, false)).toBe("resend");
	});

	test("未完了を送った往復の間に再 done(完了)されていたら → resend(補正 complete を追送)", () => {
		expect(coalesceAction(false, true)).toBe("resend");
	});

	test("望みが消えた(undefined=ロールバック等で desiredToggle が空)→ settle(追送対象なし)", () => {
		expect(coalesceAction(true, undefined)).toBe("settle");
		expect(coalesceAction(false, undefined)).toBe("settle");
	});
});

describe("shouldReviveToggle(確定 vm から脱落した行の楽観復活)", () => {
	test("【バグ修正の核】確定に居ない + sticky あり + 退場/削除でない → 復活する(undo を即座に見せる)", () => {
		expect(shouldReviveToggle(false, false, false, true)).toBe(true);
	});

	test("確定一覧に居る → 復活不要(通常 overlay で足りる)", () => {
		expect(shouldReviveToggle(true, false, false, true)).toBe(false);
	});

	test("退場済み(retiredDoneIds)→ 復活させない(幽霊復活防止・冪等性)", () => {
		expect(shouldReviveToggle(false, true, false, true)).toBe(false);
	});

	test("楽観削除中(optimisticDeletes)→ 復活させない", () => {
		expect(shouldReviveToggle(false, false, true, true)).toBe(false);
	});

	test("sticky スナップショットが無い → 土台が無く復活できない(best-effort で見送り)", () => {
		expect(shouldReviveToggle(false, false, false, false)).toBe(false);
	});
});
