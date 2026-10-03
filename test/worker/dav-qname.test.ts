// saxes の Bun 成功だけでは Workers 互換の証拠にならない。実 workerd の
// fetch 経路で default xmlns・prefix再束縛・整形式検証を確認する。
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TEST_DUMMY_SECRETS } from "./test-secrets";

function propfind(body: string): Promise<Response> {
	return exports.default.fetch(new Request("https://example.com/dav/principals/admin/", {
		method: "PROPFIND",
		headers: {
			authorization: `Basic ${btoa(`${env.CALDAV_USERNAME}:${TEST_DUMMY_SECRETS.CALDAV_PASSWORD}`)}`,
			depth: "0", "content-type": "application/xml",
		},
		body,
	}), env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

describe("DAV QName on workerd", () => {
	it("既定namespaceと子prefix再束縛を200/404に分ける", async () => {
		const res = await propfind('<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><displayname/><c:calendar-home-set/><c:calendar-home-set xmlns:c="urn:wrong"/><c:Calendar-home-set/><principal-URL/></prop></propfind>');
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:displayname>");
		expect(xml).toContain("<c:calendar-home-set>");
		expect(xml).toContain("<d:principal-URL>");
		expect(xml).toContain('<x1:calendar-home-set xmlns:x1="urn:wrong"/>');
		expect(xml).toContain("<c:Calendar-home-set/>");
		expect(xml).toContain("HTTP/1.1 404 Not Found");
	});

	it("未宣言prefix・DTD・malformed XMLを400にする", async () => {
		for (const body of ['<d:propfind xmlns:d="DAV:"><d:prop><x:displayname/></d:prop></d:propfind>', '<!DOCTYPE p SYSTEM "https://example.com/external"><p/>', '<propfind xmlns="DAV:"><allprop/></propfind><extra/>']) {
			expect((await propfind(body)).status).toBe(400);
		}
	});
});
