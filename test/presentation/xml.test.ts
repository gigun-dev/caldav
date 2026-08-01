import { describe, expect, it } from "bun:test";
import { CalendarCollection, collectionId, principalPath } from "../../src/domain/caldav";
import {
	collectionProps,
	multistatus,
	parseCalendarQueryFilter,
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

	// =========================================================================
	// 404 propstat のプロパティ名は「要求された名前」でなければならない(2026-08-01 修正)
	// =========================================================================
	// 何を保証するか(RFC 4918 §14.22 "The contents of the prop XML element MUST only list the
	// names of properties to which the result in the status element applies." + §17
	// "WebDAV property names are qualified XML names (pairs of XML namespace name and local
	// name)."):404 propstat に並ぶ要素は、**要求された名前空間**と**要求されたままの
	// ローカル名(大文字小文字を含む)**を保つこと。
	// 回帰対象: 修正前は全部 `<d:...>`(DAV: へ潰す)+ 小文字化していた(本番実測)。
	describe("404 propstat のプロパティ名の忠実性", () => {
		/** 5 名前空間 + DAV: を一度に要求するボディ。実クライアント(iOS)の宣言スタイルに合わせ、
		 *  xmlns は全部 root 要素に置く。 */
		const MULTI_NS_PROPFIND = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<A:propfind xmlns:A="DAV:" xmlns:B="http://apple.com/ns/ical/"',
			' xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="http://calendarserver.org/ns/"',
			' xmlns:E="urn:ietf:params:xml:ns:carddav" xmlns:F="http://me.com/_namespace/">',
			"<A:prop>",
			"<A:principal-collection-set/>",
			"<B:calendar-color/>",
			"<C:schedule-default-calendar-URL/>",
			"<D:email-address-set/>",
			"<E:addressbook-home-set/>",
			"<F:bulk-requests/>",
			"</A:prop></A:propfind>",
		].join("");

		/** props を空にして「全部 404 へ落ちる」状態にした最小の response。 */
		function missingOnly(body: string): string {
			return multistatus(responseXml("/dav/principals/admin/", {}, parsePropFilter(body)));
		}

		it("DAV: の要求は d: prefix で返す", () => {
			expect(missingOnly(MULTI_NS_PROPFIND)).toContain("<d:principal-collection-set/>");
		});

		it("Apple ical 名前空間の要求は DAV: に潰さず ical: prefix で返す", () => {
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml).toContain("<ical:calendar-color/>");
			expect(xml).not.toContain("<d:calendar-color/>");
		});

		it("CalDAV 名前空間の要求は c: prefix で返す", () => {
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml).toContain("<c:schedule-default-calendar-URL/>");
			expect(xml).not.toContain("<d:schedule-default-calendar-URL/>");
		});

		it("calendarserver 名前空間の要求は cs: prefix で返す", () => {
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml).toContain("<cs:email-address-set/>");
			expect(xml).not.toContain("<d:email-address-set/>");
		});

		it("multistatus が宣言していない名前空間(carddav / me.com)は要素自身に xmlns を付けて返す", () => {
			// 要求されうる名前空間は無限なので、multistatus の静的な宣言リストでは閉じない。
			// 要素ローカル宣言で任意の URI を正しく表現できることを固定する。
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml).toMatch(/<(\w+):addressbook-home-set xmlns:\1="urn:ietf:params:xml:ns:carddav"\/>/);
			expect(xml).toMatch(/<(\w+):bulk-requests xmlns:\1="http:\/\/me\.com\/_namespace\/"\/>/);
			// DAV: へ潰していないこと。
			expect(xml).not.toContain("<d:addressbook-home-set/>");
			expect(xml).not.toContain("<d:bulk-requests/>");
		});

		it("大文字を含むローカル名(schedule-default-calendar-URL)を小文字化しない", () => {
			// XML の要素名は大文字小文字を区別するので、小文字化すると別の要素になる。
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml).toContain("schedule-default-calendar-URL");
			expect(xml).not.toContain("schedule-default-calendar-url");
		});

		it("同じ未宣言名前空間の複数プロパティは、どの要素にも xmlns を付ける(スコープは要素単位)", () => {
			// 2個目の宣言を省くと名前空間的に非整形式になる、という踏みやすい罠の回帰。
			const body = '<A:propfind xmlns:A="DAV:" xmlns:V="http://vendor.example/ns/"><A:prop><V:one/><V:two/></A:prop></A:propfind>';
			const xml = missingOnly(body);
			expect((xml.match(/xmlns:x1="http:\/\/vendor\.example\/ns\/"/g) ?? []).length).toBe(2);
		});

		it("既定名前空間(xmlns=)で要求されたプロパティも名前空間を解決する", () => {
			// prefix を一切使わないクライアントの表記。unprefixed = 既定名前空間 DAV:。
			const body = '<propfind xmlns="DAV:"><prop><nosuchprop/></prop></propfind>';
			expect(missingOnly(body)).toContain("<d:nosuchprop/>");
		});

		it("名前空間が特定できない要求は prefix 無しで返す(DAV: を捏造しない)", () => {
			// prefix を宣言し忘れた壊れた要求。旧実装は無条件に d: を付けていたが、
			// 「知らない名前空間を DAV: だと言い張る」より「名前空間なし」の方が誠実。
			const body = '<propfind><prop><Z:mystery/></prop></propfind>';
			const xml = missingOnly(body);
			expect(xml).toContain("<mystery/>");
			expect(xml).not.toContain("<d:mystery/>");
		});

		it("404 の並び順はクライアントが要求した順を保つ", () => {
			// RFC の要求ではないが、リクエストと応答の目視突き合わせを楽にするための仕様。
			const xml = missingOnly(MULTI_NS_PROPFIND);
			expect(xml.indexOf("principal-collection-set")).toBeLessThan(xml.indexOf("calendar-color"));
			expect(xml.indexOf("calendar-color")).toBeLessThan(xml.indexOf("schedule-default-calendar-URL"));
		});

		it("200 側の照合はローカル名で行うので、名前空間つき要求でも既存プロパティは 200 に載る", () => {
			// 「マッチングの正規化」と「応答の表現」を分けた設計の裏返し。ここが崩れると
			// 既存クライアントの 200 応答が丸ごと 404 に落ちるので、明示的に固定しておく。
			const filter = parsePropFilter(MULTI_NS_PROPFIND);
			const xml = responseXml("/dav/cal/", {
				"calendar-color": "<ical:calendar-color>#FF0000FF</ical:calendar-color>",
			}, filter);
			expect(xml).toContain("<ical:calendar-color>#FF0000FF</ical:calendar-color>");
			expect(xml).toContain("HTTP/1.1 200 OK");
		});

		it("multistatus が宣言する prefix と 404 側が使う prefix は一致する", () => {
			// DECLARED_NS_PREFIXES と multistatus() のテンプレートの二重管理を守る番人。
			// どちらか片方だけを増減させると、未宣言 prefix を使った非整形式 XML になる。
			const empty = multistatus("");
			for (const [prefix, uri] of [
				["d", "DAV:"],
				["c", "urn:ietf:params:xml:ns:caldav"],
				["cs", "http://calendarserver.org/ns/"],
				["ical", "http://apple.com/ns/ical/"],
			]) {
				expect(empty).toContain(`xmlns:${prefix}="${uri}"`);
			}
		});
	});

	it("prefixに依存せずhrefを抽出してXML entityを戻す", () => {
		expect(parseHrefs(`<x:href xmlns:x="DAV:">/a&amp;b.ics</x:href>`)).toEqual(["/a&b.ics"]);
	});

	it("Extended MKCOLの表示名・種別・Apple属性を読む", () => {
		const props = parseCollectionProperties(`<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>仕事 &amp; 私用</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><i:calendar-color symbolic-color="blue">#112233FF</i:calendar-color><i:calendar-order>4</i:calendar-order></d:prop></d:set></d:mkcol>`);
		expect(props).toEqual({ displayName: "仕事 & 私用", components: ["VTODO"], color: "#112233FF", order: 4 });
	});

	// J-2: supported-calendar-component-set は複数 comp を並べられる(§5.2.3)。VJOURNAL 対応 +
	// 複数 comp 対応の回帰テスト。
	it("VJOURNAL の comp name を拾う", () => {
		const props = parseCollectionProperties(
			`<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><c:supported-calendar-component-set><c:comp name="VJOURNAL"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`,
		);
		expect(props.components).toEqual(["VJOURNAL"]);
	});

	it("複数 comp(VEVENT+VTODO)を配列で返す", () => {
		const props = parseCollectionProperties(
			`<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`,
		);
		expect(props.components).toEqual(["VEVENT", "VTODO"]);
	});

	it("comp が無ければ components は undefined", () => {
		const props = parseCollectionProperties(
			`<d:mkcol xmlns:d="DAV:"><d:set><d:prop><d:displayname>foo</d:displayname></d:prop></d:set></d:mkcol>`,
		);
		expect(props.components).toBeUndefined();
	});

	// J-2: collectionProps の supported-calendar-component-set 宣言。
	describe("collectionProps: supported-calendar-component-set", () => {
		it("supportedComponents=undefined のコレクションは VEVENT/VTODO/VJOURNAL 全部を宣言する(§5.2.3: プロパティ不在=全受理 MUST と実際の受理を一致させる)", () => {
			const col = new CalendarCollection({
				id: collectionId("misc"),
				owner: principalPath("/principals/users/alice/"),
				displayName: "Misc",
			});
			const props = collectionProps(col, "https://example.com/sync/1");
			const decl = props["supported-calendar-component-set"];
			expect(decl).toContain('<c:comp name="VEVENT"/>');
			expect(decl).toContain('<c:comp name="VTODO"/>');
			expect(decl).toContain('<c:comp name="VJOURNAL"/>');
		});

		it("supportedComponents=[VEVENT] の既定 calendar コレクションは VEVENT だけ宣言する(VJOURNAL を宣言しないことの回帰保証)", () => {
			const col = new CalendarCollection({
				id: collectionId("calendar"),
				owner: principalPath("/principals/users/alice/"),
				displayName: "Calendar",
				supportedComponents: ["VEVENT"],
			});
			const props = collectionProps(col, "https://example.com/sync/1");
			const decl = props["supported-calendar-component-set"];
			expect(decl).toBe('<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>');
		});
	});

	// R-5a: free-busy-query REPORT(G-4 で実装済み)が supported-report-set の広告に無かった漏れの回帰。
	it("supported-report-set は free-busy-query を含む(§7.10.2 の実装済み REPORT を広告する)", () => {
		const col = new CalendarCollection({
			id: collectionId("misc"),
			owner: principalPath("/principals/users/alice/"),
			displayName: "Misc",
		});
		const props = collectionProps(col, "https://example.com/sync/1");
		expect(props["supported-report-set"]).toContain("<c:free-busy-query/>");
	});

	// R-5b: RFC 6578 §4 は DAV:sync-token を「PROPFIND allprop では SHOULD NOT 返す」と定める。
	describe("responseXml: sync-token と allprop(R-5b)", () => {
		const col = new CalendarCollection({
			id: collectionId("misc"),
			owner: principalPath("/principals/users/alice/"),
			displayName: "Misc",
		});
		const props = collectionProps(col, "https://example.com/sync/1");

		it("allprop 応答には sync-token を含めない", () => {
			const filter = parsePropFilter(`<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>`);
			const xml = responseXml("/dav/cal/", props, filter);
			expect(xml).not.toContain("<d:sync-token>");
			// allprop でも他プロパティは通常どおり返る(除外は sync-token 限定であることの確認)。
			expect(xml).toContain("<cs:getctag>");
		});

		it("<d:sync-token/> を明示要求した場合は返す", () => {
			const filter = parsePropFilter(`<d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>`);
			const xml = responseXml("/dav/cal/", props, filter);
			expect(xml).toContain("<d:sync-token>https://example.com/sync/1</d:sync-token>");
		});
	});

	// =========================================================================
	// G-3: parseCalendarQueryFilter
	// =========================================================================
	describe("parseCalendarQueryFilter", () => {
		it("comp-filter + time-range を抜き出す(VEVENT)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<D:prop><D:getetag/><C:calendar-data/></D:prop>",
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VEVENT">',
				'<C:time-range start="20260101T000000Z" end="20260201T000000Z"/>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VEVENT");
			expect(filter.timeRange).toEqual({
				startMillis: Date.UTC(2026, 0, 1),
				endMillis: Date.UTC(2026, 1, 1),
			});
			expect(filter.floatingTimeZone).toBeUndefined();
		});

		it("time-range が無ければ comp-filter のみ(range=undefined)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VTODO"/>',
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VTODO");
			expect(filter.timeRange).toBeUndefined();
		});

		it("prop-filter があれば unsupported=true(§7.8 supported-filter 対象外)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VEVENT">',
				'<C:prop-filter name="UID"><C:text-match>abc</C:text-match></C:prop-filter>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(true);
		});

		it("ネストした comp-filter(VALARM 等)は unsupported=true", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VTODO">',
				'<C:comp-filter name="VALARM"><C:time-range start="20260106T100000Z"/></C:comp-filter>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			expect(parseCalendarQueryFilter(body).unsupported).toBe(true);
		});

		it("CALDAV:expand は unsupported=true", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				'<D:prop><C:calendar-data><C:expand start="20260101T000000Z" end="20260201T000000Z"/></C:calendar-data></D:prop>',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>',
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			expect(parseCalendarQueryFilter(body).unsupported).toBe(true);
		});

		it("CALDAV:timezone の VTIMEZONE を解決して floatingTimeZone に入れる", () => {
			const vtimezoneIcs = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Test//Test//EN",
				"BEGIN:VTIMEZONE",
				"TZID:Asia/Tokyo",
				"BEGIN:STANDARD",
				"DTSTART:19700101T000000",
				"TZOFFSETFROM:+0900",
				"TZOFFSETTO:+0900",
				"END:STANDARD",
				"END:VTIMEZONE",
				"END:VCALENDAR",
			].join("\n");
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				`<C:timezone>${vtimezoneIcs}</C:timezone>`,
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>',
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.floatingTimeZone).toBe("Asia/Tokyo");
		});

		// =====================================================================
		// J-1: VJOURNAL の comp-filter 対応(J-1 時点は time-range 無しのみ許可。
		// J-4 で time-range 付きも解禁 — 下の describe 末尾のテスト参照)
		// =====================================================================
		it("comp-filter VJOURNAL(time-range 無し)は unsupported=false で通す", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VJOURNAL"/>',
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VJOURNAL");
			expect(filter.timeRange).toBeUndefined();
		});

		// J-4: application 層(vjournalOverlapsRange)に §9.9 VJOURNAL 実効値表 + RRULE 展開を
		// 実装したため、VJOURNAL+time-range は VEVENT/VTODO と同じく解禁(旧 J-1 の暫定 unsupported を解除)。
		it("comp-filter VJOURNAL + time-range は unsupported=false で通す(J-4 で解禁)", () => {
			const body = [
				'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
				"<C:filter>",
				'<C:comp-filter name="VCALENDAR">',
				'<C:comp-filter name="VJOURNAL">',
				'<C:time-range start="20260101T000000Z" end="20260201T000000Z"/>',
				"</C:comp-filter>",
				"</C:comp-filter>",
				"</C:filter>",
				"</C:calendar-query>",
			].join("");
			const filter = parseCalendarQueryFilter(body);
			expect(filter.unsupported).toBe(false);
			expect(filter.componentName).toBe("VJOURNAL");
			expect(filter.timeRange).toEqual({
				startMillis: Date.UTC(2026, 0, 1, 0, 0, 0),
				endMillis: Date.UTC(2026, 1, 1, 0, 0, 0),
			});
		});
	});
});
