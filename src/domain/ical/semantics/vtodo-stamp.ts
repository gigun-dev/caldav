// =============================================================================
// vtodo-stamp — サーバー発 VTODO の生成プロパティ(E-1 スライス②-a)
// =============================================================================
//
// 【この層の責務・単一情報源にする理由】
// 「RFC 定義 + iOS 使用 + 忠実維持できる → 積極生成」方針(2026-07-12 iOS 実機実測、
// docs/modeling/06 §D9)のもと、CreateTodo/UpdateTodo/CompleteTodo(②-b/②-c で追加)が
// それぞれ個別に STATUS/CREATED/LAST-MODIFIED/DTSTAMP/X-APPLE-SORT-ORDER を書くと、
// 「create では触るが update では触らない」ような差分ルールが複数箇所に散って事故る
// (例: update が誤って CREATED を今の時刻で上書きしてしまう)。生成プロパティの
// 「何を・いつ触るか」をこのファイル1箇所にまとめ、各 UC は stampCreate/stampUpdate を
// 呼ぶだけにする。
//
// 【structure/edit.ts の upsertProperty のみで組み立てる理由】
// 出現順保持・ロスレス最小 diff の方針(edit.ts ファイル冒頭コメント)をここでも踏襲する。
// VALARM や X-APPLE-* など他のプロパティ・サブコンポーネントには一切触れない
// (stampCreate は「新規組み立て中の VTODO に足りないプロパティを足す」用途、stampUpdate は
// 「既存 VTODO の一部だけ書き換える」patch 方式 — vtodo-write.ts 冒頭コメントの区別と対応)。
//
// 【now を引数注入にする理由(Clock port を導入しない)】
// create-todo.ts の既存判断(Clock/IdGenerator port は導入しない・YAGNI)に合わせる。
// この純関数自体は「今」を知らず、呼び出し側(application 層)が Date から組み立てた
// NowStamp を渡す形にすることでテスト容易性を保つ(固定値を渡せば決定的にテストできる)。
// =============================================================================

import type { Component } from "../structure/types";
import { upsertProperty } from "../structure/edit";

/**
 * 「今」の2表現をまとめた入力型。
 * - utcRaw: DTSTAMP/CREATED/LAST-MODIFIED にそのまま書ける UTC 生値(例 "20260712T120000Z"、
 *   §3.3.5 DATE-TIME の UTC 形式)。
 * - unixSeconds: X-APPLE-SORT-ORDER の算出に使う Unix エポック秒(Date.getTime()/1000 相当)。
 *   utcRaw から逆算もできなくはないが、呼び出し側は既に Date を持っているはずなので
 *   二度手間になる parse を避けるためそのまま渡してもらう。
 */
export interface NowStamp {
	readonly utcRaw: string;
	readonly unixSeconds: number;
}

/**
 * X-APPLE-SORT-ORDER は Apple の CFAbsoluteTime(2001-01-01T00:00:00Z を起点とする秒数)を
 * 使っている(iOS 実機キャプチャで実測・裏取り済み: docs/modeling/06 §D9)。
 * 2001-01-01T00:00:00Z の Unix エポック秒がこの定数(1970-01-01 起点との差分)。
 * 実測: create 2026-07-12T11:48:30Z(unix 1783856910) の X-APPLE-SORT-ORDER が 805549710。
 * 1783856910 - 805549710 = 978307200 で一致することを確認済み。
 */
export const CF_ABSOLUTE_EPOCH_OFFSET_SECONDS = 978307200;

/**
 * 新規 VTODO 作成時に付けるプロパティを upsert する。
 * - STATUS:NEEDS-ACTION(§3.8.1.11) — 既に STATUS があれば触らない(呼び出し側が明示的に
 *   別の初期状態を設定したいケースへの防御。今回の CreateTodo は STATUS を渡さないので
 *   実質常に新規セットされるが、将来 import 系 UC がこの関数を再利用する可能性を考慮)。
 * - CREATED(§3.8.7.1)/LAST-MODIFIED(§3.8.7.3)/DTSTAMP(§3.8.7.2) は無条件で now.utcRaw に
 *   upsert する(新規作成なので「既存値を保持する」余地がない = 常に今でよい)。
 * - X-APPLE-SORT-ORDER は iOS が実際に送ってくる Apple 拡張プロパティ(ベンダー拡張だが
 *   意味を解読でき忠実再現できるので積極生成の対象 — 方針どおり)。INTEGER 文字列で出す。
 */
export function stampCreate(vtodo: Component, now: NowStamp): Component {
	let out = vtodo;

	if (out.properties.every((p) => p.name !== "STATUS")) {
		out = upsertProperty(out, "STATUS", "NEEDS-ACTION");
	}

	out = upsertProperty(out, "CREATED", now.utcRaw);
	out = upsertProperty(out, "LAST-MODIFIED", now.utcRaw);
	out = upsertProperty(out, "DTSTAMP", now.utcRaw);

	const sortOrder = now.unixSeconds - CF_ABSOLUTE_EPOCH_OFFSET_SECONDS;
	out = upsertProperty(out, "X-APPLE-SORT-ORDER", String(sortOrder));

	return out;
}

/**
 * 既存 VTODO の部分更新時に付けるプロパティを upsert する。
 *
 * 【CREATED・X-APPLE-SORT-ORDER・STATUS に触らない理由(② -b/-c で使う際の重要な制約)】
 * - CREATED を更新のたびに「今」へ書き換えると「作成時刻」という意味が壊れる(RFC 上も
 *   §3.8.7.1 は「作成された日時」であって更新日時ではない)。
 * - X-APPLE-SORT-ORDER は CREATED から導出される値(実測: create 時刻ベース)なので、
 *   CREATED を保持する以上これも保持しないと矛盾する。
 * - STATUS は UpdateTodo が触るべきプロパティではない(完了操作は CompleteTodo が担う
 *   想定 — ②-c)。stampUpdate は「更新した」という事実だけを記録する。
 * LAST-MODIFIED(§3.8.7.3)/DTSTAMP(§3.8.7.2) のみ now.utcRaw に upsert する。
 */
export function stampUpdate(vtodo: Component, now: NowStamp): Component {
	let out = vtodo;
	out = upsertProperty(out, "LAST-MODIFIED", now.utcRaw);
	out = upsertProperty(out, "DTSTAMP", now.utcRaw);
	return out;
}
