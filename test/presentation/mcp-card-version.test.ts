// =============================================================================
// test/presentation/mcp-card-version.test.ts — カードの版不整合可視化(④)の純関数を固定
// =============================================================================
// 【何を保証するか(What)】card-version.ts の2関数を固定する:
//   - cardVersionIsStale: カード自身の焼き込み版ハッシュ ↔ サーバー現行 uiHash の不一致判定。
//     どちらか欠落時は false(誤検知回避 = 欠落時は「古い」と主張しない)。
//   - injectCardBuildHash: 配信 HTML の <head> 直後へ window.__CARD_BUILD_HASH__ を注入する。
// 【背景】claude.ai が古いカード HTML をキャッシュ描画し続ける実害(2026-07-23「古い UI 混乱」)への
// 対策。詳細は card-version.ts 冒頭・todos-view-model.ts の uiHash JSDoc。
// =============================================================================
import { describe, expect, test } from "bun:test";
import {
	AGENDA_APP_HTML,
	AGENDA_UI_HASH,
	AGENDA_UI_URI,
} from "../../src/presentation/mcp/ui/agenda-app";
import { cardVersionIsStale, injectCardBuildHash } from "../../src/presentation/mcp/ui/card-version";
import {
	TODOS_APP_HTML,
	TODOS_UI_HASH,
	TODOS_UI_URI,
} from "../../src/presentation/mcp/ui/todos-app";

describe("cardVersionIsStale(版不整合判定)", () => {
	test("両者一致 → false(古くない)", () => {
		expect(cardVersionIsStale("abcd1234", "abcd1234")).toBe(false);
	});

	test("両者不一致 → true(カードが古い可能性 = 警告を出す)", () => {
		expect(cardVersionIsStale("oldoldold", "newnewnew")).toBe(true);
	});

	test("カード側の焼き込みが欠落 → false(旧カード/注入前は誤検知しない)", () => {
		expect(cardVersionIsStale(undefined, "newnewnew")).toBe(false);
		expect(cardVersionIsStale(null, "newnewnew")).toBe(false);
		expect(cardVersionIsStale("", "newnewnew")).toBe(false);
	});

	test("サーバー側の uiHash が欠落 → false(旧サーバー/additive 欠落は誤検知しない)", () => {
		expect(cardVersionIsStale("abcd1234", undefined)).toBe(false);
		expect(cardVersionIsStale("abcd1234", null)).toBe(false);
		expect(cardVersionIsStale("abcd1234", "")).toBe(false);
	});
});

describe("injectCardBuildHash(版ハッシュの HTML 注入)", () => {
	test("<head> の直後に window.__CARD_BUILD_HASH__ を設定する classic script を差し込む", () => {
		const core = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
		const out = injectCardBuildHash(core, "abcd1234");
		// <head> の直後(meta より前)に注入され、値は JSON 文字列リテラルで焼き込まれる。
		expect(out).toContain('<head>\n<script>window.__CARD_BUILD_HASH__="abcd1234";</script>');
		// 元の内容は保たれる(core を破壊しない)。
		expect(out).toContain('<meta charset="utf-8">');
		expect(out).toContain("</body></html>");
	});

	test("<head> を持たない(テンプレ破損)ときは注入せず core をそのまま返す(安全側 degrade)", () => {
		const core = "<html><body>no head here</body></html>";
		expect(injectCardBuildHash(core, "abcd1234")).toBe(core);
	});
});

describe("カード配信物への版ハッシュ配線", () => {
	test("todos: 配信 HTML の焼き込み値・ui:// URI・server 用 hash が同じ版を指す", () => {
		// 純関数だけが正しくても todos-app.ts が注入を呼び忘れると実カードでは検知不能になるため、
		// 最終配信物まで通した契約をここで固定する。hash 値そのものはバンドル変更で変わるので固定しない。
		expect(TODOS_APP_HTML).toContain(`window.__CARD_BUILD_HASH__=${JSON.stringify(TODOS_UI_HASH)};`);
		expect(TODOS_UI_URI).toBe(`ui://caldav/todos.${TODOS_UI_HASH}.html`);
	});

	test("agenda: 配信 HTML の焼き込み値・ui:// URI・server 用 hash が同じ版を指す", () => {
		// agenda は todos と別バンドル/別 URI なので、片側だけ配線が外れる退行を対称なテストで防ぐ。
		expect(AGENDA_APP_HTML).toContain(`window.__CARD_BUILD_HASH__=${JSON.stringify(AGENDA_UI_HASH)};`);
		expect(AGENDA_UI_URI).toBe(`ui://caldav/agenda.${AGENDA_UI_HASH}.html`);
	});
});
