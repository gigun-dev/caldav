// =============================================================================
// semantics/valarm-write.ts のテスト(#51 Phase 1)
// =============================================================================
// buildProximityAlarm が iOS 実測 fixtures/real-ios/vtodo-proximity-alarm.ics に構造忠実な
// proximity VALARM を組むことを検証する。UID はランダム(crypto.randomUUID)なので固定値比較は
// できないため、「UID と X-WR-ALARMUID が互いに同値」かつ「他の固定要素が実測どおり」を確認する。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProximityAlarm, PROXIMITY_TRIGGER_PLACEHOLDER } from "../../../src/domain/ical/semantics/valarm-write";
import { serialize } from "../../../src/domain/ical/serialize/serializer";
import { parse } from "../../../src/domain/ical/parse/parser";
import { readProximityAlarm } from "../../../src/domain/ical/semantics/structured-location";
import type { Component, Property } from "../../../src/domain/ical/structure/types";

// fixture(iOS 26.5 実測 put13)の VALARM を取り出す。実測の「形」を期待値の一次資料にする。
function loadFixtureProximityValarm(): Component {
	const ics = readFileSync(join(__dirname, "fixtures/real-ios/vtodo-proximity-alarm.ics"), "utf-8");
	const vcalendar = parse(ics);
	const vtodo = vcalendar.components.find((c) => c.name === "VTODO")!;
	return vtodo.components.find((c) => c.name === "VALARM")!;
}

const prop = (c: Component, name: string): Property | undefined => c.properties.find((p) => p.name === name);
const paramOf = (p: Property, name: string): string | undefined => p.parameters.find((x) => x.name === name)?.values[0];

