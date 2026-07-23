// =============================================================================
// presentation/mcp/ui/trash-view.ts — ② ゴミ箱ページの行構築(純関数コア・2026-07-24)
// =============================================================================
// 【責務】list-deleted 応答の deletedItems(DeletedItemView 相当)を、カードのゴミ箱ページが1行ずつ
// 描くのに必要な表示文字列へ変換する(タイトルの無題フォールバック・削除時刻の相対表記)。リスト名の
// 解決(calendarId → displayName)は calendarsCache(module state)に依存するので、この純関数は
// calendarId をそのまま返し DOM 側で名前を当てる — DOM・ネットワーク・module state に触れないロジック
// だけを toggle-coalesce.ts / completed-summary-view.ts と同じ規律で切り出し bun test で固定する。
// =============================================================================

/** buildTrashRows が要求する deletedItems の最小構造(todos-view-model.ts の DeletedItemView と同型)。 */
export interface DeletedItemInput {
	uri: string;
	calendarId: string;
	title: string;
	deletedAtMillis: number;
}

/** ゴミ箱ページの1行(表示用)。DOM 側は uri/calendarId を restore-deleted の引数に、title/deletedRelative を描画に使う。 */
export interface TrashRow {
	uri: string;
	calendarId: string;
	/** 表示タイトル(空文字の元 title は "(無題)" に degrade)。 */
	title: string;
	/** 削除時刻の相対表記("たった今" / "N分前" / "N時間前" / "N日前" / "YYYY-MM-DD")。 */
	deletedRelative: string;
}

// 相対表記のしきい値(ms)。iOS の「〜前」表記の粒度に寄せた素朴な段階分け。厳密な根拠より
// 「削除直後の undo 文脈で"たった今/N分前"が読めれば十分・古いものは日付で足りる」ことが目的。
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 削除時刻(epoch ms)を now 基準の相対表記へ整形する。
 * - 1分未満        : "たった今"
 * - 1時間未満      : "N分前"
 * - 1日未満        : "N時間前"
 * - 7日未満        : "N日前"
 * - それ以上/未来  : "YYYY-MM-DD"(相対では情報量が薄い/負値は嘘になるので絶対日付へ)
 *
 * 【なぜ 7日で日付へ切り替えるか】ゴミ箱は「最近消したものを戻す」文脈が主で、1週間以上前のものは
 * "N日前" より日付の方が探しやすい(相対は now への依存が強く、履歴復元で now とズレると誤読を招く
 * — todos-diff.ts の formatDueDisplay が相対表現を避けたのと同じ理由)。
 * @param deletedAtMillis 削除時刻(epoch ms)。
 * @param nowMillis 現在時刻(epoch ms)。呼び出し側が Date.now() を渡す(純関数に保つため引数化)。
 */
export function formatDeletedRelative(deletedAtMillis: number, nowMillis: number): string {
	const diff = nowMillis - deletedAtMillis;
	// 未来(時計ずれ・不正データ)は相対にすると "-3分前" のような嘘になるので絶対日付へ倒す。
	if (diff < 0) return isoDate(deletedAtMillis);
	if (diff < MINUTE) return "たった今";
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
	if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}日前`;
	return isoDate(deletedAtMillis);
}

/** epoch ms を UTC 基準の "YYYY-MM-DD" にする(相対表記の最終フォールバック用)。表示ゾーンの厳密さは
 *  「1週間以上前」という粗い文脈では不要なので UTC 日付で足りる(誤差1日はこの用途で許容)。 */
function isoDate(millis: number): string {
	return new Date(millis).toISOString().slice(0, 10);
}

/**
 * deletedItems を表示用の TrashRow[] へ変換する。並び順は「削除時刻の新しい順」(最近消したものを
 * 上に=undo しやすい)。同時刻は uri でタイブレークして決定的にする(ListTodos の sortOrder 流儀)。
 * @param items list-deleted の deletedItems。
 * @param nowMillis 現在時刻(相対表記の基準)。
 */
export function buildTrashRows(items: readonly DeletedItemInput[], nowMillis: number): TrashRow[] {
	return items
		.slice()
		.sort((a, b) => {
			if (a.deletedAtMillis !== b.deletedAtMillis) return b.deletedAtMillis - a.deletedAtMillis;
			return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
		})
		.map((it) => ({
			uri: it.uri,
			calendarId: it.calendarId,
			// 無題(空 SUMMARY)は "(無題)" に degrade — 空行だと復元ボタンだけの正体不明な行になるため。
			title: it.title.trim() !== "" ? it.title : "(無題)",
			deletedRelative: formatDeletedRelative(it.deletedAtMillis, nowMillis),
		}));
}
