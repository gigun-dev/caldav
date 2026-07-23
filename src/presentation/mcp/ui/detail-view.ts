// =============================================================================
// presentation/mcp/ui/detail-view.ts — 予定「詳細(閲覧)ページ」の表示項目を組む純関数群
//                                       (#44 実機FB「イベントタップ=詳細ファースト」の描画判断)
// =============================================================================
// 【このモジュールの位置づけ(location-view.ts / fold.ts / format.ts と同じ規律)】
//   一覧行タップで開く「読み取り専用の詳細ページ」に、どの行を・どの文言で出すかを決める純関数だけを
//   切り出す。DOM には一切触れない(見出し/リンク/コピー導線の組み立ては agenda-entry.ts が担う)ので
//   bun:test で DOM 無しに境界を固定できる(mcp-detail-view.test.ts)。
//   これまで「開く/コピー」導線や日時整形は agenda-entry.ts の巨大な描画関数の中に埋もれていて
//   テストが当てられなかった — 表示項目の構成(What)をここへ抜き、entry 側は How(DOM 組み立て)だけに
//   痩せさせる。
//
// 【なぜ ui/ に置くか】これは「読み取った意味値 → 詳細ページ表示の判断」であって生 ICS の解釈ではない。
//   ui/ は 'mcp-ui-is-terminal' 境界で src/ 内 import を禁じられているため、C1 の型(ConferenceView 等)は
//   location-view.ts の写経を再利用する(同じ ui/ 内なので import 可)。日付整形は format.ts を再利用。
// =============================================================================

import { wallDatePart, wallTimePart, weekdayOf } from "./format";
import { showReferenceUrl, type ConferenceView } from "./location-view";

// -----------------------------------------------------------------------------
// URL 行(会議 URL / 汎用 参照 URL)の構成
// -----------------------------------------------------------------------------

/** 詳細ページに出す URL 行1つ分。
 *  - kind "conference": 会議 URL(🎥。ラベルは「会議に参加」)。conference が非 null のとき出す。
 *  - kind "reference" : 汎用の参照 URL(🔗。ラベルは「リンクを開く」)。showReferenceUrl が true のとき出す。
 *  url は開く/コピーの対象そのもの。detail はページ全域を使えるので inline のような主要1つ束ねはせず、
 *  会議・参照が両方あれば両方出す(一覧 meta の appendJoinChip/ref-chip と同じ二重回避規約を踏襲)。 */
export interface DetailUrlRow {
	kind: "conference" | "reference";
	url: string;
}

/**
 * 詳細ページの URL 行を「上から出す順」で組む(#44 指示2)。
 *
 * 【会議 → 参照 の順】一覧 meta(appendJoinChip → ref-chip)と同じ順序に揃える。会議は「いま参加」の
 * アクション性が高いので先。参照 URL を独立で出すかは location-view.showReferenceUrl に委ねる
 * (conference.source==="url" の会議は URL が既に「参加」に化けているので二重に出さない — 純関数で判定済み)。
 *
 * 【空/空白 URL は落とす】conference.url が空文字のことは C1 の契約上ほぼ無いが、詳細ページで「開けない
 * 空リンク」を出さないよう trim して弾く(死にリンクを作らない。一覧 ref-chip と同じ安全側)。
 *
 * @param url        汎用 URL(EventItem.url。未設定は null)
 * @param conference C1 の conference(会議でない=参照 URL のままは null)
 */
export function detailUrlRows(url: string | null, conference: ConferenceView | null): DetailUrlRow[] {
	const rows: DetailUrlRow[] = [];
	if (conference !== null && conference.url.trim() !== "") {
		rows.push({ kind: "conference", url: conference.url });
	}
	// showReferenceUrl が conference.source==="url" の二重回避まで面倒を見る(location-view.ts)。
	if (showReferenceUrl(url, conference) && url !== null && url.trim() !== "") {
		rows.push({ kind: "reference", url });
	}
	return rows;
}

// -----------------------------------------------------------------------------
// 日時の閲覧用テキスト
// -----------------------------------------------------------------------------

