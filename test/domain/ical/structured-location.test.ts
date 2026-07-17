// =============================================================================
// structured-location ユニットテスト — 場所 / proximity / 会議 の read 派生(C1・設計 05 §1)
// =============================================================================
// 設計 05 §1 の「本番 D1 生 ICS」実データ(3種: 自宅到着 VTODO / 岐阜大学 VEVENT / paiza 招待
// VEVENT)をフィクスチャに、structured-location.ts の純関数(readStructuredLocation /
// readProximityAlarm / readConference)の round-trip を検証する。line folding・QUOTED X-ADDRESS・
// 壊れ値 degrade も網羅する(テスト=What: この派生が何を保証するか)。
import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/domain/ical";
import type { Component } from "../../../src/domain/ical/structure/types";
import {
	readConference,
	readProximityAlarm,
	readStructuredLocation,
} from "../../../src/domain/ical/semantics";

// VCALENDAR 1枚 + 指定行の単一コンポーネントを組み、その中身 Component を返す。
// name は "VEVENT" | "VTODO"。parse は CRLF 前提なので "\r\n" で連結する(line folding も
// 物理行を "\r\n" で区切り継続行の先頭に空白を置くことで再現する)。
function firstChild(name: string, lines: string[]): Component {
	const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", `BEGIN:${name}`, ...lines, `END:${name}`, "END:VCALENDAR"].join(
		"\r\n",
	);
	const root = parse(ics);
	return root.components.find((c) => c.name === name)!;
}

describe("readStructuredLocation: 岐阜大学 VEVENT(設計 05 §1-b)", () => {
	// 実データを line folding して与える(1論理行を CRLF+空白で複数物理行に折る)。
	// 継続行は先頭に1個の空白を置く(§3.1)。unfold が連結して1つの X-APPLE-STRUCTURED-LOCATION に戻す。
	const vevent = firstChild("VEVENT", [
		"UID:e-gifu",
		"DTSTAMP:20260717T000000Z",
		"DTSTART:20260718T010000Z",
		"SUMMARY:岐阜大学で会議",
		"LOCATION:岐阜大学\\n501-1112\\n岐阜県 岐阜市\\n柳戸1-1\\n日本",
		// 折り返し: X-ADDRESS の "\n" はパラメータ値中のバックスラッシュエスケープ(住所の複数行)。
		"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=501-1112\\n岐阜県 岐阜市\\n柳戸1-1\\n日",
		" 本;X-APPLE-RADIUS=100;X-TITLE=岐阜大学:geo:35.463012,136.737202",
	]);

	test("title / geo / radius を派生する", () => {
		const loc = readStructuredLocation(vevent);
		expect(loc).not.toBeNull();
		expect(loc!.title).toBe("岐阜大学");
		expect(loc!.geo).toEqual({ lat: 35.463012, lon: 136.737202 });
		expect(loc!.radiusMeters).toBe(100);
	});

	test("X-ADDRESS の \\n エスケープを decode して実改行に戻す(line folding 越え)", () => {
		const loc = readStructuredLocation(vevent);
		// 折り返しで "日本" が分断されていても unfold で連結され、"\n" は改行に decode される。
		expect(loc!.address).toBe("501-1112\n岐阜県 岐阜市\n柳戸1-1\n日本");
	});
});

describe("readStructuredLocation: QUOTED な X-ADDRESS", () => {
	test("引用符で囲まれた住所(カンマ入り)を1値として読む", () => {
		const vevent = firstChild("VEVENT", [
			"UID:e-quoted",
			"DTSTAMP:20260717T000000Z",
			"DTSTART:20260718T010000Z",
			"SUMMARY:引用住所",
			// QUOTED: カンマを含むため DQUOTE で囲む。parser が DQUOTE を剥がし1値にする。
			'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="〒501-1132, 岐阜県岐阜市";X-TITLE=某所:geo:35.4,136.7',
		]);
		const loc = readStructuredLocation(vevent);
		expect(loc!.address).toBe("〒501-1132, 岐阜県岐阜市");
		expect(loc!.title).toBe("某所");
		expect(loc!.geo).toEqual({ lat: 35.4, lon: 136.7 });
	});
});

describe("readStructuredLocation: 未設定・壊れ値 degrade", () => {
	test("プロパティ自体が無ければ null", () => {
		const vevent = firstChild("VEVENT", ["UID:e0", "DTSTAMP:20260717T000000Z", "DTSTART:20260718T010000Z", "SUMMARY:場所なし"]);
		expect(readStructuredLocation(vevent)).toBeNull();
	});

	test("壊れた geo 値でも throw せず geo:null に degrade(他フィールドは温存)", () => {
		const vevent = firstChild("VEVENT", [
			"UID:e-broken",
			"DTSTAMP:20260717T000000Z",
			"DTSTART:20260718T010000Z",
			"SUMMARY:壊れ座標",
			// 値が geo URI でない(壊れ)。title は読めるので温存する。
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=どこか:not-a-geo-uri",
		]);
		const loc = readStructuredLocation(vevent);
		expect(loc).not.toBeNull();
		expect(loc!.geo).toBeNull();
		expect(loc!.title).toBe("どこか");
		expect(loc!.radiusMeters).toBeNull();
	});
});

