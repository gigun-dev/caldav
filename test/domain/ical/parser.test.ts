// =============================================================================
// パーサー単体テスト(RFC 5545 §3.1〜3.2)
// =============================================================================
// 折り畳み解除 / quoted パラメータ / 複数値 / ネスト / エラー(行番号付き)を確認する。
// ランナーは bun:test。
import { describe, expect, test } from "bun:test";
import { ParseError, parse } from "../../../src/domain/ical";

// テスト用に CRLF 行を組み立てるヘルパ(ソースコード中で \r\n をベタ書きすると読みにくい)。
const crlf = (...lines: string[]) => lines.join("\r\n") + "\r\n";

describe("unfold(折り畳み解除, §3.1)", () => {
	test("CRLF+SPACE で折られた行を1つの値に復元する", () => {
		// "Hello World" を SPACE 折り。継続行先頭の SPACE 1 個は剥がされ、"HelloWorld" ではなく
		// "Hello World"(元の文字列)に戻る = 折り畳みで挿入された SPACE だけが消える。
		const ics = crlf(
			"BEGIN:VCALENDAR",
			"SUMMARY:Hello ",
			" World",
			"END:VCALENDAR",
		);
		const c = parse(ics);
		expect(c.properties[0]!.value).toBe("Hello World");
	});

	test("CRLF+HTAB でも折り畳みとして解除する", () => {
		const ics = crlf("BEGIN:VCALENDAR", "SUMMARY:ab", "\tcd", "END:VCALENDAR");
		expect(parse(ics).properties[0]!.value).toBe("abcd");
	});

	test("日本語がオクテット境界で折られていても正しく復元される", () => {
		// 「日本」を途中で折った想定(継続行の先頭 SPACE を剥がすと連結される)。
		const ics = crlf("BEGIN:VCALENDAR", "SUMMARY:日", " 本語", "END:VCALENDAR");
		expect(parse(ics).properties[0]!.value).toBe("日本語");
	});
});

describe("寛容な改行受理(Postel の法則)", () => {
	test("LF のみでもパースできる", () => {
		const ics = "BEGIN:VCALENDAR\nSUMMARY:x\nEND:VCALENDAR\n";
		expect(parse(ics).properties[0]!.value).toBe("x");
	});
	test("CR のみでもパースできる", () => {
		const ics = "BEGIN:VCALENDAR\rSUMMARY:x\rEND:VCALENDAR\r";
		expect(parse(ics).properties[0]!.value).toBe("x");
	});
	test("末尾や途中の空行は無視する", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR",
			"",
			"SUMMARY:x",
			"",
			"END:VCALENDAR",
			"",
		);
		expect(parse(ics).properties).toHaveLength(1);
	});
	test("空値プロパティ(X-EMPTY:)は空行として捨てない", () => {
		const ics = crlf("BEGIN:VCALENDAR", "X-EMPTY:", "END:VCALENDAR");
		const c = parse(ics);
		expect(c.properties).toHaveLength(1);
		expect(c.properties[0]!.name).toBe("X-EMPTY");
		expect(c.properties[0]!.value).toBe("");
	});
});

describe("コンテンツ行のパース(§3.1)", () => {
	test("プロパティ名・パラメータ名は大文字に正規化される", () => {
		const ics = crlf("BEGIN:VCALENDAR", "summary;language=ja:x", "END:VCALENDAR");
		const p = parse(ics).properties[0]!;
		expect(p.name).toBe("SUMMARY");
		expect(p.parameters[0]!.name).toBe("LANGUAGE");
		// パラメータ**値**は case-sensitive なので変えない(§3.1)。
		expect(p.parameters[0]!.values).toEqual(["ja"]);
	});

	test("値部分はエスケープ解除せず生のまま保持する(最重要設計決定)", () => {
		// TEXT のエスケープ(\n \, \;)を解釈しない。バックスラッシュ列がそのまま残ること。
		const ics = crlf(
			"BEGIN:VCALENDAR",
			String.raw`DESCRIPTION:a\nb\, c\; d`,
			"END:VCALENDAR",
		);
		expect(parse(ics).properties[0]!.value).toBe(String.raw`a\nb\, c\; d`);
	});

	test("値の中のコロンは区切りにならない(最初のコロンだけが区切り)", () => {
		const ics = crlf("BEGIN:VCALENDAR", "X-URL:http://a.b/c", "END:VCALENDAR");
		expect(parse(ics).properties[0]!.value).toBe("http://a.b/c");
	});
});

