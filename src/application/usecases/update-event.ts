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
	composeDescriptionWithConference,
	ICalendarObject,
	isValidIanaZone,
	localFieldsToEpochMillis,
	serialize,
	splitConferenceFromDescription,
	UnsupportedTimeZoneError as DomainUnsupportedTimeZoneError,
	zoneResolverFor,
	type Component,
	type ConferenceInput,
	type RecurrenceRule,
	type StructuredLocationInput,
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
import { decodeText, parseCalDate, type CalDate, type CalDateTime } from "../../domain/ical/values";
import { isSameResourceConflict, PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
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
	InvalidConferenceUrlError,
	InvalidEndError,
	InvalidStartError,
	InvalidStructuredLocationError,
	InvalidTravelMinutesError,
	InvalidUrlError,
	StartAfterEndError,
	StartEndTypeMismatchError,
	validateAndBuildAlarms,
	validateConferenceUrl,
	validateStructuredLocation,
	validateTravelMinutes,
	validateUrl,
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
	/**
	 * C8(設計 05 §1-b・§2「場所」スロット)。三値: 省略=変更しない / null=構造化場所を除去
	 * (LOCATION テキストは温存。vevent-patch.ts の VEventPatchFields.structuredLocation コメント参照)/
	 * StructuredLocationInput=設定(LOCATION も title で上書き)。
	 */
	structuredLocation?: StructuredLocationInput | null;
	/**
	 * C8(設計 05 §1-c・§2「会議」スロット)。三値: 省略=変更しない / null=DESCRIPTION から会議ブロックを
	 * 除去(notes 本文は温存)/ ConferenceInput=設定・差し替え(既存 notes 本文と再合成する)。
	 * notes を同時指定した場合は新 notes + 新 conference を合成する。
	 */
	conference?: ConferenceInput | null;
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
	| InvalidUrlError
	| InvalidStructuredLocationError
	| InvalidConferenceUrlError
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
		// --- S-B (2026-07-16): 同一リソース競合(ETag 不一致)時の自動リトライ(1回だけ) ---
		// lookup → patch → PUT(must-match)の間に他クライアント(iOS の PUT・カードの保存など)が
		// 同じリソースを書くと ETag がずれて 412 相当(ETagConditionError)になる。この UC の入力は
		// 「意味的パッチ」(title だけ・start だけ、のようなフィールド差分)なので、最新状態を
		// 読み直して同じパッチを再適用しても他クライアントの変更を巻き戻さない(lost update に
		// ならない)— ICS 全文を上書きする素の PUT との決定的な違いで、だからこそリトライは
		// この UC(と対称の UpdateTodo)にだけ入れ、put-calendar-object 自体には入れない。
		// 2回目も競合したら従来どおりエラーを伝播する(R-7 の「素の 412」を最後の砦に残す —
		// 2連続competing はビジー状態のシグナルであり、無限に再適用し続ける方が危険)。
		// attemptUpdate は lookup からやり直すので、再試行 = re-read → re-patch → 再 PUT になる。
		try {
			return await this.attemptUpdate(input);
		} catch (error) {
			// 同一リソース競合を1回だけリトライする。競合はどちらの層で捕まえても同じ扱い:
			//   - ETagConditionError(must-match): put-calendar-object.ts Step 3 のメモリ判定で、
			//     lookup した etag と DB の現在 etag がずれていた(早期弾き)。
			//   - ConcurrencyConflictError: UoW の DB 側 ETag CAS が③の0行で捕まえた
			//     (メモリ判定を通過した後、書き込み直前までに他者が書いた TOCTOU)。
			// どちらも「lookup してから書くまでに同じリソースが動いた」= re-read→re-patch で解ける
			// (ports の ConcurrencyConflictError コメントの正規化方針)。
			if (isSameResourceConflict(error)) {
				return await this.attemptUpdate(input);
			}
			throw error;
		}
	}

	/** 1回分の lookup → patch → PUT(must-match)。execute がリトライ制御込みで呼ぶ。 */
	private async attemptUpdate(input: UpdateEventInput): Promise<UpdateEventOutput> {
		// start/end の parse(format/timeZone/DST エラーは lookup 前に投げる = 安価な失敗)。
		const parsedStart = input.start !== undefined ? this.parseStart(input.start, input.timeZone) : undefined;
		const parsedEnd = input.end !== undefined ? this.parseEnd(input.end, input.timeZone) : undefined;

		// 通知(alarms)+ 移動時間(travelMinutes)の三値を patch 指示へ解決(lookup 前 = 安価な失敗)。
		//   alarms: undefined=触らない / null=全除去 / 配列=検証して {minutesBefore,uid} 列へ。
		//   travelMinutes: undefined=触らない / null=除去 / 正整数=検証。
		const alarmsPatch: ReadonlyArray<{ minutesBefore: number; uid: string }> | null | undefined =
			input.alarms === undefined ? undefined : input.alarms === null ? null : validateAndBuildAlarms(input.alarms);
		if (input.travelMinutes !== undefined && input.travelMinutes !== null) validateTravelMinutes(input.travelMinutes);
		// url も同じ「lookup 前の安価な失敗」に揃える(null=除去は検証不要・undefined=据え置きも同様)。
		if (input.url !== undefined && input.url !== null) validateUrl(input.url);
		// structuredLocation/conference も同じ規律(C8)。
		if (input.structuredLocation !== undefined && input.structuredLocation !== null) {
			validateStructuredLocation(input.structuredLocation);
		}
		if (input.conference !== undefined && input.conference !== null) validateConferenceUrl(input.conference.url);

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

		// DESCRIPTION の再合成(C8): notes/conference のどちらか一方だけを patch したい場合でも、
		// もう一方は既存 DESCRIPTION から split して温存する(composeDescriptionWithConference /
		// splitConferenceFromDescription は互いの逆写像 — ファイル冒頭 structured-location-write.ts
		// コメント参照)。どちらも undefined(触らない)なら DESCRIPTION 自体を patch しない
		// (patchVEventFields の description は undefined=触らない の二値なので、既存の "notes まるごと
		// 上書き" 挙動を壊さないよう、変更が無いときは既存 event-dto.ts Event.notes と同じ「未分割の
		// 生 DESCRIPTION」を保つ)。
		let descriptionPatch: string | undefined;
		if (input.notes !== undefined || input.conference !== undefined) {
			const existingRaw = looked.vevent.description; // encodeText 済みの生値(decodeText して split)。
			const existing = splitConferenceFromDescription(existingRaw !== undefined ? decodeText(existingRaw) : undefined);
			const notes = input.notes !== undefined ? input.notes : existing.notes;
			const conference: ConferenceInput | undefined =
				input.conference === undefined
					? existing.conference !== undefined
						? { url: existing.conference }
						: undefined
					: input.conference === null
						? undefined
						: input.conference;
			// composeDescriptionWithConference は undefined を返しうる(notes/conference 両方無し)。
			// patchVEventFields.description は「undefined=触らない」二値なので、除去したい(空にしたい)
			// ときは空文字を明示して DESCRIPTION を空の TEXT にする(除去 API が無い既存契約に合わせる —
			// vevent-patch.ts に description の三値除去が無いのは既存仕様であり本タスクのスコープ外)。
			descriptionPatch = composeDescriptionWithConference(notes, conference) ?? "";
		}

		let patched: Component = patchVEventFields(looked.vevent.raw, {
			summary: input.title,
			description: descriptionPatch,
			location: input.location,
			url: input.url,
			start: parsedStart?.patch,
			end: parsedEnd?.patch,
			recurrence: recurrencePatch,
			alarms: alarmsPatch,
			travelMinutes: input.travelMinutes,
			structuredLocation: input.structuredLocation,
		});

		patched = stampUpdate(patched, nowStampFromDate(new Date()));

		// VCALENDAR.components の対象 VEVENT だけを差し替える(他サブコンポーネントは保持)。
		const vcalendar = looked.resource.payload.raw;
		let components = vcalendar.components.map((c) => (c === looked.vevent.raw ? patched : c));

		// 【recurrence: null = 反復をやめるときは同 UID の override も削除する(2026-07-22)】
		// iPhone 純正カレンダーで単発編集された繰り返し予定は、master と同じファイルに
		// RECURRENCE-ID 付き override VEVENT を持つ(本番 D1 の実データで確認 — 移動した1回分が
		// 別コンポーネントとして同居)。RRULE だけ消すと override が孤児として残り、
		// (1) 本アプリの展開エンジン(expansion.ts item10: 非反復 master は master 1件のみ返す)では
		//     表示されないのに、(2) Apple クライアントは生 ICS を直接描くので表示され続ける、という
		//     クライアント間の見え方割れが起きる(§3.8.4.4: RECURRENCE-ID は反復セットの特定
		//     インスタンス参照 — 参照先の反復セットが消えた時点で意味を失う)。
		// 「detached として単発イベントに昇格させて残す」案はボツ: ユーザーの意図は「反復をやめて
		// 1つの予定にする」であり、編集済みの過去回が別予定として突然増殖するのは驚き最小原則に反する
		// (EXDATE/RDATE の除去は vevent-patch.ts 側 — プロパティ単位はあちら・コンポーネント単位は
		// ここ、という責務分界。あちらのコメントと対)。
		if (recurrencePatch === null) {
			components = components.filter((c) => {
				if (c.name !== "VEVENT" || c === patched) return true;
				const uid = c.properties.find((p) => p.name === "UID")?.value;
				const isOverride = c.properties.some((p) => p.name === "RECURRENCE-ID");
				return !(uid === input.eventId && isOverride);
			});
		}

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
