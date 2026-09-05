// =============================================================================
// presentation/mcp/ui/todos-input.ts — todos structuredContent の受信正規化
// =============================================================================
// todos-entry.ts は DOM 前提で直接単体テストしにくいため、受信境界の純粋な値変換をここへ隔離する。
// ホストから受信するデータで nullable な task フィールドが未設定時にキーごと省略されても、
// カード内の TodoItem は「未設定 = null」という1つの形で描画・編集ロジックへ渡す契約を持つ。

/** 受信 task の共通識別子と nullable フィールドを、カード内で扱うための最小入力形。 */
export interface TodoWithOptionalNullableFields {
	id: string;
	status?: string | null;
	due?: string | null;
	percentComplete?: number | null;
	completedAt?: string | null;
	notes?: string | null;
	sortOrder?: number | null;
	location?: string | null;
	recurrence?: unknown | null;
	structuredLocation?: unknown | null;
	proximityAlarm?: unknown | null;
}

interface NormalizedTodoNullableFields {
	status: string | null;
	due: string | null;
	percentComplete: number | null;
	completedAt: string | null;
	notes: string | null;
	sortOrder: number | null;
	location: string | null;
	recurrence: unknown | null;
	structuredLocation: unknown | null;
	proximityAlarm: unknown | null;
}

/**
 * structuredContent.tasks の1行をカード内の nullable フィールド契約へ正規化する。
 *
 * 未設定の nullable キーだけを null に補い、文字列・数値と明示的な null は値を変えない。
 * ここで正規化する理由は、各フィールドを使う描画・編集経路の前に全入口を通せる唯一の
 * 受信境界だからである。formatter 側を都度 undefined 対応にすると、経路ごとの漏れが残り
 * TodoItem の契約も曖昧になるため採らない。title など必須フィールドはこの helper で補完しない。
 */
export function normalizeTodoTask<T extends TodoWithOptionalNullableFields>(task: T): T & NormalizedTodoNullableFields {
	return {
		...task,
		status: task.status ?? null,
		due: task.due ?? null,
		percentComplete: task.percentComplete ?? null,
		completedAt: task.completedAt ?? null,
		notes: task.notes ?? null,
		sortOrder: task.sortOrder ?? null,
		location: task.location ?? null,
		recurrence: task.recurrence ?? null,
		structuredLocation: task.structuredLocation ?? null,
		proximityAlarm: task.proximityAlarm ?? null,
	};
}
