import { describe, expect, it } from "bun:test";
import { authenticateBasic } from "../../src/presentation/auth/basic-auth";

describe("Basic auth", () => {
	it("正しい資格情報だけを受理する", async () => {
		const header = `Basic ${btoa("alice:correct horse")}`;
		expect(await authenticateBasic(header, { username: "alice", password: "correct horse" })).toBe(true);
		expect(await authenticateBasic(header, { username: "alice", password: "wrong" })).toBe(false);
	});

	it("壊れたAuthorizationを拒否する", async () => {
		expect(await authenticateBasic("Bearer token", { username: "a", password: "b" })).toBe(false);
		expect(await authenticateBasic("Basic !!!", { username: "a", password: "b" })).toBe(false);
	});
});
