// =============================================================================
// MKCALENDAR method-rewriting proxy
// =============================================================================
// Cloudflare workerd が認識できない MKCALENDAR だけを POST + 内部ヘッダーへ変換する。
// Cloud Run/Vercel Container/通常のDockerホストで同じイメージを動かせるよう、Bun標準APIだけを使う。

const upstream = process.env.UPSTREAM_URL;
const secret = process.env.PROXY_SHARED_SECRET;
const port = Number(process.env.PORT ?? "8080");

if (!upstream) throw new Error("UPSTREAM_URL is required");
if (!secret) throw new Error("PROXY_SHARED_SECRET is required");

const upstreamBase = new URL(upstream);

Bun.serve({
	port,
	hostname: "0.0.0.0",
	async fetch(request) {
		const incomingUrl = new URL(request.url);
		if (incomingUrl.pathname === "/health") return Response.json({ ok: true, service: "caldav-proxy" });

		const target = new URL(incomingUrl.pathname + incomingUrl.search, upstreamBase);
		const headers = new Headers(request.headers);
		headers.delete("host");
		headers.delete("content-length");
		headers.delete("connection");
		headers.set("x-forwarded-host", incomingUrl.host);
		headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));

		let method = request.method;
		if (method.toUpperCase() === "MKCALENDAR") {
			method = "POST";
			headers.set("x-caldav-method", "MKCALENDAR");
			headers.set("x-caldav-proxy-secret", secret);
		} else {
			headers.delete("x-caldav-method");
			headers.delete("x-caldav-proxy-secret");
		}

		const response = await fetch(target, {
			method,
			headers,
			body: request.body,
			redirect: "manual",
		});

		// 2026-07-11 iOS アカウント追加不能バグの修正: response.body(ストリーム)を
		// そのまま返すと Bun が Transfer-Encoding: chunked で再フレーミングし、
		// upstream の Content-Length が消える。iOS(accountsd)はローカル tunnel 経由の
		// chunked 207 でディスカバリ応答を破棄しフォールバック探索に落ちた
		// (本番 Cloud Run 入口は Content-Length 付きで成功 — 唯一の観測可能差分だった)。
		// → 全体をバッファして Content-Length を明示する。CalDAV の応答は小さい
		// (207 で数KB〜数十KB)のでバッファのメモリコストは無視できる。
		const buf = await response.arrayBuffer();
		const resHeaders = new Headers(response.headers);
		// fetch は body を自動解凍済みなので、圧縮時代のヘッダが残っていると長さが嘘になる。
		resHeaders.delete("content-encoding");
		resHeaders.delete("transfer-encoding");
		// 204/304 はボディを持てない(RFC 9110)ため Content-Length を付けず body も null に。
		if (response.status === 204 || response.status === 304) {
			return new Response(null, { status: response.status, headers: resHeaders });
		}
		resHeaders.set("content-length", String(buf.byteLength));
		return new Response(buf, { status: response.status, headers: resHeaders });
	},
});
