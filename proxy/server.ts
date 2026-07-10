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
		return new Response(response.body, { status: response.status, headers: response.headers });
	},
});
