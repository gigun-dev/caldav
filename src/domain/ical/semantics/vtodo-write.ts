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
//   同じ値で立てる。時刻付き due(DATE-TIME;TZID)も同じ規律で DTSTART;TZID=... と
//   DUE;TZID=... を同値で立てる(下記 V6 コメント参照)。
// - 【2026-07-13 V6: 時刻付き due(DATE-TIME;TZID)に対応】
//   スライス①時点(2026-07-12)では「domain/ical/timezone/ に TZID→VTIMEZONE 生成
//   ユーティリティが無い」ため DATE-TIME を reject していたが、V6 で
//   timezone/vtimezone-write.ts の buildVTimezone を新設したため解禁する
//   (旧 dueValueType?: "DATE" 限定・DATE-TIME reject throw は撤去 — 概念自体は正しかったが
//   単に「まだ実装が無い」だけだったので、実装ができた以上ここに残す理由が無い)。
//   VTIMEZONE 自体はこのファイルでは生成しない(vtimezone-write.ts の責務)。呼び出し側
//   (application 層の create-todo.ts)が窓を決めて buildVTimezone を呼び、結果の
//   Component を vtimezone フィールドで渡す契約にする(このファイルは「もらった
//   VTIMEZONE を VCALENDAR の先頭に置く」だけ — TZ 計算の知識を持ち込まない)。
// - CreateTodo では VALARM を設定しない(要件どおり。サーバー発アラームの実機挙動が
//   未検証のため、スライス①では踏み込まない)。
//   【2026-07-13 更新】V5 実機検証(サーバー発 VALARM を iOS が鳴らすか)の前提として、
//   任意指定の VALARM 生成に対応した(下記 alarm フィールド参照)。docs/modeling/06 §D5 の
//   実測どおり iOS は絶対 UTC TRIGGER の DISPLAY アラームを使う(相対 TRIGGER ではない)ため、
//   この実装もそれに倣う。相対トリガー・複数 VALARM・位置アラームは対象外(今回は
//   「絶対時刻の DISPLAY アラーム1個」のみ。iOS が最も素直に鳴らす形に絞って実機検証を先に通す)。
// =============================================================================

import type { Component, Parameter } from "../structure/types";
import { appendSubComponent, upsertProperty } from "../structure/edit";
import { encodeText } from "../values/text-value";
import { formatRecurrenceRule, type RecurrenceRule } from "../values/recurrence-rule";
import { stampCreate, type NowStamp } from "./vtodo-stamp";
import { buildProximityAlarm, type ProximityAlarmInput } from "./valarm-write";

/**
 * VTODO に載せる VALARM の判別 union(#51 Phase 1)。
 * - "absolute": 時刻の絶対 UTC TRIGGER アラーム(due 由来。従来の alarm フィールドと同じ shape)。
 * - "proximity": 位置(geofence)アラーム(valarm-write.ts の buildProximityAlarm で組む)。
 *
 * 【なぜ配列で共存を許すか】iOS のリマインダーは「期日通知(絶対)」と「場所通知(proximity)」を
 * 1つの VTODO に同時に持てる(due + 位置リマインダー)。Phase 1 は最大2個(absolute 1 + proximity 1)で
 * 十分なので、単一 union ではなく union の配列にして共存を表現する(順序は配列順どおり appendSubComponent)。
 */
