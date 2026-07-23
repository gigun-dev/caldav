// =============================================================================
// test/presentation/mcp-trash-view.test.ts — ② ゴミ箱行の構築純関数を固定(2026-07-24)
// =============================================================================
// 【何を保証するか(What)】trash-view.ts の buildTrashRows / formatDeletedRelative(純関数)を固定する。
// これは todos カードのゴミ箱ページ(buildTrashPage)が各行を描くのに使う表示整形 — 相対削除時刻・
// 無題フォールバック・新しい順ソート。DOM/ネットワークに依存しないのでフィクスチャだけで固定できる。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { buildTrashRows, formatDeletedRelative } from "../../src/presentation/mcp/ui/trash-view";

const NOW = Date.parse("2026-07-24T12:00:00Z");

describe("formatDeletedRelative(削除時刻の相対表記)", () => {
	test("1分未満は『たった今』", () => {
		expect(formatDeletedRelative(NOW - 30_000, NOW)).toBe("たった今");
	});
	test("分・時間・日の段階", () => {
		expect(formatDeletedRelative(NOW - 5 * 60_000, NOW)).toBe("5分前");
		expect(formatDeletedRelative(NOW - 3 * 3_600_000, NOW)).toBe("3時間前");
		expect(formatDeletedRelative(NOW - 2 * 86_400_000, NOW)).toBe("2日前");
	});
	test("7日以上前は絶対日付(相対では情報が薄い)", () => {
		const tenDaysAgo = NOW - 10 * 86_400_000;
		expect(formatDeletedRelative(tenDaysAgo, NOW)).toBe(new Date(tenDaysAgo).toISOString().slice(0, 10));
	});
	test("未来(時計ずれ・不正データ)は嘘の相対表記を出さず絶対日付へ倒す", () => {
		const future = NOW + 3 * 60_000;
		expect(formatDeletedRelative(future, NOW)).toBe(new Date(future).toISOString().slice(0, 10));
	});
});

describe("buildTrashRows(ゴミ箱ページの行構築)", () => {
	test("新しい順(削除時刻降順)に並べる", () => {
		const rows = buildTrashRows(
			[
				{ uri: "old.ics", calendarId: "tasks", title: "古い", deletedAtMillis: NOW - 3_600_000 },
				{ uri: "new.ics", calendarId: "tasks", title: "新しい", deletedAtMillis: NOW - 60_000 },
			],
			NOW,
		);
		expect(rows.map((r) => r.uri)).toEqual(["new.ics", "old.ics"]);
	});

	test("同時刻は uri でタイブレークして決定的にする", () => {
		const rows = buildTrashRows(
			[
				{ uri: "b.ics", calendarId: "tasks", title: "B", deletedAtMillis: NOW },
				{ uri: "a.ics", calendarId: "tasks", title: "A", deletedAtMillis: NOW },
			],
			NOW,
		);
		expect(rows.map((r) => r.uri)).toEqual(["a.ics", "b.ics"]);
	});

	test("空タイトル(空 SUMMARY)は『(無題)』に degrade する", () => {
		const rows = buildTrashRows([{ uri: "x.ics", calendarId: "tasks", title: "  ", deletedAtMillis: NOW }], NOW);
		expect(rows[0]?.title).toBe("(無題)");
	});

	test("uri/calendarId を復元キーとしてそのまま運ぶ(restore-deleted の引数用)", () => {
		const rows = buildTrashRows(
			[{ uri: "keep.ics", calendarId: "reading", title: "本", deletedAtMillis: NOW - 120_000 }],
			NOW,
		);
		expect(rows[0]).toEqual({ uri: "keep.ics", calendarId: "reading", title: "本", deletedRelative: "2分前" });
	});

	test("空配列は空行を返す(呼び出し側が『ゴミ箱は空です』を出す)", () => {
		expect(buildTrashRows([], NOW)).toEqual([]);
	});
});
