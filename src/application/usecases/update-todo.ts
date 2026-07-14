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

import {
	buildVTimezone,
	ICalendarObject,
	isValidIanaZone,
	localFieldsToEpochMillis,
	serialize,
	UnsupportedTimeZoneError as DomainUnsupportedTimeZoneError,
	type Component,
	type RecurrenceRule,
} from "../../domain/ical";
import {
	applyCompletion,
	applyReopen,
	patchVTodoFields,
	removeDueAnchoredAlarmTriggers,
	shiftAbsoluteAlarmTriggers,
	stampUpdate,
	type VTodoDuePatch,
} from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { zoneResolverFor, type RecurrenceIterator } from "../../domain/ical/recurrence";
import { calDateStartEpochMillis, calDateTimeToEpochMillis } from "../../domain/ical/timezone";
import { parseCalDate, type CalDate, type CalDateTime } from "../../domain/ical/values";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError, type LookedUpTodo } from "./todo-lookup";
import {
	// buildRecurrenceRule と recurrence 3エラーは create-todo と共有する(2026-07-15 recurrence 対称化。
	// chat 語彙 → RecurrenceRule 変換 + count/until 排他・weekdays は weekly 限定・UNTIL 値型追従の
	// 判別ロジックを二重管理しない — create-todo.ts の buildRecurrenceRule export コメント参照)。
	buildRecurrenceRule,
	DueTimeZoneRequiredError,
	InvalidDueError,
	InvalidTimeZoneError,
	RecurrenceCountUntilConflictError,
	RecurrenceRequiresDueError,
	RecurrenceWeekdaysRequireWeeklyError,
	UnsupportedTimeZoneError,
	type CreateTodoRecurrenceInput,
} from "./create-todo";
import { completeRecurringTodo } from "./recurring-completion";
import { nowStampFromDate } from "./now-stamp";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import type { CalendarObjectResourceRepository } from "../ports";

// YYYY-MM-DD の厳密マッチ。create-todo.ts と同じ正規表現(意味も同じなので複製せず
// 再定義してもよいレベルの1行だが、create-todo.ts 側は非公開 const のため import できない
// — 公開昇格させるほどの重複でもないと判断しこのファイルにも定義する)。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DDTHH:MM:SS の厳密マッチ(時刻付き due・offset 無しの壁時計。create-todo.ts と同じ。
// offset 付き "Z"/"+09:00" 等はこれに一致しない = InvalidDueError で弾かれる[TZID を offset から
// 一意に逆引きできないため。create-todo.ts の InvalidDueError コメント参照])。
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

// 反復ホライズン・VTIMEZONE 窓の余白。create-todo.ts の WINDOW_MARGIN_MILLIS と同じ値・同じ理由
// (§3.6.5 の VTIMEZONE は特定瞬間のオフセットを説明できればよいが、境界日ちょうどを安全側に
// 倒すため前後に 400日 = 1年+1ヶ月強の余白を持たせる)。update では反復ホライズンの厳密計算までは
// せず、「due の前後 400日」窓だけで固定オフセットゾーンの遷移有無を確認できれば十分
// (固定オフセットゾーンは運用中に遷移が無い前提なので窓の広さに敏感でない)。
const WINDOW_MARGIN_MILLIS = 400 * 24 * 60 * 60 * 1000;