describe("パラメータ(§3.2)", () => {
	test("quoted-string 内の : ; , は区切りにならず DQUOTE は剥がす", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR",
			'X;CN="Doe, John; Jr:":value',
			"END:VCALENDAR",
		);
		const p = parse(ics).properties[0]!;
		expect(p.parameters[0]!.values).toEqual(["Doe, John; Jr:"]);
		expect(p.value).toBe("value");
	});

	test("複数値パラメータ(PARAM=v1,v2)を配列にする", () => {
		const ics = crlf("BEGIN:VCALENDAR", "X;MEMBER=a,b,c:v", "END:VCALENDAR");
		expect(parse(ics).properties[0]!.parameters[0]!.values).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("quoted と非 quoted の混在した複数値", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR",
			'X;M="a:1",b,"c;2":v',
			"END:VCALENDAR",
		);
		expect(parse(ics).properties[0]!.parameters[0]!.values).toEqual([
			"a:1",
			"b",
			"c;2",
		]);
	});

	test("複数のパラメータを順に読む", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR",
			"X;A=1;B=2;C=3:v",
			"END:VCALENDAR",
		);
		const params = parse(ics).properties[0]!.parameters;
		expect(params.map((p) => p.name)).toEqual(["A", "B", "C"]);
	});
});

describe("BEGIN/END のネスト(§3.6)", () => {
	test("VCALENDAR > VEVENT > VALARM の階層を組み立てる", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:1",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"END:VALARM",
			"END:VEVENT",
			"END:VCALENDAR",
		);
		const cal = parse(ics);
		expect(cal.name).toBe("VCALENDAR");
		const vevent = cal.components[0]!;
		expect(vevent.name).toBe("VEVENT");
		expect(vevent.properties[0]!.name).toBe("UID");
		expect(vevent.components[0]!.name).toBe("VALARM");
	});

	test("コンポーネント名は大文字に正規化される", () => {
		const ics = crlf("begin:vcalendar", "end:vcalendar");
		expect(parse(ics).name).toBe("VCALENDAR");
	});
});

describe("エラー(行番号付き ParseError)", () => {
	test("BEGIN/END の名前不一致は不一致行を指す", () => {
		const ics = crlf(
			"BEGIN:VCALENDAR", // line 1
			"BEGIN:VEVENT", // line 2
			"END:VALARM", // line 3 ← ここでエラー
			"END:VCALENDAR",
		);
		expect(() => parse(ics)).toThrow(ParseError);
		try {
			parse(ics);
		} catch (e) {
			const err = e as ParseError;
			expect(err.lineNo).toBe(3);
			expect(err.message).toContain("VALARM");
			expect(err.message).toContain("VEVENT");
		}
	});

	test("未閉鎖の BEGIN はエラー", () => {
		const ics = crlf("BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VCALENDAR");
		// END:VCALENDAR が VEVENT と一致しない時点で不一致エラーになる。
		expect(() => parse(ics)).toThrow(ParseError);
	});

	test("EOF で閉じられていない BEGIN はエラー", () => {
		const ics = crlf("BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VEVENT");
		expect(() => parse(ics)).toThrow(/unclosed component BEGIN:VCALENDAR/);
	});

	test("行番号は unfold 前の物理行(折り畳み分ずれない)", () => {
		// 2〜3 行目が折り畳み1論理行。4 行目の壊れた END が物理行4を指すこと。
		const ics = crlf(
			"BEGIN:VCALENDAR", // 1
			"SUMMARY:long", // 2
			" folded", // 3(継続行)
			"END:VEVENT", // 4 ← VCALENDAR と不一致
		);
		try {
			parse(ics);
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as ParseError).lineNo).toBe(4);
		}
	});

	test("コロンの無い行はエラー", () => {
		const ics = crlf("BEGIN:VCALENDAR", "NOCOLON", "END:VCALENDAR");
		expect(() => parse(ics)).toThrow(/no ':' value delimiter/);
	});

	test("閉じ DQUOTE の無いパラメータはエラー", () => {
		const ics = crlf("BEGIN:VCALENDAR", 'X;CN="unterminated:v', "END:VCALENDAR");
		expect(() => parse(ics)).toThrow(/unterminated quoted/);
	});

	test("コンポーネント外のプロパティはエラー", () => {
		const ics = crlf("SUMMARY:x", "BEGIN:VCALENDAR", "END:VCALENDAR");
		expect(() => parse(ics)).toThrow(/outside of any component/);
	});
});
