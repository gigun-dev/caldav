// 過去の実機要求でURI/case/要素ローカルxmlnsの契約を固定する。
// 手書き再現だけではiOSが実際に送る principal-URL 等の表記変更を見逃す。
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { SaxesParser } from "saxes";
import { AppleColor, CalendarCollection, collectionId, principalPath } from "../../src/domain/caldav";
import { collectionProps, homeProps, multistatus, parsePropFilter, principalProps, responseXml } from "../../src/presentation/dav/xml";

const caldav = "urn:ietf:params:xml:ns:caldav";
const cs = "http://calendarserver.org/ns/";
const apple = "http://apple.com/ns/ical/";
const qname = (namespace: string, local: string) => `{${namespace}}${local}`;
const principalBody = readFileSync(new URL("./fixtures/real-ios/principal-propfind.xml", import.meta.url), "utf8");
const homeBody = readFileSync(new URL("./fixtures/real-ios/home-propfind.xml", import.meta.url), "utf8");

// goldenのQNameは原本を独立に展開して固定する。parsePropFilterがnamespaceを誤解決しても
// 同じ誤った要求集合から404期待値を作って成功させないため、手元のparser結果は正としない。
const golden: { principal: string[]; home: string[] } = JSON.parse(readFileSync(new URL("./fixtures/real-ios/qualified-property-names.json", import.meta.url), "utf8"));

// serializerのprefixや文字列位置に依存せず、応答の実namespaceを読む。
// 200/404の名前を全件比較するので未知プロパティの欠落と200混入の両方を検出できる。
function responseNames(xml: string): Map<string, string[]> {
	const parser = new SaxesParser({ xmlns: true });
	const result = new Map<string, string[]>();
	let depth = 0;
	let propDepth = 0;
	let statusDepth = 0;
	let names: string[] = [];
	let status = "";
	parser.on("opentag", tag => {
		depth++;
		if (tag.uri === "DAV:" && tag.local === "propstat") { names = []; status = ""; }
		if (tag.uri === "DAV:" && tag.local === "prop") propDepth = depth;
		else if (propDepth && depth === propDepth + 1) names.push(qname(tag.uri, tag.local));
		if (tag.uri === "DAV:" && tag.local === "status") statusDepth = depth;
	});
	parser.on("text", text => { if (statusDepth) status += text; });
	parser.on("closetag", tag => {
		if (depth === propDepth) propDepth = 0;
		if (depth === statusDepth) statusDepth = 0;
		if (tag.uri === "DAV:" && tag.local === "propstat") result.set(status.trim(), names);
		depth--;
	});
	parser.write(xml).close();
	return result;
}

function checkSelection(body: string, xml: string, expectedRequested: string[], expected200: string[]): void {
	const filter = parsePropFilter(body);
	if (filter === "allprop") throw new Error("explicit prop request expected");
	const requested = [...filter.values()].map(p => qname(p.namespace, p.localName));
	const groups = responseNames(xml);
	expect(requested).toEqual(expectedRequested);
	expect(groups.get("HTTP/1.1 200 OK")?.toSorted()).toEqual(expected200.toSorted());
	expect(groups.get("HTTP/1.1 404 Not Found")).toEqual(expectedRequested.filter(name => !expected200.includes(name)));
}

describe("実機iOS26.5の探索要求fixture", () => {
	it("principalの14プロパティは6既知を200・8未知を元QNameの404へ返す", () => {
		const xml = multistatus(responseXml("/dav/principals/test/", principalProps("test", "/dav/principals/test/", "/dav/calendars/test/"), parsePropFilter(principalBody)));
		checkSelection(principalBody, xml, golden.principal, [
			qname(caldav, "calendar-home-set"), qname(caldav, "calendar-user-address-set"),
			qname("DAV:", "current-user-principal"), qname("DAV:", "displayname"),
			qname("DAV:", "principal-URL"), qname("DAV:", "supported-report-set"),
		]);
	});

	it("homeの38要求はhome自身の3既知・35未知を欠落なく分ける", () => {
		const xml = multistatus(responseXml("/dav/calendars/test/", homeProps("test"), parsePropFilter(homeBody)));
		checkSelection(homeBody, xml, golden.home, [qname("DAV:", "current-user-privilege-set"), qname("DAV:", "displayname"), qname("DAV:", "resourcetype")]);
	});

	for (const component of ["VEVENT", "VTODO"] as const) {
		it(`38要求の${component} collectionは9既知・29未知を分け、明示sync-tokenを返す`, () => {
			const collection = new CalendarCollection({ id: collectionId("fixture"), owner: principalPath("/dav/principals/test/"), displayName: "Fixture", supportedComponents: [component], color: AppleColor.parse("#112233FF"), order: 3 });
			const xml = multistatus(responseXml("/dav/calendars/test/fixture/", collectionProps(collection, "https://example.com/sync/1"), parsePropFilter(homeBody)));
			checkSelection(homeBody, xml, golden.home, [
				qname(apple, "calendar-color"), qname(apple, "calendar-order"), qname(cs, "getctag"),
				qname(caldav, "supported-calendar-component-set"), qname("DAV:", "current-user-privilege-set"),
				qname("DAV:", "displayname"), qname("DAV:", "resourcetype"),
				qname("DAV:", "supported-report-set"), qname("DAV:", "sync-token"),
			]);
			expect(xml).toContain(`<c:comp name="${component}"/>`);
			expect(xml).toContain("<c:supported-calendar-component-sets/>");
			expect(xml).toContain("<c:schedule-default-calendar-URL/>");
		});
	}
});
