// =============================================================================
// semantics/vtodo-patch.ts のテスト(E-1 スライス②-b 新設)
// =============================================================================
// patchVTodoFields/applyCompletion/applyReopen が「指定したプロパティだけを触り、
// 他(VALARM/VTIMEZONE/未指定プロパティ)には一切触れない」ことを検証する。
// vtodo-recurring-master.ics(VALARM/VTIMEZONE 同梱の実機フィクスチャ)を使い、
// ロスレス編集であることを構造的に確認する。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCompletion, applyReopen, patchVTodoFields } from "../../../src/domain/ical/semantics/vtodo-patch";
import type { NowStamp } from "../../../src/domain/ical/semantics/vtodo-stamp";
import { parse } from "../../../src/domain/ical/parse/parser";
import type { Component } from "../../../src/domain/ical/structure/types";

const NOW: NowStamp = { utcRaw: "20260713T090000Z", unixSeconds: 1783933200 };

function emptyVTodo(): Component {
	return { name: "VTODO", properties: [], components: [] };
}

function propValue(c: Component, name: string): string | undefined {
	return c.properties.find((p) => p.name === name)?.value;
}

function loadRecurringMasterVTodo(): Component {
	const ics = readFileSync(
		join(__dirname, "fixtures/real-ios/vtodo-recurring-master.ics"),
		"utf-8",
	);
	const vcalendar = parse(ics);
	const vtodo = vcalendar.components.find((c) => c.name === "VTODO");
	if (vtodo === undefined) throw new Error("fixture has no VTODO");
	return vtodo;
}

describe("patchVTodoFields", () => {
	test("summary のみ指定すると SUMMARY だけが変わる", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [
				{ name: "SUMMARY", parameters: [], value: "old" },
				{ name: "PRIORITY", parameters: [], value: "5" },
			],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { summary: "new" });
		expect(propValue(out, "SUMMARY")).toBe("new");
		expect(propValue(out, "PRIORITY")).toBe("5"); // 触っていない
	});

	test("due を指定すると DTSTART/DUE が VALUE=DATE で同値 upsert される", () => {
		const out = patchVTodoFields(emptyVTodo(), { due: "20260715", dueValueType: "DATE" });
		expect(propValue(out, "DTSTART")).toBe("20260715");
		expect(propValue(out, "DUE")).toBe("20260715");
		const dtstart = out.properties.find((p) => p.name === "DTSTART");
		expect(dtstart?.parameters).toEqual([{ name: "VALUE", values: ["DATE"] }]);
	});

	test("priority:0 は PRIORITY を削除する(§3.8.1.9: 0=未定義)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "PRIORITY", parameters: [], value: "5" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, { priority: 0 });
		expect(propValue(out, "PRIORITY")).toBeUndefined();
	});

	test("priority が正の値なら PRIORITY を upsert する", () => {
		const out = patchVTodoFields(emptyVTodo(), { priority: 1 });
		expect(propValue(out, "PRIORITY")).toBe("1");
	});

	test("undefined のフィールドには一切触れない(何も指定しなければ元のまま)", () => {
		const vtodo: Component = {
			name: "VTODO",
			properties: [{ name: "SUMMARY", parameters: [], value: "keep" }],
			components: [],
		};
		const out = patchVTodoFields(vtodo, {});
		expect(out).toEqual(vtodo);
	});

	test("実機フィクスチャ(VALARM/VTIMEZONE 同梱)に対して指定外のプロパティ・サブコンポーネントは不変", () => {
		const vtodo = loadRecurringMasterVTodo();
		const out = patchVTodoFields(vtodo, { summary: "renamed" });

		expect(propValue(out, "SUMMARY")).toBe("renamed");
		// RRULE/UID/STATUS 等の未指定プロパティは値が変わらない。
		expect(propValue(out, "RRULE")).toBe(propValue(vtodo, "RRULE"));
		expect(propValue(out, "UID")).toBe(propValue(vtodo, "UID"));
		expect(propValue(out, "STATUS")).toBe(propValue(vtodo, "STATUS"));
		// VALARM サブコンポーネントは構造ごと不変(ロスレス編集の核心)。
		expect(out.components).toEqual(vtodo.components);
	});
});

describe("applyCompletion", () => {
	test("STATUS:COMPLETED / COMPLETED:<now> / PERCENT-COMPLETE:100 の三点セットを upsert する", () => {
		const out = applyCompletion(emptyVTodo(), NOW);
		expect(propValue(out, "STATUS")).toBe("COMPLETED");
		expect(propValue(out, "COMPLETED")).toBe("20260713T090000Z");
		expect(propValue(out, "PERCENT-COMPLETE")).toBe("100");
	});

	test("他のプロパティ・サブコンポーネントには触れない", () => {
		const vtodo = loadRecurringMasterVTodo();
		const out = applyCompletion(vtodo, NOW);
		expect(propValue(out, "SUMMARY")).toBe(propValue(vtodo, "SUMMARY"));
		expect(propValue(out, "RRULE")).toBe(propValue(vtodo, "RRULE"));
		expect(out.components).toEqual(vtodo.components);
	});
});

describe("applyReopen", () => {
	test("STATUS:NEEDS-ACTION に戻し、COMPLETED/PERCENT-COMPLETE を削除する", () => {
		const completed: Component = {
			name: "VTODO",
			properties: [
				{ name: "STATUS", parameters: [], value: "COMPLETED" },
				{ name: "COMPLETED", parameters: [], value: "20260710T045638Z" },
				{ name: "PERCENT-COMPLETE", parameters: [], value: "100" },
				{ name: "SUMMARY", parameters: [], value: "keep" },
			],
			components: [],
		};
		const out = applyReopen(completed);
		expect(propValue(out, "STATUS")).toBe("NEEDS-ACTION");
		expect(propValue(out, "COMPLETED")).toBeUndefined();
		expect(propValue(out, "PERCENT-COMPLETE")).toBeUndefined();
		expect(propValue(out, "SUMMARY")).toBe("keep"); // 触っていない
	});
});
