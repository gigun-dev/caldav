// =============================================================================
// presentation/mcp/ui/toggle-coalesce.ts — 完了トグル coalesce / 楽観復活の判定(純関数コア)
//                                            (> 2026-07-17 実機 FB 第2ラウンドの監査修正)
// =============================================================================
// 【なぜ切り出すか】done→undo の競合で「完了状態で残る」実機バグが出た。原因は todos-entry.ts の
// 非同期フロー(flushToggle の追送判定 / rebuildDisplay の楽観復活判定)に埋め込まれた2つの小さな
// 決定ロジックで、DOM・ネットワーク・module state と絡んで単体テストしづらかった。決定そのものは
// 純関数に落とせるので、ここに抽出して競合ケースをテストで固定する(fold.ts / feedback.ts と同じ規律
// = 「新規に書く純関数・定数だけ ui/ で共有し、境界を mcp-ui-is-terminal の ui/→ui/ 許可に乗せる」)。
// DOM 操作・Map の読み書き・ネットワークは呼び出し側(todos-entry.ts)に残す。
//
// 【背景となる状態機械(2つの決定)】
//  (1) coalesce の追送判定(flushToggle): 送った状態 sent と、往復後の最新の望み latest を突き合わせ、
//      食い違えば「最新でもう1発送る(resend)」、一致すれば「確定(settle)」。連打しても常に最新1発に
//      集約される(last-write-wins)。
//  (2) 楽観復活の判定(rebuildDisplay): サーバー確定 vm から id が脱落している(= 完了確定で未完了ビュー
//      から抜けた)状況で、その id に in-flight の楽観トグル(desired)が乗っているとき、確定行が無いので
//      overlay できず楽観が「見えない」。sticky スナップショットを土台に楽観を復活させてよいか(reopen を
//      即座に見せるか)を判定する。復活は in-flight 楽観の間だけ許し、退場済み/楽観削除中は許さない。
// =============================================================================

/** coalesce の追送判定(flushToggle の1往復後に呼ぶ)。
 *  @param sentCompleted この往復でサーバーへ送った完了状態(true=COMPLETED / false=NEEDS-ACTION)。
 *  @param latestCompleted 往復の間にユーザーが更新した「今の望み」の完了状態(undefined=望みが消えた
 *    = ロールバック等で desiredToggle が空になった)。
 *  @returns "resend" = 望みが送った内容と食い違うのでもう1発送る(補正・最新意図を送る) /
 *           "settle" = 一致 or 望み消滅 → 確定して楽観状態を解除してよい。
 *  【なぜ latest===undefined を settle にするか】望みが消えたのは呼び出し側がロールバック等で片付けた
 *  ことを意味し、追送すべき対象が無い(=これ以上ループしない)。 */
export function coalesceAction(sentCompleted: boolean, latestCompleted: boolean | undefined): "resend" | "settle" {
	if (latestCompleted === undefined) return "settle";
	return latestCompleted !== sentCompleted ? "resend" : "settle";
}

/** 楽観復活の判定(rebuildDisplay で id ごとに呼ぶ)。確定 vm に居ない id へ楽観トグルが乗っているとき、
 *  sticky スナップショットから行を復活させて楽観状態(desired)を見せてよいかを返す。
 *  @param inConfirmed その id が confirmedTasks(サーバー確定一覧)に居るか。居るなら通常 overlay で足りる
 *    ので復活は不要(false を返す)。
 *  @param optimisticallyDeleted 楽観削除中(optimisticDeletes)か。削除中の行は復活させない。
 *  @param hasSticky sticky に last-known スナップショットがあるか。無ければ土台が無いので復活できない。
 *  @returns true = sticky を土台に楽観を復活させて表示に足す(reopen が即座に見える)。
 *  【なぜこの判定が要るか(実機バグ)】done がサーバー確定すると未完了ビューから id が脱落する。その後の
 *  undo(楽観 reopen)は「確定行が無い」ため overlay できず見えない → 行が完了表示のまま残る、という実機
 *  バグの主因。in-flight 楽観の間だけ sticky から復活させれば undo が即座に反映される(サーバー再開の
 *  往復を待たない)。復活は optimisticToggle が生きている間だけ(settle/rollback で消えれば止まる)なので
 *  幽霊化しない。
 *  【2026-07-23: retired 引数を撤去】旧シグネチャは「退場済み(retiredDoneIds)か」を4番目の引数に取り、
 *  退場した行は復活させない判定をしていた。C0-a(約3秒退場機構)そのものを撤去したため retiredDoneIds が
 *  無くなり、この引数も意味を失った(完了行はもう退場しないので、退場済み判定を通す必要が無くなった)。 */
export function shouldReviveToggle(inConfirmed: boolean, optimisticallyDeleted: boolean, hasSticky: boolean): boolean {
	if (inConfirmed) return false; // 確定行があるので通常 overlay で足りる
	if (optimisticallyDeleted) return false; // 削除中は復活させない
	return hasSticky; // 土台(sticky)があるときだけ復活できる
}

/** 完了 becoming(done-in-place)の描画土台を作る merge 規則(renderAll の synthDone 構築で使う)。
 *  【なぜ要るか(実機バグ「done 状態で notes の表示が消える」)】完了確定で未完了ビュー(confirmedTasks)から
 *  脱落した行は、サーバー応答の affected[].task スナップショット(TaskSnapshot = 最小フィールド。**notes を
 *  持たない**)から擬似行 snapshotItem に合成される。この擬似行は notes:null。sectionizeManual では
 *  この擬似行が liveById に載り、`liveById ?? stickyData` の優先順で **notes まで揃った sticky より優先** されて
 *  しまうため、完了行の notes が描画から消える(再現条件: done→サーバー確定で脱落→becoming-done 表示のフレーム)。
 *  【修正原則(コーディネーター指示)】行の描画土台は常に「最後に notes まで揃っていた full な形(sticky)」を
 *  保ち、部分 snapshot で土台を上書きしない。sticky があればそれを土台にして、snapshot が権威を持つフィールド
 *  (title/due/isAllDay と完了状態)だけを重ねる — notes/priority/location/recurrence/structuredLocation/
 *  proximityAlarm は snapshot に無いので sticky の値を保つ。sticky が無い(初回が mutate 応答だった等)ときは
 *  やむなく snapshotItem をそのまま使う(見せられる full データが存在しないため。best-effort)。
 *  @param sticky その id の last-known full 行(sectionizeManual が realLive から更新した値)。無ければ undefined。
 *  @param snapshotItem サーバー snapshot から作った最小擬似行(snapshotToItem の出力。notes:null 等)。
 *  【純関数・構造的部分型】TodoItem を直接 import せず必要フィールドだけを構造制約にして「ui は末端」の設計を保つ
 *  (todos-entry.ts が TodoItem を渡すと構造的に適合する)。 */
export function mergeCompletedBase<
	T extends {
		completed: boolean;
		status: string | null;
		title: string;
		due: string | null;
		isAllDay: boolean;
		notes: string | null;
	},
>(sticky: T | undefined, snapshotItem: T): T {
	if (sticky === undefined) return snapshotItem;
	return {
		...sticky,
		completed: true,
		status: "COMPLETED",
		title: snapshotItem.title,
		due: snapshotItem.due,
		isAllDay: snapshotItem.isAllDay,
	};
}
