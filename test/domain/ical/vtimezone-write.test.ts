// =============================================================================
// timezone/vtimezone-write.ts のテスト(V6 新設)
// =============================================================================
// buildVTimezone(Phase 1: 固定オフセットゾーンのみ)/ zoneHasOffsetTransitions の単体テスト。
// §3.6.5 必須要素(TZID・STANDARD≥1・DTSTART/TZOFFSETFROM/TZOFFSETTO)を満たすこと、
// DST ゾーンは UnsupportedTimeZoneError になることを検証する。
import { describe, expect, test } from "bun:test";
import { buildVTimezone, zoneHasOffsetTransitions } from "../../../src/domain/ical/timezone/vtimezone-write";
import { UnsupportedTimeZoneError } from "../../../src/domain/ical/timezone/errors";
import { VTimezone } from "../../../src/domain/ical/semantics/vtimezone";

// 2026年を代表窓とする(固定値でテストを決定的にする)。
const WINDOW_2026 = { startMillis: Date.UTC(2026, 0, 1), endMillis: Date.UTC(2026, 11, 31) };

describe("zoneHasOffsetTransitions", () => {
	test("固定オフセットゾーン(Asia/Tokyo)は false", () => {
		expect(zoneHasOffsetTransitions("Asia/Tokyo", WINDOW_2026.startMillis, WINDOW_2026.endMillis)).toBe(false);
	});

	test("DST ゾーン(America/New_York)は true(年内に EST/EDT が切り替わる)", () => {
		expect(zoneHasOffsetTransitions("America/New_York", WINDOW_2026.startMillis, WINDOW_2026.endMillis)).toBe(true);
	});

	test("endMillis < startMillis は RangeError", () => {
		expect(() => zoneHasOffsetTransitions("Asia/Tokyo", WINDOW_2026.endMillis, WINDOW_2026.startMillis)).toThrow(RangeError);
	});
});

describe("buildVTimezone", () => {
	test("Asia/Tokyo は §3.6.5 必須要素を満たす最小 VTIMEZONE(TZOFFSETTO=+0900)を返す", () => {
		const component = buildVTimezone("Asia/Tokyo", WINDOW_2026);
		expect(component.name).toBe("VTIMEZONE");
		expect(component.properties).toContainEqual({ name: "TZID", parameters: [], value: "Asia/Tokyo" });

		// validate() 経由で §3.6.5 の必須要素(TZID・STANDARD/DAYLIGHT≥1・各サブの
		// DTSTART/TZOFFSETFROM/TZOFFSETTO)を満たすことを確認する(I10)。
		const lens = VTimezone.fromComponent(component);
		expect(lens.validate()).toEqual([]);

		const standard = lens.standard()[0]!;
		expect(standard.properties.find((p) => p.name === "TZOFFSETFROM")?.value).toBe("+0900");
		expect(standard.properties.find((p) => p.name === "TZOFFSETTO")?.value).toBe("+0900");
		// 【TZNAME 省略の実測】この実行環境(workerd/bun の ICU)は en-US ロケールで
		// Asia/Tokyo の "short" 略称を "JST" ではなく "GMT+9" で返す(iOS 実機は "JST" を送るが、
		// これは iOS 側が別のロケール/ICU バージョンを使っているため — shortTzNameFor の
		// 「GMT+数字」フィルタどおり、ここでは省略される)。TZNAME は §3.6.5 で OPTIONAL なので
		// 省略しても RFC 準拠を損なわない(validate() が上で []=違反ゼロ を確認済み)。
		expect(standard.properties.find((p) => p.name === "TZNAME")).toBeUndefined();
		// DTSTART は 19700101T000000 固定(vtimezone-write.ts の設計判断コメント参照)。
		// iOS 実機の "19510909T010000"(JST 制定日)とはバイト不一致だが、TZOFFSETFROM=TZOFFSETTO
		// の STANDARD が「その日付以降ずっと有効」を表すという意味では等価(RFC は DTSTART の
		// 実際の日付そのものに意味を持たせていない — §3.6.5 は「観測規則が適用される開始点」を
		// 要求するだけで、値の一致までは要求しない)。
		expect(standard.properties.find((p) => p.name === "DTSTART")?.value).toBe("19700101T000000");
	});

	test("分単位オフセットゾーン(Asia/Kathmandu +05:45)も正しく ±HHMM 化される", () => {
		const component = buildVTimezone("Asia/Kathmandu", WINDOW_2026);
		const lens = VTimezone.fromComponent(component);
		const standard = lens.standard()[0]!;
		expect(standard.properties.find((p) => p.name === "TZOFFSETTO")?.value).toBe("+0545");
	});

	test("DST ゾーン(America/New_York)は UnsupportedTimeZoneError", () => {
		expect(() => buildVTimezone("America/New_York", WINDOW_2026)).toThrow(UnsupportedTimeZoneError);
	});

	test("UTC は TZOFFSETTO=+0000・TZNAME=UTC(Intl が意味のある略称 'UTC' を返すため採用する)", () => {
		const component = buildVTimezone("UTC", WINDOW_2026);
		const lens = VTimezone.fromComponent(component);
		const standard = lens.standard()[0]!;
		expect(standard.properties.find((p) => p.name === "TZOFFSETTO")?.value).toBe("+0000");
		expect(standard.properties.find((p) => p.name === "TZNAME")?.value).toBe("UTC");
	});

	test("Asia/Kathmandu(+05:45)は Intl の略称が 'GMT+5:45' 形(数値表現)なので TZNAME を省略する", () => {
		const component = buildVTimezone("Asia/Kathmandu", WINDOW_2026);
		const lens = VTimezone.fromComponent(component);
		const standard = lens.standard()[0]!;
		expect(standard.properties.find((p) => p.name === "TZNAME")).toBeUndefined();
	});
});
