// =============================================================================
// ロスレス往復テスト(RFC 5545 §3.1)— このプロジェクトの最優先不変条件
// =============================================================================
// 検証は2段階(タスク要件):
//   1. オクテット等価: 正規形(CRLF・75 オクテット折り畳み・必要最小限クォート)で作った
//      フィクスチャは parse→serialize で「バイト完全一致」に戻ること。
//   2. 意味論的等価: LF 改行など非正規入力は、parse→serialize→parse の2回目 parse 結果が
//      1回目と deepEqual(= 冪等)であること。改行や折り畳みの正規化はあっても構造は不変。
//
// なぜ往復が最優先か: RFC 4791 §5.3.3(X- 拡張の格納 MUST)/ §5.3.4(データを書き換えたら
// PUT 応答で ETag を返せない MUST NOT)。生テキスト保持の設計が正しく効いているかをここで守る。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse, serialize } from "../../../src/domain/ical";

// フィクスチャは import.meta.dir 基準の node:fs 読み込み(タスク指定。bun test で動けばよい)。
// encoding は utf8。CRLF/バイト列を書き換えないよう .gitattributes で *.ics -text を設定済み。
const fixture = (name: string): string =>
	readFileSync(`${import.meta.dir}/fixtures/${name}`, "utf8");

// 正規形フィクスチャ群(オクテット等価が成立するもの)。
const CANONICAL = [
	"ios-event.ics",
	"ios-reminder.ics",
	"japanese-folding.ics",
	"recurrence-override.ics",
	"edge-cases.ics",
] as const;

describe("段階1: オクテット等価(正規形フィクスチャ)", () => {
	for (const name of CANONICAL) {
		test(`${name}: parse→serialize がバイト完全一致`, () => {
			const original = fixture(name);
			const reserialized = serialize(parse(original));
			// 完全一致。折り畳み位置・CRLF・クォート・プロパティ順まで含めて 1 バイトも変わらない。
			expect(reserialized).toBe(original);
		});
	}
});

describe("段階2: 意味論的等価(冪等性)", () => {
	// LF のみのフィクスチャ。1 回目 serialize で CRLF・折り畳みに正規化されるので
	// バイトは変わる。しかし parse→serialize→parse の構造は変わらないこと(deepEqual)。
	test("lf-only.ics: 非正規入力でも構造は保存(冪等)", () => {
		const original = fixture("lf-only.ics");
		const first = parse(original);
		const roundtripped = parse(serialize(first));
		expect(roundtripped).toEqual(first);
	});

	// 全フィクスチャで「2 回目以降は完全に安定する」ことも確認(serialize は冪等)。
	for (const name of [...CANONICAL, "lf-only.ics"]) {
		test(`${name}: serialize は冪等(2 回目以降バイト不変)`, () => {
			const once = serialize(parse(fixture(name)));
			const twice = serialize(parse(once));
			expect(twice).toBe(once);
		});
	}
});

describe("往復で構造が保存されること(スポットチェック)", () => {
	test("edge-cases: quoted param・複数値・エスケープ・空値が全て保たれる", () => {
		const vevent = parse(fixture("edge-cases.ics")).components[0]!;

		// TEXT エスケープは生のまま(解除されない)。
		const summary = vevent.properties.find((p) => p.name === "SUMMARY")!;
		expect(summary.value).toContain(String.raw`\n`);
		expect(summary.value).toContain(String.raw`\,`);
		expect(summary.value).toContain(String.raw`\;`);

		// 空値プロパティ。
		const empty = vevent.properties.find((p) => p.name === "DESCRIPTION")!;
		expect(empty.value).toBe("");

		// quoted param(, と ; を含む)は 1 値として復元。
		const attendee = vevent.properties.find((p) => p.name === "ATTENDEE")!;
		const cn = attendee.parameters.find((p) => p.name === "CN")!;
		expect(cn.values).toEqual(["Doe, John; Jr."]);
		// MEMBER は複数の quoted 値。
		const member = attendee.parameters.find((p) => p.name === "MEMBER")!;
		expect(member.values).toEqual(["mailto:a@x.com", "mailto:b@x.com"]);

		// 複数値パラメータ。
		const multi = vevent.properties.find((p) => p.name === "X-MULTI")!;
		expect(multi.parameters[0]!.values).toEqual(["one", "two", "three"]);
	});

	test("recurrence-override: 同一 UID の master + override 2 VEVENT が保たれる", () => {
		const cal = parse(fixture("recurrence-override.ics"));
		const events = cal.components.filter((c) => c.name === "VEVENT");
		expect(events).toHaveLength(2);
		// 2 つ目に RECURRENCE-ID が付く(オーバーライド)。
		const hasRecurrenceId = (c: (typeof events)[number]) =>
			c.properties.some((p) => p.name === "RECURRENCE-ID");
		expect(hasRecurrenceId(events[0]!)).toBe(false);
		expect(hasRecurrenceId(events[1]!)).toBe(true);
		// UID は両方同じ。
		const uid = (c: (typeof events)[number]) =>
			c.properties.find((p) => p.name === "UID")!.value;
		expect(uid(events[0]!)).toBe(uid(events[1]!));
	});

	test("ios-event: VTIMEZONE と VALARM のネストが保たれる", () => {
		const cal = parse(fixture("ios-event.ics"));
		expect(cal.components.some((c) => c.name === "VTIMEZONE")).toBe(true);
		const vevent = cal.components.find((c) => c.name === "VEVENT")!;
		expect(vevent.components.some((c) => c.name === "VALARM")).toBe(true);
		// 折り畳まれていた X-APPLE-STRUCTURED-LOCATION の値(unfold 済み)が geo: で始まる。
		const loc = vevent.properties.find(
			(p) => p.name === "X-APPLE-STRUCTURED-LOCATION",
		)!;
		expect(loc.value).toBe("geo:37.334606,-122.009102");
		// VALUE=URI パラメータと quoted X-TITLE が保たれる。
		expect(loc.parameters.find((p) => p.name === "VALUE")!.values).toEqual([
			"URI",
		]);
		expect(loc.parameters.find((p) => p.name === "X-TITLE")!.values).toEqual([
			"Apple Park, 1 Apple Park Way, Cupertino, CA",
		]);
	});
});

