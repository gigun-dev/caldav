// =============================================================================
// presentation/mcp/format のテスト(G-5)
// =============================================================================
// epochToIso / parseIsoToEpoch / formatDateOnly を検証する。tz-resolution.test.ts と
// 同じ方針で、期待値は常に絶対値(Date.UTC / 既知オフセット)で固定する。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { epochToIso, formatDateOnly, parseIsoToEpoch } from "../../src/presentation/mcp/format";

describe("epochToIso", () => {
	test("UTC は Z 終端", () => {
		const millis = Date.UTC(2026, 6, 11, 3, 0, 0); // 2026-07-11T03:00:00Z
		expect(epochToIso(millis, "UTC")).toBe("2026-07-11T03:00:00Z");
	});

	test("Asia/Tokyo は +09:00(DST 無し)", () => {
		const millis = Date.UTC(2026, 6, 11, 3, 0, 0); // 2026-07-11T03:00:00Z → JST 12:00
		expect(epochToIso(millis, "Asia/Tokyo")).toBe("2026-07-11T12:00:00+09:00");
	});

	test("America/New_York は夏時間で -04:00(EDT)", () => {
		// 2026-07-11 は米国夏時間期間中(3月〜11月)。UTC 03:00 → EDT(-4h) 前日 23:00。
		const millis = Date.UTC(2026, 6, 11, 3, 0, 0);
		expect(epochToIso(millis, "America/New_York")).toBe("2026-07-10T23:00:00-04:00");
	});

	test("America/New_York は冬時間で -05:00(EST)", () => {
		// 2026-01-11 は米国標準時期間中。UTC 03:00 → EST(-5h) 前日 22:00。
		const millis = Date.UTC(2026, 0, 11, 3, 0, 0);
		expect(epochToIso(millis, "America/New_York")).toBe("2026-01-10T22:00:00-05:00");
	});
});

describe("parseIsoToEpoch", () => {
	test("Z 終端は受理する", () => {
		expect(parseIsoToEpoch("2026-07-11T03:00:00Z")).toBe(Date.UTC(2026, 6, 11, 3, 0, 0));
	});

	test("コロン付き offset は受理する", () => {
		expect(parseIsoToEpoch("2026-07-11T12:00:00+09:00")).toBe(Date.UTC(2026, 6, 11, 3, 0, 0));
	});

	test("floating(offset 無し)は throw する", () => {
		expect(() => parseIsoToEpoch("2026-07-11T03:00:00")).toThrow(RangeError);
	});

	test("壊れた文字列は throw する", () => {
		expect(() => parseIsoToEpoch("not-a-date")).toThrow(RangeError);
	});
});

describe("formatDateOnly", () => {
	test("UTC 00:00 相当の epoch を YYYY-MM-DD にする", () => {
		const millis = Date.UTC(2026, 6, 11, 0, 0, 0);
		expect(formatDateOnly(millis, "UTC")).toBe("2026-07-11");
	});

	test("ゾーンをまたいで日付が変わるケース", () => {
		// UTC 2026-07-11T23:00:00Z は Asia/Tokyo(+9h)では 2026-07-12 08:00。
		const millis = Date.UTC(2026, 6, 11, 23, 0, 0);
		expect(formatDateOnly(millis, "Asia/Tokyo")).toBe("2026-07-12");
	});
});
