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
// 【kind 絞りは SQL、STATUS・DUE はメモリフィルタである理由(2026-07-14 更新)】
// 当初は CalendarObjectResourceRepository.findAllInCollection(コレクション内の全リソースを
// 返す既存ポート)で VEVENT/VJOURNAL も含めて全件を引き、component 種別・STATUS・DUE の
// フィルタを全部この UC のメモリ上で行っていた。本番実測(list-todos avg 706ms)でこれが
// 主因と判明したため、component_kind="VTODO" の絞り込みだけを findVTodosInCollection
// (ports/index.ts のコメント参照)で SQL 側に押し出した。STATUS(完了状態)は D1 に列が
// 無いため今回はメモリ判定のまま(理由は findVTodosInCollection 側のコメントに集約)。
// G-3 の time-range 専用索引 findInCollectionByTimeRange は VEVENT 想定の occurrence bounds
// 前提で VTODO の「単発 due」フィルタには過剰なため、DUE の絞り込みも引き続きメモリで行う。
// =============================================================================

import type { CalendarObjectResource, CollectionId, PrincipalRef } from "../../domain/caldav";
import { collectionId as mkCollectionId } from "../../domain/caldav";
import { zoneResolverFor } from "../../domain/ical/recurrence";
import { calDateStartEpochMillis } from "../../domain/ical/timezone";
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
	/**
	 * 対象コレクション ID。
	 *
	 * 【K3(2026-07-23)で意味を変えた点】旧実装は省略時に既定コレクション "tasks" だけを見ていた
	 * (todos カードは「1カード=1コレクション」前提で、切替のたびに calendarId 指定で再往復して
	 * いた)。K3 は「初回に全 VTODO コレクションを横断取得 → 切替はクライアント側フィルタ」へ
	 * 変えるため、**省略時(undefined)は owner 配下の全 VTODO コレクション横断**に意味を変える
	 * (findByOwnerTimeRange の「undefined=全横断」契約と合わせる)。明示文字列 "all" も同じ扱い
	 * (親仕様の指示 — MCP ツール入力で「省略」と「明示的に全部」を区別したい呼び出し元のため)。
	 * 【後方互換への影響】単一コレクションを指定する呼び出し(calendarId: "other-tasks" 等)は
	 * 完全に不変。省略呼び出しは「"tasks" だけ」→「全コレクション横断」に振る舞いが変わるが、
	 * VTODO コレクションが "tasks" 1つしか無い環境(既存テストの大半・多くの実運用アカウント)では
	 * 観測できる差が無い(結果集合が同じになる)。複数 VTODO コレクションを持つ環境でだけ挙動が
	 * 変わる(= このタスクの目的そのもの)。
	 */
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

/**
 * "YYYY-MM-DD"(Task.due の終日形。formatCalDateAsIso 出力と同形)を CalDate へ戻す。
 * サーバー自身が taskFromVTodo で生成した形式なので構文検証はせず素朴に split する
 * (外部入力ではなく自己生成データの往復なので、cal-date.ts の厳格パーサを持ち込む必要が無い)。
 */
function parseAllDayDue(due: string): { year: number; month: number; day: number } {
	const [year, month, day] = due.split("-").map(Number);
	return { year, month, day };
}

