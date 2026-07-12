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
import { applyCompletion, applyReopen, patchVTodoFields, shiftAbsoluteAlarmTriggers, stampUpdate } from "../../domain/ical/semantics";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { zoneResolverFor, type RecurrenceIterator } from "../../domain/ical/recurrence";
import { calDateStartEpochMillis, calDateTimeToEpochMillis } from "../../domain/ical/timezone";
import { parseCalDate, type CalDate, type CalDateTime } from "../../domain/ical/values";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import { InvalidDueError } from "./create-todo";
import { completeRecurringTodo } from "./recurring-completion";
import { nowStampFromDate } from "./now-stamp";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import type { CalendarObjectResourceRepository } from "../ports";

// YYYY-MM-DD の厳密マッチ。create-todo.ts と同じ正規表現(意味も同じなので複製せず
// 再定義してもよいレベルの1行だが、create-todo.ts 側は非公開 const のため import できない
// — 公開昇格させるほどの重複でもないと判断しこのファイルにも定義する)。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * @returns 旧 due も旧 DTSTART も無い(前進の基準が無い)場合は undefined。
 */
function dueShiftMillis(
	oldInstance: CalDate | CalDateTime | undefined,
	newDueYYYYMMDD: string,
	zoneOf: (tzid: string) => string,
): number | undefined {
	if (oldInstance === undefined) return undefined; // 基準が無い = shift しない(仕様どおり)。

	// floatingTimeZone="UTC": PUT 時点の floating/DATE 解決は UTC 固定という既存の確定設計
	// (recurring-completion.ts の zoneResolverFor 呼び出しコメント・occurrence-bounds.ts と同じ規約)
	// にここでも揃える。
	const oldEpoch = isCalDateTime(oldInstance)
		? calDateTimeToEpochMillis(oldInstance, { zoneOf, floatingTimeZone: "UTC" })
		: calDateStartEpochMillis(oldInstance, "UTC");

	// 新 due は patchVTodoFields の契約上 VALUE=DATE(YYYYMMDD)のみ(vtodo-patch.ts の
	// dueValueType?: "DATE" 制約)。「時刻付き→終日変換の近似」はこの start-of-day 採用が
	// 唯一の情報源であること自体を指す(update-todo.ts の呼び出し箇所コメント参照)。
	const newEpoch = calDateStartEpochMillis(parseCalDate(newDueYYYYMMDD), "UTC");

	return newEpoch - oldEpoch;
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
}

export type UpdateTodoError = InvalidDueError | TodoNotFoundError | PutCalendarObjectError;

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

		// --- due 変更時の VALARM 絶対トリガー追随(2026-07-13 追加。V2 実機で判明した欠落) -----
		// 【iOS 忠実 + オフセット保存】iOS ネイティブは due を動かすとリマインダー通知(VALARM)も
		// 一緒に動く。反復マスター前進(vtodo-recurrence.ts の advanceMasterToNextOccurrence)では
		// 既にこの「絶対トリガーを occurrence の絶対時刻差ぶん shift する」を実装済み
		// (shiftAbsoluteAlarmTriggers = 今回そちらから共有化した同じプリミティブ)。ここでは
		// 「occurrence の前進」の代わりに「ユーザーによる due の書き換え」を差分の発生源にする。
		// shift は「アラームと due の相対オフセットを保つ」規則(due 連動アラームだけでなく、
		// ユーザーが設定した早期リマインダーも due と同じだけ動く)。相対トリガー(RELATED/DURATION)
		// と位置アラーム(X-APPLE-PROXIMITY)は shiftAbsoluteAlarmTriggers 自身が据え置く。
		//
		// 【input.due が指定されたときだけ】title/priority/status のみの update では due 自体が
		// 動いていないので VALARM にも触れない(due===undefined ならこのブロック自体をスキップ)。
		//
		// 【時刻付き→終日(DATE)変換の近似(限界。dueShiftMillis の JSDoc にも明記)】
		// create/update は現状 DATE の due しか生成できない(vtodo-patch.ts の dueValueType:"DATE"
		// 制約)。旧 due が時刻付き(DATE-TIME)だったケースで新 due(終日)に変えると、新
		// 「インスタンス」は start-of-day を採る他ない。結果としてアラームは「旧 due 時刻から
		// (新 due の start-of-day − 旧 due の絶対時刻)だけ動いた絶対時刻」になり、iOS が実際に
		// 終日リマインダーを鳴らす時刻(例: 当日9:00 等、ローカル既定値)とは一致しない可能性がある。
		// これはロスレス(既存プロパティを消さず、常に何らかの一貫した規則で動かす)を優先した
		// 割り切りであり、「時刻付き due 自体の生成が未対応」という既存制約(create-todo.ts と
		// 同じ)と地続きの限界として許容する。
		//
		// 【反復完了経路(completeRecurringTodo)との順序】status:"COMPLETED" かつ反復 VTODO のとき
		// 下の分岐は patched(= このブロック適用後の Component)を masterVtodo として渡す。つまり
		// 「due patch → VALARM shift」を必ず先に済ませてから渡すことで、completeRecurringTodo 側は
		// 何も意識せず patched を受け取るだけでよい(buildCompletionSnapshot・
		// advanceMasterToNextOccurrence の双方に、due 変更由来の VALARM shift が既に反映された
		// 状態で伝播する)。
		if (due !== undefined) {
			const zoneOf = zoneResolverFor(looked.resource.payload);
			const oldInstance = looked.vtodo.due ?? looked.vtodo.dtstart; // 旧 DUE、無ければ旧 DTSTART。
			const shiftMs = dueShiftMillis(oldInstance, due, zoneOf);
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
				return { task };
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
