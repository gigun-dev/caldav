// フィクスチャ生成スクリプト(bun run _gen.ts で実行)。
// canonical フィクスチャは serialize(parse(src)) を通して CRLF・75 オクテット折り畳みの
// 正規形に「焼き込む」ことで、ロスレス往復のオクテット等価テストが必ず通る形にする。
// 手で折り畳み位置を数える代わりに、シリアライザ自身に正規形を作らせる(=テストと同じ規則)。
// lf-only.ics だけは LF のまま(寛容受理の冪等性テスト用)なので canonicalize しない。
import { writeFileSync } from "node:fs";
import { parse, serialize } from "../../../../src/domain/ical";

const dir = import.meta.dir;

// canonical: LF ソースを parse→serialize で CRLF・折り畳み正規形にして書き出す。
// エンコードは UTF-8(日本語フィクスチャがあるため必須。折り畳みは UTF-8 バイト基準)。
function canonical(name: string, src: string): void {
	writeFileSync(`${dir}/${name}`, serialize(parse(src)), "utf8");
}
// raw: バイト列をそのまま書き出す(改行を書き換えない)
function raw(name: string, src: string): void {
	writeFileSync(`${dir}/${name}`, src, "utf8");
}

// --- ios-event.ics: VTIMEZONE(Asia/Tokyo STANDARD)+ X-APPLE-* + VALARM -------
canonical(
	"ios-event.ics",
	String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iPhone OS 17.5//EN
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
BEGIN:STANDARD
DTSTART:19510906T000000
TZNAME:JST
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
CREATED:20260701T120000Z
DTSTAMP:20260701T120000Z
LAST-MODIFIED:20260701T120000Z
UID:1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D
SUMMARY:Team sync
DTSTART;TZID=Asia/Tokyo:20260710T100000
DTEND;TZID=Asia/Tokyo:20260710T110000
SEQUENCE:0
TRANSP:OPAQUE
X-APPLE-CREATOR-IDENTITY:com.apple.mobilecal
X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70.0;X-TITLE="Apple Park, 1 Apple Park Way, Cupertino, CA":geo:37.334606,-122.009102
BEGIN:VALARM
ACKNOWLEDGED:20260710T005500Z
ACTION:DISPLAY
DESCRIPTION:Reminder
TRIGGER:-PT15M
UID:9F8E7D6C-5B4A-3928-1706-F5E4D3C2B1A0
X-WR-ALARMUID:9F8E7D6C-5B4A-3928-1706-F5E4D3C2B1A0
END:VALARM
END:VEVENT
END:VCALENDAR
`,
);

// --- ios-reminder.ics: VTODO(X-APPLE-SORT-ORDER / PRIORITY / STATUS) ---------
canonical(
	"ios-reminder.ics",
	String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iOS 17.5//EN
CALSCALE:GREGORIAN
BEGIN:VTODO
CREATED:20260701T090000Z
DTSTAMP:20260701T090000Z
LAST-MODIFIED:20260701T090000Z
UID:B2C3D4E5-F6A7-8B9C-0D1E-2F3A4B5C6D7E
SUMMARY:Buy milk
PRIORITY:1
STATUS:NEEDS-ACTION
X-APPLE-SORT-ORDER:706942000
END:VTODO
END:VCALENDAR
`,
);

// --- japanese-folding.ics: 日本語 SUMMARY/DESCRIPTION が UTF-8 境界付近で折れる -----
canonical(
	"japanese-folding.ics",
	String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//JP//EN
BEGIN:VEVENT
UID:JP-0001
DTSTAMP:20260701T000000Z
SUMMARY:日本語のタイトルです。これは七十五オクテットを超える長い要約なので折り畳みが発生します。
DESCRIPTION:これは説明文です。マルチバイト文字がUTF-8のオクテット境界の途中で割れないことを確認するための十分に長い日本語テキストを含んでいます。
DTSTART;TZID=Asia/Tokyo:20260715T140000
END:VEVENT
END:VCALENDAR
`,
);

// --- recurrence-override.ics: 同一 UID の master(RRULE)+ override(RECURRENCE-ID) -
canonical(
	"recurrence-override.ics",
	String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Recurrence//EN
BEGIN:VEVENT
UID:REC-0001
DTSTAMP:20260701T000000Z
DTSTART;TZID=Asia/Tokyo:20260706T090000
DTEND;TZID=Asia/Tokyo:20260706T100000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Weekly standup
END:VEVENT
BEGIN:VEVENT
UID:REC-0001
RECURRENCE-ID;TZID=Asia/Tokyo:20260713T090000
DTSTAMP:20260701T000000Z
DTSTART;TZID=Asia/Tokyo:20260713T093000
DTEND;TZID=Asia/Tokyo:20260713T103000
SUMMARY:Weekly standup (rescheduled)
END:VEVENT
END:VCALENDAR
`,
);

// --- edge-cases.ics: quoted param(; : ,)/ 複数値 / TEXT エスケープ / 空値 --------
// String.raw なので \n \, \; \\ はすべて「バックスラッシュ + 文字」の literal になる。
// これらは TEXT 値のエスケープ(§3.3.11)であり、parser は解除しない(生テキスト保持)。
canonical(
	"edge-cases.ics",
	String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Edge//EN
BEGIN:VEVENT
UID:EDGE-0001
DTSTAMP:20260701T000000Z
SUMMARY:Escapes: line1\nline2\, comma\; semi\\backslash done
DESCRIPTION:
ATTENDEE;CN="Doe, John; Jr.";MEMBER="mailto:a@x.com","mailto:b@x.com":mailto:john@example.com
X-MULTI;VALS=one,two,three:payload
X-COLON-IN-QUOTE;X-URI="http://example.com:8080/p?q=1":value
X-EMPTY:
END:VEVENT
END:VCALENDAR
`,
);

// --- lf-only.ics: LF のみ改行(寛容受理 → 冪等性テスト用)。canonicalize しない ------
raw(
	"lf-only.ics",
	"BEGIN:VCALENDAR\n" +
		"VERSION:2.0\n" +
		"PRODID:-//Test//LF//EN\n" +
		"BEGIN:VEVENT\n" +
		"UID:LF-0001\n" +
		"DTSTAMP:20260701T000000Z\n" +
		"SUMMARY:LF only line endings\n" +
		"DTSTART:20260701T090000Z\n" +
		"END:VEVENT\n" +
		"END:VCALENDAR\n",
);

console.log("fixtures generated");
