// =============================================================================
// vtodo-patch — 既存 VTODO の部分更新プリミティブ(E-1 スライス②-b)
// =============================================================================
//
// 【この層の責務・vtodo-write.ts との違い】
// vtodo-write.ts の buildVTodoCalendar は「新規 VTODO をゼロから組み立てる」専用であり、
// vtodo-write.ts 冒頭コメントが明言するとおり既存リソースの部分更新には使わない設計
// (iOS が送ってきた X-APPLE-*/VALARM 等をゼロから作り直すと丸ごと落としてしまうため)。
// このファイルはその「patch 方式」の実体: upsertProperty/removeProperty(structure/edit.ts)
// だけを使い、指定したプロパティ以外には一切触れない。VALARM・VTIMEZONE・SUBSTATE
// (VSTATUS サブコンポーネント)等は素通しでそのまま残る(呼び出し側の
// application/usecases/update-todo.ts 等が「patch した Component」を VCALENDAR の
// components 配列に差し戻すだけで、他のコンポーネントには一切触れない構造になっている)。
//
// 【なぜ stampUpdate をここで呼ばないか】
// vtodo-stamp.ts の stampUpdate(LAST-MODIFIED/DTSTAMP の upsert)は「生成プロパティの
// 単一情報源」方針(vtodo-stamp.ts 冒頭コメント)に従い、呼び出し側の UC が
// patchVTodoFields/applyCompletion/applyReopen の**後**に個別に呼ぶ。この関数群を
// stampUpdate と束ねてしまうと、「フィールドの patch」と「生成プロパティの更新」という
// 意味の異なる操作が1関数に混在し、テストの関心も混ざってしまうため分離したままにする。
// =============================================================================

import type { Component } from "../structure/types";
import { removeProperty, upsertProperty } from "../structure/edit";
import { encodeText } from "../values/text-value";
import { formatCalDateTime, parseCalDateTime, toEpochMillis, type CalDateTime } from "../values/cal-date-time";
import { formatRecurrenceRule, parseRecurrenceRule, type RecurrenceRule } from "../values/recurrence-rule";
import { localFieldsToEpochMillis } from "../timezone";
import type { NowStamp } from "./vtodo-stamp";
import { firstProp, paramFirst, rawValue } from "./helpers";

// VALUE=DATE パラメータ。vtodo-write.ts と同じ定数(用途が同じなので値も揃える。
// 型が readonly Parameter[] の局所定数のため、共有ファイルへ格上げするほどの重複ではないと
// 判断してこのファイルにも定義する — DRY より「各ファイルが自己完結して読める」を優先)。
const VALUE_DATE_PARAMS = [{ name: "VALUE", values: ["DATE"] }] as const;

/**
 * due(DTSTART/DUE)への patch 指示(2026-07-14 V6 フォローアップ: create-todo との対称化)。
 *
 * 【なぜ単純な文字列 + dueValueType から判別 union に変えたか(経緯)】
 * ②-b 時点は「終日(VALUE=DATE)の due しか patch できない」制約で、`due?: string` +
 * `dueValueType?: "DATE"` の2フィールドで表していた(時刻付き due は create-todo だけの機能)。
 * V6 フォローアップで update-todo を create-todo と対称にする(時刻付き due・due 除去)ため、
 * 「終日にする / 時刻付きにする / 期日を外す」という3つの意図を型で区別できる判別 union にする。
 * 文字列 + フラグの組み合わせより、呼び出し側(update-todo.ts)が意図を取り違えにくい
 * (例: kind:"remove" に raw を渡すコンパイルエラーで守れる)。
 *
 * 【VTIMEZONE をここに含めない理由(create 側と同じ層分担)】
 * kind:"date-time" は DTSTART;TZID/DUE;TZID を立てるが、対応する VTIMEZONE の生成・同梱は
 * VCALENDAR レベルの操作(この関数が返すのは VTODO Component 単体)であり、create-todo.ts が
 * buildVTimezone を application 層で呼んで VCALENDAR に足すのと同じく、update-todo.ts の責務に
 * 残す。この関数は VTODO 内の DTSTART/DUE と(値型追従のため)RRULE:UNTIL までだけを触る。
 */
