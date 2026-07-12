// =============================================================================
// semantics/vtodo-stamp.ts のテスト(E-1 スライス②-a 新設)
// =============================================================================
// stampCreate/stampUpdate が「何を触り、何を触らないか」を直接検証する。
// X-APPLE-SORT-ORDER の実測固定値(2026-07-12 iOS 実機キャプチャ、docs/modeling/06 §D9)を
// 使い、CFAbsoluteTime 変換のデコード結果が回帰しないことを保証する。
import { describe, expect, test } from "bun:test";
import {
	CF_ABSOLUTE_EPOCH_OFFSET_SECONDS,
	stampCreate,
	stampUpdate,
	type NowStamp,
} from "../../../src/domain/ical/semantics/vtodo-stamp";
import type { Component } from "../../../src/domain/ical/structure/types";

// 実測: create 2026-07-12T11:48:30Z(unix 1783856910) → X-APPLE-SORT-ORDER 805549710。
const NOW: NowStamp = { utcRaw: "20260712T114830Z", unixSeconds: 1783856910 };

function emptyVTodo(): Component {
	return { name: "VTODO", properties: [], components: [] };
}

function propValue(c: Component, name: string): string | undefined {
	return c.properties.find((p) => p.name === name)?.value;
}

describe("stampCreate", () => {
	test("STATUS/CREATED/LAST-MODIFIED/DTSTAMP/X-APPLE-SORT-ORDER を付ける", () => {
		const out = stampCreate(emptyVTodo(), NOW);
		expect(propValue(out, "STATUS")).toBe("NEEDS-ACTION");
		expect(propValue(out, "CREATED")).toBe("20260712T114830Z");
		expect(propValue(out, "LAST-MODIFIED")).toBe("20260712T114830Z");
		expect(propValue(out, "DTSTAMP")).toBe("20260712T114830Z");
		expect(propValue(out, "X-APPLE-SORT-ORDER")).toBe("805549710");
	});

	test("X-APPLE-SORT-ORDER は unixSeconds - CF_ABSOLUTE_EPOCH_OFFSET_SECONDS(実測固定値で検証)", () => {
		expect(NOW.unixSeconds - CF_ABSOLUTE_EPOCH_OFFSET_SECONDS).toBe(805549710);
		const out = stampCreate(emptyVTodo(), NOW);
		expect(propValue(out, "X-APPLE-SORT-ORDER")).toBe(
			String(NOW.unixSeconds - CF_ABSOLUTE_EPOCH_OFFSET_SECONDS),
		);
	});

	test("既に STATUS がある場合は上書きしない", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "STATUS", parameters: [], value: "IN-PROCESS" }],
			components: [],
		};
		const out = stampCreate(vtodo, NOW);
		expect(propValue(out, "STATUS")).toBe("IN-PROCESS");
	});
});

describe("stampUpdate", () => {
	test("LAST-MODIFIED/DTSTAMP のみ更新し CREATED/X-APPLE-SORT-ORDER/STATUS は保持する", () => {
		const existing: Component = {
			name: "VTODO",
			properties: [
				{ name: "STATUS", parameters: [], value: "NEEDS-ACTION" },
				{ name: "CREATED", parameters: [], value: "20260101T000000Z" },
				{ name: "LAST-MODIFIED", parameters: [], value: "20260101T000000Z" },
				{ name: "DTSTAMP", parameters: [], value: "20260101T000000Z" },
				{ name: "X-APPLE-SORT-ORDER", parameters: [], value: "1" },
			],
			components: [],
		};
		const later: NowStamp = { utcRaw: "20260713T090000Z", unixSeconds: 1783933200 };
		const out = stampUpdate(existing, later);

		expect(propValue(out, "LAST-MODIFIED")).toBe("20260713T090000Z");
		expect(propValue(out, "DTSTAMP")).toBe("20260713T090000Z");
		// 触らないプロパティ(update で CREATED を今にするのは「作成時刻」として嘘になる —
		// vtodo-stamp.ts stampUpdate コメント参照)。
		expect(propValue(out, "CREATED")).toBe("20260101T000000Z");
		expect(propValue(out, "X-APPLE-SORT-ORDER")).toBe("1");
		expect(propValue(out, "STATUS")).toBe("NEEDS-ACTION");
	});
});
