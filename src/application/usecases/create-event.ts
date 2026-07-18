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
	composeDescriptionWithConference,
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
	type ConferenceInput,
	type RecurrenceRule,
	type StructuredLocationInput,
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
	/**
	 * 通知(開始相対 VALARM)。minutesBefore の列(0=開始時刻ちょうど)。最大2件・重複不可・負値不可。
	 * 省略または空配列なら VALARM を書かない。TRIGGER は `-PT{n}M`(vevent-alarm.ts の裁定)。
	 */
	alarms?: number[];
	/** 移動時間(X-APPLE-TRAVEL-DURATION・分)。正整数のみ。省略なら書かない。 */
	travelMinutes?: number;
	/**
	 * C8(設計 05 §1-b・§2「場所」スロット): 構造化された場所(タイトル+座標)。既存 location(表示
	 * テキスト)とは additive — 両方渡された場合は structuredLocation.title が LOCATION を上書きする
	 * (vevent-write.ts の author 規約)。省略なら X-APPLE-STRUCTURED-LOCATION を書かない。
	 */
	structuredLocation?: StructuredLocationInput;
	/**
	 * C8(設計 05 §1-c・§2「会議」スロット): 会議(Join)リンク。既存 url(参照 URL)とは別物 —
	 * 両者は同時に設定でき、conference は DESCRIPTION の「ビデオ通話」ブロックとして書く
	 * (composeDescriptionWithConference。author 規約は設計 05 §1-c)。url を会議として使い回したい
	 * 場合は conference.url に同じ値を渡す(サーバー側で url→conference の自動昇格はしない —
	 * 「参照リンクのつもりが意図せず参加ボタンになる」事故を避けるため明示指定を要求する)。
	 */
	conference?: ConferenceInput;
}

// alarms の上限件数(docs/modeling/12 §1「最大2件」= 通知 + 予備の通知)。UI/UC の都合の制約で
// ドメイン組み立て(vevent-write)は件数を縛らない — 検証はここ application 層に置く。
const MAX_ALARMS = 2;

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

/**
 * 通知(alarms)の入力が不正なときのエラー(件数超過・負値/非整数・重複を1エラー種別にまとめる)。
 * reason で細分(create/update-event 共通。MCP はメッセージをそのまま toolError に載せる)。
 */
export class InvalidAlarmsError extends Error {
	readonly kind = "InvalidAlarmsError" as const;
	constructor(readonly reason: "too-many" | "negative" | "non-integer" | "duplicate", message: string) {
		super(message);
		this.name = "InvalidAlarmsError";
	}
}

/**
 * url(§3.8.4.6・URI 値型)が「スキーム付き絶対 URI」でないときのエラー。create/update-event 共有
 * (docs/modeling/12 §7.6)。
 *
 * 【なぜ http/https に限定しないか】RFC 5545 §3.8.4.6 原文(docs/rfc/rfc5545.txt)は
 * "This memo does not attempt to standardize the form of the URI" と明言している — URL プロパティは
 * 値型が URI というだけで、スキームを http/https に絞る根拠は原文に無い。iOS カレンダーは
 * tel:/webex:/msteams:/facetime: 等のスキームを URL に置く実例がある(会議リンク・電話番号)ため、
 * ここで弾くと正当な入力を壊す。要求するのは「スキームがあること」(絶対 URI)だけ。
 *
 * 【なぜここ(application 層)で検証するか】既存の他フィールド検証(InvalidAlarmsError・
 * InvalidTravelMinutesError・StartAfterEndError 等)が全てこの層にあり、同じ様式(kind タグ付き
 * Error・create/update 共有関数・server.ts の isEventInputError で catch-all)に揃えるため。
 * presentation の zod で弾く案もあったが、zod の .url() は http/https 限定のプリセットしか無く
 * 「スキームの有無だけ」を表現するには結局カスタム refine が要る = ここに書くのと手間が同じ。
 * かつ zod に置くと「なぜ http/https に限定しないか」という判断根拠(RFC 原文)が実装層から
 * 遠くなる(presentation はプロトコル/入出力整形の層であり、RFC 値型の妥当性はドメイン寄りの
 * 判断 — application に置く方が層の責務に合う)。
 */
