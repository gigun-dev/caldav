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
import type { NowStamp } from "./vtodo-stamp";

// VALUE=DATE パラメータ。vtodo-write.ts と同じ定数(用途が同じなので値も揃える。
// 型が readonly Parameter[] の局所定数のため、共有ファイルへ格上げするほどの重複ではないと
// 判断してこのファイルにも定義する — DRY より「各ファイルが自己完結して読める」を優先)。
const VALUE_DATE_PARAMS = [{ name: "VALUE", values: ["DATE"] }] as const;

/** patchVTodoFields の入力。与えられたフィールドのみを upsert する(undefined は無視)。 */
export interface VTodoPatchFields {
	/** SUMMARY(§3.8.1.12)。意味的な文字列(エスケープ前)。 */
	summary?: string;
	/** DESCRIPTION(§3.8.1.5)。意味的な文字列(エスケープ前)。 */
	description?: string;
	/**
	 * DUE(§3.8.2.3)の生値。dueValueType が "DATE" のときのみ YYYYMMDD を渡す。
	 * 【スコープ外】due の「削除」(DTSTART/DUE を取り除く)はこの関数では扱わない
	 * (呼び出し側の要求に無い操作を先取りで作らない判断。将来必要になったら
	 * removeProperty(vtodo,"DUE")/removeProperty(vtodo,"DTSTART") を呼ぶ別関数を足す)。
	 */
	due?: string;
	/** due の値型。"DATE" のみサポート(vtodo-write.ts と同じ制約)。due 指定時は必須。 */
	dueValueType?: "DATE";
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
	if (fields.due !== undefined && fields.dueValueType !== "DATE") {
		// vtodo-write.ts の buildVTodoCalendar と同じ防御的 throw(契約違反はコード側のバグ)。
		throw new Error("patchVTodoFields: due requires dueValueType 'DATE' (DATE-TIME is not yet supported)");
	}

	let out = vtodo;

	if (fields.summary !== undefined) {
		out = upsertProperty(out, "SUMMARY", encodeText(fields.summary));
	}
	if (fields.description !== undefined) {
		out = upsertProperty(out, "DESCRIPTION", encodeText(fields.description));
	}
	if (fields.due !== undefined) {
		// iOS 実機キャプチャどおり DTSTART と DUE を同値・同値型で両方 upsert する
		// (vtodo-write.ts buildVTodoCalendar と同じ規約)。
		out = upsertProperty(out, "DTSTART", fields.due, VALUE_DATE_PARAMS);
		out = upsertProperty(out, "DUE", fields.due, VALUE_DATE_PARAMS);
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
