// =============================================================================
// vevent-alarm — VEVENT の「開始相対 VALARM(通知)」プリミティブ(E-3 スライス S1.5)
// =============================================================================
//
// 【なぜ独立ファイルにするか(vevent-write / vevent-patch / event-dto の共有カーネル)】
// 通知(VALARM)は create-event が新規に書き(vevent-write)・update-event が全置換し
// (vevent-patch)・Event DTO が読み戻す(event-dto)という3経路で「同じ1つの VALARM 表現」を
// 扱う。表現(ACTION/DESCRIPTION/TRIGGER/UID の並びと TRIGGER 書式)がこの3箇所でズレると
// ロスレス往復が壊れるため、build/predicate/read を1ファイルに集約して単一情報源にする
// (vtodo 側は VALARM 生成が vtodo-write に直書きされていて patch(shiftAbsoluteAlarmTriggers /
// removeDueAnchoredAlarmTriggers)側とロジックが分散しているが、VEVENT では最初から共有化する)。
//
// 【VTODO の VALARM との意図的な違い: 絶対 UTC トリガー vs 開始相対トリガー】
// vtodo-write.ts の VALARM は iOS リマインダー実機挙動(docs/modeling/06 §D5)に合わせて
// 絶対 UTC の TRIGGER;VALUE=DATE-TIME を書く。一方 VEVENT の通知は「開始の n 分前」という
// 開始相対が iOS カレンダーの語彙なので、こちらは相対トリガー(既定 = RELATED=START の DURATION)を
// 書く。相対トリガーにする利点は「DTSTART を動かせば通知時刻も自動追従する(サーバーが
// トリガーを shift しなくてよい)」こと — update-event が start を変えても VALARM を触らずに済む。
//
// 【TRIGGER 書式の裁定(docs/rfc/rfc5545.txt §3.8.6.3 原文確認済み)】
// - 既定の値型は DURATION、既定の関連は「関連付けられた event/to-do の START からの相対」
//   (原文 "The default duration is relative to the start of an event or to-do")。よって
//   VALUE パラメータも RELATED パラメータも付けない素の `TRIGGER:<dur-value>` が
//   「開始の相対」を意味する(RFC 例も `TRIGGER:-PT15M` = 開始 15 分前)。
// - 負の DURATION が「開始より前(before)」、正が「開始より後(after)」(原文 "An alarm with a
//   negative duration is triggered before ...")。通知は「n 分前」なので負の `-PT{n}M` で書く。
// - n=0(開始時刻ちょうど)は `-PT0M` と書く。§3.3.6 の dur-value 文法上 `-PT0M` は合法
//   (符号は全体に1つ・dur-minute = 1*DIGIT "M" なので "0M" 可)。`PT0S` でも意味は同じだが、
//   0 も含めて `-PT{n}M` の単一書式に統一する方が生成・読み戻しの分岐が減る(minutesBefore=0 の
//   往復が `-PT0M`⇔0 で素直に閉じる)。RELATED=START の既定に載るので絶対 0 の曖昧さは無い。
// =============================================================================

import type { Component } from "../structure/types";
import { parseDurationValue } from "../values/duration-value";
import { firstProp, paramFirst } from "./helpers";

/**
 * 開始相対の DISPLAY アラーム(VALARM)を1つ組み立てる。
 *
 * @param minutesBefore 開始の何分前に鳴らすか(0 = 開始時刻ちょうど)。非負整数を渡す契約
 *   (負値・非整数・上限件数の検証は application 層 create-event/update-event の責務)。
 * @param uid VALARM の UID と X-WR-ALARMUID に同値で入れる識別子(呼び出し側が採番)。
 *
 * 【プロパティ順(ACTION → DESCRIPTION → TRIGGER → UID → X-WR-ALARMUID)】vtodo-write.ts の
 * VALARM と同順に揃える(RFC 上は順序に意味は無いが、決定的な出力で diff/テストを安定させる
 * 既存方針 + iOS 実機フィクスチャの並びに寄せる。UID==X-WR-ALARMUID も iOS の流儀の踏襲)。
 * DESCRIPTION は ACTION:DISPLAY で REQUIRED(§3.8.6.1)。iOS リマインダー実機が固定文字列
 * "Reminder" を送るのに倣い、SUMMARY 流用ではなく固定 "Reminder" にする(vtodo-write と同じ流儀)。
 */
