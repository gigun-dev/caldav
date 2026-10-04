// In-memory save counts are not a persistence proof. Exercise the real Worker
// fetch path and local D1, including a valid update after the rejected batch.
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TEST_DUMMY_SECRETS } from "./test-secrets";

function request(path: string, method: string, body?: string): Promise<Response> {
	return exports.default.fetch(new Request(`https://example.com${path}`, {
		method, headers: {
			authorization: `Basic ${btoa(`${env.CALDAV_USERNAME}:${TEST_DUMMY_SECRETS.CALDAV_PASSWORD}`)}`,
			"content-type": "application/xml", depth: "0",
		}, body,
	}), env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

describe("PROPPATCH atomicity on workerd/D1", () => {
	it("rejects a mixed update without changing D1, then persists a valid update", async () => {
		expect((await request("/dav/", "PROPFIND")).status).toBe(207);
		const path = `/dav/calendars/${env.CALDAV_USERNAME}/calendar/`;
		const before = (await env.DB.prepare("SELECT * FROM calendar_collections ORDER BY id").all()).results;
		const rejected = await request(path, "PROPPATCH", '<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:unsupported"><d:set><d:prop><d:displayname>must not persist</d:displayname><x:setting>value</x:setting></d:prop></d:set></d:propertyupdate>');
		expect(rejected.status).toBe(207);
		const xml = await rejected.text();
		expect(xml).toContain("403 Forbidden");
		expect(xml).toContain("424 Failed Dependency");
		expect(xml).not.toContain("200 OK");
		expect((await env.DB.prepare("SELECT * FROM calendar_collections ORDER BY id").all()).results).toEqual(before);

		const accepted = await request(path, "PROPPATCH", '<propertyupdate xmlns="DAV:"><set><prop><displayname>Atomic fixture</displayname></prop></set></propertyupdate>');
		expect(accepted.status).toBe(207);
		expect(await accepted.text()).toContain("200 OK");
		const read = await request(path, "PROPFIND", '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>');
		expect(await read.text()).toContain("Atomic fixture");
	});
});
