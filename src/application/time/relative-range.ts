// =============================================================================
// time/relative-range — 相対レンジ enum → 絶対 epoch 範囲の解決(時刻グラウンディング)
// =============================================================================
//
// 【なぜ相対レンジ enum を足すのか(往復削減)】
// MCP の照会系(list-events-expanded / get-freebusy)は絶対 ISO 範囲(timeMin/timeMax)を
// 要求していた。ホストモデルが「今日の予定」を引くには、まず get-current-time で now を得て
// から今日の 0 時〜明日の 0 時を自前で組み立て、それを timeMin/timeMax に渡す──という
// 2 往復が必要だった。サーバー権威の now で境界を計算して返せば、事前 get-current-time 無しの
// 1 発で「今日の予定」が引ける。get-current-time は「今/今日は何日か」を明示的に知りたい
// 用途で存置し、こちらは「相対レンジを1発で解決する」役割に絞る(排他: どちらか一方)。
//
// 【なぜ enum(自由文字列パースではない)か(Why not natural-language parsing)】
// "next week" のような自由文字列を受けてサーバーがパースする案は不採用。(1) 語彙が無限に
// 広がり曖昧さ(「来週」は月曜起点か? 今日から7日か?)をサーバーが暗黙に埋めることになり、
// SUDO モデリングの「入力の曖昧さをサーバーの暗黙解釈で埋めない」方針に反する。(2) enum なら
// 各キーワードの境界定義をコード+テストで一意に固定でき、モデルにも description で明示できる。
// 初期語彙は today / tomorrow / next-7-days / next-30-days の4つだけに絞る。
//
// 【なぜ this-week を入れないか(Why not this-week)】
// 「週」の起点は WKST(週の始まり: 日曜 or 月曜)に依存し、ロケール/カレンダー設定で割れる。
// サーバーが勝手に月曜起点(or 日曜起点)と決めるとユーザーの期待と静かにズレる。RFC 5545 の
// RRULE は WKST を明示要求するのと同じ問題で、「週」は曖昧さを内包するため初期語彙から外す。
// 需要が出たら wkst を明示引数に取る形で別途足す(今は素朴に保つ)。
//
// 【この層(application/time)に置く理由】
// DAV 専用にせず MCP / REST / メール等の複数入口から呼べるべき純粋なユースケース補助
// (CLAUDE.md 長期ビジョン①)。TZ 解決(domain/ical/timezone)に隣接する application 層の
// 時刻ロジックとして time/ 配下に新設した。now を引数注入する純関数にしてユニットテストで
// 境界を固定できるようにする(Date.now() をモジュール内で直接読まない)。
// =============================================================================

import { localFieldsToEpochMillis } from "../../domain/ical/timezone/instant";

/** 受け付ける相対レンジのキーワード(初期語彙4つ。this-week は WKST 問題で除外・上記参照)。 */
export type RelativeRangeKeyword = "today" | "tomorrow" | "next-7-days" | "next-30-days";

/** resolveRelativeRange の返り値。epoch ミリ秒(呼び出し側が epochToIso で offset ISO 化する)。 */
export interface ResolvedRange {
	timeMinMillis: number;
	timeMaxMillis: number;
}

/** now(epoch ミリ秒)における当該ゾーンのローカル年月日を取り出す。 */
function localYmdAt(nowMillis: number, ianaTimeZone: string): { year: number; month: number; day: number } {
	// Intl.DateTimeFormat の parts で「その瞬間のそのゾーンの壁時計日付」を得る。
	// hourCycle:"h23" は日付だけ見る用途では効かないが、instant.ts と同じ en-US/2-digit の
	// 流儀に揃える(将来 hour まで見るとき事故らないように)。ローカル TZ 依存の Date メソッドは
	// 使わない(instant.ts「ランタイム TZ 非依存」方針を踏襲)。
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: ianaTimeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = fmt.formatToParts(new Date(nowMillis));
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const p = parts.find((x) => x.type === type);
		return p !== undefined ? Number(p.value) : 0;
	};
	return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * 相対レンジキーワードを、当該 TZ の「ローカル午前0時起点・終端排他」の絶対 epoch 範囲へ解決する。
 *
 * 【境界定義(全て当該 TZ のローカル 00:00 基準・終端排他 [start, end))】
 *   today        = [今日0時,   明日0時)
 *   tomorrow     = [明日0時,   明後日0時)
 *   next-7-days  = [今日0時,   7日後0時)
 *   next-30-days = [今日0時,   30日後0時)
 * 終端排他にするのは list-occurrences / compute-free-busy の既存展開ロジックが
 * rangeEndMillis を排他境界(半開区間)として扱うのと整合させるため(境界ちょうどに始まる
 * occurrence を二重に拾わない)。
 *
 * 【なぜミリ秒加算(+86400000)ではなく壁時計のカレンダー日加算か(DST 安全)】
 * 「N 日後の 0 時」を now + N*86400000 で求めると、その N 日の間に DST 切替が挟まると
 * 1 時間ズレる(春は 23h・秋は 25h の日があるため、24h 固定加算は現地 0 時に着地しない)。
 * そこで日付は Y-M-D の day フィールドに +N してから localFieldsToEpochMillis で epoch 化する
 * (壁時計 00:00 を DST 遷移込みで正しく epoch に落とす。TZ 計算は自前で書かず instant.ts に委ねる)。
 * day に +7 や +32 のような月末超えの値を入れても、localFieldsToEpochMillis 内の Date.UTC が
 * 桁上がりを正規化する(例 2026-01-32 → 2026-02-01)ので、月跨ぎ・年跨ぎも自然に処理できる。
 *
 * @param keyword       相対レンジキーワード。
 * @param ianaTimeZone  境界を計算するゾーン(呼び出し側が検証済みの前提。range 指定時は必須)。
 * @param nowMillis     サーバー権威の現在時刻(epoch ミリ秒)。テストで固定注入できるよう引数化。
 */
export function resolveRelativeRange(
	keyword: RelativeRangeKeyword,
	ianaTimeZone: string,
	nowMillis: number,
): ResolvedRange {
	const { year, month, day } = localYmdAt(nowMillis, ianaTimeZone);

	// startDayOffset / endDayOffset: 「今日のローカル日」からの日数オフセット([start, end))。
	// 壁時計 00:00 を作るため hour/minute/second は常に 0。
	let startDayOffset: number;
	let endDayOffset: number;
	switch (keyword) {
		case "today":
			startDayOffset = 0;
			endDayOffset = 1;
			break;
		case "tomorrow":
			startDayOffset = 1;
			endDayOffset = 2;
			break;
		case "next-7-days":
			startDayOffset = 0;
			endDayOffset = 7;
			break;
		case "next-30-days":
			startDayOffset = 0;
			endDayOffset = 30;
			break;
	}

	const atMidnight = (dayOffset: number): number =>
		// day + offset を localFieldsToEpochMillis に渡す(月末超えは Date.UTC が桁上げ正規化)。
		// これが「壁時計のカレンダー日加算」の実体 — ミリ秒加算をしないので DST 安全。
		localFieldsToEpochMillis({ year, month, day: day + dayOffset, hour: 0, minute: 0, second: 0 }, ianaTimeZone);

	return {
		timeMinMillis: atMidnight(startDayOffset),
		timeMaxMillis: atMidnight(endDayOffset),
	};
}
