// =============================================================================
// test/presentation/mcp-done-exit.test.ts — 完了退場(iOS リマインダー準拠・C0-a′)の判定を固定
// =============================================================================
// 【何を保証するか(What)】done-exit.ts の2つの純関数を固定する:
//   - isDoneRowStillInPlace: completedSummary 側の重複排除フィルタが使う「本体側にまだ実体があるか」。
//     猶予中(retiring)・退場アニメ中(exiting)のどちらでも true(=completedSummary 側は隠す)。
//   - shouldScheduleDoneExit: 退場猶予の二重スケジュール防止。既に猶予中/アニメ中なら false
//     (=再スケジュールしない。1回の完了に対して退場は1回だけという不変条件)。
// タイマー本体(setTimeout)・DOM 反映(guardedRenderAll)・sheet gate との整合(仕様3)は
// todos-entry.ts 側の配線(setTimeout/Map/Set)に依存するため、実機/結合レベルの検証は
// docs/log.md の実機検証記録に委ねる(このテストは決定ロジックの固定に絞る)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { isDoneRowStillInPlace, shouldScheduleDoneExit } from "../../src/presentation/mcp/ui/done-exit";

describe("isDoneRowStillInPlace(completedSummary 側の重複排除)", () => {
	test("猶予中(retiring)は本体に実体あり → true(completedSummary 側は隠す)", () => {
		expect(isDoneRowStillInPlace({ retiring: true, exiting: false })).toBe(true);
	});

	test("退場アニメ中(exiting)も本体に実体あり → true", () => {
		expect(isDoneRowStillInPlace({ retiring: false, exiting: true })).toBe(true);
	});

	test("どちらでもない(退場済み or 未完了)→ false(completedSummary 側だけが表示チャンネル)", () => {
		expect(isDoneRowStillInPlace({ retiring: false, exiting: false })).toBe(false);
	});
});

describe("shouldScheduleDoneExit(退場猶予の二重スケジュール防止)", () => {
	test("猶予中でもアニメ中でもない → スケジュールしてよい(true)", () => {
		expect(shouldScheduleDoneExit({ retiring: false, exiting: false })).toBe(true);
	});

	test("【重複排除】既に猶予中 → 再スケジュールしない(false・猶予を延長させない)", () => {
		expect(shouldScheduleDoneExit({ retiring: true, exiting: false })).toBe(false);
	});

	test("既に退場アニメ中 → 再スケジュールしない(false)", () => {
		expect(shouldScheduleDoneExit({ retiring: false, exiting: true })).toBe(false);
	});
});
