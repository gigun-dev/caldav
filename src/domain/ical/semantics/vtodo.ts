// =============================================================================
// VTodo — RFC 5545 §3.6.2 VTODO コンポーネントのレンズ(iOS リマインダーの主戦場)
// =============================================================================
//
// VEVENT と同じく「Component を包む読み取りレンズ + validate」。書き込みは将来の PUT で。
// VTODO 特有の点:
//   - 期限は DUE(§3.8.2.3)。DUE と DURATION は排他(I4)で、DURATION 側は DTSTART 必須。
//   - COMPLETED(§3.8.2.1)は「完了時刻」で UTC DATE-TIME MUST。
//   - PERCENT-COMPLETE(§3.8.1.8)は 0..100 の整数。PRIORITY(§3.8.1.9)は 0..9 の整数。
//   - STATUS: NEEDS-ACTION|COMPLETED|IN-PROCESS|CANCELLED(§3.8.1.11)。
// =============================================================================

import type { Component } from "../structure/types";
import {
	type CalDate,
	type CalDateTime,
	type DurationValue,
	parseDurationValue,
	parseRecurrenceRule,
	type RecurrenceRule,
} from "../values";
import { InvariantViolation } from "./errors";
import { VAlarm } from "./valarm";
import {
	compareDateValue,
	firstProp,
	isCalDateTime,
	isChronologicallyComparable,
	parseDateOrDateTime,
	rawValue,
	// sameDateForm は P2 修正で VTODO では未使用になった(DUE 判定を値型一致のみに緩和したため)。
	// helpers.ts の定義自体は VEvent の RECURRENCE-ID 形態一致検証で使われ続けるので残す。
	subComponents,
} from "./helpers";
import { parseInteger, reportDuplicate, safe, validateRRule } from "./vevent";

export class VTodo {
	private constructor(private readonly component: Component) {}

	static fromComponent(c: Component): VTodo {
		if (c.name !== "VTODO") {
			throw new Error(`VTodo.fromComponent: expected VTODO component, got ${c.name}`);
		}
		return new VTodo(c);
	}

	get raw(): Component {
		return this.component;
	}

	// ---------------------------------------------------------------------------
	// 読み取りアクセサ
	// ---------------------------------------------------------------------------

	get uid(): string | undefined {
		return rawValue(this.component, "UID");
	}

	get dtstamp(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTSTAMP");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	get dtstart(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTSTART");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/** DUE(§3.8.2.3)。期限。DURATION と排他(I4)。値型は DTSTART と一致 MUST(I6 相当)。 */
	get due(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DUE");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	get duration(): DurationValue | undefined {
		const raw = rawValue(this.component, "DURATION");
		return raw !== undefined ? parseDurationValue(raw) : undefined;
	}

	get summary(): string | undefined {
		return rawValue(this.component, "SUMMARY");
	}

	/** STATUS(§3.8.1.11)。列挙値は case-insensitive → 大文字化して返す。 */
	get status(): string | undefined {
		return rawValue(this.component, "STATUS")?.toUpperCase();
	}

	/** COMPLETED(§3.8.2.1)。完了時刻。UTC DATE-TIME MUST(検証は将来の必要時に)。 */
	get completed(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "COMPLETED");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/** PERCENT-COMPLETE(§3.8.1.8)。0..100 の整数。範囲検証は将来の必要時に(iOS は 0/100 主体)。 */
	get percentComplete(): number | undefined {
		const raw = rawValue(this.component, "PERCENT-COMPLETE");
		return raw !== undefined ? parseInteger(raw, "PERCENT-COMPLETE") : undefined;
	}

	/** PRIORITY(§3.8.1.9)。0..9 の整数(0=未定義)。 */
	get priority(): number | undefined {
		const raw = rawValue(this.component, "PRIORITY");
		return raw !== undefined ? parseInteger(raw, "PRIORITY") : undefined;
	}

	get sequence(): number | undefined {
		const raw = rawValue(this.component, "SEQUENCE");
		return raw !== undefined ? parseInteger(raw, "SEQUENCE") : undefined;
	}

	get rrule(): RecurrenceRule | undefined {
		const raw = rawValue(this.component, "RRULE");
		return raw !== undefined ? parseRecurrenceRule(raw) : undefined;
	}

	/** サブコンポーネントの VALARM(VTODO もアラームを持てる。§3.6.6)。 */
	alarms(): VAlarm[] {
		return subComponents(this.component, "VALARM").map((c) => VAlarm.fromComponent(c));
	}

