// =============================================================================
// icaljs-rrule-iterator — RecurrenceIterator port の ical.js アダプタ
// =============================================================================
//
// 【依存の絞り方(docs/modeling/08 §5 の決着。domain/ical/recurrence/iterator-port.ts も参照)】
// ical.js に依存するのはこのファイルだけ(infrastructure 層)。使うのは ICAL.Recur +
// ICAL.Time の「反復アルゴリズム」だけで、ICAL.Event / ICAL.TimezoneService /
// ICAL.Timezone(VTIMEZONE 評価)は一切使わない — 本リポジトリの TZ 解決は
// domain/ical/timezone/(resolver.ts の4段チェーン + instant.ts の Intl/ICU 変換)で
// 独自に確立済みで、ical.js 側の TZ 機構を混ぜると「どちらの解決が正か」が二重化する事故の元。
// ここで作る ICAL.Time は常に「floating(zone 未指定)」— ical.js の RecurIterator は
// dtstart.zone を見ずに壁時計フィールドだけを動かすので、floating で反復させて構わない。
// =============================================================================

import ICAL from "ical.js";
import type { RecurrenceIterator, RecurrenceWallClockFields } from "../../domain/ical/recurrence/iterator-port";
import type { RecurrenceRule } from "../../domain/ical/values/recurrence-rule";
import { formatRecurrenceRule } from "../../domain/ical/values/recurrence-rule";

// ical.js の RecurIterator は暴走ガード(内部の maxTries)を持つ。具体的には
// RecurIterator#next 内で「1回の next() 呼び出しあたり最大 1e6 回サブ計算を試みて
// 見つからなければ null を返して打ち切る」実装(ical.js 本体のソース。BYxxx の組み合わせが
// スカスカ/矛盾していて次の occurrence がなかなか見つからないケースの DoS 対策)。
// この暴走ガードは ical.js 内部の話で、こちら側の maxOccurrences(expansion.ts が呼び出しを
// 打ち切る回数)とは独立の二重の安全弁になっている。
export class IcaljsRRuleIterator implements RecurrenceIterator {
	*iterate(rule: RecurrenceRule, dtstartFields: RecurrenceWallClockFields, isDate: boolean): Iterable<RecurrenceWallClockFields> {
		// --- RecurrenceRule(domain 値オブジェクト)→ ICAL.Recur --------------------------
		// formatRecurrenceRule() で RECUR 値文字列へ落としてから ICAL.Recur.fromString で
		// 読み直す。フィールド対応(byDay の序数表現など)を手で1つ1つ変換するより、
		// 既に検証済みの format 関数を再利用したほうが変換バグの入る余地が少ない。
		// 呼び出し側(expansion.ts)は UNTIL を含まない rule を渡す契約(port のコメント参照)なので、
		// ここで組み立てる RECUR 値文字列にも UNTIL は現れない = ical.js 側は
		// COUNT 指定時だけ有限、それ以外は無限反復になる。
		const recurString = formatRecurrenceRule(rule);
		const recur = ICAL.Recur.fromString(recurString);

		// --- dtstart 壁時計フィールド → ICAL.Time(floating。zone 引数を渡さない)---------
		// isDate を渡すことで ical.js 内部の日付処理(時刻成分を無視する分岐)を有効にする。
		// DATE 値のときに hour/minute/second が 0 でなくても isDate=true なら ical.js は
		// 時刻成分を見ない実装だが、呼び出し側(expansion.ts)は既に I9 に従って
		// BYSECOND/BYMINUTE/BYHOUR を rule から落とした上で 0 を渡す契約にしている。
		const dtstart = ICAL.Time.fromData({
			year: dtstartFields.year,
			month: dtstartFields.month,
			day: dtstartFields.day,
			hour: dtstartFields.hour,
			minute: dtstartFields.minute,
			second: dtstartFields.second,
			isDate,
		});

		const iter = recur.iterator(dtstart);

		// ical.js の next() は完了すると null を返す(型定義は Time だが実装は null を返しうる。
		// completed フラグでも判定できるが、null 判定のほうが素直なので両方見て安全側に倒す)。
		for (let next = iter.next(); next !== null && next !== undefined && !iter.completed; next = iter.next()) {
			yield {
				year: next.year,
				month: next.month,
				day: next.day,
				hour: next.hour,
				minute: next.minute,
				second: next.second,
			};
			// completed になった回の next も一応 yield 済みなので、ループ条件の再評価で終了する。
			if (iter.completed) break;
		}
	}
}
