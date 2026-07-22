// =============================================================================
// test/presentation/mcp-fold.test.ts — inline 畳み判定(fold.ts・畳み共有カーネル)の境界値テスト
//                                       (P4-DM C1+C2・swift-mcp-app 側設計 04 §5・
//                                        2026-07-17 動的フィット改訂で computeInlineFit に移行)
// =============================================================================
// 【何を保証するか(What)】本アプリ(swift-mcp-app)相当(maxHeight 未送信=Infinity)で畳みが
// 一切発火しない(不活性が既定)ことと、有限 maxHeight を送るホストでは「すべて表示」ボタン
// +FAB(bottomChrome・2026-07-17 追更新で FAB を budget 先引きに合算)の高さを先引きした
// budget から、行の累積下端(実測)を直接使って収まる行数を求めること(旧・固定 N=6 の
// 件数閾値では 6件ちょうど+FAB のクリップ再発バグを防げなかった)を、DOM 無しの純関数
// レベルで固定する。
//
// 【共有カーネル化(2026-07-17・fold.ts へリネーム)】computeInlineFit は todos だけでなく
// agenda カード(occurrence 行単位の畳み・日見出しを rowBottoms の累積 offset に織り込む)からも
// 使う純関数になった。テスト末尾に agenda 特有の系列(見出し高が rowBottoms のオフセットに
// 混ざるケース・日境界ちょうどで切れるケース)を追加し、両カードの前提を1ファイルで固定する。
//
// 【2026-07-17 追更新②(C0-b・意味の書き換え): computeInlineFit の役割が「畳み」から
// 「inline プレビューの安全クランプ」に変わった(fold.ts 冒頭コメント参照)】computeInlineFit の
// 純関数ロジック自体は無改造なので、下の物理フィットの境界値テスト(maxHeight にどこまで収まるか)は
// そのまま有効=削らない。新モデルの「inline は高々 INLINE_PREVIEW_MAX 件」というプロダクト方針は
// 呼び出し側(*-entry.ts の applyInlineFold)が `min(INLINE_PREVIEW_MAX, フィット件数)` で合成する
// ため、ここでは定数 INLINE_PREVIEW_MAX の値と「min 合成」の意味を固定するテストを足す(DOM を伴う
// applyInlineFold 側の実挙動は純関数レベルでは検証できないので、合成規則を式として明示するに留める)。
// =============================================================================
import { describe, expect, test } from "bun:test";
import { INLINE_PREVIEW_MAX, boundPreviewList, canRequestFullscreen, computeInlineFit } from "../../src/presentation/mcp/ui/fold";

describe("computeInlineFit", () => {
	test("maxHeight 未送信(Infinity)は不活性(本アプリの現状=退行ゼロ)", () => {
		expect(computeInlineFit([100, 200, 300], 9999, Infinity, 60)).toEqual({ mode: "full" });
	});

	test("フル描画時の全高(FAB込み)が maxHeight 以下なら不活性(等号を含む)", () => {
		expect(computeInlineFit([100, 200, 300], 350, 350, 60)).toEqual({ mode: "full" });
	});

	test("maxHeight=4000(現行の安全網値)でも実高さがそれ以下なら不活性", () => {
		expect(computeInlineFit([200, 500, 900], 1200, 4000, 60)).toEqual({ mode: "full" });
	});

	test("溢れる場合、ボタン高を先引きした budget に収まる最大行数へ畳む", () => {
		// rowBottoms=[100,200,300,400], maxHeight=350, bottomChrome=60 → budget=290 → 100,200 が収まり visibleCount=2
		expect(computeInlineFit([100, 200, 300, 400], 500, 350, 60)).toEqual({
			mode: "folded",
			visibleCount: 2,
		});
	});

	test("ボタン高の先引きが境界の行数を1減らす(旧実装の欠陥だったケース)", () => {
		// budget=maxHeight-bottomChrome を引かなければ 300 も収まってしまうが、
		// bottomChrome 分を先に引くことで境界の1行(300)が収まらなくなる。
		expect(computeInlineFit([100, 200, 300, 400], 500, 320, 60)).toEqual({
			mode: "folded",
			visibleCount: 2,
		});
	});

	test("budget が極端に小さく1行も収まらなくても最低1行は見せる", () => {
		expect(computeInlineFit([100, 200, 300], 500, 50, 60)).toEqual({
			mode: "folded",
			visibleCount: 1,
		});
	});

	// --- agenda カード特有(occurrence 行単位・日見出し高が rowBottoms に織り込まれる)-------
	// agenda の畳み単位は occurrence 行(li)だが、行は日セクション見出し(.section の div)ごとに
	// グループ化されて縦に並ぶ。computeInlineFit は「見出しを別枠で数える」のではなく、各行の
	// root 基準の累積下端(li.offsetTop+li.offsetHeight)をそのまま渡す設計なので、見出しの高さは
	// 各行の offsetTop に自然に加算されて入ってくる(関数側は無改造で流用できる、という設計04 の前提)。
	// 以下は「見出し高が rowBottoms のオフセットに混ざった系列」で visibleCount が正しく出ることを固定する。
	test("agenda: 見出し高が rowBottoms の累積 offset に混ざる系列でも visibleCount が正しい", () => {
		// 例: 2日分。1日目の見出し(高さ30)+ 行3本(各40)→ 下端 70,110,150。
		// 2日目の見出し(高さ30・累積で 180 から)+ 行2本(各40)→ 下端 220,260。
		// maxHeight=200, bottomChrome=40 → budget=160。160 以下は 70,110,150 の3行 → visibleCount=3。
		// (見出しの分だけ各行の offset が押し下がっているので、素朴な「行高だけの累積」より少なく収まる。)
		expect(computeInlineFit([70, 110, 150, 220, 260], 300, 200, 40)).toEqual({
			mode: "folded",
			visibleCount: 3,
		});
	});

	test("agenda: 日境界ちょうど(2日目の先頭行下端)で切れる", () => {
		// 上と同じ系列。budget を 220 ちょうどに合わせる(maxHeight=260, bottomChrome=40)。
		// 220 <= 220 なので2日目の先頭行(220)まで収まり visibleCount=4。日境界の等号を含めて拾う。
		expect(computeInlineFit([70, 110, 150, 220, 260], 300, 260, 40)).toEqual({
			mode: "folded",
			visibleCount: 4,
		});
	});
});

