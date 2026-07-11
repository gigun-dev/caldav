// =============================================================================
// ICalendarObject — RFC 5545 §3.4/§3.6 VCALENDAR の集約ルート(レンズ)
// =============================================================================
//
// 【集約ルートだが、やはり Component を包むレンズ(§1-1)】
// 独自ツリーへ変換せず、内部 VCALENDAR Component を保持して events()/todos()/timezones()
// で子コンポーネントをレンズ化して返す。CalDAV リソース層(CalendarObjectResource)は
// この集約を payload として持つ(§2)が、URL や ETag といった DAV の都合はここに一切
// 持ち込まない(コンテキスト境界。iCalendar は最も内側)。
//
// 【validate の集約構造】
// この validate() は I1(VCALENDAR 自身)と I8(VCALENDAR 全体を横断する TZID 参照整合)を
// 見たうえで、配下の VEvent/VTodo/VTimezone の validate() をすべて連結して返す。
// 「全違反を集めて返す」方針(errors.ts)なので、途中で throw も打ち切りもしない。
// =============================================================================

import type { Component } from "../structure/types";
import { InvariantViolation } from "./errors";
import { VEvent } from "./vevent";
import { VTodo } from "./vtodo";
import { VJournal } from "./vjournal";
import { VTimezone } from "./vtimezone";
import { firstProp, paramFirst, rawValue, subComponents, valueType } from "./helpers";

export class ICalendarObject {
	private constructor(private readonly component: Component) {}

	/**
	 * VCALENDAR Component からレンズを作る。名前が VCALENDAR 以外はエラー
	 * (リソースの中身は VCALENDAR 1つ、という前提。パーサーもトップレベル単一を強制済み)。
	 */
	static fromComponent(c: Component): ICalendarObject {
		if (c.name !== "VCALENDAR") {
			throw new Error(`ICalendarObject.fromComponent: expected VCALENDAR component, got ${c.name}`);
		}
		return new ICalendarObject(c);
	}

	get raw(): Component {
		return this.component;
	}

	// ---------------------------------------------------------------------------
	// カレンダー全体のプロパティ / 子コンポーネント
	// ---------------------------------------------------------------------------

	/** PRODID(§3.7.3)。生成プロダクト識別子。必須(I1)。 */
	get prodid(): string | undefined {
		return rawValue(this.component, "PRODID");
	}

	/** VERSION(§3.7.4)。"2.0" 必須(I1)。 */
	get version(): string | undefined {
		return rawValue(this.component, "VERSION");
	}

	/** METHOD(§3.7.2)。iTIP(スケジューリング)時のみ存在。通常のカレンダーリソースには無い。 */
	get method(): string | undefined {
		return rawValue(this.component, "METHOD")?.toUpperCase();
	}

	/** 配下の VEVENT をレンズ化(同一 UID のマスター+オーバーライドで複数並びうる。§3.8.4.4)。 */
	events(): VEvent[] {
		return subComponents(this.component, "VEVENT").map((c) => VEvent.fromComponent(c));
	}

	/** 配下の VTODO をレンズ化。 */
	todos(): VTodo[] {
		return subComponents(this.component, "VTODO").map((c) => VTodo.fromComponent(c));
	}

	/** 配下の VJOURNAL をレンズ化(J-1: 方向性 J「agentic な日誌」)。
	 *  VEVENT/VTODO 同様、同一 UID のマスター+オーバーライドで複数並びうる。 */
	journals(): VJournal[] {
		return subComponents(this.component, "VJOURNAL").map((c) => VJournal.fromComponent(c));
	}

	/** 配下の VTIMEZONE をレンズ化。 */
	timezones(): VTimezone[] {
		return subComponents(this.component, "VTIMEZONE").map((c) => VTimezone.fromComponent(c));
	}

