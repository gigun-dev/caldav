// =============================================================================
// WebDAV `If` ヘッダ解析(RFC 4918 §10.4) — R-3: RFC 6578 §5 MUST 対応
// =============================================================================
//
// 【このファイルの役割】
// RFC 6578 §5「Servers MUST support use of DAV:sync-token values in If request
// headers」を満たすため、PUT/DELETE の `If` ヘッダから DAV:sync-token を
// precondition として取り出す。ヘッダの構文解析(HTTP ヘッダ知識)はプロトコル知識
// なので presentation 層の仕事、実際に「今のコレクションの token と一致するか」の
// 評価は application 層(put/delete usecase)に委ねる(R-2 の If-Match/If-None-Match
// と同じ分担方針を踏襲)。
//
// 【対応する構文(サブセット)】RFC 4918 §10.4.2 ABNF のうち
//   If = 1*Tagged-list
//   Tagged-list = Resource-Tag 1*List
//   List = "(" 1*Condition ")"
//   Condition = ["Not"] State-token
//   State-token = Coded-URL ( "<" ... ">" )
// だけを解釈する。RFC 6578 §5.1/§5.2 の例(`If: </collection/> (<sync-token-uri>)`)は
// まさにこの形。
//
// 【対応しないもの(判断理由)】
//  - No-tag-list(タグ無しの `(...)`)。RFC 6578 の sync-token は「対象コレクション」
//    (= PUT/DELETE の対象リソースとは別)に紐づく状態なので、Resource-Tag で明示的に
//    コレクションを指す Tagged-list 以外は本タスクのユースケースに現れない
//    (§5.1/§5.2 の例もすべて Tagged-list)。出現したら「解釈できない」としてヘッダ全体を
//    無視する(下記の「未対応構文の扱い」参照)。
//  - entity-tag 条件(`["..."]`)。If ヘッダ内に ETag 条件を混在させる構文
//    (§10.4.9 のような COPY 例)は、既存の If-Match/If-None-Match ヘッダによる ETag 条件
//    (R-2 で対応済み)と役割が重複するうえ、iOS を含む実クライアントでの使用は
//    確認できていない。フルの ABNF パーサ(entity-tag と state-token の混在 AND/OR)を
//    実装するコストに見合わないため未対応とする。
//
// 【未対応構文の扱い: 412 にせず黙殺する】
// RFC 4918 §10.4.1: 「If ヘッダが評価されて全 state list が false なら 412」。
// 裏を返せば「(このサーバーが)評価できない」ことは「false」と同義ではない。
// entity-tag 混在や No-tag-list など、このサブセットの外側の構文を検出した場合は
// 「サーバーはこの If ヘッダの中身を解釈できなかった」として sync-token precondition の
// 評価自体を行わない(= 412 にしない・従来どおり通す)。理由:
//   1. RFC 6578 §5 が MUST として要求するのは「sync-token を If ヘッダの state-token として
//      使えること」であって、If ヘッダの全構文をサポートすることではない。
//   2. 未対応構文を安易に「false」= 412 に倒すと、当該サーバーが単に読めなかっただけの
//      ヘッダで正当なリクエストを一律拒否してしまい、可用性を損なう(iOS 側は If ヘッダを
//      同期用途以外にはほぼ使わない観測があり、フェイルオープンの実害は小さいと判断)。
//   3. 逆に「実は sync-token 条件を書いていたのに黙殺されて上書きされてしまう」事故を
//      避けたいなら、まず対応構文(Tagged-list + State-token)を優先実装し、他パターンは
//      観測されてから拡張する(YAGNI)。
// =============================================================================

/** 1個の Condition(State-token。"Not" で否定できる)。 */
export interface IfStateCondition {
	negate: boolean;
	/** State-token の中身(`<` `>` を除いた Coded-URL 文字列)。 */
	token: string;
}

/** 1個の Tagged-list(Resource-Tag + 1個以上の List)。List は複数あれば OR。 */
export interface IfTaggedList {
	/** Resource-Tag の中身(`<` `>` を除いた Simple-ref 文字列)。 */
	resourceTag: string;
	/** 1個の List 内の Condition 列(AND)。 */
	conditions: IfStateCondition[];
}

/**
 * `If` ヘッダを解析する。
 *
 * 戻り値:
 *   - `IfTaggedList[]`: 解釈できた Tagged-list の列(RFC 4918 §10.4.3 のとおり、
 *     複数 List は OR、1 List 内の Condition は AND)。
 *   - `null`: ヘッダが空 / このサブセット外の構文(entity-tag・No-tag-list・壊れた構文)
 *     を検出した(冒頭コメント「未対応構文の扱い」参照)。呼び出し側は sync-token
 *     precondition を評価しない(= 従来どおり無条件で処理を進める)。
 */
