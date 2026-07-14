// =============================================================================
// MoveTodo ユースケース — MCP move-todo ツール専用の VTODO コレクション間移動
// =============================================================================
//
// 【なぜ既存 DAV 経路(MOVE メソッド)を UC 化してここに寄せなかったか】
// タスク指示どおり DAV の MOVE メソッド(RFC 4918 §9.9)実装はこの UC のスコープ外。
// delete-collection.ts の先例(DAV 経路を無条件で変えないため MCP 専用に切り出す)と同じ判断で、
// この UC は MCP `move-todo` ツール専用として新設する(DAV MOVE を実装したくなったら、
// そのとき Destination ヘッダ・Overwrite ヘッダ等の DAV 語彙を扱う別 UC を検討する)。
//
// 【「移動」の実装方式: 独自の移動専用ストレージ操作は作らない】
// PutCalendarObject(移動先へ新規作成)+ DeleteCalendarObject(移動元を削除)という、
// 既存の2 UC の組み合わせだけで実装する。CreateTodo が PutCalendarObject を合成する設計
// (create-todo.ts 冒頭コメント)と同じ理由 — precondition 検証・ETag 計算・occurrence bounds
// 索引・コレクション変更ログ更新をこの UC で再実装しない。
//
// 【ICS バイト列を無変更のまま移動する(rawIcs を再シリアライズしない)】
// CalendarObjectResource.rawIcs は「格納オクテット列そのもの」(calendar-object-resource.ts の
// フィールドコメント参照)。UpdateTodo のようにフィールドを patch する必要は無く、単に
// 保存先を変えるだけの操作なので、serialize() を経由せず rawIcs をそのまま次の PUT の ics 入力に
// 渡す。これにより移動前後で ETag の元になるオクテット列が完全に一致する(移動によって
// プロパティ順や折り畳み位置が変わらないことを保証する)。
//
// 【URI 命名規則: CreateTodo と対称にする】
// 移動先での新規リソース URI は create-todo.ts と同じ `${uid}.ics` 規則を使う。todo-lookup.ts
// 冒頭コメントのとおり、iOS 由来の VTODO は元のリソース URI が UID と一致しないことがあるが、
// この UC が移動先に作る新リソースは「MCP 発の新規作成」に相当するため CreateTodo の規則に
// 揃えるのが自然(移動元の URI をそのまま引き継ぐと、移動元・移動先で命名規則が食い違う
// 資産[iOS 由来の URI]を新しいコレクションへ持ち込むことになり、以降 CreateTodo が生成する
// `${uid}.ics` 形式のリソースと不揃いになる)。同名衝突(移動先に同 UID の別リソースが既に
// 存在する等)は PutCalendarObject の must-not-exist が ETagConditionError を投げ、
// create-todo と同じ扱いになる(このタスクでは新しいエラー型を増やさず既存の型を再利用する)。
//
// 【原子性: 「移動先 PUT → 移動元 DELETE」の順序を厳守する】
// CollectionUnitOfWork は単一コレクション内の「リソース保存 + 変更ログ更新」までしか原子性を
// 保証しない(ports/index.ts の CollectionUnitOfWork コメント参照)。コレクションをまたぐ
// 「移動」自体は2つの UoW 呼び出し(PutCalendarObject 内部の saveResource → この UC が呼ぶ
// DeleteCalendarObject 内部の deleteResource)に分かれ、真の意味での分散トランザクションは
// 持たない。順序を「先に移動先へ作成 → 成功したら移動元を削除」に固定するのは、万一
// 途中で失敗した場合の安全側(フェイルセーフ)を選ぶため: この順序なら失敗時は「移動元にも
// 移動先にも同じ内容が残る(重複)」で済み、データを失うことは無い。逆順(先に削除)だと
// 失敗時に「どちらにも存在しない(消失)」という取り返しのつかない事故になる。重複は
// ユーザーが目視で気づいて手動で片方を消せば直せるが、消失は直せない — この非対称性から
// 順序を選んだ。両コレクションの sync-token/SyncChange は、それぞれの UoW 呼び出し
// (PutCalendarObject の recordChange("created") / DeleteCalendarObject の
// recordChange("deleted"))が個別に進める(呼び出し側の指示どおり「移動元=deleted、
// 移動先=created」)。
// =============================================================================

import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import type { CalendarObjectResourceRepository } from "../ports";
import { DeleteCalendarObject } from "./delete-calendar-object";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import { lookupTodo, TodoNotFoundError } from "./todo-lookup";
import { taskFromVTodo, type Task } from "./task-dto";

// --- 入力 DTO ---

export interface MoveTodoInput {
	owner: PrincipalRef;
	/** 移動対象の VTODO UID。 */
	todoId: string;
	/** 移動元コレクション ID。省略時は "tasks"。 */
	calendarId?: string;
	/** 移動先コレクション ID(必須)。 */
	toCalendarId: string;
}

