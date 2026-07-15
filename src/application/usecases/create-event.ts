// =============================================================================
// CreateEvent ユースケース — E-3 スライス S1(MCP からの VEVENT 作成)
// =============================================================================
//
// 【この UC が担う範囲・CreateTodo との対称】
// chat(MCP `create-event` ツール)から VEVENT を新規作成する。UID/DTSTAMP はサーバーが生成し、
// domain/ical/semantics/vevent-write.ts の buildVEventCalendar で VCALENDAR+VEVENT を組み、
// serialize() で ICS 化してから PutCalendarObject を must-not-exist で呼ぶ。CreateTodo が
// buildVTodoCalendar を使うのと完全に対称(独自の保存経路は作らない — DAV PUT の薄いラッパー)。
//
// 【VTODO との違い(意図的な非対称)】
// - due(DTSTART/DUE 同値)ではなく DTSTART(必須)+ DTEND(排他的終端・省略可)。
// - 招待(ATTENDEE/ORGANIZER)・VALARM・occurrence 単位編集はスコープ外(docs/modeling/12 §1)。
// - all-day/timed は start 文字列の形式で決まる("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"+timeZone)。
//   isAllDay の明示フラグは受け取らない(create-todo が due の形式で終日/時刻付きを決めるのと同じ。
//   docs/modeling/12 §2 の isAllDay? は形式で表現できるため UC 入力には持ち込まない — 最終報告で親に返す)。
// =============================================================================

import {
	buildVEventCalendar,
	buildVTimezone,
	ICalendarObject,
	isValidIanaZone,
	localFieldsToEpochMillis,
	parseCalDate,
	serialize,
	toEpochMillis,
	UnsupportedTimeZoneError as DomainUnsupportedTimeZoneError,
	zoneResolverFor,
	type CalDateTime,
	type Component,
	type RecurrenceRule,
	type VEventDateValue,
	type VEventFields,
} from "../../domain/ical";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import {
	buildRecurrenceRule,
	InvalidTimeZoneError,
	RecurrenceCountUntilConflictError,
	RecurrenceWeekdaysRequireWeeklyError,
	UnsupportedTimeZoneError,
	type CreateTodoRecurrenceInput,
} from "./create-todo";
import type { Event } from "./event-dto";
import { eventFromVEvent } from "./event-dto";
import { nowStampFromDate } from "./now-stamp";

// VTIMEZONE 窓の余白(create-todo.ts の WINDOW_MARGIN_MILLIS と同値・同理由)。
const WINDOW_MARGIN_MILLIS = 400 * 24 * 60 * 60 * 1000;

// --- 入力 DTO ---

export interface CreateEventInput {
	owner: PrincipalRef;
	/** SUMMARY(必須)。 */
	title: string;
	/** DESCRIPTION。省略可。 */
	notes?: string;
	/** DTSTART(必須)。"YYYY-MM-DD"(終日)または "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組)。 */
	start: string;
	/** DTEND(排他的終端)。省略可。start と同じ2形態。start より後でなければならない(I3)。 */
	end?: string;
	/** start/end が時刻付きのときの IANA タイムゾーン(必須)。終日のときは無視する(create-todo と同じ制約)。 */
	timeZone?: string;
	/** LOCATION(§3.8.1.7)。空文字は未設定扱い。 */
	location?: string;
	/** URL(§3.8.4.6・URI 値型)。空文字は未設定扱い。 */
	url?: string;
	/** 保存先コレクション ID。省略時は "calendar"(既定 VEVENT コレクション)。 */
	calendarId?: string;
	/** 反復指定(create-todo と同一 shape)。DTSTART をアンカーにする(§3.8.5.3)。 */
	recurrence?: CreateTodoRecurrenceInput;
}

// --- 出力 DTO ---

export interface CreateEventOutput {
	event: Event;
}

// --- エラー型 ---

/** start の形式が2形態("YYYY-MM-DD" / "YYYY-MM-DDTHH:MM:SS")のどちらにも一致しないときのエラー。 */
export class InvalidStartError extends Error {
	readonly kind = "InvalidStartError" as const;
	constructor(readonly start: string) {
		super(
			'start must be "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM:SS" (timed, paired with timeZone). ' +
				`Offset ISO8601 (with "Z" or "+09:00") is not accepted — a TZID cannot be derived from an offset: "${start}"`,
		);
		this.name = "InvalidStartError";
	}
}

