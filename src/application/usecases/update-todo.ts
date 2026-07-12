// =============================================================================
// UpdateTodo ユースケース — 既存 VTODO の部分更新(方向性 E-1 スライス②-b)
// =============================================================================
//
// 【この UC が担う範囲】
// chat(MCP `update-todo` ツール)から既存 VTODO の一部フィールドを書き換える。
// title/notes/due/priority は domain/ical/semantics/vtodo-patch.ts の patchVTodoFields に
// そのまま委譲する(「与えられたフィールドのみ upsert・他は一切触れない」契約はそちらが持つ)。
// status(COMPLETED/NEEDS-ACTION)は同じ patch.ts の applyCompletion/applyReopen を使う —
// 「完了/再開」という状態遷移はフィールド patch と別の意味を持つ操作だが、UpdateTodo の
// 入力に status を含めることで「1回の chat 操作で複数フィールドとステータスを同時に変えたい」
// (例: 「due を来週に伸ばして完了にして」)ケースを1回の PUT にまとめられる利点がある。
// 単発の完了操作だけを行いたい場合は CompleteTodo(complete-todo.ts)の方が薄くて済む
// (RecurringCompletionNotSupportedError の判定など完了専用の関心を持たないため)。
//
// 【lossless read→patch→PUT の実装方法】
// 1. lookupTodo で対象 VTODO を含む CalendarObjectResource を取得(resource.payload.raw が
//    VCALENDAR の Component 全体 — VTIMEZONE や他のプロパティも保持している)。
// 2. patch 後の VTODO Component を作る(patchVTodoFields → 必要なら applyCompletion/
//    applyReopen → 最後に stampUpdate)。
// 3. VCALENDAR.components 配列の「対象 VTODO だけ」を patch 後の Component に差し替える
//    (VTIMEZONE 等の他のサブコンポーネントはそのまま = 配列の他要素は触らない)。
// 4. serialize() で ICS 化し、PutCalendarObject を must-match(現在の ETag)で呼ぶ
//    (楽観ロック。lookupTodo 時点と PUT 時点の間に他プロセスが書き換えていたら 412 相当の
//    ETagConditionError を呼び出し側 MCP ツールがそのまま返す)。
// =============================================================================

import { ICalendarObject, serialize, type Component } from "../../domain/ical";
import { applyCompletion, applyReopen, patchVTodoFields, stampUpdate } from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import { InvalidDueError } from "./create-todo";
import { RecurringCompletionNotSupportedError } from "./complete-todo";
import { nowStampFromDate } from "./now-stamp";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import type { CalendarObjectResourceRepository } from "../ports";

// YYYY-MM-DD の厳密マッチ。create-todo.ts と同じ正規表現(意味も同じなので複製せず
// 再定義してもよいレベルの1行だが、create-todo.ts 側は非公開 const のため import できない
// — 公開昇格させるほどの重複でもないと判断しこのファイルにも定義する)。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- 入力 DTO ---

export interface UpdateTodoInput {
	owner: PrincipalRef;
	/** 更新対象の VTODO UID。 */
	todoId: string;
	/** 保存先コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
	/** SUMMARY。省略時は変更しない。 */
	title?: string;
	/** DESCRIPTION。省略時は変更しない。 */
	notes?: string;
	/** 期日。"YYYY-MM-DD" のみ(create-todo.ts と同じ制約)。省略時は変更しない。 */
	due?: string;
	/** PRIORITY(0-9)。0 は「未設定に戻す」(vtodo-patch.ts 参照)。省略時は変更しない。 */
	priority?: number;
	/**
	 * STATUS の遷移。"COMPLETED" で完了・"NEEDS-ACTION" で未完了に戻す。省略時は変更しない。
	 * 【CompleteTodo と同じガードを status:"COMPLETED" にも適用する(2026-07-12 レビューで確定)】
	 * 実装時点では「UpdateTodo は汎用フィールド patch なので反復 VTODO のチェックを持たせない」
	 * という設計だったが、それだと chat から `update-todo(status:"COMPLETED")` を呼ぶだけで
	 * CompleteTodo が防いでいる誤動作(反復 VTODO のマスター自体を完了扱いにしてしまい、
	 * 以降の全 occurrence が消えたように見える — docs/modeling/06 §D4)を素通りさせてしまう
	 * 抜け道になる。「完了」という意味を持つ操作である以上、入口が CompleteTodo でも
	 * UpdateTodo.status でも同じ不変条件(反復 VTODO は単純な STATUS:COMPLETED では
	 * 完了させない)を守るべきと判断し、ここでも RecurringCompletionNotSupportedError を
	 * 再利用して reject する(execute() 内の分岐参照)。NEEDS-ACTION への reopen は反復性に
	 * 関係なく安全な操作なのでガードしない。
	 */
	status?: "COMPLETED" | "NEEDS-ACTION";
}

