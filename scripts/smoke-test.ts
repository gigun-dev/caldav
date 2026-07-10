// 本番/ローカルで同じCalDAV探索を再現する軽量smoke test。
// 使用例: CALDAV_URL=https://... CALDAV_USERNAME=... CALDAV_PASSWORD=... bun scripts/smoke-test.ts

export {};

const base = process.env.CALDAV_URL?.replace(/\/$/, "");
const username = process.env.CALDAV_USERNAME;
const password = process.env.CALDAV_PASSWORD;
if (!base || !username || !password) throw new Error("CALDAV_URL, CALDAV_USERNAME and CALDAV_PASSWORD are required");

const authorization = `Basic ${btoa(`${username}:${password}`)}`;
const propfind = async (path: string, body: string, depth = "0") => fetch(`${base}${path}`, {
	method: "PROPFIND",
	headers: { authorization, depth, "content-type": "application/xml" },
	body,
});

const entry = await propfind("/dav/", `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/></d:prop></d:propfind>`);
if (entry.status !== 207) throw new Error(`entry PROPFIND failed: ${entry.status} ${await entry.text()}`);
const entryXml = await entry.text();
if (!entryXml.includes("current-user-principal") || !entryXml.includes("principal-URL")) throw new Error("entry discovery properties missing");

const encoded = encodeURIComponent(username);
const principal = await propfind(`/dav/principals/${encoded}/`, `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><d:displayname/></d:prop></d:propfind>`);
if (principal.status !== 207 || !(await principal.text()).includes("calendar-home-set")) throw new Error("principal discovery failed");

const home = await propfind(`/dav/calendars/${encoded}/`, `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:sync-token/></d:prop></d:propfind>`, "1");
const homeXml = await home.text();
if (home.status !== 207 || !homeXml.includes("VEVENT") || !homeXml.includes("VTODO")) throw new Error(`calendar home discovery failed: ${home.status}`);

console.log(JSON.stringify({ ok: true, base, checks: ["entry", "principal", "calendar-home"] }));
