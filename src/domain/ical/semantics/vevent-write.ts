// =============================================================================
// vevent-write — VEVENT 組み立て(E-3 スライス S1 CreateEvent 専用)
// =============================================================================
//
// 【この層の責務・vtodo-write.ts との対称】
// vtodo-write.ts の buildVTodoCalendar が「新規 VTODO をゼロから組み立てる」専用であるのと
// 完全に対称に、このファイルは「新規 VEVENT をゼロから組み立てる」専用。vevent.ts(既存)は
// 読み取りレンズ + validate に徹する読み取り専用ファイルであり CLAUDE.md の指示どおり
// この作業では変更しない。structure/edit.ts の汎用プリミティブ(upsertProperty 等)で
// VCALENDAR + VEVENT の Component ツリーを作り、application/usecases/create-event.ts が
// serialize() で ICS 化する。
//
// 【CreateEvent 以外でこのファイルを使わない方針(vtodo-write.ts と同じ境界)】
// buildVEventCalendar は「新規 VEVENT をゼロから作る」専用であり、既存リソースの部分更新
// (update-event)には使わない。既存 ICS の一部だけを書き換えるユースケースは
// findByUri → Component 取得 → vevent-patch.ts の patchVEventFields で patch する
// (ゼロから作り直すと iOS 発の X-APPLE-*/VALARM/DTEND⇄DURATION 等を丸ごと落とすため)。
//
// 【VTODO との違い(意図的に写経しなかった点)】
// - STATUS/X-APPLE-SORT-ORDER は書かない。STATUS:NEEDS-ACTION と X-APPLE-SORT-ORDER は
//   VTODO(リマインダー)固有の生成プロパティ(vtodo-stamp.ts の stampCreate が書く)であり、
//   VEVENT では STATUS は TENTATIVE|CONFIRMED|CANCELLED の OPTIONAL・ソート順の Apple 拡張も
//   イベントでは iOS が使わない。よって stampCreate は流用せず、イベントに必要な
//   DTSTAMP/CREATED/LAST-MODIFIED だけを書く(生成プロパティの過剰生成を避ける)。
// - 期日ではなく DTSTART(必須)+ DTEND(排他的終端・OPTIONAL)。VTODO の DUE/DTSTART 同値
//   規約とは異なり、イベントは「開始と終了」という別々の意味を持つ2点なので同値化しない。
// - VALARM は書かない(E-3 スコープ外 — VALARM 管理スライスに束ねる。docs/modeling/12 §1)。
// =============================================================================

import type { Component, Parameter } from "../structure/types";
import { upsertProperty } from "../structure/edit";
import { encodeText } from "../values/text-value";
import { formatRecurrenceRule, type RecurrenceRule } from "../values/recurrence-rule";
import type { NowStamp } from "./vtodo-stamp";

// PRODID(§3.7.3)。vtodo-write.ts の局所定数と同値(サーバー発 ICS の product identifier は
// コンポーネント種別を問わず同じ発行元。将来 ical/index.ts 経由で公開へ昇格する余地も同じ)。
const PRODID = "-//gigun-dev//caldav//EN";

// VALUE=DATE パラメータ(終日 DTSTART/DTEND 用)。vtodo-write.ts と同値。
const VALUE_DATE_PARAMS: readonly Parameter[] = [{ name: "VALUE", values: ["DATE"] }];

/**
 * DTSTART/DTEND の判別 union(vtodo-write.ts の VTodoFields.due と同じ2形態)。
 * - "DATE": VALUE=DATE の終日。raw は "YYYYMMDD"(区切り無し §3.3.4)。
 * - "DATE-TIME": TZID 付きの時刻指定。raw は "YYYYMMDDTHHMMSS"(Z無し壁時計 §3.3.5)。tzid は
 *   IANA 名(呼び出し側 application 層が isValidIanaZone 検証済みのものを渡す契約)。DATE-TIME を
 *   使うときは vtimezone 必須(§3.6.5。下記 buildVEventCalendar の防御的 throw)。
 */
export type VEventDateValue =
	| { type: "DATE"; raw: string }
	| { type: "DATE-TIME"; raw: string; tzid: string };

