// =============================================================================
// test/presentation/mcp-location-view.test.ts — 場所/会議/参照 URL の描画判断(location-view.ts)の
//                                                境界値テスト(C2・設計 05 §2 の3スロット意味モデル)
// =============================================================================
// 【何を保証するか(What)】C1(structured-location.ts)が派生させた3スロットを、カード行に
// 「何を・どの文言で出すか」へ写す純関数(location-view.ts)の判断を DOM 無しで固定する:
//   - resolveLocationTitle: structuredLocation.title 優先 → LOCATION 先頭行 degrade → null。
//   - agendaInlineBadge   : 会議優先(🎥参加)→ 場所(📍タイトル)→ null(inline は主要1つ)。
//   - showReferenceUrl    : conference.source==="url" のときだけ 🔗 を出さない(二重回避)。
//   - proximityBadge      : ARRIVE/DEPART の文言 + title 欠落時の「位置情報の通知」degrade。
// 描画(DOM)側は *-entry.ts の applyInlineFold と同じく純関数レベルでは検証しないので、
// ここでは「判断の式」を固定するに留める(fold.ts のテストと同じ流儀)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import {
	type ConferenceView,
	type ProximityAlarmView,
	type StructuredLocationView,
	agendaInlineBadge,
	proximityBadge,
	resolveLocationTitle,
	showReferenceUrl,
} from "../../src/presentation/mcp/ui/location-view";

/** テスト用の構造化場所を作る小ヘルパー(欠けたフィールドは null で埋める)。 */
function loc(partial: Partial<StructuredLocationView>): StructuredLocationView {
	return { title: null, address: null, geo: null, radiusMeters: null, ...partial };
}

describe("resolveLocationTitle", () => {
	test("structuredLocation.title を最優先で使う", () => {
		expect(resolveLocationTitle(loc({ title: "岐阜大学" }), "岐阜大学\n岐阜県岐阜市柳戸1-1")).toBe("岐阜大学");
	});

	test("title が無ければ LOCATION の先頭行へ degrade(住所全文は出さない)", () => {
		expect(resolveLocationTitle(loc({ title: null }), "スターバックス\n岐阜県...")).toBe("スターバックス");
	});

	test("structuredLocation 自体が null でも LOCATION 先頭行を使う", () => {
		expect(resolveLocationTitle(null, "会議室A\n本館3F")).toBe("会議室A");
	});

	test("title が空白のみなら LOCATION へ落ちる(空文字は無視)", () => {
		expect(resolveLocationTitle(loc({ title: "   " }), "現地集合")).toBe("現地集合");
	});

	test("どちらも無ければ null(📍 を出さない)", () => {
		expect(resolveLocationTitle(null, null)).toBeNull();
		expect(resolveLocationTitle(loc({ title: null }), "")).toBeNull();
	});
});

describe("agendaInlineBadge", () => {
	const conf: ConferenceView = { url: "https://meet.google.com/abc", source: "description" };

	test("会議があれば場所より優先して 🎥参加 を出す", () => {
		expect(agendaInlineBadge(conf, loc({ title: "岐阜大学" }), "岐阜大学")).toEqual({ kind: "conference" });
	});

	test("会議が無く場所があれば 📍タイトルを出す", () => {
		expect(agendaInlineBadge(null, loc({ title: "岐阜大学" }), null)).toEqual({ kind: "location", title: "岐阜大学" });
	});

	test("会議が無く structuredLocation も無いが LOCATION があれば先頭行を出す", () => {
		expect(agendaInlineBadge(null, null, "会議室A\n本館")).toEqual({ kind: "location", title: "会議室A" });
	});

	test("会議も場所も無ければ null", () => {
		expect(agendaInlineBadge(null, null, null)).toBeNull();
	});
});

describe("showReferenceUrl", () => {
	test("conference.source==='url'(URL が参加ボタンに化けている)は 🔗 を出さない(二重回避)", () => {
		const conf: ConferenceView = { url: "https://meet.google.com/abc", source: "url" };
		expect(showReferenceUrl("https://meet.google.com/abc", conf)).toBe(false);
	});

	test("conference.source==='description'(URL 側は参照リンク)は 🔗 を出す", () => {
		const conf: ConferenceView = { url: "https://meet.google.com/abc", source: "description" };
		expect(showReferenceUrl("message:%3C...%3E", conf)).toBe(true);
	});

	test("会議なし(conference===null)で URL が残っていれば 🔗 を出す", () => {
		expect(showReferenceUrl("https://example.com/invite", null)).toBe(true);
	});

	test("message: 等の非 http も生値で出す方向に渡す(スキームで弾かない)", () => {
		expect(showReferenceUrl("message:%3Cabc@amazonses.com%3E", null)).toBe(true);
	});

	test("URL が null / 空なら出さない", () => {
		expect(showReferenceUrl(null, null)).toBe(false);
		expect(showReferenceUrl("  ", null)).toBe(false);
	});
});

describe("proximityBadge", () => {
	test("ARRIVE + title は「<title>に到着時」", () => {
		const p: ProximityAlarmView = { proximity: "ARRIVE", location: loc({ title: "福登の自宅" }) };
		expect(proximityBadge(p).text).toBe("福登の自宅に到着時");
	});

	test("DEPART + title は「<title>から出発時」", () => {
		const p: ProximityAlarmView = { proximity: "DEPART", location: loc({ title: "オフィス" }) };
		expect(proximityBadge(p).text).toBe("オフィスから出発時");
	});

	test("title が null なら「位置情報の通知」へ degrade(握りつぶさず可視化)", () => {
		const p: ProximityAlarmView = { proximity: "ARRIVE", location: loc({ title: null, geo: { lat: 35, lon: 136 } }) };
		expect(proximityBadge(p).text).toBe("位置情報の通知");
	});

	test("aria は 📍 を「位置情報」と読み下す", () => {
		const p: ProximityAlarmView = { proximity: "ARRIVE", location: loc({ title: "自宅" }) };
		expect(proximityBadge(p).aria).toBe("位置情報 自宅に到着時");
	});
});
