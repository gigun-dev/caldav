// =============================================================================
// iCalendar パーサー(RFC 5545 §3.1〜3.2): ICS 文字列 → Component ツリー
// =============================================================================
//
// 【責務】structure/types.ts の汎用構造層(Component / Property / Parameter)への
// 変換だけを行う。値の意味解釈(DTSTART を日時に、RRULE を規則に…)は一切しない。
// value は「コロン以降の生テキスト」のまま持つ(types.ts 冒頭の最重要設計決定)。
// エスケープ(\n \, \; \\)の解除もしない。折り畳み(§3.1)の解除だけがこの層の仕事。
//
// 【なぜ生テキスト保持か(再掲)】RFC 4791 §5.3.3 は X- 拡張の格納を MUST とし、
// §5.3.4 はサーバーがデータを書き換えると PUT 応答で ETag を返せなくなる(MUST NOT)。
// 「解釈してから型に持ち上げる」方式は解釈バグ = データ改変になり往復が壊れる。
// 生テキストで受けて生テキストで返せば parse→serialize が構造的に恒等写像に近づく。
// =============================================================================

import type { Component, Parameter, Property } from "../structure/types";

/**
 * パースエラー。TypeScript strict で扱いやすいよう Result 型ではなく throw 方式を採用
 * (CLAUDE.md の指定)。**行番号(元の物理行)を必ず含める**: iOS の実データは巨大で、
 * どの行で BEGIN/END が壊れたか分からないとデバッグ不能になるため。
 * lineNo は unfold **前**の物理行番号(1 始まり)。折り畳み後の論理行番号ではなく、
 * ユーザーがエディタで開いたときに一致する物理行を指す。
 */
export class ParseError extends Error {
	constructor(
		message: string,
		readonly lineNo: number,
	) {
		// 例: "line 42: END:VEVENT does not match BEGIN:VALARM"
		super(`line ${lineNo}: ${message}`);
		this.name = "ParseError";
	}
}

// unfold 後の1論理行。lineNo は「この論理行が始まった物理行番号」を保持する。
// 折り畳みで複数物理行にまたがっても、エラーは先頭の物理行を指せば十分デバッグできる。
interface LogicalLine {
	readonly text: string;
	readonly lineNo: number;
}

/**
 * 折り畳み解除(RFC 5545 §3.1)。
 *
 * RFC の折り畳みは「CRLF の直後に 1 個の WSP(SPACE or HTAB)を置く」もので、
 * 復元は「CRLF+WSP を除去して前後を連結」。**この除去を文字列(コードポイント列)操作で
 * 行えば、UTF-8 マルチバイト境界の途中で折られていても自然に復元される**
 * (折り畳みはオクテット単位で行われうるが、我々は既に UTF-8 デコード済みの JS 文字列を
 *  扱っており、除去するのは純粋に「改行 + 先頭 1 空白」という制御シーケンスだけなので、
 *  文字の中身には触れない。types.ts の設計意図どおり)。
 *
 * 【寛容受理(Postel の法則)】行区切りは CRLF が正(§3.1)だが、実クライアントには
 * LF のみ / CR のみで送ってくるものがある(古い実装・コピペ経由)。ここでは
 * CRLF / CR / LF のいずれも行区切りとして受理する。この寛容さは「意味論的等価の往復」
 * (parse→serialize→parse が冪等)でカバーし、シリアライズ時は常に CRLF に正規化する。
 */
function unfold(input: string): LogicalLine[] {
	// まず物理行に分割する。CRLF を最優先(CR と LF を別々の区切りと誤認しないため、
	// 正規表現の選択肢の先頭に \r\n を置く)。CR のみ・LF のみも区切りとして受理。
	const physical = input.split(/\r\n|\r|\n/);

	const logical: LogicalLine[] = [];
	for (let i = 0; i < physical.length; i++) {
		const line = physical[i]!;
		const physicalLineNo = i + 1; // 1 始まり(エディタの行番号に合わせる)

		// 継続行の判定: 先頭が SPACE(U+0020)か HTAB(U+0009)なら、直前の論理行の続き。
		// §3.1 の折り畳み解除: 先頭 1 文字の WSP を剥がして直前行に連結する。
		const isContinuation =
			logical.length > 0 && (line.startsWith(" ") || line.startsWith("\t"));
		if (isContinuation) {
			const prev = logical[logical.length - 1]!;
			// readonly なので作り直す。text は「WSP 1 個を除いた残り」を連結。
			logical[logical.length - 1] = {
				text: prev.text + line.slice(1),
				lineNo: prev.lineNo, // 論理行の開始物理行番号は維持
			};
			continue;
		}

		logical.push({ text: line, lineNo: physicalLineNo });
	}

	return logical;
}