export type VTodoDuePatch =
	// 終日にする。raw は YYYYMMDD(区切り無し、VALUE=DATE の値構文 §3.3.4)。
	| { readonly kind: "date"; readonly raw: string }
	// 時刻付きにする。raw は YYYYMMDDTHHMMSS(区切り無し、DATE-TIME の値構文 §3.3.5)。
	// tzid は IANA ゾーン名で DTSTART;TZID=.../DUE;TZID=... に使う。
	| { readonly kind: "date-time"; readonly raw: string; readonly tzid: string }
	// 期日を外す(DTSTART/DUE を取り除く)。
	| { readonly kind: "remove" };

/** patchVTodoFields の入力。与えられたフィールドのみを upsert する(undefined は無視)。 */
export interface VTodoPatchFields {
	/** SUMMARY(§3.8.1.12)。意味的な文字列(エスケープ前)。 */
	summary?: string;
	/** DESCRIPTION(§3.8.1.5)。意味的な文字列(エスケープ前)。 */
	description?: string;
	/**
	 * DUE/DTSTART(§3.8.2.3 / §3.8.2.4)への patch 指示。
	 * undefined = 触らない / VTodoDuePatch = 終日・時刻付き・除去のいずれかを適用する。
	 * (旧 `due?: string` + `dueValueType?: "DATE"` を V6 フォローアップで判別 union へ差し替えた
	 * — VTodoDuePatch の JSDoc の経緯参照。)
	 */
	due?: VTodoDuePatch;
	/**
	 * PRIORITY(§3.8.1.9)。0-9。
	 * 【0 の扱い】§3.8.1.9 原文 "A value of 0 specifies an undefined priority" どおり、
	 * 0 は「未設定」と同義なのでプロパティ自体を removeProperty する(vtodo-write.ts の
	 * buildVTodoCalendar が 0 のとき upsert をスキップするのと対称の判断。既存 VTODO に
	 * 既に PRIORITY が立っている状態から「未設定に戻す」操作を priority:0 で表現できる
	 * — buildVTodoCalendar 側は新規作成なのでこの「既存値を消す」ケースが無く非対称だが、
	 * 意味論は同じ)。
	 */
	priority?: number;
}

/**
 * 既存 VTODO の一部フィールドだけを patch する。
 *
 * 【undefined は「触らない」、明示値は「upsert する」の二値契約】
 * fields の各プロパティが undefined なら該当プロパティには一切触れない(消したい場合の
 * 表現はこの関数の外 — 現状 priority:0 のみが「消す」の唯一の明示的な表現)。
 */
export function patchVTodoFields(vtodo: Component, fields: VTodoPatchFields): Component {
	let out = vtodo;

	if (fields.summary !== undefined) {
		out = upsertProperty(out, "SUMMARY", encodeText(fields.summary));
	}
	if (fields.description !== undefined) {
		out = upsertProperty(out, "DESCRIPTION", encodeText(fields.description));
	}
	if (fields.due !== undefined) {
		out = applyDuePatch(out, fields.due);
	}
	if (fields.priority !== undefined) {
		if (fields.priority === 0) {
			out = removeProperty(out, "PRIORITY");
		} else {
			out = upsertProperty(out, "PRIORITY", String(fields.priority));
		}
	}

	return out;
}

/**
 * VTodoDuePatch を VTODO に適用する(DTSTART/DUE の upsert/削除 + RRULE:UNTIL 値型追従)。
 *
 * 【DTSTART と DUE を同値・同値型で両方立てる理由】
 * iOS 実機キャプチャどおり(vtodo-write.ts buildVTodoCalendar と同じ規約)。DTSTART は
 * RRULE のアンカーでもあるため、反復 VTODO では DTSTART が必須(§3.8.5.3)。
 */
