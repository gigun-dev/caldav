// =============================================================================
// CalAddress — RFC 5545 §3.3.3 CAL-ADDRESS 値型(ORGANIZER / ATTENDEE の値)
// =============================================================================
//
// 【この値型(§3.3.3)】
//   CAL-ADDRESS = URI。実質的にはほぼ常に "mailto:" URI(例 mailto:alice@example.com)。
//   ORGANIZER / ATTENDEE プロパティの値として使う(スケジューリング文脈)。
//
// 【判断: 過度な検証はしない — URI として最低限成立するかだけ見る】
// 理由はモデル図 §1-1 のロスレス最優先方針。ATTENDEE は実データに壊れた値
// (スキームなし、全角、内部システム独自の URN 等)が普通に来る。ここで RFC 3986 の
// 厳密な URI 検証をかけて弾くと、往復保持(§3.6 の SHOULD NOT drop)を破ってしまう。
// よって「非空で、コロンでスキームらしきものが取れるか(mailto: など)」程度の
// 緩い検査に留める。スキームが無くてもエラーにはせず、scheme=undefined で受理する。
// この緩さは意図的。厳密性が要る局面(スケジューリング実装時)で別途強めればよい。
// =============================================================================

import { InvalidValueError } from "./errors";

/**
 * CAL-ADDRESS 値(§3.3.3)。イミュータブル。
 *
 * - uri: 生の URI 文字列(そのまま保持。往復のため加工しない)。
 * - scheme: URI スキームを小文字化して抜き出したもの(取れなければ undefined)。
 *   便宜フィールド。"mailto" 判定を上位で楽にするため。値の同一性は uri で見る。
 */
export interface CalAddress {
	readonly uri: string;
	readonly scheme?: string;
}

// スキーム抽出用。RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"。
// 先頭が英字で始まり ":" までがスキーム。緩め(検証ではなく抽出目的)。
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * 生の値文字列 → CalAddress(§3.3.3)。
 * 非空チェックだけを不変条件とし、スキームは取れれば添える。
 */
export function parseCalAddress(raw: string): CalAddress {
	// 空だけは弾く(ORGANIZER/ATTENDEE の値が空は明らかにデータ不整合)。
	if (raw.length === 0) {
		throw new InvalidValueError("CAL-ADDRESS", raw, "empty address");
	}
	const m = SCHEME_RE.exec(raw);
	// スキームが取れなければ undefined のまま受理(壊れた実データ耐性。上のコメント参照)。
	const scheme = m !== null ? m[1].toLowerCase() : undefined;
	return { uri: raw, scheme };
}

/**
 * CalAddress → 生の値文字列(§3.3.3)。
 * 保持している uri をそのまま返す(加工していないので往復は自明にロスレス)。
 */
export function formatCalAddress(a: CalAddress): string {
	return a.uri;
}
