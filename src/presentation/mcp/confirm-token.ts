// =============================================================================
// presentation/mcp/confirm-token.ts — 破壊的操作(delete 系)の確認トークン(HMAC 署名)
// =============================================================================
// 【位置づけ(設計の正: docs/modeling/14-confirmation-card.md §2)】
//   破壊的な書き込み(delete-event / delete-todo / delete-calendar 等・Tier A)は「propose-*
//   (副作用なし・確認カードを返す)→ カード内 callServerTool で本体ツールを実行」の2段にする。
//   propose-* が「ペイロードへの HMAC 署名付きワンタイムトークン」を **結果の _meta にだけ** 載せ、
//   本体ツールは実行前にそのトークンを検証する。_meta は MCP Apps がカード iframe にだけ渡す
//   UI 専用チャネルで **モデルのコンテキストには入らない**(SEP-1865)。ゆえに:
//     - LLM はトークンを知り得ない = 「確認済み実行」は必ずユーザーのタップを経由してしか起きない。
//     - モデルが delete-* を「確認済みのふりで」直接叩いても、正しい token を持てず検証で弾かれる。
//
// 【なぜサーバー側 pending レコード(D1)ではなくステートレストークンか(§5 案2 の却下)】
//   D1 migration + TTL 掃除 cron + 冪等性検証が要る不可逆コストの割に、得られる安全性は署名検証と
//   同等。将来 pending 化・監査ログが要件化したら移行できるよう、外側(propose-*)の形は保つ。
//
// 【なぜ crypto.subtle(HMAC-SHA256)か — content-hash.ts の FNV-1a と方針が違う理由】
//   content-hash.ts が非暗号ハッシュ(FNV-1a)なのは「モジュールロード時に同期評価する ui:// URI」
//   という制約 + 目的が cache-busting(暗号強度不要)だったから。こちらは真逆で、
//     (1) 目的が「秘密鍵を知らない者に偽造させない」= 暗号強度が本質。
//     (2) 評価文脈が async な MCP ツールハンドラ内(top-level 同期評価ではない)。
//   よって crypto.subtle.digest / HMAC(いずれも Promise を返す)を素直に使える。
//
// 【「canonical JSON」を挟む理由】署名対象を JSON.stringify そのままにすると、キー順序の違いで
//   同じ論理ペイロードが別バイト列になり、検証側の再シリアライズ順序に依存して署名が一致しない
//   事故を生む。キーをソートして正規化(canonicalJson)してから HMAC する。ネストしたオブジェクト/
//   配列も再帰的に正規化する(配列は順序が意味を持つのでソートしない)。
//
// 【「ワンタイム」の意味と、ステートレスゆえの限界(重要な但し書き・Why not 完全な一回性)】
//   トークンには nonce(乱数)と exp(失効時刻)を必ず含める。nonce により、同じ論理ペイロードでも
//   毎回異なるトークン文字列になる。ただし **サーバーは使用済みトークンを記録しない**(ステートレス
//   =§2 の設計)ため、TTL 内での「同一トークンの再提示」を厳密に一度きりへ制限はできない。
//   これは意図的な割り切りで、実害が無いと判断した根拠:
//     - 攻撃者(モデル)はそもそもトークンを入手できない(_meta 秘匿)ので replay の起点が無い。
//     - 万一同じ delete トークンが2回実行されても、対象は1回目で消えており2回目は「対象なし」
//       エラーになるだけ(冪等的に無害)。
//   厳密な一回性が要件化したら KV/D1 に nonce の消費記録を足す(外側インターフェースは不変)。
// =============================================================================

// --- TTL 既定値 --------------------------------------------------------------
// propose-* が発行する「対象を特定した削除確認トークン」の寿命。ユーザーは確認カードを見て即座に
// 「削除する」を押す想定なので、短くてよい(§2: TTL 5分)。長すぎると盗まれたトークンの有効窓が
// 無駄に広がる(_meta 秘匿が破れた場合の被害を小さく保つ defense-in-depth)。
export const PROPOSE_TOKEN_TTL_MS = 5 * 60 * 1000;

// カード発の削除(既存 todos/agenda カードの swipe/詳細ページ削除)に使う「免除トークン」の寿命
// (docs/modeling/14 §6 項目5 の設計判断。詳細は server.ts の mintCardToken 呼び出し箇所コメント)。
// カードは開きっぱなしにされ得るので propose の5分では swipe 削除が途中で失効してしまう。免除トークンの
// 安全性は TTL ではなく _meta 秘匿 + HMAC 不可偽造に依存する(モデルはトークンを読めない)ため、
// TTL は「万一漏れたときの窓」を抑える defense-in-depth に留め、実用上十分長い 12 時間にする。
// カードは focus/mutation のたびに再取得し、その応答で常に新しい免除トークンを受け取るので、通常は
// この上限に達する前に更新される(12h は「無操作で放置された古いカード」の保険)。
export const CARD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** 検証結果。ok のとき payload(署名された論理ペイロード)を返す。 */
export type ConfirmTokenVerification =
	| { readonly ok: true; readonly payload: Record<string, unknown>; readonly expiresAt: number }
	// reason は運用ログ/デバッグ用の機械可読タグ(ユーザー向け文言ではない)。
	| { readonly ok: false; readonly reason: "malformed" | "bad-signature" | "expired" };

