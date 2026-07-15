// =============================================================================
// completeRecurringTodo — 反復 VTODO の完了オーケストレーション(D4 モデル。E-1 スライス②-c)
// =============================================================================
//
// 【この関数の位置づけ・なぜクラスではなく関数か】
// domain/ical/semantics/vtodo-recurrence.ts の buildCompletionSnapshot /
// advanceMasterToNextOccurrence(純関数、Component → Component)を実際の PUT 2回に
// 配線する薄いオーケストレーション層。CompleteTodo/UpdateTodo という2つの呼び出し元
// (complete-todo.ts / update-todo.ts)から同じロジックを呼ぶために抽出したが、状態を
// 持たない・constructor injection で束ねる価値のある複数メソッドも無いため、
// PutCalendarObject/CreateTodo のような class ではなく素朴な async 関数にする
// (既存コードの中では stampCreate/applyCompletion 等の純関数と同じ「小さく完結した処理は
// 関数のままにする」慣習に揃えた判断 — CLAUDE.md にクラス化の強制はない)。
//
// 【非原子 2 PUT の失敗モードと安全性(snapshot-first の理由)】
// このオーケストレーションは1つの UoW にまたがらない「at-least-once」な操作である
// (PutCalendarObject.execute を2回、それぞれ別のリクエストとして呼ぶ。中間で失敗しても
// ロールバックは無い)。順序を snapshot-first((a) スナップショット作成 → (b) マスター前進)に
// 固定する理由:
//   - (a) が失敗(ネットワーク断・precondition 違反等) → 何も変わっていないので、
//     呼び出し側がそのまま再実行すれば良い(冪等ではないが実質無害な再試行になる)。
//   - (a) 成功 → (b) が失敗(典型は楽観ロック — must-match の ETag が別プロセスの更新で
//     ズレていた) → 完了スナップショットが1件「余剰」に残るだけ(良性・可逆: ユーザーが
//     見れば「あ、これは重複か」と分かる形で残り、二度と occurrence が失われることはない)。
// これを逆(master-first: 先にマスターを前進させてから完了スナップショットを作る)にすると、
// (b) 相当の失敗で「マスターは次回へ進んだのに完了記録(スナップショット)が無い」= 今回
// 完了させた occurrence の記録が消え、かつ次回の occurrence へ進んでしまっている(スキップ扱い)
// という非可逆な事故になる。よって snapshot-first を必ず守る((a)→(b) の順序を変えない)。
//
// 【均一化した2 PUT モデル(2026-07-13 V8 本番実機実測で確定)】
// 旧実装は advanceMasterToNextOccurrence が "exhausted" を返す(=前進先が無い)場合に
// 「スナップショットを作らずマスターへ直接 applyCompletion して1 PUT のみ」という特別扱いを
// していた。しかし本番実機(iOS 26.5・FREQ=DAILY;UNTIL・2 occurrence を最後まで完了)を見たところ、
// **iOS は最終 occurrence でも必ずスナップショットを作り、マスターも次の生ステップへ前進させる**
// ことが判明した(完了スナップショットが2件・マスター DTSTART/DUE が UNTIL 越えの次の日へ
// 前進・RRULE 不変・STATUS:COMPLETED)。これを受けて、advanceMasterToNextOccurrence の契約を
// 「常に次の生ステップへ前進し、境界を越えたかどうかは seriesEnded フラグで返す」に変更し
// (vtodo-recurrence.ts 参照)、この関数は **常に2 PUT** を行うよう均一化した。
//
// STATUS の決定はこの関数の責務(advanceMasterToNextOccurrence 側から引き上げた — 同ファイルの
// 責務分離コメント参照):
//   - advance.kind === "advanced" && seriesEnded === false(継続): applyReopen
//     (STATUS:NEEDS-ACTION に戻す — 次回まだ発生する)。
//   - advance.kind === "advanced" && seriesEnded === true(最終回): applyCompletion
//     (前進した DTSTART/DUE のまま STATUS を COMPLETED 系にする)。
//   - advance.kind === "no-next-step"(病的ケースのみの例外): 前進を諦め、マスター自身へ
//     その場 applyCompletion する(旧 "exhausted" 分岐の名残 — こちらは実機で踏まれる想定がない
//     保険的フォールバックなので、稀なケースとして残す)。
// =============================================================================

import { ICalendarObject, serialize, type Component } from "../../domain/ical";
import {
	advanceMasterToNextOccurrence,
	applyCompletion,
	applyReopen,
	buildCompletionSnapshot,
	stampUpdate,
	type NowStamp,
} from "../../domain/ical/semantics";
import { zoneResolverFor, type RecurrenceIterator } from "../../domain/ical/recurrence";
import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject } from "./put-calendar-object";
import type { LookedUpTodo } from "./todo-lookup";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";

export interface CompleteRecurringTodoDeps {
	readonly putCalendarObject: PutCalendarObject;
	readonly recurrenceIterator: RecurrenceIterator;
}

