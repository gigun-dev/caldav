// =============================================================================
// presentation/mcp/ui/content-hash のテスト + TODOS_UI_URI/AGENDA_UI_URI の hash 化検証
// =============================================================================
// 2026-07-17 キャッシュバスティング S1: fnv1aHex 自体の性質(同一入力→不変・1文字違い→変化)と、
// 実際に ui:// URI が `ui://caldav/<name>.<8hex>.html` の形式になっていることを保証する。
// URI 形式が崩れると server.ts のエイリアス登録(legacy URI との対比)や claude.ai 側の
// リソースマッチングが壊れるため、正規表現での固定 assert を持つ。
// =============================================================================

import { describe, expect, test } from "bun:test";
import { fnv1aHex } from "../../src/presentation/mcp/ui/content-hash";
import { TODOS_UI_URI } from "../../src/presentation/mcp/ui/todos-app";
import { AGENDA_UI_URI } from "../../src/presentation/mcp/ui/agenda-app";

describe("fnv1aHex", () => {
	test("同一入力からは常に同じ hash を返す", () => {
		const input = "<!doctype html><html></html>";
		expect(fnv1aHex(input)).toBe(fnv1aHex(input));
	});

	test("1文字違うだけで hash が変わる", () => {
		const a = fnv1aHex("<!doctype html><html></html>");
		const b = fnv1aHex("<!doctype html><html><body></body></html>");
		expect(a).not.toBe(b);
	});

	test("8桁の hex 文字列を返す", () => {
		expect(fnv1aHex("")).toMatch(/^[0-9a-f]{8}$/);
		expect(fnv1aHex("x")).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("ui:// URI の content-address 化(S1)", () => {
	test("TODOS_UI_URI は ui://caldav/todos.<8hex>.html 形式", () => {
		expect(TODOS_UI_URI).toMatch(/^ui:\/\/caldav\/todos\.[0-9a-f]{8}\.html$/);
	});

	test("AGENDA_UI_URI は ui://caldav/agenda.<8hex>.html 形式", () => {
		expect(AGENDA_UI_URI).toMatch(/^ui:\/\/caldav\/agenda\.[0-9a-f]{8}\.html$/);
	});
});
