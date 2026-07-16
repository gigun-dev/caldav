// =============================================================================
// presentation/mcp/ui/todos-fold.ts — inline displayMode の「畳み」判定(純関数)
//                                       (P4-DM C1+C2・swift-mcp-app 側設計 04 §5)
// =============================================================================
// 【このモジュールの位置づけ】ホストが宣言する containerDimensions.maxHeight(spec:
// apps.mdx:671-733 / spec.types.ts:243-249 の McpUiHostContext.containerDimensions)を
// 使って「行リストをどこまで見せれば maxHeight に収まるか」を DOM に一切触れず判定する
// 純関数だけを切り出す。feedback.ts / row-key.ts と同じ規律(「新規に書く純関数・定数だけ
// 共有する」)。DOM 操作(li の間引き・「すべて表示」ノード挿入・FAB の hide)は
// todos-entry.ts 側(renderAll 最終段の applyInlineFold)が担う。
//
// 【不活性が既定であることの核心(退行ゼロの保証点)】本アプリ(swift-mcp-app)は現状
// containerDimensions.maxHeight を「安全網 4000」または未送信で送る(設計04 §1 現状の表)。
// computeInlineFit は maxHeightPx が有限でない(null/undefined→呼び出し側で Infinity 化)
// ときは即 { mode: "full" } を返し、有限値でも「フル描画時の全高(FAB込み)がそれ以下」
// なら畳まない。4000 という値そのものは通常のカード内容(todos 数十件でも 4000px は超え
// にくい)では超過しないため、本アプリでは事実上常に不活性 = 現状の見た目と完全に一致する。
// この不活性性はコードのロジックのみで保証されており、ホスト側の協力(小さい maxHeight を
// 送る)がない限り作動しない。
//
// 【2026-07-17 更新: 固定 N=6 の畳み(旧 decideFoldedVisibleCount)を廃止し動的フィットへ改訂】
// 旧実装は「行数が FOLD_VISIBLE_COUNT(6)を超えていたら先頭6件に畳む」という**件数閾値**
// だった。これは実機で破綻した: todos がちょうど6件(または6件強)のとき「6件以下だから
// 畳まない」と判定されるが、行高(due バッジ・優先度・繰り返しアイコンの有無で可変)次第では
// 6件の実高さがそのまま maxHeight を超え、host 側は scrollEnabled=false で maxHeight
// クランプするため **カード下端の FAB(+)が maxHeight の外にクリップされ、隠れて操作不能に
// なる**。件数閾値は「行高が可変・maxHeight が端末依存」という前提の下では原理的に高さを
// 保証できない(ボツ・経緯は財産として残す — 「N を1ずつ減らしながら再測定するループ」も
// 検討したが、DOM の累積オフセットを1回読めば同じ答えが閉じた形で求まるので不要な複雑さ)。
//
// 改訂後は「maxHeight に収まる**行数**を、行ごとの累積下端(offsetTop+offsetHeight)から
// 直接逆算する」動的フィットに切り替える。「すべて表示」ボタンの高さ(下余白込み)を
// budget から**先引き**するのが要点 — 旧実装は「畳む件数を決めてからボタンを append する」
// 順序だったため、ボタン自身の高さが収まり計算の外にあり(=それも隠れバグの一因)、今回の
// 改訂で構造的に解消する(todos-entry.ts の applyInlineFold 側コメント参照)。
// =============================================================================

/** computeInlineFit の戻り値。件数を決め打ちで返すのではなく、「畳まず全部見せてよいか
 *  (full)」「先頭何件までなら maxHeight に収まるか(folded)」の二択にする — 呼び出し側
 *  (applyInlineFold)はこの結果をそのまま DOM の間引きに使えばよく、追加の場合分けを
 *  持たない。 */
export type InlineFit = { mode: "full" } | { mode: "folded"; visibleCount: number };