export interface CompleteRecurringTodoArgs {
	readonly owner: PrincipalRef;
	readonly collectionId: CollectionId;
	/** lookupTodo が返した対象一式(resource/resourceUri/etag/vtodo)。 */
	readonly looked: LookedUpTodo;
	/**
	 * 完了操作を適用する対象のマスター VTODO Component。CompleteTodo は looked.vtodo.raw を
	 * そのまま渡すが、UpdateTodo は「他フィールドの patch を先に適用した後」の Component を
	 * 渡す想定(update-todo.ts の呼び出し箇所参照 — 「due を伸ばして完了」のような複合操作でも
	 * フィールド更新が失われないようにするため)。
	 */
	readonly masterVtodo: Component;
	readonly now: NowStamp;
}

export interface CompleteRecurringTodoResult {
	readonly task: Task;
}

/**
 * R-8(R-7 に軽く同梱): スナップショット UID を「元 UID + 完了させる occurrence の DTSTART/DUE」
 * から決定的に導出する。
 *
 * 【なぜ決定的にするのか(R-7 の CAS 化との関係)】
 * R-7 で PUT が 412 を返すようになったことで、「1回目の PUT は実は DB に反映されていたのに
 * クライアントには何らかの理由でエラーが伝わり、同じ操作をもう一度送ってくる」という
 * at-least-once な再試行が今までより増える可能性がある(このオーケストレーションはファイル
 * 冒頭コメントのとおりそもそも非原子 2 PUT で「再試行前提」の設計)。旧実装は
 * `crypto.randomUUID()` で毎回新しい UID を採番していたため、再試行のたびに別リソース
 * (`${newUid}.ics`)が INSERT され、同じ occurrence の完了スナップショットが複数件重複して
 * 残るおそれがあった。UID(および PUT 先の resourceUri = `${uid}.ics`)を「元 VTODO の UID +
 * 完了させる occurrence の DTSTART/DUE」から決定的に導出すれば、再試行は同じ URI への
 * PUT になり、PutCalendarObject の `INSERT ... ON CONFLICT(owner, collection_id, uri) DO
 * UPDATE` (repositories.ts) がそのまま upsert として吸収する(migrations/0001 の
 * `UNIQUE (owner, collection_id, uid)` 制約にも触れない — uid も URI も同じ値になるため)。
 *
 * 【occurrence キーに DTSTART/DUE を使う判断】
 * このスナップショットは RECURRENCE-ID を持たない(buildCompletionSnapshot は UID を差し替える
 * だけで RECURRENCE-ID プロパティを追加しない — D4 モデルは「単発 VTODO」として作る設計。
 * vtodo-recurrence.ts の buildCompletionSnapshot コメント参照)。そのため「どの occurrence を
 * 完了させたか」を一意に表す既存の値は、マスターの現在の DTSTART(無ければ DUE)しかない。
 * 同じマスターに対して同じ DTSTART/DUE で2回 completeRecurringTodo が呼ばれることは
 * 「同じ occurrence をもう一度完了させようとした」場合のみで、それはまさに再試行のケースと
 * 一致する(正常系で同じ occurrence を2回別々に完了させる操作はそもそも意味がない)。
 *
 * 【SHA-256 を使う理由・UUID 形式にしない判断】
 * Workers ランタイムで確実に使える Web Crypto の `crypto.subtle.digest` を使う(乱数生成用の
 * `crypto.randomUUID()` から `crypto.subtle` に変えるだけで追加の依存は増えない)。出力は
 * ハッシュの hex 文字列そのままにし、UUID の見た目(8-4-4-4-12)に整形する追加コストはかけない
 * — このプロジェクトの UID は RFC 5545 上「一意な文字列」であればよく UUID 形式である必要は
 * ない(calendar_objects.uid 列も TEXT で形式を強制しない)。`completion-` プレフィックスは
 * デバッグ時に「D4 モデルの完了スナップショットである」ことが uid だけで分かるようにするため。
 */
