// =============================================================================
// test/presentation/mcp-location-picker.test.ts — C4 場所/会議セミモーダルの選択→引数変換
//                                                   (location-picker.ts)の境界値テスト
// =============================================================================
// 【何を保証するか(What)】location-picker.ts の純関数群(DOM 非依存)を固定する:
//   - locationPickerToCreateArgs: 場所選択 → structuredLocation / 会議選択 → conference の出し分け・
//     省略可フィールド(address/radius/provider)がキー自体を持たないこと。
//   - knownLocationToPickerValue: list-known-locations の1件 → LocationPickerValue の写像。
//   - locationPickerLabel/locationPickerIconName: 行に出す表示の決定式。
// =============================================================================
import { describe, expect, test } from "bun:test";
import {
	knownLocationToPickerValue,
	locationPickerIconName,
	locationPickerLabel,
	locationPickerToCreateArgs,
	type LocationPickerValue,
} from "../../src/presentation/mcp/ui/location-picker";

describe("locationPickerToCreateArgs", () => {
	test("null(未選択)は空オブジェクト", () => {
		expect(locationPickerToCreateArgs(null)).toEqual({});
	});

	test("場所選択(address/radius あり)→ structuredLocation フル", () => {
		const v: LocationPickerValue = {
			kind: "place",
			title: "岐阜大学",
			address: "岐阜県岐阜市柳戸1-1",
			lat: 35.463012,
			lon: 136.737202,
			radius: 100,
		};
		expect(locationPickerToCreateArgs(v)).toEqual({
			structuredLocation: { title: "岐阜大学", address: "岐阜県岐阜市柳戸1-1", lat: 35.463012, lon: 136.737202, radius: 100 },
		});
	});

	test("場所選択(address/radius 無し)→ 省略可フィールドはキー自体を持たない", () => {
		const v: LocationPickerValue = { kind: "place", title: "福登の自宅", address: null, lat: 35.017639, lon: 136.954547, radius: null };
		const args = locationPickerToCreateArgs(v);
		expect(args).toEqual({ structuredLocation: { title: "福登の自宅", lat: 35.017639, lon: 136.954547 } });
		expect("address" in (args.structuredLocation as object)).toBe(false);
		expect("radius" in (args.structuredLocation as object)).toBe(false);
	});

	test("会議選択(provider あり)→ conference.provider を含む", () => {
		const v: LocationPickerValue = { kind: "conference", provider: "Google Meet", url: "https://meet.google.com/xpk-yooe-eev" };
		expect(locationPickerToCreateArgs(v)).toEqual({ conference: { provider: "Google Meet", url: "https://meet.google.com/xpk-yooe-eev" } });
	});

	test("会議選択(provider 無し・任意URL直入力)→ conference.provider は省略", () => {
		const v: LocationPickerValue = { kind: "conference", provider: null, url: "https://x.com/foo" };
		const args = locationPickerToCreateArgs(v);
		expect(args).toEqual({ conference: { url: "https://x.com/foo" } });
		expect("provider" in (args.conference as object)).toBe(false);
	});
});

describe("knownLocationToPickerValue", () => {
	test("list-known-locations の1件を kind:\"place\" の選択結果へ写す", () => {
		expect(knownLocationToPickerValue({ title: "岐阜大学", address: null, lat: 1, lon: 2, radius: 100 })).toEqual({
			kind: "place",
			title: "岐阜大学",
			address: null,
			lat: 1,
			lon: 2,
			radius: 100,
		});
	});
});

describe("locationPickerLabel / locationPickerIconName", () => {
	test("場所は map-pin + タイトル", () => {
		const v: LocationPickerValue = { kind: "place", title: "岐阜大学", address: null, lat: 1, lon: 2, radius: null };
		expect(locationPickerIconName(v)).toBe("map-pin");
		expect(locationPickerLabel(v)).toBe("岐阜大学");
	});

	test("会議は video + provider(あれば)優先", () => {
		const v: LocationPickerValue = { kind: "conference", provider: "Zoom", url: "https://zoom.us/j/123" };
		expect(locationPickerIconName(v)).toBe("video");
		expect(locationPickerLabel(v)).toBe("Zoom");
	});

	test("会議で provider 無しは URL を表示", () => {
		const v: LocationPickerValue = { kind: "conference", provider: null, url: "https://x.com/foo" };
		expect(locationPickerLabel(v)).toBe("https://x.com/foo");
	});
});
