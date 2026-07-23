// =============================================================================
// presentation/mcp/ui/todos-calendar-filter.ts — K3(2026-07-23): todos カードのリスト切替を
//   「初回に全 VTODO コレクション横断取得 → 切替はクライアント側フィルタ」にするための純関数コア
// =============================================================================
// 【なぜ切り出すか】todos-entry.ts はブラウザ専用エントリで bun test から直接 import できない
// (DOM 前提・ファイル冒頭コメント参照)。toggle-coalesce.ts / done-exit.ts と同じ規律で、
// 「状態合成のルール」だけを DOM・ネットワーク・module state から切り離した純関数として
// ここに置き、todos-entry.ts はこれを import して module state(tasks/confirmedTasks/
// currentCalendarId)へ適用するだけにする。
//
// 【この2関数が担う設計(概要。詳細は各関数の JSDoc)】
//   - mergeTasksByCalendar: サーバー応答(横断 or 単一コレクション)を「保持中の横断キャッシュ」へ
//     合成する。1回の mutate(単一コレクション応答)で他リストのキャッシュを消さないための要。
//   - filterTasksByCalendar: 横断キャッシュから「今表示中のリスト」だけを取り出す。renderAll の
//     セクション計算はこの絞り込み後の配列だけを見る。
// =============================================================================

/** mergeTasksByCalendar/filterTasksByCalendar が要求する最小構造。TodoItem を直接 import せず
 *  構造的部分型で受ける(todos-entry.ts の TodoItem はこれに自然に適合する — toggle-coalesce.ts の
 *  mergeCompletedBase と同じ「ui は末端」の設計)。 */
export interface CalendarTaggedItem {
	id: string;
	calendarId?: string;
}

/**
 * K3: 応答 tasks を「保持中の横断キャッシュ」へ合成する。
 *
 * 【設計】
 *   - incomingCalendarId === null(owner 横断応答: calendarId 省略の list-todos/refresh-todos、
 *     または calendarId フィールド自体が無い旧応答/フィクスチャ)→ nextTasks は owner 配下の
 *     全 VTODO を含む完全な最新値として扱い、丸ごと置き換える。
 *   - incomingCalendarId が非 null(単一コレクション応答: 明示 calendarId 指定の list-todos、
 *     または mutate 系の確定一覧)→ そのコレクション由来の行だけを新データへ差し替え、
 *     他コレクションの行(prev のうち calendarId が一致しないもの)は保持する
 *     (merge-by-calendarId)。1回の mutate(例: create-todo を calendarId:"tasks" で実行)で
 *     他リスト(例 "reading-list")のキャッシュを消してしまうと、直後に switchCalendar で
 *     そちらへ切り替えたときネットワーク往復ゼロの前提が崩れて空表示になる — それを防ぐ。
 *   - prev の行で calendarId が undefined(旧応答/テストフィクスチャ由来)は「所属不明」として
 *     誤って消さない安全側で常に保持する。
 *
 * 【なぜ diff(computeSyncDiff)より前にこの合成を行う必要があるか(呼び出し側の責務)】
 * サーバー確定一覧の「見た目の差分」(sync 由来の追加/削除)は、この関数が返す **合成後** の値を
 * 次の confirmedTasks として比較しないと、単一コレクション応答(他コレクションの行を含まない)を
 * そのまま次値にした場合に「他コレクションの行が全部消えた」という偽の削除を検出してしまう
 * (呼び出し側 todos-entry.ts の applyStructuredContent 参照)。
 */
export function mergeTasksByCalendar<T extends CalendarTaggedItem>(
	prev: readonly T[] | null,
	incomingCalendarId: string | null,
	nextTasks: readonly T[],
): T[] {
	if (incomingCalendarId === null) return nextTasks.slice();
	// calendarId !== incomingCalendarId で十分(undefined も自然に「不一致」= 保持される)。
	// 明示的に `t.calendarId !== undefined &&` を足さない: 足すと不明行まで「一致扱い」で除去されてしまい、
	// 「所属不明行は誤って消さない」という契約(このファイル冒頭の JSDoc)に反する(実装時に一度踏んだ誤り)。
	const kept = (prev ?? []).filter((t) => t.calendarId !== incomingCalendarId);
	return kept.concat(nextTasks);
}

/**
 * K3: renderAll のセクション計算に渡す直前で「今表示中のリスト」だけへ絞り込む。
 * calendarId が null(未選択。横断応答をまだ1件も受けていない・VTODO コレクションが無い等)の
 * ときは絞り込まず全件を返す(空表示より「とりあえず何か見せる」degrade を優先)。
 * calendarId が undefined の行(旧応答/フィクスチャ由来)は除外しない(取りこぼしより過剰表示の
 * 方が実害が小さい判断)。
 */
