// =============================================================================
// presentation/mcp/ui/render-gate.ts — シート表示中の破壊的 renderAll() 抑止(純粋判定の共有)
// =============================================================================
// 【根本原因(2026-07-23 iOS 実機バグ: fullscreen で入力タップ直後にキーボードが閉じ vevent/vtodo を
// 追加できない)】todos-entry.ts / agenda-entry.ts の renderAll() は #root.innerHTML="" で DOM を
// 全消しして作り直す設計(冒頭コメントの一貫方針)。詳細シート(sheetState !== null)がフルスクリーン
// 表示中に input へフォーカスしたまま renderAll が走ると、focus 中の要素そのものが DOM から消える
// 瞬間が生まれ、iOS はそれでソフトキーボードを閉じる(blur→再 focus では間に合わない・実機挙動)。
// キーボードが出現するとホストが containerDimensions を再送し、hostcontextchanged / agenda の
// 60秒赤線タイマー / ontoolresult push / visibilitychange・focus・pageshow の maybeRefetch という
// 「本来 DOM 構造までは壊さなくてよい」イベントが renderAll() を誘発していたのが実害の連鎖
// (fullscreen 限定なのは fullscreen-scroll(--host-max-height 連動)が fullscreen でしか付かず、
// この経路の CSS 変数更新がそこでしか renderAll を伴わないため)。
//
// 【対策(案A: シート表示中は破壊的再描画を抑止・採用)】
// 「いま renderAll を抑止すべきか」を sheetState の有無だけで判定する純関数をここに1つ置き、
// 両カードの hostcontextchanged/タイマー/ontoolresult push/focus 系リスナーがこれを経由する
// guardedRenderAll() 越しに renderAll() を呼ぶ(guardedRenderAll 自体は各カードの sheetState/
// renderAll に依存するためこのファイルには置けない・*-entry.ts 側にごく短く実装する)。
// 抑止で取りこぼした再描画要求は「シートを閉じた瞬間に1回だけ flush する」(setSheetState 経由)。
//
// 【Why not 案B: renderAll を差分更新(VDOM 的)へ全面書き換え】このカード群は「renderAll = 全消し
// 全組み立て」を設計原則として一貫させてきた。差分更新化は全描画コードに影響が及び、このバグ1件の
// ために背負うコストが大きすぎる(このカードの規模で1から差分レンダラを書く判断はしない)。
// 【Why not 案C: blur→再 focus で復元】iOS は focus 要素が消えた瞬間に一度キーボードを閉じるため、
// 直後に再 focus してもキーボードは開き直らない(プログラム的な再 focus はユーザー操作直後でないと
// ソフトキーボードを開かない実機挙動がある)。体感が直らないため採用しない。
// =============================================================================

/**
 * シート(詳細ページ / リスト選択ページ)表示中は破壊的 renderAll() を抑止すべきか。
 * sheetState は todos-entry.ts / agenda-entry.ts で型が違う({id,...} / {key,...})ので unknown で
 * 受け、null かどうかだけを判定する(両カードとも「シート無し」は sheetState===null で表す規約)。
 */
export function shouldSkipDestructiveRender(sheetState: unknown): boolean {
	return sheetState !== null;
}
