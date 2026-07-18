// =============================================================================
// presentation/mcp/ui/fold.ts — inline displayMode の「畳み」判定(純関数・畳み共有カーネル)
//                                 (P4-DM C1+C2・swift-mcp-app 側設計 04 §5)
// =============================================================================
// 【共有カーネル化(2026-07-17・todos-fold.ts → fold.ts へリネーム)】当初は todos カード専用
// だったが、agenda カード(予定一覧)の fullscreen 対応(P4-DM 移植)でも同じ判定ロジックを使う
// ため、カード非依存の「畳み共有カーネル」として切り出した。純関数は DOM に触れず「行の累積下端の
// 配列」しか受け取らないので、そもそもカードの内部構造に依存しておらず、リネームは名前の是正
// (todos 専用に見える名前をやめる)だけで中身は無改造。
//
// 【computeInlineFit の rowBottoms が指す「行」はカードごとに異なる(呼び出し側の責務)】
// この関数にとって rowBottoms は「畳み対象として先頭から間引ける単位の累積下端」でしかなく、
// その単位が何かは呼び出し側が決める:
//   - todos カード: タスク行(section > ul > li)。セクション見出し(h2)は各行の offsetTop に
//     押し下げとして織り込まれる。
//   - agenda カード: occurrence 行(.section の日見出し + 直後 ul > li)。**日見出しの高さは
//     各 occurrence 行の offsetTop に自然に加算されて入ってくる**ため、見出しを別枠で数える必要は
//     無く、todos と同型で流用できる(設計04 の「見出し高は rowBottoms の累積 offset に織り込まれる」)。
// どちらの場合も「空になったセクション見出しの除去」は畳み適用後に呼び出し側(*-entry.ts)が行う。
//
// 【このモジュールの位置づけ】ホストが宣言する containerDimensions.maxHeight(spec:
// apps.mdx:671-733 / spec.types.ts:243-249 の McpUiHostContext.containerDimensions)を
// 使って「行リストをどこまで見せれば maxHeight に収まるか」を DOM に一切触れず判定する
// 純関数だけを切り出す。feedback.ts / row-key.ts と同じ規律(「新規に書く純関数・定数だけ
// 共有する」)。DOM 操作(li の間引き・「すべて表示」ノード挿入)は todos-entry.ts 側
// (renderAll 最終段の applyInlineFold)が担う。**+ FAB は folded でも隠さない**(下記
// 2026-07-17 追更新)ため、本モジュールが担うのは「行 + すべて表示 + FAB の3者が maxHeight に
// 収まるように、行の表示件数を逆算する」ことだけになる。
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
//
// 【2026-07-17 追更新②(C0-b・役割変更): 「畳み」から「inline プレビューの安全クランプ」へ】
// 設計05 §4「inline = 境界の効いたプレビュー / fullscreen = 全件」への裁定に伴い、このモジュールの
// 位置づけが変わった(computeInlineFit 本体のコードは無改造・意味だけ変わる)。旧モデルでは inline は
// 「maxHeight に収まる限り全件出し、溢れたら畳む(動的畳み)」だったが、新モデルでは inline は常に
// 「上位 N_MAX 件(INLINE_PREVIEW_MAX)のプレビュー」に束ね、全件閲覧は右上 ⤢(requestDisplayMode
// fullscreen)へ一本化する(「すべて表示」ボタンと動的畳みは廃止=モック docs/design/mocks/
// inline-preview.html・設計05 §4)。
//   → 呼び出し側(*-entry.ts の applyInlineFold)は visibleCount = min(INLINE_PREVIEW_MAX,
//     computeInlineFit のフィット件数) にクランプする。computeInlineFit は「捨てる」のではなく、
//     「N_MAX 件でも端末次第(小さい maxHeight)で溢れるケースの安全クランプ」として再利用する
//     (端末依存の破綻を防ぐ最後の砦。純関数のロジックはそのまま活きる)。
// この追更新は下記の旧経緯(動的畳み・FAB 撤回)を「消さずに積む」— 動的畳みの発見と根治の履歴は
// 財産として残し、新モデルはその上に乗る(旧「畳み」も maxHeight が極端に小さいホストでは依然として
// visibleCount を N_MAX より小さく削るクランプとして機能するため、両者は排他ではなく min で合成される)。
//
// 【2026-07-17 追更新: 「folded では FAB を隠す」判断をユーザー実機 FB で撤回】
// 当初案は畳んだとき + FAB を hidden にし、追加操作を fullscreen 側の FAB に集約していた
// (「FAB はクリップ源だから隠す」という fable の設計判断)。しかしユーザーから
// 「+ 追加ボタンは主要アクションなので、畳んだ inline カードでも常に見えているべき」との
// 実機フィードバックがあり撤回した。撤回に伴い、budget の先引き量(bottomChrome)は
// 「すべて表示ボタン単体」から「すべて表示ボタン + FAB の合計」へ拡張する — FAB を隠さない
// 以上、畳んだ行・ボタン・FAB の3つ全部が maxHeight に収まっていなければ、根治したはずの
// 「FAB がクリップされて隠れる」再発バグが今度は folded 側で再発してしまうため
// (computeInlineFit の bottomChrome 引数コメント・todos-entry.ts の measureFabBlockPx 参照)。
//
// 【2026-07-18 ユーザー裁定: 浮遊 FAB(絶対配置)そのものを inline から撤去】
// 上の 2026-07-17 追更新は「FAB を隠さない」ことは正しく守ったが、「フッタ + FAB の2つが別々の
// flow 要素として bottomChrome に同居する」という会計の複雑さ自体は残っており、直近の再発
// (原因はホスト側レースだったが、構造の脆さがバグを呼び込みやすくしていた)を受けてユーザーが
// 構造そのものを見直す判断をした。inline では絶対配置の浮遊 FAB を完全に廃止し、+ を「他 n件」
// フッタと同じ1行(action-row)の右端へ統合する(*-entry.ts の buildActionRow・fullscreen だけ
// 浮遊 FAB を維持)。この結果、bottomChrome/fullHeight の先引き対象は「action-row 1つ分の高さ」
// だけになり、旧「フッタ + FAB の合計」という非対称な会計は解消された(*-entry.ts の
// measureActionRowBlockPx コメント参照)。computeInlineFit 自体のシグネチャ・ロジックは無改造
// (呼び出し側が渡す bottomChrome の“中身”が1要素分に単純化されただけ)。
// =============================================================================

