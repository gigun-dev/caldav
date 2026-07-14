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
	allProps,
	compareDateValue,
	firstProp,
	isCalDateTime,
	isChronologicallyComparable,
	paramFirst,
	parseDateOrDateTime,
	rawValue,
	relatedToOf,
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

	/**
	 * LOCATION(§3.8.1.7)。TEXT 値型。summary と同じ流儀(raw のまま返す。エスケープ解除は
	 * 呼び出し側 — task-dto.ts の decodeText でまとめて行う。semantics 層のレンズは
	 * 一貫して「生の Property.value をそのまま返す」方針なのでここでも踏襲する)。
	 *
	 * 【2026-07-14 E-2 追記: LOCATION は VTODO 標準プロパティだが「使われ方」に注意】
	 * iOS リマインダーの「指定した場所で通知」機能(位置情報リマインダー)は CloudKit 独自の
	 * 仕組みで実装されており、CalDAV 経由では同期されない見込み(docs/modeling/06 §D2/D3 で
	 * 確認した「iOS 固有機能で CalDAV に写らない」天井群と同種)。したがって LOCATION が
	 * 実際に立つのは主に他の CalDAV クライアント経由、または本サーバーの create-todo 等
	 * 自前の書き込み経路からになる想定。VTODO 自体は §3.6.2 で LOCATION を許可しているので
	 * レンズとしては素直に読めるようにしておく(iOS の制約とプロトコルの仕様は別レイヤーの話)。
	 */
	get location(): string | undefined {
		return rawValue(this.component, "LOCATION");
	}

	/**
	 * STATUS(§3.8.1.11)。列挙値は case-insensitive → 大文字化して返す。
	 *
	 * 【J-3 追記】RFC 5545 の4値(NEEDS-ACTION/COMPLETED/IN-PROCESS/CANCELLED)に加えて、
	 * draft-ietf-calext-ical-tasks-17 §11.2(2025-12 rev、"Redefined STATUS Property")が
	 * VTODO の STATUS に PENDING・FAILED の2値を追加している(原文照合済み: §15.3 Status
	 * Value registry にも両値が登録されている)。この既存アクセサは大文字化した生値をそのまま
	 * 返すだけなので、追加された2値も検証なしで既に受け取れる — union 型にしていないのは
	 * 「draft の値名変更・追加でアクセサ表面が壊れない」ことを優先する CLAUDE.md の追従リスク
	 * 最小化方針どおり(コード変更は不要、この JSDoc 追記のみが J-3 の対応)。
	 */
	get status(): string | undefined {
		return rawValue(this.component, "STATUS")?.toUpperCase();
	}

	/**
	 * SUBSTATE(draft-ietf-calext-ical-tasks-17 §10.3、rev-17 / 2025-12)。
	 *
	 * 【原文照合で確定した構造(重要: VTODO 直下のプロパティではない)】
	 * §10.3 の Conformance は「このプロパティは VSTATUS コンポーネントに指定できる」であり、
	 * VTODO の todoprop には含まれない。SUBSTATE は VTODO 配下の VSTATUS サブコンポーネント
	 * (§12.1、"This component can be specified multiple times in any calendar component")
	 * の中のプロパティとして現れる。よってこのアクセサは VTODO 自身のプロパティを見るのではなく、
	 * 最初の VSTATUS サブコンポーネントを読む(複数 VSTATUS が付きうるが、J-3 は「先頭の
	 * ステータスが読める」ところまでを先取りのスコープとする — 履歴全件の集約は将来の課題)。
	 *
	 * 値型は TEXT。ABNF 上は OK/ERROR/SUSPENDED が例示された iana-token 拡張可能な列挙だが、
	 * union 型にはしない(draft の値追加で壊れないように。string で大文字化のみ)。
	 */
	get substate(): string | undefined {
		const status = subComponents(this.component, "VSTATUS")[0];
		if (status === undefined) return undefined;
		return rawValue(status, "SUBSTATE")?.toUpperCase();
	}

	/**
	 * REASON(draft-ietf-calext-ical-tasks-17 §10.2、rev-17 / 2025-12)。
	 *
	 * 【原文照合で確定した構造】SUBSTATE と同じく、Conformance は「VSTATUS と PARTICIPANT
	 * コンポーネントに指定できる」であり、VTODO 直下ではない。ここでは VSTATUS 側(SUBSTATE と
	 * 同じ最初のサブコンポーネント)を読む。PARTICIPANT(RFC 9073)配下の REASON は対象外
	 * (J-3 のスコープは VTODO/VJOURNAL のタスク状態モデルであり、参加者ステータスは含まない)。
	 *
	 * 値型は URI(§10.2 "Value Type: URI" — TEXT ではない。設計メモ段階では TEXT を仮定して
	 * いたが原文で訂正)。ただしこのアクセサはロスレスの生文字列をそのまま返すだけで URI
	 * パースはしない(検証なし方針・CLAUDE.md)。
	 */
	get reason(): string | undefined {
		const status = subComponents(this.component, "VSTATUS")[0];
		if (status === undefined) return undefined;
		return rawValue(status, "REASON");
	}

	/**
	 * ESTIMATED-DURATION(draft-ietf-calext-ical-tasks-17 §10.1、rev-17 / 2025-12)。
	 *
	 * 原文照合: Conformance は「VTODO に指定できる」(VSTATUS ではなく VTODO 直下)。
	 * Value Type は DURATION(§3.3.6 と同じ構文、正の期間のみを想定)なので、既存の
	 * parseDurationValue(duration アクセサと同じコーデック)をそのまま使う。
	 */
	get estimatedDuration(): DurationValue | undefined {
		const raw = rawValue(this.component, "ESTIMATED-DURATION");
		return raw !== undefined ? parseDurationValue(raw) : undefined;
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

	/**
	 * RELATED-TO(§3.8.4.5、RFC 9253 §9.1 で拡張)。VJournal.relatedTo()(J-1)と同じ意味論。
	 * 実装は helpers.ts の relatedToOf() に共通化(J-3。両レンズで重複実装しない)。
	 */
	relatedTo(): { value: string; reltype: string }[] {
		return relatedToOf(this.component);
	}

	/**
	 * DEPENDS-ON(RFC 9253 §5・§9.1)。
	 *
	 * 【原文照合で確定した最重要点: 独立したプロパティではない】
	 * "DEPENDS-ON" は RFC 9253 §5 で定義される RELATED-TO の RELTYPE 値の1つであって、
	 * `DEPENDS-ON:` という別プロパティ名は存在しない(§9.1 の RELATED-TO 再定義 ABNF にも
	 * DEPENDS-ON という語は出てこない — reltypeparam の値としてのみ現れる)。つまり
	 * `RELATED-TO;RELTYPE=DEPENDS-ON:<value>` の形。設計メモ段階では独立プロパティを仮定して
	 * いたが誤りだったので、実装は RELATED-TO 全体から RELTYPE=DEPENDS-ON のものだけを
	 * 抽出するフィルタにする。
	 *
	 * 値の型: §9.1 "Value Type: URI, UID, or TEXT"。既定(VALUE 未指定)は UID
	 * ("By default ... consists of ... UID")。ここでは値型の解決はせず生文字列を返す
	 * (検証なし方針)。
	 *
	 * GAP パラメータ(§6.2): "This parameter MAY be specified on the RELATED-TO property"
	 * — DEPENDS-ON 専用ではなく RELATED-TO 全般に付けられるパラメータだが、DEPENDS-ON
	 * (先行タスクの遅れ/前倒しを表現する用途)で使われることを想定して戻り値に含める。
	 * 値型は dur-value(RFC 5545 §3.3.6 の DURATION 構文)なので parseDurationValue を使う。
	 * 符号あり(正=lag、負=lead)。
	 */
	dependsOn(): { value: string; gap?: DurationValue }[] {
		return allProps(this.component, "RELATED-TO")
			.filter((p) => paramFirst(p, "RELTYPE")?.toUpperCase() === "DEPENDS-ON")
			.map((p) => {
				const gapRaw = paramFirst(p, "GAP");
				return {
					value: p.value,
					gap: gapRaw !== undefined ? parseDurationValue(gapRaw) : undefined,
				};
			});
	}

	/**
	 * REFID(RFC 9253 §8.3)。
	 *
	 * 原文照合: Conformance は「任意の iCalendar コンポーネントに 0 回以上指定できる」
	 * ("can be specified zero or more times")— 1プロパティ内に複数値ではなく、
	 * プロパティ自体が複数回出現しうる形(REFID:a と REFID:b を別プロパティとして持てる)。
	 * よって allProps で全件集める(1プロパティ複数値のパース、ではない)。値型は TEXT。
	 */
	refids(): string[] {
		return allProps(this.component, "REFID").map((p) => p.value);
	}

	// CONCEPT・LINK(RFC 9253 §8.1・§8.2)は J-3 では型付きアクセサを先取りしない
	// (Fable 設計メモの判断: agent 状態モデルとの結びつきが薄く、使う入口 MCP の要件が
	// まだ無い)。生値保持による parse→serialize のロスレス往復は既に無条件で保証されて
	// いるので、"読めない・消える" ことはない。型付きアクセサが要る場面が来たら追加する。

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
