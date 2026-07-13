// =============================================================================
// mcp/todos-diff — mutate 差分メタ(affected/removed)の表示用正規化(E-2 スライス②)
// =============================================================================
//
// 【責務】mutate ツールが返す AffectedTask.changes / RemovedTask.due の「表示用の短い正規化
// 文字列」を作る。UI(別実装)にそのまま出せる人間可読の短文にし、生 ISO(...T09:00:00+09:00)や
// 生 RRULE は載せない(contract の合意。UI が生値を整形し直す責務を持たなくて済むように、
// 整形は truth surface を作る presentation 側=ここで済ませる)。
//
// 【なぜ application の task-dto を再利用せず薄い整形をここに置くか】
// task-dto.taskFromVTodo は既に「due を自ゾーンの ISO/日付」に整形済みの Task を返す。差分表示に
// 必要なのは「その Task.due を UI 向けにさらに短くする」だけなので、日時計算はやり直さず
// Task の整形済みフィールドを文字列加工する(タイムゾーン計算の二重化を避ける)。
// =============================================================================

import type { Task } from "../../application/usecases";
import type { AffectedTask, TaskSnapshot } from "./todos-view-model";

// title の before/after をそのまま載せる上限長。これを超える長いタイトルは changes に before/after を
// 載せず field だけにする(UI は「編集済みバッジ」に degrade)。60 は chat UI の 1 行に収まる目安で、
// 厳密な根拠より「長文を差分に流し込まない」ことが目的の緩いガード。
const TITLE_DIFF_MAX_LEN = 60;

/**
 * Task.due(整形済み: 終日は "YYYY-MM-DD"、時刻付きは自ゾーン ISO)を UI 表示用の短文にする。
 * - 終日          : "2026-07-15"(そのまま)。
 * - 時刻付き ISO  : "2026-07-15 14:00"(日付と時分だけ。秒/offset は落とす)。
 *
 * 【"明日 14:00" のような相対表現を採らない理由(2026-07-13 判断)】
 * contract 例には相対表現("明日 14:00")もあったが、相対表現は「今(now)」と表示ロケール・
 * タイムゾーンに依存し、サーバー側で確定的に作ると UI 側の now とズレて嘘になりうる(差分の
 * before/after で「明日」が指す日が UI 描画時にはもう当日、という不整合)。相対化は now を持つ
 * UI の責務に寄せ、サーバーは絶対の短い正規化文字列だけを渡す(生 ISO は載せない、という
 * contract の主眼はここで満たしている)。UI が相対表示したければ due の絶対値から自前で導出できる。
 */
export function formatDueDisplay(task: Task): string | undefined {
	if (task.due === null) return undefined;
	if (task.isAllDay) return task.due; // 既に "YYYY-MM-DD"。
	// 時刻付きは自ゾーン ISO("2026-07-15T14:00:00+09:00" / "...Z")。日付 + 時分だけ抜く。
	// slice で十分(Task.due の時刻付き形は epochToIsoLocal 由来で必ず "YYYY-MM-DDTHH:MM:SS..." 固定長)。
	const date = task.due.slice(0, 10);
	const time = task.due.slice(11, 16);
	return `${date} ${time}`;
}

/**
 * PRIORITY(0-9)を iOS 準拠の表示語に正規化する(create-todo の description と同じ 1=高/5=中/9=低)。
 * 0 は「未設定」なので "なし"。1-4 を高、5 を中、6-9 を低に寄せる(iOS の 3 段階 UI に合わせた区分。
 * 中間値は iOS も上下どちらかの段階に丸めて表示するため、ここでも段階に丸める)。
 */
export function formatPriorityDisplay(priority: number): string {
	if (priority === 0) return "なし";
	if (priority <= 4) return "高";
	if (priority === 5) return "中";
	return "低";
}

/**
 * Task → TaskSnapshot(差分レンズ用の自己完結スナップショット・案X 2026-07-13)。
 * affected[].task / removed の両方がこれを使う(対称化)。
 *
 * 【なぜここで表示整形まで済ませるか】formatDueDisplay/formatPriorityDisplay は既にこのファイルの
 * 責務(mutate 差分メタの表示用正規化)。UI に生 ISO/生 PRIORITY を渡さない contract をここでも
 * 一貫させる — snapshot だけ整形を怠ると UI 側が2種類の due 形式(生ISO と表示短文)を
 * 相手にする羽目になる。
 */
export function snapshotFromTask(task: Task): TaskSnapshot {
	const due = formatDueDisplay(task);
	// priority=0(未設定)は表示語を出さない(snapshot では省略 = UI で「なし」を描かない)。
	const priority = task.priority > 0 ? formatPriorityDisplay(task.priority) : undefined;
	return {
		id: task.id,
		title: task.title,
		...(due !== undefined ? { due } : {}),
		...(priority !== undefined ? { priority } : {}),
		isAllDay: task.isAllDay,
	};
}

/**
 * update-todo の「変更されたフィールド」から edited の changes 配列を作る。
 *
 * 【変更フィールドの判定方針(素朴判定・server.ts の呼び出し側と対)】
 * UpdateTodo UC は「実際に変わったフィールド」を返さないため、呼び出し側(server.ts)は
 * 「ツール引数に渡された(= undefined でない)フィールド」を changed とみなす素朴判定を採る。
 * この関数はその provided フィールド集合を受け取り、before(更新前 Task)/after(更新後 Task)から
 * 表示値を引く。値が実際には同じでも(例: 既に "高" のタスクに priority:1 を再指定)changes に
 * 出るが、「ユーザーがそのフィールドを指定した」事実は正しく、UI 上も無害(before==after で
 * 演出が空振りするだけ)。UC を変えずに差分を presentation で組む方針の割り切り。
 *
 * @param provided title/notes/due/priority のうち、ツール引数で指定された(非 undefined)フィールド名。
 */
export function buildEditedChanges(before: Task, after: Task, provided: ReadonlySet<string>): AffectedTask["changes"] {
	const changes: NonNullable<AffectedTask["changes"]> = [];

	if (provided.has("title")) {
		// 短ければ before/after を載せ、長ければ field だけ(UI は編集済みバッジに degrade)。
		if (before.title.length <= TITLE_DIFF_MAX_LEN && after.title.length <= TITLE_DIFF_MAX_LEN) {
			changes.push({ field: "title", before: before.title, after: after.title });
		} else {
			changes.push({ field: "title" });
		}
	}

	if (provided.has("due")) {
		// due は表示用短文(生 ISO は載せない)。null → 省略(before/after のどちらかが未設定なら
		// そのキーを省く = UI 側で「未設定 → 値」/「値 → 未設定」を表現できる)。
		const beforeDue = formatDueDisplay(before);
		const afterDue = formatDueDisplay(after);
		changes.push({ field: "due", ...(beforeDue !== undefined ? { before: beforeDue } : {}), ...(afterDue !== undefined ? { after: afterDue } : {}) });
	}

	if (provided.has("priority")) {
		changes.push({ field: "priority", before: formatPriorityDisplay(before.priority), after: formatPriorityDisplay(after.priority) });
	}

	if (provided.has("notes")) {
		// notes は自由記述で長くなりがち。before/after を差分に流し込まず field だけ載せる
		// (UI は「メモを編集した」バッジに degrade)。contract の「notes は field のみ」方針どおり。
		changes.push({ field: "notes" });
	}

	return changes.length > 0 ? changes : undefined;
}