// --- 出力 DTO ---

export interface MoveTodoOutput {
	/**
	 * 移動元から見た「削除直前」スナップショット(ghost 表示用)。DeleteTodo.removed と同じ発想
	 * (delete-todo.ts の JSDoc 参照) — lookupTodo が読んだ更新前レンズをそのまま整形するだけで
	 * 追加の D1 往復は無い。presentation 側はこれを removed として TodosViewModel に載せ、
	 * structuredContent.movedTo(このタスクの仕様)を添えることで「削除」ではなく「移動」の
	 * ゴーストとして描き分けられるようにする(判別の主体は presentation 層 — この UC 自体は
	 * "movedTo" という表示ラベルの概念を持たない。プロトコル知識を持ち込まない層分担のため)。
	 */
	removed: Task;
}

// --- エラー型 ---

/**
 * 移動元と移動先が同一コレクションだったときのエラー(no-op)。
 * 【設計判断: 早期に明示エラーにする】もし弾かずに実行すると「移動先へ同名リソースを
 * must-not-exist で作ろうとして ETagConditionError になる」という遠回りな失敗になり、
 * 呼び出し側にとって原因がわかりにくい(あたかも「同名衝突」のような紛らわしいメッセージに
 * なる)。移動元=移動先という入力そのものが無意味な操作なので、lookup 前に(安価に)専用エラーで
 * 弾く。
 */
export class MoveTodoSameCollectionError extends Error {
	readonly kind = "MoveTodoSameCollectionError" as const;
	constructor(readonly collectionId: string) {
		super(`move-todo: source and destination collection are the same ("${collectionId}"); nothing to do`);
		this.name = "MoveTodoSameCollectionError";
	}
}

export type MoveTodoError =
	| MoveTodoSameCollectionError
	| TodoNotFoundError
	// 移動先コレクション不在(CollectionNotFoundError)・移動先が VTODO を supported しない
	// (CalDAVPreconditionError の "supported-calendar-component" violation)・移動先に同 UID の
	// リソースが既に存在する(ETagConditionError)は、いずれも移動先への PutCalendarObject が
	// 検出するので、既存のエラー型をそのまま再利用する(新しい判別ロジックを増やさない)。
	| PutCalendarObjectError;

export class MoveTodo {
	// 【putCalendarObject/deleteCalendarObject を完成品として合成する理由】
	// CreateTodo/DeleteTodo と同じ構図(それぞれのファイル冒頭コメント参照)。この UC は
	// 「2つの既存 UC をどう組み合わせるか」だけを知っていればよく、collectionRepo/uow/
	// recurrenceIterator を再度バラで受け取る必要は無い。
	constructor(
		private readonly putCalendarObject: PutCalendarObject,
		private readonly deleteCalendarObject: DeleteCalendarObject,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: MoveTodoInput): Promise<MoveTodoOutput> {
		const fromCollectionId = mkCollectionId(input.calendarId ?? "tasks");
		const toCollectionId = mkCollectionId(input.toCalendarId);

		// CollectionId は branded string(値そのものは string)なので単純な === 比較で
		// 同一コレクションかどうかを判定できる(values/identifiers.ts のコメント参照。
		// パースや正規化を持たない薄い型なので、大文字小文字の揺れ等の正規化はしない —
		// collectionId() 自体がそこまでの意味論を持たせない設計のため)。
		if (fromCollectionId === toCollectionId) {
			throw new MoveTodoSameCollectionError(fromCollectionId);
		}

		const looked = await lookupTodo(this.resourceRepo, input.owner, fromCollectionId, input.todoId);
		if (looked === null) {
			throw new TodoNotFoundError(input.todoId);
		}

		// 移動直前スナップショット(移動元コレクション基準)。DeleteCalendarObject を呼ぶと当然
		// もう読めないので、必ず移動処理の前に作る(delete-todo.ts の removed と同じ発想 —
		// lookupTodo が読み済みの更新前レンズを整形するだけ = 追加往復無し)。
		const removed = taskFromVTodo(looked.vtodo);

		// --- 移動先へ ICS バイト列を無変更のまま新規作成する(ファイル冒頭コメント参照) ---
		await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId: toCollectionId,
			resourceUri: `${looked.resource.uid}.ics`,
			ics: looked.resource.rawIcs,
			condition: { kind: "must-not-exist" },
		});

		// --- 移動先への作成が成功した後にだけ移動元を削除する(冒頭コメントの順序保証) ---
		// DeleteTodo と同じ理由(delete-todo.ts 冒頭コメント)で無条件削除にする: chat 駆動の
		// 操作には iOS の If-Match 前提(直前の GET/PROPFIND で取得した ETag を使う)が無い。
		await this.deleteCalendarObject.execute({
			owner: input.owner,
			collectionId: fromCollectionId,
			resourceUri: looked.resourceUri,
			ifMatchEtag: null,
		});

		return { removed };
	}
}