// CalDate | CalDateTime の判別。semantics/helpers.ts の isCalDateTime は semantics/index.ts の
// 公開 API に意図的に含まれていない(index.ts のコメント参照)。task-dto.ts が既にこの
// パターン("kind" フィールドの有無で判定するローカル再定義)を採用しているので、ここでも
// 新しい公開 API を増やさずに揃える。
function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/**
 * due 変更に伴う VALARM 絶対トリガーの shift 量(ms)を求める(2026-07-13 追加)。
 *
 * 【なぜ update-todo.ts に置くか(domain 層へ引き上げない理由)】
 * 「旧 due インスタンス/新 due インスタンスの epoch 差」という計算自体は日時変換
 * (calDateStartEpochMillis/calDateTimeToEpochMillis)だけの純粋な計算で domain 層に置いても
 * 良さそうに見えるが、「旧 due が無ければ旧 DTSTART にフォールバックする」「新 due 文字列
 * (YYYYMMDD)をどう解釈するか」は UpdateTodo の入力契約(VTodoPatchFields の due は DATE 限定 —
 * vtodo-patch.ts の制約と同じ)に強く紐づいた1回限りのオーケストレーションであり、
 * vtodo-patch.ts/vtodo-recurrence.ts のような複数呼び出し元を持つ再利用可能な変換ではない。
 * 「UC 固有の1箇所だけの配線ロジックは無理に domain へ引き上げない」既存の判断
 * (recurring-completion.ts 冒頭コメントの class 化しない理由と同種の判断)に揃え、
 * この UC ファイルに留める。
 *
 * @param newDueEpoch 新 due の絶対時刻(呼び出し側が終日=start-of-day UTC / 時刻付き=壁時計+TZID
 *   の epoch として算出済み。V6 フォローアップで「新 due は VALUE=DATE 限定」の前提が外れたため、
 *   新 due の epoch 化を呼び出し側に委ね、この関数は差分計算に専念する)。
 * @returns 旧 due も旧 DTSTART も無い(前進の基準が無い)場合は undefined。
 */
function dueShiftMillis(
	oldInstance: CalDate | CalDateTime | undefined,
	newDueEpoch: number,
	zoneOf: (tzid: string) => string,
): number | undefined {
	if (oldInstance === undefined) return undefined; // 基準が無い = shift しない(仕様どおり)。

	// floatingTimeZone="UTC": PUT 時点の floating/DATE 解決は UTC 固定という既存の確定設計
	// (recurring-completion.ts の zoneResolverFor 呼び出しコメント・occurrence-bounds.ts と同じ規約)
	// にここでも揃える。
	const oldEpoch = isCalDateTime(oldInstance)
		? calDateTimeToEpochMillis(oldInstance, { zoneOf, floatingTimeZone: "UTC" })
		: calDateStartEpochMillis(oldInstance, "UTC");

	return newDueEpoch - oldEpoch;
}

/**
 * 既存 due(CalDate | CalDateTime)から buildRecurrenceRule 用の dueTimeInfo(壁時計 + TZID)を導く
 * (2026-07-15。recurrence を「due 据え置きのまま」設定/変更するとき、既存 due をアンカーにするため)。
 *
 * @returns 終日(CalDate)は undefined(create 側 buildRecurrenceRule が「dueTimeInfo undefined = DATE
 *   アンカー = UNTIL も DATE」と解釈する)。時刻付き(CalDateTime)は zoned なら TZID→IANA を zoneOf で
 *   解決、utc/floating は "UTC" を timeZone に採る(UNTIL の壁時計時刻を組む素材にする)。
 */