/** end の形式が不正なときのエラー(start と同じ2形態を要求)。 */
export class InvalidEndError extends Error {
	readonly kind = "InvalidEndError" as const;
	constructor(readonly end: string) {
		super(`end must be "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM:SS" (timed): "${end}"`);
		this.name = "InvalidEndError";
	}
}

/** 時刻付き start/end なのに timeZone が省略されたときのエラー(暗黙 UTC フォールバック禁止)。 */
export class EventTimeZoneRequiredError extends Error {
	readonly kind = "EventTimeZoneRequiredError" as const;
	constructor() {
		super("start/end is time-of-day; timeZone is required (no implicit UTC fallback)");
		this.name = "EventTimeZoneRequiredError";
	}
}

/**
 * end が start より後でない(end <= start)ときのエラー。§3.8.2.2: DTEND は DTSTART より厳密に
 * 後でなければならない(I3。終日イベントも排他的終端なので end == start の0長は不可)。
 */
export class StartAfterEndError extends Error {
	readonly kind = "StartAfterEndError" as const;
	constructor(readonly start: string, readonly end: string) {
		super(`end must be strictly after start (§3.8.2.2): start="${start}", end="${end}"`);
		this.name = "StartAfterEndError";
	}
}

/** end の値型(DATE/DATE-TIME)が start と一致しないときのエラー(§3.8.2.2 I6: DTEND は DTSTART と値型一致 MUST)。 */
export class StartEndTypeMismatchError extends Error {
	readonly kind = "StartEndTypeMismatchError" as const;
	constructor() {
		super("start and end must have the same value type (both all-day or both timed) (§3.8.2.2)");
		this.name = "StartEndTypeMismatchError";
	}
}

export type CreateEventError =
	| InvalidStartError
	| InvalidEndError
	| EventTimeZoneRequiredError
	| StartAfterEndError
	| StartEndTypeMismatchError
	| InvalidTimeZoneError
	| UnsupportedTimeZoneError
	| RecurrenceCountUntilConflictError
	| RecurrenceWeekdaysRequireWeeklyError
	| PutCalendarObjectError;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

// 「時刻付き start/end のパース結果」。VEventDateValue(vevent-write に渡す形)+ epoch(比較・窓用)+
// dueTimeInfo(recurrence の UNTIL 値型を DTSTART に合わせるための壁時計 + TZID)を束ねる。
interface ParsedInstant {
	value: VEventDateValue;
	epochMillis: number;
	// 時刻付きのときだけ埋まる(終日は undefined = buildRecurrenceRule が DATE アンカーと解釈する)。
	timeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;
}

export class CreateEvent {
	constructor(private readonly putCalendarObject: PutCalendarObject) {}

