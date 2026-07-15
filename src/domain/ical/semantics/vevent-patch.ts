// =============================================================================
// vevent-patch — 既存 VEVENT の部分更新プリミティブ(E-3 スライス S1)
// =============================================================================
//
// 【この層の責務・vtodo-patch.ts との対称】
// vtodo-patch.ts が「既存 VTODO の一部だけをロスレスに書き換える patch 方式」を担うのと
// 完全に対称に、このファイルは VEVENT の patch を担う。upsertProperty/removeProperty
// (structure/edit.ts)だけを使い、指定したフィールド以外(VTIMEZONE・未指定の X-APPLE-* 等)には
// 一切触れない。通知(alarms)は指定時のみ「開始相対 VALARM だけ」を差し替え、他クライアント由来の
// VALARM(絶対トリガー・終了相対・位置トリガー)は温存する(applyAlarmsPatch 参照)。呼び出し側(application/usecases/update-event.ts)が「patch した VEVENT」を
// VCALENDAR.components 配列に差し戻すだけで、他のコンポーネントには触れない構造にする。
//
// 【DTEND⇄DURATION の lossless 原則(VTODO には無い VEVENT 固有の配慮)】
// VEVENT の終端は DTEND(§3.8.2.2)か DURATION(§3.8.2.5)のどちらかで表され、両者は排他(I3)。
// 他クライアント(iOS 等)は DURATION 形式で書くことがある。start/end を patch するとき、既存の
// DURATION を素直に残すと意味が保存されないケースがある:
//   - 明示的な end(DTEND)を新しく立てるとき: DTEND と DURATION は排他なので DURATION を消す
//     (でないと I3 違反の VEVENT を作ってしまう)。「DURATION を DTEND に書き換えてよい」の実体は
//     この「新 DTEND を立てて古い DURATION を落とす」= 意味は新 DTEND が保存する。
//   - start だけ動かす(end 未指定)とき: DURATION は DTSTART 相対なので、start を動かせば実効
//     終了も一緒に動く(意味保存される)。よって DURATION はそのまま残してよい。
// この判断は applyStartPatch/applyEndPatch のコメントに再掲する。
// =============================================================================

import type { Component, Parameter } from "../structure/types";
import { appendSubComponent, removeProperty, upsertProperty } from "../structure/edit";
import { encodeText } from "../values/text-value";
import { buildStartRelativeAlarm, isStartRelativeAlarm } from "./vevent-alarm";
import { type CalDateTime } from "../values/cal-date-time";
import { formatRecurrenceRule, parseRecurrenceRule, type RecurrenceRule } from "../values/recurrence-rule";
import { localFieldsToEpochMillis } from "../timezone";
import { rawValue } from "./helpers";

// VALUE=DATE パラメータ(vtodo-patch.ts と同値。各ファイルが自己完結して読めるよう再定義する)。
const VALUE_DATE_PARAMS = [{ name: "VALUE", values: ["DATE"] }] as const;

// X-APPLE-TRAVEL-DURATION の VALUE=DURATION パラメータ(vevent-write.ts と同値・同理由)。
const VALUE_DURATION_PARAMS: readonly Parameter[] = [{ name: "VALUE", values: ["DURATION"] }];

/**
 * DTSTART への patch 指示(vtodo-patch.ts の VTodoDuePatch と対称。ただし start は除去不可)。
 * イベントに開始は必須(§3.6.1: DTSTART は REQUIRED)なので "remove" 相当は持たない。
 * - "date"      : 終日にする。raw は YYYYMMDD(§3.3.4)。
 * - "date-time" : 時刻付きにする。raw は YYYYMMDDTHHMMSS(§3.3.5)。tzid は IANA ゾーン名。
 */
export type VEventStartPatch =
	| { readonly kind: "date"; readonly raw: string }
	| { readonly kind: "date-time"; readonly raw: string; readonly tzid: string };