/** buildVEventCalendar の入力。 */
export interface VEventFields {
	/** UID(§3.8.4.7)。呼び出し側(application 層)が採番して渡す。 */
	uid: string;
	/** 「今」の UTC 生値(DTSTAMP/CREATED/LAST-MODIFIED 用)。X-APPLE-SORT-ORDER を書かないので
	 *  unixSeconds は使わないが、VTODO と同じ NowStamp 型を受けて呼び出し側の組み立てを揃える。 */
	now: NowStamp;
	/** SUMMARY(§3.8.1.12)。エスケープ前の意味的文字列(ここで encodeText する)。 */
	summary: string;
	/** DESCRIPTION(§3.8.1.5)。省略可。SUMMARY と同じくエスケープ前。 */
	description?: string;
	/**
	 * DTSTART(§3.8.2.4)。イベントには開始が必須(§3.6.1: DTSTART は METHOD 無しの VEVENT で REQUIRED)。
	 * DATE-TIME のときは vtimezone 必須(下の防御的 throw)。
	 */
	start: VEventDateValue;
	/**
	 * DTEND(§3.8.2.2)。排他的終端。省略時は DTEND を書かない(終日1日イベント = DTSTART のみ、
	 * 時刻付きで end 省略 = DTEND 無し。docs/modeling/12 §2)。値型は DTSTART と一致すべき(I6)だが、
	 * その一致検証・start>end 検証は application 層(create-event.ts)の責務にする(このファイルは
	 * 「渡された値をそのまま書く」に徹する — vtodo-write.ts が due の妥当性を UC に委ねるのと同じ)。
	 */
	end?: VEventDateValue;
	/**
	 * VTIMEZONE(§3.6.5)。start か end が DATE-TIME のとき必須。呼び出し側(application 層)が
	 * buildVTimezone で組み立てたものをそのまま渡す(このファイルは TZ 計算をしない)。VCALENDAR の
	 * components 先頭に置く(iOS 実機の並び — VTIMEZONE が VEVENT より先)。
	 */
	vtimezone?: Component;
	/** LOCATION(§3.8.1.7)。省略可。空文字は「未設定」と同義に扱い書かない(vtodo-write.ts と同じ)。 */
	location?: string;
	/**
	 * URL(§3.8.4.6)。省略可。空文字は未設定扱いで書かない(location と同じ規約)。
	 * 【値型は URI(TEXT ではない)】§3.8.4.6 原文で Value Type: URI。TEXT のような \, / \; /
	 * \n エスケープは URI 値には適用しない(§3.3.13 URI)。よって encodeText せず生値のまま書く
	 * (SUMMARY/LOCATION が encodeText するのと非対称なのは値型が違うため)。§3.8.4.6 は「once」なので
	 * upsertProperty(単一プロパティ差し替え)で足りる。
	 */
	url?: string;
	/**
	 * RRULE(§3.3.10 / §3.8.5.3)。DTSTART をアンカーにする(§3.8.5.3)。イベントは DTSTART が
	 * 常に必須なので VTODO のような「recurrence には due が必要」という前提チェックは不要
	 * (start が type で必須になっている)。ドメイン型 RecurrenceRule をそのまま受け取る
	 * (chat 語彙からの変換は application 層 create-event.ts の責務)。
	 */
	recurrence?: RecurrenceRule;
}

/**
 * VEVENT の DTSTART/DTEND プロパティを1つ upsert するヘルパー(DATE/DATE-TIME の分岐を1箇所に)。
 * VALUE=DATE は終日、TZID=... は時刻付き(DATE-TIME は §3.8.2.x の既定値型なので VALUE パラメータは
 * 出さない — iOS 実機が既定値を明示しないのに揃える。vtodo-write.ts の同じ判断)。
 */
function upsertDateProperty(component: Component, name: string, value: VEventDateValue): Component {
	if (value.type === "DATE") {
		return upsertProperty(component, name, value.raw, VALUE_DATE_PARAMS);
	}
	const tzidParams: readonly Parameter[] = [{ name: "TZID", values: [value.tzid] }];
	return upsertProperty(component, name, value.raw, tzidParams);
}

