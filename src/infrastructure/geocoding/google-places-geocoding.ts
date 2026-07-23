// =============================================================================
// GooglePlacesGeocodingAdapter — GeocodingPort の Google Places Text Search (New) 実装(#45)
// =============================================================================
//
// 【なぜ Google Places Text Search (New) を選んだか】
// docs/research/geocoding-bench-2026-07-23.md の 18 クエリ実測ベンチで、解決率(18/18)・POI 強度
// (有名 POI もチェーン店も高精度)・3点セット(title=displayName / address=formattedAddress /
// geo=location)の安定性のすべてで Google が優位だった(GSI は住所専用で POI 名に非対応・Apple は
// POI 曖昧クエリで取りこぼしと住所誤答)。iOS の structuredLocation を狙うので Google を主力にする。
//
// 【Field Mask で必要3項目だけを取る(コスト最適化 + 語彙の局所化)】
// X-Goog-FieldMask で places.displayName / places.formattedAddress / places.location だけを要求する。
// Text Search (New) は要求フィールドの階層で課金 SKU が変わる(公式 SKU 表・2026-07-23 確認:
// developers.google.com/maps/billing-and-pricing/sku-details)。この3項目は Text Search **Pro** SKU に
// 該当する(displayName/formattedAddress/location は Pro。Essentials は place の ID のみで、レスポンスに
// 複数階級のフィールドが混在すると**最高位 SKU で課金**される)。Pro の無料枠は月 5,000 コール、超過は
// $9.60〜25.60/1,000(developers.google.com/maps/billing-and-pricing/pricing・同日確認)。
// 【Why not: FieldMask に安易にフィールドを足さない】photos を足しても Pro のままだが、Enterprise 系
// フィールド(例: reviews / editorialSummary)を足すと課金階級が Enterprise へ跳ねる。structuredLocation の
// 素材は title/address/geo の3点で足りるので、SKU を上げる誘惑に乗らない(必要になったら SKU への
// 影響を SKU 表で確認してから足すこと)。Google 固有のレスポンス形もこのファイル1箇所に閉じ込める
// (GeocodingPort の語彙 title/address/geo へ即座に写す)。
//
// 【キー未設定の縮退(GeocodingNotConfiguredError)】
// GOOGLE_MAPS_API_KEY は secrets.required に載せるが、キー未設定でも Worker 起動・他ツールは正常で
// なければならない(app.ts の wiring コメント参照)。よってアダプタは空キーでも構築でき、
// searchLocation を呼んだ瞬間だけ GeocodingNotConfiguredError を投げる(CONFIRM_SECRET と同じ縮退)。
//
// 【fetch を注入可能にする(テスト容易性)】
// Workers の global fetch をそのまま使うと単体テストで写像・エラー系を検証しづらい。コンストラクタで
// fetch を差し替えられるようにし、テストはスタブ fetch でレスポンス JSON / 非 200 / 壊れた JSON を
// 与えて写像と degrade を固定する(google-places-geocoding.test.ts)。
// =============================================================================

import type { GeocodingPort, LocationCandidate, SearchLocationOptions } from "../../application/ports";
import { GeocodingNotConfiguredError } from "../../application/ports";

// Text Search (New) のエンドポイント(公式 v1)。POST + JSON body + X-Goog-* ヘッダで叩く。
const PLACES_SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

// Field Mask: 必要3項目だけ(ファイル冒頭「Field Mask」コメント参照)。places. プレフィックスは
// searchText レスポンスの places[] 配列要素に対する射影。
const FIELD_MASK = "places.displayName,places.formattedAddress,places.location";

// 既定の返却件数上限。ベンチは上位候補で曖昧解消できることを確認済み(raw_count 複数が判定材料)。
// 多すぎるとモデルが選びにくく、少なすぎると「品川の叙々苑」のような地域修飾クエリで正解を落とす。
// 5 は Google の Text Search が返す上位のうち実運用で十分な広さ(ベンチの q04/q06 も上位5件内に正解)。
const DEFAULT_MAX_RESULTS = 5;

