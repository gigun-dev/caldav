// =============================================================================
// telemetry-support のユニットテスト(観測基盤 v1)
// =============================================================================
// 何を保証するか(CLAUDE.md「テストコード=What」):
//   - classifyHost: User-Agent からの粗い分類基準(claude.ai/swift/inspector/unknown)。
//   - summarizeArgsDigest: 引数の要約規則(内容データが argsDigest に絶対に漏れないこと)。
//   - readSessionId: params._meta からの相関 ID 読み取り。
// =============================================================================

import { describe, expect, it } from "bun:test";
import { classifyHost, readSessionId, summarizeArgsDigest } from "../../src/presentation/mcp/telemetry-support";

describe("classifyHost", () => {
	it("claude を含む User-Agent は claude.ai と分類する", () => {
		expect(classifyHost("Claude-User/1.0")).toBe("claude.ai");
		expect(classifyHost("claude.ai-desktop/2.1")).toBe("claude.ai");
	});

	it("CFNetwork/swift を含む User-Agent は swift と分類する(iOS ネイティブクライアント想定)", () => {
		expect(classifyHost("Reminders/1 CFNetwork/1500 Darwin/24.0")).toBe("swift");
		expect(classifyHost("my-swift-client/0.1")).toBe("swift");
	});

	it("inspector を含む User-Agent は inspector と分類する", () => {
		expect(classifyHost("modelcontextprotocol-inspector/0.5")).toBe("inspector");
	});

	it("該当パターンが無い/ヘッダ無しは unknown に落ちる", () => {
		expect(classifyHost("curl/8.4.0")).toBe("unknown");
		expect(classifyHost(null)).toBe("unknown");
		expect(classifyHost(undefined)).toBe("unknown");
		expect(classifyHost("")).toBe("unknown");
	});

	it("claude と swift 両方に一致する UA は claude.ai を優先する(判定順序の契約)", () => {
		expect(classifyHost("Claude-Desktop CFNetwork/1 Darwin/24")).toBe("claude.ai");
	});
});

describe("summarizeArgsDigest", () => {
	it("識別子キー(calendarId 等)は値をそのまま残す", () => {
		expect(summarizeArgsDigest({ calendarId: "tasks", id: "abc-123" })).toEqual({
			calendarId: "tasks",
			id: "abc-123",
		});
	});

	it("配列は中身を見ず件数だけを残す(識別子の配列でも中身は載せない)", () => {
		expect(summarizeArgsDigest({ calendarIds: ["a", "b", "c"] })).toEqual({ calendarIds: { count: 3 } });
	});

	it("自由記述の文字列(title/notes 等)は値を載せず型名だけにする — 内容データ漏洩防止の核", () => {
		const digest = summarizeArgsDigest({ title: "秘密の予定タイトル", notes: "誰にも見せたくないメモ" });
		expect(digest).toEqual({ title: "string", notes: "string" });
		// 値そのものが JSON 化された結果に一切含まれないことを文字列検索でも確認する。
		expect(JSON.stringify(digest)).not.toContain("秘密");
		expect(JSON.stringify(digest)).not.toContain("メモ");
	});

	it("真偽値/数値/オブジェクトの非識別子キーも型名のみ残す", () => {
		expect(summarizeArgsDigest({ includeCompleted: true, priority: 5, due: { date: "2026-01-01" } })).toEqual({
			includeCompleted: "boolean",
			priority: "number",
			due: "object",
		});
	});

	it("空オブジェクト/非オブジェクト引数は undefined を返す(『要約すべき引数が無い』契約)", () => {
		expect(summarizeArgsDigest({})).toBeUndefined();
		expect(summarizeArgsDigest(undefined)).toBeUndefined();
		expect(summarizeArgsDigest(null)).toBeUndefined();
		expect(summarizeArgsDigest("not-an-object")).toBeUndefined();
		expect(summarizeArgsDigest(["array", "args"])).toBeUndefined();
	});
});

describe("readSessionId", () => {
	it("gigun.dev/session キーが文字列であれば返す", () => {
		expect(readSessionId({ "gigun.dev/session": "session-abc" })).toBe("session-abc");
	});

	it("キーが無い/文字列でない/meta 自体が無い場合は undefined", () => {
		expect(readSessionId({})).toBeUndefined();
		expect(readSessionId({ "gigun.dev/session": 123 })).toBeUndefined();
		expect(readSessionId({ "gigun.dev/session": "" })).toBeUndefined();
		expect(readSessionId(undefined)).toBeUndefined();
	});
});
