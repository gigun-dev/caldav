// =============================================================================
// vtodo-write — VTODO 組み立て(E-1 スライス① CreateTodo 専用)
// =============================================================================
//
// 【この層の責務】
// vtodo.ts(既存)は「Component を包む読み取りレンズ + validate」に徹する読み取り専用の
// ファイルであり、CLAUDE.md の指示どおりこの作業では変更しない。VTODO を新規に組み立てる
// 責務はここに切り出す。structure/edit.ts の汎用プリミティブ(upsertProperty 等)を使って
// VCALENDAR + VTODO の Component ツリーを作り、application/usecases/create-todo.ts が
// domain/ical/serialize/serializer.ts の serialize() に渡して ICS 化する。
//
// 【CreateTodo 以外でこのファイルを使わない方針(重要)】
// buildVTodoCalendar は「新規 VTODO をゼロから作る」専用であり、既存リソースの部分更新
// (例: 将来の UpdateTodo/CompleteTodo)には使わない。既存 ICS の一部だけを書き換える
// ユースケースは findByUri → Component を取得 → edit.ts の upsertProperty で当該プロパティ
// だけを差し替える、という「patch」方式にすべき(buildVTodoCalendar で作り直すと、
// iOS が送ってきた X-APPLE-* や VALARM 等ロスレス保持すべき情報を丸ごと落としてしまう)。
// この境界を破らないよう、他ユースケースからの import は禁止(レビューで担保)。
//
// 【iOS 実機キャプチャに合わせる(2026-07-12 docs/modeling/06 準拠)】
// - 優先度: PRIORITY:9(低)/5(中)/1(高)。CUA 端点(RFC 5545 §3.8.1.9)。
// - 期日: iOS は終日 TODO で DTSTART;VALUE=DATE と DUE;VALUE=DATE を**同値**で両方送る
//   (VTodo.validate() の I4 は「DUE < DTSTART」だけを違反とし同値は許容 — vtodo.ts の
//   2026-07-10 実測修正コメント参照)。このファイルもそれに倣い、due 指定時は DTSTART も
//   同じ値で立てる。
// - 時刻付き due(TZID + VTIMEZONE 同梱)は、この回のスコープでは**未対応**とする。
//   理由: VTIMEZONE を正しく合成するには IANA タイムゾーンから RFC 5545 の
//   STANDARD/DAYLIGHT 遷移規則を導出する必要があり、domain/ical/timezone/ 配下には
//   「TZID → 解決(resolver)」はあっても「TZID → VTIMEZONE 生成」のユーティリティが
//   まだ無い(2026-07-12 時点で調査済み)。無い機能を急ごしらえで作ると VTIMEZONE の
//   RFC 準拠(§3.6.5)が疑わしいものになり、iOS 側で誤動作するリスクの方が大きいと判断。
//   よって dueValueType: "DATE-TIME" はスライス①では zod 側で reject し、
//   「終日(DATE)を確実に対応する」ことを優先する(黙って落とさず明示的にエラーにする)。
// - CreateTodo では VALARM を設定しない(要件どおり。サーバー発アラームの実機挙動が
//   未検証のため、スライス①では踏み込まない)。
// =============================================================================

import type { Component, Parameter } from "../structure/types";
import { upsertProperty } from "../structure/edit";
import { encodeText } from "../values/text-value";
import { formatRecurrenceRule, type RecurrenceRule } from "../values/recurrence-rule";
import { stampCreate, type NowStamp } from "./vtodo-stamp";

/**
 * VCALENDAR の PRODID(§3.7.3)。既存コードベースに再利用できる定数が無かったため
 * ここで新規に定義する(他ユースケースがサーバー発 ICS を組み立てるようになったら、
 * ical/index.ts 経由で公開する形に昇格させてよい — 今は CreateTodo 専用なので局所定数のまま)。
 * "-//caldav//E-1 CreateTodo//EN" 形式(§3.7.3 の product identifier の慣用形)。
 */
const PRODID = "-//gigun-dev//caldav//EN";

/** buildVTodoCalendar の入力。 */
export interface VTodoFields {
	/** UID(§3.8.4.7)。呼び出し側(application 層)が crypto.randomUUID() 等で採番して渡す。 */
	uid: string;
	/**
	 * 「今」の2表現(§3.8.7.2 DTSTAMP の UTC 生値 + X-APPLE-SORT-ORDER 算出用 Unix 秒)。
	 * 【スライス②-a で dtstamp: string から変更】DTSTAMP は他の生成プロパティ
	 * (STATUS/CREATED/LAST-MODIFIED/X-APPLE-SORT-ORDER)と合わせて vtodo-stamp.ts の
	 * stampCreate に一本化した(生成プロパティの単一情報源にする方針)。呼び出し側
	 * (create-todo.ts)は Date から NowStamp を組み立てて渡す。
	 */
	now: NowStamp;
	/** SUMMARY(§3.8.1.12)。意味的な文字列(エスケープ前)。ここで encodeText する。 */
	summary: string;
	/** DESCRIPTION(§3.8.1.5)。省略可。SUMMARY と同じくエスケープ前の意味的文字列。 */
	description?: string;
	/**
	 * DUE(§3.8.2.3)の生値。dueValueType が "DATE" なら YYYYMMDD、省略時は無し。
	 * 【設計判断】"DATE-TIME" は現状未対応(ファイル冒頭コメント参照)なので、この型は
	 * 呼び出し側(application 層)が VALUE=DATE のみを渡す契約にする。
	 */
	due?: string;
	/** due の値型。"DATE" のみサポート(ファイル冒頭コメント参照)。due 指定時は必須。 */
	dueValueType?: "DATE";
	/** PRIORITY(§3.8.1.9)。0-9。0(既定=未設定)を渡すとプロパティ自体を省略する。 */
	priority?: number;
	/**
	 * RRULE(§3.3.10 RECUR / §3.8.5.3 プロパティ)。タスク③(反復付き create-todo)で追加。
	 * 【DTSTART が前提】RRULE は DTSTART を反復のアンカーにする(§3.8.5.3 の記載どおり
	 * DTSTART が反復の起点)。よって recurrence を指定するなら due(→ DTSTART/DUE)も
	 * 必須という契約にする(下の防御的 throw、および application 層 create-todo.ts の
	 * 本線チェック)。ドメイン型 RecurrenceRule をそのまま受け取る(MCP 由来の素朴な
	 * 語彙からの変換は application 層の責務 — values 層の recurrenceRule() を経由済みの
	 * 検証済み値がここに来る)。
	 */
	recurrence?: RecurrenceRule;
}

