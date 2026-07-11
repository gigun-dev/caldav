// =============================================================================
// TZ 解決層(docs/modeling/08 §6)のテスト
// =============================================================================
//
// resolver(TZID→IANA チェーン)/ instant(壁時計⇄UTC 変換)/ effective-period(§9.9)を
// まとめて検証する。**ランタイムのローカル TZ に依存させない**(本番 TZ=UTC / wrangler dev は
// ローカル TZ, workerd #2328)ため、期待値は常に Date.UTC(...) の絶対値で書く。
// DST 境界の「穴・重なり」の解決値は RFC が一意に定めない実装依存挙動なので、ここで
// 実測値を固定し、ICU/tzdb 更新で値が変わったら落ちるようにしておく。
// =============================================================================

import { describe, expect, test } from "bun:test";
import type { Component } from "../../../../src/domain/ical";
import {
	TimezoneResolutionError,
	VTimezone,
	calDateStartEpochMillis,
	calDateTimeToEpochMillis,
	effectiveEventPeriod,
	getZoneOffsetMillis,
	isValidIanaZone,
	localFieldsToEpochMillis,
	parseCalDate,
	parseCalDateTime,
	parseDurationValue,
	resolveTimeZoneId,
} from "../../../../src/domain/ical";

// テスト用: X-LIC-LOCATION を持つ VTIMEZONE を手組みする(libical/Lightning 相当)。
function vtimezoneWith(tzid: string, props: Record<string, string>): VTimezone {
	const component: Component = {
		name: "VTIMEZONE",
		properties: [
			{ name: "TZID", parameters: [], value: tzid },
			...Object.entries(props).map(([name, value]) => ({ name, parameters: [], value })),
		],
		components: [],
	};
	return VTimezone.fromComponent(component);
}

// 恒等 zoneOf(テストでは tzid にそのまま IANA 名を入れるので素通し)。
const idZone = (t: string): string => t;

describe("resolveTimeZoneId(§6-2 の4段チェーン)", () => {
	test("① IANA 名の直引き", () => {
		expect(resolveTimeZoneId("Asia/Tokyo")).toEqual({ ianaId: "Asia/Tokyo", via: "iana" });
	});

	test("① 先頭スラッシュ(§3.2.19 グローバル一意プレフィックス)を剥がして直引き", () => {
		expect(resolveTimeZoneId("/Asia/Tokyo")).toEqual({ ianaId: "Asia/Tokyo", via: "iana" });
	});

	test("② Windows 名マップ(大文字小文字ゆれ込み)", () => {
		expect(resolveTimeZoneId("Tokyo Standard Time")).toEqual({ ianaId: "Asia/Tokyo", via: "windows" });
		// 全大文字の表記ゆれ(Outlook 系実装例)も引ける。
		expect(resolveTimeZoneId("TOKYO STANDARD TIME")).toEqual({ ianaId: "Asia/Tokyo", via: "windows" });
	});

	test("③(a) VTIMEZONE の X-LIC-LOCATION から推測", () => {
		// tzid 自体は IANA でも Windows でもない → X-LIC-LOCATION の IANA 名を採用。
		const vtz = vtimezoneWith("Customized Time Zone", { "X-LIC-LOCATION": "Asia/Tokyo" });
		expect(resolveTimeZoneId("Customized Time Zone", vtz)).toEqual({ ianaId: "Asia/Tokyo", via: "x-lic-location" });
	});

	test("③(b) TZID 末尾の Area/Location suffix から推測", () => {
		// libical のグローバル一意プレフィックス形。末尾 2 セグメントが IANA 名。
		expect(resolveTimeZoneId("/mozilla.org/20070129_1/Asia/Tokyo")).toEqual({
			ianaId: "Asia/Tokyo",
			via: "tzid-suffix",
		});
		// 3 セグメント地域(America/Argentina/Buenos_Aires)も末尾から拾える。
		expect(resolveTimeZoneId("/mozilla.org/20070129_1/America/Argentina/Buenos_Aires")).toEqual({
			ianaId: "America/Argentina/Buenos_Aires",
			via: "tzid-suffix",
		});
	});

	test("④ 全滅なら TimezoneResolutionError(暗黙フォールバックしない)", () => {
		expect(() => resolveTimeZoneId("Totally Unknown Zone")).toThrow(TimezoneResolutionError);
	});

	test("isValidIanaZone は未知名を弾く", () => {
		expect(isValidIanaZone("Asia/Tokyo")).toBe(true);
		expect(isValidIanaZone("Not/AZone")).toBe(false);
		expect(isValidIanaZone("")).toBe(false);
	});
});

