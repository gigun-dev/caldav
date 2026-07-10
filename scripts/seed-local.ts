// =============================================================================
// ローカル開発用シードスクリプト — wrangler dev の D1(--local)に検証データを流し込む
// =============================================================================
//
// 【なぜ SQL 直挿しではなく HTTP PUT でシードするのか】
// ETag は ICS バイト列の SHA-256(src/domain/caldav/values/etag.ts)であり、
// sync_changes のトークンはコレクションの syncCounter を進めながら記録される。
// これらを SQL で手計算して挿入すると、少しの改行/折り畳みのズレで ETag が
// 実サーバーの再計算とズレ、iOS 同期で「変更なしのはずが差分扱い」になる。
// よって seed は実際の PUT ユースケースを通し、ドメインロジックに ETag / sync token を
// 計算させる。おまけに「iOS が叩くのと同じ経路」を通るので dev サーバーの疎通確認も兼ねる。
//
// 【前提】`make dev`(= wrangler dev)が localhost:8787 で起動していること。
//   このスクリプト単体では D1 を触れない(wrangler dev のプロセスが D1 を握るため)。
//
// 【冪等性】同じ UID/URI に繰り返し PUT するので、何度実行しても最終状態は同じ。
//   provision は初回 PROPFIND で走る(コレクションが 0 件なら calendar/tasks を作る)。
//
// 実行: `make seed`(または `bun run scripts/seed-local.ts`)。
// 接続先やアカウントは環境変数で上書き可能(下記デフォルトは .dev.vars と wrangler.jsonc に対応)。

export {}; // top-level await を使うため ES モジュール化(TS1375 回避)。

const BASE = process.env.CALDAV_BASE ?? "http://localhost:8787";
const USER = process.env.CALDAV_USER ?? "admin"; // wrangler.jsonc vars.CALDAV_USERNAME
const PASS = process.env.CALDAV_PASS ?? "changeme"; // .dev.vars CALDAV_PASSWORD(2026-07-11 検証アカウントの値に統一)

const auth = `Basic ${btoa(`${USER}:${PASS}`)}`;
const home = `/dav/calendars/${encodeURIComponent(USER)}/`;

// --- ICS ビルダー ---------------------------------------------------------
// 最小構成の VEVENT / VTODO。DTSTAMP は固定値にして冪等性を保つ
// (現在時刻を入れると毎回 ETag が変わり「毎回差分」になってシードの意味が薄れる)。
// 固定タイムスタンプ 20260101T000000Z は「シードデータであること」がひと目で分かる値。

function vevent(uid: string, summary: string, start: string): string {
	// CRLF 必須(RFC 5545 §3.1)。折り畳みは短いので不要。
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//caldav//seed//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`DTSTART:${start}`,
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

function vtodo(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//caldav//seed//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		"STATUS:NEEDS-ACTION",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

// --- シード対象 -----------------------------------------------------------
// UID = URI(拡張子 .ics)で揃える。iOS も UID.ics のリソース名を使うことが多い。
const events = [
	{ uid: "seed-event-1", summary: "シード予定 A", start: "20260115T100000Z" },
	{ uid: "seed-event-2", summary: "シード予定 B", start: "20260116T140000Z" },
];
const todos = [
	{ uid: "seed-todo-1", summary: "シードタスク A" },
	{ uid: "seed-todo-2", summary: "シードタスク B" },
];

// --- 実行 -----------------------------------------------------------------

async function req(method: string, path: string, body?: string, extra?: Record<string, string>): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		method,
		headers: {
			authorization: auth,
			...(body ? { "content-type": "text/calendar; charset=utf-8" } : {}),
			...extra,
		},
		body,
	});
}

// 1. provision を誘発(初回 PROPFIND で calendar/tasks が作られる)。
//    depth:1 は calendar-home-set 配下を列挙する探索フェーズ。
const propfind = await req("PROPFIND", home, undefined, { depth: "1" });
if (propfind.status !== 207) {
	console.error(`provision 失敗: PROPFIND ${home} -> ${propfind.status}`);
	console.error("wrangler dev が起動しているか / 認証情報が合っているか確認してください。");
	process.exit(1);
}
console.log(`✓ provision OK (PROPFIND ${home} -> 207)`);

// 2. VEVENT を calendar/ に PUT。
for (const e of events) {
	const res = await req("PUT", `${home}calendar/${e.uid}.ics`, vevent(e.uid, e.summary, e.start));
	// 201=新規 / 204=更新(再実行時)。どちらも成功。
	const ok = res.status === 201 || res.status === 204;
	console.log(`${ok ? "✓" : "✗"} PUT calendar/${e.uid}.ics -> ${res.status}`);
	if (!ok) console.error(await res.text());
}

// 3. VTODO を tasks/ に PUT。
for (const t of todos) {
	const res = await req("PUT", `${home}tasks/${t.uid}.ics`, vtodo(t.uid, t.summary));
	const ok = res.status === 201 || res.status === 204;
	console.log(`${ok ? "✓" : "✗"} PUT tasks/${t.uid}.ics -> ${res.status}`);
	if (!ok) console.error(await res.text());
}

console.log(`\nシード完了: ${events.length} events / ${todos.length} todos @ ${BASE}${home}`);