// =============================================================================
// 実データ版フィクスチャ(iOS 26.5 実機キャプチャ、2026-07-10)
// =============================================================================
// fixtures/real-ios/ に保存した「iOS が実際に PUT してきた生 ICS」。由来と伏せ字化は
// fixtures/real-ios/README.md 参照。ここでの分類は往復レベル別:
//   - CANONICAL_REAL_IOS: iOS の折り畳み結果が本作 serializer と一致 → オクテット等価が成立。
//   - FOLDED_REAL_IOS: 116B の日本語 SUMMARY 等、iOS が本作と違う位置で折る(または折らない)
//     行を含む。バイト等価は不成立だが、parse→serialize→parse が構造 deepEqual = 冪等。
// なぜ分けるか: iOS の折り畳みは 75 オクテット厳守ではなく「非 ASCII を含む値は寛容/折らない」
// 傾向で、本作(生成時のみ 75 で折る)と生成結果が食い違う。本作は格納時に生バイト保持なので
// 実害は無く、往復の担保は「生成しない限りオクテット等価/生成する場合は冪等」で足りる。
const realIos = (name: string): string =>
	readFileSync(`${import.meta.dir}/fixtures/real-ios/${name}`, "utf8");

const CANONICAL_REAL_IOS = [
	"weekly-recur-event.ics", // ③ RRULE(FREQ 先頭)+ X-APPLE-TRAVEL-DURATION + VTIMEZONE
	"attendee-invite-event.ics", // ⑦ ATTENDEE/ORGANIZER 無し(B9)
	"vtodo-date-only.ics", // ⑩ DUE 無しの最小 VTODO
	"vtodo-completed.ics", // ⑫ STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100
] as const;

const FOLDED_REAL_IOS = [
	"japanese-long-event.ics", // ① 116B 日本語 SUMMARY を iOS は折らない(本作は 75 で折る)
	"vtodo-proximity-alarm.ics", // ⑬ X-APPLE-PROXIMITY + STRUCTURED-LOCATION(伏せ字済み)
	// A7 決着(2026-07-11 第3ラウンド): LOCATION 値に生 DQUOTE("折立")、X-TITLE パラメータ
	// では iOS が DQUOTE を黙って除去(RFC 6868 ^ エンコードは使わない)。geo は伏せ字済み。
	// iOS は非 ASCII 含み長行を折らない + 伏せ字で折り位置も変わったため冪等群。
	"dquote-location-event.ics",
] as const;

describe("実データ(iOS 26.5): オクテット等価群", () => {
	for (const name of CANONICAL_REAL_IOS) {
		test(`${name}: parse→serialize がバイト完全一致`, () => {
			const original = realIos(name);
			expect(serialize(parse(original))).toBe(original);
		});
	}
});

describe("実データ(iOS 26.5): 折り畳み差異あり(冪等のみ保証)", () => {
	for (const name of FOLDED_REAL_IOS) {
		test(`${name}: 構造は保存(parse→serialize→parse が deepEqual)`, () => {
			const original = realIos(name);
			const first = parse(original);
			expect(parse(serialize(first))).toEqual(first);
		});
		test(`${name}: serialize は冪等(2 回目以降バイト不変)`, () => {
			const once = serialize(parse(realIos(name)));
			expect(serialize(parse(once))).toBe(once);
		});
	}

	// A2 実測の回帰: iOS は 116 オクテットの日本語 SUMMARY を折らずに送るが、本作 serializer は
	// 75 で折る。この「食い違いが起きること自体」を固定しておく(将来 serializer の折り畳みを
	// いじったとき、iOS 実データとの関係が変わったら気づけるように)。
	test("japanese-long-event: 116B 日本語行を iOS は折らないが本作は折る", () => {
		const original = realIos("japanese-long-event.ics");
		// 原本(iOS)は SUMMARY を 1 物理行で送っている(継続行が無い)。
		expect(original).toContain(
			"\r\nSUMMARY:日本語長文タイトルです。これは予定のタイトルです。場所と通知を含みます。\r\n",
		);
		// 本作 serialize はこの行を 75 オクテットで折る(継続行 " " が出現)。
		const reserialized = serialize(parse(original));
		expect(reserialized).not.toBe(original);
		expect(reserialized).toContain("\r\n "); // 折り畳み継続行が発生している
	});
});
