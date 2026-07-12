// =============================================================================
// CompleteTodo ユースケース — VTODO の完了操作(方向性 E-1 スライス②-b 単発 → ②-c 反復対応)
// =============================================================================
//
// 【なぜ UpdateTodo.status とは別に専用 UC を用意するのか】
// 「完了する」は chat から最も頻繁に呼ばれるであろう単純操作なので、MCP ツールとして
// 薄い専用の入口(id だけ渡せば完了する)を用意する。
//
// 【反復 VTODO の完了(②-c で D4 モデルに差し替えた経緯)】
// docs/modeling/06-ios-behavior-verification.md §D4: iOS 実機の反復 VTODO 完了は
// 「新 UID で完了スナップショットを作り、マスターの DTSTART/DUE を次の occurrence へ前進させる」
// というモデル。②-b の時点ではこのモデルが未実装だったため RecurringCompletionNotSupportedError
// で明示的に拒否していた(黙って単純な STATUS:COMPLETED を書くと、マスター自体を完了扱いに
// してしまい以降の全 occurrence が消えたように見える重大な誤動作になるため)。②-c で
// domain/ical/semantics/vtodo-recurrence.ts(buildCompletionSnapshot/advanceMasterToNextOccurrence)
// + application/usecases/recurring-completion.ts(completeRecurringTodo。2 PUT オーケストレーション)
// を実装したので、この reject 分岐は completeRecurringTodo の呼び出しに置き換えた。
// =============================================================================

import { ICalendarObject, serialize, type Component } from "../../domain/ical";
import { applyCompletion, stampUpdate } from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import type { RecurrenceIterator } from "../../domain/ical/recurrence";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import { completeRecurringTodo } from "./recurring-completion";
import { nowStampFromDate } from "./now-stamp";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface CompleteTodoInput {
	owner: PrincipalRef;
	/** 完了対象の VTODO UID。 */
	todoId: string;
	/** 保存先コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
}

// --- 出力 DTO ---

export interface CompleteTodoOutput {
	task: Task;
}

export type CompleteTodoError = TodoNotFoundError | PutCalendarObjectError;

export class CompleteTodo {
	// UpdateTodo と同じ理由(resourceRepo を別途受け取る)。update-todo.ts のコンストラクタ
	// コメント参照。recurrenceIterator は②-c で追加(completeRecurringTodo が RRULE 前進に使う。
	// PutCalendarObject 自身も同じ port を内部で持つが、あちらはカプセル化されていて外へ
	// 公開しないため、ここでも put-calendar-object.ts と同じ理由でもう一度別途受け取る)。
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: CompleteTodoInput): Promise<CompleteTodoOutput> {
		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		if (looked.vtodo.rrule !== undefined) {
			// D4 モデル(新 UID スナップショット + マスター前進)へ委譲する(②-c)。
			const { task } = await completeRecurringTodo(
				{ putCalendarObject: this.putCalendarObject, recurrenceIterator: this.recurrenceIterator },
				{ owner: input.owner, collectionId, looked, masterVtodo: looked.vtodo.raw, now: nowStampFromDate(new Date()) },
			);
			return { task };
		}

		let patched: Component = applyCompletion(looked.vtodo.raw, nowStampFromDate(new Date()));
		patched = stampUpdate(patched, nowStampFromDate(new Date()));

		const vcalendar = looked.resource.payload.raw;
		const components = vcalendar.components.map((c) => (c === looked.vtodo.raw ? patched : c));
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
		const vtodo = obj.todos().find((t) => t.uid === input.todoId) ?? obj.todos()[0];
		if (vtodo === undefined) {
			throw new Error("CompleteTodo: internal error — patched VTODO not found after round-trip");
		}

		return { task: taskFromVTodo(vtodo) };
	}
}
