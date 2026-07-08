// =============================================================================
// VEvent — RFC 5545 §3.6.1 VEVENT コンポーネントのレンズ
// =============================================================================
//
// 【レンズであってデータ変換ではない(§1-1)】
// VEvent は内部に Component(name=VEVENT)を1つ持つだけ。dtstart などのアクセサは
// 呼ばれるたびに内部 Property を values/ コーデックで解釈して返す。未知の X-APPLE-* は
// Component 内にそのまま残り、ロスレス往復が壊れない。
//
// 【今はイミュータブル読み取り + validate だけ】
// 書き込みアクセサ(setDtstart 等)は将来の PUT ユースケース実装時に、内部 Property を
// 差し替える形で追加する。今それを入れないのは、書き込みには「値→生文字列の format +
// パラメータ(TZID/VALUE)の再構築 + プロパティ順の保存」というロスレス配慮が要り、
// PUT の要件(If-Match, ETag 再計算)と一緒に設計しないと中途半端になるため。
// =============================================================================

import type { Component } from "../structure/types";
import {
	type CalDate,
	type CalDateTime,
	type CalAddress,
	type DurationValue,
	type RecurrenceRule,
	parseCalAddress,
	parseDurationValue,
	parseRecurrenceRule,
	InvalidValueError,
} from "../values";
import type { Property } from "../structure/types";
import { InvariantViolation } from "./errors";
import { VAlarm } from "./valarm";
import {
	allProps,
	compareDateValue,
	firstProp,
	isCalDateTime,
	parseDateOrDateTime,
	rawValue,
	sameDateForm,
	subComponents,
	valueType,
} from "./helpers";

export class VEvent {
	private constructor(private readonly component: Component) {}

	static fromComponent(c: Component): VEvent {
		if (c.name !== "VEVENT") {
			throw new Error(`VEvent.fromComponent: expected VEVENT component, got ${c.name}`);
		}
		return new VEvent(c);
	}

	get raw(): Component {
		return this.component;
	}

	// ---------------------------------------------------------------------------
	// 読み取りアクセサ(値が壊れていれば values/ コーデックの throw を伝播する)
	// ---------------------------------------------------------------------------

	/** UID(§3.8.4.7)。識別子なので生文字列のまま返す。 */
	get uid(): string | undefined {
		return rawValue(this.component, "UID");
	}