	async execute(input: CreateEventInput): Promise<CreateEventOutput> {
		// start(必須)を parse。onInvalid で start 用/end 用のエラー種別を分ける。
		const start = this.parseInstant(input.start, input.timeZone, () => new InvalidStartError(input.start));
		let end: ParsedInstant | undefined;
		if (input.end !== undefined) {
			end = this.parseInstant(input.end, input.timeZone, () => new InvalidEndError(input.end!));
			// 値型一致(§3.8.2.2 I6)。片方 DATE・片方 DATE-TIME は不正(iOS も混在させない)。
			if (start.value.type !== end.value.type) {
				throw new StartEndTypeMismatchError();
			}
			// end は start より厳密に後(§3.8.2.2 I3)。
			if (end.epochMillis <= start.epochMillis) {
				throw new StartAfterEndError(input.start, input.end);
			}
		}

		// recurrence(chat 語彙 → RecurrenceRule + 不変条件検証は create-todo と共有)。DTSTART が
		// 常にあるので create-todo のような「recurrence には due 必須」チェックは不要(start が必須)。
		let recurrence: RecurrenceRule | undefined;
		if (input.recurrence !== undefined) {
			recurrence = buildRecurrenceRule(input.recurrence, start.timeInfo);
		}

		// VTIMEZONE: start か end が時刻付き(DATE-TIME)なら生成する。窓は start/end/UNTIL/反復ホライズンを
		// 覆う([min 開始, max 終了 + 3年 or UNTIL] ± 余白)。create-todo.ts と同じ発想で組む。
		let vtimezone: Component | undefined;
		const needsTz = start.value.type === "DATE-TIME" || end?.value.type === "DATE-TIME";
		if (needsTz) {
			// timeZone は parseInstant で検証済み(DATE-TIME を返した時点で isValidIanaZone 通過済み)。
			const tzid = input.timeZone!;
			const lo = Math.min(start.epochMillis, end?.epochMillis ?? start.epochMillis);
			const hi = Math.max(start.epochMillis, end?.epochMillis ?? start.epochMillis);
			const horizonMillis = this.recurrenceHorizonMillis(recurrence, hi);
			try {
				vtimezone = buildVTimezone(tzid, {
					startMillis: lo - WINDOW_MARGIN_MILLIS,
					endMillis: horizonMillis + WINDOW_MARGIN_MILLIS,
				});
			} catch (error) {
				if (error instanceof DomainUnsupportedTimeZoneError) throw new UnsupportedTimeZoneError(tzid);
				throw error;
			}
		}

		const uid = crypto.randomUUID();
		const now = nowStampFromDate(new Date());
		const fields: VEventFields = {
			uid,
			now,
			summary: input.title,
			description: input.notes,
			start: start.value,
			end: end?.value,
			vtimezone,
			location: input.location,
			url: input.url,
			recurrence,
		};
		const component = buildVEventCalendar(fields);
		const ics = serialize(component);

		const collectionId = mkCollectionId(input.calendarId ?? "calendar");
		await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: `${uid}.ics`,
			ics,
			condition: { kind: "must-not-exist" },
		});

		// 保存直後の Event DTO は組み立てた component をレンズ経由で読み直す(create-todo と同じ)。
		const obj = ICalendarObject.fromComponent(component);
		const vevent = obj.events()[0];
		if (vevent === undefined) {
			throw new Error("CreateEvent: internal error — built VEVENT not found after round-trip");
		}
		return { event: eventFromVEvent(vevent, zoneResolverFor(obj), input.timeZone ?? "UTC") };
	}

	/**
	 * start/end 文字列を VEventDateValue + epoch + timeInfo に解析する。
	 * 形式不一致は onInvalid()(start/end で種別を分ける)を throw。時刻付きは timeZone 必須・
	 * 暗黙 UTC 禁止・不正 IANA は InvalidTimeZoneError(create-todo の due 解析と同じ規律)。
	 */
	private parseInstant(raw: string, timeZone: string | undefined, onInvalid: () => Error): ParsedInstant {
		if (DATE_ONLY_RE.test(raw)) {
			const dateRaw = raw.replace(/-/g, ""); // YYYYMMDD(§3.3.4)。
			const epochMillis = toEpochMillis({ kind: "utc", ...calDateStartFields(dateRaw) });
			return { value: { type: "DATE", raw: dateRaw }, epochMillis, timeInfo: undefined };
		}
		const m = DATE_TIME_LOCAL_RE.exec(raw);
		if (m === null) throw onInvalid();
		if (timeZone === undefined) throw new EventTimeZoneRequiredError();
		if (!isValidIanaZone(timeZone)) throw new InvalidTimeZoneError(timeZone);
		const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
		const fields = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) };
		const epochMillis = localFieldsToEpochMillis(fields, timeZone);
		return {
			value: { type: "DATE-TIME", raw: `${y}${mo}${d}T${h}${mi}${s}`, tzid: timeZone },
			epochMillis,
			timeInfo: { hour: fields.hour, minute: fields.minute, second: fields.second, timeZone },
		};
	}

	// 反復ホライズン: recurrence に UNTIL(date-time)があればその瞬間、無ければ endHint + 3年
	// (create-todo.ts の同名ロジックと同値)。
	private recurrenceHorizonMillis(recurrence: RecurrenceRule | undefined, endHintMillis: number): number {
		if (recurrence?.until !== undefined && recurrence.until.type === "date-time") {
			const dt = recurrence.until.dateTime;
			return dt.kind === "utc" ? toEpochMillis(dt) : localFieldsToEpochMillis(dt, "UTC");
		}
		const horizon = new Date(endHintMillis);
		horizon.setUTCFullYear(horizon.getUTCFullYear() + 3);
		return horizon.getTime();
	}
}

// YYYYMMDD → CalDateTime(kind:"utc")の年月日フィールド(時刻 0)。終日 start/end の start-of-day
// UTC を epoch にするための素材(create-todo.ts が calDateStartEpochMillis を使うのと同じ意図だが、
// parseCalDate → 変換の1経路に揃えるためここで年月日を取り出す)。
function calDateStartFields(yyyymmdd: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const cd = parseCalDate(yyyymmdd);
	return { year: cd.year, month: cd.month, day: cd.day, hour: 0, minute: 0, second: 0 };
}
