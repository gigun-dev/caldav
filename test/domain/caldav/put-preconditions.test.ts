// =============================================================================
// PUT precondition のテスト(RFC 4791 §5.3.2.1)
// =============================================================================
// 検証項目(タスク指定):
//   - R2: supportedComponents 不一致 / プロパティ不在時は全受理
//   - R4: UID 衝突 / UID 変更
// 併せて valid-calendar-data(parse 失敗)も確認する。
import { describe, expect, test } from "bun:test";
import {
	checkPutPreconditions,
	resourceUri,
	type ComponentKind,
	type PreconditionName,
	type PutPreconditionInput,
	type ResourceUri,
} from "../../../src/domain/caldav";

// 最小の妥当な VEVENT リソース。UID を差し替えて使う。
function veventIcs(uid: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//t//t//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		"DTSTART:20260101T000000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

// 最小の妥当な VTODO リソース。
function vtodoIcs(uid: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//t//t//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

// デフォルトの入力を組み立て、上書きしたいフィールドだけ渡すヘルパー。
// findUidOwner/existingUidAt は「衝突なし・新規作成」を既定にする。
function input(overrides: Partial<PutPreconditionInput> & Pick<PutPreconditionInput, "ics">): PutPreconditionInput {
	return {
		targetUri: resourceUri("target.ics"),
		findUidOwner: () => undefined,
		existingUidAt: () => undefined,
		...overrides,
	};
}

// 違反に含まれる precondition 名の集合。
function names(inp: PutPreconditionInput): Set<PreconditionName> {
	return new Set(checkPutPreconditions(inp).map((v) => v.precondition));
}

describe("valid-calendar-data", () => {
	test("parse 不能な本文は valid-calendar-data 違反(以降は判定しない)", () => {
		const v = checkPutPreconditions(input({ ics: "not a calendar at all" }));
		expect(v.length).toBe(1);
		expect(v[0]!.precondition).toBe("valid-calendar-data");
	});

	test("妥当な VEVENT は違反ゼロ", () => {
		expect(checkPutPreconditions(input({ ics: veventIcs("u1") }))).toEqual([]);
	});
});

describe("supported-calendar-component(R2)", () => {
	test("supportedComponents 不在なら全受理(VEVENT も VTODO も通る)", () => {
		// supportedComponents を渡さない = プロパティ不在 = 全受理 MUST。
		expect(names(input({ ics: veventIcs("u1") })).has("supported-calendar-component")).toBe(false);
		expect(names(input({ ics: vtodoIcs("u2") })).has("supported-calendar-component")).toBe(false);
	});

	test("VTODO のみ受理のコレクションに VEVENT を置くと違反", () => {
		const supported: ComponentKind[] = ["VTODO"];
		const v = checkPutPreconditions(input({ ics: veventIcs("u1"), supportedComponents: supported }));
		expect(v.some((x) => x.precondition === "supported-calendar-component" && x.rule === "R2")).toBe(true);
	});

	test("VTODO 受理コレクションに VTODO を置くのは OK", () => {
		expect(names(input({ ics: vtodoIcs("u1"), supportedComponents: ["VTODO"] })).has("supported-calendar-component")).toBe(false);
	});
});

describe("no-uid-conflict(R4)", () => {
	test("同 UID を別リソースが保持 → 衝突(conflictHref に相手 uri)", () => {
		const other = resourceUri("other.ics");
		const v = checkPutPreconditions(
			input({
				ics: veventIcs("dup"),
				// UID "dup" は other.ics が既に使用中。
				findUidOwner: (uid): ResourceUri | undefined => (uid === "dup" ? other : undefined),
			}),
		);
		const conflict = v.find((x) => x.precondition === "no-uid-conflict");
		expect(conflict).toBeDefined();
		expect(conflict!.rule).toBe("R4");
		expect(conflict!.conflictHref).toBe(other);
	});

	test("同 UID の保持者が自分自身(同 uri)なら衝突ではない(更新)", () => {
		const target = resourceUri("target.ics");
		const v = checkPutPreconditions(
			input({
				ics: veventIcs("selfsame"),
				targetUri: target,
				// 自分が既にこの UID を持っている(通常の更新)。
				findUidOwner: (uid): ResourceUri | undefined => (uid === "selfsame" ? target : undefined),
				existingUidAt: () => "selfsame",
			}),
		);
		expect(v.some((x) => x.precondition === "no-uid-conflict")).toBe(false);
	});

	test("既存リソースの UID を変更しようとすると違反(更新で UID 変更不可)", () => {
		const target = resourceUri("target.ics");
		const v = checkPutPreconditions(
			input({
				ics: veventIcs("new-uid"),
				targetUri: target,
				// target.ics には元々 old-uid があった。
				existingUidAt: (uri): string | undefined => (uri === target ? "old-uid" : undefined),
			}),
		);
		expect(v.some((x) => x.precondition === "no-uid-conflict" && x.rule === "R4")).toBe(true);
	});
});

describe("max-resource-size(サーバーポリシー)", () => {
	test("上限未満なら通る / 上限超過なら違反", () => {
		const ics = veventIcs("u1");
		expect(names(input({ ics, policy: { maxResourceSize: 10_000 } })).has("max-resource-size")).toBe(false);
		expect(names(input({ ics, policy: { maxResourceSize: 10 } })).has("max-resource-size")).toBe(true);
	});
});
