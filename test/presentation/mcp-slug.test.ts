// =============================================================================
// slugifyForCollectionId の単体テスト
// - 2026-07-15 是正: 非 ASCII displayName の縮退バグ(degenerate slug → UUID フォールバック)
// - 2026-07-23 K1 追記: フォールバック先を crypto.randomUUID() → 安定 hash slug に変更
//   (同じ displayName なら同じ id 候補になり、CreateCollection UC の displayName 重複ガードと
//   二重防御になる。src/presentation/mcp/server.ts の slugifyForCollectionId コメント参照)
// =============================================================================
// 本番検証で、create-calendar に日本語 displayName(例「読書リスト2」)を渡すと、素朴な
// slug 化(非 ASCII を "-" に畳んで前後 trim)で日本語部分が丸ごと落ち、id が "2" という
// 無意味な値に縮退する事故を確認した(src/presentation/mcp/server.ts の
// slugifyForCollectionId コメント参照)。対象関数を直接 export してもらい、境界値だけを
// ここで検証する(mcp-server.test.ts のような McpServer 全体の統合テストは重いため)。
import { describe, expect, test } from "bun:test";
import { slugifyForCollectionId } from "../../src/presentation/mcp/server";

// K1 以降のフォールバック slug は "list-" + 8桁 hex(FNV-1a)の形。
const HASH_SLUG_RE = /^list-[0-9a-f]{8}$/;

describe("slugifyForCollectionId", () => {
	test("ASCII displayName は素朴な slug 化のまま(既存挙動の退行防止)", () => {
		expect(slugifyForCollectionId("Reading List")).toBe("reading-list");
		expect(slugifyForCollectionId("Work Tasks 2026")).toBe("work-tasks-2026");
	});

	test("日本語のみの displayName は安定 hash slug にフォールバックする(全部 '-' に潰れ空文字になる縮退)", () => {
		const result = slugifyForCollectionId("読書リスト");
		expect(result).toMatch(HASH_SLUG_RE);
	});

	test("日本語+数字は数字だけが偶然生き残っても hash slug にフォールバックする(本番で踏んだ実バグ: 'id=2' 事故)", () => {
		// 「読書リスト2」→ 旧実装は "読書リスト" が "-" に潰れ "-2-" → trim で "2" に縮退していた。
		const result = slugifyForCollectionId("読書リスト2");
		expect(result).not.toBe("2");
		expect(result).toMatch(HASH_SLUG_RE);
	});

	test("2文字以下に潰れる短い残骸も hash slug にフォールバックする(長さ<3 の縮退判定)", () => {
		const result = slugifyForCollectionId("OK読書リスト"); // → 素朴normalizeで "ok" (2文字)まで潰れる
		expect(result).not.toBe("ok");
		expect(result).toMatch(HASH_SLUG_RE);
	});

	test("十分な長さの英数字 slug はそのまま使う(数字を含んでいても数字のみでなければ縮退させない)", () => {
		expect(slugifyForCollectionId("list42")).toBe("list42");
	});

	// K1: 同じ displayName を複数回渡しても同じ id 候補になる(安定性。冪等の二重防御)。
	test("同じ非 ASCII displayName は毎回同じ hash slug になる(安定 id — K1 の二重防御)", () => {
		const first = slugifyForCollectionId("読書リスト");
		const second = slugifyForCollectionId("読書リスト");
		expect(first).toBe(second);
	});

	// NFC/NFD の差異は素朴な toLowerCase() 経路には影響しないが、hash slug 経路は内部で
	// NFC 正規化してからハッシュ化するため、見た目同じ displayName が NFD で渡っても
	// 同じ id 候補になる(UC 層の displayName 比較の正規化方針と揃えた)。
	test("NFC/NFD で見た目同じ displayName は同じ hash slug になる", () => {
		const nfc = slugifyForCollectionId("しごと".normalize("NFC"));
		const nfd = slugifyForCollectionId("しごと".normalize("NFD"));
		expect(nfc).toBe(nfd);
	});

	// 異なる displayName は(衝突しない限り)異なる hash slug になることを確認する
	// (FNV-1a は暗号学的強度を求めていないが、簡単な非衝突性の smoke test として)。
	test("異なる displayName は異なる hash slug になる(smoke test)", () => {
		expect(slugifyForCollectionId("読書リスト")).not.toBe(slugifyForCollectionId("買い物リスト"));
	});
});
