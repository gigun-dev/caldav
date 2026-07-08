// =============================================================================
// VTimezone — RFC 5545 §3.6.5 VTIMEZONE コンポーネントのレンズ
// =============================================================================
//
// TZID 付き日時(CalDateTime の zoned 形態)を絶対時刻へ解決するための定義。iOS は
// TZID 付き DTSTART を送るとき必ず対応する VTIMEZONE を同梱してくる(I8)。
// このレンズは「TZID の宣言」と「STANDARD/DAYLIGHT の観測規則」を読むだけで、
// オフセットの実際の計算(zoned → 絶対時刻)は将来の RecurrenceExpansion / time-range
// 評価の責務(§1-4)。ここでは validate(I10)までを担う。
// =============================================================================

import type { Component } from "../structure/types";
import { InvariantViolation } from "./errors";
import { firstProp, rawValue, subComponents } from "./helpers";

export class VTimezone {
	private constructor(private readonly component: Component) {}

	static fromComponent(c: Component): VTimezone {
		if (c.name !== "VTIMEZONE") {
			throw new Error(`VTimezone.fromComponent: expected VTIMEZONE component, got ${c.name}`);
		}
		return new VTimezone(c);
	}

	get raw(): Component {
		return this.component;
	}

	/**
	 * TZID(§3.8.3.1)。このタイムゾーン定義の識別子(例 "Asia/Tokyo")。
	 * ICalendarObject の I8 検証が、日時プロパティの TZID パラメータとこれを突き合わせる。
	 */
	get tzid(): string | undefined {
		return rawValue(this.component, "TZID");
	}

	/** STANDARD サブコンポーネント群(標準時の観測規則。複数可)。 */
	standard(): Component[] {
		return subComponents(this.component, "STANDARD");
	}

	/** DAYLIGHT サブコンポーネント群(夏時間の観測規則。複数可)。 */
	daylight(): Component[] {
		return subComponents(this.component, "DAYLIGHT");
	}

	// ---------------------------------------------------------------------------
	// validate: I10(TZID 必須 + STANDARD/DAYLIGHT 少なくとも1つ + 各サブの必須プロパティ)
	// ---------------------------------------------------------------------------
	validate(): InvariantViolation[] {
		const violations: InvariantViolation[] = [];
		const add = (message: string): void => {
			violations.push(new InvariantViolation("I10", "VTIMEZONE", message));
		};

		// TZID 必須(§3.6.5)。
		if (firstProp(this.component, "TZID") === undefined) {
			add("TZID is required (§3.6.5)");
		}

		// STANDARD か DAYLIGHT が少なくとも1つ(両方必須ではない。§05 訂正6)。
		const subs = [...this.standard(), ...this.daylight()];
		if (subs.length === 0) {
			add("VTIMEZONE must contain at least one STANDARD or DAYLIGHT sub-component (§3.6.5)");
		}

		// 各サブコンポーネントは DTSTART / TZOFFSETTO / TZOFFSETFROM 必須(§3.6.5)。
		for (const sub of subs) {
			for (const required of ["DTSTART", "TZOFFSETTO", "TZOFFSETFROM"]) {
				if (firstProp(sub, required) === undefined) {
					add(`${sub.name} sub-component requires ${required} (§3.6.5)`);
				}
			}
		}

		return violations;
	}
}
