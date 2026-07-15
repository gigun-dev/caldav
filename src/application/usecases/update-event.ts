// =============================================================================
// UpdateEvent ユースケース — 既存 VEVENT の部分更新(E-3 スライス S1)
// =============================================================================
//
// 【UpdateTodo と対称】lossless read→patch→PUT(must-match)。lookupEvent で対象 VEVENT を含む
// リソースを読み(内部 read で ETag も取れる)、vevent-patch.ts の patchVEventFields で指定
// フィールドだけを書き換え、VCALENDAR.components の対象 VEVENT だけを差し替えて serialize → PUT。
// VTIMEZONE の同梱/孤立掃除も UpdateTodo と同じ責務分担(patch は VEVENT 内だけ触り、VCALENDAR
// レベルの VTIMEZONE 操作はこの UC が行う)。
//
// 【UpdateTodo との違い(スコープ)】
// - status(完了/再開)は無い(イベントに完了は無い — docs/modeling/12 §4)。
// - 通知(alarms)は開始相対 VALARM の三値 patch(S1.5)。他クライアント由来の VALARM は温存し、
//   相対トリガーゆえ start 変更で自動追従する(サーバーはトリガーを shift しない)。
// - start は除去できない(§3.6.1: DTSTART REQUIRED)。end は除去できる(DTEND OPTIONAL)。
// =============================================================================

import {
	buildVTimezone,
	ICalendarObject,
	isValidIanaZone,
	localFieldsToEpochMillis,
	serialize,
	UnsupportedTimeZoneError as DomainUnsupportedTimeZoneError,
	zoneResolverFor,
	type Component,
	type RecurrenceRule,
} from "../../domain/ical";
import {
	patchVEventFields,
	pruneUnreferencedVTimezones,
	type VEventEndPatch,
	type VEventStartPatch,
} from "../../domain/ical/semantics";
import { stampUpdate } from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { calDateStartEpochMillis, calDateTimeToEpochMillis } from "../../domain/ical/timezone";
import { parseCalDate, type CalDate, type CalDateTime } from "../../domain/ical/values";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupEvent, EventNotFoundError, type LookedUpEvent } from "./event-lookup";
import {
	buildRecurrenceRule,
	InvalidTimeZoneError,
	RecurrenceCountUntilConflictError,
	RecurrenceWeekdaysRequireWeeklyError,
	UnsupportedTimeZoneError,
	type CreateTodoRecurrenceInput,
} from "./create-todo";
import {
	EventTimeZoneRequiredError,
	InvalidAlarmsError,
	InvalidEndError,
	InvalidStartError,
	InvalidTravelMinutesError,
	StartAfterEndError,
	StartEndTypeMismatchError,
	validateAndBuildAlarms,
	validateTravelMinutes,
} from "./create-event";
import { nowStampFromDate } from "./now-stamp";
import { eventFromVEvent, type Event } from "./event-dto";
import type { CalendarObjectResourceRepository } from "../ports";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const WINDOW_MARGIN_MILLIS = 400 * 24 * 60 * 60 * 1000;

function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

// --- 入力 DTO ---

export interface UpdateEventInput {
	owner: PrincipalRef;
	/** 更新対象の VEVENT UID。 */
	eventId: string;
	/** 保存先コレクション ID。省略時は "calendar"。 */
	calendarId?: string;
	/** SUMMARY。省略時は変更しない。 */
	title?: string;
	/** DESCRIPTION。省略時は変更しない。 */
	notes?: string;
	/**
	 * DTSTART。省略=変更しない / "YYYY-MM-DD"(終日)/ "YYYY-MM-DDTHH:MM:SS"(時刻付き・timeZone と組)。
	 * start は除去できない(§3.6.1: DTSTART REQUIRED)ので null は取らない。
	 */
	start?: string;
	/**
	 * DTEND。省略=変更しない / null=DTEND を除去(開始のみのイベントにする)/ 文字列=設定(start と同2形態)。
	 */
	end?: string | null;
	/** 時刻付き start/end のときの IANA タイムゾーン(必須)。終日/除去/省略のときは無視する。 */
	timeZone?: string;
	/** LOCATION。省略=変更しない / null=除去 / 文字列=差し替え。 */
	location?: string | null;
	/** URL(§3.8.4.6)。location と同じ三値: 省略=変更しない / null=除去 / 文字列=差し替え。 */
	url?: string | null;
	/**
	 * 反復の設定/変更/除去(create-todo と同一 shape。undefined=据え置き / null=除去 / obj=全置換)。
	 * アンカーは DTSTART(常に存在するので RecurrenceRequiresDueError 相当は無い)。
	 */
	recurrence?: CreateTodoRecurrenceInput | null;
	/**
	 * 通知(開始相対 VALARM)。三値: 省略=変更しない / null=全除去 / 配列=全置換(minutesBefore の列・
	 * 最大2件・重複/負値不可)。全置換は「開始相対 VALARM だけ」を差し替え、他クライアント由来の VALARM
	 * (絶対・終了相対・位置)は温存する(vevent-patch.ts の applyAlarmsPatch)。start を変えても相対
	 * トリガーは自動追従する(VALARM を触らずに済む)。
	 */
	alarms?: number[] | null;
	/** 移動時間(X-APPLE-TRAVEL-DURATION・分)。三値: 省略=変更しない / null=除去 / 正整数=設定。 */
	travelMinutes?: number | null;
}