describe("instant: 壁時計 ⇄ UTC 変換(Intl/ICU)", () => {
	test("Asia/Tokyo は常に +9h(DST なし)", () => {
		// 1 月・7 月とも +9h 固定。
		expect(getZoneOffsetMillis("Asia/Tokyo", Date.UTC(2026, 0, 15))).toBe(9 * 3600_000);
		expect(getZoneOffsetMillis("Asia/Tokyo", Date.UTC(2026, 6, 15))).toBe(9 * 3600_000);
		// 壁時計 2026-01-15 12:00 JST = 03:00 UTC。
		expect(localFieldsToEpochMillis({ year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 }, "Asia/Tokyo")).toBe(
			Date.UTC(2026, 0, 15, 3, 0, 0),
		);
	});

	test("America/New_York は EST(-5)と EDT(-4)を切り替える", () => {
		// 1 月は EST -5h、7 月は EDT -4h。
		expect(getZoneOffsetMillis("America/New_York", Date.UTC(2026, 0, 15))).toBe(-5 * 3600_000);
		expect(getZoneOffsetMillis("America/New_York", Date.UTC(2026, 6, 15))).toBe(-4 * 3600_000);
		// 壁時計 2026-01-15 12:00 EST = 17:00 UTC。
		expect(localFieldsToEpochMillis({ year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 }, "America/New_York")).toBe(
			Date.UTC(2026, 0, 15, 17, 0, 0),
		);
		// 壁時計 2026-07-15 12:00 EDT = 16:00 UTC。
		expect(localFieldsToEpochMillis({ year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 }, "America/New_York")).toBe(
			Date.UTC(2026, 6, 15, 16, 0, 0),
		);
	});

	test("DST 春の穴(2026-03-08 02:30 NY は実在しない)の決定的解決", () => {
		// instant.ts のコメント参照: 2 パス方式で 2026-03-08T06:30Z に倒れる(EST 側=穴の直前)。
		expect(localFieldsToEpochMillis({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/New_York")).toBe(
			Date.UTC(2026, 2, 8, 6, 30, 0),
		);
	});

	test("DST 秋の重なり(2026-11-01 01:30 NY は2度出る)の決定的解決", () => {
		// 最初の出現(EDT 側)= 2026-11-01T05:30Z に解決される。
		expect(localFieldsToEpochMillis({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, "America/New_York")).toBe(
			Date.UTC(2026, 10, 1, 5, 30, 0),
		);
	});

	test("floating の既定は UTC(§7.3 の MAY を暗黙にしない)", () => {
		const floating = parseCalDateTime("20260315T120000");
		expect(calDateTimeToEpochMillis(floating, { zoneOf: idZone })).toBe(Date.UTC(2026, 2, 15, 12, 0, 0));
		// floatingTimeZone を渡せば上書きされる。
		expect(calDateTimeToEpochMillis(floating, { zoneOf: idZone, floatingTimeZone: "Asia/Tokyo" })).toBe(
			Date.UTC(2026, 2, 15, 3, 0, 0),
		);
	});

	test("zoned は zoneOf で IANA 名を得て変換", () => {
		const zoned = parseCalDateTime("20260115T120000", "America/New_York");
		expect(calDateTimeToEpochMillis(zoned, { zoneOf: idZone })).toBe(Date.UTC(2026, 0, 15, 17, 0, 0));
	});

	test("うるう秒(秒=60)は計算時 59 にクランプ", () => {
		// utc 経路(toEpochMillis 再利用)。20261231T235960Z → 59 秒扱い。
		const leap = parseCalDateTime("20261231T235960Z");
		expect(calDateTimeToEpochMillis(leap, { zoneOf: idZone })).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
		// zoned 経路のクランプも確認。
		const leapZoned = parseCalDateTime("20261231T235960", "Asia/Tokyo");
		expect(calDateTimeToEpochMillis(leapZoned, { zoneOf: idZone })).toBe(
			Date.UTC(2026, 11, 31, 23, 59, 59) - 9 * 3600_000,
		);
	});

	test("calDateStartEpochMillis は指定ゾーンの現地 00:00", () => {
		expect(calDateStartEpochMillis(parseCalDate("20260315"), "UTC")).toBe(Date.UTC(2026, 2, 15, 0, 0, 0));
		expect(calDateStartEpochMillis(parseCalDate("20260315"), "Asia/Tokyo")).toBe(
			Date.UTC(2026, 2, 15, 0, 0, 0) - 9 * 3600_000,
		);
	});
});

describe("effectiveEventPeriod(RFC 4791 §9.9)", () => {
	test("DTEND あり → end は DTEND の実効瞬間", () => {
		const p = effectiveEventPeriod(
			{ dtstart: parseCalDateTime("20260101T000000Z"), dtend: parseCalDateTime("20260101T010000Z") },
			{ zoneOf: idZone },
		);
		expect(p.startMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(p.endMillis).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));
	});

	test("DURATION PT1H は exact 加算(UTC ms)", () => {
		const p = effectiveEventPeriod(
			{ dtstart: parseCalDateTime("20260101T000000Z"), duration: parseDurationValue("PT1H") },
			{ zoneOf: idZone },
		);
		expect(p.endMillis - p.startMillis).toBe(3600_000);
	});

	test("DURATION P1D は nominal 加算(DST 跨ぎで壁時計を維持)", () => {
		// NY で 3/7 23:00 開始 + P1D。壁時計は翌日 23:00 を維持するので実経過は 23h(春の DST 跨ぎ)。
		const p = effectiveEventPeriod(
			{ dtstart: parseCalDateTime("20260307T230000", "America/New_York"), duration: parseDurationValue("P1D") },
			{ zoneOf: idZone },
		);
		// start: 2026-03-07 23:00 EST = 2026-03-08T04:00Z。
		expect(p.startMillis).toBe(Date.UTC(2026, 2, 8, 4, 0, 0));
		// end: 2026-03-08 23:00 EDT(遷移後 -4h)= 2026-03-09T03:00Z。壁時計 23:00 維持。
		expect(p.endMillis).toBe(Date.UTC(2026, 2, 9, 3, 0, 0));
		// 実経過は 23 時間(nominal の証拠。exact なら 24h になるはず)。
		expect(p.endMillis - p.startMillis).toBe(23 * 3600_000);
	});

	test("負 DURATION は符号どおり", () => {
		const p = effectiveEventPeriod(
			{ dtstart: parseCalDateTime("20260101T120000Z"), duration: parseDurationValue("-PT2H") },
			{ zoneOf: idZone },
		);
		expect(p.endMillis).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
	});

	test("DTEND/DURATION 省略: DATE-TIME は 0 秒(end=start)", () => {
		const p = effectiveEventPeriod({ dtstart: parseCalDateTime("20260101T120000Z") }, { zoneOf: idZone });
		expect(p.endMillis).toBe(p.startMillis);
	});

	test("DTEND/DURATION 省略: DATE は +P1D(壁時計で翌日 00:00)", () => {
		const p = effectiveEventPeriod({ dtstart: parseCalDate("20260308") }, { zoneOf: idZone });
		expect(p.startMillis).toBe(Date.UTC(2026, 2, 8, 0, 0, 0));
		expect(p.endMillis).toBe(Date.UTC(2026, 2, 9, 0, 0, 0));
	});

	test("DTEND が DATE 値: 現地 00:00 で非包含", () => {
		// 1/1〜1/3 の終日(2日間)。DTEND=1/3 は非包含なので end=1/3 00:00。
		const p = effectiveEventPeriod(
			{ dtstart: parseCalDate("20260101"), dtend: parseCalDate("20260103") },
			{ zoneOf: idZone },
		);
		expect(p.startMillis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
		expect(p.endMillis).toBe(Date.UTC(2026, 0, 3, 0, 0, 0));
	});
});
