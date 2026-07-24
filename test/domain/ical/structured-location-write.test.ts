// =============================================================================
// structured-location-write ユニットテスト(C8・設計 05 §1-b/§1-c)
// =============================================================================
// write(encode)は read(decode)の逆写像であることを検証する。C1 の structured-location.test.ts
// と対で、①1プロパティ単位の encode↔decode 往復、②DESCRIPTION 合成/分解(compose↔split)の往復、
// ③buildVEventCalendar 経由でのフル往復(実データ §1-b/§1-c の値を使う)を確認する。
import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/domain/ical";
import { serialize } from "../../../src/domain/ical/serialize/serializer";
import { ICalendarObject } from "../../../src/domain/ical/semantics";
import { buildVEventCalendar } from "../../../src/domain/ical/semantics/vevent-write";
import { patchVEventFields } from "../../../src/domain/ical/semantics/vevent-patch";
import {
	readConference,
	readStructuredLocation,
} from "../../../src/domain/ical/semantics/structured-location";
import {
	buildConferenceBlock,
	buildStructuredLocationProperty,
	composeDescriptionWithConference,
	splitConferenceFromDescription,
} from "../../../src/domain/ical/semantics/structured-location-write";

const NOW = { utcRaw: "20260718T000000Z", unixSeconds: 1784419200 };

describe("buildStructuredLocationProperty ↔ readStructuredLocation(1プロパティ往復)", () => {
	test("岐阜大学(設計 05 §1-b)相当の値が往復する", () => {
		const prop = buildStructuredLocationProperty({
			title: "岐阜大学",
			address: "501-1112\n岐阜県 岐阜市\n柳戸1-1\n日本",
			lat: 35.463012,
			lon: 136.737202,
			radius: 100,
		});
		const component = { name: "VEVENT" as const, properties: [prop], components: [] };
		const loc = readStructuredLocation(component);
		expect(loc).toEqual({
			title: "岐阜大学",
			address: "501-1112\n岐阜県 岐阜市\n柳戸1-1\n日本",
			geo: { lat: 35.463012, lon: 136.737202 },
			radiusMeters: 100,
		});
	});

	test("address/radius 省略時は書かれない(read も null に戻る)", () => {
		const prop = buildStructuredLocationProperty({ title: "某所", lat: 35.4, lon: 136.7 });
		expect(prop.parameters.find((p) => p.name === "X-ADDRESS")).toBeUndefined();
		expect(prop.parameters.find((p) => p.name === "X-APPLE-RADIUS")).toBeUndefined();
		const component = { name: "VEVENT" as const, properties: [prop], components: [] };
		const loc = readStructuredLocation(component);
		expect(loc!.address).toBeNull();
		expect(loc!.radiusMeters).toBeNull();
	});

	test("X-ADDRESS にカンマを含む住所は serializer が自動 DQUOTE 化しても往復する", () => {
		const prop = buildStructuredLocationProperty({ title: "某所", address: "〒501-1132, 岐阜県岐阜市", lat: 35.4, lon: 136.7 });
		const vevent = { name: "VEVENT" as const, properties: [{ name: "UID", parameters: [], value: "e1" }, prop], components: [] };
		const vcalendar = { name: "VCALENDAR" as const, properties: [{ name: "VERSION", parameters: [], value: "2.0" }], components: [vevent] };
		const ics = serialize(vcalendar);
		const reparsed = parse(ics);
		const reparsedVevent = reparsed.components.find((c) => c.name === "VEVENT")!;
		const loc = readStructuredLocation(reparsedVevent);
		expect(loc!.address).toBe("〒501-1132, 岐阜県岐阜市");
	});
});

describe("buildConferenceBlock(設計 05 §1-c) ↔ readConference", () => {
	test("生成したブロックを DESCRIPTION に埋めると readConference が会議として認識する", () => {
		const block = buildConferenceBlock({ url: "https://meet.google.com/xpk-yooe-eev" });
		expect(block).toBe("----( ビデオ通話 )----\nhttps://meet.google.com/xpk-yooe-eev\n---===---");
		const conf = readConference(null, block);
		expect(conf).toEqual({ url: "https://meet.google.com/xpk-yooe-eev", source: "description" });
	});
});