/**
 * DTEND への patch 指示。start と違い除去できる(DTEND は OPTIONAL — 開始のみのイベントは合法)。
 * - "date"/"date-time" : DTEND を立てる(既存 DURATION は排他なので消す。ファイル冒頭コメント)。
 * - "remove"           : DTEND(と既存 DURATION)を取り除く = 開始のみのイベントにする。
 */
export type VEventEndPatch = VEventStartPatch | { readonly kind: "remove" };

/** patchVEventFields の入力。undefined のフィールドは触らない。 */
export interface VEventPatchFields {
	/** SUMMARY(§3.8.1.12)。意味的な文字列(エスケープ前)。 */
	summary?: string;
	/** DESCRIPTION(§3.8.1.5)。意味的な文字列(エスケープ前)。 */
	description?: string;
	/**
	 * LOCATION(§3.8.1.7)。vtodo-patch.ts と同じ三値: undefined=触らない / null or ""=除去 /
	 * 非空文字列=差し替え(ここで encodeText する)。
	 */
	location?: string | null;
	/**
	 * URL(§3.8.4.6)。location と同じ三値: undefined=触らない / null or ""=除去 / 非空文字列=差し替え。
	 * 【値型は URI】encodeText しない(生値のまま upsert。vevent-write.ts の VEventFields.url コメント参照)。
	 */
	url?: string | null;
	/** DTSTART への patch。undefined=触らない / VEventStartPatch=終日・時刻付きのいずれかに設定。 */
	start?: VEventStartPatch;
	/** DTEND への patch。undefined=触らない / VEventEndPatch=設定・除去のいずれか。 */
	end?: VEventEndPatch;
	/**
	 * RRULE への patch(vtodo-patch.ts と同じ三値):
	 *   - undefined      = 触らない
	 *   - null           = RRULE を除去する(反復をやめる)
	 *   - RecurrenceRule = RRULE を全置換する(部分マージしない)
	 * chat 語彙 → RecurrenceRule 変換は application 層(create-todo.ts の buildRecurrenceRule を
	 * update-event.ts が共有)。ここは RRULE 文字列を upsert/remove するだけ。
	 */
	recurrence?: RecurrenceRule | null;
	/**
	 * 通知(開始相対 VALARM)への patch(三値):
	 *   - undefined = 触らない(既存 VALARM を全部そのまま残す)
	 *   - null      = 開始相対 VALARM を全除去する(絶対トリガー・終了相対・位置トリガーは温存)
	 *   - 配列      = 開始相対 VALARM を全置換する(既存の開始相対だけ捨て、渡された列を新規に足す。
	 *                 開始相対以外は温存)
	 * 【なぜ「全 VALARM 置換」でなく「開始相対のみ管理」か(安全側)】他クライアント(iOS 等)が
	 * 書いた絶対トリガー/終了相対/位置トリガーの VALARM を、サーバーの通知編集で黙って壊さない
	 * ため。管理対象の線引きは isStartRelativeAlarm(vevent-alarm.ts)。空配列 [] は null と同義
	 * (開始相対を全部消して何も足さない = 全除去)になる。
	 */
	alarms?: ReadonlyArray<{ minutesBefore: number; uid: string }> | null;
	/**
	 * 移動時間(X-APPLE-TRAVEL-DURATION)への patch(三値): undefined=触らない / null=除去 /
	 * 正整数=設定(`PT{n}M`)。location/url の三値と同じパターン(値の妥当性検証は application 層)。
	 */
	travelMinutes?: number | null;
}

/**
 * 既存 VEVENT の一部フィールドだけを patch する。undefined は「触らない」。
 *
 * 【適用順】recurrence を start/end より先に適用する(vtodo-patch.ts と同じ理由 — 全置換 rule の
 * UNTIL は application が新 start の値型に合わせて組む契約なので、後段の followUntilValueType は
 * no-op になり二重調整が起きない)。
 */
