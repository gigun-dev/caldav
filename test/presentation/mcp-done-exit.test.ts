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
//
// 【2026-07-23 追加(退行#5「done 行が3秒後に移動しない」の随伴修正)】
// 回帰の原因は resetPositionMemory(todos-entry.ts)が「実質別ビューへの切り替え」のたびに
// retiringDoneIds/exitingDoneIds の setTimeout を clearTimeout で握りつぶしていたこと。猶予中に
// リスト切替(switchCalendar)や別ビューでの list-todos push(viewChanged)が起きると、予約済みの
// finishDoneExit が二度と発火せず、その行は完了済みチェックが付いたまま元セクションに永遠に残った。
// 修正は2箇所: ①resetPositionMemory から retiringDoneIds/exitingDoneIds の掃除を削除(タイマーは
// ビュー切替をまたいで生存させる)。②renderAll の affectedItems 合成ループに
// isDoneRowStillInPlace ガードを追加(退場完了後に affectedById の古いエントリが completed バケツへ
// 復活し続ける不変条件違反の随伴修正)。①はタイマー配線(setTimeout)そのものなので DOM 結合レベル
// でしか検証できないが、②が使う isDoneRowStillInPlace の判定はこのファイルの純関数そのもの —
// 「退場完了後(retiring=false かつ exiting=false)は affected 合成の対象から外れる(false)」という
// 契約を、下の describe ブロックで completedSummary 側の重複排除と同じ関数として明示的に固定する
// (1つの純関数を2つの消費者[renderAll の affectedItems 合成 / completedSummary の重複排除]が
// 同じ意味で使う、という設計そのものをテストの説明文で残す)。
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

describe("isDoneRowStillInPlace(退行#5 随伴修正: renderAll の affectedItems 合成ガードとしても使う)", () => {
	test("退場完了後(false,false)は affected 合成の対象から外れる(=affectedById の古いエントリを二度と拾わない)", () => {
		// renderAll は `isDoneRowStillInPlace({retiring, exiting})` が false の id を
		// affectedItems(completed の擬似行合成)へ二度と加えない。ビュー切替をまたいでタイマーが
		// 生存し finishDoneExit が正常発火した後は、この判定が false になって初めて「本体セクションから
		// 消え completedSummary 側だけの表示へ収束する」という退場の最終状態が成立する。
		expect(isDoneRowStillInPlace({ retiring: false, exiting: false })).toBe(false);
	});

	test("猶予中/退場アニメ中は affected 合成を継続する(=退場の途中で行が一瞬消えたりしない)", () => {
		expect(isDoneRowStillInPlace({ retiring: true, exiting: false })).toBe(true);
		expect(isDoneRowStillInPlace({ retiring: false, exiting: true })).toBe(true);
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