describe("composeDescriptionWithConference ↔ splitConferenceFromDescription(逆写像の往復)", () => {
	test("notes のみ", () => {
		const desc = composeDescriptionWithConference("お知らせです。", undefined);
		expect(desc).toBe("お知らせです。");
		expect(splitConferenceFromDescription(desc)).toEqual({ notes: "お知らせです。", conference: undefined });
	});

	test("conference のみ", () => {
		const desc = composeDescriptionWithConference(undefined, { url: "https://meet.google.com/abc" });
		expect(desc).toBe("----( ビデオ通話 )----\nhttps://meet.google.com/abc\n---===---");
		expect(splitConferenceFromDescription(desc)).toEqual({ notes: undefined, conference: "https://meet.google.com/abc" });
	});

	test("notes + conference(paiza 実例と同じ構造)", () => {
		const desc = composeDescriptionWithConference("面談のお知らせです。", { url: "https://meet.google.com/xpk-yooe-eev" });
		expect(desc).toBe("面談のお知らせです。\n\n----( ビデオ通話 )----\nhttps://meet.google.com/xpk-yooe-eev\n---===---");
		const split = splitConferenceFromDescription(desc);
		expect(split.notes).toBe("面談のお知らせです。");
		expect(split.conference).toBe("https://meet.google.com/xpk-yooe-eev");
	});

	test("何も無ければ undefined(DESCRIPTION 自体を書かない)", () => {
		expect(composeDescriptionWithConference(undefined, undefined)).toBeUndefined();
		expect(splitConferenceFromDescription(undefined)).toEqual({ notes: undefined, conference: undefined });
	});

	test("会議ブロックが本文の途中にある Apple 産 DESCRIPTION でも前後が空行1つで連結される(監査#4)", () => {
		// composeDescriptionWithConference は常に末尾追記(§1-c 裁定)なので、Apple 純正クライアント
		// 由来の「本文中間にブロックがある」形は手組みで再現する(splitConferenceFromDescription は
		// compose の生成物だけでなく、そういう実データも受理する必要がある — 上の関数コメント参照)。
		const block = buildConferenceBlock({ url: "https://meet.google.com/xpk-yooe-eev" });
		const desc = `前半の本文です。\n\n${block}\n\n後半の本文です。`;
		const { notes, conference } = splitConferenceFromDescription(desc);
		// 旧実装は before+after を区切りなしで連結し「前半の本文です。後半の本文です。」に潰れていた
		// (段落境界が消える事故)。修正後は空行1つを挟んで両パラグラフが判別可能なまま残る。
		expect(notes).toBe("前半の本文です。\n\n後半の本文です。");
		expect(conference).toBe("https://meet.google.com/xpk-yooe-eev");
	});

	test("会議ブロックを split で除去しても notes に余分な空行が残らない(繰り返し update での蓄積を防ぐ)", () => {
		const desc = composeDescriptionWithConference("本文", { url: "https://meet.google.com/abc" });
		const { notes } = splitConferenceFromDescription(desc);
		expect(notes).toBe("本文");
		// 除去後に再合成しても同じ結果になる(冪等)。
		const recomposed = composeDescriptionWithConference(notes, undefined);
		expect(recomposed).toBe("本文");
	});
});

