// =============================================================================
// mcp/events-diff — mutate 差分メタ(affected/removed)の表示用正規化(E-3 スライス S1)
// =============================================================================
//
// 【責務・todos-diff.ts と対称】mutate ツールが返す AffectedEvent.changes / EventSnapshot の
// 「表示用の短い正規化文字列」を作る。UI に生 ISO(...T09:00:00+09:00)/生 RRULE は載せない
// (整形は truth surface を作る presentation 側 = ここで済ませる。todos-diff.ts と同じ contract)。
// =============================================================================

import type { Event } from "../../application/usecases";
import type { AffectedEvent, EventSnapshot } from "./events-view-model";

// title の before/after をそのまま載せる上限長(todos-diff.ts の TITLE_DIFF_MAX_LEN と同値・同理由)。
const TITLE_DIFF_MAX_LEN = 60;

/**
 * Event.start/end(整形済み: 終日は "YYYY-MM-DD"、時刻付きは offset ISO)を UI 表示用の短文にする。
 * - 終日          : "2026-07-15"(そのまま)。
 * - 時刻付き ISO  : "2026-07-15 14:00"(日付と時分だけ。秒/offset は落とす)。
 * todos-diff.ts の formatDueDisplay と同じ整形方針(相対表現は UI の責務なのでここでは絶対短文だけ)。
 */
export function formatInstantDisplay(iso: string | null, isAllDay: boolean): string | undefined {
	if (iso === null) return undefined;
	if (isAllDay) return iso; // 既に "YYYY-MM-DD"。
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Event → EventSnapshot(差分レンズ用の自己完結スナップショット)。affected[].event / removed が使う。
 */
export function snapshotFromEvent(event: Event): EventSnapshot {
	const start = formatInstantDisplay(event.start, event.isAllDay);
	const end = formatInstantDisplay(event.end, event.isAllDay);
	return {
		id: event.id,
		title: event.title,
		...(start !== undefined ? { start } : {}),
		...(end !== undefined ? { end } : {}),
		...(event.location !== null ? { location: event.location } : {}),
		isAllDay: event.isAllDay,
	};
}

/**
 * update-event の「変更されたフィールド」から edited の changes 配列を作る(todos-diff.ts の
 * buildEditedChanges と対称)。start/end/location は短文 before/after、notes/recurrence は field のみ。
 *
 * @param provided title/notes/start/end/location/url/recurrence/alarms/travelMinutes のうち、ツール引数で指定された(非 undefined)フィールド名。
 */
export function buildEventEditedChanges(before: Event, after: Event, provided: ReadonlySet<string>): AffectedEvent["changes"] {
	const changes: NonNullable<AffectedEvent["changes"]> = [];

	if (provided.has("title")) {
		if (before.title.length <= TITLE_DIFF_MAX_LEN && after.title.length <= TITLE_DIFF_MAX_LEN) {
			changes.push({ field: "title", before: before.title, after: after.title });
		} else {
			changes.push({ field: "title" });
		}
	}

	if (provided.has("start")) {
		const b = formatInstantDisplay(before.start, before.isAllDay);
		const a = formatInstantDisplay(after.start, after.isAllDay);
		changes.push({ field: "start", ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
	}

	if (provided.has("end")) {
		// end は before/after のどちらかが null(未設定)になりうる(除去/新規付与)。null はキー省略。
		const b = formatInstantDisplay(before.end, before.isAllDay);
		const a = formatInstantDisplay(after.end, after.isAllDay);
		changes.push({ field: "end", ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
	}

	if (provided.has("location")) {
		// location は住所等で長くなりうるので短文 before/after を載せず field のみ(todos-diff.ts と同じ判断)。
		changes.push({ field: "location" });
	}

	if (provided.has("url")) {
		// url も長くなりうる + そのまま表示すると崩れやすいので field のみ(スコープ追加時の指示どおり)。
		changes.push({ field: "url" });
	}

	if (provided.has("notes")) {
		changes.push({ field: "notes" });
	}

	if (provided.has("recurrence")) {
		changes.push({ field: "recurrence" });
	}

	if (provided.has("alarms")) {
		// 通知は件数/分の列で before/after を短文化しづらい(かつ UI は最新スナップショットの
		// alarms を直接読める)ので field のみ。todos の notes/recurrence と同じ degrade 判断。
		changes.push({ field: "alarms" });
	}

	if (provided.has("travelMinutes")) {
		changes.push({ field: "travelMinutes" });
	}

	return changes.length > 0 ? changes : undefined;
}
