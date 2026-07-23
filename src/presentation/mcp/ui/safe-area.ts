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
 * 【暫定値・実機採寸前】claude.ai iOS の下部 composer クローム(メッセージ入力欄)に削られる分の
 * 暫定フォールバック(px)。top(liquid glass ヘッダ)と同じ思想の bottom 版。
 *
 * 【なぜ bottom にもフォールバックが要るのか(2026-07-23 実機バグ・docs/log.md 該当エントリ)】
 * 当初の resolveSafeBottomPx は「bottom はホームインジケータ程度で top ほど深刻な occlusion を
 * 起こさない」という仮定でフォールバックを持たなかった。だが claude.ai iOS の fullscreen では
 * 画面下部に composer クロームが常駐し、その分を safeAreaInsets.bottom に申告しない実測反証が出た
 * — fullscreen 右下の ⊕ FAB / action-row / フッタが composer の裏に隠れてタップできない
 * (実機スクショあり)。top の occlusion(ヘッダに操作対象が隠れる)と全く同じ実害なので、top と
 * 対称に「モバイル fullscreen 限定・未申告時のみ」のフォールバックを設ける。
 *
 * 【値の根拠と更新手順】60px は composer クローム高さの未実測時点の保守的な仮値
 * (top の 56px と並ぶ経験オーダー。iOS の composer は入力欄+左右アイコンでおおよそこの高さ)。
 * 「safeAreaInsets 実測ログ」(既存の検証項目)で claude.ai iOS の実 bottom composer 高さが取れ次第、
 * この定数だけを更新すればよい(判定を resolveSafeBottomPx 1関数に隔離してある理由)。
 * 過大でも「FAB がやや浮く」程度の実害だが、不足すると FAB が composer に食われてタップ不能になる
 * ため、実測が来るまでは安全側(やや大きめ)へ倒す。
 */
export const FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX = 60;

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
 * fullscreen コンテナへ適用すべき padding-bottom(px)。
 * 優先順位は resolveSafeTopPx と対称:
 *   (1) insets.bottom が申告されていて 0 より大きければそれを採用(申告済みホストではフォールバック
 *       を絶対に使わない — 二重余白を避ける)。
 *   (2) 未申告(undefined)か 0 のときに限り、displayMode==="fullscreen" ならフォールバック値を使う。
 *   (3) それ以外(inline 等)は 0(= 従来どおり無余白)。
 * 【2026-07-23 変更: displayMode 引数を additive 追加】旧実装はフォールバックを持たず引数も insets のみ
 * だったが、claude.ai iOS の composer occlusion 実測反証(FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX コメント
 * 参照)を受け top と対称化した。displayMode 省略時(既存呼び出し・テスト)は undefined → 非 fullscreen
 * 扱いで従来どおり 0 を返すので後方互換。
 * 【Why not: bottom===0 を明示ゼロ申告として尊重する案】resolveSafeTopPx と同じ理由で却下
 * (「composer 分を含めない実装のたまたま 0」と「クローム無しの 0」を区別するシグナルが無い。
 * occlusion の実害 > フォールバック不要な稀ホストで数十px 余る実害、として 0 は未申告側へ寄せる)。
 */
export function resolveSafeBottomPx(insets: SafeAreaInsets | undefined, displayMode?: string | null): number {
	if (insets !== undefined && insets.bottom > 0) return insets.bottom;
	if (displayMode === "fullscreen") return FULLSCREEN_SAFE_BOTTOM_FALLBACK_PX;
	return 0;
}
