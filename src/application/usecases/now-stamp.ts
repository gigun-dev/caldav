// =============================================================================
// now-stamp — Date から NowStamp を組み立てる共有ヘルパー(E-1 スライス②-b で抽出)
// =============================================================================
//
// 【抽出の経緯】
// create-todo.ts に「Date から NowStamp(vtodo-stamp.ts の生成プロパティ入力)を組み立てる」
// 15行ほどのブロックが直書きされていた。UpdateTodo/CompleteTodo(②-b)も同じ変換を必要と
// するため、重複させず1関数に共通化する。挙動は create-todo.ts の元実装と完全に同一
// (utcRaw の桁組み立て・unixSeconds の Math.floor)。
// =============================================================================

import type { NowStamp } from "../../domain/ical/semantics/vtodo-stamp";

/**
 * Date から NowStamp を組み立てる。
 * - utcRaw: DTSTAMP/CREATED/LAST-MODIFIED にそのまま書ける UTC 生値(§3.3.5 の UTC 形式)。
 * - unixSeconds: X-APPLE-SORT-ORDER 算出用の Unix エポック秒(秒未満切り捨て)。
 */
export function nowStampFromDate(d: Date): NowStamp {
	const utcRaw = `${d.getUTCFullYear().toString().padStart(4, "0")}` +
		`${(d.getUTCMonth() + 1).toString().padStart(2, "0")}` +
		`${d.getUTCDate().toString().padStart(2, "0")}T` +
		`${d.getUTCHours().toString().padStart(2, "0")}` +
		`${d.getUTCMinutes().toString().padStart(2, "0")}` +
		`${d.getUTCSeconds().toString().padStart(2, "0")}Z`;
	return { utcRaw, unixSeconds: Math.floor(d.getTime() / 1000) };
}