export class InvalidUrlError extends Error {
	readonly kind = "InvalidUrlError" as const;
	constructor(readonly url: string) {
		super(`url must be an absolute URI with a scheme (e.g. "https://..." or "tel:..."), got: "${url}"`);
		this.name = "InvalidUrlError";
	}
}

/** 移動時間(travelMinutes)が正整数でないときのエラー。 */
export class InvalidTravelMinutesError extends Error {
	readonly kind = "InvalidTravelMinutesError" as const;
	constructor(readonly travelMinutes: number) {
		super(`travelMinutes must be a positive integer (minutes): ${travelMinutes}`);
		this.name = "InvalidTravelMinutesError";
	}
}

/**
 * structuredLocation の geo(lat/lon)が範囲外、または radius が非正のときのエラー(C8)。
 * title の空文字チェックは zod(presentation 層)の min(1) 相当に委ねず、ここでも防御的に見る
 * (他の InvalidXxxError と同じ層に検証を揃える方針)。
 */
export class InvalidStructuredLocationError extends Error {
	readonly kind = "InvalidStructuredLocationError" as const;
	constructor(readonly reason: "title-empty" | "lat-out-of-range" | "lon-out-of-range" | "radius-non-positive", message: string) {
		super(message);
		this.name = "InvalidStructuredLocationError";
	}
}

/**
 * conference.url が http(s) URL でないときのエラー(C8)。読み取り側 readConference/HTTP_URL_RE が
 * `https?://` 直入れ or DESCRIPTION ブロック内の http(s) URL しか会議と認識しない(structured-location.ts
 * 参照)ため、http(s) 以外を書いても読み戻すと会議として復元されず round-trip が壊れる。書く前に
 * 弾いて壊れた ICS を作らない(InvalidUrlError が url を http/https に限定しない方針と対称的に、
 * conference は「会議として読み戻せること」がここでの唯一の目的なので http(s) 限定にする)。
 */
