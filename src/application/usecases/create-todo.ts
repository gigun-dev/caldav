// =============================================================================
// CreateTodo ユースケース — 方向性 E-1 スライス①(MCP からの VTODO 作成)
// =============================================================================
//
// 【この UC が担う範囲】
// chat(MCP `create-todo` ツール)から VTODO を新規作成する。UID/DTSTAMP はサーバーが
// 生成し、domain/ical/semantics/vtodo-write.ts の buildVTodoCalendar で VCALENDAR+VTODO の
// Component ツリーを組み、serialize() で ICS 化してから、既存の PutCalendarObject を
// must-not-exist(If-None-Match:* 相当)で呼ぶ。**独自の保存経路は作らない**
// (PutCalendarObject が担う precondition 検証・ETag 計算・occurrence bounds 索引・
// コレクション変更ログ更新を再実装しないため。CLAUDE.md 長期ビジョン1「MCP/REST/メール
// ハンドラなど複数の入口から呼べる形」の実例そのもの — CreateTodo は DAV PUT の薄いラッパー)。
//
// 【なぜ PutCalendarObject を「合成」するのか(DI の形)】
// このユースケースは PutCalendarObject の完成品インスタンスをコンストラクタで受け取る
// (collectionRepo/resourceRepo/uow/recurrenceIterator を再度バラで受け取らない)。
// 理由: PutCalendarObject 自身が「4つのポートから何を組み立てるか」を知っていればよく、
// CreateTodo はそれを知る必要がない(依存を1段畳んでカプセル化する = 呼び出し側
// (MCP サーバーのファクトリ)の組み立てコードが素直になる)。
//
// 【UID/DTSTAMP の生成方式(Clock/IdGenerator port は導入しない判断)】
// 既存コードベースを調査した結果、UID 生成・現在時刻取得に共通の port
// (Clock/IdGenerator インターフェース)は存在しなかった(grep 済み)。よってこの UC でも
// 素直に `crypto.randomUUID()` と `new Date()` を直接呼ぶ。Workers ランタイムは両方とも
// 標準 Web API として提供しており、テスト時の決定性が必要になったら
// (例: DTSTAMP の往復一致を厳密に検証したいテスト)呼び出し結果を正規表現で緩く検証すれば
// 足りる規模。ここで新しい port を1つ増やすのは、既存の設計慣行から外れる割に得られる
// 価値(テスト容易性)が小さいと判断した(YAGNI。他の UC が port 化する必要に迫られたら
// そのとき一括で導入する)。
// =============================================================================

import { buildVTodoCalendar, ICalendarObject, serialize, type VTodoFields } from "../../domain/ical";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";

// --- 入力 DTO ---

export interface CreateTodoInput {
	owner: PrincipalRef;
	/** SUMMARY(必須)。空文字は許可しない判断は zod 側(presentation)で先に弾く想定だが、
	 *  domain の buildVTodoCalendar 自体は空文字も許容する(VTODO の SUMMARY は RFC 上 OPTIONAL
	 *  かつ空 TEXT も文法上不正ではないため、UC 層で余計な制約を足さない)。 */
	title: string;
	/** DESCRIPTION。省略可。 */
	notes?: string;
	/**
	 * 期日。"YYYY-MM-DD"(終日)のみサポート(ISO8601 時刻付きはスライス①未対応 —
	 * vtodo-write.ts のファイル冒頭コメント参照)。時刻付き文字列が来たら InvalidDueError。
	 */
	due?: string;
	/** PRIORITY(§3.8.1.9)。0-9。省略時はプロパティを立てない(未設定)。 */
	priority?: number;
	/** 保存先コレクション ID。省略時は "tasks"(provision-default-collections.ts の既定 VTODO コレクション)。 */
	calendarId?: string;
}

// --- 出力 DTO ---

export interface CreateTodoOutput {
	task: Task;
}

// --- エラー型 ---

/**
 * due が "YYYY-MM-DD" 形式(終日)以外だったときのエラー。
 * 【設計判断】時刻付き due(ISO8601 の "T" を含む)は vtodo-write.ts が対応していない
 * (VTIMEZONE 合成ユーティリティが domain に無いため)。ここで早期に弾き、
 * buildVTodoCalendar 側の防御的 throw(Error)より意味の伝わるエラー型で呼び出し側
 * (MCP ツールハンドラ)に返す。
 */
