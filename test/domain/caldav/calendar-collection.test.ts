// =============================================================================
// CalendarCollection.changesSince のテスト(RFC 6578 §3.4/§3.5)
// =============================================================================
// 検証項目(タスク指定):
//   - created→modified の畳み込み(1件 "changed")
//   - 同期間隔内 created→deleted は removed 報告(§3.5)
//   - 無効トークンの区別({valid:false})
import { describe, expect, test } from "bun:test";
import {
	CalendarCollection,
	SyncToken,
	collectionId,
	principalPath,
	resourceUri,
	type SyncReport,
} from "../../../src/domain/caldav";

// テスト用コレクションを1つ作る(メタデータは sync に無関係なので最小)。
function newCollection(): CalendarCollection {
	return new CalendarCollection({
		id: collectionId("work"),
		owner: principalPath("/principals/users/alice/"),
		displayName: "Work",
	});
}

// SyncReport の集合を [uri, change] のタプル集合へ(順序非依存に比較するため)。
function asPairs(reports: SyncReport[]): Set<string> {
	return new Set(reports.map((r) => `${r.uri}:${r.change}`));
}

describe("changesSince: created→modified の畳み込み", () => {
	test("同一メンバーを created→modified しても 1 件 changed に畳む", () => {
		const col = newCollection();
		const a = resourceUri("a.ics");
		// トークンを取ってから create→modify する。
		const before = col.syncToken;
		col.recordChange(a, "created");
		col.recordChange(a, "modified");

		const result = col.changesSince(before);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(asPairs(result.changes)).toEqual(new Set(["a.ics:changed"]));
		// newToken は現在値まで進んでいる(2 回変更 = counter 2)。
		expect(result.newToken.counter).toBe(2);
	});
});

describe("changesSince: 同期間隔内 created→deleted は removed(§3.5)", () => {
	test("baseline 以降に追加→削除されたメンバーは removed として報告する", () => {
		const col = newCollection();
		const a = resourceUri("a.ics");
		const b = resourceUri("b.ics");
		// baseline より前に b を作っておく(既存メンバー)。
		col.recordChange(b, "created");
		const baseline = col.syncToken; // ここをクライアントのトークンとする

		// 同期間隔内に a を作ってすぐ消す。b は更新。
		col.recordChange(a, "created");
		col.recordChange(a, "deleted");
		col.recordChange(b, "modified");

		const result = col.changesSince(baseline);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		// a は removed(§3.5)、b は changed。
		expect(asPairs(result.changes)).toEqual(new Set(["a.ics:removed", "b.ics:changed"]));
	});

	test("初回同期(undefined)では net-removed を報告しない", () => {
		const col = newCollection();
		const a = resourceUri("a.ics");
		const b = resourceUri("b.ics");
		col.recordChange(a, "created");
		col.recordChange(a, "deleted"); // 作って消した(クライアントは知らない)
		col.recordChange(b, "created"); // 現存

		const result = col.changesSince(undefined);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		// 現存する b だけ changed。作って消えた a は初回では出さない。
		expect(asPairs(result.changes)).toEqual(new Set(["b.ics:changed"]));
	});
});

describe("changesSince: 無効トークンの区別", () => {
	test("現在より未来を指すトークンは invalid", () => {
		const col = newCollection();
		col.recordChange(resourceUri("a.ics"), "created"); // counter = 1
		// counter=5 は本コレクションが未だ到達していない未来 → 差分計算不能。
		const future = SyncToken.of(5);
		expect(col.changesSince(future).valid).toBe(false);
	});

	test("現在ちょうどのトークンは valid で差分ゼロ", () => {
		const col = newCollection();
		col.recordChange(resourceUri("a.ics"), "created");
		const now = col.syncToken;
		const result = col.changesSince(now);
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.changes).toEqual([]);
	});
});

describe("ctag は sync カウンタから導出され、変更で必ず変わる", () => {
	test("recordChange で ctag が変化する", () => {
		const col = newCollection();
		const before = col.ctag;
		col.recordChange(resourceUri("a.ics"), "created");
		expect(col.ctag.equals(before)).toBe(false);
	});
});

describe("accepts(R2): supportedComponents 不在なら全受理", () => {
	test("undefined なら VEVENT/VTODO とも受理", () => {
		const col = newCollection(); // supportedComponents 未指定
		expect(col.accepts("VEVENT")).toBe(true);
		expect(col.accepts("VTODO")).toBe(true);
	});

	test("指定ありなら含まれる種別だけ受理", () => {
		const col = new CalendarCollection({
			id: collectionId("reminders"),
			owner: principalPath("/principals/users/alice/"),
			displayName: "Reminders",
			supportedComponents: ["VTODO"],
		});
		expect(col.accepts("VTODO")).toBe(true);
		expect(col.accepts("VEVENT")).toBe(false);
	});
});