// --- base64url(バイト列 ⇄ 文字列)------------------------------------------
// JWT 系と同じ URL セーフな base64(+/= を -_ へ・パディング無し)。トークンを "." 区切りの
// ASCII 文字列にして MCP の JSON 引数へそのまま載せられるようにする。
function bytesToBase64Url(bytes: Uint8Array): string {
	// btoa は「1文字=1バイト」の binary string を要求するので、code unit へ落としてから渡す。
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
	// パディングを復元してから標準 base64 へ戻す(atob はパディング必須の実装があるため補う)。
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// --- canonical JSON(キー順序正規化)-----------------------------------------
/**
 * 値を「キーをソートした決定的な JSON 文字列」へ変換する。オブジェクトはキー昇順・ネストも再帰。
 * 配列は順序が意味を持つのでソートしない(要素だけ再帰正規化)。undefined はキーごと省く
 * (JSON.stringify の既定挙動に合わせる — 署名側/検証側で同じ省略規則になるようにする)。
 *
 * 【Why not JSON.stringify(value, Object.keys(value).sort())】replacer 引数のキー配列はトップレベル
 * だけでなく全階層の *同名キー* に効くうえ、ネストしたキー集合が階層ごとに違うと取りこぼす。自前の
 * 再帰で「そのオブジェクト自身のキーだけをソート」する方が正しく決定的になる。
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		// プリミティブ(string/number/boolean/null)はそのまま JSON 化(順序の概念が無い)。
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined) // undefined 値のキーは JSON では消えるので署名対象からも外す。
		.sort();
	const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
	return `{${entries.join(",")}}`;
}

// --- HMAC-SHA256 -------------------------------------------------------------
async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false, // extractable=false(鍵をエクスポートさせない)。
		["sign", "verify"],
	);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return new Uint8Array(sig);
}

/** 定数時間比較(タイミング攻撃対策)。長さが違えば即 false でよい(署名長は固定なので長さ差は
 *  攻撃情報にならない)が、同長時は全バイトを XOR-OR で舐めて早期 return しない。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

// --- 署名対象の内部表現 ------------------------------------------------------
// トークンに埋め込む本体。p=論理ペイロード(呼び出し側が意味を決める)・e=失効 epoch ms・n=nonce。
// これを canonicalJson して HMAC する。トークンは `b64url(msg)` + "." + `b64url(sig)` の2部構成で、
// 検証側は前半 msg をそのまま(再パースせず)署名し直して照合する(canonical 済みなので bit 完全一致)。
interface TokenBody {
	readonly p: Record<string, unknown>;
	readonly e: number;
	readonly n: string;
}

/**
 * 論理ペイロード payload に HMAC 署名付きトークンを発行する(async)。
 * @param secret Workers secret(CONFIRM_SECRET)。空文字は呼び出し側で弾くこと(下記コメント)。
 * @param payload 署名する論理ペイロード(delete 対象の同定情報など)。検証側が同じ payload を
 *   再構成できる必要はない — payload 自体をトークンに埋め込むので、検証で復元して返す。
 * @param ttlMs 失効までのミリ秒(既定 PROPOSE_TOKEN_TTL_MS)。
 * @param now テスト用の時刻注入(既定 Date.now())。
 */
export async function signConfirmToken(
	secret: string,
	payload: Record<string, unknown>,
	ttlMs: number = PROPOSE_TOKEN_TTL_MS,
	now: number = Date.now(),
): Promise<string> {
	const body: TokenBody = {
		p: payload,
		e: now + ttlMs,
		// nonce: 96bit の乱数を hex 化。同一 payload でも毎回別トークンにする(上の「ワンタイム」但し書き)。
		n: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12))),
	};
	const msg = canonicalJson(body);
	const sig = await hmac(secret, msg);
	// msg は既に canonical な文字列なので、その UTF-8 バイトを b64url して前半に載せる。検証側は
	// この前半を復号 → その文字列をそのまま署名し直して照合する(順序ゆらぎが原理的に起きない)。
	return `${bytesToBase64Url(new TextEncoder().encode(msg))}.${bytesToBase64Url(sig)}`;
}

/**
 * トークンを検証する(async)。署名一致 + 未失効なら ok:true と埋め込み payload を返す。
 * @param now テスト用の時刻注入(既定 Date.now())。TTL 失効の境界テストに使う。
 */
export async function verifyConfirmToken(
	secret: string,
	token: string,
	now: number = Date.now(),
): Promise<ConfirmTokenVerification> {
	// 形式検査: "<b64url msg>.<b64url sig>" の2部構成。壊れた入力はここで malformed。
	const dot = token.indexOf(".");
	if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
	const msgB64 = token.slice(0, dot);
	const sigB64 = token.slice(dot + 1);

	let msg: string;
	let providedSig: Uint8Array;
	try {
		msg = new TextDecoder().decode(base64UrlToBytes(msgB64));
		providedSig = base64UrlToBytes(sigB64);
	} catch {
		// base64url 復号に失敗 = 明らかに壊れたトークン。
		return { ok: false, reason: "malformed" };
	}

	// 署名照合(定数時間)。ここで前半 msg を「受け取ったそのまま」署名し直す(canonical 済みなので
	// 再シリアライズによる順序ゆらぎは起きない)。payload を書き換えられていれば msg が変わり弾かれる。
	const expectedSig = await hmac(secret, msg);
	if (!timingSafeEqual(expectedSig, providedSig)) return { ok: false, reason: "bad-signature" };

	// 署名は正しい。中身(TokenBody)を取り出す。
	let body: TokenBody;
	try {
		const parsed = JSON.parse(msg) as unknown;
		if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "malformed" };
		body = parsed as TokenBody;
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (typeof body.e !== "number" || typeof body.p !== "object" || body.p === null) {
		return { ok: false, reason: "malformed" };
	}
	// 失効判定は署名検証の後(改ざんされた exp は上の署名照合で既に弾かれている前提)。
	if (now >= body.e) return { ok: false, reason: "expired" };

	return { ok: true, payload: body.p, expiresAt: body.e };
}