describe("INLINE_PREVIEW_MAX(C0-b・inline プレビュー上限)", () => {
	test("設計05 §4・モック inline-preview.html に合わせて N=5", () => {
		expect(INLINE_PREVIEW_MAX).toBe(5);
	});

	// applyInlineFold は `min(INLINE_PREVIEW_MAX, computeInlineFit のフィット件数)` で表示件数を
	// クランプする。ここではその合成規則を式として固定する(DOM は伴わない純粋な算術)。
	// フィット件数 = computeInlineFit が full なら全行数・folded なら visibleCount、と呼び出し側で読む。
	const clampPreview = (fitCount: number): number => Math.min(INLINE_PREVIEW_MAX, fitCount);

	test("maxHeight 無制限(full=全行フィット)でもプレビューは高々 N 件に束ねる", () => {
		// 例: 全12行フィットでも inline は 5 件だけ見せ、残り 7 件はフッタ「他 7 件の未完了」へ(タップで全画面)。
		expect(clampPreview(12)).toBe(INLINE_PREVIEW_MAX);
	});

	test("端末の maxHeight が小さく N 件未満しか収まらない場合は computeInlineFit のフィット件数が勝つ", () => {
		// 安全クランプ: N=5 でも小さい maxHeight で 3 件しか収まらないなら 3 件(min が拾う)。
		expect(clampPreview(3)).toBe(3);
	});
});

describe("boundPreviewList(カード UI 原則 (b) 是正③・2026-07-23・agenda 月ビュー下段の有界化)", () => {
	test("既定の N(INLINE_PREVIEW_MAX)以下なら全件可視・remaining=0", () => {
		const items = [1, 2, 3];
		expect(boundPreviewList(items)).toEqual({ visible: [1, 2, 3], remaining: 0 });
	});

	test("既定の N を超えると先頭 N 件だけ可視・残りは件数のみ", () => {
		const items = [1, 2, 3, 4, 5, 6, 7];
		expect(boundPreviewList(items)).toEqual({ visible: [1, 2, 3, 4, 5], remaining: 2 });
		expect(INLINE_PREVIEW_MAX).toBe(5); // このテストが暗黙依存する定数値を明示的にも固定する
	});

	test("ちょうど N 件は remaining=0(境界の等号)", () => {
		const items = [1, 2, 3, 4, 5];
		expect(boundPreviewList(items)).toEqual({ visible: [1, 2, 3, 4, 5], remaining: 0 });
	});

	test("max を明示指定すると既定 N を無視してそちらに従う", () => {
		expect(boundPreviewList([1, 2, 3, 4], 2)).toEqual({ visible: [1, 2], remaining: 2 });
	});

	test("空配列は visible=[] remaining=0", () => {
		expect(boundPreviewList([])).toEqual({ visible: [], remaining: 0 });
	});
});

describe("canRequestFullscreen", () => {
	test("availableDisplayModes 未受信(null)は受動表示のまま(死にボタンを出さない)", () => {
		expect(canRequestFullscreen(null)).toBe(false);
	});

	test("availableDisplayModes に fullscreen が無いホスト(inline のみ広告)は受動表示のまま", () => {
		expect(canRequestFullscreen(["inline"])).toBe(false);
	});

	test("availableDisplayModes に fullscreen があるホストはボタン化してよい", () => {
		expect(canRequestFullscreen(["inline", "fullscreen"])).toBe(true);
	});
});