	/**
	 * DTSTAMP(§3.8.7.2)。UTC 形式 MUST だが、アクセサでは形態を強制せず解釈結果を返す
	 * (UTC 強制の診断は validate の I2 の役目)。DATE-TIME 兼 DATE を返しうるが、
	 * DTSTAMP は常に DATE-TIME なので実際は CalDateTime。
	 */
	get dtstamp(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTSTAMP");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/**
	 * DTSTART(§3.8.2.4)。VALUE=DATE なら CalDate、そうでなければ CalDateTime(TZID 反映)。
	 * 終日イベントか時刻付きかは返り値の型(CalDate vs CalDateTime)で判別できる。
	 */
	get dtstart(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTSTART");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/** DTEND(§3.8.2.2)。DURATION と排他(I3)。値型は DTSTART と一致 MUST(I6)。 */
	get dtend(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTEND");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/** DURATION(§3.8.2.5)。DTEND と排他(I3)。 */
	get duration(): DurationValue | undefined {
		const raw = rawValue(this.component, "DURATION");
		return raw !== undefined ? parseDurationValue(raw) : undefined;
	}

	/** SUMMARY(§3.8.1.12)。TEXT のエスケープは values 層で解除する設計だが、
	 *  ここでは生値を返す(表示整形は上位の関心事。往復のため生値を素通しする)。 */
	get summary(): string | undefined {
		return rawValue(this.component, "SUMMARY");
	}

	/** DESCRIPTION(§3.8.1.5)。 */
	get description(): string | undefined {
		return rawValue(this.component, "DESCRIPTION");
	}

	/** LOCATION(§3.8.1.7)。 */
	get location(): string | undefined {
		return rawValue(this.component, "LOCATION");
	}

	/** STATUS(§3.8.1.11: TENTATIVE|CONFIRMED|CANCELLED)。列挙値は case-insensitive なので大文字化。 */
	get status(): string | undefined {
		return rawValue(this.component, "STATUS")?.toUpperCase();
	}

	/** TRANSP(§3.8.2.7: OPAQUE|TRANSPARENT)。同上、大文字化。 */
	get transp(): string | undefined {
		return rawValue(this.component, "TRANSP")?.toUpperCase();
	}

	/** SEQUENCE(§3.8.7.4)。0 以上の整数(I7)。パース失敗時は NaN を返さず throw(下の parseInteger)。 */
	get sequence(): number | undefined {
		const raw = rawValue(this.component, "SEQUENCE");
		return raw !== undefined ? parseInteger(raw, "SEQUENCE") : undefined;
	}

	/** RRULE(§3.8.5.3)。UNTIL/COUNT 排他などは values 層で検証済み。 */
	get rrule(): RecurrenceRule | undefined {
		const raw = rawValue(this.component, "RRULE");
		return raw !== undefined ? parseRecurrenceRule(raw) : undefined;
	}

	/** RECURRENCE-ID(§3.8.4.4)。マスターの1回を指す。DTSTART と値型・形態一致 MUST(I6)。 */
	get recurrenceId(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "RECURRENCE-ID");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/**
	 * RDATE / EXDATE は「生 Property のまま」返す。
	 * 理由: RDATE は DATE / DATE-TIME / PERIOD の3値型を取りうえ、1プロパティ内に
	 * カンマ区切りで複数値(§3.8.5.2/§3.8.5.1)。個々の値への展開(occurrence 集合の構築)は
	 * RecurrenceExpansion ドメインサービス(§1-4)の責務で、レンズの読み取りでそこまで
	 * 解釈すると層の責務が肥大する。ここは「その Property 群がある」ことだけ型で示す。
	 */
	get rdate(): Property[] {
		return allProps(this.component, "RDATE");
	}
	get exdate(): Property[] {
		return allProps(this.component, "EXDATE");
	}

	/** ORGANIZER(§3.8.4.3)。CAL-ADDRESS。スケジューリング文脈だが往復のため読み取りは提供。 */
	get organizer(): CalAddress | undefined {
		const raw = rawValue(this.component, "ORGANIZER");
		return raw !== undefined ? parseCalAddress(raw) : undefined;
	}

	/** ATTENDEE(§3.8.4.1)。複数出現しうるので配列で返す。 */
	get attendee(): CalAddress[] {
		return allProps(this.component, "ATTENDEE").map((p) => parseCalAddress(p.value));
	}

	/** サブコンポーネントの VALARM をレンズ化して返す(§3.6.6)。 */
	alarms(): VAlarm[] {
		return subComponents(this.component, "VALARM").map((c) => VAlarm.fromComponent(c));
	}

	// ---------------------------------------------------------------------------
	// validate: I2 / I3 / I6(値型一致)/ I7 / I9 + カーディナリティ + 配下 VALARM
	// ---------------------------------------------------------------------------
	validate(): InvariantViolation[] {
		const c = this.component;
		const violations: InvariantViolation[] = [];
		const add = (invariant: Parameters<typeof pushViolation>[1], message: string): void => {
			pushViolation(violations, invariant, "VEVENT", message);
		};

		// --- カーディナリティ(同一プロパティの複数出現)------------------------
		// UID/DTSTAMP は I2、DTSTART/DTEND/DURATION は I3、RECURRENCE-ID は I6、SEQUENCE は I7 に
		// 紐付けて「2 個以上あれば違反」を報告する(タスク要件: UID 2 個等は違反)。
		reportDuplicate(add, c, "UID", "I2");
		reportDuplicate(add, c, "DTSTAMP", "I2");
		reportDuplicate(add, c, "DTSTART", "I3");
		reportDuplicate(add, c, "DTEND", "I3");
		reportDuplicate(add, c, "DURATION", "I3");
		reportDuplicate(add, c, "RECURRENCE-ID", "I6");
		reportDuplicate(add, c, "SEQUENCE", "I7");

		// --- I2: UID + DTSTAMP 必須。DTSTAMP は UTC 形式 MUST(§3.8.7.2)-------------
		if (firstProp(c, "UID") === undefined) add("I2", "UID is required (§3.6.1)");
		const dtstampProp = firstProp(c, "DTSTAMP");
		if (dtstampProp === undefined) {
			add("I2", "DTSTAMP is required (§3.6.1)");
		} else {
			// DTSTAMP は「DATE-TIME の UTC 形態」でなければならない。VALUE=DATE・floating・zoned は違反。
			safe(violations, "I2", "VEVENT", () => {
				const v = parseDateOrDateTime(dtstampProp);
				if (!isCalDateTime(v) || v.kind !== "utc") {
					add("I2", "DTSTAMP must be a UTC date-time (ending in 'Z') (§3.8.7.2)");
				}
			});
		}

		// --- I3: DTEND と DURATION 排他。DTEND > DTSTART(同時刻不可 MUST)-----------
		const hasDtend = firstProp(c, "DTEND") !== undefined;
		const hasDuration = firstProp(c, "DURATION") !== undefined;
		if (hasDtend && hasDuration) {
			add("I3", "DTEND and DURATION must not both be present (§3.6.1)");
		}

		const dtstartProp = firstProp(c, "DTSTART");
		const dtendProp = firstProp(c, "DTEND");

		// --- I6: 値型一致(DTEND/RECURRENCE-ID/UNTIL が DTSTART と一致)--------------
		//     と I3 の DTEND>DTSTART は DTSTART が読めることが前提なので、まとめて処理。
		safe(violations, "I6", "VEVENT", () => {
			const start = dtstartProp !== undefined ? parseDateOrDateTime(dtstartProp) : undefined;

			// DTEND の値型は DTSTART と一致 MUST(§3.8.2.2)。さらに DTEND>DTSTART(I3)。
			if (dtendProp !== undefined && start !== undefined) {
				const end = parseDateOrDateTime(dtendProp);
				// 値型(DATE/DATE-TIME)の一致だけ I6 で見る(DTEND は形態=tzid までは縛らない)。
				if (isCalDateTime(start) !== isCalDateTime(end)) {
					add("I6", "DTEND value type must match DTSTART (DATE vs DATE-TIME) (§3.8.2.2)");
				} else if (compareDateValue(end, start) <= 0) {
					// 同時刻も不可(MUST)。<= 0 を違反とする。
					add("I3", "DTEND must be strictly after DTSTART (§3.8.2.2)");
				}
			}

			// RECURRENCE-ID は DTSTART と「値型 + 形態」一致 MUST(§3.8.4.4)。
			const ridProp = firstProp(c, "RECURRENCE-ID");
			if (ridProp !== undefined && start !== undefined) {
				const rid = parseDateOrDateTime(ridProp);
				if (!sameDateForm(start, rid)) {
					add("I6", "RECURRENCE-ID value type/form must match DTSTART (§3.8.4.4)");
				}
			}

			// UNTIL の値型一致(§3.3.10 / §05 訂正4): DTSTART が DATE なら UNTIL は DATE、
			// DATE-TIME なら UNTIL は DATE-TIME(UTC)。UNTIL の UTC 強制自体は values 層が担保済み。
			const rruleRaw = rawValue(c, "RRULE");
			if (rruleRaw !== undefined && start !== undefined) {
				// RRULE 自体のパース失敗(I5 の UNTIL/COUNT 排他違反等)もここで拾う。
				safe(violations, "I5", "VEVENT", () => {
					const rule = parseRecurrenceRule(rruleRaw);
					if (rule.until !== undefined) {
						const untilIsDate = rule.until.type === "date";
						const startIsDate = !isCalDateTime(start);
						if (untilIsDate !== startIsDate) {
							add("I6", "RRULE UNTIL value type must match DTSTART (DATE vs DATE-TIME) (§3.3.10)");
						}
					}

					// --- I9: DATE 型 DTSTART のときの RRULE BYSECOND/BYMINUTE/BYHOUR ------
					// RFC は「違反時は無視 MUST」(§3.3.10)。つまりデータを弾く筋のものではない。
					// よって本実装は BYSECOND/BYMINUTE/BYHOUR の存在自体は違反として報告しない
					// (将来の RecurrenceExpansion がこれらを無視して展開する)。この方針の明示:
					// I9 のうち「無視 MUST」側はエラーにもワーニングにもしない。
					// I9 の違反として報告するのは下の DURATION 単位側だけ。
				});
			}
		});

		// --- I9: DATE 型 DTSTART のとき DURATION は日/週単位のみ(§3.6.1)-------------
		// DATE(終日)イベントに時分秒の期間は意味論的に不整合。これは「無視 MUST」ではなく
		// データの誤りなので違反として報告する(BY* 側と扱いを分ける。上のコメント参照)。
		if (dtstartProp !== undefined && valueType(dtstartProp) === "DATE" && hasDuration) {
			safe(violations, "I9", "VEVENT", () => {
				const dur = parseDurationValue(rawValue(c, "DURATION")!);
				const hasTime = dur.hours !== undefined || dur.minutes !== undefined || dur.seconds !== undefined;
				if (hasTime) {
					add("I9", "DATE-typed event DURATION must use day/week units only (no H/M/S) (§3.6.1)");
				}
			});
		}

		// --- I7: SEQUENCE は 0 以上の整数(§3.8.7.4)---------------------------------
		const seqRaw = rawValue(c, "SEQUENCE");
		if (seqRaw !== undefined) {
			safe(violations, "I7", "VEVENT", () => {
				const n = parseInteger(seqRaw, "SEQUENCE");
				if (n < 0) add("I7", "SEQUENCE must be a non-negative integer (§3.8.7.4)");
			});
		}

		// --- 配下の VALARM の validate を集約 ---------------------------------------
		for (const alarm of this.alarms()) {
			violations.push(...alarm.validate());
		}

		return violations;
	}
}

// ---------------------------------------------------------------------------
// モジュール内ヘルパー(VEvent / VTodo で共有したいものは helpers.ts に、
// validate 専用の細かいものはここに置く。VTodo からも import する)
// ---------------------------------------------------------------------------

/** 整数パース。SEQUENCE/PRIORITY/PERCENT-COMPLETE 等の「整数値」用。非整数は InvalidValueError。 */
export function parseInteger(raw: string, name: string): number {
	if (!/^[+-]?\d+$/.test(raw)) {
		throw new InvalidValueError("INTEGER", raw, `${name} must be an integer`);
	}
	return Number(raw);
}

/** violations 配列へ1件積む薄いヘルパー(add クロージャの実体)。 */
export function pushViolation(
	violations: InvariantViolation[],
	invariant: ConstructorParameters<typeof InvariantViolation>[0],
	component: string,
	message: string,
): void {
	violations.push(new InvariantViolation(invariant, component, message));
}

/** name のプロパティが2個以上あれば「複数出現は違反」を1件報告する。 */
export function reportDuplicate(
	add: (invariant: ConstructorParameters<typeof InvariantViolation>[0], message: string) => void,
	c: Component,
	name: string,
	invariant: ConstructorParameters<typeof InvariantViolation>[0],
): void {
	const n = allProps(c, name).length;
	if (n > 1) add(invariant, `${name} must occur at most once, found ${n} (§3.6)`);
}

/**
 * values コーデックの throw(InvalidValueError)を catch して違反へ変換する実行ラッパ。
 * validate の中で「壊れた値」に出会ったら、その値の解釈失敗自体を1つの違反として記録する
 * (errors.ts の方針: validate は throw を集める)。InvalidValueError 以外(=想定外バグ)は
 * 握り潰さず再 throw する。
 */
export function safe(
	violations: InvariantViolation[],
	invariant: ConstructorParameters<typeof InvariantViolation>[0],
	component: string,
	fn: () => void,
): void {
	try {
		fn();
	} catch (e) {
		if (e instanceof InvalidValueError) {
			violations.push(new InvariantViolation(invariant, component, `invalid value: ${e.reason}`));
			return;
		}
		throw e;
	}
}
