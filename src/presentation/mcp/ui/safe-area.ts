// =============================================================================
// presentation/mcp/ui/safe-area.ts — 安全先頭(safe top)規約の共有カーネル
//                                     (2026-07-23 カード UI 原則 (b) 是正①・docs/modeling/15 §B-3)
// =============================================================================
// 【このファイルの位置づけ】
//   todos-entry.ts / agenda-entry.ts の両方の applyHostContext() が呼ぶ純関数群。DOM 非依存
//   (bun:test で境界を固定できるようにする — fold.ts / day-timeline.ts が先例)。CSS 変数の実際の
//   setProperty は呼び出し側(各 entry の applyHostContext)が行う(ここは「いくつにすべきか」の
//   判断だけを担い、「どう当てるか」は各 entry に残す — 責務を混ぜない)。
//
// 【何のためにあるか(modeling/15 §B-3)】
//   fullscreen カードの上部は、ホストのクローム(例: claude.ai iOS の liquid glass ヘッダ)に
//   物理的に削られる。これを吸収する優先順位は次のとおり:
//     1. 第一優先: HostContext.safeAreaInsets(MCP Apps 仕様に存在するフィールド)を読み、
//        CSS 変数へ落として fullscreen コンテナの padding-top へ一元適用する。
//     2. フォールバック: safeAreaInsets が未申告のときのみ、モバイル fullscreen 限定の実測値に
//        よるフォールバックを使う。
//   CSS の env(safe-area-inset-*) は iframe 内では効かない(トップレベルドキュメント基準)ため
//   使わない。
// =============================================================================

/** HostContext.safeAreaInsets の写経(ローカル interface。ui は末端 — ext-apps の型を直接使っても
 *  依存境界的には問題ないが、他の写経箇所(agenda-entry.ts の EventItem 等)と規律を揃えるため
 *  ここでも構造だけをローカルに定義する)。 */
export interface SafeAreaInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * 【暫定値・実機採寸前】claude.ai iOS の liquid glass ヘッダに削られる分の暫定フォールバック(px)。
 * safeAreaInsets が「ホストクローム分まで含めて申告する」ことは MCP Apps 仕様上の mandate ではなく、
 * claude.ai がクローム分込みで申告しているかは未実測(2026-07-23 時点)。このフォールバックは
 * safeAreaInsets が未申告(undefined/0)のホストでのみ発動する — 申告済みホストでは決して使われない
 * (二重余白を避ける。modeling/15 §B-4 ボツ案「読まずに一律 padding を決め打ちする案」の却下理由)。
 * 実測でき次第この定数だけを更新すればよい(判定を resolveSafeTopPx 1関数に隔離してある理由)。
 */
export const FULLSCREEN_SAFE_TOP_FALLBACK_PX = 56;

/**
 * fullscreen コンテナへ適用すべき padding-top(px)を決める。
 * 優先順位: (1) insets.top が申告されていて 0 より大きければそれを採用。
 *           (2) 申告が無い(undefined)か 0(=「安全領域なし」と「未申告」を区別できないホスト)
 *               のときに限り、displayMode==="fullscreen" ならフォールバック値を使う。
 *           (3) それ以外(inline 等)は 0。
 * 【Why not: insets.top===0 も「明示的にゼロ申告」として尊重する案】却下理由: 仕様上 top の単位は
 * pixel の非負整数だが、「クローム分を含めない実装」と「クロームが無いので 0」を安全に区別する
 * シグナルが無い(仕様に「0 は明示的申告」という mandate も無い)。fullscreen で 0 のまま運用すると
 * ヘッダ occlusion の実害(タップ不能領域)の方が「フォールバックが不要な稀なホストで数十px 余白が
 * 余る」実害より大きいと判断し、0 は未申告側へ寄せる(保守的に倒す)。
 */
export function resolveSafeTopPx(insets: SafeAreaInsets | undefined, displayMode: string | null): number {
	if (insets !== undefined && insets.top > 0) return insets.top;
	if (displayMode === "fullscreen") return FULLSCREEN_SAFE_TOP_FALLBACK_PX;
	return 0;
}

/**
 * fullscreen コンテナへ適用すべき padding-bottom(px)。bottom はホームインジケータ等のクロームで、
 * top ほど深刻な occlusion(ヘッダに操作対象が隠れる)を起こしにくいため、フォールバックは設けず
 * 申告があるときだけ反映する(未申告時は 0 = 従来どおり無余白)。
 */
export function resolveSafeBottomPx(insets: SafeAreaInsets | undefined): number {
	return insets !== undefined && insets.bottom > 0 ? insets.bottom : 0;
}
