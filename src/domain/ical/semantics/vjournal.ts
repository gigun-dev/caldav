// =============================================================================
// VJournal — RFC 5545 §3.6.3 VJOURNAL コンポーネントのレンズ
// =============================================================================
//
// 【方向性 J: agentic な日誌の本丸】
// 09 §4a で起票した「メール/タスク統合の中核」。VJOURNAL は「ある日付に紐づく記述的な
// テキストのまとまり」で、DTEND/DURATION/DUE を持たない(§3.6.3 の jourprop に無い —
// 「時間を占有しない」コンポーネントだから)。RELATED-TO で VTODO/VEVENT や他の VJOURNAL に
// 紐付けられる点が本タスクの本丸(CLAUDE.md 長期ビジョン①「agentic なタスク管理の基盤」)。
//
// 【VTodo レンズを写経した理由】
// jourprop は VTODO の todoprop とかなり重なる(UID/DTSTAMP 必須、DTSTART 任意、STATUS、
// SEQUENCE、RRULE 等)。vtodo.ts の「fromComponent ガード + raw + アクセサ + validate」の
// 型をほぼそのまま流用し、jourprop に無いもの(DUE/DURATION/PERCENT-COMPLETE/PRIORITY/
// COMPLETED/VALARM)は作らない。逆に jourprop 固有のもの(DESCRIPTION 複数可・RELATED-TO)
// は新設する。
//
// 【DESCRIPTION が複数可な点(VEVENT/VTODO との最大の違い)】
// §3.8.1.5 の descprop は VEVENT/VTODO では「MUST NOT occur more than once」だが、
// VJOURNAL の jourprop では明示的に「MAY occur more than once」側(comment/description/
// rdate 等の複数可グループ)に分類されている。これは VJOURNAL が「1件のテキストノート」
// ではなく「複数の記述の集まり」を表現できる設計だからで(§3.6.3 Description の
// "one or more descriptive text notes")、単一 description ゲッターにすると2件目以降を
// 握り潰してロスレス往復の精神(CLAUDE.md)に反する。よって単数形の `.description` では
// なく複数形の `.descriptions()` にして、all を返す。
// =============================================================================

import type { Component } from "../structure/types";
import {
	type CalDate,
	type CalDateTime,
	parseRecurrenceRule,
	type RecurrenceRule,
} from "../values";
import { InvariantViolation } from "./errors";
import {
	allProps,
	firstProp,
	isCalDateTime,
	paramFirst,
	parseDateOrDateTime,
	rawValue,
} from "./helpers";
import { parseInteger, reportDuplicate, safe, validateRRule } from "./vevent";

export class VJournal {
	private constructor(private readonly component: Component) {}

