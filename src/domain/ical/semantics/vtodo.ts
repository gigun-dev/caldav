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
	firstProp,
	isCalDateTime,
	parseDateOrDateTime,
	rawValue,
	sameDateForm,
	subComponents,
} from "./helpers";
import { parseInteger, reportDuplicate, safe } from "./vevent";

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
	// validate: I2 / I4 / DUE の値型一致(I6 相当)+ カーディナリティ + 配下 VALARM
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

		// --- I6 相当: DUE の値型は DTSTART と一致 MUST(§3.8.2.3)---------------------
		const dtstartProp = firstProp(c, "DTSTART");
		const dueProp = firstProp(c, "DUE");
		if (dtstartProp !== undefined && dueProp !== undefined) {
			safe(violations, "I6", "VTODO", () => {
				const start = parseDateOrDateTime(dtstartProp);
				const due = parseDateOrDateTime(dueProp);
				// 値型(DATE/DATE-TIME)+ 形態の一致を見る。DUE は開始より後であるべきだが、
				// RFC は DTSTART<DUE を明示 MUST とはしていない(§3.8.2.3 は値型一致を要求)ので
				// 大小はここでは強制しない。値型一致だけを I6 相当として報告する。
				if (!sameDateForm(start, due)) {
					add("I6", "DUE value type/form must match DTSTART (§3.8.2.3)");
				}
			});
		}

		// 配下の VALARM を集約。
		for (const alarm of this.alarms()) {
			violations.push(...alarm.validate());
		}

		return violations;
	}
}