describe("buildVEventCalendar: structuredLocation の author 規約(LOCATION も title で上書き)", () => {
	test("structuredLocation 指定時は LOCATION が title になり、X-APPLE-STRUCTURED-LOCATION が付く", () => {
		const component = buildVEventCalendar({
			uid: "ev-loc",
			now: NOW,
			summary: "岐阜大学で会議",
			start: { type: "DATE", raw: "20260718" },
			structuredLocation: { title: "岐阜大学", address: "岐阜県岐阜市柳戸1-1", lat: 35.463012, lon: 136.737202, radius: 100 },
		});
		const ics = serialize(component);
		const reparsed = ICalendarObject.fromComponent(parse(ics));
		expect(reparsed.validate()).toEqual([]);
		const ev = reparsed.events()[0]!;
		expect(ev.location).toBe("岐阜大学"); // encodeText 済み生値(エスケープ対象文字なし)。
		const loc = readStructuredLocation(ev.raw);
		// 2026-07-24 実機確認済み(本採用): VEVENT の X-APPLE-STRUCTURED-LOCATION は X-ADDRESS を
		// 書かない(X-ADDRESS があると iOS カレンダーの地図が壊れる実機挙動を確認・ical-generator #236
		// の報告と一致)。input に address: "岐阜県岐阜市柳戸1-1" を渡していても出力からは消える
		// (地図表示を成立させるための必須トレードオフ)。radius は入力どおり 100。
		expect(loc).toEqual({
			title: "岐阜大学",
			address: null,
			geo: { lat: 35.463012, lon: 136.737202 },
			radiusMeters: 100,
		});
	});

	test("2026-07-24 実機確認済み: X-APPLE-STRUCTURED-LOCATION が X-ADDRESS 無し・X-APPLE-RADIUS=100 のバイト列になる(iOS カレンダーで地図表示 PASS)", () => {
		// 実機(iOS カレンダー)で handle 無しでも地図が出た最小形式: X-TITLE + geo: + X-APPLE-RADIUS
		// のみ・X-ADDRESS 無し(ical-generator #236 の報告と一致)。
		const component = buildVEventCalendar({
			uid: "ev-loc-236",
			now: NOW,
			summary: "岐阜大学で会議",
			start: { type: "DATE", raw: "20260718" },
			structuredLocation: { title: "岐阜大学", address: "岐阜県岐阜市柳戸1-1", lat: 35.4651333, lon: 136.7372096 },
		});
		const ics = serialize(component);
		const line = ics
			.split(/\r\n/)
			.reduce((acc: string[], l) => {
				// unfold(継続行の先頭スペースを連結)してから検索する — serializer が長い行を折り返すため。
				if (l.startsWith(" ") && acc.length > 0) acc[acc.length - 1] += l.slice(1);
				else acc.push(l);
				return acc;
			}, [])
			.find((l) => l.startsWith("X-APPLE-STRUCTURED-LOCATION"));
		expect(line).toBe(
			"X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=岐阜大学;X-APPLE-RADIUS=100:geo:35.4651333,136.7372096",
		);
	});

	test("location と structuredLocation を両方渡すと structuredLocation.title が LOCATION を上書きする(後勝ち規約)", () => {
		const component = buildVEventCalendar({
			uid: "ev-loc2",
			now: NOW,
			summary: "テスト",
			start: { type: "DATE", raw: "20260718" },
			location: "自由記述の場所",
			structuredLocation: { title: "確定した場所", lat: 1, lon: 2 },
		});
		const ev = ICalendarObject.fromComponent(component).events()[0]!;
		expect(ev.location).toBe("確定した場所");
	});
});