// Google Places Text Search (New) のレスポンス形(必要フィールドだけを型に起こす。FieldMask で
// 絞っているので places 要素はこの3フィールドのみ来る想定だが、欠落に耐えるよう全て optional)。
interface PlacesSearchTextResponse {
	places?: Array<{
		displayName?: { text?: string };
		formattedAddress?: string;
		location?: { latitude?: number; longitude?: number };
	}>;
}

export class GooglePlacesGeocodingAdapter implements GeocodingPort {
	constructor(
		// 空文字は「キー未設定」を意味する(env.GOOGLE_MAPS_API_KEY ?? "" で渡す)。searchLocation 時に
		// 空なら GeocodingNotConfiguredError(起動時ではなく呼び出し時 — ファイル冒頭の縮退方針)。
		private readonly apiKey: string,
		// fetch を注入可能に(テスト容易性)。既定は Workers global fetch。
		// 2026-07-23 本番 FAIL 修正: `= fetch` の素の関数参照はダメ。class フィールドに格納して
		// `this.fetchImpl(...)` で呼ぶと receiver が adapter インスタンスになり、workerd の fetch は
		// `this` が globalThis でないと "Illegal invocation" を投げる(Inspector E2E で全クエリ失敗)。
		// bun test のスタブ fetch は this を見ないため green で、本番だけ落ちる典型パターン。
		// `.bind(globalThis)` ではなくアロー括りにしたのは、ブラウザ/Node/workerd いずれでも同義で
		// 束縛意図が見た目に残るため。
		private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
	) {}

	async searchLocation(query: string, opts?: SearchLocationOptions): Promise<LocationCandidate[]> {
		if (this.apiKey === "") throw new GeocodingNotConfiguredError();

		const maxResultCount = opts?.limit ?? DEFAULT_MAX_RESULTS;
		const response = await this.fetchImpl(PLACES_SEARCH_TEXT_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// 認証は API キーヘッダ(OAuth ではない)。X-Goog-FieldMask で射影を絞る(必須 —
				// FieldMask 未指定だと Text Search (New) は 400 を返す仕様)。
				"X-Goog-Api-Key": this.apiKey,
				"X-Goog-FieldMask": FIELD_MASK,
			},
			// languageCode/regionCode を日本固定にする(単一ユーザーの iOS 運用。ベンチも ja/JP で実施)。
			// 将来 SearchLocationOptions に言語/地域を足すならここで上書きする(今は seam のみ)。
			body: JSON.stringify({ textQuery: query, languageCode: "ja", regionCode: "JP", maxResultCount }),
		});

		if (!response.ok) {
			// 非 200 は「解決失敗」ではなく「プロバイダ側のエラー(キー無効・レート制限・障害)」。
			// 空配列に丸めると呼び出し側が「0 件」と誤認するので、明示的に throw して search-location の
			// catch が「解決に失敗しました」系メッセージへ変換する(errKind で HTTP エラーを区別可能に)。
			// 本文はメッセージに載せない(API キー等がエコーされる可能性 — telemetry の規律と同じ)。
			throw new Error(`google places searchText failed: HTTP ${response.status}`);
		}

		// 壊れた JSON はここで例外になる(呼び出し側 catch が拾う)。degrade はフィールド欠落に対して行い、
		// レスポンス全体が壊れているケースは「プロバイダ異常」として throw に倒す(0 件と区別する)。
		const json = (await response.json()) as PlacesSearchTextResponse;
		const places = json.places ?? [];

		const candidates: LocationCandidate[] = [];
		for (const place of places) {
			const lat = place.location?.latitude;
			const lon = place.location?.longitude;
			// geo は候補の最低要件(GeocodingPort の契約)。座標が取れない要素は候補から落とす
			// (title/address だけの候補を返しても structuredLocation の geo にはならず、degrade 経路と
			// 二重になって紛らわしい)。
			if (typeof lat !== "number" || typeof lon !== "number") continue;
			candidates.push({
				// displayName.text が無い(ありえないが FieldMask 変更等で欠落)場合は住所を、住所も無ければ
				// クエリ自体を title に使う(空 title の候補を作らない — 選択時に表示名が空になるのを防ぐ)。
				title: place.displayName?.text ?? place.formattedAddress ?? query,
				address: place.formattedAddress ?? null,
				geo: { lat, lon },
			});
		}
		return candidates;
	}
}
