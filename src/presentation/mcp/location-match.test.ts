import { describe, expect, it } from "bun:test";
import { LOCATION_MATCH_THRESHOLD, locationMatchScore, normalizeForMatch } from "./location-match";

// =============================================================================
// #locationMatchQuality: locationMatchScore/normalizeForMatch のテスト。
// =============================================================================
// 通す/弾くコーパスは docs/research/geocoding-bench-2026-07-23.md の q01〜q18(Google Places の
// 実応答)と、本番受け入れで見つかったゴミクエリの実例(「まったく存在しない架空ZZZ検証場所」→
// 「魚彩ダイニングまったく」京都)をそのまま固定する(bench 生成時のクエリ→応答を丸写しし、
// テストと bench ドキュメントの数値がズレないようにする)。

describe("normalizeForMatch", () => {
	it("全角英数・記号・空白・郵便記号を除去し小文字化する", () => {
		expect(normalizeForMatch("〒１００−０００５ 東京都　千代田区")).toBe("東京都千代田区");
	});

	it("長音符(ー)を除去する(スタバ⇄スターバックスの短縮形一致のため)", () => {
		expect(normalizeForMatch("スターバックス")).toBe(normalizeForMatch("スタバックス"));
	});

	it("句読点・記号(中黒等)を除去する", () => {
		expect(normalizeForMatch("ドン・キホーテ")).toBe("ドンキホテ");
	});
});

describe("locationMatchScore: 境界値", () => {
	it("正規化後2文字未満のクエリは判定不能として1.0を返す(false reject回避)", () => {
		expect(locationMatchScore("駅", "全く無関係などこかの店", "遠い住所")).toBe(1.0);
		expect(locationMatchScore("", "何でもいい", null)).toBe(1.0);
	});

	it("完全一致は1.0", () => {
		expect(locationMatchScore("東京駅", "東京駅", "東京都千代田区丸の内1丁目9")).toBe(1.0);
	});

	it("バイグラムが1件も一致しなければ0", () => {
		expect(locationMatchScore("abcdef", "全く無関係などこかの店", "無関係な住所")).toBe(0);
	});
});

describe("locationMatchScore: 通すべきコーパス(bench q01〜q18)", () => {
	// [クエリ, title, address] の18件。docs/research/geocoding-bench-2026-07-23.md のマトリクスから
	// Google Places 列(名称/住所)をそのまま転記。
	const cases: [string, string, string][] = [
		["東京駅", "東京駅", "〒100-0005 東京都千代田区丸の内１丁目９"],
		["渋谷スクランブルスクエア", "渋谷スクランブルスクエア", "〒150-0002 東京都渋谷区渋谷２丁目２４−１２"],
		["東京ドーム", "東京ドーム", "〒112-0004 東京都文京区後楽１丁目３−６１"],
		["品川の叙々苑", "叙々苑 品川プリンスホテル店", "〒108-0074 東京都港区高輪４丁目１０−３０ Ｎタワー 1F 品川プリンスホテル"],
		["新宿の紀伊國屋書店", "紀伊國屋書店 新宿本店", "〒160-0022 東京都新宿区新宿３丁目１７−７"],
		["岐阜駅前のスタバ", "スターバックス コーヒー ASTY岐阜店", "〒500-8856 岐阜県岐阜市橋本町１丁目10−１ ASTY岐阜 3F"],
		["スターバックス 渋谷", "スターバックス コーヒー 渋谷マークシティ店", "〒150-0043 東京都渋谷区道玄坂１丁目１２−３ 渋谷マークシティ イースト 3F"],
		["ドン・キホーテ 名古屋", "MEGAドン・キホーテ 名古屋本店", "〒462-0018 愛知県名古屋市北区玄馬町２３４−１"],
		["岐阜市役所", "岐阜市役所", "〒500-8701 岐阜県岐阜市司町４０−１"],
		["慶應義塾大学 三田キャンパス", "慶應義塾大学", "〒108-0073 東京都港区三田２丁目１５−４５"],
		["東京都渋谷区道玄坂2-1-1", "道玄坂２丁目１−１", "〒150-0043 東京都都渋谷区道玄坂２丁目１−１"],
		["岐阜県岐阜市橋本町1丁目10-1", "橋本町１丁目１０−１", "〒500-8856 岐阜県岐阜市橋本町１丁目１０−１"],
		["千代田区丸の内1丁目", "１丁目", "〒100-0005 東京都千代田区丸の内１丁目"],
		["品川プリンスホテルのロビー", "品川プリンスホテル", "〒108-8611 東京都港区高輪４丁目１０−３０"],
		["羽田空港第2ターミナル", "羽田空港 第2旅客ターミナル", "〒144-0041 東京都大田区羽田空港３丁目４−２ 羽田空港 第2旅客ターミナル"],
		["京都駅", "京都駅", "〒600-8216 京都府京都市下京区東塩小路釜殿町"],
		["大阪城", "大阪城", "〒540-0002 大阪府大阪市中央区大阪城１−１"],
		["六本木ヒルズ森タワー", "六本木ヒルズ森タワー", "〒106-0032 東京都港区六本木６丁目１０−１"],
	];

	for (const [id, [query, title, address]] of cases.entries()) {
		it(`q${String(id + 1).padStart(2, "0")}「${query}」→「${title}」は閾値以上`, () => {
			expect(locationMatchScore(query, title, address)).toBeGreaterThanOrEqual(LOCATION_MATCH_THRESHOLD);
		});
	}

	it("「品川のホテルの叙々苑」→「叙々苑 品川プリンスホテル店」は閾値以上(既知の言い換え)", () => {
		const score = locationMatchScore(
			"品川のホテルの叙々苑",
			"叙々苑 品川プリンスホテル店",
			"〒108-0074 東京都港区高輪４丁目１０−３０ Ｎタワー 1F 品川プリンスホテル",
		);
		expect(score).toBeGreaterThanOrEqual(LOCATION_MATCH_THRESHOLD);
	});
});

describe("locationMatchScore: 弾くべきコーパス", () => {
	it("本番受け入れで見つかった実例: 架空クエリ→無関係な京都の店は閾値未満", () => {
		// #51 の本番受け入れ FAIL の再現ケースそのもの(このケースを弾けることがこのゲートの存在意義)。
		const score = locationMatchScore("まったく存在しない架空ZZZ検証場所", "魚彩ダイニングまったく", "京都府京都市");
		expect(score).toBeLessThan(LOCATION_MATCH_THRESHOLD);
	});

	it("ランダムな英字ゴミクエリ→任意の実在候補は閾値未満", () => {
		const score = locationMatchScore("asdfgh zzz", "東京駅", "〒100-0005 東京都千代田区丸の内１丁目９");
		expect(score).toBeLessThan(LOCATION_MATCH_THRESHOLD);
	});
});
