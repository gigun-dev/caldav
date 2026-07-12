// =============================================================================
// ListTodos ユースケース — 方向性 E-1 スライス①(MCP からの VTODO 一覧)
// =============================================================================
//
// 【この UC が担う範囲】
// 指定コレクション(既定 "tasks")配下の VTODO を一覧する。ListOccurrences(VEVENT 専用の
// 展開一覧)とは異なり、**反復展開は行わない**(RRULE 付きの master も1行として返す —
// 「VTODO の反復インスタンス管理は iOS でも master 単位」という前提。展開が要る要件が
// 出たら別 UC を足す。仕様の指示どおり、既存の反復 VTODO も壊さず一覧できることだけを担保する)。
//
// 【全件取得 + メモリフィルタである理由】
// CalendarObjectResourceRepository.findAllInCollection は「コレクション内の全リソース」を返す
// ポート(既存の設計。G-3 の time-range 専用索引 findInCollectionByTimeRange は VEVENT 想定の
// occurrence bounds 前提で、VTODO の「単発 due」フィルタには過剰). iOS の Tasks コレクションは
// 実運用で数千件未満(findAllInCollection のコメントと同じ前提)なので、component 種別・
// STATUS・DUE のフィルタは呼び出し側(この UC)でメモリ上に行う設計にする。
// =============================================================================

import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import { collectionId as mkCollectionId } from "../../domain/caldav";
import { zoneResolverFor } from "../../domain/ical/recurrence";
import { calDateStartEpochMillis, calDateTimeToEpochMillis } from "../../domain/ical/timezone";
import type { CalendarObjectResourceRepository } from "../ports";
import { taskFromVTodo, type Task } from "./task-dto";

// --- 入力 DTO ---

export interface ListTodosInput {
	owner: PrincipalRef;
	/** 完了済み(STATUS:COMPLETED)を含めるか。既定 false(未完了のみ)。 */
	includeCompleted?: boolean;
	/** DUE がこの ISO8601 時刻より前の TODO だけに絞る。due 無しの TODO は除外する
	 *  (「期限を持たない」= dueBefore/dueAfter の対象外というのが自然な解釈のため)。 */
	dueBefore?: string;
	/** DUE がこの ISO8601 時刻より後(以降)の TODO だけに絞る。dueBefore と同じ理由で due 無しは除外。 */
	dueAfter?: string;
	/** 対象コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
	/** DATE-TIME/DATE の due を表示・比較する IANA タイムゾーン。省略時は UTC。 */
	timeZone?: string;
}

// --- 出力 DTO ---

export interface ListTodosOutput {
	tasks: Task[];
}

// offset 付き ISO8601 の厳密マッチ("Z" または "±HH:MM")。presentation/mcp/format.ts の
// parseIsoToEpoch と同じ理由(instant.ts が警告する「ランタイムのローカル TZ 依存で
// floating を誤解釈する」落とし穴を避ける)でここでも同じ形式を要求する。
// import で流用しない理由は task-dto.ts 冒頭コメントと同じ(application → presentation
// import は層境界違反になるため、10行未満のこの正規表現チェックだけ複製する)。
const OFFSET_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseOffsetIso(s: string): number {
	if (!OFFSET_ISO_PATTERN.test(s)) {
		throw new RangeError(`dueBefore/dueAfter must be offset ISO8601 (Z or ±HH:MM), got: "${s}"`);
	}
	return Date.parse(s);
}

export class ListTodos {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: ListTodosInput): Promise<ListTodosOutput> {
		const includeCompleted = input.includeCompleted ?? false;
		const timeZone = input.timeZone ?? "UTC";
		const collectionId: CollectionId = mkCollectionId(input.calendarId ?? "tasks");

		const dueBeforeMillis = input.dueBefore !== undefined ? parseOffsetIso(input.dueBefore) : undefined;
		const dueAfterMillis = input.dueAfter !== undefined ? parseOffsetIso(input.dueAfter) : undefined;

		const resources = await this.resourceRepo.findAllInCollection(input.owner, collectionId);

		const tasks: Task[] = [];
		for (const resource of resources) {
			// componentKind==="VTODO" のみ対象(仕様どおり)。VEVENT/VJOURNAL は無視する。
			if (resource.componentKind !== "VTODO") continue;

			// master(RECURRENCE-ID 無し)を1件として扱う。反復展開はしない方針(ファイル冒頭)。
			// todos() は同一 UID の master + オーバーライドを返しうるが、VTODO はこの実装では
			// オーバーライドを想定していない(put-calendar-object.ts の VTODO bounds 計算コメント
			// 「反復 VTODO の展開自体をスコープ外にしている」と同じ前提)ので先頭要素を master とみなす。
			const vtodo = resource.payload.todos()[0];
			if (vtodo === undefined) continue;

			if (!includeCompleted && vtodo.status === "COMPLETED") continue;

			const zoneOf = zoneResolverFor(resource.payload);

			if (dueBeforeMillis !== undefined || dueAfterMillis !== undefined) {
				const due = vtodo.due;
				// due 無しは「期限が無い」= scheduled ではないので、dueBefore/dueAfter が
				// 指定されている以上は対象外にする(仕様の指示どおり)。
				if (due === undefined) continue;
				const dueMillis = "kind" in due
					? calDateTimeToEpochMillis(due, { zoneOf, floatingTimeZone: timeZone })
					: calDateStartEpochMillis(due, timeZone);
				if (dueBeforeMillis !== undefined && !(dueMillis < dueBeforeMillis)) continue;
				if (dueAfterMillis !== undefined && !(dueMillis > dueAfterMillis)) continue;
			}

			tasks.push(taskFromVTodo(vtodo, zoneOf, timeZone));
		}

		return { tasks };
	}
}