	static fromComponent(c: Component): VJournal {
		if (c.name !== "VJOURNAL") {
			throw new Error(`VJournal.fromComponent: expected VJOURNAL component, got ${c.name}`);
		}
		return new VJournal(c);
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

	/** DTSTART(§3.8.2.4)。VJOURNAL では任意(jourprop の OPTIONAL 群)。
	 *  「この日誌がどのカレンダー日付に紐づくか」を表す。DATE 型が一般的だが DATE-TIME も可
	 *  (§3.6.3 Description: "Generally, it will have a DATE value data type, but it can
	 *  also be used to specify a DATE-TIME value data type.")。 */
	get dtstart(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "DTSTART");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	get summary(): string | undefined {
		return rawValue(this.component, "SUMMARY");
	}

	/** STATUS(§3.8.1.11)。VJOURNAL の許容値は DRAFT|FINAL|CANCELLED だが、VTodo と同じく
	 *  列挙値の妥当性検証はしない(このタスクのスコープ外。大文字化のみ)。 */
	get status(): string | undefined {
		return rawValue(this.component, "STATUS")?.toUpperCase();
	}

	get sequence(): number | undefined {
		const raw = rawValue(this.component, "SEQUENCE");
		return raw !== undefined ? parseInteger(raw, "SEQUENCE") : undefined;
	}

	/** RRULE(§3.8.5.3)。jourprop では "SHOULD NOT occur more than once" 側(VEVENT/VTODO と
	 *  同じ扱い)。反復 VJOURNAL の展開自体は J-4 のスコープ(occurrence-bounds.ts 参照)。 */
	get rrule(): RecurrenceRule | undefined {
		const raw = rawValue(this.component, "RRULE");
		return raw !== undefined ? parseRecurrenceRule(raw) : undefined;
	}

	/** RECURRENCE-ID(§3.8.4.4)。VEvent と同じ意味論(マスターの1回を指す override)。 */
	get recurrenceId(): CalDate | CalDateTime | undefined {
		const p = firstProp(this.component, "RECURRENCE-ID");
		return p !== undefined ? parseDateOrDateTime(p) : undefined;
	}

	/**
	 * DESCRIPTION(§3.8.1.5)。VJOURNAL では複数可(冒頭コメント参照)。全件を出現順で返す。
	 * VEVENT/VTODO の単一 `.description` アクセサとはこの点で意図的に非対称。
	 */
	descriptions(): string[] {
		return allProps(this.component, "DESCRIPTION").map((p) => p.value);
	}

	/**
	 * RELATED-TO(§3.8.4.5)。J の本丸 — VJOURNAL を VTODO/VEVENT や他の VJOURNAL へ
	 * 紐付けるためのプロパティ。複数可。RELTYPE パラメータ(§3.2.15)は既定 PARENT
	 * (未指定時のデフォルト値をここで補って返す — 呼び出し側が毎回 "未指定なら PARENT"
	 * を書かなくて済むように、レンズの責務として解決しておく)。
	 */
	relatedTo(): { value: string; reltype: string }[] {
		return allProps(this.component, "RELATED-TO").map((p) => ({
			value: p.value,
			reltype: paramFirst(p, "RELTYPE")?.toUpperCase() ?? "PARENT",
		}));
	}

	/** CATEGORIES(§3.8.1.2)。複数可(1プロパティ内カンマ区切り、かつプロパティ自体も複数出現しうる)。
	 *  ここでは「プロパティが複数あればそれぞれの生値」を返す(カンマ分割は上位の関心事)。 */
	categories(): string[] {
		return allProps(this.component, "CATEGORIES").map((p) => p.value);
	}

	// DTEND/DURATION/DUE/VALARM は jourprop に無いため意図的に作らない(冒頭コメント参照)。
	// 「VJOURNAL は時間を占有しない(§3.6.3: "does not take up time on a calendar")」という
	// RFC の意味論をレンズの形そのもので表現する — 誤って DTEND 的な期間アクセサを生やすと
	// 「VJOURNAL にも期間がある」という誤解を型で許してしまう。

	// ---------------------------------------------------------------------------
	// validate: I2(UID/DTSTAMP)+ カーディナリティ + I5/I6(RRULE)+ I6(RECURRENCE-ID)
	// VTodo/VEvent と違い I3/I4(DTEND/DUE 系)は存在しない(jourprop に無いので検証しようがない)。
	// STATUS の値列挙検証もしない(VTodo と同粒度、スコープ外)。
	// ---------------------------------------------------------------------------
	validate(): InvariantViolation[] {
		const c = this.component;
		const violations: InvariantViolation[] = [];
		const add = (invariant: ConstructorParameters<typeof InvariantViolation>[0], message: string): void => {
			violations.push(new InvariantViolation(invariant, "VJOURNAL", message));
		};

		// --- カーディナリティ(jourprop の「MUST NOT occur more than once」群)-------------
		// UID/DTSTAMP は I2。それ以外(DTSTART/RRULE/CLASS/CREATED/LAST-MODIFIED/
		// RECURRENCE-ID/SEQUENCE/STATUS/SUMMARY/URL)は §3.6.3 の jourprop 定義に忠実に
		// 「1回まで」グループとして列挙する(DESCRIPTION/RELATED-TO/CATEGORIES/ATTACH/
		// ATTENDEE/COMMENT/CONTACT/EXDATE/RDATE/RSTATUS は複数可なので対象外)。
		// I 番号は VEvent/VTodo の踏襲(DTSTART→I3 相当の枠が無いので I4 系に寄せず、
		// jourprop の性質が VTodo に近い DTSTART 系のカーディナリティとして扱う)。
		reportDuplicate(add, c, "UID", "I2");
		reportDuplicate(add, c, "DTSTAMP", "I2");
		reportDuplicate(add, c, "DTSTART", "I4");
		reportDuplicate(add, c, "RECURRENCE-ID", "I6");
		reportDuplicate(add, c, "SEQUENCE", "I7");

		// --- I2: UID + DTSTAMP 必須。DTSTAMP は UTC 形式 MUST(VTodo/VEvent と同一実装)-----
		if (firstProp(c, "UID") === undefined) add("I2", "UID is required (§3.6.3)");
		const dtstampProp = firstProp(c, "DTSTAMP");
		if (dtstampProp === undefined) {
			add("I2", "DTSTAMP is required (§3.6.3)");
		} else {
			safe(violations, "I2", "VJOURNAL", () => {
				const v = parseDateOrDateTime(dtstampProp);
				if (!isCalDateTime(v) || v.kind !== "utc") {
					add("I2", "DTSTAMP must be a UTC date-time (ending in 'Z') (§3.8.7.2)");
				}
			});
		}

		// --- I6 相当: RECURRENCE-ID の DTSTART との整合(VEvent と同粒度: 値型一致 + floating iff floating)---
		// VJournal は DTEND/DUE が無いので VEvent/VTodo の「値型一致 MUST」比較対象を持たないが、
		// RECURRENCE-ID の §3.8.4.4 MUST(値型一致 + floating iff floating)は DTSTART さえあれば
		// 独立に検証できる。VEvent.validate() の同ロジックと同じ精密化(2026-07-09 原文再照合)を適用する。
		const dtstartProp = firstProp(c, "DTSTART");
		const ridProp = firstProp(c, "RECURRENCE-ID");
		if (dtstartProp !== undefined && ridProp !== undefined) {
			safe(violations, "I6", "VJOURNAL", () => {
				const start = parseDateOrDateTime(dtstartProp);
				const rid = parseDateOrDateTime(ridProp);
				const startDt = isCalDateTime(start);
				const ridDt = isCalDateTime(rid);
				if (startDt !== ridDt) {
					add("I6", "RECURRENCE-ID value type must match DTSTART (DATE vs DATE-TIME) (§3.8.4.4)");
				} else if (startDt && ridDt) {
					const startFloating = start.kind === "floating";
					const ridFloating = rid.kind === "floating";
					if (startFloating !== ridFloating) {
						add("I6", "RECURRENCE-ID must be floating (local time) if and only if DTSTART is floating (§3.8.4.4)");
					}
				}
			});
		}

		// --- I5/I6: RRULE の UNTIL/COUNT 排他・UNTIL 値型一致(VEvent/VTodo と共通のロジックを流用)---
		validateRRule(violations, "VJOURNAL", c);

		return violations;
	}
}
