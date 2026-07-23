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
 * 破壊的 renderAll() を抑止すべきか。抑止条件は次の OR(どちらか成立で抑止):
 *   (1) シート(詳細 / リスト選択ページ)表示中 = sheetState !== null。
 *   (2) カードの root 配下に focus 中の input/textarea がある = hasFocusedInput === true。
 *
 * 【(2) を 2026-07-23 に additive 追加した理由(iOS 実機バグ再発)】
 * ce7d5aa の初版は (1) だけを見ていた。だが ⊕→fullscreen 昇格「直後」のドラフト作成ビューは
 * シートではなく本体リスト上の行(sheetState===null)であり、この状態で input に同期 focus した
 * 直後、昇格に伴う hostcontextchanged 起点の renderAll が focus 中の input を DOM ごと消す経路が
 * 残っていた(キーボードが一瞬立ち上がって即閉じる)。焦点の有無を直接見れば、シートかどうかに
 * 依らず「focus 中の要素を破壊する renderAll」を全経路で塞げる。
 *
 * 【Why not: 遅延 focus(昇格アニメ後に focus を投げ直す)ワークアラウンドの復活】modeling/15 §B の
 * ボツ案。iOS はプログラム的な再 focus をユーザー操作直後でないとソフトキーボードで開き直さないため
 * 体感が直らない(render-gate.ts 冒頭 Why not 案C と同根)。抑止側で塞ぐのが筋。
 *
 * 【注意: 「focus がある間ずっと renderAll を握り潰す」副作用】focus 中は push 反映が止まるので、
 * 抑止で取りこぼした再描画は blur/submit 時に1回 flush する必要がある(setSheetState(null) が
 * シート閉時に flush するのと対称。配線は *-entry.ts の pendingRenderAfterSheet / flush 経路)。
 *
 * sheetState は todos-entry.ts / agenda-entry.ts で型が違う({id,...} / {key,...})ので unknown で
 * 受け、null かどうかだけを判定する。hasFocusedInput は DOM 依存(document.activeElement 判定)なので
 * この純関数の外(呼び出し側)で算出して boolean で渡す — ここは DOM 非依存を保つ(bun:test 可能)。
 */
export function shouldSkipDestructiveRender(sheetState: unknown, hasFocusedInput: boolean = false): boolean {
	return sheetState !== null || hasFocusedInput;
}