// --- 出力 DTO ---

export interface UpdateTodoOutput {
	task: Task;
}

export type UpdateTodoError =
	| InvalidDueError
	| TodoNotFoundError
	| RecurringCompletionNotSupportedError
	| PutCalendarObjectError;

export class UpdateTodo {
	// 【resourceRepo を別途受け取る理由(CreateTodo との違い)】
	// CreateTodo は PutCalendarObject だけを合成すればよかった(新規リソースは lookup 不要)が、
	// UpdateTodo/CompleteTodo/DeleteTodo はまず lookupTodo で対象を特定する必要があり、
	// lookupTodo は CalendarObjectResourceRepository を直接必要とする。PutCalendarObject は
	// resourceRepo を private に抱え込んでいて外へ公開しないため(put-calendar-object.ts の
	// カプセル化方針)、この UC は resourceRepo を PutCalendarObject とは別に、もう一度
	// コンストラクタで受け取る(合成済み完成品への依存 + 素の port 依存が両方ある形。
	// CreateTodo の「PutCalendarObject だけを知っていればよい」という単純な合成の利点は
	// 失われるが、lookup を UC 側で行う以上避けられないトレードオフと判断した)。
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: UpdateTodoInput): Promise<UpdateTodoOutput> {
		let due: string | undefined;
		if (input.due !== undefined) {
			if (!DATE_ONLY_RE.test(input.due)) {
				throw new InvalidDueError(input.due);
			}
			due = input.due.replace(/-/g, "");
		}

		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		let patched: Component = patchVTodoFields(looked.vtodo.raw, {
			summary: input.title,
			description: input.notes,
			due,
			dueValueType: due !== undefined ? "DATE" : undefined,
			priority: input.priority,
		});

		if (input.status === "COMPLETED") {
			// CompleteTodo と同じ不変条件(反復 VTODO は単純な STATUS:COMPLETED では完了させない)を
			// ここでも守る(入力コメント参照)。lookupTodo が返す vtodo は patch 前の生 Component
			// レンズなので、rrule の有無はここで判定する(patchVTodoFields は RRULE に触れないので
			// looked.vtodo.rrule の判定結果は patched 後も変わらない)。
			if (looked.vtodo.rrule !== undefined) {
				throw new RecurringCompletionNotSupportedError(input.todoId);
			}
			patched = applyCompletion(patched, nowStampFromDate(new Date()));
		} else if (input.status === "NEEDS-ACTION") {
			patched = applyReopen(patched);
		}

		patched = stampUpdate(patched, nowStampFromDate(new Date()));

		// VCALENDAR.components の対象 VTODO だけを patch 後の Component に差し替える。
		// 他のサブコンポーネント(VTIMEZONE 等)はそのまま保持する(ロスレス編集の核心)。
		const vcalendar = looked.resource.payload.raw;
		const components = vcalendar.components.map((c) => (c === looked.vtodo.raw ? patched : c));
		const newVcalendar: Component = { ...vcalendar, components };
		const ics = serialize(newVcalendar);

		const result = await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: looked.resourceUri,
			ics,
			condition: { kind: "must-match", etag: looked.etag.hex },
		});
		void result;

		const obj = ICalendarObject.fromComponent(newVcalendar);
		const vtodo = obj.todos().find((t) => t.uid === input.todoId) ?? obj.todos()[0];
		if (vtodo === undefined) {
			throw new Error("UpdateTodo: internal error — patched VTODO not found after round-trip");
		}

		return { task: taskFromVTodo(vtodo) };
	}
}