/**
 * VCALENDAR(VERSION:2.0 + PRODID + CALSCALE)+ VEVENT の Component ツリーを新規に組み立てる。
 *
 * 【エスケープ・折り畳みの境界】SUMMARY/DESCRIPTION/LOCATION は encodeText で TEXT エスケープを
 * 付与してから upsertProperty に渡す(Property.value は「生テキスト(エスケープ済み)」を保持する
 * 契約)。75 オクテット折り畳みは serialize() が担う(vtodo-write.ts と同じ境界)。
 */
export function buildVEventCalendar(fields: VEventFields): Component {
	const needsVtimezone = fields.start.type === "DATE-TIME" || fields.end?.type === "DATE-TIME";
	if (needsVtimezone && fields.vtimezone === undefined) {
		// §3.6.5: TZID 付き日時プロパティを使うカレンダーは対応する VTIMEZONE を含めなければならない。
		// application 層(create-event.ts)が本線で満たすが、ここでも防御的に throw する
		// (vtodo-write.ts の「表現できない入力を黙って壊さない」方針どおり)。
		throw new Error("buildVEventCalendar: DATE-TIME start/end requires vtimezone (§3.6.5)");
	}

	let vevent: Component = { name: "VEVENT", properties: [], components: [] };
	vevent = upsertProperty(vevent, "UID", fields.uid);
	vevent = upsertProperty(vevent, "SUMMARY", encodeText(fields.summary));
	if (fields.description !== undefined) {
		vevent = upsertProperty(vevent, "DESCRIPTION", encodeText(fields.description));
	}
	vevent = upsertDateProperty(vevent, "DTSTART", fields.start);
	if (fields.end !== undefined) {
		// DTEND は排他的終端(§3.8.2.2)。end 省略時は書かない(DURATION も書かない — 終日1日/
		// 開始のみのイベントを素直に表現する。docs/modeling/12 §2)。
		vevent = upsertDateProperty(vevent, "DTEND", fields.end);
	}
	if (fields.recurrence !== undefined) {
		// DTSTART/DTEND の後に RRULE を置く(RFC 上は順序に意味は無いが、決定的な出力で diff/テストを
		// 安定させる既存方針 — vtodo-write.ts と同じ)。
		vevent = upsertProperty(vevent, "RRULE", formatRecurrenceRule(fields.recurrence));
	}
	if (fields.location !== undefined && fields.location !== "") {
		vevent = upsertProperty(vevent, "LOCATION", encodeText(fields.location));
	}
	if (fields.url !== undefined && fields.url !== "") {
		// URL は URI 値型(§3.8.4.6)なので encodeText しない(生値のまま。VEventFields.url コメント参照)。
		vevent = upsertProperty(vevent, "URL", fields.url);
	}

	// 生成プロパティ。VTODO の stampCreate(STATUS/X-APPLE-SORT-ORDER 込み)は流用せず、イベントに
	// 必要な DTSTAMP/CREATED/LAST-MODIFIED だけを書く(ファイル冒頭「VTODO との違い」参照)。
	vevent = upsertProperty(vevent, "DTSTAMP", fields.now.utcRaw);
	vevent = upsertProperty(vevent, "CREATED", fields.now.utcRaw);
	vevent = upsertProperty(vevent, "LAST-MODIFIED", fields.now.utcRaw);

	const vcalendar: Component = {
		name: "VCALENDAR",
		properties: [
			{ name: "VERSION", parameters: [], value: "2.0" },
			{ name: "PRODID", parameters: [], value: PRODID },
			// CALSCALE(§3.7.1)。iOS 実機が必ず含める(vtodo-write.ts と同じ積極生成方針)。
			{ name: "CALSCALE", parameters: [], value: "GREGORIAN" },
		],
		// VTIMEZONE は VEVENT より先(iOS 実機の並び)。無ければ VEVENT 単独。
		components: fields.vtimezone !== undefined ? [fields.vtimezone, vevent] : [vevent],
	};
	return vcalendar;
}