/**
 * コンテンツ行 1 行(unfold 済み)を Property に分解する(RFC 5545 §3.1 の contentline 文法)。
 * 文法: `name *(";" param ) ":" value`  /  `param = param-name "=" param-value *("," param-value)`
 *
 * スキャナ方式(1 文字ずつ)にした理由: quoted-string(DQUOTE 囲み)の中では `:` `;` `,` が
 * 区切りとして働かない、という文脈依存があり、正規表現一発では正しく切れないため。
 */
function parseContentLine(line: string, lineNo: number): Property {
	let pos = 0;
	const len = line.length;

	// --- プロパティ名 --------------------------------------------------------
	// 名前は ';'(パラメータ開始)か ':'(値開始)まで。§3.1 では name は iana-token /
	// x-name で英数と '-' のみだが、寛容にそれ以外も名前として読む(壊れたデータでも
	// 落とさず往復させる方針。厳密な妥当性検査は semantics 層の責務)。
	let name = "";
	while (pos < len && line[pos] !== ";" && line[pos] !== ":") {
		name += line[pos];
		pos++;
	}
	if (pos >= len) {
		// ':' が最後まで現れない = 値区切りが無い。BEGIN/END も含め全行が name:value 形式なので
		// これは構造破壊。
		throw new ParseError(`content line has no ':' value delimiter: "${line}"`, lineNo);
	}
	if (name === "") {
		throw new ParseError(`content line has empty property name: "${line}"`, lineNo);
	}
	// 名前は case-insensitive(§3.1)。types.ts の契約どおり大文字に正規化して保持。
	name = name.toUpperCase();

	// --- パラメータ列 --------------------------------------------------------
	const parameters: Parameter[] = [];
	while (line[pos] === ";") {
		pos++; // ';' を消費

		// パラメータ名: '=' まで(';' や ':' が先に来たら文法違反)。
		let pname = "";
		while (
			pos < len &&
			line[pos] !== "=" &&
			line[pos] !== ";" &&
			line[pos] !== ":"
		) {
			pname += line[pos];
			pos++;
		}
		if (line[pos] !== "=") {
			// param は必ず "name=value"(§3.2)。'=' が無いのは壊れている。
			throw new ParseError(
				`parameter "${pname}" is missing '=' in: "${line}"`,
				lineNo,
			);
		}
		pos++; // '=' を消費

		// パラメータ値(複数値 = カンマ区切り。§3.2: PARAM=v1,v2)。
		const values: string[] = [];
		for (;;) {
			let val = "";
			if (line[pos] === '"') {
				// quoted-string(§3.1): DQUOTE 内は QSAFE-CHAR。ここでは `:` `;` `,` を
				// 区切りとして扱わず、そのまま値に取り込む。DQUOTE は剥がして格納する
				// (types.ts 契約: quoted か否かはシリアライズ時に値の内容から機械的に再決定)。
				pos++; // 開き DQUOTE を消費
				while (pos < len && line[pos] !== '"') {
					val += line[pos];
					pos++;
				}
				if (pos >= len) {
					throw new ParseError(
						`unterminated quoted parameter value in: "${line}"`,
						lineNo,
					);
				}
				pos++; // 閉じ DQUOTE を消費
			} else {
				// 非 quoted: 次の区切り(',' 別値 / ';' 次パラメータ / ':' 値開始)まで。
				while (
					pos < len &&
					line[pos] !== "," &&
					line[pos] !== ";" &&
					line[pos] !== ":"
				) {
					val += line[pos];
					pos++;
				}
			}
			values.push(val);

			// 同一パラメータの次の値へ続くのはカンマのときだけ。
			if (line[pos] === ",") {
				pos++; // ',' を消費して次の値へ
				continue;
			}
			break;
		}

		// パラメータ名も case-insensitive(§3.1)→ 大文字正規化(types.ts 契約)。
		parameters.push({ name: pname.toUpperCase(), values });
	}

	// --- 値 ------------------------------------------------------------------
	if (line[pos] !== ":") {
		// パラメータ走査後にここへ来るのは、quoted 値の直後に不正な文字が続いた等の壊れ方。
		throw new ParseError(
			`expected ':' before value but found "${line[pos] ?? "<eol>"}" in: "${line}"`,
			lineNo,
		);
	}
	pos++; // ':' を消費
	// コロン以降は**生の値テキスト**。エスケープ解除もクォート処理もしない(最重要設計決定)。
	const value = line.slice(pos);

	return { name, parameters, value };
}

