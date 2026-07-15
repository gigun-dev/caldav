// =============================================================================
// event-dto — Event DTO(E-3 UI-ready・全 event 系ユースケース共通)
// =============================================================================
//
// 【この DTO の位置づけ・task-dto.ts との対称】
// CreateEvent/UpdateEvent/DeleteEvent(mutate)と list-events-expanded(照会)が共通で返す
// UI-ready なイベント表現。task-dto.ts の Task DTO が VTODO 系ユースケース共通なのと完全に対称。
// docs/modeling/12 §3 の形を厳密に写す(claude.ai カードと SwiftUI の両方が消費する UI 技術非依存
// の語彙 — §6)。
//
// 【日時整形をここで持つ理由(presentation/mcp/format.ts を import しない)】
// task-dto.ts と同じ層境界判断: application → presentation の import は依存の向きが逆
// (オニオンアーキテクチャ違反・CI 層境界チェックに引っかかる)。ロジックは format.ts /
// task-dto.ts と同じだが、実体はこのファイルに複製して application 層内に閉じる(10 行強の
// 純関数で「層境界の健全性」を「値の重複回避」より優先する既存判断)。
// =============================================================================

import type { VEvent } from "../../domain/ical/semantics";
import type { CalDate, CalDateTime, Frequency, RecurrenceRule } from "../../domain/ical/values";
import { decodeText, InvalidValueError } from "../../domain/ical/values";
import { calDateTimeToEpochMillis, getZoneOffsetMillis } from "../../domain/ical/timezone";
import type { Occurrence } from "../../domain/ical/recurrence";

