// =============================================================================
// presentation/mcp/ui/todos-input.ts — todos structuredContent の受信正規化
// =============================================================================
// todos-entry.ts は DOM 前提で直接単体テストしにくいため、受信境界の純粋な値変換をここへ隔離する。
// ホストから受信するデータで nullable な `due` が未設定時にキーごと省略されても、カード内の
// TodoItem は「未設定 = null」という1つの形で描画・編集ロジックへ渡す契約を持つ。

/** 受信 task の共通識別子と due 欠落を、カード内で扱うための最小入力形。 */
export interface TodoWithOptionalDue {
	id: string;
	due?: string | null;
}

/**
 * structuredContent.tasks の1行をカード内の due 契約へ正規化する。
 *
 * `due` の省略だけを補い、文字列と明示的な null は値を変えない。ここで正規化する理由は、
 * `wallDatePart` や due セクション判定を呼ぶ前に全入口を通せる唯一の受信境界だからである。
 * formatter 側を `undefined` 対応にすると、期日を使う各描画・編集経路へ欠落値が漏れ続け、
 * TodoItem の契約も曖昧になるため採らない。
 */
export function normalizeTodoDue<T extends TodoWithOptionalDue>(task: T): T & { due: string | null } {
	return { ...task, due: task.due ?? null };
}
