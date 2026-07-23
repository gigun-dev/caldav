// =============================================================================
// test/presentation/mcp-freshness.test.ts — 2026-07-23 SWR 完全形の鮮度判定コアを固定
// =============================================================================
// 【何を保証するか(What)】
// shouldRevalidateOnPush(freshness.ts)が push(ontoolresult)経路の generatedAt から
// 「背景 revalidate を1回スケジュールすべきか」を正しく判定すること。
//  (1) MOUNT_REVALIDATE_MS を超えて古い generatedAt の push は revalidate=true。
//  (2) MOUNT_REVALIDATE_MS 以内の新しい generatedAt の push は revalidate=false
//      (履歴復元の楽観表示を数十秒で正す SWR 完全形。無条件 revalidate はしない —
//      freshness.ts 冒頭コメントの「無条件 revalidate をしない理由」参照)。
//  (3) generatedAt 欠落(旧サーバー応答/キャッシュ)は revalidate=false へフォールバックする
//      (fail-closed にしない。todos-entry.ts/agenda-entry.ts は push=新鮮の従来挙動へ落ちる)。
//  (4) generatedAt が now より未来(クロックスキュー)でも age を 0 clamp し、誤って
//      「古い」と判定しない。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { MOUNT_REVALIDATE_MS, shouldRevalidateOnPush } from "../../src/presentation/mcp/ui/freshness";

describe("shouldRevalidateOnPush", () => {
	test("MOUNT_REVALIDATE_MS を超えて古い generatedAt の push は背景 refetch を要求する(true)", () => {
		const now = 1_000_000;
		const generatedAt = now - (MOUNT_REVALIDATE_MS + 1);
		expect(shouldRevalidateOnPush(generatedAt, now)).toBe(true);
	});

	test("MOUNT_REVALIDATE_MS ちょうどの古さは境界(超過のみ true)なので発火しない", () => {
		const now = 1_000_000;
		const generatedAt = now - MOUNT_REVALIDATE_MS;
		expect(shouldRevalidateOnPush(generatedAt, now)).toBe(false);
	});

	test("新しい generatedAt(直近)の push は背景 refetch を発火しない(false)", () => {
		const now = 1_000_000;
		const generatedAt = now - 500; // 0.5秒前
		expect(shouldRevalidateOnPush(generatedAt, now)).toBe(false);
	});

	test("generatedAt 欠落(旧サーバー応答/フィクスチャ)は false へフォールバックする(fail-closed にしない)", () => {
		const now = 1_000_000;
		expect(shouldRevalidateOnPush(undefined, now)).toBe(false);
	});

	test("generatedAt が now より未来(クロックスキュー)でも age を 0 clamp し、古いと誤判定しない", () => {
		const now = 1_000_000;
		const generatedAt = now + 5_000; // サーバー時計がわずかに進んでいるケース
		expect(shouldRevalidateOnPush(generatedAt, now)).toBe(false);
	});
});