export function filterTasksByCalendar<T extends CalendarTaggedItem>(
	items: readonly T[],
	calendarId: string | null,
): T[] {
	if (calendarId === null) return items.slice();
	return items.filter((t) => t.calendarId === undefined || t.calendarId === calendarId);
}

// =============================================================================
// K3 是正(2026-07-23 ユーザー裁定): 「すべて」はコレクションごとのグループ表示
// =============================================================================
// 【背景(ユーザー報告)】K3(mergeTasksByCalendar/filterTasksByCalendar 導入)の既定選択が
// 「全コレクション合流」になっていた結果、reading-list の本(!!! 付き)が tasks の一覧に
// 貫通して混ざって表示された。ユーザー裁定:「コレクションは分離して基本表示。横断表示は
// ニーズがあれば良いが、その場合はコレクションごとに(グルーピングして)表示」。
//
// 【なぜ「すべて」専用のセンチネル ID が要るか】currentCalendarId(todos-entry.ts)は
// null を「まだ何も選ばれていない(初回応答前 or VTODO コレクションが無い)」の意味で
// 既に使っている(applyStructuredContent の既定自動選択トリガー)。「すべて」をユーザーが
// 明示的に選んだ状態を null と同じ値で表すと、①既定自動選択ロジックが「すべて」を
// 「未選択」と誤認して勝手に単一コレクションへ引き戻してしまう、②切替メニューの現在地
// チェックが「すべて」行にも「まだ何も選んでいない」ときにも同時に付いてしまう、という
// 2つの事故が起きる。null とは別の非 null な文字列センチネル(ALL_CALENDARS_ID)を
// 割り当てることで、「ユーザーが明示的に選んだ横断表示」と「未選択」を型上も値上も
// 区別できるようにする(todos-entry.ts 側は「calendarId が実在のコレクション ID か」を
// この定数との等値比較で判定する)。
export const ALL_CALENDARS_ID = "__all__";

/** groupTasksByCalendar の1グループ。 */
export interface CalendarGroup<T> {
	calendarId: string;
	tasks: T[];
}

/**
 * 「すべて」表示のためのグルーピング(コレクションごとに分ける・純関数)。
 *
 * 【設計】
 *   - items は呼び出し側が既に「見せたい順」(todos-entry.ts では sectionizeManual の
 *     due 優先順=overdue→today→upcoming→noDue を1本に連結した配列)に並べてある前提。
 *     この関数はその順序を保ったまま calendarId でバケツ分けするだけ(ソートはしない)。
 *     結果として各グループ内の順序は「既存の並び規則」(呼び出し側が渡した順)がそのまま
 *     引き継がれる — 仕様「グループ内は既存の並び規則」を、この関数を「並べ替えない」
 *     形にすることで満たす(グループ分け自体が並び順を変えてはいけない、という制約を
 *     関数のシグネチャで表明する)。
 *   - calendarId が undefined の行(旧応答/フィクスチャ由来の所属不明行)は空文字 "" を
 *     キーとする専用グループにまとめる(filterTasksByCalendar と同じ「取りこぼしより
 *     過剰表示」の安全側判断 — 消さずに見せる)。
 *   - calendarOrder(calendarsCache から VTODO コレクションだけを抜いた表示順。省略可)を
 *     渡すとその順でグループを並べる(切替メニューの表示順と一致させ、ユーザーが
 *     「さっきメニューで見た並び」を素直に期待できるようにする)。calendarOrder に無い
 *     calendarId(未取得中・未知)は、items 側での初出順のまま末尾へ追加する(取りこぼし
 *     防止=常にすべての行がどこかのグループに入る)。
 *
 * @param items グループ化対象(呼び出し側が既に望む順で並べたもの)。
 * @param calendarOrder グループの表示順を決める calendarId の並び(省略時は items の初出順)。
 */
export function groupTasksByCalendar<T extends CalendarTaggedItem>(
	items: readonly T[],
	calendarOrder?: readonly string[],
): CalendarGroup<T>[] {
	const buckets = new Map<string, T[]>();
	for (const t of items) {
		const key = t.calendarId ?? "";
		const arr = buckets.get(key);
		if (arr === undefined) buckets.set(key, [t]);
		else arr.push(t);
	}
	// 表示順: calendarOrder に載っている id → その順。載っていない id(未知・所属不明の ""
	// を含む)は items 側での初出順のまま末尾に積む(取りこぼし防止)。
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const id of calendarOrder ?? []) {
		if (buckets.has(id) && !seen.has(id)) {
			ordered.push(id);
			seen.add(id);
		}
	}
	for (const key of buckets.keys()) {
		if (!seen.has(key)) {
			ordered.push(key);
			seen.add(key);
		}
	}
	return ordered.map((calendarId) => ({ calendarId, tasks: buckets.get(calendarId) ?? [] }));
}