export function buildStartRelativeAlarm(minutesBefore: number, uid: string): Component {
	return {
		name: "VALARM",
		properties: [
			{ name: "ACTION", parameters: [], value: "DISPLAY" },
			{ name: "DESCRIPTION", parameters: [], value: "Reminder" },
			// TRIGGER:-PT{n}M。VALUE も RELATED も付けない = 既定(DURATION・開始相対。ファイル冒頭裁定)。
			{ name: "TRIGGER", parameters: [], value: `-PT${minutesBefore}M` },
			{ name: "UID", parameters: [], value: uid },
			{ name: "X-WR-ALARMUID", parameters: [], value: uid },
		],
		components: [],
	};
}

/**
 * VALARM が「開始相対トリガー(このサーバーが管理する種別)」かを判定する。
 *
 * 【この述語で管理対象を絞る理由(他クライアントのアラームを黙って壊さない安全側)】
 * update-event の alarms 全置換は「開始相対 VALARM だけを差し替え、それ以外(絶対トリガー・
 * RELATED=END の終了相対・位置トリガー等、iOS や他クライアントが書いたもの)は温存」する。
 * どれを我々が管理してよいかの線引きがこの述語。判定基準:
 *   - VALARM である。
 *   - X-APPLE-PROXIMITY(位置トリガー)を持たない(位置アラームは時刻に依存せず別種。
 *     vtodo-patch.ts の shiftAbsoluteAlarmTriggers が位置アラームを据え置くのと同じ扱い)。
 *   - TRIGGER の値型が DURATION(= VALUE=DATE-TIME でない)。絶対トリガーは我々の管理外。
 *   - RELATED パラメータが無いか START(= 開始相対)。RELATED=END(終了相対)は管理外。
 */
export function isStartRelativeAlarm(c: Component): boolean {
	if (c.name !== "VALARM") return false;
	if (firstProp(c, "X-APPLE-PROXIMITY") !== undefined) return false;
	const trigger = firstProp(c, "TRIGGER");
	if (trigger === undefined) return false;
	// 値型: VALUE=DATE-TIME なら絶対トリガー。既定(パラメータ無し)= DURATION = 相対(§3.8.6.3)。
	if (paramFirst(trigger, "VALUE")?.toUpperCase() === "DATE-TIME") return false;
	// 関連: 既定は START。END(終了相対)は管理対象外。START/未指定のみ管理する。
	const related = paramFirst(trigger, "RELATED")?.toUpperCase();
	if (related !== undefined && related !== "START") return false;
	return true;
}

/**
 * 開始相対 VALARM から minutesBefore(開始の何分前)を読み取る。開始相対でなければ undefined。
 *
 * 【符号の意味: before(負 DURATION)= 正の minutesBefore】§3.8.6.3 原文どおり負の DURATION が
 * 「開始より前」。よって `-PT30M`(before)→ minutesBefore=30、`PT10M`(after start)→ -10 と
 * 符号反転して返す(我々の書き込みは常に before=負だが、他クライアントが after を書いていても
 * 数値として素直に表現できるようにしておく。TRIGGER が壊れて parse できなければ undefined で
 * degrade する — 1件の壊れたアラームで list 全体を落とさない event-dto の degrade 方針に合わせる)。
 */
export function startRelativeAlarmMinutesBefore(c: Component): number | undefined {
	if (!isStartRelativeAlarm(c)) return undefined;
	const trigger = firstProp(c, "TRIGGER")!;
	let dur;
	try {
		dur = parseDurationValue(trigger.value);
	} catch {
		return undefined; // 壊れた DURATION は数えない(degrade)。
	}
	// 週/日/時/分/秒を分に畳む(我々の生成は分単位だが、他クライアントの P1H 等も総分で表現する)。
	const totalMinutes =
		(dur.weeks ?? 0) * 7 * 24 * 60 +
		(dur.days ?? 0) * 24 * 60 +
		(dur.hours ?? 0) * 60 +
		(dur.minutes ?? 0) +
		(dur.seconds ?? 0) / 60;
	// positive=false(before)→ 正の minutesBefore。positive=true(after)→ 負。0 はどちらでも 0。
	return dur.positive ? -totalMinutes : totalMinutes;
}
