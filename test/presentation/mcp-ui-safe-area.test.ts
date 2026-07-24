// =============================================================================
// presentation/mcp/ui/safe-area.ts の純関数テスト(安全先頭規約・2026-07-23 カード UI 原則 (b) 是正①)
// =============================================================================
// 【何を保証するか(What)】HostContext.safeAreaInsets を CSS 変数へ落とす px 値の決定ロジックが
// docs/modeling/15 §B-3 の優先順位(申告値 > フォールバック > 0)どおりに振る舞うこと。
// フォールバックは「未申告(undefined/0) かつ fullscreen/inline」のときだけ発動し、申告済み
// ホストでは絶対に発動しない(二重余白を作らない・§B-4 のボツ案の裏返し)ことを固定する。
// top は fullscreen 限定のフォールバックのまま(2026-07-24 #48/#50 是正Aは bottom のみ inline へ拡張。
// top の inline occlusion は今回のフィードバックの対象外)。
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
	FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX,
	FULLSCREEN_SAFE_TOP_FALLBACK_PX,
	INLINE_SAFE_BOTTOM_FALLBACK_PX,
	resolveSafeBottomPx,
	resolveSafeTopPx,
} from "../../src/presentation/mcp/ui/safe-area";

describe("resolveSafeTopPx", () => {
	test("申告値がある(top>0)ならそれを採用する(displayMode に関わらず)", () => {
		expect(resolveSafeTopPx({ top: 44, right: 0, bottom: 0, left: 0 }, "fullscreen")).toBe(44);
		expect(resolveSafeTopPx({ top: 20, right: 0, bottom: 0, left: 0 }, "inline")).toBe(20);
	});

	test("未申告(undefined) かつ fullscreen ならフォールバック値を使う", () => {
		expect(resolveSafeTopPx(undefined, "fullscreen")).toBe(FULLSCREEN_SAFE_TOP_FALLBACK_PX);
	});

	test("top===0 の申告も未申告側へ寄せる(fullscreen ならフォールバック)", () => {
		// 【意図】仕様上「0 は明示的申告」と「クローム分を含めない実装のたまたま 0」を区別する
		// シグナルが無いため、保守的に未申告扱いにする(safe-area.ts の resolveSafeTopPx コメント参照)。
		expect(resolveSafeTopPx({ top: 0, right: 0, bottom: 0, left: 0 }, "fullscreen")).toBe(FULLSCREEN_SAFE_TOP_FALLBACK_PX);
	});

	test("未申告でも inline / null(displayMode 未受信)ではフォールバックを発動しない", () => {
		expect(resolveSafeTopPx(undefined, "inline")).toBe(0);
		expect(resolveSafeTopPx(undefined, null)).toBe(0);
	});

	test("申告済みホストではフォールバックが絶対に発動しない(inline でも fullscreen でも申告値のみ)", () => {
		expect(resolveSafeTopPx({ top: 12, right: 0, bottom: 0, left: 0 }, null)).toBe(12);
	});
});

describe("resolveSafeBottomPx", () => {
	test("申告値(bottom>0)があればそれを使う(displayMode に関わらず)", () => {
		expect(resolveSafeBottomPx({ top: 0, right: 0, bottom: 34, left: 0 })).toBe(34);
		expect(resolveSafeBottomPx({ top: 0, right: 0, bottom: 34, left: 0 }, "fullscreen")).toBe(34);
	});

	// 【2026-07-23 追加: composer occlusion フォールバック】claude.ai iOS の下部 composer クロームは
	// safeAreaInsets.bottom に申告されない実測反証を受け、top と対称のフォールバックを設けた。
	test("未申告(undefined) かつ fullscreen ならフォールバック値を使う", () => {
		expect(resolveSafeBottomPx(undefined, "fullscreen")).toBe(FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX);
	});

	test("bottom===0 の申告も未申告側へ寄せる(fullscreen ならフォールバック)", () => {
		expect(resolveSafeBottomPx({ top: 0, right: 0, bottom: 0, left: 0 }, "fullscreen")).toBe(
			FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX,
		);
	});

	// 【2026-07-24 実機フィードバック #48/#50・是正A追加】inline の action-row(完了済み/他n件/⊕)が
	// composer に隠れる occlusion 実害を受け、inline にも未申告時フォールバックを追加した。
	// fullscreen とは異なる控えめな値(INLINE_SAFE_BOTTOM_FALLBACK_PX)を使う。
	test("未申告(undefined) かつ inline なら inline 専用フォールバック値を使う", () => {
		expect(resolveSafeBottomPx(undefined, "inline")).toBe(INLINE_SAFE_BOTTOM_FALLBACK_PX);
	});

	test("bottom===0 の申告も未申告側へ寄せる(inline なら inline フォールバック)", () => {
		expect(resolveSafeBottomPx({ top: 0, right: 0, bottom: 0, left: 0 }, "inline")).toBe(
			INLINE_SAFE_BOTTOM_FALLBACK_PX,
		);
	});

	test("null(displayMode 未受信) / displayMode 省略ではフォールバックを発動しない(後方互換)", () => {
		expect(resolveSafeBottomPx(undefined, null)).toBe(0);
		// displayMode 引数を省略した既存呼び出しは undefined → 非 fullscreen/inline 扱いで従来どおり 0。
		expect(resolveSafeBottomPx(undefined)).toBe(0);
		expect(resolveSafeBottomPx({ top: 0, right: 0, bottom: 0, left: 0 })).toBe(0);
	});
});
