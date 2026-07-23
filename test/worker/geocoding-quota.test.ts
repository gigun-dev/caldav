// =============================================================================
// test/worker/geocoding-quota.test.ts — D1GeocodingQuotaStore の atomic 予約(#45 追加要件)
// =============================================================================
//
// 【なぜ workerd レーンか】D1GeocodingQuotaStore は実 D1Database(cloudflare:workers の env.DB)の
// 条件付き UPSERT + RETURNING を叩く。bun test には D1 が無いため、migrations/0005_geocoding_quota.sql が
// 適用される workerd レーン(vitest run)に置く(d1-repositories.test.ts と同じ判断)。
//
// 【検証項目(要件 #5)】
//   ① 上限到達で tryConsume がブロック(ok:false)になる。
//   ② 月が変われば別 month 行でリセットされる(month キーの切り替わり)。
//   ③ 並行 tryConsume でも単調増加(used が飛ばず・limit を超えない)。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1GeocodingQuotaStore } from "../../src/infrastructure/geocoding/d1-geocoding-quota-store";

describe("D1GeocodingQuotaStore.tryConsume", () => {
	it("上限到達でブロックし、月が変わればリセットされる", async () => {
		const store = new D1GeocodingQuotaStore(env.DB);
		// テストごとに一意な月キー空間にするため、テスト固有の "月" 文字列を使う(実カレンダー月に
		// 依存しない = 他テストや実時刻と衝突しない)。
		const monthA = "test-2026-01";
		const monthB = "test-2026-02";

		const r1 = await store.tryConsume(monthA, 2);
		expect(r1).toEqual({ ok: true, used: 1 });
		const r2 = await store.tryConsume(monthA, 2);
		expect(r2).toEqual({ ok: true, used: 2 });
		// 上限到達 → ブロック(used は増えない)。
		const r3 = await store.tryConsume(monthA, 2);
		expect(r3.ok).toBe(false);

		// 別月は別カウンタ = リセット扱い。
		const rB = await store.tryConsume(monthB, 2);
		expect(rB).toEqual({ ok: true, used: 1 });
	});

	it("並行 tryConsume でも単調増加し limit を超えない", async () => {
		const store = new D1GeocodingQuotaStore(env.DB);
		const month = "test-concurrent-2026-03";
		const limit = 5;

		// 20 並行で叩く。ちょうど limit 件だけ ok:true になり、残りは ok:false。
		const results = await Promise.all(
			Array.from({ length: 20 }, () => store.tryConsume(month, limit)),
		);
		const okCount = results.filter((r) => r.ok).length;
		expect(okCount).toBe(limit);

		// 成功分の used は 1..limit を過不足なく1回ずつ(単調増加・重複なし)。
		const okUsed = results.filter((r) => r.ok).map((r) => r.used).sort((a, b) => a - b);
		expect(okUsed).toEqual([1, 2, 3, 4, 5]);

		// 最終的な行の used は limit で頭打ち。
		const final = await store.tryConsume(month, limit);
		expect(final.ok).toBe(false);
	});
});
