// =============================================================================
// presentation/mcp/ui/events-diff-client のテスト(S-A・modeling/12 §7.3)
// =============================================================================
// 2026-07-16 実機FB: 単発イベントを平日 RRULE 化すると展開 occurrence(同一 id 複数行)が
// added/removed のノイズとして噴き出した(旧実装が Map で同一 id を最後の1件に潰していた)。
// ここでは §7.3 の確定規約「diff は id(系列)単位」を What として固定する:
//   - 同一 id の occurrence が何行増減しても added/removed は出ない(既存 id は edited 候補のみ)。
//   - id の消滅 = removed 1件(代表 occurrence のスナップショット)。
//   - id の新規出現 = added 1件。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { computeSyncDiff, type DiffEvent } from "../../src/presentation/mcp/ui/events-diff-client";
import { rowKey, idOfRowKey, groupById } from "../../src/presentation/mcp/ui/row-key";

/** テスト用 DiffEvent を最小の手数で作る(差分に関係ないフィールドは既定値)。 */
function ev(id: string, start: string, overrides: Partial<DiffEvent> = {}): DiffEvent {
	return {
		id,
		title: "t",
		start,
		end: null,
		isAllDay: !start.includes("T"),
		location: null,
		url: null,
		notes: null,
		recurrence: null,
		alarms: [],
		travelMinutes: null,
		...overrides,
	};
}

const noExplained = new Set<string>();

describe("computeSyncDiff — id(系列)単位グルーピング(§7.3)", () => {
	test("単発 → RRULE 展開(同一 id が1行→4行)でも added/removed は出ない", () => {
		// 実機FB の再現形: マスター1件が平日 RRULE で4 occurrence に展開された。
		const rec = { frequency: "weekly", weekdays: ["MO", "TU", "WE", "TH", "FR"] };
		const prev = [ev("uid-1", "2026-07-16T10:00:00+09:00")];
		const next = [
			ev("uid-1", "2026-07-16T10:00:00+09:00", { recurrence: rec }),
			ev("uid-1", "2026-07-17T10:00:00+09:00", { recurrence: rec }),
			ev("uid-1", "2026-07-20T10:00:00+09:00", { recurrence: rec }),
			ev("uid-1", "2026-07-21T10:00:00+09:00", { recurrence: rec }),
		];
		const diff = computeSyncDiff(prev, next, noExplained);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		// 既存 id は edited 候補(recurrence 変化)。消費側が捨てる規約は不変(entry 側コメント参照)。
		expect(diff.edited.map((e) => e.id)).toEqual(["uid-1"]);
	});

	test("逆方向(RRULE 解除で4行→1行)でも removed は出ない", () => {
		const rec = { frequency: "weekly", weekdays: ["MO"] };
		const prev = [
			ev("uid-1", "2026-07-16T10:00:00+09:00", { recurrence: rec }),
			ev("uid-1", "2026-07-23T10:00:00+09:00", { recurrence: rec }),
		];
		const next = [ev("uid-1", "2026-07-16T10:00:00+09:00")];
		const diff = computeSyncDiff(prev, next, noExplained);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	test("id の消滅(系列ごと外部削除)= removed 1件(代表 occurrence のスナップショット)", () => {
		const prev = [
			ev("uid-gone", "2026-07-16T10:00:00+09:00", { title: "消える系列" }),
			ev("uid-gone", "2026-07-17T10:00:00+09:00", { title: "消える系列" }),
			ev("uid-stay", "2026-07-18"),
		];
		const next = [ev("uid-stay", "2026-07-18")];
		const diff = computeSyncDiff(prev, next, noExplained);
		expect(diff.removed).toHaveLength(1);
		expect(diff.removed[0]?.id).toBe("uid-gone");
		expect(diff.removed[0]?.title).toBe("消える系列");
		// 代表 = 先頭 occurrence の日時が短文で載る。
		expect(diff.removed[0]?.start).toBe("2026-07-16 10:00");
	});

	test("新規 id(反復イベントの外部追加で複数 occurrence)= added 1件", () => {
		const prev = [ev("uid-stay", "2026-07-18")];
		const next = [
			ev("uid-stay", "2026-07-18"),
			ev("uid-new", "2026-07-16T09:00:00+09:00"),
			ev("uid-new", "2026-07-17T09:00:00+09:00"),
			ev("uid-new", "2026-07-18T09:00:00+09:00"),
		];
		const diff = computeSyncDiff(prev, next, noExplained);
		expect(diff.added).toEqual(["uid-new"]);
		expect(diff.removed).toEqual([]);
	});

	test("explainedIds(affected/removed/pending 済み)は added/edited/removed から除外される", () => {
		const prev = [ev("uid-a", "2026-07-16"), ev("uid-b", "2026-07-17")];
		const next = [ev("uid-a", "2026-07-16", { title: "changed" }), ev("uid-c", "2026-07-18")];
		const diff = computeSyncDiff(prev, next, new Set(["uid-a", "uid-b", "uid-c"]));
		expect(diff).toEqual({ added: [], edited: [], removed: [] });
	});
});

describe("row-key — 行同一性の合成キー(§7.1)", () => {
	test("rowKey は id + NUL + recurrenceId(null/未指定は空)", () => {
		expect(rowKey({ id: "uid-1", recurrenceId: "20260716T100000" })).toBe("uid-1\u000020260716T100000");
		expect(rowKey({ id: "uid-1", recurrenceId: null })).toBe("uid-1\u0000");
		// todos 側は recurrenceId を持たない行のまま同関数を使える(§4 共有カーネル方針)。
		expect(rowKey({ id: "todo-1" })).toBe("todo-1\u0000");
	});

	test("同一 id でも occurrence が違えばキーは衝突しない(実機FB バグの核心)", () => {
		const a = rowKey({ id: "uid-1", recurrenceId: "20260716T100000" });
		const b = rowKey({ id: "uid-1", recurrenceId: "20260717T100000" });
		expect(a).not.toBe(b);
		// mutate 層(マスター id 単位)へ戻すときは idOfRowKey で id を取り出す。
		expect(idOfRowKey(a)).toBe("uid-1");
		expect(idOfRowKey(b)).toBe("uid-1");
	});

	test("idOfRowKey は rowKey を通っていない生 id もそのまま返す(draft 行の防御)", () => {
		expect(idOfRowKey("draft:abc")).toBe("draft:abc");
	});

	test("groupById は同一 id を潰さず出現順の配列で保持する", () => {
		const rows = [
			{ id: "a", n: 1 },
			{ id: "b", n: 2 },
			{ id: "a", n: 3 },
		];
		const map = groupById(rows);
		expect(map.get("a")?.map((r) => r.n)).toEqual([1, 3]);
		expect(map.get("b")?.map((r) => r.n)).toEqual([2]);
	});
});
