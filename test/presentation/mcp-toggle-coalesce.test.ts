// =============================================================================
// test/presentation/mcp-toggle-coalesce.test.ts — 完了トグル coalesce / 楽観復活の判定(純関数)を固定
//                                                   (> 2026-07-17 実機 FB「done→undo で完了状態が残る」の監査)
// =============================================================================
// 【何を保証するか(What)】実機バグ「done を押してすぐ取り消すと完了状態で残る」の再現条件を、
// todos-entry.ts から抽出した2つの純関数レベルで固定する:
//  (1) coalesceAction: done→undo の間にサーバー確定往復が入っても、最新の望み(undo=未完了)が送った
//      内容(完了)と食い違えば必ず補正(reopen)を追送する(= 完了で握りつぶさない)。
//  (2) shouldReviveToggle: 完了確定で未完了ビューから脱落した id への undo(楽観 reopen)を、sticky から
//      復活させて即座に見せる(= 確定行が無くても desired が勝つ)。削除中は復活させない。
//      【2026-07-23】retired 引数(退場済み判定)は C0-a(約3秒退場機構)撤去に伴い削除した(下記参照)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { coalesceAction, mergeCompletedBase, shouldReviveToggle } from "../../src/presentation/mcp/ui/toggle-coalesce";

/** テスト用の最小 TodoItem 相当(mergeCompletedBase の構造制約を満たす分 + notes/priority)。 */
interface Row {
	id: string;
	completed: boolean;
	status: string | null;
	title: string;
	due: string | null;
	isAllDay: boolean;
	notes: string | null;
	priority: number;
}

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
	test("【バグ修正の核】確定に居ない + sticky あり + 削除中でない → 復活する(undo を即座に見せる)", () => {
		expect(shouldReviveToggle(false, false, true)).toBe(true);
	});

	test("確定一覧に居る → 復活不要(通常 overlay で足りる)", () => {
		expect(shouldReviveToggle(true, false, true)).toBe(false);
	});

	test("楽観削除中(optimisticDeletes)→ 復活させない", () => {
		expect(shouldReviveToggle(false, true, true)).toBe(false);
	});

	test("sticky スナップショットが無い → 土台が無く復活できない(best-effort で見送り)", () => {
		expect(shouldReviveToggle(false, false, false)).toBe(false);
	});
});

describe("mergeCompletedBase(完了 becoming の描画土台 merge・notes 消失バグ修正)", () => {
	// sticky = notes まで揃った last-known full 行(完了前の姿)。
	const sticky: Row = {
		id: "a",
		completed: false,
		status: "NEEDS-ACTION",
		title: "牛乳を買う",
		due: "2026-07-18",
		isAllDay: true,
		notes: "低脂肪のやつ",
		priority: 5,
	};
	// snapshotItem = TaskSnapshot 由来の最小行(notes を持たない=null。priority も 0 に潰れている)。
	const snapshotItem: Row = {
		id: "a",
		completed: true,
		status: "COMPLETED",
		title: "牛乳を買う",
		due: "2026-07-18",
		isAllDay: true,
		notes: null,
		priority: 0,
	};

	test("【バグ修正の核】sticky があれば notes を保持したまま完了状態を重ねる(notes が消えない)", () => {
		const merged = mergeCompletedBase(sticky, snapshotItem);
		expect(merged.notes).toBe("低脂肪のやつ"); // ← 以前は snapshot の notes:null で潰れて消えていた
		expect(merged.priority).toBe(5); // notes 以外の full フィールド(priority 等)も sticky を保つ
		expect(merged.completed).toBe(true); // 完了状態は snapshot 側(権威)を反映
		expect(merged.status).toBe("COMPLETED");
	});

	test("snapshot が権威を持つフィールド(title/due/isAllDay)は snapshot 側を採る", () => {
		// 完了時に title/due が変わっていた場合(反復 D4 等)は snapshot が新しい。
		const changed: Row = { ...snapshotItem, title: "牛乳(2本)", due: "2026-07-19", isAllDay: false };
		const merged = mergeCompletedBase(sticky, changed);
		expect(merged.title).toBe("牛乳(2本)");
		expect(merged.due).toBe("2026-07-19");
		expect(merged.isAllDay).toBe(false);
		expect(merged.notes).toBe("低脂肪のやつ"); // notes は依然 sticky を保持
	});

	test("sticky が無い(初回が mutate 応答だった等)→ snapshotItem をそのまま使う(best-effort)", () => {
		const merged = mergeCompletedBase(undefined, snapshotItem);
		expect(merged).toBe(snapshotItem);
	});
});
