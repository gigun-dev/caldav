// object宛multigetはRFC 4791 §7.9で「単一href = Request-URI」が必須。
// pathnameだけの比較では外国ホストを自己URIと誤認し、文字列の完全一致では
// 正当なpercent-encodingや既定portを拒否するため、URIの構成要素で照合する。
function normalizePercentEncoding(value: string): string {
	// RFC 3986 §2.3/6.2.2: unreservedだけ復号。%2Fなど予約文字は復号すると
	// パス境界を変えるため、大文字hexへの統一だけにとどめる。
	return value.replace(/%[\da-f]{2}/gi, (encoded) => {
		const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
		return /[a-z\d._~-]/i.test(char) ? char : encoded.toUpperCase();
	});
}

export function equivalentObjectHref(href: string, requestUrl: URL, publicOrigin: string): boolean {
	// RFC 4918 §8.3 Simple-ref: 絶対URIまたは絶対path。短い相対名・fragmentを
	// 寛容に同一扱いすると、clientの別リソース指定を見逃すので受理しない。
	if (!/^(?:\/(?!\/)|https?:\/\/)/i.test(href)) return false;
	try {
		// Cloud Run経由ではrequestUrlはWorkerのURL。クライアントが見ているoriginを
		// 既存のexternalOriginから受け取り、proxy側の絶対hrefを同一URIとして扱う。
		const target = new URL(href, publicOrigin);
		return target.origin === new URL(publicOrigin).origin && !target.username && !target.password && !target.hash
			&& normalizePercentEncoding(target.pathname) === normalizePercentEncoding(requestUrl.pathname)
			&& normalizePercentEncoding(target.search) === normalizePercentEncoding(requestUrl.search);
	} catch {
		// 不正URLはclientの要求不備。URL constructor例外を500に流さない。
		return false;
	}
}
