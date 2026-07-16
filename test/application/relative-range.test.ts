// =============================================================================
// relative-range — 相対レンジ解決の境界(ローカル0時・終端排他)+ DST 安全性の検証
// =============================================================================
//
// What(このテストが保証する仕様):
//   - today/tomorrow/next-7-days/next-30-days の境界が「当該 TZ のローカル午前0時・終端排他」
//   - DST 遷移をまたぐ日でも日跨ぎが 24h 固定でなく壁時計で正しい(春23h/秋25h の日を跨ぐ)
//   - 月跨ぎ・年跨ぎの日加算が桁上がりで正しく処理される
// now を固定注入し、境界 epoch を epochToIso(表示 TZ)で壁時計に戻して検証する。
// =============================================================================

import { describe, expect, it } from "bun:test";
import { resolveRelativeRange } from "../../src/application/time/relative-range";
import { epochToIso } from "../../src/presentation/mcp/format";

// 解決した epoch 範囲を「当該 TZ の壁時計 ISO」に戻すヘルパー(境界が現地0時かを目で見て検証できる形にする)。
function isoRange(keyword: Parameters<typeof resolveRelativeRange>[0], zone: string, nowMillis: number) {
	const { timeMinMillis, timeMaxMillis } = resolveRelativeRange(keyword, zone, nowMillis);
	return { min: epochToIso(timeMinMillis, zone), max: epochToIso(timeMaxMillis, zone) };
}

describe("resolveRelativeRange", () => {
	describe("Asia/Tokyo(固定 +09:00・DST 無し)", () => {
		// now = 2026-07-16T05:00:00Z = 2026-07-16 14:00 JST(現地では 7/16 の昼)。
		const now = Date.parse("2026-07-16T05:00:00Z");

		it("today = [今日0時, 明日0時)・現地0時・終端排他", () => {
			const { min, max } = isoRange("today", "Asia/Tokyo", now);
			expect(min).toBe("2026-07-16T00:00:00+09:00");
			expect(max).toBe("2026-07-17T00:00:00+09:00");
		});

		it("tomorrow = [明日0時, 明後日0時)", () => {
			const { min, max } = isoRange("tomorrow", "Asia/Tokyo", now);
			expect(min).toBe("2026-07-17T00:00:00+09:00");
			expect(max).toBe("2026-07-18T00:00:00+09:00");
		});

		it("next-7-days = [今日0時, 7日後0時)", () => {
			const { min, max } = isoRange("next-7-days", "Asia/Tokyo", now);
			expect(min).toBe("2026-07-16T00:00:00+09:00");
			expect(max).toBe("2026-07-23T00:00:00+09:00");
		});

		it("next-30-days = [今日0時, 30日後0時)(月跨ぎ)", () => {
			const { min, max } = isoRange("next-30-days", "Asia/Tokyo", now);
			expect(min).toBe("2026-07-16T00:00:00+09:00");
			// 7/16 + 30 日 = 8/15。day フィールドに +30 を渡し localFieldsToEpochMillis 内の桁上げで月跨ぎ処理。
			expect(max).toBe("2026-08-15T00:00:00+09:00");
		});
	});

	describe("UTC", () => {
		const now = Date.parse("2026-07-16T23:30:00Z"); // 現地(=UTC)では 7/16 の深夜。
		it("today の境界は UTC の現地0時", () => {
			const { min, max } = isoRange("today", "UTC", now);
			expect(min).toBe("2026-07-16T00:00:00Z");
			expect(max).toBe("2026-07-17T00:00:00Z");
		});
	});

	describe("America/Los_Angeles(DST あり)", () => {
		// 【DST 安全の要】ms 加算(+N*86400000)だと DST を跨ぐと1時間ズレる。壁時計の日加算なら
		// 境界は常に現地0時(offset は季節で -07:00/-08:00 に変わるが「現地0時」であることは保たれる)。

		it("春の切替日(2026-03-08・02:00→03:00)を today が跨いでも現地0時・終端排他", () => {
			// now = 2026-03-08 の日中。この日は現地で 23 時間しかない(2時台が消える)。
			const now = Date.parse("2026-03-08T18:00:00Z"); // = 2026-03-08 10:00 PST/PDT 近辺の昼
			const { min, max } = isoRange("today", "America/Los_Angeles", now);
			// 開始は PST(-08:00)の現地0時、終端(翌日0時)は PDT(-07:00)の現地0時。
			// 実 epoch 差は 23h(DST で1時間短い)だが、両端とも「現地0時」であることが壁時計日加算の正しさ。
			expect(min).toBe("2026-03-08T00:00:00-08:00");
			expect(max).toBe("2026-03-09T00:00:00-07:00");
			// 念のため実 epoch 差が 23h(=DST で1時間短い日)であることを確認 — ms 加算実装なら 24h になり落ちる。
			const { timeMinMillis, timeMaxMillis } = resolveRelativeRange("today", "America/Los_Angeles", now);
			expect(timeMaxMillis - timeMinMillis).toBe(23 * 3600 * 1000);
		});

		it("秋の切替日(2026-11-01・02:00→01:00)を today が跨いでも現地0時・実 epoch 差 25h", () => {
			const now = Date.parse("2026-11-01T18:00:00Z");
			const { min, max } = isoRange("today", "America/Los_Angeles", now);
			// 開始は PDT(-07:00)の現地0時、終端は PST(-08:00)の現地0時。この日は現地で 25 時間ある。
			expect(min).toBe("2026-11-01T00:00:00-07:00");
			expect(max).toBe("2026-11-02T00:00:00-08:00");
			const { timeMinMillis, timeMaxMillis } = resolveRelativeRange("today", "America/Los_Angeles", now);
			expect(timeMaxMillis - timeMinMillis).toBe(25 * 3600 * 1000);
		});

		it("next-7-days が春の DST 切替を内包しても両端は現地0時", () => {
			// 2026-03-05 起点の7日間は 3/08 の切替を含む。両端が現地0時であることを確認(内部の1時間ズレは吸収)。
			const now = Date.parse("2026-03-05T20:00:00Z");
			const { min, max } = isoRange("next-7-days", "America/Los_Angeles", now);
			expect(min).toBe("2026-03-05T00:00:00-08:00");
			expect(max).toBe("2026-03-12T00:00:00-07:00");
		});
	});

	describe("年跨ぎ・月末跨ぎの日加算", () => {
		it("12/31 起点の tomorrow が翌年 1/1 になる(年跨ぎ桁上げ)", () => {
			const now = Date.parse("2026-12-31T15:00:00Z"); // = 2027-01-01 00:00 JST。現地では既に 1/1。
			// JST では now は 1/1 なので today=1/1, tomorrow=1/2。年跨ぎ検証には UTC で 12/31 を使う。
			const nowUtc = Date.parse("2026-12-31T12:00:00Z");
			const { min, max } = isoRange("tomorrow", "UTC", nowUtc);
			expect(min).toBe("2027-01-01T00:00:00Z");
			expect(max).toBe("2027-01-02T00:00:00Z");
			// now 引数の JST 版でも「現地日基準」で解決されることを別途確認(日境界がゾーン依存である証拠)。
			const jst = isoRange("today", "Asia/Tokyo", now);
			expect(jst.min).toBe("2027-01-01T00:00:00+09:00");
		});

		it("next-30-days が月末を跨いでも正しく桁上げ(1/20 + 30日 = 2/19)", () => {
			const now = Date.parse("2026-01-20T12:00:00Z");
			const { max } = isoRange("next-30-days", "UTC", now);
			expect(max).toBe("2026-02-19T00:00:00Z");
		});
	});
});
