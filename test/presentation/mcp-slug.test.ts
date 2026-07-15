// =============================================================================
// slugifyForCollectionId の単体テスト(2026-07-15 是正: 非 ASCII displayName の縮退バグ)
// =============================================================================
// 本番検証で、create-calendar に日本語 displayName(例「読書リスト2」)を渡すと、素朴な
// slug 化(非 ASCII を "-" に畳んで前後 trim)で日本語部分が丸ごと落ち、id が "2" という
// 無意味な値に縮退する事故を確認した(src/presentation/mcp/server.ts の
// slugifyForCollectionId コメント参照)。対象関数を直接 export してもらい、境界値だけを
// ここで検証する(mcp-server.test.ts のような McpServer 全体の統合テストは重いため)。
import { describe, expect, test } from "bun:test";
import { slugifyForCollectionId } from "../../src/presentation/mcp/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("slugifyForCollectionId", () => {
	test("ASCII displayName は素朴な slug 化のまま(既存挙動の退行防止)", () => {
		expect(slugifyForCollectionId("Reading List")).toBe("reading-list");
		expect(slugifyForCollectionId("Work Tasks 2026")).toBe("work-tasks-2026");
	});

	test("日本語のみの displayName は UUID にフォールバックする(全部 '-' に潰れ空文字になる縮退)", () => {
		const result = slugifyForCollectionId("読書リスト");
		expect(result).toMatch(UUID_RE);
	});

	test("日本語+数字は数字だけが偶然生き残っても UUID にフォールバックする(本番で踏んだ実バグ: 'id=2' 事故)", () => {
		// 「読書リスト2」→ 旧実装は "読書リスト" が "-" に潰れ "-2-" → trim で "2" に縮退していた。
		const result = slugifyForCollectionId("読書リスト2");
		expect(result).not.toBe("2");
		expect(result).toMatch(UUID_RE);
	});

	test("2文字以下に潰れる短い残骸も UUID にフォールバックする(長さ<3 の縮退判定)", () => {
		const result = slugifyForCollectionId("OK読書リスト"); // → 素朴normalizeで "ok" (2文字)まで潰れる
		expect(result).not.toBe("ok");
		expect(result).toMatch(UUID_RE);
	});

	test("十分な長さの英数字 slug はそのまま使う(数字を含んでいても数字のみでなければ縮退させない)", () => {
		expect(slugifyForCollectionId("list42")).toBe("list42");
	});
});
