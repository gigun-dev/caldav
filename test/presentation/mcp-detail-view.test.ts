// =============================================================================
// test/presentation/mcp-detail-view.test.ts — 予定「詳細(閲覧)ページ」の表示項目(detail-view.ts)の
//                                              境界値テスト(#44 実機FB「イベントタップ=詳細ファースト」)
// =============================================================================
// 【何を保証するか(What)】一覧行タップで開く読み取り専用の詳細ページに、どの URL 行を・どの日時文言を
// 出すかを決める純関数の判断を DOM 無しで固定する:
//   - detailUrlRows    : 会議 URL(先)→ 参照 URL(showReferenceUrl の二重回避に従う)の順・空URL除外。
//   - formatDetailWhen : 終日/時刻付き・同日/別日・終了なし の各分岐の1行整形。
//   - chooseCopyStrategy: clipboard API 有無での degrade 分岐。
// DOM(開く/コピーの副作用)は entry 側の責務なので純関数レベルでは検証しない(location-view.ts テストと同流儀)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import {
	chooseCopyStrategy,
	detailUrlRows,
	formatDetailWhen,
} from "../../src/presentation/mcp/ui/detail-view";
import type { ConferenceView } from "../../src/presentation/mcp/ui/location-view";

const conf = (url: string, source: "url" | "description"): ConferenceView => ({ url, source });

describe("detailUrlRows", () => {
	test("会議も参照も無ければ空", () => {
		expect(detailUrlRows(null, null)).toEqual([]);
	});

	test("会議のみ(source=url)は会議行だけ・参照は二重回避で出さない", () => {
		// conference.source==="url" は URL が既に「参加」に化けているので、同じ url を参照でも出さない。
		expect(detailUrlRows("https://zoom.example/x", conf("https://zoom.example/x", "url"))).toEqual([
			{ kind: "conference", url: "https://zoom.example/x" },
		]);
	});

	test("会議(source=description)+ 別の参照 URL は両方・会議が先", () => {
		expect(detailUrlRows("https://ref.example/doc", conf("https://meet.example/y", "description"))).toEqual([
			{ kind: "conference", url: "https://meet.example/y" },
			{ kind: "reference", url: "https://ref.example/doc" },
		]);
	});

	test("会議なし・参照 URL のみ", () => {
		expect(detailUrlRows("https://ref.example/doc", null)).toEqual([{ kind: "reference", url: "https://ref.example/doc" }]);
	});

	test("空/空白の会議 URL は死にリンクを作らないため落とす", () => {
		expect(detailUrlRows(null, conf("   ", "description"))).toEqual([]);
	});

	test("message: 等の非 http スキームも参照として渡す(開けるかはホスト判断)", () => {
		expect(detailUrlRows("message://guid", null)).toEqual([{ kind: "reference", url: "message://guid" }]);
	});
});

describe("formatDetailWhen", () => {
	test("終日・単日", () => {
		expect(formatDetailWhen("2026-07-16", null, true)).toBe("7/16(木) 終日");
	});

	test("終日・複数日(開始日〜終了日)", () => {
		expect(formatDetailWhen("2026-07-16", "2026-07-18", true)).toBe("7/16(木) 〜 7/18(土) 終日");
	});

	test("終日・開始日==終了日は単日表示に畳む", () => {
		expect(formatDetailWhen("2026-07-16", "2026-07-16", true)).toBe("7/16(木) 終日");
	});

	test("時刻付き・同日は終了を時刻だけ", () => {
		expect(formatDetailWhen("2026-07-16T19:00:00+09:00", "2026-07-16T20:30:00+09:00", false)).toBe(
			"7/16(木) 19:00 〜 20:30",
		);
	});

	test("時刻付き・別日は終了側に日付を添える", () => {
		expect(formatDetailWhen("2026-07-16T23:00:00+09:00", "2026-07-17T08:00:00+09:00", false)).toBe(
			"7/16(木) 23:00 〜 7/17(金) 08:00",
		);
	});

	test("時刻付き・終了なしは開始のみ", () => {
		expect(formatDetailWhen("2026-07-16T19:00:00+09:00", null, false)).toBe("7/16(木) 19:00");
	});

	test("isAllDay=false でも start が日付だけなら終日として扱う", () => {
		// 契約上は isAllDay と start の T 有無は揃うが、片方だけ来ても崩れないことを固定する。
		expect(formatDetailWhen("2026-07-16", null, false)).toBe("7/16(木) 終日");
	});
});

describe("chooseCopyStrategy", () => {
	test("clipboard API があれば第一手段", () => {
		expect(chooseCopyStrategy(true)).toBe("clipboard-api");
	});
	test("無ければ execCommand フォールバック", () => {
		expect(chooseCopyStrategy(false)).toBe("exec-command");
	});
});
