// =============================================================================
// CalDAV Basic 認証 — iOS が要求する最小の認証アダプタ
// =============================================================================
// 資格情報は Wrangler secret/vars から受け取り、ドメインの Principal には持ち込まない。
// HTTPS 終端は Cloudflare が担うため、平文 Basic 資格情報がインターネット上を平文で流れない。

export interface BasicAuthConfig {
	username: string;
	password: string;
}

function decodeBasic(header: string | undefined): { username: string; password: string } | null {
	if (!header?.toLowerCase().startsWith("basic ")) return null;
	try {
		const bytes = Uint8Array.from(atob(header.slice(6).trim()), (ch) => ch.charCodeAt(0));
		const decoded = new TextDecoder().decode(bytes);
		const separator = decoded.indexOf(":");
		if (separator < 0) return null;
		return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
	} catch {
		return null;
	}
}

export async function secureStringEqual(left: string, right: string): Promise<boolean> {
	// 長さ差による早期終了も避けるため、SHA-256 の固定長ダイジェスト同士を比較する。
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	const aa = new Uint8Array(a);
	const bb = new Uint8Array(b);
	let difference = 0;
	for (let i = 0; i < aa.length; i += 1) difference |= aa[i] ^ bb[i];
	return difference === 0;
}

export async function authenticateBasic(
	header: string | undefined,
	config: BasicAuthConfig,
): Promise<boolean> {
	const credentials = decodeBasic(header);
	if (!credentials) return false;
	const [usernameMatches, passwordMatches] = await Promise.all([
		secureStringEqual(credentials.username, config.username),
		secureStringEqual(credentials.password, config.password),
	]);
	return usernameMatches && passwordMatches;
}

export const UNAUTHORIZED_HEADERS = {
	"WWW-Authenticate": 'Basic realm="CalDAV", charset="UTF-8"',
} as const;
