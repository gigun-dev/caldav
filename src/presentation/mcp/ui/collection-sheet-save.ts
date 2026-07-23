// =============================================================================
// presentation/mcp/ui/collection-sheet-save.ts
//   — コレクション詳細ページ(K2-UI②)の「保存」が update-calendar を叩くべきかの純粋判定
// =============================================================================
// 【何のためのファイルか】todos-entry.ts の saveCollectionSheet(既存編集の分岐)は、これまで
// displayName/color の変更有無を見ずに毎回 update-calendar を呼んでいた。update-calendar 自体は
// server.ts 側で「displayName/color 両方省略」だけを no-op として弾く設計(update-calendar の
// no-op ガードコメント参照)なので、値を毎回送っても「サーバーのエラーを踏む」ことは無かった
// (この点は当初の懸念だったが実装を確認すると該当しない)。
// それでも変更が無いのに毎回 PROPPATCH 相当のツール呼び出しを発行するのは無駄な副作用
// (updateCollectionProperties の execute が実際に D1 へ書き込みに行く)なので、
// 「差分が無ければ呼ばない」判定をここに純関数として切り出し固定する
// (render-gate.ts と同じ「*-entry.ts の巨大ファイルから薄い純粋ロジックだけを外に出す」流儀)。
// =============================================================================

/** update-calendar に渡す引数(id は呼び出し側が既に持っている calendarId なのでここでは含めない)。 */
export interface CollectionSheetUpdateArgs {
	displayName: string;
	color: string;
}

/**
 * 既存リストの現在値(displayName/color)と編集ドラフトを比較し、update-calendar を呼ぶべき
 * 引数を返す。差分が無ければ null(呼び出し側は no-op としてページを閉じるだけでよい)。
 * 【なぜ trim 後の name で比較するか】呼び出し元(saveCollectionSheet)は保存前に空チェックとして
 * 既に trim 済みの name を使っている(表示名の前後空白は意味を持たない一貫方針)ため、ここでも
 * trim 済み文字列を受け取る前提にする(この関数自身は trim しない — 呼び出し側の責務に揃える)。
 */
export function buildCollectionSheetUpdateArgs(
	current: { displayName: string; color: string },
	draft: { displayName: string; color: string },
): CollectionSheetUpdateArgs | null {
	const nameChanged = draft.displayName !== current.displayName;
	// 色は8色パレットの hex 文字列同士の比較。大文字小文字が揺れても同じ色を指す可能性があるため
	// calendarColor() 側と同様 lowercase で正規化して比較する(色チップ選択 UI の selected 判定
	// (buildCollectionSheetPage の toLowerCase 比較)と同じ揺れ対策)。
	const colorChanged = draft.color.toLowerCase() !== current.color.toLowerCase();
	if (!nameChanged && !colorChanged) return null;
	return { displayName: draft.displayName, color: draft.color };
}