/**
 * inline displayMode で「行リストをどこまで見せれば maxHeight に収まるか」を判定する
 * 純関数(DOM に一切触れない — 呼び出し側が実測値を渡す)。
 *
 * @param rowBottoms 畳み対象の各行の、root 基準の累積下端(`li.offsetTop + li.offsetHeight`)を
 *   文書順に並べた配列。行高は due/優先度バッジ等で行ごとに可変なので、件数ではなく
 *   この実測配列から「maxHeight に収まる行数」を直接求める(旧・固定 N=6 の破綻を根治)。
 * @param fullHeight FAB・余白込みのフル描画時の全高(`root.scrollHeight`)。旧実装は
 *   「行の合計」だけを見ていたため FAB 分の高さが計算に入らず、6件ちょうど等で
 *   「行だけなら収まるが FAB を足すと溢れる」ケースを見逃していた(再発バグの核心)。
 * @param maxHeight ホストが宣言した inline の空間上限(px)。containerDimensions.maxHeight が
 *   無い/未送信のホストは呼び出し側が `Infinity` を渡す(旧 API の `null` 分岐は呼び出し側で
 *   Infinity に正規化する形に統一 — 純関数側は「有限か否か」の1判定に絞る)。
 * @param buttonBlock 「すべて表示」ボタン(下余白込み)の高さ(px)。**budget から先引きする
 *   のが本関数の核心** — 畳み決定より後にボタンを append すると、ボタン自身の高さぶん
 *   maxHeight を超過してしまう(旧実装の欠陥。todos-entry.ts 側で hidden 実測して渡す)。
 * @returns 収まる(fullHeight <= maxHeight)なら `{mode:"full"}`。溢れるなら
 *   `{mode:"folded", visibleCount}`(budget=maxHeight-buttonBlock に収まる最大行数。
 *   1行も収まらない極端なケースでも最低1行は見せる)。
 */
export function computeInlineFit(
	rowBottoms: readonly number[],
	fullHeight: number,
	maxHeight: number,
	buttonBlock: number,
): InlineFit {
	// maxHeight 情報が無い(Infinity)ホストは常に不活性(旧・不活性ホスト分岐を維持)。
	if (!(maxHeight < Infinity)) return { mode: "full" };
	// FAB 込みの全高が既に maxHeight に収まっているなら畳む理由が無い(旧実装と同じ判定基準だが、
	// 今回は「行の合計」ではなく root.scrollHeight = FAB・余白込みの実測値で判定するので
	// 「行だけなら収まるが FAB で溢れる」再発バグのケースを正しく folded 側に倒せる)。
	if (fullHeight <= maxHeight) return { mode: "full" };
	// ボタン(+ 下余白)ぶんを先に引いた予算の中に収まる最大行数を、累積下端から直接求める。
	// これにより「畳み決定 → 後からボタンを足す」だった旧実装の順序逆転バグ(ボタン高が
	// 収まり計算の外にあった)が構造的に発生しなくなる。
	const budget = maxHeight - buttonBlock;
	const visibleCount = rowBottoms.filter((bottom) => bottom <= budget).length;
	// budget がどれだけ小さくても(極端な maxHeight・大きい buttonBlock)最低1行は見せる —
	// 0件表示は「一覧が消えた」ように見えてしまい、ユーザーが状況を把握できなくなるため。
	return { mode: "folded", visibleCount: Math.max(1, visibleCount) };
}

// --- C3: 「すべて表示」ボタン vs 受動「残り n 件」表示の分岐(設計04 §5 C3) -----------------
// 【なぜこれだけ切り出すか】この判定自体は DOM/SDK に触れない1行の真偽判定だが、「死にボタンを
// 出さない」という設計04 の fable 指摘(§5 の 2026-07-16 更新)がこのプロダクトの安全性要件の
// 中核なので、todos-entry.ts に埋め込まず独立した名前を与えてテストで固定する。
// apps.mdx:782(View は requestDisplayMode 前に availableDisplayModes を確認する MUST)の
// 「確認」をこの関数が担う — availableDisplayModes に "fullscreen" が無いホスト(または
// hostContext 自体が届いていない/配列が空の)場合は false を返し、呼び出し側は受動表示のまま
// にする(押しても requestDisplayMode が拒否 or 送信自体をしない = 死にボタンを作らない)。
/**
 * ホストが fullscreen への昇格を受理しうるか(= 「すべて表示」ボタンをタップ可能にしてよいか)を
 * 判定する純関数。
 *
 * @param availableDisplayModes getHostContext().availableDisplayModes(applyHostContext が
 *   保持しているホスト広告値)。未受信/未広告のホストは null を渡す。
 */
export function canRequestFullscreen(availableDisplayModes: readonly string[] | null): boolean {
	if (availableDisplayModes === null) return false;
	return availableDisplayModes.includes("fullscreen");
}