function dueTimeInfoFromInstance(
	instance: CalDate | CalDateTime,
	zoneOf: (tzid: string) => string,
): { hour: number; minute: number; second: number; timeZone: string } | undefined {
	if (!isCalDateTime(instance)) return undefined; // 終日: DATE アンカー。
	// zoned は自前 TZID を IANA へ解決、utc/floating は自ゾーンを持たないので UTC に倒す
	// (dueShiftMillis の floatingTimeZone="UTC" 規約・formatDue の floating 既定と揃える)。
	const timeZone = instance.kind === "zoned" ? zoneOf(instance.tzid) : "UTC";
	return { hour: instance.hour, minute: instance.minute, second: instance.second, timeZone };
}

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
	/**
	 * 期日。create-todo と対称の三値 + 2形態(V6 フォローアップ・2026-07-14):
	 *   - undefined = 変更しない
	 *   - null      = 期日を外す(DTSTART/DUE を除去。反復 VTODO は RecurringDueRemovalError)
	 *   - "YYYY-MM-DD"           = 終日にする
	 *   - "YYYY-MM-DDTHH:MM:SS"  = 時刻付きにする(timeZone と組。offset 付き ISO8601 は不可)
	 */
	due?: string | null;
	/**
	 * due が時刻付き("YYYY-MM-DDTHH:MM:SS")のときの IANA タイムゾーン(必須)。create-todo と同じ
	 * 制約(省略時 DueTimeZoneRequiredError・暗黙 UTC フォールバック禁止・DST ゾーンは
	 * UnsupportedTimeZoneError)。終日 due / due 除去 / due 省略のときは無視する。
	 */
	timeZone?: string;
	/** PRIORITY(0-9)。0 は「未設定に戻す」(vtodo-patch.ts 参照)。省略時は変更しない。 */
	priority?: number;
	/**
	 * LOCATION(§3.8.1.7)。due の三値と同じパターン(2026-07-15 追加):
	 *   - undefined = 変更しない
	 *   - null      = LOCATION を除去する
	 *   - 文字列     = LOCATION を差し替える(空文字は vtodo-patch 側で除去に倒す)
	 */
	location?: string | null;
	/**
	 * RRULE(反復)の設定/変更/除去(2026-07-15 追加。create-todo と対称の chat 語彙)。
	 *   - undefined                 = 変更しない(既存 RRULE を残す)
	 *   - null                      = RRULE を除去する(反復をやめる)
	 *   - CreateTodoRecurrenceInput  = RRULE を**全置換**する(部分マージしない)
	 * 【アンカーは due(§3.8.5.3)】設定/変更時は due が必須。新 due を同時に指定していればそれを、
	 * 指定していなければ既存 due をアンカーにする。どちらも無ければ RecurrenceRequiresDueError。
	 * due と recurrence を同時に変更するリクエストは許可する(新 due をアンカーに全置換)。
	 * 【due:null(除去)と同時の recurrence:null は合法】反復をやめて期日も外す、は自然な操作
	 * (RecurringDueRemovalError は「RRULE を残したまま due だけ外す」場合のみ拒否する)。
	 */
	recurrence?: CreateTodoRecurrenceInput | null;
	/**
	 * STATUS の遷移。"COMPLETED" で完了・"NEEDS-ACTION" で未完了に戻す。省略時は変更しない。
	 * 【CompleteTodo と同じガードを status:"COMPLETED" にも適用する(2026-07-12 レビューで確定)】
	 * 実装時点では「UpdateTodo は汎用フィールド patch なので反復 VTODO のチェックを持たせない」
	 * という設計だったが、それだと chat から `update-todo(status:"COMPLETED")` を呼ぶだけで
	 * CompleteTodo が防いでいる誤動作(反復 VTODO のマスター自体を完了扱いにしてしまい、
	 * 以降の全 occurrence が消えたように見える — docs/modeling/06 §D4)を素通りさせてしまう
	 * 抜け道になる。「完了」という意味を持つ操作である以上、入口が CompleteTodo でも
	 * UpdateTodo.status でも同じ不変条件を守るべきと判断し、ここでも反復 VTODO なら
	 * completeRecurringTodo(D4 モデル)へ委譲する(execute() 内の分岐参照。②-c で
	 * RecurringCompletionNotSupportedError による reject から実装に差し替えた)。
	 * NEEDS-ACTION への reopen は反復性に関係なく安全な操作なのでガードしない。
	 */
	status?: "COMPLETED" | "NEEDS-ACTION";
}

// --- 出力 DTO ---

export interface UpdateTodoOutput {
	task: Task;
	/**
	 * 更新「前」の Task スナップショット(2026-07-14 追加。MCP レイテンシ改善のため)。
	 *
	 * 【なぜ UC から before を返すか(経緯: 旧「UC を変えない」方針の撤回)】
	 * ②-b 実装時は「UpdateTodo は変更後の task だけ返し、差分の before は presentation 側で
	 * 別途 ListTodos を全件読みして引く」という分業だった(presentation の findTaskById)。
	 * だが本番計測(POST /mcp wall p95≈1164ms)で、トグル1回に対し ①before 取得の ListTodos 全件 →
	 * ②UpdateTodo(内部 read + PUT)→ ③確定一覧の ListTodos 全件、という直列 D1 往復が
	 * ボトルネックと判明した。UpdateTodo は If-Match 検証のため更新前リソースを既に内部で読んで
	 * いる(lookupTodo)。その読み済みの更新前状態をそのまま before として公開すれば、
	 * presentation は①の全件読みを丸ごと省ける(3回の全件級読み → 2回)。「UC は変更後だけ返す」
	 * より「読んだものは無駄にせず返す」方が I/O を減らせるという判断で方針を反転した。
	 *
	 * 【undefined になりうるか】lookupTodo が null(対象不在)なら execute は TodoNotFoundError を
	 * 投げるため、正常 return 経路では before は必ず定義される。それでも optional(?)にするのは、
	 * 「更新前状態が存在しない create 的経路が将来増えても契約を壊さない」ための余地
	 * (呼び出し側は before === undefined を「差分を描かない」に degrade できる)。
	 *
	 * 【zoneOf/timeZone を渡さない理由】下の execute が返す task も taskFromVTodo(vtodo) を
	 * 既定(identity zoneOf / UTC)で呼んでいる。before/after を同一パラメータで整形することで、
	 * 差分比較(presentation の buildEditedChanges)が「整形ゾーンのズレ由来の偽差分」を出さない
	 * (before と after が同じ物差しで並ぶことが差分の正しさより重要)。
	 */
	before?: Task;
}

