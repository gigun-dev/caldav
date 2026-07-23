// =============================================================================
// QuotaLimitedGeocoding ユニットテスト(#45 追加要件・月次 quota デコレータ)
// =============================================================================
// フェイクの GeocodingQuotaStore(インメモリの month→used カウンタ)と inner GeocodingPort を
// 注入して、①上限内は inner を呼ぶ ②上限到達で inner を呼ばず GeocodingQuotaExceededError
// ③月が変わると別カウンタでリセット ④消費は inner 呼び出しの直前(reserve 失敗時は inner 未実行)を固定する。
import { describe, expect, test } from "bun:test";
import { QuotaLimitedGeocoding } from "../../src/application/geocoding/quota-limited-geocoding";
import {
	GeocodingQuotaExceededError,
	type GeocodingPort,
	type GeocodingQuotaStore,
	type LocationCandidate,
} from "../../src/application/ports";

// インメモリの quota ストア(D1GeocodingQuotaStore の条件付き UPSERT と同じ「used < limit なら +1」)。
class FakeQuotaStore implements GeocodingQuotaStore {
	readonly used = new Map<string, number>();
	async tryConsume(month: string, limit: number): Promise<{ ok: boolean; used: number }> {
		const current = this.used.get(month) ?? 0;
		if (current >= limit) return { ok: false, used: current };
		const next = current + 1;
		this.used.set(month, next);
		return { ok: true, used: next };
	}
}

// inner: 呼ばれた回数を数え、固定候補を返す。
class CountingGeocoding implements GeocodingPort {
	calls = 0;
	async searchLocation(): Promise<LocationCandidate[]> {
		this.calls++;
		return [{ title: "t", address: null, geo: { lat: 1, lon: 2 } }];
	}
}

describe("QuotaLimitedGeocoding", () => {
	test("上限内は inner を呼び、上限到達で inner を呼ばず GeocodingQuotaExceededError", async () => {
		const store = new FakeQuotaStore();
		const inner = new CountingGeocoding();
		// クロックを固定して同一月に留める。上限 2。
		const fixed = new Date("2026-07-15T00:00:00Z");
		const geo = new QuotaLimitedGeocoding(inner, store, 2, () => fixed);

		await geo.searchLocation("a"); // used 1/2
		await geo.searchLocation("b"); // used 2/2
		expect(inner.calls).toBe(2);

		// 3回目は枠なし → ブロック(inner は呼ばれない)。
		await expect(geo.searchLocation("c")).rejects.toBeInstanceOf(GeocodingQuotaExceededError);
		expect(inner.calls).toBe(2);
		expect(store.used.get("2026-07")).toBe(2); // 消費されていない(reserve 失敗)。
	});

	test("月が変わると別カウンタでリセットされる(month キーの切り替わり)", async () => {
		const store = new FakeQuotaStore();
		const inner = new CountingGeocoding();
		let now = new Date("2026-07-31T23:00:00Z");
		const geo = new QuotaLimitedGeocoding(inner, store, 1, () => now);

		await geo.searchLocation("july"); // 2026-07 used 1/1
		await expect(geo.searchLocation("july-again")).rejects.toBeInstanceOf(GeocodingQuotaExceededError);

		// 月をまたぐ。2026-08 は別カウンタなので再び通る。
		now = new Date("2026-08-01T00:00:00Z");
		await geo.searchLocation("august");
		expect(inner.calls).toBe(2);
		expect(store.used.get("2026-07")).toBe(1);
		expect(store.used.get("2026-08")).toBe(1);
	});
});