export function parseIfHeader(raw: string | null | undefined): IfTaggedList[] | null {
	if (!raw) return null;
	// entity-tag 条件(`[...]`)が混在するヘッダは未対応構文として丸ごと無視する
	// (冒頭コメント「対応しないもの」参照)。
	if (raw.includes("[")) return null;

	const lists: IfTaggedList[] = [];
	let currentTag: string | null = null;
	let i = 0;
	while (i < raw.length) {
		while (i < raw.length && /\s/.test(raw[i])) i++;
		if (i >= raw.length) break;

		if (raw[i] === "<") {
			// Resource-Tag(次の List 群が指す対象)。State-token の "<...>" と字面上
			// 区別できないが、List の外(= 直前が Resource-Tag/文頭)に出現する "<...>" は
			// 構文上つねに Resource-Tag なので、このトップレベルループで拾えば十分。
			const end = raw.indexOf(">", i);
			if (end === -1) return null; // 閉じ忘れ = 壊れた構文
			currentTag = raw.slice(i + 1, end);
			i = end + 1;
			continue;
		}

		if (raw[i] === "(") {
			// No-tag-list(Resource-Tag なしで List だけが出現する構文)はここに来る。
			// 未対応構文として扱う(冒頭コメント参照)。
			if (currentTag === null) return null;
			const end = raw.indexOf(")", i);
			if (end === -1) return null;
			const conditions = parseConditions(raw.slice(i + 1, end));
			if (conditions === null) return null;
			lists.push({ resourceTag: currentTag, conditions });
			i = end + 1;
			continue;
		}

		// 想定外の文字("Not" は List の中でしか出現しないはず等)。壊れた構文として無視。
		return null;
	}

	return lists.length > 0 ? lists : null;
}

/** List の中身("(" と ")" を除いた文字列)から Condition 列を取り出す。 */
function parseConditions(body: string): IfStateCondition[] | null {
	const conditions: IfStateCondition[] = [];
	let i = 0;
	while (i < body.length) {
		while (i < body.length && /\s/.test(body[i])) i++;
		if (i >= body.length) break;

		let negate = false;
		// "Not" の直後は空白か文字列末尾のはず(トークンの一部として "Not..." のような
		// State-token に誤爆しないための簡易境界チェック)。
		if (body.slice(i, i + 3) === "Not" && (i + 3 >= body.length || /\s/.test(body[i + 3]))) {
			negate = true;
			i += 3;
			while (i < body.length && /\s/.test(body[i])) i++;
		}

		if (body[i] !== "<") return null; // このサブセットでは State-token 以外は非対応
		const end = body.indexOf(">", i);
		if (end === -1) return null;
		conditions.push({ negate, token: body.slice(i + 1, end) });
		i = end + 1;
	}
	return conditions.length > 0 ? conditions : null;
}

/**
 * 解析済みの Tagged-list 群から「指定コレクション(collectionHref)を指す List だけ」を
 * OR-of-AND の形に絞り込む。
 *
 * 【なぜコレクションだけを見るのか】このタスクの対象は RFC 6578 §5.1/§5.2 の
 * 「sync-token はコレクションに定義され、PUT/DELETE の対象リソースとは別」という
 * ケースだけ(冒頭コメント参照)。他の Resource-Tag(対象リソース自身など)を指す
 * List は sync-token の話ではない(たとえば lock token やこのサブセットでは
 * パースしない entity-tag の話)ため、ここでは無視する。
 *
 * 【スコープの限界(コメントとして明示)】RFC 4918 §10.4.3 は「Tagged-list 全体で
 * 見て、どれか1つの List が真なら If ヘッダ全体は真」という OR を、Resource-Tag を
 * 跨いで取る。本実装はコレクションを指さない List を「無かったこと」として除外するため、
 * 「コレクション向けの List は false だが、無関係な Resource-Tag 向けの List が真」という
 * ケースでは本来 RFC 的には成功すべきところを 412 にしてしまう可能性がある。
 * このタスクのスコープ(RFC 6578 §5 MUST = sync-token を If ヘッダで使えること)には
 * 現れないケースだが、フル RFC 4918 §10.4 準拠ではないことの記録として残す。
 *
 * 戻り値: マッチする List が1つも無ければ `[]`(= precondition なし。呼び出し側は
 * unconditional として扱う)。
 */
export function syncTokenListsFor(lists: IfTaggedList[] | null, collectionHref: string): IfStateCondition[][] {
	if (lists === null) return [];
	return lists
		.filter((list) => normalizeResourceTag(list.resourceTag) === collectionHref)
		.map((list) => list.conditions);
}

/**
 * Resource-Tag の Simple-ref(絶対 URL か絶対パスか)を、collectionHref(常に絶対パス。
 * app.ts の normalizeCollectionHref 参照)と比較できる形に正規化する。
 *
 * 絶対 URL(`https://host/dav/...`)ならパス部分だけを取り出し、そうでなければ
 * (すでに絶対パスのはずなので)そのまま返す。パースできない値は絶対パスとして扱う
 * (比較で単に一致しないだけなので安全側)。
 */
function normalizeResourceTag(tag: string): string {
	try {
		return new URL(tag).pathname;
	} catch {
		return tag;
	}
}
