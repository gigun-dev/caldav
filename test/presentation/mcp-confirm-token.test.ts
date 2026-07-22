// =============================================================================
// confirm-token(S1・docs/modeling/14 確認トークン)の単体テスト
// =============================================================================
// 何を保証するか(What):
//   - 正しい鍵 + 未失効なら検証が通り、署名した payload をそのまま復元して返す。
//   - TTL 超過(now を進める)で失効(reason:"expired")する。
//   - payload / 署名 / 鍵のいずれかが違えば bad-signature で弾かれる(偽造不可)。
//   - 壊れた文字列は malformed で弾かれる。
//   - nonce により、同一 payload でも毎回異なるトークン文字列になる(ワンタイム性の担保・ただし
//     ステートレスなので「同一トークンの再提示」までは制限しない — confirm-token.ts の但し書き参照)。
//   - canonicalJson はキー順序に依存しない決定的な文字列を返す(署名の一致性の土台)。
// =============================================================================

import { describe, expect, it } from "bun:test";
import {
	PROPOSE_TOKEN_TTL_MS,
	canonicalJson,
	signConfirmToken,
	verifyConfirmToken,
} from "../../src/presentation/mcp/confirm-token";

const SECRET = "unit-test-secret";
const PAYLOAD = { kind: "delete", tool: "delete-todo", id: "abc-123", calendarId: "tasks" };

describe("canonicalJson", () => {
	it("キー順序が違っても同じ文字列になる(決定的)", () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});

	it("ネストしたオブジェクトのキーも再帰的にソートする", () => {
		expect(canonicalJson({ x: { p: 1, q: 2 } })).toBe(canonicalJson({ x: { q: 2, p: 1 } }));
		expect(canonicalJson({ x: { p: 1, q: 2 } })).toBe('{"x":{"p":1,"q":2}}');
	});

	it("配列は順序を保つ(ソートしない)", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	it("undefined 値のキーは省く(JSON.stringify と揃える)", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});

describe("signConfirmToken / verifyConfirmToken", () => {
	it("正しい鍵で署名 → 検証が通り payload を復元する", async () => {
		const token = await signConfirmToken(SECRET, PAYLOAD);
		const v = await verifyConfirmToken(SECRET, token);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.payload).toEqual(PAYLOAD);
	});

	it("TTL 超過で失効する(now を exp より後に進める)", async () => {
		const now = 1_000_000;
		const token = await signConfirmToken(SECRET, PAYLOAD, PROPOSE_TOKEN_TTL_MS, now);
		// 失効直前は通る。
		const before = await verifyConfirmToken(SECRET, token, now + PROPOSE_TOKEN_TTL_MS - 1);
		expect(before.ok).toBe(true);
		// exp ちょうど(now >= exp)で失効。
		const at = await verifyConfirmToken(SECRET, token, now + PROPOSE_TOKEN_TTL_MS);
		expect(at.ok).toBe(false);
		if (!at.ok) expect(at.reason).toBe("expired");
	});

	it("別の鍵では検証に失敗する(bad-signature)", async () => {
		const token = await signConfirmToken(SECRET, PAYLOAD);
		const v = await verifyConfirmToken("wrong-secret", token);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toBe("bad-signature");
	});

	it("payload を改ざんすると署名が一致しない(bad-signature)", async () => {
		const token = await signConfirmToken(SECRET, PAYLOAD);
		// トークンは "<b64url msg>.<b64url sig>"。前半(msg)を別の payload に差し替えて署名部を流用する
		// = 典型的な偽造の試み。署名は元 msg に対するものなので一致しない。
		const [, sig] = token.split(".");
		const forgedMsg = btoa(JSON.stringify({ p: { ...PAYLOAD, id: "evil" }, e: Date.now() + 60000, n: "x" }))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const forged = `${forgedMsg}.${sig}`;
		const v = await verifyConfirmToken(SECRET, forged);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toBe("bad-signature");
	});

	it("壊れた文字列は malformed", async () => {
		for (const bad of ["", "no-dot", ".", "a.", ".b", "@@@.@@@"]) {
			const v = await verifyConfirmToken(SECRET, bad);
			expect(v.ok).toBe(false);
			if (!v.ok) expect(["malformed", "bad-signature"]).toContain(v.reason);
		}
	});

	it("同一 payload でも nonce で毎回別トークンになる(ワンタイム性の担保)", async () => {
		const t1 = await signConfirmToken(SECRET, PAYLOAD);
		const t2 = await signConfirmToken(SECRET, PAYLOAD);
		expect(t1).not.toBe(t2);
		// どちらも(ステートレスなので)有効ではある — 「同一トークンの再提示」までは制限しない設計
		// (confirm-token.ts の「ワンタイムの意味と限界」コメント参照)。
		expect((await verifyConfirmToken(SECRET, t1)).ok).toBe(true);
		expect((await verifyConfirmToken(SECRET, t2)).ok).toBe(true);
	});
});
