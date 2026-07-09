// =============================================================================
// ETag のテスト(RFC 7232 / RFC 4791 §5.3.4)
// =============================================================================
// 検証項目(タスク指定):
//   - 同一 ICS → 同一 ETag(決定的)
//   - 1文字違い → 別 ETag(衝突しない = 内容が変われば必ず変わる)
//   - quoted 形式("...")
import { describe, expect, test } from "bun:test";
import { ETag, computeETag } from "../../../../src/domain/caldav/values";

const SAMPLE = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//y//EN\r\nEND:VCALENDAR\r\n";

describe("computeETag", () => {
	test("同一 ICS からは同一 ETag(決定的)", async () => {
		const a = await computeETag(SAMPLE);
		const b = await computeETag(SAMPLE);
		expect(a.equals(b)).toBe(true);
		// hex は 64 桁の小文字 16 進(SHA-256)。
		expect(a.hex).toMatch(/^[0-9a-f]{64}$/);
	});

	test("1文字違いで別 ETag(内容が変われば必ず変わる)", async () => {
		const a = await computeETag(SAMPLE);
		const b = await computeETag(SAMPLE.replace("2.0", "2.1"));
		expect(a.equals(b)).toBe(false);
	});

	test("既知ベクタ: 空文字列の SHA-256", async () => {
		// SHA-256("") の既知値。TextEncoder の空入力 = 0 バイトのハッシュ。
		const e = await computeETag("");
		expect(e.hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

describe("ETag 表現", () => {
	test("quoted 形式は強い ETag(W/ を付けない)", async () => {
		const e = await computeETag(SAMPLE);
		expect(e.toHeader()).toBe(`"${e.hex}"`);
		expect(e.toHeader().startsWith("W/")).toBe(false);
	});

	test("fromHex は大文字小文字を正規化して等価に扱う", () => {
		const lower = ETag.fromHex("a".repeat(64));
		const upper = ETag.fromHex("A".repeat(64));
		expect(lower.equals(upper)).toBe(true);
	});

	test("fromHex は 64 桁でない値を拒否する", () => {
		expect(() => ETag.fromHex("deadbeef")).toThrow();
		expect(() => ETag.fromHex("z".repeat(64))).toThrow();
	});
});
