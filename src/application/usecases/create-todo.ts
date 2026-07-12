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

import {
	buildVTodoCalendar,
	ICalendarObject,
	parseCalDate,
	recurrenceRule,
	serialize,
	type Frequency,
	type RecurrenceRule,
	type VTodoFields,
	type Weekday,
} from "../../domain/ical";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import { nowStampFromDate } from "./now-stamp";

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
	/**
	 * 反復指定(タスク③)。MCP `create-todo` の chat 語彙(iOS リマインダーの繰り返し UI に
	 * 合わせた素朴な形)をそのまま受け取り、この UC 内でドメインの RecurrenceRule に変換する
	 * (変換・不変条件検証をこの UC に集約する設計判断。下の buildRecurrenceRule 参照)。
	 * 指定時は due が必須(RRULE は DTSTART をアンカーにするため — RecurrenceRequiresDueError)。
	 */
	recurrence?: CreateTodoRecurrenceInput;
}

/** MCP `create-todo` の recurrence 入力(zod 前段は presentation 層が担う。ここは素朴な形のまま)。 */
export interface CreateTodoRecurrenceInput {
	frequency: "daily" | "weekly" | "monthly" | "yearly";
	/** INTERVAL(§3.3.10)。省略時は RRULE に INTERVAL を出さない(既定 1 を補完しない。ロスレス方針)。 */
	interval?: number;
	/** BYDAY(序数無し)。weekly でのみ有効(下記バリデーション参照)。 */
	weekdays?: readonly Weekday[];
	/** COUNT(§3.3.10)。until と排他。 */
	count?: number;
	/** UNTIL を "YYYY-MM-DD" で指定。count と排他。DATE 型で RRULE に出す(下記コメント参照)。 */
	until?: string;
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

/**
 * recurrence を指定したのに due が無いときのエラー。
 * 【設計判断】RRULE は DTSTART をアンカーにする(§3.8.5.3)ので、我々の実装(due が
 * DTSTART/DUE の値そのもの)では due 無しに RRULE だけ立てることができない。zod では
 * 「他のフィールドの有無」を跨いだ相関チェックが冗長になりがちなので、application 層で
 * 明示的にエラーにする(InvalidDueError と型を分けたのは、原因が「due の形式」ではなく
 * 「due の不在」であることをメッセージ・catch 分岐の両方で区別できるようにするため)。
 */
export class RecurrenceRequiresDueError extends Error {
	readonly kind = "RecurrenceRequiresDueError" as const;
	constructor() {
		super("recurrence requires due (RRULE needs a DTSTART anchor); specify due together with recurrence");
		this.name = "RecurrenceRequiresDueError";
	}
}

/**
 * count と until を両方指定したときのエラー。
 * 【RFC 根拠】§3.3.10 recur ABNF のコメント「The UNTIL or COUNT rule parts are OPTIONAL,
 * but they MUST NOT occur in the same 'recur'.」(I5)。recurrence-rule.ts の recurrenceRule()
 * も同じ不変条件を検証するが、ここで早期に弾いて MCP ツール利用者にわかりやすいメッセージを
 * 返す(recurrenceRule() 側のメッセージは values 層向けの汎用文言のため)。
 */
export class RecurrenceCountUntilConflictError extends Error {
	readonly kind = "RecurrenceCountUntilConflictError" as const;
	constructor() {
		super("recurrence.count and recurrence.until must not both be specified (RFC 5545 I5)");
		this.name = "RecurrenceCountUntilConflictError";
	}
}

/**
 * weekly 以外の frequency に weekdays を指定したときのエラー。
 * 【設計判断(安全側を選ぶ)】RFC 5545 §3.3.10 は BYDAY を monthly/yearly でも許容するが、
 * それは「序数付き BYDAY」(例 2MO, -1SU)としての用法であり、序数無し BYDAY(例 "MO"だけ)を
 * monthly/yearly に付けたときの意味は曖昧(「毎月の月曜すべて」等、複数 occurrence/期間に
 * 展開されうる)。一方 weekly の序数無し BYDAY は「その週の指定曜日」という一義的な意味を持つ
 * (recurrence-rule.ts の I 系検証も序数付き BYDAY を monthly/yearly 限定にしているだけで、
 * 序数無し BYDAY を weekly 限定とはしていない=values 層は通してしまう)。chat からの
 * ゼロ知識入力でこの曖昧さを黙って解釈するより、weekly 限定に絞って明示的にエラーにする方が
 * 安全側(誤った反復パターンを黙って作ってしまうより、失敗して再入力を促す方がまし)と判断した。
 * monthly/yearly の曜日指定(序数付き BYDAY)が必要になったら、そのとき専用の入力語彙を
 * 別途設計する(YAGNI)。
 */
export class RecurrenceWeekdaysRequireWeeklyError extends Error {
	readonly kind = "RecurrenceWeekdaysRequireWeeklyError" as const;
	constructor(readonly frequency: string) {
		super(`recurrence.weekdays is only valid when frequency is "weekly", got "${frequency}"`);
		this.name = "RecurrenceWeekdaysRequireWeeklyError";
	}
}

export type CreateTodoError =
	| InvalidDueError
	| RecurrenceRequiresDueError
	| RecurrenceCountUntilConflictError
	| RecurrenceWeekdaysRequireWeeklyError
	| PutCalendarObjectError;

// YYYY-MM-DD の厳密マッチ(値の実在性チェックは domain の calDate ファクトリに委ねる —
// ここでは「時刻付きではないこと」の形式だけを見る)。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// chat 語彙の frequency ("daily"等) → ドメインの Frequency("DAILY"等)。
const FREQUENCY_MAP: Record<CreateTodoRecurrenceInput["frequency"], Frequency> = {
	daily: "DAILY",
	weekly: "WEEKLY",
	monthly: "MONTHLY",
	yearly: "YEARLY",
};

/**
 * CreateTodoRecurrenceInput(chat 語彙) → RecurrenceRule(ドメイン型)への変換 + 不変条件検証。
 * 【until を DATE 型で出す理由】buildVTodoCalendar は due(→ DTSTART)を常に VALUE=DATE で
 * 立てる(vtodo-write.ts 冒頭コメント)。RFC 5545 §3.3.10 の UNTIL 規則「The value of the
 * UNTIL rule part MUST have the same value type as the "DTSTART" property」に従い、
 * DTSTART が DATE である以上 UNTIL も DATE でなければ値型不一致になる(update-todo.ts で
 * 判明した同種の罠 — I6 不変条件)。よってここでは常に RecurUntil{type:"date"} を組み立てる
 * (DATE-TIME 版の UNTIL を選べる入力にはしない = 値型不一致を作れない設計)。
 */
function buildRecurrenceRule(input: CreateTodoRecurrenceInput): RecurrenceRule {
	if (input.count !== undefined && input.until !== undefined) {
		throw new RecurrenceCountUntilConflictError();
	}
	if (input.weekdays !== undefined && input.weekdays.length > 0 && input.frequency !== "weekly") {
		throw new RecurrenceWeekdaysRequireWeeklyError(input.frequency);
	}

	return recurrenceRule({
		freq: FREQUENCY_MAP[input.frequency],
		interval: input.interval,
		count: input.count,
		until: input.until !== undefined ? { type: "date", date: parseCalDate(input.until.replace(/-/g, "")) } : undefined,
		byDay:
			input.frequency === "weekly" && input.weekdays !== undefined
				? input.weekdays.map((weekday) => ({ weekday }))
				: undefined,
	});
}

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