/** computeInlineFit の戻り値。件数を決め打ちで返すのではなく、「畳まず全部見せてよいか
 *  (full)」「先頭何件までなら maxHeight に収まるか(folded)」の二択にする — 呼び出し側
 *  (applyInlineFold)はこの結果をそのまま DOM の間引きに使えばよく、追加の場合分けを
 *  持たない。 */
export type InlineFit = { mode: "full" } | { mode: "folded"; visibleCount: number };

/** inline プレビューで見せる未完了/直近 occurrence の上限件数(C0-b・設計05 §4「上位 N 件プレビュー」・
 *  モック docs/design/mocks/inline-preview.html は N=5)。呼び出し側は
 *  `visibleCount = min(INLINE_PREVIEW_MAX, computeInlineFit のフィット件数)` でクランプする。
 *  【なぜ純関数 computeInlineFit の中ではなく定数として外に置くか】computeInlineFit は「端末の
 *  maxHeight にどこまで収まるか」という物理制約だけを扱う純関数のまま保ち(テストで固定した境界値の
 *  意味を変えない)、「プレビューは高々 N 件」というプロダクト方針(端末非依存)は呼び出し側で min を
 *  取る形に分離する。両者の関心を混ぜないことで、N を変えても物理フィットのテストが壊れない。 */
export const INLINE_PREVIEW_MAX = 5;

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
 * @param bottomChrome 畳んだ行より**下に必ず並ぶ要素群**の合計高さ(px)。**budget から
 *   先引きするのが本関数の核心** — 畳み決定より後にこれらを append すると、その高さぶん
 *   maxHeight を超過してしまう(旧実装の欠陥)。
 *   【2026-07-17 追更新: 「すべて表示」ボタン単体 → ボタン+FAB の合計へ改名・意味変更】
 *   当初は「すべて表示」ボタンの高さだけを指す `buttonBlock` という名前だったが、ユーザー実機
 *   FB「+ 追加ボタンは主要アクションなので畳んだ inline でも常に見えているべき」を受けて
 *   folded でも + FAB を隠さない設計に変えたため、budget の先引きにも FAB の高さを含める
 *   必要が生じた。呼び出し側(todos-entry.ts)が「『すべて表示』ボタン高 + FAB(.fab-row)高」の
 *   合計をここに渡す — 関数のシグネチャ・判定ロジック自体は無変更(引数の“中身”が1要素分から
 *   2要素の合計に変わっただけ)。
 * @returns 収まる(fullHeight <= maxHeight)なら `{mode:"full"}`。溢れるなら
 *   `{mode:"folded", visibleCount}`(budget=maxHeight-bottomChrome に収まる最大行数。
 *   1行も収まらない極端なケースでも最低1行は見せる)。
 */
export function computeInlineFit(
	rowBottoms: readonly number[],
	fullHeight: number,
	maxHeight: number,
	bottomChrome: number,
): InlineFit {
	// maxHeight 情報が無い(Infinity)ホストは常に不活性(旧・不活性ホスト分岐を維持)。
	if (!(maxHeight < Infinity)) return { mode: "full" };
	// FAB 込みの全高が既に maxHeight に収まっているなら畳む理由が無い(旧実装と同じ判定基準だが、
	// 今回は「行の合計」ではなく root.scrollHeight+FAB = 実際にレンダリングされる全高の実測値で
	// 判定するので「行だけなら収まるが FAB で溢れる」再発バグのケースを正しく folded 側に倒せる)。
	if (fullHeight <= maxHeight) return { mode: "full" };
	// bottomChrome(「すべて表示」ボタン + FAB の合計)ぶんを先に引いた予算の中に収まる最大行数を、
	// 累積下端から直接求める。これにより「畳み決定 → 後からボタン/FAB を足す」順序逆転バグ
	// (それらの高さが収まり計算の外にあった)が構造的に発生しなくなる。
	const budget = maxHeight - bottomChrome;
	const visibleCount = rowBottoms.filter((bottom) => bottom <= budget).length;
	// budget がどれだけ小さくても(極端な maxHeight・大きい bottomChrome)最低1行は見せる —
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
