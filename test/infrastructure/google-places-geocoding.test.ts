// =============================================================================
// GooglePlacesGeocodingAdapter ユニットテスト(#45 スライス A)
// =============================================================================
// fetch をスタブして「Google レスポンス → LocationCandidate の写像」「非 200 / 壊れた JSON /
// 座標欠落 / キー未設定」の各挙動を固定する(実 API は叩かない)。
import { describe, expect, test } from "bun:test";
import { GooglePlacesGeocodingAdapter } from "../../src/infrastructure/geocoding/google-places-geocoding";
import { GeocodingNotConfiguredError } from "../../src/application/ports";

// Google Places Text Search (New) の正常レスポンス断片(FieldMask で絞った3項目)。
function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("GooglePlacesGeocodingAdapter.searchLocation", () => {
	test("displayName/formattedAddress/location を title/address/geo に写像する", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchStub = (async (url: unknown, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return okResponse({
				places: [
					{ displayName: { text: "東京駅" }, formattedAddress: "東京都千代田区丸の内1丁目9", location: { latitude: 35.681, longitude: 139.767 } },
				],
			});
		}) as unknown as typeof fetch;

		const adapter = new GooglePlacesGeocodingAdapter("test-key", fetchStub);
		const candidates = await adapter.searchLocation("東京駅");

		expect(candidates).toEqual([
			{ title: "東京駅", address: "東京都千代田区丸の内1丁目9", geo: { lat: 35.681, lon: 139.767 } },
		]);
		// エンドポイント・API キーヘッダ・FieldMask・body(ja/JP)を検証する。
		expect(capturedUrl).toBe("https://places.googleapis.com/v1/places:searchText");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["X-Goog-Api-Key"]).toBe("test-key");
		expect(headers["X-Goog-FieldMask"]).toBe("places.displayName,places.formattedAddress,places.location");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			textQuery: "東京駅",
			languageCode: "ja",
			regionCode: "JP",
			maxResultCount: 5,
		});
	});

	test("座標(location)が欠落した候補は落とす(geo は必須)", async () => {
		const fetchStub = (async () =>
			okResponse({
				places: [
					{ displayName: { text: "座標なし" }, formattedAddress: "住所だけ" }, // location 欠落 → 落とす。
					{ displayName: { text: "座標あり" }, location: { latitude: 1, longitude: 2 } },
				],
			})) as unknown as typeof fetch;
		const adapter = new GooglePlacesGeocodingAdapter("k", fetchStub);
		const candidates = await adapter.searchLocation("q");
		expect(candidates).toEqual([{ title: "座標あり", address: null, geo: { lat: 1, lon: 2 } }]);
	});

	test("解決 0 件は空配列(例外にしない)", async () => {
		const fetchStub = (async () => okResponse({})) as unknown as typeof fetch;
		const adapter = new GooglePlacesGeocodingAdapter("k", fetchStub);
		expect(await adapter.searchLocation("該当なし")).toEqual([]);
	});

	test("非 200 は throw する(0 件と区別する)", async () => {
		const fetchStub = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
		const adapter = new GooglePlacesGeocodingAdapter("k", fetchStub);
		await expect(adapter.searchLocation("q")).rejects.toThrow(/HTTP 403/);
	});

	test("キー未設定(空文字)は呼び出し時に GeocodingNotConfiguredError(fetch は叩かない)", async () => {
		let called = false;
		const fetchStub = (async () => {
			called = true;
			return okResponse({});
		}) as unknown as typeof fetch;
		const adapter = new GooglePlacesGeocodingAdapter("", fetchStub);
		await expect(adapter.searchLocation("q")).rejects.toBeInstanceOf(GeocodingNotConfiguredError);
		expect(called).toBe(false);
	});
});
