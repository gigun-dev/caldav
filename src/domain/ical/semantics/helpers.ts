// =============================================================================
// semantics/ 層 共通ヘルパー(レンズが Component を読むための道具箱)
// =============================================================================
//
// 【この層のレンズの原則(モデル図 §1-1)】
// 意味論レイヤーは Component を「独自データ構造に変換しない」。VEvent は内部に
// Component(name=VEVENT)を1つ持つだけで、dtstart などのアクセサは呼ばれるたびに
// 内部 Component の Property を values/ コーデックで解釈して返す。この方針だと未知の
// X-APPLE-* プロパティは Component 内に触れられず残り続け、ロスレス往復(§1-1 の設計決定)が
// 壊れない。ここに置くのは「Property を名前で引く」「パラメータを読む」「値型を判定する」
// といった、全レンズで共通の下ごしらえ関数。
//
// 【プロパティ名・パラメータ名の一致は「大文字完全一致」でよい理由】
// structure/types.ts の契約により、パーサーは name/param-name を大文字へ正規化済み。
// よってここでは toUpperCase を再度かけず、呼び出し側が大文字リテラル("DTSTART" 等)で
// 引けば必ず一致する。列挙「値」(STATUS の CONFIRMED 等)だけは §3.1 で case-insensitive
// なので、値を比較するときは別途 toUpperCase する(それはレンズ側の責務)。
// =============================================================================

import type { Component, Property } from "../structure/types";
import { type CalDate, parseCalDate } from "../values";
import { type CalDateTime, parseCalDateTime } from "../values";

/** name(大文字)に一致する最初の Property。無ければ undefined。 */
export function firstProp(c: Component, name: string): Property | undefined {
	return c.properties.find((p) => p.name === name);
}

/** name(大文字)に一致する全 Property(出現順)。カーディナリティ検査・複数値プロパティ用。 */
export function allProps(c: Component, name: string): Property[] {
	return c.properties.filter((p) => p.name === name);
}

/** Property の生の値文字列(コーデック解釈しない)。プロパティ自体が無ければ undefined。 */
export function rawValue(c: Component, name: string): string | undefined {
	return firstProp(c, name)?.value;
}

/** name(大文字)に一致するサブコンポーネント(出現順)。VALARM / STANDARD / DAYLIGHT 抽出用。 */
export function subComponents(c: Component, name: string): Component[] {
	return c.components.filter((sc) => sc.name === name);
}

/**
 * パラメータの最初の値を返す(§3.2 のパラメータは複数値を持ちうるが、TZID/VALUE など
 * ここで見たいものは常に単一値)。パラメータ自体が無ければ undefined。
 */
export function paramFirst(p: Property, name: string): string | undefined {
	return p.parameters.find((pm) => pm.name === name)?.values[0];
}

/**
 * プロパティの「値型」を判定する(DATE か DATE-TIME か)。
 *
 * §3.3.5 の既定: DTSTART/DTEND/DUE/RECURRENCE-ID の既定値型は DATE-TIME で、
 * `;VALUE=DATE` が明示されたときだけ DATE になる。VALUE 名は列挙値なので
 * case-insensitive(§3.1)。ここで大文字化して照合する。
 */
export function valueType(p: Property): "DATE" | "DATE-TIME" {
	const v = paramFirst(p, "VALUE");
	return v !== undefined && v.toUpperCase() === "DATE" ? "DATE" : "DATE-TIME";
}

/**
 * DATE / DATE-TIME 兼用の日時アクセサ本体。VALUE と TZID パラメータを見て
 * CalDate か CalDateTime を返す(§3.3.4 / §3.3.5)。
 *
 * - VALUE=DATE       → CalDate(TZID は付いていても無視。§3.3.5 で DATE への TZID は
 *                       MUST NOT なので、そもそも付いていたら I8 側で違反として拾う)
 * - それ以外(DATE-TIME)→ TZID パラメータを parseCalDateTime に渡して 3 形態へ解釈
 *
 * 値が壊れていれば values/ コーデックが InvalidValueError を throw する。
 * この関数はそれを握り潰さず伝播させる(errors.ts の方針: アクセサは throw 伝播、
 * validate は catch して収集)。
 */
export function parseDateOrDateTime(p: Property): CalDate | CalDateTime {
	if (valueType(p) === "DATE") {
		return parseCalDate(p.value);
	}
	const tzid = paramFirst(p, "TZID");
	return parseCalDateTime(p.value, tzid);
}