/**
 * 反復 VTODO(RRULE あり)の due を除去しようとしたときのエラー(V6 フォローアップ)。
 * 【設計判断: サイレント破壊せず明示エラー】DTSTART は RRULE の反復アンカー(§3.8.5.3)。
 * due を外すと DTSTART も消えるため、RRULE を残したまま due 除去を許すと「アンカー無し反復」に
 * なり、以降の occurrence 計算が壊れる(iOS 側の解釈も不定)。除去を黙って無視するのも、DTSTART を
 * 消して RRULE も一緒に消すのも、どちらもユーザーの意図(期日だけ外す)を超えた勝手な破壊になる。
 * よって明示的にエラーで拒否し、呼び出し側(chat/UI)に「反復を先に解除するか、期日は残す」判断を
 * 委ねる(create-todo.ts の RecurrenceRequiresDueError と対になる不変条件)。
 */
export class RecurringDueRemovalError extends Error {
	readonly kind = "RecurringDueRemovalError" as const;
	constructor(readonly todoId: string) {
		super(
			`cannot remove due from a recurring todo "${todoId}" (RRULE anchors on DTSTART §3.8.5.3); ` +
				"clear the recurrence first, or keep the due",
		);
		this.name = "RecurringDueRemovalError";
	}
}

export type UpdateTodoError =
	| InvalidDueError
	| DueTimeZoneRequiredError
	| InvalidTimeZoneError
	| UnsupportedTimeZoneError
	| RecurringDueRemovalError
	// recurrence 設定/変更(2026-07-15)で create-todo と同じ3エラーを投げうる。
	| RecurrenceRequiresDueError
	| RecurrenceCountUntilConflictError
	| RecurrenceWeekdaysRequireWeeklyError
	| TodoNotFoundError
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
	// recurrenceIterator は②-c で追加(status:"COMPLETED" かつ反復 VTODO のとき
	// completeRecurringTodo に渡す。CompleteTodo と同じ理由)。
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: UpdateTodoInput): Promise<UpdateTodoOutput> {
		// due の解析(format/timeZone/DST エラーは lookup 前に投げる = 安価な失敗)。
		// 反復 VTODO の due 除去拒否だけは looked.vtodo.rrule を要するので lookup 後に行う。
		const parsed = this.parseDuePatch(input);
		const duePatch = parsed.duePatch;

		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const looked = await lookupTodo(this.resourceRepo, input.owner, collectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		// 反復 VTODO(RRULE あり)の due 除去はサイレント破壊せず拒否する(RecurringDueRemovalError の
		// JSDoc 参照。DTSTART が反復アンカー §3.8.5.3 なので消せない)。patchVTodoFields も同じ不変条件を
		// 防御的に throw するが、ここでは呼び出し側がわかる kind タグ付きエラーで先に弾く。
		// 【例外: recurrence:null(反復も同時に外す)なら許可する】「反復をやめて期日も外す」は自然な
		// 操作なので、RRULE を同時に除去するリクエストでは due 除去を拒否しない(input.recurrence の
		// JSDoc 参照。patchVTodoFields も recurrence を due より先に適用して RRULE を消してから
		// due 除去するので、あちらの防御 throw にも引っかからない)。
		const removingRecurrence = input.recurrence === null;
		if (duePatch?.kind === "remove" && looked.vtodo.rrule !== undefined && !removingRecurrence) {
			throw new RecurringDueRemovalError(input.todoId);
		}

		// 更新前スナップショット(before)。lookupTodo が読んだ更新前 VTODO レンズから作る
		// (追加の D1 往復は無い — 既に読み終えたものを整形するだけ)。presentation の差分レンズが
		// これを edited の changes.before に使う(UpdateTodoOutput.before の JSDoc 参照)。
		const before = taskFromVTodo(looked.vtodo);

		// --- recurrence patch の組み立て(2026-07-15。設定/変更/除去)---------------------------
		// undefined=据え置き / null=除去 / CreateTodoRecurrenceInput=全置換。全置換時は due(新 or 既存)を
		// アンカーに buildRecurrenceRule で RecurrenceRule を作る(chat 語彙 → ドメイン型 + 不変条件検証は
		// create-todo と完全共有 — 判別ロジックの二重管理をしない)。
		const recurrencePatch = this.buildRecurrencePatch(input, duePatch, parsed.dueTimeInfo, looked);

		let patched: Component = patchVTodoFields(looked.vtodo.raw, {
			summary: input.title,
			description: input.notes,
			location: input.location,
			due: duePatch,
			priority: input.priority,
			recurrence: recurrencePatch,
		});

		// --- due 変更時の VALARM 追随(2026-07-13 追加。V2 実機で判明した欠落。V6 で3形態に拡張)-----
		// 【iOS 忠実 + オフセット保存】iOS ネイティブは due を動かすとリマインダー通知(VALARM)も
		// 一緒に動く。反復マスター前進(vtodo-recurrence.ts の advanceMasterToNextOccurrence)では
		// 既にこの「絶対トリガーを occurrence の絶対時刻差ぶん shift する」を実装済み
		// (shiftAbsoluteAlarmTriggers = 今回そちらから共有化した同じプリミティブ)。ここでは
		// 「occurrence の前進」の代わりに「ユーザーによる due の書き換え」を差分の発生源にする。
		// shift は「アラームと due の相対オフセットを保つ」規則(due 連動アラームだけでなく、
		// ユーザーが設定した早期リマインダーも due と同じだけ動く)。相対トリガー(RELATED/DURATION)
		// と位置アラーム(X-APPLE-PROXIMITY)は shiftAbsoluteAlarmTriggers 自身が据え置く。
		//
		// 【3形態の扱い(V6 フォローアップ)】
		//  - set(date / date-time): 絶対トリガーを (新 due epoch − 旧 due/DTSTART epoch) ぶん shift する。
		//    新 due epoch は parseDuePatch が算出済み(終日=start-of-day UTC / 時刻付き=壁時計+TZID)。
		//  - remove: 期日が無くなるので、期日依存 VALARM(絶対 + 相対)を除去する
		//    (removeDueAnchoredAlarmTriggers。位置アラームだけ残す。判断根拠は同関数の JSDoc)。
		//  - undefined(due 変更なし): このブロックをスキップ(title/priority/status のみの update は
		//    due が動いていないので VALARM に触れない)。
		//
		// 【全日→時刻付きで「新規 VALARM は作らない」という判断(create-todo との非対称・親へ論点)】
		// create-todo は「時刻付き due には常にサーバー発 VALARM を付ける」(V6 の統合)が、update では
		// shiftAbsoluteAlarmTriggers は既存の絶対トリガーを動かすだけで、元々アラームが無い VTODO
		// (終日タスクは iOS 実機観測どおり VALARM 無し)を時刻付きにしても新しい VALARM は生成しない。
		// これは「patch = 与えられたものだけ触る/ユーザーが持っていなかったデータを編集で勝手に生やさない」
		// というロスレス方針に沿った割り切り。「時刻付き化したら通知も付けたい」需要が確認できたら別途
		// 判断する(最終報告で親に論点として返す)。
		//
		// 【反復完了経路(completeRecurringTodo)との順序】status:"COMPLETED" かつ反復 VTODO のとき
		// 下の分岐は patched(= このブロック適用後の Component)を masterVtodo として渡す。つまり
		// 「due patch → VALARM 追随」を必ず先に済ませてから渡すことで、completeRecurringTodo 側は
		// 何も意識せず patched を受け取るだけでよい(buildCompletionSnapshot・
		// advanceMasterToNextOccurrence の双方に、due 変更由来の VALARM 追随が既に反映された
		// 状態で伝播する)。
		if (duePatch?.kind === "remove") {
			patched = removeDueAnchoredAlarmTriggers(patched);
		} else if (duePatch !== undefined) {
			// set(date / date-time)。新 due epoch は parseDuePatch が必ず算出している。
			const zoneOf = zoneResolverFor(looked.resource.payload);
			const oldInstance = looked.vtodo.due ?? looked.vtodo.dtstart; // 旧 DUE、無ければ旧 DTSTART。
			const shiftMs = dueShiftMillis(oldInstance, parsed.newDueEpoch!, zoneOf);
			if (shiftMs !== undefined) {
				patched = shiftAbsoluteAlarmTriggers(patched, shiftMs);
			}
			// oldInstance が undefined(旧 DUE も旧 DTSTART も無い)のときは shift 基準が無いので
			// 何もしない(仕様どおり — dueShiftMillis の JSDoc 参照)。
		}

		if (input.status === "COMPLETED") {
			// CompleteTodo と同じ不変条件(反復 VTODO は単純な STATUS:COMPLETED では完了させない)を
			// ここでも守る(入力コメント参照)。lookupTodo が返す vtodo は patch 前の生 Component
			// レンズなので、rrule の有無はここで判定する(patchVTodoFields は RRULE に触れないので
			// looked.vtodo.rrule の判定結果は patched 後も変わらない)。
			if (looked.vtodo.rrule !== undefined) {
				// D4 モデルへ委譲する(②-c)。patched(他フィールドの patch 済み Component)を
				// masterVtodo として渡すことで、「due を伸ばして完了」のような複合操作でも
				// フィールド更新がスナップショット/前進後マスターの両方に反映される
				// (recurring-completion.ts の入力コメント参照)。completeRecurringTodo が
				// 自前で PUT・stampUpdate まで完結させるので、以降の共通処理はスキップして
				// ここで直接 return する。
				const { task } = await completeRecurringTodo(
					{ putCalendarObject: this.putCalendarObject, recurrenceIterator: this.recurrenceIterator },
					{ owner: input.owner, collectionId, looked, masterVtodo: patched, now: nowStampFromDate(new Date()) },
				);
				// 反復 D4 経路でも before は添える(呼び出し側 status:"COMPLETED" では before を
				// 使わないが、契約の一貫性のため全 return 経路で返す)。
				return { task, before };
			}
			patched = applyCompletion(patched, nowStampFromDate(new Date()));
		} else if (input.status === "NEEDS-ACTION") {
			patched = applyReopen(patched);
		}

		patched = stampUpdate(patched, nowStampFromDate(new Date()));

		// VCALENDAR.components の対象 VTODO だけを patch 後の Component に差し替える。
		// 他のサブコンポーネント(VTIMEZONE 等)はそのまま保持する(ロスレス編集の核心)。
		const vcalendar = looked.resource.payload.raw;
		let components = vcalendar.components.map((c) => (c === looked.vtodo.raw ? patched : c));

		// 時刻付き due に変更したとき、その TZID の VTIMEZONE を VCALENDAR に同梱する(§3.6.5:
		// TZID 付きプロパティを使うカレンダーは対応する VTIMEZONE を含めるのが前提。create-todo.ts が
		// buildVTimezone を application 層で呼んで足すのと同じ責務分担 — patchVTodoFields は VTODO 内
		// だけを触り、VCALENDAR レベルの VTIMEZONE 同梱はここで行う)。
		// 【重複回避】同 TZID の VTIMEZONE が既にあれば足さない(iOS 発の既存タイムゾーンや、
		// 同ゾーン内での時刻変更で二重に積まないため)。TZID の照合は VTIMEZONE の TZID プロパティ値で行う。
		if (parsed.dueVTimezone !== undefined) {
			const newTzid = parsed.dueVTimezone.properties.find((p) => p.name === "TZID")?.value;
			const alreadyPresent = components.some(
				(c) => c.name === "VTIMEZONE" && c.properties.find((p) => p.name === "TZID")?.value === newTzid,
			);
			if (!alreadyPresent) {
				// VTIMEZONE は VCALENDAR の先頭寄り(他コンポーネントより前)に置くのが慣例だが、RFC 5545 は
				// 順序に意味を課さない(§3.6)。既存構造をなるべく乱さないため単純に末尾へ追加する
				// (serialize/parse の往復は順序を保存するだけで、iOS の解釈も順序非依存)。
				components = [...components, parsed.dueVTimezone];
			}
		}

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

		// 時刻付き due(TZID 付き)を正しく offset ISO に整形するため zoneResolverFor(obj)/timeZone を
		// 渡す(create-todo.ts の return と同じパターン)。obj は VTIMEZONE を含む VCALENDAR レンズなので
		// zoneResolverFor が TZID→IANA を解決できる。timeZone は floating な DATE-TIME の既定解釈用
		// (input.timeZone が無い = 終日/除去/変更なしのケースは UTC 既定で従来と同じ)。
		return { task: taskFromVTodo(vtodo, zoneResolverFor(obj), input.timeZone ?? "UTC"), before };
	}

	/**
	 * recurrence patch(RRULE の据え置き/除去/全置換)を組み立てる(2026-07-15)。
	 *   - input.recurrence undefined → undefined(RRULE を触らない)
	 *   - input.recurrence null      → null(RRULE 除去。vtodo-patch が removeProperty する)
	 *   - CreateTodoRecurrenceInput  → RecurrenceRule(全置換。buildRecurrenceRule で chat 語彙を変換)
	 *
	 * 【アンカー due の決定(§3.8.5.3 RRULE は DTSTART をアンカーにする)】
	 * 全置換時は「新 due(同時変更)> 既存 due」の優先で anchor を選ぶ。anchor が終日なら UNTIL も
	 * DATE、時刻付きなら UNTIL も DATE-TIME(UTC)になるよう buildRecurrenceRule に dueTimeInfo を渡す
	 * (I6 §3.3.10: UNTIL の値型は DTSTART に従う MUST)。
	 *   - duePatch remove: 期日を外しながら反復を設定するのは矛盾 → RecurrenceRequiresDueError。
	 *   - duePatch date: 新終日 due がアンカー(dueTimeInfo=undefined)。
	 *   - duePatch date-time: 新時刻付き due がアンカー(parseDuePatch が算出した dueTimeInfo)。
	 *   - duePatch undefined: 既存 due がアンカー。既存 due も無ければ RecurrenceRequiresDueError。
	 */
	private buildRecurrencePatch(
		input: UpdateTodoInput,
		duePatch: VTodoDuePatch | undefined,
		newDueTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined,
		looked: LookedUpTodo,
	): RecurrenceRule | null | undefined {
		if (input.recurrence === undefined) return undefined; // 据え置き。
		if (input.recurrence === null) return null; // 除去。

		let anchorTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;
		if (duePatch === undefined) {
			// due 据え置き: 既存 due をアンカーにする(無ければアンカー不在エラー)。
			const existing = looked.vtodo.due;
			if (existing === undefined) throw new RecurrenceRequiresDueError();
			anchorTimeInfo = dueTimeInfoFromInstance(existing, zoneResolverFor(looked.resource.payload));
		} else if (duePatch.kind === "remove") {
			// 期日を外しながら反復を設定するのは不整合(アンカー不在)。create の due 無し反復と同じ拒否。
			throw new RecurrenceRequiresDueError();
		} else if (duePatch.kind === "date") {
			anchorTimeInfo = undefined; // 新終日 due アンカー(UNTIL も DATE)。
		} else {
			anchorTimeInfo = newDueTimeInfo; // 新時刻付き due アンカー(parseDuePatch 算出済み)。
		}
		return buildRecurrenceRule(input.recurrence, anchorTimeInfo);
	}

	/**
	 * input.due(三値 + 2形態)を VTodoDuePatch へ解析し、時刻付きなら VTIMEZONE と新 due epoch も
	 * 併せて返す(create-todo.ts の execute 前半の due 解析と対称。フォーマット/timeZone/DST の各
	 * エラーはここで投げる)。
	 *
	 * @returns duePatch=undefined(input.due===undefined: 変更なし)/ kind:"remove"(null: 除去。
	 *   dueVTimezone・newDueEpoch は無し)/ kind:"date"(終日: newDueEpoch=start-of-day UTC)/
	 *   kind:"date-time"(時刻付き: dueVTimezone + newDueEpoch=壁時計+TZID の epoch)。
	 */
	private parseDuePatch(input: UpdateTodoInput): {
		duePatch: VTodoDuePatch | undefined;
		dueVTimezone: Component | undefined;
		newDueEpoch: number | undefined;
		// dueTimeInfo(2026-07-15 追加): 新 due が時刻付き(date-time)のときの壁時計 + TZID。
		// recurrence 全置換で新 due をアンカーにするとき、UNTIL の値型/時刻を組む素材として
		// buildRecurrencePatch → buildRecurrenceRule に渡す(create-todo.ts の dueTimeInfo と同じ)。
		dueTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;
	} {
		if (input.due === undefined) {
			return { duePatch: undefined, dueVTimezone: undefined, newDueEpoch: undefined, dueTimeInfo: undefined };
		}
		if (input.due === null) {
			// 期日を外す(反復 VTODO の拒否は lookup 後に execute 側で行う — ここでは rrule を知らない)。
			return { duePatch: { kind: "remove" }, dueVTimezone: undefined, newDueEpoch: undefined, dueTimeInfo: undefined };
		}
		if (DATE_ONLY_RE.test(input.due)) {
			const raw = input.due.replace(/-/g, ""); // YYYYMMDD(VALUE=DATE の値構文)。
			// 終日 due の「新インスタンス」は start-of-day を UTC で採る(既存 dueShiftMillis と同じ規約)。
			const newDueEpoch = calDateStartEpochMillis(parseCalDate(raw), "UTC");
			return { duePatch: { kind: "date", raw }, dueVTimezone: undefined, newDueEpoch, dueTimeInfo: undefined };
		}
		// 時刻付き("YYYY-MM-DDTHH:MM:SS")。create-todo.ts と同じ検証(offset ISO 拒否・timeZone 必須・
		// 暗黙 UTC 禁止・DST ゾーン未対応)。
		const m = DATE_TIME_LOCAL_RE.exec(input.due);
		if (m === null) {
			// 空文字・offset 付き ISO8601・その他不正な形式はすべてここに落ちる(create-todo と同じ)。
			throw new InvalidDueError(input.due);
		}
		if (input.timeZone === undefined) {
			throw new DueTimeZoneRequiredError(input.due);
		}
		if (!isValidIanaZone(input.timeZone)) {
			throw new InvalidTimeZoneError(input.timeZone);
		}
		const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
		const newDueEpoch = localFieldsToEpochMillis(
			{ year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) },
			input.timeZone,
		);
		// VTIMEZONE を due の前後 400日窓で生成する(create-todo.ts と同じ。反復ホライズンの厳密計算は
		// せず窓だけで足りる — WINDOW_MARGIN_MILLIS のコメント参照)。DST ゾーンは domain の
		// UnsupportedTimeZoneError を application 層の kind タグ付きへ写像する(create-todo と同じ)。
		let dueVTimezone: Component;
		try {
			dueVTimezone = buildVTimezone(input.timeZone, {
				startMillis: newDueEpoch - WINDOW_MARGIN_MILLIS,
				endMillis: newDueEpoch + WINDOW_MARGIN_MILLIS,
			});
		} catch (error) {
			if (error instanceof DomainUnsupportedTimeZoneError) {
				throw new UnsupportedTimeZoneError(input.timeZone);
			}
			throw error;
		}
		const raw = `${y}${mo}${d}T${h}${mi}${s}`; // YYYYMMDDTHHMMSS(DATE-TIME の値構文)。
		// dueTimeInfo: recurrence 全置換で新時刻付き due をアンカーにするときの UNTIL 素材(壁時計 + TZID)。
		const dueTimeInfo = { hour: Number(h), minute: Number(mi), second: Number(s), timeZone: input.timeZone };
		return { duePatch: { kind: "date-time", raw, tzid: input.timeZone }, dueVTimezone, newDueEpoch, dueTimeInfo };
	}
}