/**
 * 【2026-07-23 症状B再発対策で抽出】ListTodos.execute の「STATUS(完了) + DUE 窓」フィルタを
 * Task[] 段階の純関数として export する。
 *
 * 【なぜ抽出したか(経緯)】completedSummary(症状B対策・todos-view-model.ts の completedSummary
 * JSDoc 参照)は buildTodosViewModel(presentation/mcp/server.ts)が「due 非フィルタの全完了済み」
 * から計算する必要がある。しかし当初の実装は ListTodos.execute を dueBefore/dueAfter 込みで
 * 1回呼ぶだけだったため、モデルが「今週のタスク」等 due 窓付きで list-todos を叩くと、その
 * 応答の completedSummary.total が due 窓で痩せてしまい(症状Bの「どんな view の push でも
 * サマリは不変」という治療原則が再発)、コーディネーターの指摘で修正が必要になった。
 * 【なぜ SQL 側 dueBefore/dueAfter を追加せず Task[] 段階の純関数にしたか】
 *   (1) D1 SELECT を1回に保つ制約(IAD レイテンシ事情)がある以上、buildTodosViewModel は
 *       「includeCompleted:true・due 無し」で1回 execute して得た全件(allTasks)を
 *       completedSummary と tasks の両方の元にしたい。
 *   (2) due 窓判定のロジック(offset ISO パース・終日/時刻付きの epoch 変換規則)を presentation
 *       に複製すると、ここ(application)と presentation の2箇所で判定がズレる事故リスクを
 *       抱える(single source of truth 違反)。よって判定そのものを export し、
 *       buildTodosViewModel はこの関数を呼ぶだけにする(依存方向は presentation→application で
 *       層規律に反しない)。
 *   (3) ListTodos.execute 自身もこの関数を内部で使うようリファクタした(下記)。UC 自身の
 *       出力と、presentation が同じ関数で再現する出力が構造的に一致することを保証する
 *       (2箇所で「同じつもりのロジック」が経年でズレる事故を型ではなく構造で防ぐ)。
 * 【Task[] 段階で判定して原本(vtodo/CalDate)の再解析を避けた理由】taskFromVTodo が既に due を
 * 「終日は 'YYYY-MM-DD' / 時刻付きは epochToIsoLocal 由来の offset 付き絶対 ISO(オフセット込みで
 * 一意な瞬間を表す)」に整形済み(task-dto.ts の formatDue 参照)。時刻付きは Date.parse するだけで
 * 元の判定と同じ epoch millis が得られる(表示ゾーンが変わっても instant は不変なため)。終日は
 * 元の判定と同じ計算(calDateStartEpochMillis + 呼び出し時の timeZone)を再現するため、
 * "YYYY-MM-DD" を CalDate へ戻してから同じ domain 関数に通す(このリパースだけが「複製」だが、
 * epoch 計算そのもの=判定の核はここでも同じ domain 関数を呼ぶので実質的な重複ロジックではない)。
 */
export interface TaskWindowFilter {
	includeCompleted?: boolean;
	dueBefore?: string;
	dueAfter?: string;
	timeZone?: string;
}

export function filterTasksByWindow(tasks: Task[], filter: TaskWindowFilter): Task[] {
	const includeCompleted = filter.includeCompleted ?? false;
	const timeZone = filter.timeZone ?? "UTC";
	const dueBeforeMillis = filter.dueBefore !== undefined ? parseOffsetIso(filter.dueBefore) : undefined;
	const dueAfterMillis = filter.dueAfter !== undefined ? parseOffsetIso(filter.dueAfter) : undefined;

	return tasks.filter((task) => {
		if (!includeCompleted && task.completed) return false;

		if (dueBeforeMillis !== undefined || dueAfterMillis !== undefined) {
			// due 無しは「期限が無い」= scheduled ではないので、dueBefore/dueAfter が
			// 指定されている以上は対象外にする(仕様の指示どおり。元実装と同じ規則)。
			if (task.due === null) return false;
			const dueMillis = task.isAllDay
				? calDateStartEpochMillis(parseAllDayDue(task.due), timeZone)
				: Date.parse(task.due); // 時刻付きは offset 込みの絶対 ISO なので Date.parse で足りる。
			if (dueBeforeMillis !== undefined && !(dueMillis < dueBeforeMillis)) return false;
			if (dueAfterMillis !== undefined && !(dueMillis > dueAfterMillis)) return false;
		}

		return true;
	});
}

export class ListTodos {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: ListTodosInput): Promise<ListTodosOutput> {
		const timeZone = input.timeZone ?? "UTC";
		// K3: calendarId 省略 または明示 "all" は owner 横断(ListTodosInput.calendarId の JSDoc 参照)。
		// それ以外(具体的なコレクション ID 文字列)は従来どおり単一コレクション。
		const acrossOwner = input.calendarId === undefined || input.calendarId === "all";

