// =============================================================================
// PROPPATCH の全件成功 / 全件無変更を app.fetch の実経路で保証する
// =============================================================================
// 0007: codec だけでは、検証が正しくても app が先に save してしまう退行を検知できない。
// app.test.ts と同じ repository factory seam を使い、応答・保存回数・保存値を同時に見る。
// RFC 4918 §9.2 の document order / atomicity が対象。任意 dead property の保存や
// metadata remove の実装は追加せず、未対応の remove も隣の set を巻き戻す境界に留める。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SaxesParser } from "saxes";
import { app, __setRepositoriesFactoryForTest } from "../../src/app";
import { AppleColor, CalendarCollection, collectionId, principalPath } from "../../src/domain/caldav";
import {
	FakeCalendarCollectionRepository,
	FakeCalendarObjectResourceRepository,
	FakeCollectionUnitOfWork,
	FakePrincipalRepository,
} from "../application/fakes";

const USERNAME = "test";
const PASSWORD = "secret";
const OWNER = principalPath(`/dav/principals/${USERNAME}/`);
const CALENDAR = collectionId("calendar");
const PATH = `/dav/calendars/${USERNAME}/calendar/`;
const DAV = "DAV:";
const APPLE = "http://apple.com/ns/ical/";
const UNKNOWN = "urn:proppatch-test";
const INITIAL = { displayName: "Original", color: "#112233FF", order: 7 };

// 実 DB は不要。認証を含む Hono 経路は通し、永続化だけを Fake に差し替える。
const ENV = {
	DB: {} as unknown,
	CALDAV_USERNAME: USERNAME,
	CALDAV_PASSWORD: PASSWORD,
	PROXY_SHARED_SECRET: "",
} as unknown as CloudflareBindings;

function makeRepos() {
	const principals = new FakePrincipalRepository();
	const collections = new FakeCalendarCollectionRepository();
	const resources = new FakeCalendarObjectResourceRepository();
	const uow = new FakeCollectionUnitOfWork(resources, collections);
	let saveCount = 0;
	const originalSave = collections.save.bind(collections);
	collections.save = async (collection: CalendarCollection) => {
		saveCount++;
		await originalSave(collection);
	};
	// seed は save を通さない。PROPFIND provision の保存を混ぜず、要求自体の書込を数える。
	collections.seed(new CalendarCollection({
		id: CALENDAR,
		owner: OWNER,
		displayName: INITIAL.displayName,
		color: AppleColor.parse(INITIAL.color),
		order: INITIAL.order,
	}));
	return { repos: { principals, collections, resources, uow }, getSaveCount: () => saveCount };
}

function propertyupdate(instructions: string): string {
	return `<d:propertyupdate xmlns:d="${DAV}" xmlns:i="${APPLE}" xmlns:x="${UNKNOWN}">${instructions}</d:propertyupdate>`;
}

function set(properties: string): string {
	return `<d:set><d:prop>${properties}</d:prop></d:set>`;
}

function remove(properties: string): string {
	return `<d:remove><d:prop>${properties}</d:prop></d:remove>`;
}

type PropertyStatus = readonly [namespace: string, localName: string, status: number];

/**
 * 応答も namespace を解決して照合する。prefix や propstat のグループ分けは自由なので
 * 文字列順の一致にはしない。一方「403 がどこかにある」だけでは、失敗 QName の欠落や
 * supported への誤った 200 を見逃すため、名前と status の対応を必ず検証する。
 * production の codec helper は使わず、HTTP で実際に返った XML を独立に読む。
 */