/**
 * 詳細ページの「日時」1行分のテキストを組む(#44 指示1 の閲覧表示)。
 *
 * 【出し分け】
 *   - 終日 かつ 開始日==終了日(または終了なし): "7/16(木) 終日"
 *   - 終日 かつ 複数日               : "7/16(木) 〜 7/18(土) 終日"
 *   - 時刻付き 同日                 : "7/16(木) 19:00 〜 20:30"
 *   - 時刻付き 別日                 : "7/16(木) 19:00 〜 7/17(金) 08:00"
 *   - 終了なし(時刻付き)           : "7/16(木) 19:00"
 * 壁時計(HH:MM)はイベント自身のゾーンの値をそのまま出す(format.ts の wallTimePart 規約。一覧の
 * 時刻列と同じ)。曜日は開始/終了それぞれの日付から引く。
 *
 * 【なぜ純関数化したか】この「開始と終了をどう1行に畳むか」は分岐が多く、実機で崩れやすい割に DOM を
 * 介さず検証できる典型なので、entry 側の DOM 組み立てから切り離して bun:test で固定する。
 *
 * @param start   EventItem.start(終日 "YYYY-MM-DD" / 時刻付き offset ISO)
 * @param end     EventItem.end(同形式。無しは null)
 * @param isAllDay 終日フラグ
 */
export function formatDetailWhen(start: string, end: string | null, isAllDay: boolean): string {
	const startDateKey = wallDatePart(start);
	const md = (dateKey: string): string => {
		const [, m, d] = dateKey.split("-").map(Number);
		return `${m}/${d}(${weekdayOf(dateKey)})`;
	};
	const allDay = isAllDay || !start.includes("T");
	if (allDay) {
		// 終日: DTEND は排他的終端なので「終了日の前日」までが実体。ただし詳細では利用者に分かりやすい
		// 「開始日 [〜 終了日]」を出す方針にし、DTEND を1日戻す補正は入れない(一覧の跨ぎ〜M/D と揃える。
		// 排他終端の厳密表示より "いつからいつまで" の直感を優先 — ここは閲覧用の要約)。
		if (end === null) return `${md(startDateKey)} 終日`;
		const endDateKey = wallDatePart(end);
		if (endDateKey === startDateKey) return `${md(startDateKey)} 終日`;
		return `${md(startDateKey)} 〜 ${md(endDateKey)} 終日`;
	}
	const startText = `${md(startDateKey)} ${wallTimePart(start)}`;
	if (end === null || !end.includes("T")) return startText;
	const endDateKey = wallDatePart(end);
	const endTime = wallTimePart(end);
	// 同日なら終了は時刻だけ(日付の重複を出さない)。別日なら終了側にも日付を添える。
	if (endDateKey === startDateKey) return `${startText} 〜 ${endTime}`;
	return `${startText} 〜 ${md(endDateKey)} ${endTime}`;
}

// -----------------------------------------------------------------------------
// クリップボードコピーの degrade 分岐(#44 指示2(b))
// -----------------------------------------------------------------------------

/**
 * コピー方式の選択(純粋な分岐の記述。実際の副作用は entry 側が担う)。
 *
 * 【なぜこの形か(#44 指示2)】sandbox iframe 内では navigator.clipboard.writeText が Permissions Policy で
 * 拒否される(あるいは undefined)ことがある。第一手段は clipboard API、拒否/不在なら textarea+execCommand
 * フォールバックへ degrade する、という2段の分岐だけを純関数で表明しテストで固定する
 * (DOM 実行そのものはテスト不能なので、"どちらを選ぶか" の判定式だけを切り出す)。
 *
 * @param hasClipboardApi navigator.clipboard?.writeText が関数として在るか(entry 側が typeof で判定して渡す)
 * @returns "clipboard-api"(第一手段)| "exec-command"(フォールバック)
 */
export function chooseCopyStrategy(hasClipboardApi: boolean): "clipboard-api" | "exec-command" {
	return hasClipboardApi ? "clipboard-api" : "exec-command";
}
