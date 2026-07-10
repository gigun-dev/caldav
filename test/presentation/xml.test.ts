import { describe, expect, it } from "bun:test";
import {
	multistatus,
	parseCollectionProperties,
	parseHrefs,
	parsePropFilter,
	responseXml,
} from "../../src/presentation/dav/xml";

describe("DAV XML", () => {
	it("要求された未知プロパティを404 propstatへ列挙する", () => {
		const filter = parsePropFilter(`<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:unknown/></d:prop></d:propfind>`);
		const xml = multistatus(responseXml("/dav/", {
			resourcetype: "<d:resourcetype><d:collection/></d:resourcetype>",
		}, filter));
		expect(xml).toContain("HTTP/1.1 200 OK");
		expect(xml).toContain("<d:unknown/>");
		expect(xml).toContain("HTTP/1.1 404 Not Found");
	});

	it("prefixに依存せずhrefを抽出してXML entityを戻す", () => {
		expect(parseHrefs(`<x:href xmlns:x="DAV:">/a&amp;b.ics</x:href>`)).toEqual(["/a&b.ics"]);
	});

	it("Extended MKCOLの表示名・種別・Apple属性を読む", () => {
		const props = parseCollectionProperties(`<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>仕事 &amp; 私用</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><i:calendar-color symbolic-color="blue">#112233FF</i:calendar-color><i:calendar-order>4</i:calendar-order></d:prop></d:set></d:mkcol>`);
		expect(props).toEqual({ displayName: "仕事 & 私用", component: "VTODO", color: "#112233FF", order: 4 });
	});
});