// --- 出力 DTO ---

export interface UpdateEventOutput {
	event: Event;
	/** 更新「前」の Event スナップショット(差分レンズ用。UpdateTodoOutput.before と同じ役割)。 */
	before?: Event;
}

export type UpdateEventError =
	| InvalidStartError
	| InvalidEndError
	| EventTimeZoneRequiredError
	| StartAfterEndError
	| StartEndTypeMismatchError
	| InvalidTimeZoneError
	| UnsupportedTimeZoneError
	| RecurrenceCountUntilConflictError
	| RecurrenceWeekdaysRequireWeeklyError
	| InvalidAlarmsError
	| InvalidTravelMinutesError
	| EventNotFoundError
	| PutCalendarObjectError;

// start/end の parse 結果(patch 指示 + epoch + timeInfo + 時刻付きなら VTIMEZONE)。
interface ParsedStart {
	patch: VEventStartPatch;
	epochMillis: number;
	timeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;
	vtimezone: Component | undefined;
}
interface ParsedEnd {
	patch: VEventEndPatch;
	// remove のときは epoch/type 無し。
	epochMillis?: number;
	valueType?: "DATE" | "DATE-TIME";
	vtimezone?: Component;
}

export class UpdateEvent {
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: UpdateEventInput): Promise<UpdateEventOutput> {
		// start/end の parse(format/timeZone/DST エラーは lookup 前に投げる = 安価な失敗)。
		const parsedStart = input.start !== undefined ? this.parseStart(input.start, input.timeZone) : undefined;
		const parsedEnd = input.end !== undefined ? this.parseEnd(input.end, input.timeZone) : undefined;

		// 通知(alarms)+ 移動時間(travelMinutes)の三値を patch 指示へ解決(lookup 前 = 安価な失敗)。
		//   alarms: undefined=触らない / null=全除去 / 配列=検証して {minutesBefore,uid} 列へ。
		//   travelMinutes: undefined=触らない / null=除去 / 正整数=検証。
		const alarmsPatch: ReadonlyArray<{ minutesBefore: number; uid: string }> | null | undefined =
			input.alarms === undefined ? undefined : input.alarms === null ? null : validateAndBuildAlarms(input.alarms);
		if (input.travelMinutes !== undefined && input.travelMinutes !== null) validateTravelMinutes(input.travelMinutes);

		const collectionId = mkCollectionId(input.calendarId ?? "calendar");
		const looked = await lookupEvent(this.resourceRepo, input.owner, collectionId, input.eventId);
		if (looked === null) {
			throw new EventNotFoundError(input.eventId);
		}

		const zoneOf = zoneResolverFor(looked.resource.payload);

		// --- start/end の整合(値型一致 §3.8.2.2 I6 + end > start §3.8.2.2 I3)を、既存値も考慮して検証 ---
		this.validateStartEnd(input, parsedStart, parsedEnd, looked, zoneOf);

		// 更新前スナップショット(before)。lookupEvent が読んだ更新前レンズから作る(追加往復なし)。
		const before = eventFromVEvent(looked.vevent, zoneOf, input.timeZone ?? "UTC");

		// recurrence patch(据え置き/除去/全置換)。全置換は新 or 既存 DTSTART をアンカーに UNTIL 値型を揃える。
		const recurrencePatch = this.buildRecurrencePatch(input, parsedStart, looked, zoneOf);

		let patched: Component = patchVEventFields(looked.vevent.raw, {
			summary: input.title,
			description: input.notes,
			location: input.location,
			url: input.url,
			start: parsedStart?.patch,
			end: parsedEnd?.patch,
			recurrence: recurrencePatch,
			alarms: alarmsPatch,
			travelMinutes: input.travelMinutes,
		});

		patched = stampUpdate(patched, nowStampFromDate(new Date()));

		// VCALENDAR.components の対象 VEVENT だけを差し替える(他サブコンポーネントは保持)。
		const vcalendar = looked.resource.payload.raw;
		let components = vcalendar.components.map((c) => (c === looked.vevent.raw ? patched : c));

		// 時刻付き start/end に変更したときの VTIMEZONE 同梱(重複回避。UpdateTodo と同じ責務分担)。
		for (const vtz of [parsedStart?.vtimezone, parsedEnd?.vtimezone]) {
			if (vtz === undefined) continue;
			const newTzid = vtz.properties.find((p) => p.name === "TZID")?.value;
			const alreadyPresent = components.some(
				(c) => c.name === "VTIMEZONE" && c.properties.find((p) => p.name === "TZID")?.value === newTzid,
			);
			if (!alreadyPresent) components = [...components, vtz];
		}

		// 孤立 VTIMEZONE の掃除(patch 経路限定。pruneUnreferencedVTimezones の JSDoc 参照)。
		components = [...pruneUnreferencedVTimezones(components)];

		const newVcalendar: Component = { ...vcalendar, components };
		const ics = serialize(newVcalendar);

		await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: looked.resourceUri,
			ics,
			condition: { kind: "must-match", etag: looked.etag.hex },
		});

		const obj = ICalendarObject.fromComponent(newVcalendar);
		const vevent = obj.events().find((e) => e.uid === input.eventId && e.recurrenceId === undefined) ?? obj.events()[0];
		if (vevent === undefined) {
			throw new Error("UpdateEvent: internal error — patched VEVENT not found after round-trip");
		}
		return { event: eventFromVEvent(vevent, zoneResolverFor(obj), input.timeZone ?? "UTC"), before };
	}

	/** start/end の整合検証(既存値も考慮)。 */
	private validateStartEnd(
		input: UpdateEventInput,
		parsedStart: ParsedStart | undefined,
		parsedEnd: ParsedEnd | undefined,
		looked: LookedUpEvent,
		zoneOf: (tzid: string) => string,
	): void {
		// 実効 start(新 or 既存)の値型・epoch。既存 DTSTART は §3.6.1 で必ずある想定。
		const effStartType: "DATE" | "DATE-TIME" | undefined =
			parsedStart !== undefined
				? parsedStart.patch.kind === "date"
					? "DATE"
					: "DATE-TIME"
				: looked.vevent.dtstart !== undefined
					? isCalDateTime(looked.vevent.dtstart)
						? "DATE-TIME"
						: "DATE"
					: undefined;
		const effStartEpoch =
			parsedStart !== undefined
				? parsedStart.epochMillis
				: looked.vevent.dtstart !== undefined
					? this.instanceEpoch(looked.vevent.dtstart, zoneOf)
					: undefined;

		// 実効 end。end===null(除去)なら end 無し。end 未指定なら既存 DTEND。
		let effEndType: "DATE" | "DATE-TIME" | undefined;
		let effEndEpoch: number | undefined;
		if (input.end === null) {
			// 除去 = end 無し(整合検証は不要)。
			return;
		} else if (parsedEnd !== undefined) {
			effEndType = parsedEnd.valueType;
			effEndEpoch = parsedEnd.epochMillis;
		} else if (looked.vevent.dtend !== undefined) {
			effEndType = isCalDateTime(looked.vevent.dtend) ? "DATE-TIME" : "DATE";
			effEndEpoch = this.instanceEpoch(looked.vevent.dtend, zoneOf);
		}

		if (effEndType === undefined || effEndEpoch === undefined) return; // end 無し = 検証不要。
		if (effStartType !== undefined && effStartType !== effEndType) {
			throw new StartEndTypeMismatchError();
		}
		if (effStartEpoch !== undefined && effEndEpoch <= effStartEpoch) {
			throw new StartAfterEndError(input.start ?? "(unchanged)", (input.end as string) ?? "(unchanged)");
		}
	}

	/** 既存 DTSTART/DTEND インスタンス(CalDate|CalDateTime)を epoch にする(floating/DATE は UTC 規約)。 */
	private instanceEpoch(instance: CalDate | CalDateTime, zoneOf: (tzid: string) => string): number {
		return isCalDateTime(instance)
			? calDateTimeToEpochMillis(instance, { zoneOf, floatingTimeZone: "UTC" })
			: calDateStartEpochMillis(instance, "UTC");
	}

	/** recurrence patch(据え置き/除去/全置換)を組み立てる(UpdateTodo.buildRecurrencePatch と対称)。 */
	private buildRecurrencePatch(
		input: UpdateEventInput,
		parsedStart: ParsedStart | undefined,
		looked: LookedUpEvent,
		zoneOf: (tzid: string) => string,
	): RecurrenceRule | null | undefined {
		if (input.recurrence === undefined) return undefined;
		if (input.recurrence === null) return null;

		// アンカーは新 start(あれば)> 既存 DTSTART。DTSTART は常にあるので anchor 不在にはならない。
		let anchorTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;
		if (parsedStart !== undefined) {
			anchorTimeInfo = parsedStart.timeInfo; // undefined(終日)なら DATE アンカー。
		} else {
			const existing = looked.vevent.dtstart;
			anchorTimeInfo = existing !== undefined ? this.timeInfoFromInstance(existing, zoneOf) : undefined;
		}
		return buildRecurrenceRule(input.recurrence, anchorTimeInfo);
	}

	/** 既存 DTSTART インスタンスから buildRecurrenceRule 用の壁時計 + TZID を導く(UpdateTodo と対称)。 */
	private timeInfoFromInstance(
		instance: CalDate | CalDateTime,
		zoneOf: (tzid: string) => string,
	): { hour: number; minute: number; second: number; timeZone: string } | undefined {
		if (!isCalDateTime(instance)) return undefined;
		const timeZone = instance.kind === "zoned" ? zoneOf(instance.tzid) : "UTC";
		return { hour: instance.hour, minute: instance.minute, second: instance.second, timeZone };
	}

	/** input.start を VEventStartPatch + epoch + timeInfo +(時刻付きなら)VTIMEZONE に解析する。 */
	private parseStart(raw: string, timeZone: string | undefined): ParsedStart {
		if (DATE_ONLY_RE.test(raw)) {
			const dateRaw = raw.replace(/-/g, "");
			const epochMillis = calDateStartEpochMillis(parseCalDate(dateRaw), "UTC");
			return { patch: { kind: "date", raw: dateRaw }, epochMillis, timeInfo: undefined, vtimezone: undefined };
		}
		const m = DATE_TIME_LOCAL_RE.exec(raw);
		if (m === null) throw new InvalidStartError(raw);
		if (timeZone === undefined) throw new EventTimeZoneRequiredError();
		if (!isValidIanaZone(timeZone)) throw new InvalidTimeZoneError(timeZone);
		const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
		const fields = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) };
		const epochMillis = localFieldsToEpochMillis(fields, timeZone);
		const vtimezone = this.buildTz(timeZone, epochMillis);
		return {
			patch: { kind: "date-time", raw: `${y}${mo}${d}T${h}${mi}${s}`, tzid: timeZone },
			epochMillis,
			timeInfo: { hour: fields.hour, minute: fields.minute, second: fields.second, timeZone },
			vtimezone,
		};
	}

	/** input.end(null/string)を VEventEndPatch に解析する。 */
	private parseEnd(raw: string | null, timeZone: string | undefined): ParsedEnd {
		if (raw === null) return { patch: { kind: "remove" } };
		if (DATE_ONLY_RE.test(raw)) {
			const dateRaw = raw.replace(/-/g, "");
			const epochMillis = calDateStartEpochMillis(parseCalDate(dateRaw), "UTC");
			return { patch: { kind: "date", raw: dateRaw }, epochMillis, valueType: "DATE" };
		}
		const m = DATE_TIME_LOCAL_RE.exec(raw);
		if (m === null) throw new InvalidEndError(raw);
		if (timeZone === undefined) throw new EventTimeZoneRequiredError();
		if (!isValidIanaZone(timeZone)) throw new InvalidTimeZoneError(timeZone);
		const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
		const fields = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) };
		const epochMillis = localFieldsToEpochMillis(fields, timeZone);
		const vtimezone = this.buildTz(timeZone, epochMillis);
		return {
			patch: { kind: "date-time", raw: `${y}${mo}${d}T${h}${mi}${s}`, tzid: timeZone },
			epochMillis,
			valueType: "DATE-TIME",
			vtimezone,
		};
	}

	/** VTIMEZONE を epoch の前後 400日窓で生成する(DST ゾーンは application 層の kind タグ付きへ写像)。 */
	private buildTz(timeZone: string, epochMillis: number): Component {
		try {
			return buildVTimezone(timeZone, {
				startMillis: epochMillis - WINDOW_MARGIN_MILLIS,
				endMillis: epochMillis + WINDOW_MARGIN_MILLIS,
			});
		} catch (error) {
			if (error instanceof DomainUnsupportedTimeZoneError) throw new UnsupportedTimeZoneError(timeZone);
			throw error;
		}
	}
}