async function expectStatuses(response: Response, expected: readonly PropertyStatus[]): Promise<void> {
	expect(response.status).toBe(207);
	const parser = new SaxesParser({ xmlns: true });
	const stack: { namespace: string; localName: string }[] = [];
	const results: PropertyStatus[] = [];
	const hrefs: string[] = [];
	let root: { namespace: string; localName: string } | undefined;
	let current: { properties: { namespace: string; localName: string }[]; status: string } | undefined;
	let href = "";
	const isDav = (index: number, localName: string) => stack[index]?.namespace === DAV && stack[index]?.localName === localName;
	parser.on("opentag", (tag) => {
		const name = { namespace: tag.uri, localName: tag.local };
		stack.push(name);
		if (stack.length === 1) root = name;
		if (stack.length === 3 && isDav(1, "response") && isDav(2, "propstat")) {
			current = { properties: [], status: "" };
		}
		if (stack.length === 5 && current && isDav(3, "prop")) current.properties.push(name);
		if (stack.length === 3 && isDav(1, "response") && isDav(2, "href")) href = "";
	});
	parser.on("text", (text) => {
		if (stack.length === 4 && current && isDav(3, "status")) current.status += text;
		if (stack.length === 3 && isDav(1, "response") && isDav(2, "href")) href += text;
	});
	parser.on("closetag", () => {
		if (stack.length === 3 && current && isDav(2, "propstat")) {
			const status = /^HTTP\/1\.1 (\d{3}) .+$/.exec(current.status);
			expect(status).not.toBeNull();
			expect(current.properties.length).toBeGreaterThan(0);
			for (const prop of current.properties) results.push([prop.namespace, prop.localName, Number(status![1])]);
			current = undefined;
		}
		if (stack.length === 3 && isDav(1, "response") && isDav(2, "href")) hrefs.push(href);
		stack.pop();
	});
	parser.write(await response.text()).close();
	expect(root).toEqual({ namespace: DAV, localName: "multistatus" });
	expect(hrefs).toEqual([PATH]);
	// 同じ property の複数 set は一つの結果へまとめても個別列挙してもよい。
	// ただし同じ QName に 200 と 424 が混在すれば両方残るので失敗として検出する。
	const canonical = (values: readonly PropertyStatus[]) => [...new Set(values.map((value) => JSON.stringify(value)))].sort();
	expect(canonical(results)).toEqual(canonical(expected));
}