describe("patchVEventFields: structuredLocation の三値 patch", () => {
	function buildBase() {
		return buildVEventCalendar({
			uid: "ev-patch",
			now: NOW,
			summary: "元の予定",
			start: { type: "DATE", raw: "20260718" },
			location: "元の場所",
			structuredLocation: { title: "元の場所", lat: 35.0, lon: 136.0, radius: 50 },
		});
	}

	test("null 指定で X-APPLE-STRUCTURED-LOCATION だけ除去し、LOCATION テキストは温存する", () => {
		const calendar = buildBase();
		const vevent = ICalendarObject.fromComponent(calendar).events()[0]!.raw;
		const patched = patchVEventFields(vevent, { structuredLocation: null });
		expect(readStructuredLocation(patched)).toBeNull();
		expect(patched.properties.find((p) => p.name === "LOCATION")?.value).toBe("元の場所");
	});

	test("新しい StructuredLocationInput で設定すると LOCATION も X-APPLE-STRUCTURED-LOCATION も差し替わる", () => {
		const calendar = buildBase();
		const vevent = ICalendarObject.fromComponent(calendar).events()[0]!.raw;
		const patched = patchVEventFields(vevent, { structuredLocation: { title: "新しい場所", lat: 10, lon: 20 } });
		expect(patched.properties.find((p) => p.name === "LOCATION")?.value).toBe("新しい場所");
		// 2026-07-24 実機確認済み: radius 未指定でも VEVENT 側は既定 100 を補完して書く
		// (defaultRadiusMeters。実機で「効いた」最小形式が X-APPLE-RADIUS を常に持つため)。
		expect(readStructuredLocation(patched)).toEqual({
			title: "新しい場所",
			address: null,
			geo: { lat: 10, lon: 20 },
			radiusMeters: 100,
		});
	});

	test("undefined(省略)は既存の構造化場所を変更しない", () => {
		const calendar = buildBase();
		const vevent = ICalendarObject.fromComponent(calendar).events()[0]!.raw;
		const patched = patchVEventFields(vevent, { summary: "タイトルだけ変更" });
		expect(readStructuredLocation(patched)!.title).toBe("元の場所");
	});

	// #45 スライス B: geo 無しの設定 = degrade。LOCATION に title(+住所)を書き、既存の
	// X-APPLE-STRUCTURED-LOCATION(古い座標)は除去する(残留すると別地点のピンが残る)。
	test("geo 無しの StructuredLocationInput で設定すると degrade(LOCATION に住所併記・X-APPLE-STRUCTURED-LOCATION 除去)", () => {
		const calendar = buildBase();
		const vevent = ICalendarObject.fromComponent(calendar).events()[0]!.raw;
		const patched = patchVEventFields(vevent, { structuredLocation: { title: "住所だけの場所", address: "岐阜県岐阜市柳戸1-1" } });
		// 古い座標(X-APPLE-STRUCTURED-LOCATION)は消える。
		expect(readStructuredLocation(patched)).toBeNull();
		// LOCATION は title + 住所を改行で併記(structuredLocationDegradeText)。
		expect(patched.properties.find((p) => p.name === "LOCATION")?.value).toBe("住所だけの場所\\n岐阜県岐阜市柳戸1-1");
	});
});

describe("buildVEventCalendar: structuredLocation の geo 無し degrade(#45 スライス B)", () => {
	test("geo(lat/lon)無しなら X-APPLE-STRUCTURED-LOCATION を書かず LOCATION に title だけ書く", () => {
		const component = buildVEventCalendar({
			uid: "ev-degrade",
			now: NOW,
			summary: "座標なしの予定",
			start: { type: "DATE", raw: "20260718" },
			structuredLocation: { title: "どこかの店" },
		});
		const ev = ICalendarObject.fromComponent(component).events()[0]!;
		expect(ev.location).toBe("どこかの店");
		// X-APPLE-STRUCTURED-LOCATION は書かれない(value 本体の geo URI を作れないため)。
		expect(readStructuredLocation(ev.raw)).toBeNull();
	});

	test("geo 無し + 住所ありなら LOCATION に title と住所を改行併記する", () => {
		const component = buildVEventCalendar({
			uid: "ev-degrade2",
			now: NOW,
			summary: "住所つき",
			start: { type: "DATE", raw: "20260718" },
			structuredLocation: { title: "叙々苑 品川店", address: "東京都港区高輪4-10-30" },
		});
		const ev = ICalendarObject.fromComponent(component).events()[0]!;
		// ev.location は VEvent レンズの生値(未 decode)。encodeText で実改行が "\n"(バックスラッシュ+n)へ
		// エスケープされた形で入る(Event DTO 側では decodeText されて実改行に戻る — application 層のテストで検証)。
		expect(ev.location).toBe("叙々苑 品川店\\n東京都港区高輪4-10-30");
		expect(readStructuredLocation(ev.raw)).toBeNull();
	});
});
