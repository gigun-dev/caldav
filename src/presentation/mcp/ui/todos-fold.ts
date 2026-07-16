// =============================================================================
// presentation/mcp/ui/todos-fold.ts — inline displayMode の「畳み」判定(純関数)
//                                       (P4-DM C1+C2・swift-mcp-app 側設計 04 §5)
// =============================================================================
// 【このモジュールの位置づけ】ホストが宣言する containerDimensions.maxHeight(spec:
// apps.mdx:671-733 / spec.types.ts:243-249 の McpUiHostContext.containerDimensions)を
// 使って「行リストを先頭 N 件に畳むべきか」を DOM に一切触れず判定する純関数だけを切り出す。
// feedback.ts / row-key.ts と同じ規律(「新規に書く純関数・定数だけ共有」)。DOM 操作
// (li の間引き・「残り n 件」ノード挿入)は todos-entry.ts 側(renderAll 最終段)が担う。
//
// 【不活性が既定であることの核心(退行ゼロの保証点)】本アプリ(swift-mcp-app)は現状
// containerDimensions.maxHeight を「安全網 4000」または未送信で送る(設計04 §1 現状の表)。
// decideFoldedVisibleCount は maxHeightPx が null のときは即 null(畳まない)を返し、
// 有限値でも「実際の描画高さがそれを超えているとき」だけ畳む。4000 という値そのものは
// 通常のカード内容(todos 数十件でも 4000px は超えにくい)では超過しないため、本アプリでは
// 事実上常に不活性 = 現状の見た目と完全に一致する。この不活性性はコードのロジックのみで
// 保証されており、ホスト側の協力(小さい maxHeight を送る)がない限り作動しない。
//
// 【なぜ「N 件固定」であって「行高から件数を逆算」ではないか】
// 設計04 §5 C2 は「先頭 N 件(定数・初期 6)に畳む」と明記している。行の実高さは due の有無・
// 優先度バッジ・スワイプ状態等で行ごとに変動し、行高から動的に件数を逆算する版は複雑さの
// 割に精度が低い(結局 maxHeight 内に収まる保証にはならない)。固定 N はどのカードでも
// 「まず何件か見えて、残りは要求すれば見える(C3)」という体感を単純に作れる — 可逆な1定数。
// =============================================================================

/** 畳み後に見せる先頭行数(固定)。設計04 §5 C2 の初期値どおり 6。値の変更だけで挙動を
 *  調整できる(可逆)。 */
export const FOLD_VISIBLE_COUNT = 6;

/** decideFoldedVisibleCount の入力。DOM から読める値だけを渡す形にし、この関数自体は
 *  document / window に一切触れない(テスト容易性のため — feedback.ts の isCommitting と
 *  同じ「呼び出し側が値を渡す」設計)。 */
export interface FoldDecisionInput {
	/** ホストが宣言した inline の空間上限(px)。containerDimensions.maxHeight が無い
	 *  ホスト(現本アプリ含む)・fixed height 契約({height} 側)のホストでは null を渡す。 */
	maxHeightPx: number | null;
	/** getHostContext().displayMode。undefined/未受信は「inline とみなす」側にせず null を渡し
	 *  呼び出し側の判断に委ねる(下記 displayMode !== "inline" の分岐で不活性になる)。 */
	displayMode: string | null;
	/** renderAll がフル描画した直後に測った実高さ(root.scrollHeight 等・px)。 */
	actualHeightPx: number;
	/** 畳み対象セクション(期限切れ/今日/今後/期日なし)の合計行数。完了済み(<details> 既定閉)・
	 *  ドラフト行は対象外(常時表示のまま — 完了済みは元々閉じているので高さに寄与せず、
	 *  ドラフト行は入力中の行を隠すと編集不能になり体験を損なう)。 */
	totalCount: number;
	/** 畳んだときに見せる件数(固定・FOLD_VISIBLE_COUNT を渡すのが既定)。 */
	foldToCount: number;
}

/**
 * 「行リストを先頭 foldToCount 件に畳むべきか」を判定する純関数。
 *
 * @returns 畳むべきときは表示件数(= min(foldToCount, totalCount) 未満にはならない)、
 *          畳まないときは null(呼び出し側は全件表示のまま = 不活性)。
 *
 * 判定条件(すべて真のときだけ畳む。設計04 §5 C2):
 *   1. maxHeightPx が有限(null でない) — maxHeight 情報が無いホストは不活性が既定。
 *   2. displayMode === "inline" — fullscreen 中は畳まない(C3 で全件+内部スクロールに切替。
 *      その段は fullscreen 側の別経路が担うのでここでは判定しない)。
 *   3. actualHeightPx > maxHeightPx — 実際に収まりきらないときだけ畳む(収まっているカードを
 *      理由なく畳むと「行数が少ないのに勝手に省略される」誤動作になる)。
 */
export function decideFoldedVisibleCount(input: FoldDecisionInput): number | null {
	if (input.maxHeightPx === null) return null;
	if (input.displayMode !== "inline") return null;
	if (input.actualHeightPx <= input.maxHeightPx) return null;
	// 既に foldToCount 件以下しかない(=畳んでも件数が変わらない)なら畳む意味が無い。
	if (input.totalCount <= input.foldToCount) return null;
	return input.foldToCount;
}