/** CalDate | CalDateTime の型ガード。CalDateTime だけが `kind` を持つ(値オブジェクトの形状差)。 */
export function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/**
 * 同じ「値型・形態」かを判定する(値型 + kind + tzid の完全一致)。
 *   - 一方が DATE で他方が DATE-TIME → 不一致
 *   - 両方 DATE-TIME → kind(floating/utc/zoned)も一致し、zoned なら tzid も一致
 *
 * 【現在未使用。形態完全一致の検証が必要になったら使う。】
 * 2026-07-09 原文再照合: 唯一の呼び出し元だった VEvent の RECURRENCE-ID 検証は、§3.8.4.4 の
 * 明示 MUST が「値型一致 + floating iff floating」の2点のみと判明したため、この完全一致判定を
 * やめて緩めた(vevent.ts の該当箇所参照)。utc⇔utc / zoned+tzid の完全一致まで縛る MUST は
 * RFC 上どこにも無いので、この関数は一旦どこからも呼ばれない。定義は消さず残す — 将来
 * 「値だけでなく形態も完全一致していること」を要求する検証(例: 厳格モードの往復照合)が
 * 出てきたときに再利用できるため。冗長を理由に消さない(CLAUDE.md コメント方針)。
 */
export function sameDateForm(a: CalDate | CalDateTime, b: CalDate | CalDateTime): boolean {
	const aDt = isCalDateTime(a);
	const bDt = isCalDateTime(b);
	if (aDt !== bDt) return false; // DATE vs DATE-TIME
	if (!aDt || !bDt) return true; // 両方 DATE
	if (a.kind !== b.kind) return false;
	if (a.kind === "zoned" && b.kind === "zoned") return a.tzid === b.tzid;
	return true;
}

/**
 * compareDateValue で「VTIMEZONE 解決なしに大小比較して良い」形態かを判定する。
 * DUE>DTSTART(I4)や将来の時系列検証の前段ガード用。
 *   - 一方が DATE で他方が DATE-TIME → 比較不能(false)。値型不一致自体は I6 側で別途違反報告される
 *   - 両方 DATE → 暦日で比較できる(true)
 *   - 両方 DATE-TIME かつ非 zoned で同一 kind(floating どうし / utc どうし)→ true
 *   - zoned が絡む or kind 不一致(floating vs utc 等)→ false
 *     (zoned は VTIMEZONE を解決しないと絶対時刻に落とせず、異形態間のフィールド辞書式比較は
 *      well-defined ではない。compareDateValue 直下の限界コメント参照)
 *
 * 2026-07-08: VTODO の DUE>DTSTART(I4)追加時に新設。P2 のレビュー指摘
 * (DTSTART;TZID=Asia/Tokyo:... + DUE:...Z のような形態不一致)を「比較不能」として弾き、
 * zoned+utc を無理に比較して誤検知する事故を防ぐためのガード。
 */
export function isChronologicallyComparable(a: CalDate | CalDateTime, b: CalDate | CalDateTime): boolean {
	const aDt = isCalDateTime(a);
	const bDt = isCalDateTime(b);
	if (aDt !== bDt) return false; // DATE vs DATE-TIME(値型不一致は比較しない)
	if (!aDt || !bDt) return true; // 両方 DATE
	if (a.kind === "zoned" || b.kind === "zoned") return false; // zoned は解決なしに比較不能
	return a.kind === b.kind; // floating どうし / utc どうしのみ比較可
}

/**
 * 日時値のフィールド順比較(a<b→負, a==b→0, a>b→正)。DTEND>DTSTART 判定(I3)用。
 *
 * 【この比較の限界を明記】floating/zoned は本来 VTIMEZONE 抜きに絶対時刻へ解決できず、
 * 異なる TZID 間の大小は well-defined ではない(cal-date-time.ts 冒頭の設計決定)。
 * だが DTSTART と DTEND は I6 により値型・形態が一致している前提なので、
 * 「同一形態どうしのフィールド辞書式比較」で DTEND>DTSTART は正しく判定できる。
 * 形態が食い違うケースは先に I6 違反として報告されるので、ここでの比較の甘さは実害にならない。
 */
export function compareDateValue(a: CalDate | CalDateTime, b: CalDate | CalDateTime): number {
	const fa = fields(a);
	const fb = fields(b);
	for (let i = 0; i < fa.length; i++) {
		if (fa[i]! !== fb[i]!) return fa[i]! - fb[i]!;
	}
	return 0;
}

// 比較用にフィールドを配列へ。DATE は時分秒を 0 とみなす(同一形態比較なので実害なし)。
function fields(v: CalDate | CalDateTime): number[] {
	if (isCalDateTime(v)) {
		return [v.year, v.month, v.day, v.hour, v.minute, v.second];
	}
	return [v.year, v.month, v.day, 0, 0, 0];
}