export class InvalidConferenceUrlError extends Error {
	readonly kind = "InvalidConferenceUrlError" as const;
	constructor(readonly url: string) {
		super(`conference.url must be an http(s) URL so it round-trips as a conference (design 05 §1-c), got: "${url}"`);
		this.name = "InvalidConferenceUrlError";
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
	| InvalidAlarmsError
	| InvalidTravelMinutesError
	| InvalidUrlError
	| InvalidStructuredLocationError
	| InvalidConferenceUrlError
	| PutCalendarObjectError;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * alarms 入力(minutesBefore の列)を検証し、VEventFields 用の {minutesBefore, uid} 列へ変換する。
 * create-event / update-event で共有(検証規律の二重管理を避ける)。空配列は空配列を返す。
 *
 * 検証: 最大2件(MAX_ALARMS)/ 各要素は非負整数(負値・非整数を拒否)/ 重複拒否。
 * uid は VALARM ごとに採番する(vevent-alarm.ts が UID==X-WR-ALARMUID に使う)。
 */
export function validateAndBuildAlarms(alarms: number[]): Array<{ minutesBefore: number; uid: string }> {
	if (alarms.length > MAX_ALARMS) {
		throw new InvalidAlarmsError("too-many", `at most ${MAX_ALARMS} alarms are allowed, got ${alarms.length}`);
	}
	const seen = new Set<number>();
	for (const n of alarms) {
		if (!Number.isInteger(n)) throw new InvalidAlarmsError("non-integer", `alarm minutesBefore must be an integer, got ${n}`);
		if (n < 0) throw new InvalidAlarmsError("negative", `alarm minutesBefore must be >= 0 (0 = at start), got ${n}`);
		if (seen.has(n)) throw new InvalidAlarmsError("duplicate", `duplicate alarm minutesBefore: ${n}`);
		seen.add(n);
	}
	return alarms.map((minutesBefore) => ({ minutesBefore, uid: crypto.randomUUID() }));
}

/** travelMinutes 入力(正整数)を検証する(不正なら InvalidTravelMinutesError)。create/update 共有。 */
export function validateTravelMinutes(travelMinutes: number): void {
	if (!Number.isInteger(travelMinutes) || travelMinutes <= 0) {
		throw new InvalidTravelMinutesError(travelMinutes);
	}
}

/**
 * url 入力(§3.8.4.6・URI 値型)を「スキーム付き絶対 URI」として検証する。create/update-event 共有。
 * InvalidUrlError のコメントに判断根拠(なぜ http/https 限定でないか・なぜこの層か)を記載。
 *
 * 実装: `new URL(input)` で parse を試み、投げたら不正(相対 URI・空文字・壊れた形式を弾く)。
 * WHATWG URL パーサは "scheme:..." の形式であれば任意スキームを受理する(tel:/webex: 等も通る)ので、
 * parse 成功 = スキーム付き絶対 URI であることの十分条件になる(WHATWG URL の仕様上、パース成功する
 * 入力は必ず scheme を含む — 相対参照は base URL 無しでは常に失敗する)。追加のスキーム許可リストは
 * 意図的に持たない(InvalidUrlError のコメント参照)。
 */
export function validateUrl(url: string): void {
	try {
		new URL(url);
	} catch {
		throw new InvalidUrlError(url);
	}
}

/**
 * structuredLocation 入力(title/lat/lon/radius)を検証する(C8)。create/update-event 共有。
 * geo は WGS84 の素朴な範囲(§緯度 -90..90 / 経度 -180..180)、radius は正数(0 は「半径なし」と
 * 区別が付かなくなるので許可しない — 省略時 undefined と混同しないための境界)。
 */
export function validateStructuredLocation(loc: StructuredLocationInput): void {
	if (loc.title === "") {
		throw new InvalidStructuredLocationError("title-empty", "structuredLocation.title must not be empty");
	}
	if (!Number.isFinite(loc.lat) || loc.lat < -90 || loc.lat > 90) {
		throw new InvalidStructuredLocationError("lat-out-of-range", `structuredLocation.lat must be in [-90, 90], got ${loc.lat}`);
	}
	if (!Number.isFinite(loc.lon) || loc.lon < -180 || loc.lon > 180) {
		throw new InvalidStructuredLocationError("lon-out-of-range", `structuredLocation.lon must be in [-180, 180], got ${loc.lon}`);
	}
	if (loc.radius !== undefined && loc.radius <= 0) {
		throw new InvalidStructuredLocationError("radius-non-positive", `structuredLocation.radius must be > 0, got ${loc.radius}`);
	}
}

/** conference.url が http(s) であることを検証する(InvalidConferenceUrlError コメント参照)。create/update-event 共有。 */
export function validateConferenceUrl(url: string): void {
	if (!/^https?:\/\//i.test(url)) {
		throw new InvalidConferenceUrlError(url);
	}
}

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

		// 通知(alarms)+ 移動時間(travelMinutes)+ url の検証(lookup/PUT より前 = 安価な失敗)。
		const alarms = input.alarms !== undefined ? validateAndBuildAlarms(input.alarms) : undefined;
		if (input.travelMinutes !== undefined) validateTravelMinutes(input.travelMinutes);
		if (input.url !== undefined) validateUrl(input.url);
		if (input.structuredLocation !== undefined) validateStructuredLocation(input.structuredLocation);
		if (input.conference !== undefined) validateConferenceUrl(input.conference.url);

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
		// DESCRIPTION は notes(本文)+ conference(ビデオ通話ブロック)を合成する(設計 05 §1-c・
		// composeDescriptionWithConference)。conference 省略時は notes のみ(既存挙動と不変)。
		const description = composeDescriptionWithConference(input.notes, input.conference);
		const fields: VEventFields = {
			uid,
			now,
			summary: input.title,
			description,
			start: start.value,
			end: end?.value,
			vtimezone,
			location: input.location,
			url: input.url,
			recurrence,
			alarms,
			travelMinutes: input.travelMinutes,
			structuredLocation: input.structuredLocation,
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