export type VTodoAlarmInput =
	| { readonly kind: "absolute"; readonly triggerUtcRaw: string; readonly uid: string }
	| ({ readonly kind: "proximity" } & ProximityAlarmInput);

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
	 * DUE(§3.8.2.3)の判別 union。DTSTART も同値・同値型で立てる(ファイル冒頭コメント)。
	 * - "DATE": VALUE=DATE の終日。raw は "YYYYMMDD"。
	 * - "DATE-TIME": TZID 付きの時刻指定(V6)。raw は "YYYYMMDDTHHMMSS"(Z無し・壁時計)。
	 *   tzid は DTSTART;TZID=.../DUE;TZID=... のパラメータ値(IANA 名を渡す契約 — 呼び出し側
	 *   の application 層が isValidIanaZone で検証済みのものを渡す)。DATE-TIME を渡すときは
	 *   vtimezone も必須(下記 buildVTodoCalendar の防御的 throw 参照)。
	 */
	due?: { type: "DATE"; raw: string } | { type: "DATE-TIME"; raw: string; tzid: string };
	/**
	 * VTIMEZONE(§3.6.5)。due が DATE-TIME のとき必須。呼び出し側(application 層)が
	 * timezone/vtimezone-write.ts の buildVTimezone で組み立てたものをそのまま渡す
	 * (このファイルは TZ 計算をしない — ファイル冒頭 V6 コメント参照)。VCALENDAR の
	 * components 先頭に置く(iOS 実機キャプチャの並び: VTIMEZONE が VTODO より先 —
	 * real-ios/vtodo-recurring-master.ics 実測どおり)。
	 */
	vtimezone?: Component;
	/** PRIORITY(§3.8.1.9)。0-9。0(既定=未設定)を渡すとプロパティ自体を省略する。 */
	priority?: number;
	/**
	 * LOCATION(§3.8.1.7)。省略可。SUMMARY/DESCRIPTION と同じくエスケープ前の意味的文字列を
	 * 受け取り、ここで encodeText する。空文字("")は「未設定」と同義に扱い LOCATION を書かない
	 * (呼び出し側 application 層 create-todo.ts が空文字→未設定の正規化を担うが、防御的に
	 * ここでも空文字はプロパティを省略する — PRIORITY:0 を未設定扱いで省略するのと同じ発想)。
	 */
	location?: string;
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
	/**
	 * VALARM(§3.6.6)。任意指定(due とは独立 — due が無くてもアラーム単体で設定できる)。
	 * 【iOS 実機準拠(docs/modeling/06 §D5)】iOS の時刻アラームは相対 TRIGGER
	 * (TRIGGER;RELATED=START 等)ではなく **絶対 UTC の TRIGGER;VALUE=DATE-TIME** を使う。
	 * よってここでも絶対 UTC のみ受け付ける(相対トリガーは対象外 — ファイル冒頭コメント)。
	 * triggerUtcRaw は呼び出し側(application 層)が組み立てた "YYYYMMDDTHHMMSSZ" の生値。
	 * uid は呼び出し側が採番した UUID(VALARM の UID と X-WR-ALARMUID に同値で使う —
	 * iOS 実機フィクスチャ real-ios/vtodo-recurring-master.ics の実測どおり)。
	 *
	 * 【#51 Phase 1: 単一 absolute から union の配列へ拡張】
	 * 旧 `alarm?: { triggerUtcRaw; uid }`(絶対時刻アラーム1個)を VTodoAlarmInput[] に拡張した。
	 * due 由来の absolute アラームと位置(proximity)アラームを1つの VTODO に共存させるため
	 * (最大2個)。配列順に VALARM を append する。undefined/空配列なら VALARM を書かない(従来どおり)。
	 */
	alarms?: readonly VTodoAlarmInput[];
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
	if (fields.due !== undefined && fields.due.type === "DATE-TIME" && fields.vtimezone === undefined) {
		// §3.6.5: TZID 付き日時プロパティを使うカレンダーは対応する VTIMEZONE を
		// 含めなければならない(この契約は application 層 create-todo.ts が本線で満たすが、
		// ここでも防御的に throw する — vtodo-write.ts 冒頭コメントの
		// 「表現できない入力を黙って壊さない」方針どおり)。
		throw new Error("buildVTodoCalendar: due type 'DATE-TIME' requires vtimezone (§3.6.5)");
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
		if (fields.due.type === "DATE") {
			vtodo = upsertProperty(vtodo, "DTSTART", fields.due.raw, VALUE_DATE_PARAMS);
			vtodo = upsertProperty(vtodo, "DUE", fields.due.raw, VALUE_DATE_PARAMS);
		} else {
			// DATE-TIME;TZID(V6)。VALUE=DATE-TIME は§3.8.2.3の既定値型なので VALUE パラメータは
			// 省略する(iOS 実機キャプチャ vtodo-recurring-master.ics も DTSTART;TZID=... の形で
			// VALUE パラメータを送らない — 既定値を明示しない実データに揃える)。
			const tzidParams: readonly Parameter[] = [{ name: "TZID", values: [fields.due.tzid] }];
			vtodo = upsertProperty(vtodo, "DTSTART", fields.due.raw, tzidParams);
			vtodo = upsertProperty(vtodo, "DUE", fields.due.raw, tzidParams);
		}
	}
	if (fields.recurrence !== undefined) {
		// DTSTART/DUE のすぐ後に RRULE を置く(実機フィクスチャ real-ios/vtodo-recurring-master.ics
		// の並び DTSTART, DUE, ..., RRULE に寄せる。upsertProperty の追加順で決まるだけで
		// RFC 上は順序に意味は無いが、決定的な出力にして diff/テストを安定させる狙い)。
		vtodo = upsertProperty(vtodo, "RRULE", formatRecurrenceRule(fields.recurrence));
	}
	if (fields.location !== undefined && fields.location !== "") {
		// LOCATION(§3.8.1.7)。空文字は未設定と同義なので書かない(VTodoFields.location コメント)。
		// DTSTART/DUE/RRULE の後・PRIORITY の前に置く(RFC 上は順序に意味は無いが、決定的な出力で
		// diff/テストを安定させる既存方針に揃える)。
		vtodo = upsertProperty(vtodo, "LOCATION", encodeText(fields.location));
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

	if (fields.alarms !== undefined) {
		// VALARM は VTODO 本体プロパティが揃った後に足す(stampCreate の後段。VALARM 自体は
		// STATUS/DTSTAMP 等の生成プロパティに依存しないが、fixture の並び — VTODO 本体プロパティ
		// 群の後に VALARM サブコンポーネント — に揃えて決定的な出力にする)。配列順に append する
		// (#51: absolute + proximity の共存。呼び出し側が [absolute, proximity] の順で渡せば実測に近い並び)。
		for (const alarm of fields.alarms) {
			if (alarm.kind === "proximity") {
				// 位置(geofence)アラーム。valarm-write.ts の buildProximityAlarm に委譲する
				// (proximity 固有の TRIGGER 番兵・X-APPLE-PROXIMITY・REFERENCEFRAME 付き
				// structured-location の知識はそちらに閉じる)。
				vtodo = appendSubComponent(vtodo, buildProximityAlarm(alarm));
				continue;
			}
			// 絶対時刻アラーム(due 由来)。
			// 【iOS 実機フィクスチャ準拠のプロパティ順序: ACTION → DESCRIPTION → TRIGGER → UID →
			// X-WR-ALARMUID】RFC 5545 はプロパティの出現順に意味を持たせないが、
			// real-ios/vtodo-recurring-master.ics の実測順をそのまま再現する(diff/テストの安定性、
			// および「iOS が書く形を素直に模倣する」V5 検証の狙いに沿うため)。
			const valarm: Component = {
				name: "VALARM",
				properties: [
					// ACTION:DISPLAY(§3.8.6.1)。iOS の時刻通知はこの1択(AUDIO/EMAIL 等は対象外)。
					{ name: "ACTION", parameters: [], value: "DISPLAY" },
					// DESCRIPTION は ACTION:DISPLAY で REQUIRED(§3.8.6.1)。iOS 実機は固定文字列
					// "Reminder" を送ってくる(ユーザー入力の SUMMARY とは無関係)ので、それに倣う。
					{ name: "DESCRIPTION", parameters: [], value: "Reminder" },
					// TRIGGER;VALUE=DATE-TIME(§3.8.6.3)。既定は RELATED=START の相対値だが、
					// iOS 実機は絶対 UTC を使う(ファイル冒頭コメント・VTodoFields.alarms コメント参照)。
					{
						name: "TRIGGER",
						parameters: [{ name: "VALUE", values: ["DATE-TIME"] }],
						value: alarm.triggerUtcRaw,
					},
					// UID / X-WR-ALARMUID(iOS 拡張・非標準)。iOS はこの2つを同値にして VALARM を
					// 一意識別する。UID は VALARM 内では RFC 5545 上 OPTIONAL だが、iOS 実機が
					// 必ず送ってくるため同じ形を再現する(ロスレス方針・iOS 品質基準)。
					{ name: "UID", parameters: [], value: alarm.uid },
					{ name: "X-WR-ALARMUID", parameters: [], value: alarm.uid },
				],
				components: [],
			};
			vtodo = appendSubComponent(vtodo, valarm);
		}
	}

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
		// VTIMEZONE は VTODO より先(iOS 実機キャプチャの並び — ファイル冒頭 VTodoFields.vtimezone
		// コメント参照)。fields.vtimezone が無ければ従来どおり VTODO 単独。
		components: fields.vtimezone !== undefined ? [fields.vtimezone, vtodo] : [vtodo],
	};
	return vcalendar;
}
