// =============================================================================
// 識別子の薄い値オブジェクト(branded string)
// =============================================================================
//
// 【設計方針: 過剰な型付けは避け、URL 安全性の最小制約だけ強制する】
// CollectionId / ResourceUri / PrincipalPath は本質的にはただの文字列だが、
// 「string を取り違えて別の場所に渡す」バグ(例: displayName を uri のつもりで PUT)を
// コンパイル時に弾きたい。そこで branded type(名目的型)で区別だけ付ける。
// 一方、内部にリッチな振る舞いは持たせない(パースや正規化はしない) — これらは
// 「URL の一部になる短い識別子」であって、意味論を持つ値ではないため。
//
// 強制する制約は「URL セグメントとして安全か」の最小限だけ:
//   - 空でない(空セグメントは URL 上で消える/ルートと衝突する)
//   - 制御文字・空白を含まない(URL に生で入れられない・折り畳み等の事故源)
//   - パスセパレータ "/" を含まない(セグメント1個だけを表す型なので)
//     ※PrincipalPath だけは複数セグメントのパスを表しうるので "/" を許す(下記)
// これ以上(パーセントエンコーディング検証など)は presentation 層の URL 処理の責務とし、
// domain には持ち込まない(HTTP 非依存を保つ)。
// =============================================================================

// branded type の実装。単一の unique symbol をタグのキーに使い、B(文字列リテラル)で
// 種別を区別する。異なる B を持つ型同士は代入不可になる(名目的型の効果)。
declare const idBrand: unique symbol;
type Branded<B extends string> = string & { readonly [idBrand]: B };

/** 識別子の制約違反。どの識別子種別で何が問題だったかを message に残す。 */
export class InvalidIdentifierError extends Error {
	constructor(kind: string, raw: string, reason: string) {
		super(`invalid ${kind} "${raw}": ${reason}`);
		this.name = "InvalidIdentifierError";
	}
}

/**
 * 制御文字(U+0000–U+001F)・空白(U+0020)・DEL(U+007F)を含むかどうか。
 * URL に生で入れられない文字群だけを弾く。ハイフン "-"・ドット "."・"_" などは
 * UID 由来の識別子("REC-0001.ics" 等)で常用されるので**弾いてはならない**
 * (ここを雑に \s や範囲で書くとハイフンまで巻き込む事故になる。意図的に列挙 + コードポイント指定)。
 */
function hasUnsafeChars(s: string): boolean {
	for (const ch of s) {
		const code = ch.codePointAt(0)!;
		// 0x00–0x20: 全制御文字 + スペース。0x7F: DEL。
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * コレクション識別子(URL セグメント1個)。例: "work" / "reminders"。
 * カレンダーホーム配下のパスセグメントになるので "/" 不可。
 */
export type CollectionId = Branded<"CollectionId">;
export function collectionId(raw: string): CollectionId {
	if (raw.length === 0) throw new InvalidIdentifierError("CollectionId", raw, "must not be empty");
	if (hasUnsafeChars(raw)) throw new InvalidIdentifierError("CollectionId", raw, "must not contain whitespace or control chars");
	if (raw.includes("/")) throw new InvalidIdentifierError("CollectionId", raw, 'must not contain "/" (single path segment)');
	return raw as CollectionId;
}

/**
 * カレンダーオブジェクトリソースの URI(コレクション内で一意なセグメント1個)。
 * 慣行では "{uid}.ics"(RFC 4791 §5.3.2 は URL 名と UID の一致を要求しないが、iOS はこの形で送る)。
 * コレクション内の相対名なので "/" 不可。
 */
export type ResourceUri = Branded<"ResourceUri">;
export function resourceUri(raw: string): ResourceUri {
	if (raw.length === 0) throw new InvalidIdentifierError("ResourceUri", raw, "must not be empty");
	if (hasUnsafeChars(raw)) throw new InvalidIdentifierError("ResourceUri", raw, "must not contain whitespace or control chars");
	if (raw.includes("/")) throw new InvalidIdentifierError("ResourceUri", raw, 'must not contain "/" (name within a collection)');
	return raw as ResourceUri;
}

/**
 * プリンシパルのパス(RFC 3744/5397。プリンシパルの URL 上の同一性)。
 * 例: "/principals/users/alice/"。複数セグメントのパスなので "/" は許す点が上2つと違う。
 * 空・空白・制御文字だけを弾く(URL パスとして最低限の安全性)。
 */
export type PrincipalPath = Branded<"PrincipalPath">;
export function principalPath(raw: string): PrincipalPath {
	if (raw.length === 0) throw new InvalidIdentifierError("PrincipalPath", raw, "must not be empty");
	if (hasUnsafeChars(raw)) throw new InvalidIdentifierError("PrincipalPath", raw, "must not contain whitespace or control chars");
	return raw as PrincipalPath;
}

/**
 * 他集約(CalendarCollection.owner)からプリンシパルを ID 参照するときの型。
 * 集約は ID 参照で結ぶ(03 §2 の設計決定: 集約横断は ID で)。実体は PrincipalPath そのもの
 * だが、「これは所有者への参照だ」という意図を型名で表す。
 */
export type PrincipalRef = PrincipalPath;
