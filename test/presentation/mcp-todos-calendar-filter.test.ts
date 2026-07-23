// =============================================================================
// test/presentation/mcp-todos-calendar-filter.test.ts — K3(2026-07-23): todos カードの
//   「初回に全 VTODO コレクション横断取得 → 切替はクライアント側フィルタ」を支える純関数を固定
// =============================================================================
// 【何を保証するか(What)】
//  (1) mergeTasksByCalendar: 横断応答(calendarId:null)は丸ごと置き換え、単一コレクション応答
//      (calendarId 非 null。mutate 系・明示 calendarId 指定)は「そのコレクション由来の行だけ差し替え、
//      他コレクションの行は保持する」merge-by-calendarId になっていること。calendarId 不明行(旧応答/
//      フィクスチャ由来)を誤って消さないこと。
//  (2) filterTasksByCalendar: calendarId 非 null のとき対象コレクションだけに絞ること。calendarId
//      null(未選択)のときは絞り込まず全件を返す degrade になっていること。calendarId 不明行は
//      除外しない(過剰表示 > 取りこぼし の安全側)こと。
// =============================================================================
import { describe, expect, test } from "bun:test";
import {
	mergeTasksByCalendar,
	filterTasksByCalendar,
	groupTasksByCalendar,
} from "../../src/presentation/mcp/ui/todos-calendar-filter";

interface Item {
	id: string;
	calendarId?: string;
}

describe("mergeTasksByCalendar", () => {
	test("横断応答(incomingCalendarId:null)は prev を無視して丸ごと置き換える", () => {
		const prev: Item[] = [{ id: "a", calendarId: "tasks" }, { id: "b", calendarId: "reading-list" }];
		const next: Item[] = [{ id: "c", calendarId: "tasks" }];
		expect(mergeTasksByCalendar(prev, null, next)).toEqual([{ id: "c", calendarId: "tasks" }]);
	});

	test("単一コレクション応答は、そのコレクション由来の行だけを差し替え、他コレクションの行は保持する", () => {
		const prev: Item[] = [
			{ id: "a", calendarId: "tasks" },
			{ id: "b", calendarId: "reading-list" },
		];
		// "tasks" を新しい2件({id:"a2"} が追加、{id:"a"} は無くなった=完了/削除想定)で差し替える。
		const next: Item[] = [{ id: "a2", calendarId: "tasks" }];
		const merged = mergeTasksByCalendar(prev, "tasks", next);
		// reading-list の行(b)はそのまま残り、tasks は next の内容に完全置換される。
		expect(merged).toEqual([{ id: "b", calendarId: "reading-list" }, { id: "a2", calendarId: "tasks" }]);
	});

	test("prev の calendarId 不明行(旧応答/フィクスチャ由来)は所属不明として保持し続ける(誤って消さない)", () => {
		const prev: Item[] = [{ id: "legacy" }]; // calendarId フィールド自体が無い旧行。
		const next: Item[] = [{ id: "a2", calendarId: "tasks" }];
		const merged = mergeTasksByCalendar(prev, "tasks", next);
		expect(merged.map((t) => t.id).sort()).toEqual(["a2", "legacy"]);
	});

	test("prev が null(初回)でも単一コレクション応答をそのまま返す", () => {
		const next: Item[] = [{ id: "a", calendarId: "tasks" }];
		expect(mergeTasksByCalendar(null, "tasks", next)).toEqual(next);
	});
});

describe("filterTasksByCalendar", () => {
	const items: Item[] = [
		{ id: "a", calendarId: "tasks" },
		{ id: "b", calendarId: "reading-list" },
		{ id: "legacy" }, // calendarId 不明(旧応答由来)。
	];

	test("calendarId 指定時は対象コレクション + calendarId 不明行だけを返す", () => {
		expect(filterTasksByCalendar(items, "tasks").map((t) => t.id).sort()).toEqual(["a", "legacy"]);
	});

	test("別コレクションを指定すればそちら側だけに切り替わる(ネットワーク往復なしのクライアント側フィルタ)", () => {
		expect(filterTasksByCalendar(items, "reading-list").map((t) => t.id).sort()).toEqual(["b", "legacy"]);
	});

	test("calendarId が null(未選択)のときは絞り込まず全件を返す(degrade)", () => {
		expect(filterTasksByCalendar(items, null)).toEqual(items);
	});
});

describe("groupTasksByCalendar(「すべて」表示のコレクションごとグルーピング・2026-07-23是正)", () => {
	test("calendarId ごとにバケツ分けし、各グループ内の順序は入力順のまま保つ(並べ替えない)", () => {
		const items: Item[] = [
			{ id: "a1", calendarId: "tasks" },
			{ id: "r1", calendarId: "reading-list" },
			{ id: "a2", calendarId: "tasks" },
			{ id: "r2", calendarId: "reading-list" },
		];
		const groups = groupTasksByCalendar(items);
		expect(groups.map((g) => g.calendarId)).toEqual(["tasks", "reading-list"]);
		expect(groups.find((g) => g.calendarId === "tasks")?.tasks.map((t) => t.id)).toEqual(["a1", "a2"]);
		expect(groups.find((g) => g.calendarId === "reading-list")?.tasks.map((t) => t.id)).toEqual(["r1", "r2"]);
	});

	test("calendarOrder を渡すとその順でグループが並ぶ(切替メニューの表示順と一致させる)", () => {
		const items: Item[] = [
			{ id: "r1", calendarId: "reading-list" },
			{ id: "a1", calendarId: "tasks" },
		];
		const groups = groupTasksByCalendar(items, ["tasks", "reading-list"]);
		expect(groups.map((g) => g.calendarId)).toEqual(["tasks", "reading-list"]);
	});

	test("calendarOrder に無い calendarId は items の初出順のまま末尾に付く(取りこぼし防止)", () => {
		const items: Item[] = [
			{ id: "u1", calendarId: "unknown-list" },
			{ id: "a1", calendarId: "tasks" },
		];
		const groups = groupTasksByCalendar(items, ["tasks"]);
		expect(groups.map((g) => g.calendarId)).toEqual(["tasks", "unknown-list"]);
	});

	test("calendarId 不明行(旧応答由来)は空文字キーの専用グループにまとめる(消さずに見せる)", () => {
		const items: Item[] = [{ id: "legacy" }, { id: "a1", calendarId: "tasks" }];
		const groups = groupTasksByCalendar(items);
		expect(groups.find((g) => g.calendarId === "")?.tasks.map((t) => t.id)).toEqual(["legacy"]);
	});
});