export class InvalidDueError extends Error {
	readonly kind = "InvalidDueError" as const;
	constructor(readonly due: string) {
		super(`due must be "YYYY-MM-DD" (all-day). Time-of-day due is not yet supported: "${due}"`);
		this.name = "InvalidDueError";
	}
}

export type CreateTodoError = InvalidDueError | PutCalendarObjectError;

// YYYY-MM-DD の厳密マッチ(値の実在性チェックは domain の calDate ファクトリに委ねる —
// ここでは「時刻付きではないこと」の形式だけを見る)。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTodo {
	constructor(private readonly putCalendarObject: PutCalendarObject) {}

	async execute(input: CreateTodoInput): Promise<CreateTodoOutput> {
		let due: string | undefined;
		if (input.due !== undefined) {
			if (!DATE_ONLY_RE.test(input.due)) {
				throw new InvalidDueError(input.due);
			}
			// buildVTodoCalendar は VALUE=DATE の生値(YYYYMMDD、区切りなし)を要求する
			// (values/cal-date.ts の DATE 構文 §3.3.4)。"YYYY-MM-DD" から区切りを剥がすだけ。
			due = input.due.replace(/-/g, "");
		}

		const uid = crypto.randomUUID();
		// DTSTAMP は UTC MUST(§3.8.7.2。VTodo.validate() の I2 も検証している)。
		// values/cal-date-time.ts の formatCalDateTime は CalDateTime 型を要求するが、
		// ここでは Date から直接 UTC 文字列を組み立てる方が簡潔なので専用コーデックは経由しない
		// (「現在時刻 → DTSTAMP 生値」という一方向の単純な変換であり、往復性を保証する必要が
		// ないため values/ 層の CalDateTime ファクトリを通す価値が薄いと判断)。
		const nowDate = new Date();
		const utcRaw = `${nowDate.getUTCFullYear().toString().padStart(4, "0")}` +
			`${(nowDate.getUTCMonth() + 1).toString().padStart(2, "0")}` +
			`${nowDate.getUTCDate().toString().padStart(2, "0")}T` +
			`${nowDate.getUTCHours().toString().padStart(2, "0")}` +
			`${nowDate.getUTCMinutes().toString().padStart(2, "0")}` +
			`${nowDate.getUTCSeconds().toString().padStart(2, "0")}Z`;
		// X-APPLE-SORT-ORDER(vtodo-stamp.ts stampCreate)は Unix 秒が要る。utcRaw と同じ
		// nowDate から素直に導出する(秒未満切り捨て = Math.floor)。
		const now = { utcRaw, unixSeconds: Math.floor(nowDate.getTime() / 1000) };

		const fields: VTodoFields = {
			uid,
			now,
			summary: input.title,
			description: input.notes,
			due,
			dueValueType: due !== undefined ? "DATE" : undefined,
			priority: input.priority,
		};
		const component = buildVTodoCalendar(fields);
		const ics = serialize(component);

		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const result = await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: `${uid}.ics`,
			ics,
			condition: { kind: "must-not-exist" },
		});

		// 保存直後の Task DTO は「今組み立てた fields」から素朴に導出できるが、taskFromVTodo
		// (list-todos.ts と共通の DTO 変換)にロジックを一本化するため、いま組み立てた
		// component をそのまま domain レンズ(ICalendarObject)経由で読み直す(ics を
		// 再 parse する必要はない — component 自体が既に Component ツリーなので)。
		const obj = ICalendarObject.fromComponent(component);
		const vtodo = obj.todos()[0];
		if (vtodo === undefined) {
			// buildVTodoCalendar が必ず VTODO を1つ作るのでここには到達しないはずだが、
			// 型上 todos()[0] は undefined を返しうるため防御的に扱う。
			throw new Error("CreateTodo: internal error — built VTODO not found after round-trip");
		}
		void result; // 現状 Task DTO には ETag を含めない(E-2 UI-ready DTO の合意どおり)ので握りつぶす。

		return { task: taskFromVTodo(vtodo) };
	}
}