// 内部組み立て用の可変コンポーネント。types.ts の Component は readonly なので、
// パース中はこの可変版で push しながら組み立て、最後にそのまま Component として返す
// (readonly は「消費側が書き換えない」契約であり、構築側が可変配列で作るのは問題ない)。
interface MutableComponent {
	name: string;
	properties: Property[];
	components: MutableComponent[];
}

/**
 * ICS 文字列をパースして Component ツリー(通常ルートは VCALENDAR)を返す。
 *
 * BEGIN/END のネスト(VCALENDAR > VEVENT > VALARM)はスタックで追う。
 * - BEGIN:X → 新コンポーネントを親に push し、スタックにも push
 * - END:X   → スタック先頭を pop し、名前が一致しなければエラー(行番号付き)
 * - それ以外 → スタック先頭コンポーネントのプロパティに追加
 */
export function parse(input: string): Component {
	const lines = unfold(input);

	const stack: MutableComponent[] = [];
	let root: MutableComponent | undefined;

	for (const { text, lineNo } of lines) {
		// 空行は寛容に無視(§3.1 の文法には無いが、一部クライアントが末尾等に付ける)。
		// 注意: "X-EMPTY:" のような空値プロパティは text が "" ではないので誤って捨てない。
		if (text === "") continue;

		const prop = parseContentLine(text, lineNo);

		if (prop.name === "BEGIN") {
			// BEGIN の値がコンポーネント名。名前は case-insensitive なので大文字化して保持。
			const comp: MutableComponent = {
				name: prop.value.toUpperCase(),
				properties: [],
				components: [],
			};
			if (stack.length > 0) {
				stack[stack.length - 1]!.components.push(comp);
			} else if (root !== undefined) {
				// トップレベル(スタックが空)で 2 つ目の BEGIN。RFC 4791 §9.6 の含意により
				// カレンダーリソースは VCALENDAR 1 つ(不変条件)。複数ルートは構造として弾く。
				throw new ParseError(
					`multiple top-level components (second: BEGIN:${comp.name}); a resource must contain exactly one`,
					lineNo,
				);
			} else {
				root = comp;
			}
			stack.push(comp);
		} else if (prop.name === "END") {
			if (stack.length === 0) {
				throw new ParseError(`unmatched END:${prop.value.toUpperCase()}`, lineNo);
			}
			const open = stack.pop()!;
			const endName = prop.value.toUpperCase();
			if (open.name !== endName) {
				throw new ParseError(
					`END:${endName} does not match BEGIN:${open.name}`,
					lineNo,
				);
			}
		} else {
			if (stack.length === 0) {
				// BEGIN より前にプロパティが来た = コンポーネント外のプロパティ。構造破壊。
				throw new ParseError(
					`property ${prop.name} appears outside of any component`,
					lineNo,
				);
			}
			stack[stack.length - 1]!.properties.push(prop);
		}
	}

	if (stack.length > 0) {
		// 閉じられていない BEGIN が残っている。先頭(最も外側)の未閉鎖を報告。
		// lineNo は末尾行が無いので 0 を使う(EOF での構造エラーであることを示す)。
		throw new ParseError(
			`unclosed component BEGIN:${stack[0]!.name} (missing END at end of input)`,
			0,
		);
	}
	if (root === undefined) {
		throw new ParseError("input contains no component", 0);
	}

	return root;
}
