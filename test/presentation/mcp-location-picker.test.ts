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
	locationPickerToUpdateArgs,
	structuredToLocationPickerValue,
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

// =============================================================================
// 2026-07-23 追加: 編集詳細への C4 移植で必要になった read/write 変換の境界値
// =============================================================================
describe("structuredToLocationPickerValue", () => {
	test("両方 null → null(未選択)", () => {
		expect(structuredToLocationPickerValue(null, null)).toBeNull();
	});

	test("geo 付き構造化場所 → kind:place", () => {
		const structured = { title: "岐阜大学", address: "岐阜県岐阜市柳戸1-1", geo: { lat: 35.46, lon: 136.73 }, radiusMeters: 100 };
		expect(structuredToLocationPickerValue(structured, null)).toEqual({
			kind: "place",
			title: "岐阜大学",
			address: "岐阜県岐阜市柳戸1-1",
			lat: 35.46,
			lon: 136.73,
			radius: 100,
		});
	});

	test("geo 無し構造化場所は place として表現できないので degrade して null", () => {
		// structuredLocationInputSchema は lat/lon 必須だが、既存データに geo 無しの混在があり得る
		// (location-picker.ts の関数コメント参照)。トリガ行は「未選択」に見えるだけで、location
		// フィールド自体は消えない(このケースは呼び出し側 makeSheetDraft の責務外)。
		const structured = { title: "岐阜大学", address: null, geo: null, radiusMeters: null };
		expect(structuredToLocationPickerValue(structured, null)).toBeNull();
	});

	test("conference が source:description → kind:conference", () => {
		expect(structuredToLocationPickerValue(null, { url: "https://meet.google.com/abc", source: "description" })).toEqual({
			kind: "conference",
			provider: null,
			url: "https://meet.google.com/abc",
		});
	});

	test("conference が source:url は無視する(汎用 URL 行に委ねる・会議として書いたものではないため)", () => {
		expect(structuredToLocationPickerValue(null, { url: "https://meet.google.com/abc", source: "url" })).toBeNull();
	});

	test("構造化場所(geo あり)が conference より優先", () => {
		const structured = { title: "本社", address: null, geo: { lat: 1, lon: 2 }, radiusMeters: null };
		const conference = { url: "https://zoom.us/j/1", source: "description" as const };
		expect(structuredToLocationPickerValue(structured, conference)?.kind).toBe("place");
	});
});

describe("locationPickerToUpdateArgs", () => {
	test("変化なし(null→null)は空オブジェクト", () => {
		expect(locationPickerToUpdateArgs(null, null)).toEqual({});
	});

	test("変化なし(同じ place)は空オブジェクト", () => {
		const v: LocationPickerValue = { kind: "place", title: "岐阜大学", address: null, lat: 1, lon: 2, radius: null };
		expect(locationPickerToUpdateArgs(v, { ...v })).toEqual({});
	});

	test("未選択 → place: structuredLocation を設定するだけ(conference には触れない)", () => {
		const v: LocationPickerValue = { kind: "place", title: "岐阜大学", address: null, lat: 1, lon: 2, radius: null };
		const args = locationPickerToUpdateArgs(v, null);
		expect(args).toEqual({ structuredLocation: { title: "岐阜大学", lat: 1, lon: 2 } });
		expect("conference" in args).toBe(false);
	});

	test("place → null(クリア): structuredLocation:null のみ(conference には触れない)", () => {
		const prev: LocationPickerValue = { kind: "place", title: "岐阜大学", address: null, lat: 1, lon: 2, radius: null };
		expect(locationPickerToUpdateArgs(null, prev)).toEqual({ structuredLocation: null });
	});

	test("conference → null(クリア): conference:null のみ", () => {
		const prev: LocationPickerValue = { kind: "conference", provider: "Zoom", url: "https://zoom.us/j/1" };
		expect(locationPickerToUpdateArgs(null, prev)).toEqual({ conference: null });
	});

	test("place → conference(種別の置換): conference を設定しつつ旧 structuredLocation を null で除去", () => {
		const prev: LocationPickerValue = { kind: "place", title: "岐阜大学", address: null, lat: 1, lon: 2, radius: null };
		const next: LocationPickerValue = { kind: "conference", provider: "Zoom", url: "https://zoom.us/j/1" };
		expect(locationPickerToUpdateArgs(next, prev)).toEqual({
			conference: { provider: "Zoom", url: "https://zoom.us/j/1" },
			structuredLocation: null,
		});
	});

	test("conference → place(種別の置換): structuredLocation を設定しつつ旧 conference を null で除去", () => {
		const prev: LocationPickerValue = { kind: "conference", provider: null, url: "https://zoom.us/j/1" };
		const next: LocationPickerValue = { kind: "place", title: "本社", address: null, lat: 1, lon: 2, radius: null };
		expect(locationPickerToUpdateArgs(next, prev)).toEqual({
			structuredLocation: { title: "本社", lat: 1, lon: 2 },
			conference: null,
		});
	});
});
