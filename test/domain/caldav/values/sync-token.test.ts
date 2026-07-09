// =============================================================================
// SyncToken のテスト(RFC 6578 §3.2)
// =============================================================================
// 検証項目(タスク指定):
//   - URI 往復(toUri → fromUri で同じカウンタに戻る)
//   - 無効 URI の拒否(他サーバー由来等 → invalid)
//   - 単調増加(next で必ず増える)
import { describe, expect, test } from "bun:test";
import { SyncToken } from "../../../../src/domain/caldav/values";

const BASE = "https://dav.example/cal/work";

describe("SyncToken URI 往復", () => {
	test("toUri → fromUri でカウンタが往復する", () => {
		const t = SyncToken.of(42);
		const uri = t.toUri(BASE);
		// 公開形式は「有効な URI」であること MUST(§3.2)。ここでは base 起点の URI になっている。
		expect(uri).toBe("https://dav.example/cal/work/ns/sync/42");
		const parsed = SyncToken.fromUri(BASE, uri);
		expect(parsed.valid).toBe(true);
		if (parsed.valid) expect(parsed.token.equals(t)).toBe(true);
	});

	test("base 末尾スラッシュの有無で同じ URI を生成する", () => {
		expect(SyncToken.of(7).toUri(BASE)).toBe(SyncToken.of(7).toUri(BASE + "/"));
	});

	test("初期トークンは counter=0", () => {
		expect(SyncToken.initial().toUri(BASE)).toBe("https://dav.example/cal/work/ns/sync/0");
	});
});

describe("SyncToken 無効 URI の拒否", () => {
	test("他サーバー由来の不透明トークンは invalid", () => {
		const r = SyncToken.fromUri(BASE, "https://other.example/sync/abc123");
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.raw).toBe("https://other.example/sync/abc123");
	});

	test("prefix は合うが末尾が整数でない → invalid", () => {
		expect(SyncToken.fromUri(BASE, "https://dav.example/cal/work/ns/sync/notnum").valid).toBe(false);
	});

	test("別コレクションの base のトークンは invalid", () => {
		const uri = SyncToken.of(3).toUri("https://dav.example/cal/home");
		expect(SyncToken.fromUri(BASE, uri).valid).toBe(false);
	});
});

describe("SyncToken 単調増加", () => {
	test("next は必ずカウンタを増やす", () => {
		let t = SyncToken.initial();
		const seen: number[] = [t.counter];
		for (let i = 0; i < 5; i++) {
			t = t.next();
			seen.push(t.counter);
		}
		expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
	});

	test("of は負値・非整数を拒否する", () => {
		expect(() => SyncToken.of(-1)).toThrow();
		expect(() => SyncToken.of(1.5)).toThrow();
	});
});