	// ---------------------------------------------------------------------------
	// validate: I1 + I8 + 配下(VEvent/VTodo/VTimezone)の集約
	// ---------------------------------------------------------------------------
	validate(): InvariantViolation[] {
		const violations: InvariantViolation[] = [];

		// --- I1: VCALENDAR は VERSION:2.0 と PRODID を持つ(§3.6)--------------------
		const version = rawValue(this.component, "VERSION");
		if (version === undefined) {
			violations.push(new InvariantViolation("I1", "VCALENDAR", "VERSION is required (§3.6)"));
		} else if (version !== "2.0") {
			// VERSION の値 "2.0" は固定(§3.7.4)。値は case-sensitive("2.0" 以外は不正)。
			violations.push(new InvariantViolation("I1", "VCALENDAR", `VERSION must be "2.0", got "${version}" (§3.7.4)`));
		}
		if (firstProp(this.component, "PRODID") === undefined) {
			violations.push(new InvariantViolation("I1", "VCALENDAR", "PRODID is required (§3.6)"));
		}

		// --- I8: TZID 参照整合 + TZID の MUST NOT(UTC 値・DATE 型への付与)-----------
		violations.push(...this.validateTzidReferences());

		// --- 配下コンポーネントの validate をすべて連結 -----------------------------
		for (const tz of this.timezones()) violations.push(...tz.validate());
		for (const ev of this.events()) violations.push(...ev.validate());
		for (const td of this.todos()) violations.push(...td.validate());
		for (const jo of this.journals()) violations.push(...jo.validate());

		return violations;
	}

	/**
	 * I8 の検証(§3.2.19/§3.3.5)。VCALENDAR 内を再帰的に歩き、TZID パラメータを持つ
	 * 全プロパティについて:
	 *   (a) その TZID を宣言する VTIMEZONE が同じ VCALENDAR 内に存在するか(参照整合 MUST)
	 *   (b) TZID を UTC 値(末尾 Z)に付けていないか(MUST NOT)
	 *   (c) TZID を DATE 型(VALUE=DATE)に付けていないか(MUST NOT)
	 * を確かめる。iOS は必ず VTIMEZONE を同梱してくるので (a) は通常成功するが、
	 * 他クライアント由来データや手組みデータでの取りこぼしを検出する。
	 */
	private validateTzidReferences(): InvariantViolation[] {
		const violations: InvariantViolation[] = [];

		// 宣言済み TZID 集合(VTIMEZONE.tzid)。undefined(TZID 無し VTIMEZONE)は集合に入れない
		// — その不備は VTimezone.validate() の I10 が別途報告する。
		const declared = new Set<string>();
		for (const tz of this.timezones()) {
			const id = tz.tzid;
			if (id !== undefined) declared.add(id);
		}

		// VCALENDAR 配下を再帰的に走査。TZID パラメータを持つプロパティだけを見る。
		const walk = (c: Component): void => {
			for (const p of c.properties) {
				const tzid = paramFirst(p, "TZID");
				if (tzid === undefined) continue;

				// (b) UTC 値(末尾 Z)への TZID は MUST NOT。値の末尾で判定(values 層に投げると
				//     この矛盾で throw するので、ここは文字列判定で「違反」として収集する)。
				if (p.value.endsWith("Z")) {
					violations.push(
						new InvariantViolation("I8", c.name, `TZID must not be combined with a UTC value on ${p.name} (§3.3.5)`),
					);
					continue; // 参照整合の判定はこの矛盾状態では意味がないのでスキップ。
				}
				// (c) DATE 型への TZID は MUST NOT。
				if (valueType(p) === "DATE") {
					violations.push(
						new InvariantViolation("I8", c.name, `TZID must not be applied to a DATE value on ${p.name} (§3.3.5)`),
					);
					continue;
				}
				// (a) 参照整合: 宣言されていない TZID を参照している。
				if (!declared.has(tzid)) {
					violations.push(
						new InvariantViolation(
							"I8",
							c.name,
							`TZID="${tzid}" on ${p.name} has no matching VTIMEZONE in this VCALENDAR (§3.2.19)`,
						),
					);
				}
			}
			// サブコンポーネント(VEVENT>VALARM 等)へ再帰。
			for (const sub of c.components) walk(sub);
		};
		walk(this.component);

		return violations;
	}
}