export function patchVEventFields(vevent: Component, fields: VEventPatchFields): Component {
	let out = vevent;

	if (fields.summary !== undefined) {
		out = upsertProperty(out, "SUMMARY", encodeText(fields.summary));
	}
	if (fields.description !== undefined) {
		out = upsertProperty(out, "DESCRIPTION", encodeText(fields.description));
	}
	if (fields.location !== undefined) {
		if (fields.location === null || fields.location === "") {
			out = removeProperty(out, "LOCATION");
		} else {
			out = upsertProperty(out, "LOCATION", encodeText(fields.location));
		}
	}
	if (fields.url !== undefined) {
		// URL は URI 値型(§3.8.4.6)なので encodeText しない(location と同じ三値だがエスケープしない点だけ違う)。
		if (fields.url === null || fields.url === "") {
			out = removeProperty(out, "URL");
		} else {
			out = upsertProperty(out, "URL", fields.url);
		}
	}
	if (fields.recurrence !== undefined) {
		if (fields.recurrence === null) {
			out = removeProperty(out, "RRULE");
		} else {
			out = upsertProperty(out, "RRULE", formatRecurrenceRule(fields.recurrence));
		}
	}
	if (fields.start !== undefined) {
		out = applyStartPatch(out, fields.start);
	}
	if (fields.end !== undefined) {
		out = applyEndPatch(out, fields.end);
	}
	if (fields.travelMinutes !== undefined) {
		if (fields.travelMinutes === null) {
			out = removeProperty(out, "X-APPLE-TRAVEL-DURATION");
		} else {
			out = upsertProperty(out, "X-APPLE-TRAVEL-DURATION", `PT${fields.travelMinutes}M`, VALUE_DURATION_PARAMS);
		}
	}
	if (fields.alarms !== undefined) {
		out = applyAlarmsPatch(out, fields.alarms);
	}

	return out;
}

/**
 * 開始相対 VALARM を全置換する(null または空配列 = 全除去)。
 *
 * 【開始相対以外は温存する(VEventPatchFields.alarms コメントの安全側方針)】まず既存の
 * 「開始相対 VALARM」だけをサブコンポーネント列から除く(isStartRelativeAlarm=false のもの —
 * 絶対トリガー・終了相対・位置トリガー・VALARM 以外 — は素通しで残す)。そのうえで渡された
 * minutesBefore/uid の列を新しい開始相対 VALARM として末尾に足す。start(DTSTART)を patch しても
 * これらは相対トリガーなので自動追従する(サーバーは何も shift しない — vevent-alarm.ts 冒頭参照)。
 */
function applyAlarmsPatch(vevent: Component, alarms: ReadonlyArray<{ minutesBefore: number; uid: string }> | null): Component {
	// 既存の開始相対 VALARM を落とす(それ以外のサブコンポーネントは順序も含めそのまま残す)。
	let out: Component = { ...vevent, components: vevent.components.filter((c) => !isStartRelativeAlarm(c)) };
	if (alarms === null) return out; // 全除去(何も足さない)。
	for (const alarm of alarms) {
		out = appendSubComponent(out, buildStartRelativeAlarm(alarm.minutesBefore, alarm.uid));
	}
	return out;
}

/**
 * DTSTART を patch する(+ RRULE:UNTIL の値型追従 I6)。
 * 【DURATION は残してよい】start だけを動かす場合、DURATION は DTSTART 相対なので実効終了も
 * 一緒に動く = 意味保存される(ファイル冒頭コメント)。DTEND がある場合の DTEND は絶対時刻なので
 * start を動かしても DTEND は動かない(ユーザーが end を明示指定していない限り触らない)。
 */
function applyStartPatch(vevent: Component, start: VEventStartPatch): Component {
	let out = vevent;
	if (start.kind === "date") {
		out = upsertProperty(out, "DTSTART", start.raw, VALUE_DATE_PARAMS);
	} else {
		const tzidParams = [{ name: "TZID", values: [start.tzid] }];
		out = upsertProperty(out, "DTSTART", start.raw, tzidParams);
	}
	// I6(§3.3.10: UNTIL の値型は DTSTART に従う MUST)追従。
	out = followUntilValueType(out, start);
	return out;
}