async function deterministicSnapshotUid(masterVtodo: Component): Promise<string> {
	// UID は masterVtodo 自身から読む(呼び出し側 looked.vtodo.uid は VTodo レンズの都合で
	// string | undefined 型になっている — RFC 5545 上 UID は VTODO に必須なので実運用では
	// 常に存在するが、型としては masterVtodo.properties から直接引くほうが素直で、
	// 「マスターの現在の状態から決定的に導く」という関数の意図とも一致する)。
	const masterUid = masterVtodo.properties.find((p) => p.name === "UID")?.value ?? "";
	// DTSTART が無い VTODO(iOS の VTODO は DTSTART 省略が珍しくない)は DUE を occurrence
	// キーとして使う。どちらも無ければ空文字(この場合は事実上 completeRecurringTodo が毎回
	// 同じ UID を返すことになるが、DTSTART も DUE も無いマスターへの反復完了は D4 モデルの
	// 前提〈RRULE で occurrence が動く〉と矛盾するため実運用では起きない想定の保険的分岐)。
	const occurrenceKey =
		masterVtodo.properties.find((p) => p.name === "DTSTART")?.value ??
		masterVtodo.properties.find((p) => p.name === "DUE")?.value ??
		"";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${masterUid} ${occurrenceKey}`),
	);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `completion-${hex}`;
}

/**
 * 反復 VTODO(RRULE あり)の完了を D4 モデルで実行する。
 * CompleteTodo.execute / UpdateTodo.execute(status:"COMPLETED" 分岐)から呼ばれる。
 */
export async function completeRecurringTodo(
	deps: CompleteRecurringTodoDeps,
	args: CompleteRecurringTodoArgs,
): Promise<CompleteRecurringTodoResult> {
	const { owner, collectionId, looked, masterVtodo, now } = args;
	const vcalendar = looked.resource.payload.raw;

	// zoneOf は「この PUT で保存する ICS 自身の VTIMEZONE」から組み立てる(occurrence-bounds.ts /
	// calendar-query.ts と同じ規約 — PUT 時点の floating 解決は UTC 固定の確定設計)。
	const zoneOf = zoneResolverFor(looked.resource.payload);

	// advance を先に評価する(no-next-step の病的ケースのみ前進処理そのものを諦めるため)。
	const advance = advanceMasterToNextOccurrence(masterVtodo, deps.recurrenceIterator, zoneOf);

	// --- 常に2 PUT: snapshot-first の順序厳守(冒頭コメントの失敗モード分析どおり) -----------
	// R-8: UID は決定的に導出する(上の deterministicSnapshotUid コメント参照 — 再試行時に
	// 同一 URI への upsert として自然に吸収させるため、以前の crypto.randomUUID() から変更)。
	const snapshotUid = await deterministicSnapshotUid(masterVtodo);
	const snapshot = buildCompletionSnapshot(
		masterVtodo,
		{ uid: snapshotUid, nextAlarmUid: () => crypto.randomUUID() },
		now,
	);

	// スナップショット用 VCALENDAR: 元 VCALENDAR.components のうち対象 VTODO だけを snapshot に
	// 差し替えたもの(VTIMEZONE 等は素通しでコピー — TZID 付き DTSTART の解決に必須。他の
	// UC と同じ「components 配列を map で差し替える」パターン)。
	const snapshotComponents = vcalendar.components.map((c) => (c === looked.vtodo.raw ? snapshot : c));
	const snapshotVcalendar: Component = { ...vcalendar, components: snapshotComponents };
	const snapshotIcs = serialize(snapshotVcalendar);

	// PUT (a): 新規リソース(must-not-exist)。失敗したらここで例外が伝播し、(b) は実行されない
	// (=無変更のまま。冒頭コメントの「(a) 失敗 → 無変更で再実行回復」)。
	await deps.putCalendarObject.execute({
		owner,
		collectionId,
		resourceUri: `${snapshotUid}.ics`,
		ics: snapshotIcs,
		condition: { kind: "must-not-exist" },
	});

	// PUT (b): 既存リソース(マスター)を前進後の内容で更新。ETagConditionError 等はここで
	// 握りつぶさずそのまま呼び出し側へ伝播させる(冒頭コメント「エラーは握りつぶさない」)。
	//
	// STATUS の決定(advanceMasterToNextOccurrence から引き上げた責務。ファイル冒頭コメント参照):
	//   - "no-next-step"(病的ケースの保険): 前進を諦め、元のマスターへその場 applyCompletion。
	//   - "advanced" && seriesEnded: 前進した DTSTART/DUE のまま STATUS を COMPLETED 系にする
	//     (最終回。V8 実機実測どおり)。
	//   - "advanced" && !seriesEnded: STATUS を NEEDS-ACTION に戻す(継続。次回がまだある)。
	const patchedMaster: Component =
		advance.kind === "no-next-step"
			? applyCompletion(masterVtodo, now)
			: advance.seriesEnded
				? applyCompletion(advance.vtodo, now)
				: applyReopen(advance.vtodo);
	const advancedMaster = stampUpdate(patchedMaster, now);
	const masterComponents = vcalendar.components.map((c) => (c === looked.vtodo.raw ? advancedMaster : c));
	const masterVcalendar: Component = { ...vcalendar, components: masterComponents };
	const masterIcs = serialize(masterVcalendar);

	await deps.putCalendarObject.execute({
		owner,
		collectionId,
		resourceUri: looked.resourceUri,
		ics: masterIcs,
		condition: { kind: "must-match", etag: looked.etag.hex },
	});

	// 返す Task は「完了させたスナップショット」(呼び出し元は「今回完了させた occurrence」の
	// 状態を知りたいはずなので、前進後のマスター=NEEDS-ACTION ではなく完了済みスナップショットを
	// 返す — Fable 確定設計「返す Task=完了マスター/完了スナップショット」のとおり)。
	const snapshotObj = ICalendarObject.fromComponent(snapshotVcalendar);
	const snapshotVtodo = snapshotObj.todos().find((t) => t.uid === snapshotUid) ?? snapshotObj.todos()[0];
	if (snapshotVtodo === undefined) {
		throw new Error("completeRecurringTodo: internal error — completion snapshot VTODO not found after round-trip");
	}
	return { task: taskFromVTodo(snapshotVtodo) };
}
