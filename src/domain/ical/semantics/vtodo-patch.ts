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
import { appendSubComponent, removeProperty, upsertProperty } from "../structure/edit";
import { buildProximityAlarm, type ProximityAlarmInput } from "./valarm-write";
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
	/**
	 * LOCATION(§3.8.1.7)への patch 指示(2026-07-15 追加)。due の三値と同じパターンで:
	 *   - undefined     = 触らない
	 *   - null または "" = LOCATION を除去する
	 *   - 非空文字列     = LOCATION を差し替える(意味的文字列。ここで encodeText する)
	 * 【空文字を除去に倒す理由】create-todo が空文字を「未設定」と同義に扱う(vtodo-write.ts の
	 * location コメント)のと対称。空の LOCATION プロパティを立てても iOS/他クライアントの
	 * 表示上は「未設定」と区別できず、空プロパティを書き残す方が驚きが大きいため、null と同じ
	 * 「除去」に寄せる(呼び出し側 presentation は null=除去/undefined=据え置き の契約だが、
	 * 万一空文字が届いてもここで除去に倒しておく)。
	 */
	location?: string | null;
	/**
	 * RRULE(§3.3.10 / §3.8.5.3)への patch 指示(2026-07-15 追加。update-todo の反復設定/変更/除去)。
	 *   - undefined       = 触らない(既存 RRULE をそのまま残す)
	 *   - null            = RRULE を除去する(反復をやめる。COUNT/UNTIL は RRULE 値の一部なので同時に消える)
	 *   - RecurrenceRule  = RRULE を**全置換**する(部分マージはしない — UI は常に完全なプリセットを送る契約)
	 * 【ドメイン型 RecurrenceRule を受け取る理由(chat 語彙の変換は application の責務)】
	 * create-todo.ts の buildRecurrenceRule(chat 語彙 → RecurrenceRule + 不変条件検証)を
	 * update-todo.ts も共有して呼び、検証済みのドメイン型をここに渡す。このプリミティブは
	 * 「RRULE プロパティ文字列を upsert/remove する」だけに徹し、頻度/interval/UNTIL 値型の
	 * 判別ロジックは持ち込まない(vtodo-write.ts が RecurrenceRule をそのまま formatRecurrenceRule
	 * するのと同じ層分担)。
	 * 【UNTIL 値型追従(I6)との関係】RecurrenceRule 全置換なので、application 側が新 due の値型に
	 * 合わせて UNTIL を組んで渡す(followUntilValueType は「due だけ変えて RRULE は据え置き」の
	 * ケース専用。recurrence を全置換するときは新 rule の UNTIL がそのまま出るので二重に触らない)。
	 */
	recurrence?: RecurrenceRule | null;
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
	if (fields.location !== undefined) {
		// null または空文字 = 除去。非空文字列 = 差し替え(VTodoPatchFields.location コメント)。
		if (fields.location === null || fields.location === "") {
			out = removeProperty(out, "LOCATION");
		} else {
			out = upsertProperty(out, "LOCATION", encodeText(fields.location));
		}
	}
	// recurrence は due patch より**先**に適用する(順序が効く2ケースがある):
	//  (1) recurrence:null(除去)+ due:remove(期日も外す)を同時に送るとき — 先に RRULE を消して
	//      おかないと、下の applyDuePatch(remove) が「RRULE ありで DTSTART を消せない」防御 throw に
	//      引っかかる。反復をやめて期日も外す、は自然な操作なので先に RRULE を消して合法化する。
	//  (2) recurrence 全置換 + due 変更を同時に送るとき — applyDuePatch は既存 RRULE の UNTIL 値型を
	//      新 due に追従させる(followUntilValueType)。先に新 rule を upsert しておいても、application は
	//      新 due の値型に合わせて UNTIL を組んで渡す契約なので follow は no-op になり二重調整は起きない。
	if (fields.recurrence !== undefined) {
		if (fields.recurrence === null) {
			// RRULE 除去(反復をやめる)。COUNT/UNTIL は RRULE 値の一部なので同時に消える。
			// iOS が付ける X-APPLE-* 等の他プロパティには触れない(ロスレス方針 — 反復に紐づく
			// 独立した X-APPLE プロパティは我々のモデルには存在せず、反復情報は RRULE 値に閉じている)。
			out = removeProperty(out, "RRULE");
		} else {
			// RRULE 全置換(部分マージしない)。formatRecurrenceRule でドメイン型を RRULE 文字列に。
			out = upsertProperty(out, "RRULE", formatRecurrenceRule(fields.recurrence));
		}
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

// ---------------------------------------------------------------------------
// proximity(位置)VALARM の追加 / 除去(#51 Phase 1・update-todo の locationReminder patch)
// ---------------------------------------------------------------------------
//
// 【なぜ upsert(除去してから追加)か】proximity VALARM は VTODO に1個だけ持てる想定(Phase 1)。
// 「場所リマインダーを付け替える」操作を素朴に append すると古い位置アラームが残って二重になるため、
// 既存の proximity VALARM を先に全部除去してから新しい1個を append する(冪等な差し替え)。
// 時刻アラーム(X-APPLE-PROXIMITY を持たない VALARM)には一切触れない(due 由来アラームと共存させる)。

/**
 * VTODO に proximity(位置)VALARM を1個 upsert する(既存 proximity は差し替え)。
 * 時刻アラーム・その他のサブコンポーネントは温存する(ロスレス方針)。
 */
export function upsertProximityAlarm(vtodo: Component, input: ProximityAlarmInput): Component {
	const withoutProximity = removeProximityAlarms(vtodo); // 既存 proximity を除去(差し替えのため)。
	return appendSubComponent(withoutProximity, buildProximityAlarm(input));
}

/**
 * VTODO から proximity(位置)VALARM を全て除去する(locationReminder:null での位置通知解除)。
 * X-APPLE-PROXIMITY を持つ VALARM だけを filter する。時刻アラーム(絶対/相対)は残す
 * (removeDueAnchoredAlarmTriggers が位置アラームを残すのと対称の判断 — 位置と時刻は独立した通知)。
 */
export function removeProximityAlarms(vtodo: Component): Component {
	const components = vtodo.components.filter((c) => {
		if (c.name !== "VALARM") return true;
		return firstProp(c, "X-APPLE-PROXIMITY") === undefined; // proximity VALARM を除去、他は残す。
	});
	return { ...vtodo, components };
}

// ---------------------------------------------------------------------------
// pruneUnreferencedVTimezones — patch 経路で孤立した VTIMEZONE を掃除する
// ---------------------------------------------------------------------------
//
// 【2026-07-15 本番検証で確認: 孤立 VTIMEZONE の残留】
// update-todo で recurrence と due を両方外す(applyDuePatch(remove) で DTSTART/DUE を消し、
// recurrence:null で RRULE も消す)と、どのプロパティからも TZID 参照されなくなった
// VTIMEZONE:Asia/Tokyo だけが VCALENDAR に取り残されることを本番 D1 の ICS で確認した。
// 無害(RFC 上「使われない定義が残っている」だけで不変条件違反ではない)だが、意味的な
// 変更を加えた patch のついでに掃除しておく方が ICS が綺麗に保たれる。
//
// 【この関数を vtodo-patch.ts に置くが「VTODO 単体」ではなく VCALENDAR の components 配列を
// 受け取る理由】このファイルの他の関数(patchVTodoFields 等)はファイル冒頭コメントのとおり
// 「VTODO Component 単体」を返す設計だが、VTIMEZONE の要不要は VCALENDAR 全体(他の
// VTODO/VEVENT が同じ TZID を参照しているかもしれない)を見ないと判定できない。よって
// この関数だけは例外的に components 配列(VCALENDAR.components 相当)を受け取り、
// 呼び出し側(update-todo.ts)が VTODO 差し替え + VTIMEZONE 追加を終えた「最終段」で
// 一度だけ呼ぶ設計にした(タスク指示の「パッチ適用の最終段」はこの意味で解釈した)。
//
// 【ロスレス往復の原則との整合: patch 経路限定】
// この関数は update-todo.ts の意味的変更パス(patchVTodoFields 等を通った後)からのみ
// 呼ばれ、読み取り専用の GET や素通しの PUT(既存 ICS をそのまま受けて保存するだけの経路)
// からは呼ばれない。iOS 実機など他クライアントが書いた VTIMEZONE を、サーバーが何も意味的な
// 変更を加えていないのに勝手に間引くと「サーバーが受け取ったバイト列を書き換えた」ことになり、
// PUT のロスレス往復(RFC 4791 §5.3.4 の ETag 前提)を壊す。patch で意味的な変更を加えた
// ときに限り、その変更の副産物として不要になった VTIMEZONE を掃除するのは妥当という判断
// (掃除しないと「patch の結果、参照ゼロの VTIMEZONE が新たに生まれる」という不衛生を
// サーバー自身が作り出すことになるため、こちらは能動的に直す)。
//
// 【参照ありなら他クライアント由来でも絶対に消さない】
// DUE だけでなく DTSTART/EXDATE/RDATE/RRULE:UNTIL 等、TZID パラメータを持ちうる全プロパティを
// 対象コンポーネント全部(VTODO 本体・VALARM 等のサブコンポーネントも含む)から拾う。
// 1つでも参照が残っていればそのTZIDのVTIMEZONEは残す(参照整合 I8 を壊さないため最優先)。
/**
 * VCALENDAR の components 配列から、どのプロパティ(TZID パラメータ)からも参照されなくなった
 * VTIMEZONE コンポーネントを取り除く。非 VTIMEZONE コンポーネントの並び・内容は一切変えない
 * (フィルタするだけで他要素の同一性は保つ — components.map で差分最小にする既存パターンに合わせる)。
 */
export function pruneUnreferencedVTimezones(components: readonly Component[]): readonly Component[] {
	// 全コンポーネント(VTIMEZONE 自身は除く — VTIMEZONE 内の TZID プロパティは「宣言」であって
	// 「参照」ではないので走査対象から外す。含めても実害は無いが意図を明確にするため除外する)を
	// 再帰的に歩き、出現する TZID パラメータ値を集める。
	const referencedTzids = new Set<string>();
	const collectReferences = (c: Component): void => {
		if (c.name === "VTIMEZONE") return;
		for (const p of c.properties) {
			const tzid = p.parameters.find((param) => param.name === "TZID")?.values[0];
			if (tzid !== undefined) referencedTzids.add(tzid);
		}
		for (const sub of c.components) collectReferences(sub);
	};
	for (const c of components) collectReferences(c);

	return components.filter((c) => {
		if (c.name !== "VTIMEZONE") return true; // VTIMEZONE 以外は無条件で残す。
		const tzid = c.properties.find((p) => p.name === "TZID")?.value;
		// TZID プロパティ自体が無い VTIMEZONE(§3.6.5 の不変条件違反だが、この関数は掃除役に
		// 徹し検証はしない)は「どの TZID かも判定不能」なので安全側に倒して残す。
		if (tzid === undefined) return true;
		return referencedTzids.has(tzid);
	});
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