function applyDuePatch(vtodo: Component, due: VTodoDuePatch): Component {
	if (due.kind === "remove") {
		// 期日を外す(DTSTART/DUE を除去)。
		// 【防御的 throw: RRULE ありは呼び出し側で拒否済みのはず】DTSTART は RRULE の
		// アンカー(§3.8.5.3)なので、RRULE を残したまま DTSTART を消すと「アンカー無し反復」
		// という壊れた VTODO になる。update-todo.ts が RecurringDueRemovalError で先に弾く契約
		// だが、この domain プリミティブ単体でも不変条件を守る(vtodo-write.ts の防御的 throw と
		// 同じ発想 — 契約違反はコード側のバグとして早期に落とす)。
		if (rawValue(vtodo, "RRULE") !== undefined) {
			throw new Error("patchVTodoFields: cannot remove due while RRULE is present (RRULE anchors on DTSTART §3.8.5.3)");
		}
		let out = removeProperty(vtodo, "DUE");
		out = removeProperty(out, "DTSTART");
		return out;
	}

	let out = vtodo;
	if (due.kind === "date") {
		out = upsertProperty(out, "DTSTART", due.raw, VALUE_DATE_PARAMS);
		out = upsertProperty(out, "DUE", due.raw, VALUE_DATE_PARAMS);
	} else {
		// 時刻付き: DTSTART;TZID=.../DUE;TZID=... を立てる(create 側 vtodo-write.ts と同じ規約)。
		// upsertProperty は Property をパラメータごと丸ごと置換するので、終日(VALUE=DATE)からの
		// 遷移でも古い VALUE=DATE パラメータは TZID パラメータに置き換わる(残らない)。
		const tzidParams = [{ name: "TZID", values: [due.tzid] }];
		out = upsertProperty(out, "DTSTART", due.raw, tzidParams);
		out = upsertProperty(out, "DUE", due.raw, tzidParams);
	}
	// I6(§3.3.10: UNTIL の値型は DTSTART に従う MUST)追従。両方向を扱う(followUntilValueType)。
	out = followUntilValueType(out, due);
	return out;
}

/**
 * RRULE:UNTIL の値型を新しい DTSTART(due)の値型に追従させる(I6・§3.3.10)。
 * RRULE 無し・UNTIL 無し・既に同値型なら何もしない(呼び出しは applyDuePatch の非 remove 分岐直後)。
 *
 * 【実装場所の判断: application(update-todo.ts)ではなくここに置く根拠】
 * create 側の buildVTodoCalendar(vtodo-write.ts)は最初から RRULE の UNTIL を DTSTART と
 * 同じ VALUE 型で組み立てて出す — 「DTSTART の値型と UNTIL の値型を揃えるのは VTODO を
 * 組み立てる/書き換える側の責務」という設計がすでにそちらにある。patchVTodoFields はまさに
 * 「既存 VTODO の DTSTART/DUE を書き換える」関数なので、UNTIL 追従はその同じ責務の延長線上に
 * あり、対称性のためにここへ置く。application 層に置くと I6 由来の domain 制約の知識が漏れる。
 *
 * 【両方向とも「日付」は保存し「値型」だけ変える】
 * UNTIL の日付(年月日)を書き換えると反復系列の終了日がずれてしまう(iOS が意図した終了日を
 * サーバーが勝手に変えることになる)。ここでやってよいのは値型変換だけ:
 *   - date-time→date(終日化): 日付を転写し時刻を落とす(2026-07-13 A-2 の元実装。iOS 発の
 *     反復マスター DTSTART;TZID=...(DATE-TIME)+ RRULE UNTIL=...Z を終日に変える経路で踏んだ)。
 *   - date→date-time(時刻付き化): UNTIL の日付 + 新 due の壁時計時刻を、新 due の TZID で
 *     UTC 化する(create 側 buildRecurrenceRule と同じポリシー — 「n回目の期限と同じ時刻に
 *     終了する」直感。RFC は UNTIL の時刻の選び方までは規定せず値型一致だけを課すので、
 *     時刻の選び方はこの実装のポリシー。§3.3.10 の UNTIL は DATE-TIME のとき UTC(末尾 Z)MUST
 *     なので必ず kind:"utc" で組む)。
 */
function followUntilValueType(vtodo: Component, due: Extract<VTodoDuePatch, { kind: "date" | "date-time" }>): Component {
	const rruleRaw = rawValue(vtodo, "RRULE");
	if (rruleRaw === undefined) return vtodo; // RRULE 無し: 何もしない。

	const rrule = parseRecurrenceRule(rruleRaw);
	if (rrule.until === undefined) return vtodo; // UNTIL 無し(COUNT のみ含む): 何もしない。

	if (due.kind === "date") {
		if (rrule.until.type === "date") return vtodo; // 既に DATE 型。
		// DATE-TIME → DATE。日付部分(年月日)だけ転写、時刻は落とす。
		const dt = rrule.until.dateTime;
		const newRule: RecurrenceRule = {
			...rrule,
			until: { type: "date", date: { year: dt.year, month: dt.month, day: dt.day } },
		};
		return upsertProperty(vtodo, "RRULE", formatRecurrenceRule(newRule));
	}

	// due.kind === "date-time": UNTIL は DATE-TIME(UTC)であるべき。
	if (rrule.until.type === "date-time") return vtodo; // 既に DATE-TIME 型(値はそのまま尊重)。
	// DATE → DATE-TIME。UNTIL の日付 + 新 due の壁時計時刻を、新 due の TZID で UTC に変換する。
	const untilDate = rrule.until.date;
	const time = due.raw.split("T")[1] ?? "000000"; // YYYYMMDDTHHMMSS の HHMMSS(防御的に既定 00:00:00)。
	const untilEpoch = localFieldsToEpochMillis(
		{
			year: untilDate.year,
			month: untilDate.month,
			day: untilDate.day,
			hour: Number(time.slice(0, 2)),
			minute: Number(time.slice(2, 4)),
			second: Number(time.slice(4, 6)),
		},
		due.tzid,
	);
	// RecurUntil.dateTime の型は utc|floating union だが、§3.3.10 の UNTIL は常に UTC(末尾 Z)。
	const utcDateTime: Extract<CalDateTime, { kind: "utc" }> = { kind: "utc", ...epochToUtcFields(untilEpoch) };
	const newRule: RecurrenceRule = { ...rrule, until: { type: "date-time", dateTime: utcDateTime } };
	return upsertProperty(vtodo, "RRULE", formatRecurrenceRule(newRule));
}

