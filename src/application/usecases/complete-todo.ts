// =============================================================================
// CompleteTodo ユースケース — 単発 VTODO の完了操作(方向性 E-1 スライス②-b、単発のみ)
// =============================================================================
//
// 【なぜ UpdateTodo.status とは別に専用 UC を用意するのか】
// 「完了する」は chat から最も頻繁に呼ばれるであろう単純操作なので、MCP ツールとして
// 薄い専用の入口(id だけ渡せば完了する)を用意する。加えて、この UC は反復 VTODO
// (RRULE あり)を明示的に reject する(下記)責務を持つ — UpdateTodo.status には
// この判定を持たせない設計にした(update-todo.ts の入力コメントに論点として明記済み)。
//
// 【反復 VTODO を reject する理由(D4 スコープ外)】
// docs/modeling/06-ios-behavior-verification.md §D4: iOS 実機の反復 VTODO 完了は
// 「新 UID で完了スナップショットを作り、マスターの DTSTART/DUE を次の occurrence へ前進させる」
// という複雑なモデル。今回のスライス②-b は単発 VTODO のみ対応し、RRULE を持つ VTODO への
// 完了要求は RecurringCompletionNotSupportedError で拒否する(②-c が D4 のモデルで解決する
// 予定 — 黙って単純な STATUS:COMPLETED を書いてしまうと、マスター自体を完了扱いにしてしまい
// 以降の全 occurrence が消えたように見える重大な誤動作になるため、実装せず明示的に拒否する)。
// =============================================================================

import { ICalendarObject, serialize, type Component } from "../../domain/ical";
import { applyCompletion, stampUpdate } from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
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

/**
 * 反復 VTODO(RRULE あり)への完了要求エラー。
 * 【設計判断】D4 のモデル(新 UID スナップショット + マスター前進)は②-c で対応する。
 * 今のところ黙って単発扱いにすると誤動作するため、明示的に reject する。
 */
export class RecurringCompletionNotSupportedError extends Error {
	readonly kind = "RecurringCompletionNotSupportedError" as const;
	constructor(readonly todoId: string) {
		super(
			`Completing recurring VTODO (RRULE) is not yet supported: "${todoId}". ` +
				"This requires the new-UID snapshot model (docs/modeling/06 §D4), planned for a later slice.",
		);
		this.name = "RecurringCompletionNotSupportedError";
	}
}

export type CompleteTodoError = TodoNotFoundError | RecurringCompletionNotSupportedError | PutCalendarObjectError;

export class CompleteTodo {
	// UpdateTodo と同じ理由(resourceRepo を別途受け取る)。update-todo.ts のコンストラクタ
	// コメント参照。
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: CompleteTodoInput): Promise<CompleteTodoOutput> {
		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		if (looked.vtodo.rrule !== undefined) {
			throw new RecurringCompletionNotSupportedError(input.todoId);
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
