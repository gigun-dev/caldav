// =============================================================================
// structure/edit.ts のテスト(E-1 スライス①新設)
// =============================================================================
// upsertProperty の「順序保持」「パラメータ保持」「既存置換 vs 新規追加」を確認する。
import { describe, expect, test } from "bun:test";
import { appendSubComponent, removeProperty, upsertProperty } from "../../../src/domain/ical/structure/edit";
import type { Component } from "../../../src/domain/ical/structure/types";

const base: Component = {
	name: "VTODO",
	properties: [
		{ name: "UID", parameters: [], value: "u1" },
		{ name: "SUMMARY", parameters: [], value: "old" },
	],
	components: [],
};

describe("upsertProperty", () => {
	test("同名プロパティが無ければ末尾に追加する", () => {
		const out = upsertProperty(base, "DUE", "20260712", [{ name: "VALUE", values: ["DATE"] }]);
		expect(out.properties.map((p) => p.name)).toEqual(["UID", "SUMMARY", "DUE"]);
		expect(out.properties[2]).toEqual({ name: "DUE", parameters: [{ name: "VALUE", values: ["DATE"] }], value: "20260712" });
	});

	test("同名プロパティがあれば同じ位置で置換する(出現順を保持)", () => {
		const out = upsertProperty(base, "SUMMARY", "new");
		// SUMMARY は元々 index 1 だったので、置換後も index 1 のまま(先頭に動いたり末尾に動いたりしない)。
		expect(out.properties.map((p) => p.name)).toEqual(["UID", "SUMMARY"]);
		expect(out.properties[1]!.value).toBe("new");
	});

	test("複数出現していても最初の1つだけを置換する", () => {
		const withDup: Component = {
			...base,
			properties: [...base.properties, { name: "SUMMARY", parameters: [], value: "second" }],
		};
		const out = upsertProperty(withDup, "SUMMARY", "replaced");
		expect(out.properties.filter((p) => p.name === "SUMMARY")).toEqual([
			{ name: "SUMMARY", parameters: [], value: "replaced" },
			{ name: "SUMMARY", parameters: [], value: "second" },
		]);
	});

	test("元の Component は変更されない(イミュータブル)", () => {
		const original = JSON.parse(JSON.stringify(base));
		upsertProperty(base, "SUMMARY", "mutated");
		expect(base).toEqual(original);
	});
});

describe("removeProperty", () => {
	test("同名プロパティを全件取り除く", () => {
		const out = removeProperty(base, "SUMMARY");
		expect(out.properties.map((p) => p.name)).toEqual(["UID"]);
	});
});

describe("appendSubComponent", () => {
	test("サブコンポーネントを末尾に追加する", () => {
		const alarm: Component = { name: "VALARM", properties: [], components: [] };
		const out = appendSubComponent(base, alarm);
		expect(out.components).toEqual([alarm]);
		// 元は変更されない。
		expect(base.components).toEqual([]);
	});
});