describe("readProximityAlarm: 自宅到着 VTODO(設計 05 §1-a)", () => {
	// 番兵 TRIGGER + X-APPLE-PROXIMITY:ARRIVE + VALARM 内 structured-location。折り返しあり。
	const vtodo = firstChild("VTODO", [
		"UID:t-home",
		"DTSTAMP:20260717T000000Z",
		"SUMMARY:自宅に到着時に通知",
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
		"X-APPLE-PROXIMITY:ARRIVE",
		"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-APPLE-REFERENCEFRAME=1;",
		" X-TITLE=福登の自宅:geo:35.017639,136.954547",
		"END:VALARM",
	]);

	test("proximity=ARRIVE と VALARM 内 location(座標/タイトル/半径)を派生する", () => {
		const prox = readProximityAlarm(vtodo);
		expect(prox).not.toBeNull();
		expect(prox!.proximity).toBe("ARRIVE");
		expect(prox!.location.title).toBe("福登の自宅");
		expect(prox!.location.geo).toEqual({ lat: 35.017639, lon: 136.954547 });
		expect(prox!.location.radiusMeters).toBe(100);
	});

	test("DEPART も読める", () => {
		const departVtodo = firstChild("VTODO", [
			"UID:t-depart",
			"DTSTAMP:20260717T000000Z",
			"SUMMARY:出発時に通知",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
			"X-APPLE-PROXIMITY:DEPART",
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=会社:geo:35.6,139.7",
			"END:VALARM",
		]);
		expect(readProximityAlarm(departVtodo)!.proximity).toBe("DEPART");
	});

	test("proximity を持たない時刻 VALARM は無視して null(既存 alarms と非干渉)", () => {
		const timeVtodo = firstChild("VTODO", [
			"UID:t-time",
			"DTSTAMP:20260717T000000Z",
			"SUMMARY:時刻通知のみ",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER:-PT15M",
			"END:VALARM",
		]);
		expect(readProximityAlarm(timeVtodo)).toBeNull();
	});
});

describe("readConference: paiza 招待 VEVENT(設計 05 §1-c)", () => {
	test("DESCRIPTION の「ビデオ通話」ブロック内 URL を会議(source:description)にする", () => {
		// URL は message: スキーム(参照リンク)。会議は DESCRIPTION 内のブロック。
		const url = "message:%3Cabc@amazonses.com%3E?c=xyz";
		const notes = "面談のお知らせです。\n----( ビデオ通話 )----\nhttps://meet.google.com/xpk-yooe-eev\n---===---\nよろしく";
		const conf = readConference(url, notes);
		expect(conf).toEqual({ url: "https://meet.google.com/xpk-yooe-eev", source: "description" });
	});

	test("英語ブロック(Video Call)も認識する", () => {
		const notes = "----( Video Call )----\nhttps://zoom.us/j/123\n---===---";
		expect(readConference(null, notes)).toEqual({ url: "https://zoom.us/j/123", source: "description" });
	});

	test("ブロック無し + URL が http(s) 直入れ → 会議(source:url)", () => {
		expect(readConference("https://meet.google.com/abc", null)).toEqual({ url: "https://meet.google.com/abc", source: "url" });
	});

	test("任意ドメイン(x.com)も会議になる(ホワイトリスト判定しない・設計 05 §1-c)", () => {
		expect(readConference("https://x.com", null)).toEqual({ url: "https://x.com", source: "url" });
	});

	test("非 http(message: スキーム)は会議ではない → null(参照 URL のまま)", () => {
		expect(readConference("message:%3Cabc@amazonses.com%3E", "ただの説明文")).toBeNull();
	});

	test("URL も notes も会議シグナル無し → null", () => {
		expect(readConference(null, "ただのメモ")).toBeNull();
	});

	test("ブロック優先: DESCRIPTION ブロックと http URL が両方あればブロック側を採る", () => {
		// URL プロパティも http だが、DESCRIPTION の会議ブロックが優先(paiza 型は URL=参照でないが、
		// 両方 http のときの優先順位を明示する)。
		const conf = readConference("https://example.com/invite", "----( ビデオ通話 )----\nhttps://meet.google.com/zzz\n---===---");
		expect(conf).toEqual({ url: "https://meet.google.com/zzz", source: "description" });
	});
});
