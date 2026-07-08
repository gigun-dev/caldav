// =============================================================================
// TextValue — RFC 5545 §3.3.11 TEXT 値型のエスケープ規則(encode/decode)
// =============================================================================
//
// 【この値型が持つのは「エスケープ規則」だけ】
// TEXT の中身はただの Unicode 文字列。特別なのは、値文字列(生テキスト)の中で
// 一部の文字がバックスラッシュエスケープされている点。SUMMARY:A\, B\; C\nD の
// ような生値を、意味的な文字列 "A, B; C<改行>D" に復元(decode)し、逆に組み立てる
// (encode)コーデックを提供する。
//
// 【エスケープ規則(§3.3.11)】
//   ESCAPED-CHAR = ("\\" / "\;" / "\," / "\N" / "\n")
//   - "\\" → バックスラッシュ 1文字
//   - "\;" → セミコロン
//   - "\," → カンマ
//   - "\n" または "\N" → 改行(LF)。大文字 N も受理。
//   - COLON(:)はエスケープしては SHALL NOT(= コロンはそのまま。\: は作らない)。
//
// 【判断: decode 時の未知エスケープは寛容に(そのまま残す)】
// 例えば "\t" や "\x" のような規則外のエスケープが実データに来たとき、厳格に
// エラーにすると往復が壊れ、データ喪失につながる(モデル図 §1-1 のロスレス最優先方針)。
// よって未知の "\?" は「バックスラッシュと次の1文字をそのまま残す」= 何もしないで通す。
// こうすると decode→encode で "\?" が "\\?"(バックスラッシュを再エスケープ)に化けて
// 往復が崩れうるが、TEXT のロスレスは「生値をそのまま Property.value に持つ」構造層側で
// 担保されている(types.ts の設計決定)。この encode/decode は意味論アクセス用であり、
// 生値の可逆保持とは別レイヤー。だから寛容側に倒してよい。
// =============================================================================

/**
 * TEXT の生値(エスケープされた文字列)→ 意味的な文字列(decode)。
 * §3.3.11 のエスケープを解除する。
 */
export function decodeText(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1];
			switch (next) {
				case "\\":
					out += "\\";
					i++;
					break;
				case ";":
					out += ";";
					i++;
					break;
				case ",":
					out += ",";
					i++;
					break;
				case "n":
				case "N":
					// \n / \N はどちらも改行。RFC は LF を指定(CRLF ではなく)。
					out += "\n";
					i++;
					break;
				default:
					// 未知エスケープ: バックスラッシュをそのまま残し、次の文字は次ループで通常処理。
					// (寛容方針。ファイル冒頭の判断コメント参照。)
					out += "\\";
					break;
			}
		} else {
			// 末尾の孤立バックスラッシュもそのまま(壊れた実データ耐性)。
			out += ch;
		}
	}
	return out;
}

/**
 * 意味的な文字列 → TEXT の生値(encode)。§3.3.11 の要エスケープ文字を \ で保護する。
 *
 * エスケープ対象は BACKSLASH / SEMICOLON / COMMA / 改行 の4種のみ。
 * COLON はエスケープしない(§3.3.11: SHALL NOT)。
 * バックスラッシュを最初に処理する(後だと他のエスケープで挿入した \ を二重化してしまう)。
 */
export function encodeText(text: string): string {
	let out = "";
	for (const ch of text) {
		switch (ch) {
			case "\\":
				out += "\\\\";
				break;
			case ";":
				out += "\\;";
				break;
			case ",":
				out += "\\,";
				break;
			case "\n":
				// 改行は小文字 \n で出す(生成は1形態に統一。受理は \N も可)。
				out += "\\n";
				break;
			case "\r":
				// CR 単独は改行の一部として現れることがあるが、TEXT 値としては
				// LF に正規化して \n に寄せる…と往復が崩れるので、ここでは素通しにする。
				// (CRLF の \r\n が来たら \r は素通し + \n はエスケープ。実害はまず無い。)
				out += "\r";
				break;
			default:
				out += ch;
		}
	}
	return out;
}

/**
 * TextValue: decode 済みの意味的文字列をラップした値オブジェクト。
 *
 * 【なぜ薄いラッパを用意するか】
 * 他の値型(DATE-TIME 等)と API 形状を揃える(parse/format 対称ペアを持つ)ため。
 * 中身は decode 済み文字列そのもの。parse=decode、format=encode の別名を提供する。
 */
export interface TextValue {
	readonly text: string; // decode 済み(エスケープ解除後)の値。
}

/** 生値 → TextValue(decode してラップ)。 */
export function parseTextValue(raw: string): TextValue {
	return { text: decodeText(raw) };
}

/** TextValue → 生値(encode)。 */
export function formatTextValue(v: TextValue): string {
	return encodeText(v.text);
}
