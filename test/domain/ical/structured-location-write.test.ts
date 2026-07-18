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
		expect(loc).toEqual({
			title: "岐阜大学",
			address: "岐阜県岐阜市柳戸1-1",
			geo: { lat: 35.463012, lon: 136.737202 },
			radiusMeters: 100,
		});
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
		expect(readStructuredLocation(patched)).toEqual({
			title: "新しい場所",
			address: null,
			geo: { lat: 10, lon: 20 },
			radiusMeters: null,
		});
	});

	test("undefined(省略)は既存の構造化場所を変更しない", () => {
		const calendar = buildBase();
		const vevent = ICalendarObject.fromComponent(calendar).events()[0]!.raw;
		const patched = patchVEventFields(vevent, { summary: "タイトルだけ変更" });
		expect(readStructuredLocation(patched)!.title).toBe("元の場所");
	});
});
