// =============================================================================
// iCalendar シリアライザ(RFC 5545 §3.1〜3.2): Component ツリー → ICS 文字列
// =============================================================================
//
// 【責務】parser.ts の逆写像。汎用構造層(Component / Property / Parameter)を
// RFC 5545 準拠のバイト列(CRLF 改行・75 オクテット折り畳み)に戻す。
// value は生テキストのまま出力する(エスケープの再付与はしない = parser がしなかったから)。
// これにより parse→serialize が「並べ替え以外の改変ゼロ」= ロスレス往復になる。
//
// 【出力の正規化方針】入力が LF 改行や非正規な折り畳みでも、出力は常に
//   - 改行 = CRLF(§3.1)
//   - 75 オクテット超は CRLF+SPACE で折り畳み(SHOULD)
//   - パラメータ値のクォートは「必要なときだけ」機械的に再決定(§3.2)
// に正規化する。よって「オクテット等価の往復」が成立するのは、入力が既にこの正規形
// (CRLF・正規折り畳み・必要最小限クォート)のときだけ。非正規入力は
// parse→serialize→parse の冪等性(意味論的等価)で担保する(test 参照)。
// =============================================================================

import type { Component, Parameter, Property } from "../structure/types";

/**
 * シリアライズエラー。RFC 5545 §3.1 の paramtext / quoted-string の文法上、
 * **DQUOTE を含むパラメータ値は表現不可**(quoted の中に DQUOTE を入れる術が無く、
 * エスケープ機構も無い)。生テキスト保持の設計では値を書き換えない方針なので、
 * 表現不可能な値に出会ったら黙って壊さず、明示的にエラーにする。
 */
export class SerializeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SerializeError";
	}
}

// UTF-8 エンコード後のオクテット数を数えるための共有エンコーダ。
// 折り畳み判定は「バイト数」で行う(§3.1 は "octets" で 75 を定義)必要があるため、
// JS の文字列長(UTF-16 コードユニット数)ではなく UTF-8 バイト数で測る。
const utf8 = new TextEncoder();

// 折り畳み閾値。RFC 5545 §3.1: 「行は 75 オクテットを超えるべきではない(SHOULD NOT)。
// ただし改行を除く」。iOS/Google も 75 で折ってくるので実データと揃う。
const MAX_LINE_OCTETS = 75;

/**
 * 1 論理行を 75 オクテット以下の物理行に折り畳む(RFC 5545 §3.1)。
 *
 * 【マルチバイトを割らない】オクテット数はコードポイント単位で積算し、
 * 「次の 1 文字を足すと 75 を超える」ところで CRLF+SPACE を挿入する。
 * `for...of` は文字列をコードポイント単位で回す(サロゲートペアを結合する)ため、
 * 1 コードポイントの UTF-8 バイト列(日本語なら 3 バイト)が途中で割れることはない。
 * → 日本語 SUMMARY が化けない、という要件はここで担保される。
 *
 * 【継続行の先頭 SPACE も勘定に入れる】折り畳み後の継続行は先頭に SPACE 1 個が付く。
 * これも物理行のオクテットに含まれる(§3.1: 継続行の先頭 1 文字は WSP)。
 * よって折った直後の行頭カウンタは 0 ではなく 1(SPACE の分)から始める。
 */
function foldLine(line: string): string {
	let out = "";
	let octets = 0; // 現在構築中の物理行のオクテット数(改行は含めない)

	for (const ch of line) {
		// 1 コードポイントの UTF-8 バイト数。ASCII は 1、日本語は概ね 3、絵文字は 4。
		const chOctets = utf8.encode(ch).length;

		// この 1 文字を足すと 75 を超えるなら、先に折る。
		// 注意: ">" であって ">=" ではない。ちょうど 75 は許容(§3.1 は「超えない」)。
		if (octets + chOctets > MAX_LINE_OCTETS) {
			out += "\r\n "; // 折り畳み: CRLF + SPACE 1 個
			octets = 1; // 継続行は先頭 SPACE の 1 オクテットから数え直す
		}

		out += ch;
		octets += chOctets;
	}

	return out;
}

/**
 * パラメータ値 1 個をシリアライズする(RFC 5545 §3.2)。
 * COLON(:)/ SEMICOLON(;)/ COMMA(,)を含む値は DQUOTE で囲む必要がある
 * (これらは非 quoted の文脈では区切り文字なので)。含まなければ裸で出す。
 * この「必要なときだけクォート」の判定を parser 側で捨てた情報(クォート有無)の
 * 代わりに使う(types.ts 契約: quoted か否かは値の内容から機械的に再決定できる)。
 */
function serializeParamValue(value: string): string {
	if (value.includes('"')) {
		// §3.1 の文法上、quoted-string の中に DQUOTE を入れる方法が無く、
		// paramtext(非 quoted)にも DQUOTE は含められない。表現不可能。
		throw new SerializeError(
			`parameter value contains a DQUOTE which RFC 5545 §3.2 cannot represent: ${JSON.stringify(value)}`,
		);
	}
	// 区切り文字を含むならクォートが必要。
	if (value.includes(":") || value.includes(";") || value.includes(",")) {
		return `"${value}"`;
	}
	return value;
}

// パラメータ 1 個を "NAME=v1,v2" 形式に。複数値はカンマ結合(§3.2)。
function serializeParameter(param: Parameter): string {
	const values = param.values.map(serializeParamValue).join(",");
	return `${param.name}=${values}`;
}

// プロパティ 1 個を 1 論理行(折り畳み前)にする。
// 形式: NAME *(";" param) ":" value。value は生テキストをそのまま。
function serializeProperty(prop: Property): string {
	let line = prop.name;
	for (const param of prop.parameters) {
		line += `;${serializeParameter(param)}`;
	}
	// 値は生のまま(エスケープ再付与なし)。空値プロパティ("X-EMPTY:")は value="" で
	// "X-EMPTY:" になり、これも正しく往復する。
	line += `:${prop.value}`;
	return line;
}

// コンポーネントを BEGIN..END で再帰的に論理行の配列へ展開する。
// 出力順は types.ts 契約どおり「プロパティ列 → サブコンポーネント列」で固定
// (実データはこの順で来るため、これでオクテット等価が保てる)。
function emitComponent(comp: Component, out: string[]): void {
	out.push(`BEGIN:${comp.name}`);
	for (const prop of comp.properties) {
		out.push(serializeProperty(prop));
	}
	for (const child of comp.components) {
		emitComponent(child, out);
	}
	out.push(`END:${comp.name}`);
}

/**
 * Component ツリーを ICS 文字列にシリアライズする。
 *
 * 各コンテンツ行は CRLF 終端(§3.1)。末尾の END:VCALENDAR の後にも CRLF を付ける
 * (RFC は全コンテンツ行を CRLF 終端と定めており、最終行も例外ではない。
 *  iOS もファイル末尾に CRLF を付けて送ってくる)。
 */
export function serialize(root: Component): string {
	const logicalLines: string[] = [];
	emitComponent(root, logicalLines);

	// 各論理行を折り畳んでから CRLF で連結。foldLine は行内部に CRLF+SPACE を入れうるが、
	// 論理行同士の区切りもここで CRLF にするので改行は一貫して CRLF になる。
	// 末尾にも CRLF を付けて全行を終端する。
	return logicalLines.map(foldLine).join("\r\n") + "\r\n";
}