describe("PROPPATCH atomicity", () => {
	let restore: () => void;
	let harness: ReturnType<typeof makeRepos>;

	beforeEach(() => {
		harness = makeRepos();
		restore = __setRepositoriesFactoryForTest(() => harness.repos);
	});
	afterEach(() => restore());

	async function patch(body: string): Promise<Response> {
		return app.fetch(new Request(`https://example.com${PATH}`, {
			method: "PROPPATCH",
			headers: { authorization: `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`, "content-type": "application/xml" },
			body,
		}), ENV);
	}

	async function expectMetadata(expected: typeof INITIAL, saves: number): Promise<void> {
		expect(harness.getSaveCount()).toBe(saves);
		const saved = await harness.repos.collections.findById(OWNER, CALENDAR);
		expect(saved).not.toBeNull();
		expect({ displayName: saved!.displayName, color: saved!.color?.hex, order: saved!.order }).toEqual(expected);
	}

	// unknown が先でも後でも、既知プロパティが一瞬でも save されてはいけない。
	for (const unknownFirst of [false, true]) {
		it(`未対応 set が${unknownFirst ? "先頭" : "末尾"}なら403、既知 set は424で全件無変更`, async () => {
			const supported = set('<d:displayname>Changed</d:displayname><i:calendar-color>#445566FF</i:calendar-color><i:calendar-order>9</i:calendar-order>');
			const unsupported = set("<x:UnknownCase>value</x:UnknownCase>");
			const response = await patch(propertyupdate(unknownFirst ? unsupported + supported : supported + unsupported));
			await expectStatuses(response, [
				[DAV, "displayname", 424], [APPLE, "calendar-color", 424], [APPLE, "calendar-order", 424],
				[UNKNOWN, "UnknownCase", 403],
			]);
			await expectMetadata(INITIAL, 0);
		});
	}

	for (const operation of ["set", "remove"] as const) {
		it(`未対応 ${operation} だけでも空 response にせず403、saveは0回`, async () => {
			const instruction = operation === "set" ? set("<x:UnknownCase>value</x:UnknownCase>") : remove("<x:UnknownCase/>");
			await expectStatuses(await patch(propertyupdate(instruction)), [[UNKNOWN, "UnknownCase", 403]]);
			await expectMetadata(INITIAL, 0);
		});
	}

	// local 名だけ / 小文字化の照合を復活させると「別プロパティ」が既知値を上書きする。
	// 応答でも入力の正確な URI と case を保持することまで固定する。
	for (const [property, namespace, localName] of [
		["<x:displayname>Wrong</x:displayname>", UNKNOWN, "displayname"],
		["<displayname>Wrong</displayname>", "", "displayname"],
		["<d:DisplayName>Wrong</d:DisplayName>", DAV, "DisplayName"],
		["<d:calendar-color>#445566FF</d:calendar-color>", DAV, "calendar-color"],
		["<i:Calendar-Color>#445566FF</i:Calendar-Color>", APPLE, "Calendar-Color"],
		["<d:calendar-order>9</d:calendar-order>", DAV, "calendar-order"],
		["<i:Calendar-Order>9</i:Calendar-Order>", APPLE, "Calendar-Order"],
	] as const) {
		it(`正規QName以外の {${namespace}}${localName} は403で保存しない`, async () => {
			await expectStatuses(await patch(propertyupdate(set(property))), [[namespace, localName, 403]]);
			await expectMetadata(INITIAL, 0);
		});
	}

	it("正規QNameの表示名・色・順序を一度だけ保存し、全件200を返す", async () => {
		const response = await patch(propertyupdate(set('<d:displayname>Changed &amp; Work</d:displayname><i:calendar-color symbolic-color="blue">#445566ff</i:calendar-color><i:calendar-order>9</i:calendar-order>')));
		await expectStatuses(response, [[DAV, "displayname", 200], [APPLE, "calendar-color", 200], [APPLE, "calendar-order", 200]]);
		await expectMetadata({ displayName: "Changed & Work", color: "#445566FF", order: 9 }, 1);
	});

	it("prefixが違っても既定xmlnsでも正規URIなら同じ既知プロパティとして保存する", async () => {
		const response = await patch(`<propertyupdate xmlns="${DAV}"><set><prop><displayname>Alternate</displayname><calendar-color xmlns="${APPLE}">#445566FF</calendar-color><a:calendar-order xmlns:a="${APPLE}">9</a:calendar-order></prop></set></propertyupdate>`);
		await expectStatuses(response, [[DAV, "displayname", 200], [APPLE, "calendar-color", 200], [APPLE, "calendar-order", 200]]);
		await expectMetadata({ displayName: "Alternate", color: "#445566FF", order: 9 }, 1);
	});

	it("繰り返しsetをdocument orderで適用し、最後の値だけを一度保存する", async () => {
		const response = await patch(propertyupdate(
			set("<d:displayname>First</d:displayname><i:calendar-order>2</i:calendar-order>") +
			set("<i:calendar-color>#445566FF</i:calendar-color><d:displayname>Second</d:displayname>") +
			set("<d:displayname>Last</d:displayname><i:calendar-color>#AABBCCFF</i:calendar-color><i:calendar-order>11</i:calendar-order>"),
		));
		await expectStatuses(response, [[DAV, "displayname", 200], [APPLE, "calendar-color", 200], [APPLE, "calendar-order", 200]]);
		await expectMetadata({ displayName: "Last", color: "#AABBCCFF", order: 11 }, 1);
	});

	// XML全文の検証を終える前に適用しない。先頭の有効setを拾うregex実装への退行も防ぐ。
	for (const [label, body] of [
		["閉じタグ欠落", `<d:propertyupdate xmlns:d="${DAV}">${set("<d:displayname>Changed</d:displayname>")}`],
		["未宣言prefix", propertyupdate(set("<d:displayname>Changed</d:displayname><missing:property/>"))],
		["DTD", `<!DOCTYPE propertyupdate SYSTEM "https://example.com/unused.dtd">${propertyupdate(set("<d:displayname>Changed</d:displayname>"))}`],
	] as const) {
		it(`${label}は要求全体を400にし保存しない`, async () => {
			expect((await patch(body)).status).toBe(400);
			await expectMetadata(INITIAL, 0);
		});
	}

	for (const [invalid, localName] of [
		["<i:calendar-color>not-a-color</i:calendar-color>", "calendar-color"],
		["<i:calendar-order>not-a-number</i:calendar-order>", "calendar-order"],
	] as const) {
		it(`不正な${localName}は409、隣のdisplaynameは424、全件無変更`, async () => {
			const response = await patch(propertyupdate(set(`<d:displayname>Changed</d:displayname>${invalid}`)));
			await expectStatuses(response, [[DAV, "displayname", 424], [APPLE, localName, 409]]);
			await expectMetadata(INITIAL, 0);
		});
	}

	// 共有 UC / domain は metadata の削除契約を持たない。このスライスで意味を広げず、
	// remove を黙って捨てたり set として拾ったりして部分成功させないことを検証する。
	for (const [removed, namespace, localName, adjacent, adjacentNamespace, adjacentName] of [
		["<d:displayname/>", DAV, "displayname", "<i:calendar-color>#445566FF</i:calendar-color>", APPLE, "calendar-color"],
		["<i:calendar-color/>", APPLE, "calendar-color", "<d:displayname>Changed</d:displayname>", DAV, "displayname"],
		["<i:calendar-order/>", APPLE, "calendar-order", "<d:displayname>Changed</d:displayname>", DAV, "displayname"],
	] as const) {
		for (const removeFirst of [false, true]) {
			it(`${localName}のremoveが${removeFirst ? "先頭" : "末尾"}でも403、隣のsetは424で保存しない`, async () => {
				const instruction = removeFirst ? remove(removed) + set(adjacent) : set(adjacent) + remove(removed);
				await expectStatuses(await patch(propertyupdate(instruction)), [
					[namespace, localName, 403], [adjacentNamespace, adjacentName, 424],
				]);
				await expectMetadata(INITIAL, 0);
			});
		}
	}
});