// CalDate | CalDateTime の判別(task-dto.ts と同じローカル再定義。"kind" の有無で判定)。
function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/** MCP/将来 REST/Swift から共通で返す event の表現(docs/modeling/12 §3)。 */
export interface Event {
	/** マスターの UID。 */
	id: string;
	/**
	 * 展開 occurrence の識別(この回の開始 ISO。マスター単独の非反復イベントは null)。
	 * mutate(create/update/delete)はマスター単位の操作なので常に null。list-events-expanded は
	 * 反復 occurrence にはその回の開始を、非反復イベントには null を入れる。
	 */
	recurrenceId: string | null;
	title: string;
	/** "YYYY-MM-DD"(終日) | offset 付き ISO8601(時刻付き)。 */
	start: string;
	/** 同形式・排他的終端(§3.8.2.2)。DTEND 無し=null。 */
	end: string | null;
	isAllDay: boolean;
	/** LOCATION(§3.8.1.7)。decodeText 済みの意味的文字列。未設定は null。 */
	location: string | null;
	/**
	 * URL(§3.8.4.6)。値型は URI なので decodeText しない(生値のまま)。未設定は null。
	 * 「予定に紐づく詳細ページ/ミーティングリンク」等の URL(iOS の URL フィールドに対応)。
	 */
	url: string | null;
	/** DESCRIPTION(§3.8.1.5)。decodeText 済み。未設定は null。 */
	notes: string | null;
	/** STATUS(§3.8.1.11)。未設定は null。 */
	status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | null;
	/** RRULE 要約(Task.recurrence と同型・同じ degrade 規約)。非反復は null。 */
	recurrence: {
		frequency: string;
		interval: number;
		weekdays: string[] | null;
		count: number | null;
		until: string | null;
	} | null;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

// task-dto.ts / format.ts の epochToIso と同じ計算(層境界判断により複製)。
function epochToIsoLocal(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	const wall = new Date(millis + offsetMillis);
	const datePart =
		`${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
		`T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}`;
	if (offsetMillis === 0) return `${datePart}Z`;
	const sign = offsetMillis < 0 ? "-" : "+";
	const absMinutesTotal = Math.round(Math.abs(offsetMillis) / 60000);
	return `${datePart}${sign}${pad2(Math.floor(absMinutesTotal / 60))}:${pad2(absMinutesTotal % 60)}`;
}

// エポックミリ秒 → "YYYY-MM-DD"(終日表示。task-dto の formatCalDateAsIso とは違い、occurrence は
// 既にエポックなのでゾーンで壁時計に戻してから日付部分を取る — format.ts の formatDateOnly と同じ)。
function formatDateOnlyLocal(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	const wall = new Date(millis + offsetMillis);
	return `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

// CalDate は年月日を直接持つのでフィールドから組み立てる(task-dto.ts の formatCalDateAsIso と同じ)。
function formatCalDateAsIso(d: CalDate): string {
	return `${d.year.toString().padStart(4, "0")}-${pad2(d.month)}-${pad2(d.day)}`;
}

/**
 * DTSTART/DTEND(CalDate | CalDateTime)を Event.start/end の表現に変換する。
 * task-dto.ts の formatDue と同じ規約: 終日は "YYYY-MM-DD"、時刻付きは「その値自身のゾーン」で
 * offset ISO(zoned は自 TZID、utc は UTC、floating は応答基準 timeZone)。
 */
function formatInstant(
	value: CalDate | CalDateTime,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): { value: string; isAllDay: boolean } {
	if (!isCalDateTime(value)) {
		return { value: formatCalDateAsIso(value), isAllDay: true };
	}
	const millis = calDateTimeToEpochMillis(value, { zoneOf, floatingTimeZone: timeZone });
	const displayZone = value.kind === "zoned" ? zoneOf(value.tzid) : value.kind === "utc" ? "UTC" : timeZone;
	return { value: epochToIsoLocal(millis, displayZone), isAllDay: false };
}

// chat 語彙への逆引き(task-dto.ts の FREQUENCY_TO_CHAT_VOCAB と同値)。
const FREQUENCY_TO_CHAT_VOCAB: Partial<Record<Frequency, string>> = {
	DAILY: "daily",
	WEEKLY: "weekly",
	MONTHLY: "monthly",
	YEARLY: "yearly",
};

function formatWeekdayNumForDto(d: { ordinal?: number; weekday: string }): string {
	return d.ordinal !== undefined ? `${d.ordinal}${d.weekday}` : d.weekday;
}

function formatRecurUntilForDto(
	until: NonNullable<RecurrenceRule["until"]>,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): string {
	if (until.type === "date") {
		return formatCalDateAsIso(until.date);
	}
	const millis = calDateTimeToEpochMillis(until.dateTime, { zoneOf, floatingTimeZone: timeZone });
	const displayZone = until.dateTime.kind === "utc" ? "UTC" : timeZone;
	return epochToIsoLocal(millis, displayZone);
}

/**
 * VEvent の RRULE を Event.recurrence に変換する(task-dto.ts の formatRecurrence と同じ degrade 方針)。
 * VEvent.rrule getter は壊れた RRULE で InvalidValueError を投げるので catch して degrade する
 * (壊れた RRULE を持つ他クライアント発イベントが1件でも list 全体を 500 にしないため)。
 */
function formatRecurrence(vevent: VEvent, zoneOf: (tzid: string) => string, timeZone: string): Event["recurrence"] {
	let rule: RecurrenceRule | undefined;
	try {
		rule = vevent.rrule;
	} catch (err) {
		if (!(err instanceof InvalidValueError)) throw err;
		const rawRrule = vevent.raw.properties.find((p) => p.name === "RRULE")?.value ?? "";
		return { frequency: rawRrule, interval: 1, weekdays: null, count: null, until: null };
	}
	if (rule === undefined) return null;

	const frequency = FREQUENCY_TO_CHAT_VOCAB[rule.freq] ?? rule.freq;
	return {
		frequency,
		interval: rule.interval ?? 1,
		weekdays: rule.byDay !== undefined ? rule.byDay.map(formatWeekdayNumForDto) : null,
		count: rule.count ?? null,
		until: rule.until !== undefined ? formatRecurUntilForDto(rule.until, zoneOf, timeZone) : null,
	};
}

// VEvent 共通のメタ(title/notes/location/status/recurrence)を読む。start/end/recurrenceId は
// 呼び出し側(occurrence か VEvent 直読みか)で決まるので分離する。
function readEventMeta(
	vevent: VEvent,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): Pick<Event, "id" | "title" | "location" | "url" | "notes" | "status" | "recurrence"> {
	// URL(§3.8.4.6)。VEvent レンズに url アクセサが無い(vevent.ts は読み取り専用で変更しない方針)ため
	// raw から直接読む(task-dto.ts が DESCRIPTION を raw から読むのと同じやり方)。URI 値型なので
	// decodeText はしない(生値のまま返す — location/notes は TEXT で decodeText するのと非対称)。
	const urlProp = vevent.raw.properties.find((p) => p.name === "URL");
	return {
		id: vevent.uid ?? "",
		// task-dto.ts と同じく Task DTO は decodeText した意味的文字列で返す(生 TEXT を UI に見せない)。
		title: vevent.summary !== undefined ? decodeText(vevent.summary) : "",
		location: vevent.location !== undefined ? decodeText(vevent.location) : null,
		url: urlProp !== undefined ? urlProp.value : null,
		notes: vevent.description !== undefined ? decodeText(vevent.description) : null,
		// STATUS は大文字化済み(VEvent.status getter)。3値以外の生値も握りつぶさず通す(degrade 方針)。
		status: (vevent.status ?? null) as Event["status"],
		recurrence: formatRecurrence(vevent, zoneOf, timeZone),
	};
}

/**
 * 展開済み occurrence(list-events-expanded の経路)から Event を作る。
 * start/end は occurrence の実効エポック、recurrenceId はこの回の開始(反復のみ・非反復は null)。
 *
 * @param uid       マスター UID。
 * @param occurrence RecurrenceExpansion が返した1件。
 * @param zoneOf    zoned な UNTIL 等の TZID 解決(呼び出し側が zoneResolverFor(obj) で作る)。
 * @param timeZone  応答基準ゾーン(occurrence のエポックはこのゾーンで壁時計に戻して整形する。
 *   occurrence は展開時点で tzid を失っているため、DTSTART 自身のゾーンではなく応答ゾーンで整形する
 *   — list-events-expanded の既存挙動と同じ。§3 の「イベント自身のゾーン」との差は最終報告で親に返す)。
 */
export function eventFromOccurrence(
	uid: string,
	occurrence: Occurrence,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): Event {
	const isAllDay = !isCalDateTime(occurrence.recurrenceId);
	const start = isAllDay
		? formatDateOnlyLocal(occurrence.startMillis, timeZone)
		: epochToIsoLocal(occurrence.startMillis, timeZone);
	const end = isAllDay
		? formatDateOnlyLocal(occurrence.endMillis, timeZone)
		: epochToIsoLocal(occurrence.endMillis, timeZone);

	const component = occurrence.component;
	// isRecurring: override 由来か、マスター自身が RRULE/RDATE を持つ(list-events-expanded の既存判定)。
	const isRecurring =
		occurrence.source === "override" || component.rrule !== undefined || component.rdate.length > 0;

	return {
		...readEventMeta(component, zoneOf, timeZone),
		// id は occurrence の component.uid(override なら override の UID になりうる)ではなく、
		// 呼び出し側が渡すマスター UID で上書きする(occurrence の識別は recurrenceId で行う)。
		id: uid,
		recurrenceId: isRecurring ? start : null,
		start,
		end,
		isAllDay,
	};
}

/**
 * 書き込んだ VEvent(mutate 経路: create/update が直後に読み直すマスター)から Event を作る。
 * DTSTART/DTEND を直接読む。recurrenceId は常に null(mutate はマスター単位。docs/modeling/12 §3)。
 */
export function eventFromVEvent(vevent: VEvent, zoneOf: (tzid: string) => string, timeZone: string): Event {
	const dtstart = vevent.dtstart;
	// DTSTART は §3.6.1 で REQUIRED。無い壊れたデータは防御的に終日 "0000-00-00" 相当を避け、
	// isAllDay=false の空 ISO を返さないよう、start 未取得は空文字にフォールバックする
	// (create-event.ts は必ず DTSTART を書くので実運用では通らない経路)。
	const startFmt = dtstart !== undefined ? formatInstant(dtstart, zoneOf, timeZone) : { value: "", isAllDay: false };
	const dtend = vevent.dtend;
	const endFmt = dtend !== undefined ? formatInstant(dtend, zoneOf, timeZone) : null;

	return {
		...readEventMeta(vevent, zoneOf, timeZone),
		recurrenceId: null,
		start: startFmt.value,
		end: endFmt !== null ? endFmt.value : null,
		isAllDay: startFmt.isAllDay,
	};
}