/**
 * 完了操作: STATUS:COMPLETED / COMPLETED:<now> / PERCENT-COMPLETE:100 の三点セットを upsert する。
 *
 * 【三点セットのみ・ACKNOWLEDGED は使わない理由】
 * docs/modeling/06-ios-behavior-verification.md §D9 の実機所見: iOS は完了操作でこの三点だけを
 * 送り、RFC 9074 の ACKNOWLEDGED(VALARM 内)は使わない。iOS 対応が最優先(CLAUDE.md コア価値)
 * なのでサーバー発の完了操作もこれに揃える。
 */
export function applyCompletion(vtodo: Component, now: NowStamp): Component {
	let out = vtodo;
	out = upsertProperty(out, "STATUS", "COMPLETED");
	out = upsertProperty(out, "COMPLETED", now.utcRaw);
	out = upsertProperty(out, "PERCENT-COMPLETE", "100");
	return out;
}

/**
 * 再開操作: STATUS:NEEDS-ACTION に戻し、COMPLETED・PERCENT-COMPLETE を取り除く。
 *
 * 【COMPLETED/PERCENT-COMPLETE を消す理由】
 * 「未完了に戻した」のに COMPLETED(完了時刻)や PERCENT-COMPLETE:100 が残っていると、
 * STATUS と矛盾したデータになる(iOS 側の解釈も不定になりうる)。RFC 5545 はこれらの
 * プロパティ間に明示的な整合性 MUST を課していないが、「STATUS:NEEDS-ACTION なのに
 * 完了時刻が残る」矛盾を UC 層から作らないための能動的な判断。
 */
export function applyReopen(vtodo: Component): Component {
	let out = vtodo;
	out = upsertProperty(out, "STATUS", "NEEDS-ACTION");
	out = removeProperty(out, "COMPLETED");
	out = removeProperty(out, "PERCENT-COMPLETE");
	return out;
}

// ---------------------------------------------------------------------------
// shiftAbsoluteAlarmTriggers — VALARM の絶対トリガーだけを shiftMs だけ動かす
// ---------------------------------------------------------------------------
//
// 【2026-07-13 vtodo-recurrence.ts から移設(共有化)】
// 元は advanceMasterToNextOccurrence(反復マスターの次 occurrence 前進)専用の非公開関数
// advanceAbsoluteAlarmTriggers としてそちらに実装されていた。今回 update-todo.ts の
// due 変更でも「絶対トリガーを差分 shift する」という全く同じ変換が必要になったため、
// 反復固有ロジック(vtodo-recurrence.ts)から patch 系の共通プリミティブ(このファイル)へ
// 引き上げて公開関数にする。ロジック自体・下記の判別/除外コメントは移設元のまま(内容の
// 正しさは既存テスト — vtodo-recurrence.test.ts 「VALARM 絶対トリガーの前進」節 — で
// 担保済みなので変更しない)。
//
// 【関数名を advance→shift に変える理由】
// 反復前進(advance)は常に「未来へ」動かす一方向の操作だが、update-todo.ts の due 変更は
// due を過去方向へ動かす(=shiftMs が負)こともある(「締切を早める」ケース)。
// 「前進」を意味する advance という名前のままだと呼び出し側の意図と語彙が食い違うため、
// 正負どちらの方向も自然に表せる中立な shift に改名する(実装は shiftMs の符号をそのまま
// 使うだけで元から双方向対応していた — 名前だけが片方向を示唆していた)。
export function shiftAbsoluteAlarmTriggers(vtodo: Component, shiftMs: number): Component {
	const components = vtodo.components.map((c) => {
		if (c.name !== "VALARM") return c;
		if (firstProp(c, "X-APPLE-PROXIMITY") !== undefined) return c; // 位置アラーム: 前進しない

		const triggerProp = firstProp(c, "TRIGGER");
		if (triggerProp === undefined) return c; // TRIGGER 必須違反(壊れたデータ)。validate() 側の仕事。

		const isAbsolute = paramFirst(triggerProp, "VALUE")?.toUpperCase() === "DATE-TIME";
		if (!isAbsolute) return c; // 相対トリガー: 前進しない

		const triggerValue = parseCalDateTime(triggerProp.value);
		if (triggerValue.kind !== "utc") return c; // trigabs は utc のはずだが、防御的に非 utc は素通し

		const newEpoch = toEpochMillis(triggerValue) + shiftMs;
		const newTrigger = { ...triggerValue, ...epochToUtcFields(newEpoch) };
		return upsertProperty(c, "TRIGGER", formatCalDateTime(newTrigger), triggerProp.parameters);
	});
	return { ...vtodo, components };
}

