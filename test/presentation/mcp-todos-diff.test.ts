// =============================================================================
// test/presentation/mcp-todos-diff.test.ts — completedSummary 計算(純関数)を固定
//                                              (2026-07-23 症状B対策・ユーザー裁定)
// =============================================================================
// 【何を保証するか(What)】
// buildCompletedSummary(todos-diff.ts)が D1/principal に依存しない純関数であることを利用し、
// 症状B(「削除依頼したら完了済み111件が出現した」)対策の骨子を Task フィクスチャだけで固定する:
//  (1) total は completed:true の総数(未完了は数えない)。
//  (2) recent は completedAt 降順(新しい順)で先頭 max 件だけ。
//  (3) 【複合機能テストの核】complete-todo 等 mutate 直後の「今まさに完了した行」は completedAt が
//      最新になるため、必ず recent の先頭(= 直近5件の中)に入る。affected 合成との整合(直近5件に
//      mutate 応答の完了行が確実に入ること)をここで保証する。
// =============================================================================
import { describe, expect, test } from "bun:test";
import type { Task } from "../../src/application/usecases";
import { buildCompletedSummary } from "../../src/presentation/mcp/todos-diff";

/** テスト用の最小 Task フィクスチャ(id/completed/completedAt 以外は固定値で埋める)。 */
function makeTask(id: string, completed: boolean, completedAt: string | null): Task {
	return {
		id,
		title: `task-${id}`,
		completed,
		status: completed ? "COMPLETED" : "NEEDS-ACTION",
		due: null,
		isAllDay: false,
		priority: 0,
		percentComplete: null,
		completedAt,
		notes: null,
		sortOrder: null,
		location: null,
		recurrence: null,
		structuredLocation: null,
		proximityAlarm: null,
	};
}

describe("buildCompletedSummary(完了済みサマリの計算・症状B対策)", () => {
	test("total は completed:true の総数のみ(未完了は数えない)", () => {
		const tasks = [
			makeTask("a", false, null),
			makeTask("b", true, "2026-07-20T10:00:00Z"),
			makeTask("c", true, "2026-07-21T10:00:00Z"),
			makeTask("d", false, null),
		];
		expect(buildCompletedSummary(tasks, 5).total).toBe(2);
	});

	test("recent は completedAt 降順(新しい順)で先頭 max 件だけを返す", () => {
		const tasks = [
			makeTask("old", true, "2026-07-01T00:00:00Z"),
			makeTask("newest", true, "2026-07-22T00:00:00Z"),
			makeTask("middle", true, "2026-07-10T00:00:00Z"),
		];
		const summary = buildCompletedSummary(tasks, 2);
		expect(summary.total).toBe(3); // total は max の絞り込み前(全完了数)
		expect(summary.recent.map((t) => t.id)).toEqual(["newest", "middle"]); // old は max=2 で溢れる
	});

	test("【症状B対策の核】D4 累積で total が大量でも、mutate 直後に完了した最新行は必ず recent 先頭に入る", () => {
		// D4(反復完了スナップショット)が無期限累積した状況を模す: 古い完了済みが111件あっても、
		// たった今 complete-todo で完了させた行(=最新の completedAt)は必ず recent の先頭に来る。
		const pileUp: Task[] = [];
		for (let i = 0; i < 111; i++) {
			pileUp.push(makeTask(`old-${i}`, true, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`));
		}
		const justCompleted = makeTask("just-now", true, "2026-07-22T23:59:59Z");
		const summary = buildCompletedSummary([...pileUp, justCompleted], 5);
		expect(summary.total).toBe(112);
		expect(summary.recent[0]?.id).toBe("just-now"); // 直近5件の先頭に確実に入る
		expect(summary.recent.length).toBe(5); // 表示は5件に有界化される(111件の壁は出ない)
	});

	test("completedAt が同値(まれな同時刻完了)のときは id でタイブレークし結果を決定的にする", () => {
		const tasks = [makeTask("b", true, "2026-07-20T10:00:00Z"), makeTask("a", true, "2026-07-20T10:00:00Z")];
		const summary = buildCompletedSummary(tasks, 5);
		expect(summary.recent.map((t) => t.id)).toEqual(["a", "b"]); // id 昇順でタイブレーク
	});

	test("recent は TaskSnapshot(due/priority が未設定なら省略・isAllDay は常に載る)を返す", () => {
		const t = makeTask("x", true, "2026-07-20T10:00:00Z");
		const summary = buildCompletedSummary([t], 5);
		expect(summary.recent[0]).toEqual({ id: "x", title: "task-x", isAllDay: false });
	});
});