describe("buildProximityAlarm", () => {
	test("fixture 構造との一致(TRIGGER 番兵・UID=X-WR-ALARMUID 同値・REFERENCEFRAME=1・RADIUS・X-TITLE・geo 順序)", () => {
		const fixture = loadFixtureProximityValarm();
		const valarm = buildProximityAlarm({
			title: "自宅",
			lat: 35.658034,
			lon: 139.701636,
			trigger: "arrive",
			radius: 100,
		});

		// ACTION/DESCRIPTION は固定文字列。
		expect(prop(valarm, "ACTION")?.value).toBe("DISPLAY");
		expect(prop(valarm, "DESCRIPTION")?.value).toBe("Reminder");

		// TRIGGER は番兵固定値 + VALUE=DATE-TIME(fixture 実測と一致)。
		const trigger = prop(valarm, "TRIGGER")!;
		expect(trigger.value).toBe(PROXIMITY_TRIGGER_PLACEHOLDER);
		expect(trigger.value).toBe(prop(fixture, "TRIGGER")!.value); // fixture(19760401T005545Z)と同値。
		expect(paramOf(trigger, "VALUE")).toBe("DATE-TIME");

		// UID と X-WR-ALARMUID は互いに同値(ランダムなので値そのものは fixture と違ってよい)。
		const uid = prop(valarm, "UID")?.value;
		const wrUid = prop(valarm, "X-WR-ALARMUID")?.value;
		expect(uid).toBeDefined();
		expect(uid).toBe(wrUid);
		expect(uid).toBe(uid!.toUpperCase()); // 大文字 UUID(実測 BE34B460-... に倣う)。

		// X-APPLE-PROXIMITY: arrive → ARRIVE(fixture と同値)。
		expect(prop(valarm, "X-APPLE-PROXIMITY")?.value).toBe("ARRIVE");
		expect(prop(valarm, "X-APPLE-PROXIMITY")?.value).toBe(prop(fixture, "X-APPLE-PROXIMITY")?.value);

		// X-APPLE-STRUCTURED-LOCATION: パラメータ順・内容が fixture と同形。
		const loc = prop(valarm, "X-APPLE-STRUCTURED-LOCATION")!;
		const fixtureLoc = prop(fixture, "X-APPLE-STRUCTURED-LOCATION")!;
		// パラメータ順は fixture 実測どおり VALUE, X-APPLE-RADIUS, X-APPLE-REFERENCEFRAME, X-TITLE。
		expect(loc.parameters.map((p) => p.name)).toEqual(fixtureLoc.parameters.map((p) => p.name));
		expect(paramOf(loc, "VALUE")).toBe("URI");
		expect(paramOf(loc, "X-APPLE-RADIUS")).toBe("100");
		expect(paramOf(loc, "X-APPLE-REFERENCEFRAME")).toBe("1"); // VALARM 固有(VEVENT 側は書かない)。
		expect(paramOf(loc, "X-TITLE")).toBe("自宅");
		// geo は lat,lon の順(fixture は 0,0 のダミーだが、我々は実座標を lat,lon 順で書く)。
		expect(loc.value).toBe("geo:35.658034,139.701636");

		// プロパティ順が fixture と一致(diff 安定・Apple read 実装との相互運用)。
		expect(valarm.properties.map((p) => p.name)).toEqual(fixture.properties.map((p) => p.name));
	});

	test("trigger:leave → X-APPLE-PROXIMITY:DEPART(domain は両対応)", () => {
		const valarm = buildProximityAlarm({ title: "オフィス", lat: 1, lon: 2, trigger: "leave" });
		expect(prop(valarm, "X-APPLE-PROXIMITY")?.value).toBe("DEPART");
	});

	test("radius 未指定 → 既定 100(X-APPLE-RADIUS=100)が出る / address 省略時は X-ADDRESS を書かない", () => {
		const valarm = buildProximityAlarm({ title: "駅", lat: 1, lon: 2, trigger: "arrive" });
		const loc = prop(valarm, "X-APPLE-STRUCTURED-LOCATION")!;
		// radius 無しでは iOS の geofence が成立しないリスクがあるため、実測 fixture 値 100 を既定で書く(#51)。
		expect(paramOf(loc, "X-APPLE-RADIUS")).toBe("100");
		expect(paramOf(loc, "X-ADDRESS")).toBeUndefined();
		// REFERENCEFRAME/TITLE は常に付く。
		expect(paramOf(loc, "X-APPLE-REFERENCEFRAME")).toBe("1");
		expect(paramOf(loc, "X-TITLE")).toBe("駅");
	});

	test("radius 明示指定はその値が出る(既定 100 を上書き)", () => {
		const valarm = buildProximityAlarm({ title: "駅", lat: 1, lon: 2, trigger: "arrive", radius: 250 });
		const loc = prop(valarm, "X-APPLE-STRUCTURED-LOCATION")!;
		expect(paramOf(loc, "X-APPLE-RADIUS")).toBe("250");
	});

	test("address 指定は X-ADDRESS へ(encodeText 経由)", () => {
		const valarm = buildProximityAlarm({ title: "自宅", address: "東京都千代田区", lat: 1, lon: 2, trigger: "arrive" });
		const loc = prop(valarm, "X-APPLE-STRUCTURED-LOCATION")!;
		expect(paramOf(loc, "X-ADDRESS")).toBe("東京都千代田区");
	});

	test("serialize→parse→readProximityAlarm の往復で proximity が保持される(回帰)", () => {
		const valarm = buildProximityAlarm({ title: "自宅", address: "住所", lat: 35.1, lon: 139.2, trigger: "arrive", radius: 250 });
		// VTODO に載せて往復(readProximityAlarm は Component 配下の VALARM を走査する)。
		const vtodo: Component = { name: "VTODO", properties: [{ name: "UID", parameters: [], value: "x" }], components: [valarm] };
		const vcalendar: Component = {
			name: "VCALENDAR",
			properties: [
				{ name: "VERSION", parameters: [], value: "2.0" },
				{ name: "PRODID", parameters: [], value: "-//test//EN" },
			],
			components: [vtodo],
		};
		const roundTripped = parse(serialize(vcalendar));
		const rtVtodo = roundTripped.components.find((c) => c.name === "VTODO")!;
		const read = readProximityAlarm(rtVtodo)!;
		expect(read.proximity).toBe("ARRIVE");
		expect(read.location.title).toBe("自宅");
		expect(read.location.address).toBe("住所");
		expect(read.location.geo).toEqual({ lat: 35.1, lon: 139.2 });
		expect(read.location.radiusMeters).toBe(250);
	});
});