/**
 * due(DTSTART/DUE)に紐づく VALARM を取り除く(2026-07-14 V6 フォローアップ: due 除去に随伴)。
 *
 * 【なぜ due 除去時にアラームも消すのか(判断根拠)】
 * VTODO の VALARM は TRIGGER が「絶対時刻(§3.8.6.3 trigabs)」か「DTSTART/DUE 相対
 * (RELATED=START|END の trigrel §3.8.6.3)」のどちらかで期日に紐づく。DUE と DTSTART を
 * 両方外した VTODO でこれらを残すと、絶対トリガーは「期日が無いのに鳴る取り残され」、相対
 * トリガーは「アンカー(DTSTART/DUE)が消えて発火時刻が未定義」になる。docs/modeling/06 の
 * 実機所見どおり iOS のリマインダーは「期日 = 通知時刻」の一体モデルなので、期日を外す操作は
 * 「通知も外す」が最も驚きが少ない(ロスレスに残して壊れた通知が鳴る方が実害が大きい)。
 * よって「期日に紐づく VALARM(絶対 + 相対の両方)」をまとめて除去する。
 *
 * 【X-APPLE-PROXIMITY(位置アラーム)は残す】
 * 位置トリガーは時刻・期日に依存せず「その場所に着いたら鳴る」ので、期日を外しても意味が
 * 保たれる(取り残されにならない)。shiftAbsoluteAlarmTriggers が位置アラームを据え置くのと
 * 同じ扱い。よって X-APPLE-PROXIMITY を持つ VALARM だけは残す。
 *
 * 【親へ返す論点(相対トリガーも消すかは判断が割れうる)】
 * タスク指示の見出しは「絶対トリガー VALARM を一緒に除去」だが、括弧内で「相対トリガーも
 * VTODO では DUE 依存なので実質同じ束」と補足されている。ここではその補足に従い「相対も含めて
 * 期日依存アラームを全部消す(=位置以外)」を採った(orphan 発火を確実に防ぐため)。ユーザーが
 * 明示設定した相対アラームまで消すのは破壊的、という別解もありうる(その場合は絶対だけ消して
 * 相対は残す)。最終報告で親に判断を仰ぐ。
 */
export function removeDueAnchoredAlarmTriggers(vtodo: Component): Component {
	const components = vtodo.components.filter((c) => {
		if (c.name !== "VALARM") return true; // VALARM 以外(何も無いが将来のサブコンポーネント)は残す。
		if (firstProp(c, "X-APPLE-PROXIMITY") !== undefined) return true; // 位置アラーム: 残す(上記)。
		return false; // 期日依存アラーム(絶対 + 相対): 除去する。
	});
	return { ...vtodo, components };
}

/**
 * UTC エポックミリ秒 → CalDateTime(kind:"utc")の年月日時分秒フィールド。
 * vtodo-recurrence.ts の withNewWallClockFields(template の kind を保つ汎用版)とは違い、
 * ここでは trigabs が常に kind:"utc" 固定と分かっている(§3.8.6.3)ので、template 分岐を
 * 持たない単純な形にする(移設に伴う簡略化。呼び出し元は1箇所のみ)。
 */
function epochToUtcFields(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const d = new Date(ms);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
}