		let recurrence: RecurrenceRule | undefined;
		if (input.recurrence !== undefined) {
			// RRULE は DTSTART をアンカーにするため due 必須(vtodo-write.ts の防御的 throw と
			// 対称。ここが本線で、あちらは呼び出し側のバグを捕まえる最終防衛線)。
			if (due === undefined) {
				throw new RecurrenceRequiresDueError();
			}
			recurrence = buildRecurrenceRule(input.recurrence);
		}

		const uid = crypto.randomUUID();
		// DTSTAMP は UTC MUST(§3.8.7.2。VTodo.validate() の I2 も検証している)。
		// values/cal-date-time.ts の formatCalDateTime は CalDateTime 型を要求するが、
		// ここでは Date から直接 UTC 文字列を組み立てる方が簡潔なので専用コーデックは経由しない
		// (「現在時刻 → DTSTAMP 生値」という一方向の単純な変換であり、往復性を保証する必要が
		// ないため values/ 層の CalDateTime ファクトリを通す価値が薄いと判断)。
		// 【②-b で抽出】この変換は now-stamp.ts の nowStampFromDate に一本化した
		// (UpdateTodo/CompleteTodo も同じ変換を必要とするため。挙動は変更していない)。
		const now = nowStampFromDate(new Date());

		const fields: VTodoFields = {
			uid,
			now,
			summary: input.title,
			description: input.notes,
			due,
			dueValueType: due !== undefined ? "DATE" : undefined,
			priority: input.priority,
			recurrence,
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