/**
 * DTEND を patch する。
 * 【DTEND を立てるときは既存 DURATION を消す(I3 排他 + lossless 原則)】ファイル冒頭コメント参照。
 * 【remove は DTEND と DURATION の両方を消す】「終端の除去」= 開始のみのイベント。DURATION 形式で
 * 終端が表現されている可能性もあるので両方消す。
 */
function applyEndPatch(vevent: Component, end: VEventEndPatch): Component {
	if (end.kind === "remove") {
		let out = removeProperty(vevent, "DTEND");
		out = removeProperty(out, "DURATION");
		return out;
	}
	// DTEND を立てる。まず排他の DURATION を消してから(I3 違反を作らない)DTEND を upsert する。
	let out = removeProperty(vevent, "DURATION");
	if (end.kind === "date") {
		out = upsertProperty(out, "DTEND", end.raw, VALUE_DATE_PARAMS);
	} else {
		const tzidParams = [{ name: "TZID", values: [end.tzid] }];
		out = upsertProperty(out, "DTEND", end.raw, tzidParams);
	}
	return out;
}

/**
 * RRULE:UNTIL の値型を新しい DTSTART の値型に追従させる(I6・§3.3.10)。vtodo-patch.ts の同名
 * 非公開関数と同じロジック(DTSTART の値型に UNTIL の値型を合わせる。日付は保存し値型だけ変える)。
 * VEVENT/VTODO で共有したいが、あちらは非公開なので同じ規律をここにも書く(値の重複より各ファイルが
 * 自己完結して読める方を優先する既存判断 — vtodo-patch.ts の VALUE_DATE_PARAMS コメントと同じ)。
 */
function followUntilValueType(vevent: Component, start: VEventStartPatch): Component {
	const rruleRaw = rawValue(vevent, "RRULE");
	if (rruleRaw === undefined) return vevent;

	const rrule = parseRecurrenceRule(rruleRaw);
	if (rrule.until === undefined) return vevent;

	if (start.kind === "date") {
		if (rrule.until.type === "date") return vevent; // 既に DATE 型。
		// DATE-TIME → DATE。年月日だけ転写、時刻は落とす(終了日をずらさない)。
		const dt = rrule.until.dateTime;
		const newRule: RecurrenceRule = {
			...rrule,
			until: { type: "date", date: { year: dt.year, month: dt.month, day: dt.day } },
		};
		return upsertProperty(vevent, "RRULE", formatRecurrenceRule(newRule));
	}

	// start.kind === "date-time": UNTIL は DATE-TIME(UTC)であるべき(§3.3.10 は UTC MUST)。
	if (rrule.until.type === "date-time") return vevent; // 既に DATE-TIME 型。
	// DATE → DATE-TIME。UNTIL の日付 + 新 start の壁時計時刻を、新 start の TZID で UTC 化する
	// (vtodo-patch.ts と同じポリシー: 「n回目と同じ時刻に終了する」直感)。
	const untilDate = rrule.until.date;
	const time = start.raw.split("T")[1] ?? "000000";
	const untilEpoch = localFieldsToEpochMillis(
		{
			year: untilDate.year,
			month: untilDate.month,
			day: untilDate.day,
			hour: Number(time.slice(0, 2)),
			minute: Number(time.slice(2, 4)),
			second: Number(time.slice(4, 6)),
		},
		start.tzid,
	);
	const utcDateTime: Extract<CalDateTime, { kind: "utc" }> = { kind: "utc", ...epochToUtcFields(untilEpoch) };
	const newRule: RecurrenceRule = { ...rrule, until: { type: "date-time", dateTime: utcDateTime } };
	return upsertProperty(vevent, "RRULE", formatRecurrenceRule(newRule));
}

/** UTC エポックミリ秒 → CalDateTime(kind:"utc")の年月日時分秒(vtodo-patch.ts と同じ)。 */
function epochToUtcFields(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const d = new Date(ms);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
}
