// =============================================================================
// ETag — RFC 7232 / RFC 4791 §5.3.4 の強い ETag(値オブジェクト)
// =============================================================================
//
// 【なぜ「強い ETag」だけを扱うのか】
// RFC 4791 §5.3.4 は「全カレンダーオブジェクトリソースは強い ETag を持つ MUST」と要求する。
// 弱い ETag(W/"...")はバイト等価まで保証しないため、If-Match による楽観ロックや
// sync の効率化に使えない。iOS は If-Match / If-None-Match を多用するので、
// このプロジェクトでは弱い ETag を一切生成しない — よってこの VO も強い ETag 専用。
//
// 【なぜ「格納オクテット列(rawIcs)の SHA-256」なのか】
// 前作 hono-caldav 踏襲(03 図の ETag 注記「前作は ICS の SHA-256。踏襲候補」)。
// RFC 4791 §5.3.4 は「サーバーがデータを書き換えたら PUT 応答で ETag を返しては MUST NOT」
// と定める。本プロジェクトは structure 層でロスレス往復を担保し「格納オクテット列 =
// クライアント送信ボディ」を保てるので、送信ボディのハッシュ = 格納データのハッシュとなり、
// PUT 応答で常に ETag を返せる(この設計の RFC 上の実利。03 の R5 コメント参照)。
// 「内容が変われば必ず変わる」という ETag の要件(RFC 7232 §2.3)は暗号学的ハッシュで満たす。
//
// 【domain 層で crypto.subtle を使う判断】
// Web Crypto の `crypto.subtle` は Cloudflare Workers・bun・ブラウザすべてで使える
// Web 標準グローバル(node: プレフィックス不要)。CLAUDE.md「domain は node: も不可、
// Web 標準 API のみ可」に合致するため、domain 層で直接使ってよいと判断した。
// これを外部ポート(依存注入)にしなかった理由: SHA-256 はプラットフォーム非依存の
// 純粋関数であり、差し替え可能性(ポート&アダプタの動機)がそもそも無いため。
// =============================================================================

/**
 * 強い ETag。内部は SHA-256 の 16 進文字列(小文字・64 桁)だけを保持する。
 * ハッシュ以外の情報(生成時刻など)は持たない — 「同じ内容 → 同じ ETag」を保つため。
 */
export class ETag {
	// hex は必ず 64 桁の小文字 16 進(SHA-256 の出力)。fromHex で検証済みの値だけが入る。
	private constructor(readonly hex: string) {}

	/**
	 * 既知の 16 進文字列(DB から読み戻した ETag 等)から復元する。
	 * 64 桁の 16 進でなければ throw する — 壊れた ETag を黙って受け入れると
	 * If-Match 比較が意味を失うため。
	 */
	static fromHex(hex: string): ETag {
		const normalized = hex.toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(normalized)) {
			throw new Error(`ETag.fromHex: expected 64-hex-digit SHA-256, got "${hex}"`);
		}
		return new ETag(normalized);
	}

	/** ハッシュ値の等価比較。ETag は「内容の指紋」なので hex 一致 = 同一。 */
	equals(other: ETag): boolean {
		return this.hex === other.hex;
	}

	/**
	 * HTTP ヘッダ用の quoted 形式(RFC 7232 §2.3)。強い ETag なので `W/` は付けない。
	 * 例: `"9f86d0…"`。ETag ヘッダ・If-Match 生成は presentation 層の仕事だが、
	 * 「引用符で囲む」整形は ETag 表現そのものの一部なので VO に置く。
	 */
	toHeader(): string {
		return `"${this.hex}"`;
	}

	/** ログ・テスト表示用。ヘッダ形式と同じにしておく(混乱を避ける)。 */
	toString(): string {
		return this.toHeader();
	}
}

/**
 * 格納オクテット列(ICS 文字列)から強い ETag を計算する。
 *
 * ICS 文字列を UTF-8 バイト列にエンコードし、その SHA-256 を取る。
 * TextEncoder は常に UTF-8 を出力する(Web 標準)ので、格納時と再計算時で
 * 同じバイト列 → 同じハッシュになる。非同期なのは crypto.subtle.digest が Promise を返すため。
 */
export async function computeETag(ics: string): Promise<ETag> {
	// UTF-8 バイト列へ。structure 層が保持する「格納オクテット列」と一致させるため、
	// ここでの変換方式(UTF-8)は序列化のそれと必ず揃える必要がある(揃っていないと
	// PUT 応答 ETag と後続 GET の ETag がズレて iOS が延々と再取得する)。
	const bytes = new TextEncoder().encode(ics);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	// ArrayBuffer → 16 進文字列。padStart(2,"0") を忘れると 0x0a が "a" になり衝突する。
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return ETag.fromHex(hex);
}