// VALUE=DATE パラメータ。DTSTART/DUE を終日として立てるときに共通で使う。
const VALUE_DATE_PARAMS: readonly Parameter[] = [{ name: "VALUE", values: ["DATE"] }];

/**
 * VCALENDAR(VERSION:2.0 + PRODID)+ VTODO の Component ツリーを新規に組み立てる。
 *
 * 【DTSTART/DUE を同値で両方立てる理由】ファイル冒頭コメントの iOS 実機キャプチャ準拠。
 * 【エスケープの境界】SUMMARY/DESCRIPTION は encodeText で TEXT エスケープを付与してから
 * upsertProperty に渡す(Property.value は「生テキスト(エスケープ済み)」を保持する契約 —
 * structure/types.ts のファイル冒頭コメント)。75 オクテット折り畳みはこの層ではやらない
 * (serialize() が担う。edit.ts のファイル冒頭コメントと同じ境界)。
 */
export function buildVTodoCalendar(fields: VTodoFields): Component {
	if (fields.due !== undefined && fields.dueValueType !== "DATE") {
		// 契約違反(呼び出し側のバグ)。zod 側で弾くのが本線だが、domain 層としても
		// 「表現できない入力を黙って壊さない」方針(CLAUDE.md ロスレス優先)で防御する。
		throw new Error("buildVTodoCalendar: due requires dueValueType 'DATE' (DATE-TIME is not yet supported)");
	}
	if (fields.recurrence !== undefined && fields.due === undefined) {
		// RRULE は DTSTART をアンカーにする(§3.8.5.3)。application 層(create-todo.ts)が
		// 本線として先に弾く契約だが、ここでも防御的に throw する(vtodo-write.ts 冒頭コメントの
		// 「表現できない入力を黙って壊さない」方針どおり — 上の due/dueValueType チェックと対称)。
		throw new Error("buildVTodoCalendar: recurrence requires due (RRULE needs a DTSTART anchor)");
	}

	let vtodo: Component = { name: "VTODO", properties: [], components: [] };
	vtodo = upsertProperty(vtodo, "UID", fields.uid);
	vtodo = upsertProperty(vtodo, "SUMMARY", encodeText(fields.summary));
	if (fields.description !== undefined) {
		vtodo = upsertProperty(vtodo, "DESCRIPTION", encodeText(fields.description));
	}
	if (fields.due !== undefined) {
		// iOS 実機キャプチャどおり DTSTART と DUE を同値・同値型で両方立てる。
		vtodo = upsertProperty(vtodo, "DTSTART", fields.due, VALUE_DATE_PARAMS);
		vtodo = upsertProperty(vtodo, "DUE", fields.due, VALUE_DATE_PARAMS);
	}
	if (fields.recurrence !== undefined) {
		// DTSTART/DUE のすぐ後に RRULE を置く(実機フィクスチャ real-ios/vtodo-recurring-master.ics
		// の並び DTSTART, DUE, ..., RRULE に寄せる。upsertProperty の追加順で決まるだけで
		// RFC 上は順序に意味は無いが、決定的な出力にして diff/テストを安定させる狙い)。
		vtodo = upsertProperty(vtodo, "RRULE", formatRecurrenceRule(fields.recurrence));
	}
	if (fields.priority !== undefined && fields.priority !== 0) {
		// PRIORITY:0 は「未設定」と等価(§3.8.1.9)なのでプロパティ自体を省略する
		// (0 を明示的に書いても意味は変わらないが、iOS 実機は 0 の VTODO で PRIORITY を
		// 送ってこないため、実データに揃えて省略する)。
		vtodo = upsertProperty(vtodo, "PRIORITY", String(fields.priority));
	}

	// 生成プロパティ(STATUS/CREATED/LAST-MODIFIED/DTSTAMP/X-APPLE-SORT-ORDER)は
	// vtodo-stamp.ts の stampCreate に一本化(このファイルに直書きしない — 生成方針の
	// 単一情報源を1箇所に保つため。②-a のスライス方針どおり)。
	vtodo = stampCreate(vtodo, fields.now);

	const vcalendar: Component = {
		name: "VCALENDAR",
		properties: [
			{ name: "VERSION", parameters: [], value: "2.0" },
			{ name: "PRODID", parameters: [], value: PRODID },
			// CALSCALE(§3.7.1)。iOS 実機が送ってくる VCALENDAR に必ず含まれる(docs/modeling/06)。
			// GREGORIAN が既定値だが RFC 上省略可 — 「RFC 定義 + iOS 使用 + 忠実維持できる」の
			// 積極生成方針(②-a)により明示的に出す。
			{ name: "CALSCALE", parameters: [], value: "GREGORIAN" },
		],
		components: [vtodo],
	};
	return vcalendar;
}