		// 2026-07-14: component_kind="VTODO" の絞り込みを SQL 側に押し出した(ファイル冒頭コメント)。
		// findAllInCollection → メモリで componentKind==="VTODO" を判定、から置き換え。
		// K3: 横断時は findVTodosByOwner(1クエリ・全コレクション)、単一時は従来の
		// findVTodosInCollection を使う。どちらも「resource, その所属 collectionId」のペアへ正規化
		// してから同じループで Task 化する(D1 SELECT は常に1回のまま — 仕様「D1 クエリは1回」を守る)。
		let resources: { resource: CalendarObjectResource; collectionId: CollectionId }[];
		if (acrossOwner) {
			const matches = await this.resourceRepo.findVTodosByOwner(input.owner);
			resources = matches.map((m) => ({ resource: m.resource, collectionId: m.collectionId }));
		} else {
			const collectionId: CollectionId = mkCollectionId(input.calendarId as string);
			const found = await this.resourceRepo.findVTodosInCollection(input.owner, collectionId);
			resources = found.map((resource) => ({ resource, collectionId }));
		}

		// 【2026-07-23 リファクタ】STATUS(完了)・DUE 窓のフィルタはもうこのループの中で行わない —
		// ここでは resource → Task の変換だけを行い(全件・無条件)、フィルタは下の
		// filterTasksByWindow(export 済みの純関数)にまとめて委譲する。ループ内で直接 continue して
		// いた旧実装と比べて中間配列が1つ増えるが、単一コレクション分の全 VTODO 件数は小さく
		// (D1 の1 SELECT 分)実害は無い。見返りとして「STATUS/DUE 窓の判定ロジックが1箇所だけに
		// 存在する」という不変条件が手に入る(buildTodosViewModel が同じ関数を呼べる・ズレない)。
		const allTasks: Task[] = [];
		for (const { resource, collectionId } of resources) {
			// master(RECURRENCE-ID 無し)を1件として扱う。反復展開はしない方針(ファイル冒頭)。
			// todos() は同一 UID の master + オーバーライドを返しうるが、VTODO はこの実装では
			// オーバーライドを想定していない(put-calendar-object.ts の VTODO bounds 計算コメント
			// 「反復 VTODO の展開自体をスコープ外にしている」と同じ前提)ので先頭要素を master とみなす。
			const vtodo = resource.payload.todos()[0];
			if (vtodo === undefined) continue;
			const zoneOf = zoneResolverFor(resource.payload);
			const task = taskFromVTodo(vtodo, zoneOf, timeZone);
			// K3: どのコレクション由来かを additive に添える(単一コレクション指定時も含め常にセット。
			// 「サーバーは常に埋める」規律は Task.calendarId の JSDoc 参照。UI が横断/単一どちらの
			// 応答でも同じフィールドでコレクションを判別できるようにするため、単一指定時にも省かない)。
			task.calendarId = collectionId;
			allTasks.push(task);
		}

		const tasks = filterTasksByWindow(allTasks, input);

		// 既定の並び順: X-APPLE-SORT-ORDER 昇順(iOS のリマインダーアプリの並びに合わせる —
		// スライス②-a で導入)。sortOrder が無い(サーバー生成前の古いデータ等)ものは末尾に
		// 送る。同値(または両方 null)は id(UID)でタイブレークして結果を決定的にする
		// (Array.sort は安定ソートだが、findAllInCollection の返却順を前提にしたくないため
		// 明示的に比較関数へ入れる)。
		// 【ソートモードは足さない判断】due/priority 昇順などのモード切り替えは非同期の
		// クライアント責務とし、DTO に due/priority/title が既に載っているので MCP-app 側で
		// 並べ替え可能(仕様どおり)。ここでは「サーバーが持つ唯一の順序情報」である
		// X-APPLE-SORT-ORDER を機械的に適用するだけに留める。
		tasks.sort((a, b) => {
			if (a.sortOrder === null && b.sortOrder === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			if (a.sortOrder === null) return 1;
			if (b.sortOrder === null) return -1;
			if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

		return { tasks };
	}
}