	// ---------------------------------------------------------------------------
	// validate: I2 / I4(DUE/DURATION 排他 + DUE>DTSTART)/ I5 / I6(DUE・UNTIL の値型一致)
	//           + カーディナリティ + 配下 VALARM
	// ---------------------------------------------------------------------------
	validate(): InvariantViolation[] {
		const c = this.component;
		const violations: InvariantViolation[] = [];
		const add = (invariant: ConstructorParameters<typeof InvariantViolation>[0], message: string): void => {
			violations.push(new InvariantViolation(invariant, "VTODO", message));
		};

		// カーディナリティ(UID/DTSTAMP → I2、DUE/DURATION/DTSTART → I4)。
		reportDuplicate(add, c, "UID", "I2");
		reportDuplicate(add, c, "DTSTAMP", "I2");
		reportDuplicate(add, c, "DUE", "I4");
		reportDuplicate(add, c, "DURATION", "I4");
		reportDuplicate(add, c, "DTSTART", "I4");

		// --- I2: UID + DTSTAMP 必須。DTSTAMP は UTC 形式 MUST -----------------------
		if (firstProp(c, "UID") === undefined) add("I2", "UID is required (§3.6.2)");
		const dtstampProp = firstProp(c, "DTSTAMP");
		if (dtstampProp === undefined) {
			add("I2", "DTSTAMP is required (§3.6.2)");
		} else {
			safe(violations, "I2", "VTODO", () => {
				const v = parseDateOrDateTime(dtstampProp);
				if (!isCalDateTime(v) || v.kind !== "utc") {
					add("I2", "DTSTAMP must be a UTC date-time (ending in 'Z') (§3.8.7.2)");
				}
			});
		}

		// --- I4: DUE と DURATION 排他。DURATION には DTSTART 必須(§3.6.2)------------
		const hasDue = firstProp(c, "DUE") !== undefined;
		const hasDuration = firstProp(c, "DURATION") !== undefined;
		const hasDtstart = firstProp(c, "DTSTART") !== undefined;
		if (hasDue && hasDuration) {
			add("I4", "DUE and DURATION must not both be present (§3.6.2)");
		}
		if (hasDuration && !hasDtstart) {
			add("I4", "DURATION requires DTSTART in VTODO (§3.6.2)");
		}

		// --- I6 相当: DUE の値型は DTSTART と一致 MUST + I4: DUE は DTSTART より後 MUST(§3.8.2.3)----
		const dtstartProp = firstProp(c, "DTSTART");
		const dueProp = firstProp(c, "DUE");
		if (dtstartProp !== undefined && dueProp !== undefined) {
			safe(violations, "I6", "VTODO", () => {
				const start = parseDateOrDateTime(dtstartProp);
				const due = parseDateOrDateTime(dueProp);

				// P2(2026-07-08 レビュー指摘): DUE と DTSTART の一致要求は「値型(DATE/DATE-TIME)一致」のみ。
				// §3.8.2.3 の "The value type ... MUST be the same as the DTSTART" は VALUE 型一致であって、
				// 形態(floating/utc/zoned+tzid)一致まで MUST なのは RECURRENCE-ID だけ(§3.8.4.4 / docs/05 訂正5・75行)。
				// 旧実装は sameDateForm で形態一致まで要求し、DTSTART;TZID=Asia/Tokyo:... + DUE:...Z を
				// I6 誤検知していた。VEvent の DTEND 判定(isCalDateTime の差)と同じ粒度に揃える。
				if (isCalDateTime(start) !== isCalDateTime(due)) {
					add("I6", "DUE value type must match DTSTART (DATE vs DATE-TIME) (§3.8.2.3)");
				} else if (isChronologicallyComparable(start, due) && compareDateValue(due, start) < 0) {
					// I4(2026-07-08 レビュー時に §3.8.2.3 の "value MUST be later in time than DTSTART" を発見・追記):
					// DUE は DTSTART より後。比較は「解決不要で well-defined な形態」だけ。
					// zoned は VTIMEZONE 解決が要る(compareDateValue の限界コメント)ので比較しない
					// = VEvent の DTEND>DTSTART(I3)が同一形態前提で比較するのと同じ扱いに揃えている。
					//
					// 2026-07-10 実測修正(iOS 26.5 実機キャプチャ、docs 06 A4): iOS の「期限日付のみ」
					// リマインダーは `DTSTART;VALUE=DATE:20260710` + `DUE;VALUE=DATE:20260710`(=同日)を
					// 送ってくる(real-ios/vtodo-completed.ics)。旧実装は `<= 0`(同値も違反)でこれを
					// I4 誤検知し、precondition 層で iOS の日付リマインダーを一律 PUT 拒否してしまう
					// (= コア価値の iOS 対応を壊す)。§3.8.2.3 の "later in time" は厳密には `>` だが、
					// 最も気難しいクライアント(iOS)が等号を常用する以上、寛容化して `< 0`(DUE < DTSTART の
					// 逆転だけを違反)にする。「RFC の MUST より iOS の実挙動を優先」は CLAUDE.md の
					// コア価値方針どおり(DATE 終日タスクは begin==due が自然で、逆転でなければ実害なし)。
					add("I4", "DUE must not be earlier than DTSTART (§3.8.2.3; iOS sends equal for all-day, allowed)");
				}
			});
		}

		// --- I5/I6: RRULE の UNTIL/COUNT 排他・UNTIL 値型一致(§3.3.10)-------------------
		// 2026-07-08 レビュー指摘: VTODO の RRULE が素通りしていた。VEVENT と同じ共通ロジック
		// (vevent.ts の validateRRule)で検証する。VTODO も RRULE を持てる(§3.6.2)。
		validateRRule(violations, "VTODO", c);

		// 配下の VALARM を集約。
		for (const alarm of this.alarms()) {
			violations.push(...alarm.validate());
		}

		return violations;
	}
}
