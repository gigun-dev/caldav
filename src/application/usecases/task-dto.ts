// =============================================================================
// task-dto — Task DTO(E-2 UI-ready・全 todo 系ユースケース共通)
// =============================================================================
//
// 【この DTO の位置づけ】
// CreateTodo / ListTodos(E-1 スライス①)が共に返す出力の形。将来の CompleteTodo/UpdateTodo/
// DeleteTodo(スライス②以降)も同じ Task 形を使う想定なので、application 層内の共有モジュールに
// 切り出す(UC ごとに同じ変換ロジックを重複させない)。
//
// 【日時整形をここで持つ理由(presentation/mcp/format.ts を import しない)】
// 仕様上は「日時整形は format.ts 流用」という指示があったが、format.ts は
// src/presentation/mcp/format.ts に置かれており、application → presentation の import は
// 依存の向きが逆(オニオンアーキテクチャ違反。CI の層境界チェックにも引っかかる)。
// よってロジックは流用しつつ、実体はこのファイルにコピーして application 層内に閉じる
// (中身は format.ts の epochToIso/formatDateOnly と同じ計算— offset 付き ISO8601 組み立て・
// IANA ゾーンでの現地日付抽出。二重実装ではあるが、10行強の純関数で「意味のある共有」より
// 「層境界の健全性」を優先した判断。将来 domain/ical/timezone 配下に格上げしてもよい)。
// =============================================================================

import type { VTodo } from "../../domain/ical/semantics";
import type { CalDate, CalDateTime, Frequency, RecurrenceRule } from "../../domain/ical/values";
import { decodeText, InvalidValueError } from "../../domain/ical/values";
import { calDateStartEpochMillis, calDateTimeToEpochMillis, getZoneOffsetMillis } from "../../domain/ical/timezone";

// CalDate | CalDateTime の判別。semantics/helpers.ts の isCalDateTime は semantics/index.ts の
// 公開 API に含まれていない(意図的に内部ヘルパー扱い)ため、mcp/server.ts の
// list-events-expanded と同じ判定手法(CalDateTime だけが持つ "kind" フィールドの有無)を
// ここでも踏襲する(ical/index.ts の「index 経由でのみ import」方針を守りつつ、
// 新しい公開 API を増やさずに済ませる)。
function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/** MCP/将来 REST から共通で返す todo の表現(方向性 E-2 の UI-ready DTO 合意)。 */
export interface Task {
	id: string;
	title: string;
	completed: boolean;
	/** STATUS の生値(NEEDS-ACTION/COMPLETED/IN-PROCESS/CANCELLED 等)。未設定は null。 */
	status: string | null;
	/** "YYYY-MM-DD"(終日)または ISO8601(時刻付き)。DUE 無しは null。 */
	due: string | null;
	/** due が VALUE=DATE(終日)かどうか。due が null のときは false。 */
	isAllDay: boolean;
	/** PRIORITY(0-9)。未設定(プロパティ無し)は 0 として返す(§3.8.1.9 の「0=未定義」に合わせる)。 */
	priority: number;
	/** PERCENT-COMPLETE(0-100)。未設定は null。 */
	percentComplete: number | null;
	/** COMPLETED(完了時刻)。ISO8601(UTC MUST なので常に "...Z")。未設定は null。 */
	completedAt: string | null;
	/** DESCRIPTION。未設定は null。 */
	notes: string | null;
	/**
	 * X-APPLE-SORT-ORDER(Apple 拡張・INTEGER)。E-1 スライス②-a で追加。stampCreate が
	 * CFAbsoluteTime(2001-01-01 UTC 起点秒)で書き込む値をそのまま読み戻す(vtodo-stamp.ts
	 * 参照)。iOS 実機の並び順と一致させるための値なので、意味解釈(逆算して Date に戻す等)は
	 * せず生の INTEGER を渡す。未設定・不正値(NaN)は null。
	 */
	sortOrder: number | null;
	/**
	 * LOCATION(§3.8.1.7)。TEXT なので title/notes と同じく decodeText して意味的文字列で返す
	 * (このファイル冒頭「既存 MCP ツールとの差」コメント参照 — Task DTO は decodeText 統一)。
	 * 未設定は null。
	 *
	 * 【2026-07-14 E-2 追記: iOS の「指定した場所で通知」とは別物】
	 * iOS リマインダーの位置情報通知(ジオフェンス)は CloudKit 独自機能で CalDAV には同期
	 * されない見込み(docs/modeling/06 §D2/D3 の天井群と同種 — iOS 実機検証で確認済みの限界)。
	 * つまりこのフィールドが埋まるのは主に「他の CalDAV クライアントが書いた LOCATION」や
	 * 「本サーバーの create-todo 等 自前の書き込み経路で入れた LOCATION」であり、iOS 標準アプリの
	 * 位置情報リマインダー UI から来るものではない。VTODO の LOCATION 自体は §3.6.2 で許可された
	 * 標準プロパティなので、DTO としては素直に読めるようにしておく(iOS の機能的な限界と
	 * プロトコル上の可否は別レイヤー)。
	 */
	location: string | null;
	/**
	 * RRULE(§3.3.10)の要約。create-todo の CreateTodoRecurrenceInput(chat 語彙: daily/weekly/
	 * monthly/yearly)と**同じ語彙**で返す(入口と出口の形を揃える設計判断 — UI 側が create 時と
	 * 同じ形をそのまま再送できるようにするため)。RRULE 無し(VTODO が非反復)は null。
	 *
	 * 【フィールドの意味】
	 *   - frequency: 通常は "daily"|"weekly"|"monthly"|"yearly"(chat 語彙)。degrade 時は例外的に
	 *     生値が入ることがある(下記2ケース。formatRecurrence 参照)。
	 *   - interval: INTERVAL。RRULE に未指定でも RFC の既定値 1 を補完して返す(UI-ready の観点。
	 *     due と違い「省略時の意味」が既定値 1 で確定しているので、null にせず補完した方が
	 *     UI 側の分岐が減る)。
	 *   - weekdays: BYDAY を weekday コード(例 "MO"）または序数付き文字列(例 "2MO"）の配列で。
	 *     序数は create-todo の入力語彙には無い(weekly 限定・序数なし)が、他クライアント由来の
	 *     RRULE(例 FREQ=MONTHLY;BYDAY=2MO)を握りつぶさずロスレスに返すため出力側では許容する
	 *     (下記 degrade 方針と同じ「読めるものは読めるまま返す」の一環)。BYDAY 無しは null。
	 *   - count: COUNT。未指定は null(interval と違い「省略時の既定値」が無い rule-part なので
	 *     null が自然)。
	 *   - until: UNTIL。DATE なら "YYYY-MM-DD"、DATE-TIME なら offset 付き ISO8601(due と同じ
	 *     整形方針 — 人間可読文への整形[「毎週 月・水」等]は UI/表示層の仕事であり DTO ではやらない
	 *     判断。ISO/日付文字列のまま渡す)。未指定は null。
	 *
	 * 【degrade 方針(パース不能/chat 語彙外の FREQ を握りつぶさない)】
	 *   1. RRULE 自体が構文的に不正(他クライアントの書き込み、または手動編集等)で
	 *      parseRecurrenceRule が InvalidValueError を投げるケース: 例外を握りつぶして黙って
	 *      null を返すと「実は反復設定があるのに DTO 上は非反復に見える」という不整合になり
	 *      危険(iOS 側は反復として保持しているのに UI が見せない)。よって frequency に RRULE の
	 *      生値をそのまま入れ、他フィールドは安全側の既定(interval:1, weekdays/count/until:null)
	 *      にして「反復設定はあるが構造化できなかった」ことを可視化する。
	 *   2. RRULE は正しくパースできたが FREQ が chat 語彙に無い(SECONDLY/MINUTELY/HOURLY —
	 *      create-todo が受け付けない3値): 同じ理由で frequency に RRULE の生 FREQ(大文字のまま)
	 *      を入れる。存在しない chat 語彙にでっち上げて丸めるより、区別可能な生値を返す方が安全。
	 */
	recurrence: {
		frequency: string;
		interval: number;
		weekdays: string[] | null;
		count: number | null;
		until: string | null;
	} | null;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

// presentation/mcp/format.ts の epochToIso と同じ計算(ファイル冒頭コメントの層境界判断により複製)。
function epochToIsoLocal(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	const wall = new Date(millis + offsetMillis);
	const datePart =
		`${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
		`T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}`;
	if (offsetMillis === 0) return `${datePart}Z`;
	const sign = offsetMillis < 0 ? "-" : "+";
	const absMinutesTotal = Math.round(Math.abs(offsetMillis) / 60000);
	return `${datePart}${sign}${pad2(Math.floor(absMinutesTotal / 60))}:${pad2(absMinutesTotal % 60)}`;
}

// CalDate(VALUE=DATE)は「その日付そのもの」を返せばよく、タイムゾーンでの現地化は不要
// (formatDateOnly はエポックミリ秒からゾーンで日付を逆算するためのものだが、CalDate は
// そもそも年月日フィールドを直接持っているので、ここでは素直にフィールドから組み立てる)。
function formatCalDateAsIso(d: CalDate): string {
	return `${d.year.toString().padStart(4, "0")}-${pad2(d.month)}-${pad2(d.day)}`;
}

/**
 * due(CalDate | CalDateTime)を Task.due の表現に変換する。
 * @param zoneOf zoned の TZID → IANA 名の解決(zoneResolverFor で組み立てたものを渡す)。
 * @param timeZone floating な DATE-TIME の既定解釈に使う応答基準ゾーン。zoned/utc の due には
 *   使わない(下記「各 todo 自身のゾーンで整形する」判断を参照)。
 *
 * 【2026-07-13 E-2 スライス①: 時刻付き due は「その todo 自身のゾーン」で整形する(00:00 問題の根治)】
 * 旧実装は time-of-day な due を常に引数 timeZone(list-todos の既定は UTC)で offset ISO に
 * 整形していた。その結果「DTSTART;TZID=Asia/Tokyo の 09:00 タスク」が list-todos(timeZone 未指定)
 * では UTC 整形されて "2026-07-14T00:00:00Z"(= JST 09:00 の UTC 表現)になり、UI が素直に描画すると
 * 「00:00」に見える(= 00:00 問題)。
 *
 * 真実は「iOS 実機が壁時計 09:00 + TZID=Asia/Tokyo で持っているタスク」であり、iOS の表示も 09:00。
 * サーバーが返す truth surface もこれに一致させるべき。zoned な due はそれ自身が TZID を持って
 * いるのだから、応答基準の timeZone(表示の都合)ではなく、その todo 自身のゾーンで整形するのが
 * ドメイン的に正しい(表示 TZ という presentation の都合と、UTC+TZID という真実を分離する)。
 * よって zoned → zoneOf(tzid) の壁時計で offset ISO を組み立てる(例 "2026-07-14T09:00:00+09:00")。
 *
 * これは create-todo が既に返している形(自ゾーン offset ISO。create-todo は input.timeZone を
 * そのまま渡していたので偶然一致していた)とも整合し、全 todo 系ユースケースで due 整形が一貫する。
 *
 * kind ごとの表示ゾーン:
 *   - zoned : zoneOf(due.tzid)(その todo 自身の IANA ゾーン)。
 *   - utc   : "UTC"(明示 UTC。"...Z" になる)。
 *   - floating: 引数 timeZone(floating は自前のゾーンを持たないため、応答基準ゾーンで解釈する
 *     しかない — resolver.ts の「floating は floatingTimeZone 明示で解釈、暗黙 UTC 禁止」原則に沿う。
 *     list-todos が timeZone 未指定なら UTC になるが、floating な DATE-TIME を持つ VTODO は iOS では
 *     生成されない[必ず TZID 付き]ので実運用ではほぼ通らない経路。ロスレスに UTC 明示で倒す)。
 */
function formatDue(
	due: CalDate | CalDateTime,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): { due: string; isAllDay: boolean } {
	if (!isCalDateTime(due)) {
		return { due: formatCalDateAsIso(due), isAllDay: true };
	}
	// epoch への変換は従来どおり(floating の既定解釈にだけ timeZone を使う)。真実の瞬間は
	// kind に関わらず一意に定まる。
	const millis = calDateTimeToEpochMillis(due, { zoneOf, floatingTimeZone: timeZone });
	// 表示ゾーンは「その todo 自身のゾーン」を優先する(上記コメント参照)。zoned だけが自前の
	// TZID を持つので、そこは zoneOf で IANA 名に解決する。utc/floating は自ゾーンが無いので
	// それぞれ UTC / 応答基準 timeZone にフォールバックする。
	const displayZone = due.kind === "zoned" ? zoneOf(due.tzid) : due.kind === "utc" ? "UTC" : timeZone;
	return { due: epochToIsoLocal(millis, displayZone), isAllDay: false };
}

// create-todo.ts の FREQUENCY_MAP(chat 語彙 → RRULE FREQ)の逆引き。あちらを直接 import せず
// ここに複製する(create-todo.ts は CreateTodo 固有の入力検証・エラー型を大量に抱えたファイルで、
// DTO 変換という無関係な関心のために import すると依存が不自然に絡む。4値の定数マップなので
// 複製コストは小さい — epochToIsoLocal と同じ「層/関心の分離を値の重複より優先する」判断)。
// SECONDLY/MINUTELY/HOURLY は chat 語彙に無い(create-todo が受け付けないので対称な逆引きが
// 無い)。Partial にして「無ければ undefined」を素直に表現する。
const FREQUENCY_TO_CHAT_VOCAB: Partial<Record<Frequency, string>> = {
	DAILY: "daily",
	WEEKLY: "weekly",
	MONTHLY: "monthly",
	YEARLY: "yearly",
};

// RecurrenceRule["byDay"] の1要素(WeekdayNum)を DTO 用の文字列に整形する。
// values/recurrence-rule.ts の formatWeekdayNum と同じロジックだが非公開関数なので複製する
// (公開 API を1つ増やすより、6行の純関数を複製する方が values 層の表面を汚さずに済む)。
function formatWeekdayNumForDto(d: { ordinal?: number; weekday: string }): string {
	return d.ordinal !== undefined ? `${d.ordinal}${d.weekday}` : d.weekday;
}

// RecurrenceRule["until"](RecurUntil)を Task.recurrence.until の表現に変換する。due と同じ
// 整形方針(DATE はそのまま日付文字列、DATE-TIME は offset 付き ISO8601)。
function formatRecurUntilForDto(
	until: NonNullable<RecurrenceRule["until"]>,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): string {
	if (until.type === "date") {
		return formatCalDateAsIso(until.date);
	}
	// RecurUntil の date-time は utc|floating のみ(zoned は RECUR 値の文法上あり得ない。
	// recurrence-rule.ts の RecurUntil 型コメント参照)。表示ゾーンは due の floating と同じ扱い
	// (自前のゾーンを持たないので応答基準 timeZone にフォールバック)。
	const millis = calDateTimeToEpochMillis(until.dateTime, { zoneOf, floatingTimeZone: timeZone });
	const displayZone = until.dateTime.kind === "utc" ? "UTC" : timeZone;
	return epochToIsoLocal(millis, displayZone);
}

/**
 * VTodo の RRULE を Task.recurrence に変換する。degrade 方針は Task.recurrence の JSDoc 参照。
 *
 * vtodo.rrule は VTodo レンズの getter で、RRULE が構文的に不正だと parseRecurrenceRule が
 * 投げる InvalidValueError をそのまま re-throw する(getter 自身はキャッチしない実装 — vtodo.ts
 * 参照)。DTO 変換はロスレス・非破壊を優先するユースケース群(list/complete/update/delete の
 * before スナップショット含む)から呼ばれるため、ここで例外を握りつぶさず catch して
 * degrade 表現に倒す(呼び出し元まで例外を伝播させると「他クライアントが書いた壊れた RRULE を
 * 持つ VTODO が1件でもあると list-todos 全体が 500 になる」という壊れ方をしてしまうため、
 * DTO 層で吸収するのが正しい責務分担と判断)。
 */
function formatRecurrence(vtodo: VTodo, zoneOf: (tzid: string) => string, timeZone: string): Task["recurrence"] {
	let rule: RecurrenceRule | undefined;
	try {
		rule = vtodo.rrule;
	} catch (err) {
		if (!(err instanceof InvalidValueError)) throw err; // 想定外の例外種別は握りつぶさない。
		// degrade ケース1(JSDoc 参照): 生の RRULE 値をそのまま frequency に入れて可視化する。
		const rawRrule = vtodo.raw.properties.find((p) => p.name === "RRULE")?.value ?? "";
		return { frequency: rawRrule, interval: 1, weekdays: null, count: null, until: null };
	}
	if (rule === undefined) return null; // RRULE 無し = 非反復。

	// degrade ケース2(JSDoc 参照): chat 語彙に無い FREQ(SECONDLY/MINUTELY/HOURLY)は生値のまま。
	const frequency = FREQUENCY_TO_CHAT_VOCAB[rule.freq] ?? rule.freq;

	return {
		frequency,
		interval: rule.interval ?? 1, // RFC 既定値 1 を補完(Task.recurrence の JSDoc 参照)。
		weekdays: rule.byDay !== undefined ? rule.byDay.map(formatWeekdayNumForDto) : null,
		count: rule.count ?? null,
		until: rule.until !== undefined ? formatRecurUntilForDto(rule.until, zoneOf, timeZone) : null,
	};
}

/**
 * VTodo レンズ(読み取り専用)から Task DTO を組み立てる。
 * @param zoneOf zoned な DUE の TZID 解決。呼び出し側が zoneResolverFor(icalendarObject) で作る。
 * @param timeZone 応答基準ゾーン(list-todos の timeZone フィールド相当)。省略時は UTC。
 *   time-of-day な zoned due は「その todo 自身の TZID」で整形するので、この引数は zoned due の
 *   表示には使わない(floating due の既定解釈と、UI 側の相対判定[今日/期限切れ]の基準としてのみ
 *   意味を持つ — formatDue のコメント参照)。completedAt は §3.8.2.1 で UTC MUST なので常に UTC 整形。
 */
export function taskFromVTodo(
	vtodo: VTodo,
	zoneOf: (tzid: string) => string = (tzid) => tzid,
	timeZone = "UTC",
): Task {
	const due = vtodo.due;
	const dueOut = due !== undefined ? formatDue(due, zoneOf, timeZone) : null;

	const completed = vtodo.completed;
	// COMPLETED は §3.8.2.1 で UTC DATE-TIME MUST。vtodo.completed の型は due と同じ
	// CalDate|CalDateTime の union(vtodo.ts のアクセサ定義。COMPLETED が DATE 形態を
	// 取ることは RFC 上ありえないが、型としては union のまま公開されている)。
	// 万一 CalDate や utc 以外の CalDateTime が来ても、ここでは落とさず(ロスレス優先)
	// isCalDateTime の分岐で吸収する — CalDate は「その日の 00:00」として扱う。
	const completedAt = completed === undefined
		? null
		: isCalDateTime(completed)
			? epochToIsoLocal(calDateTimeToEpochMillis(completed, { zoneOf, floatingTimeZone: "UTC" }), "UTC")
			: epochToIsoLocal(calDateStartEpochMillis(completed, "UTC"), "UTC");

	// DESCRIPTION(§3.8.1.5)。VTodo レンズに型付きアクセサが無いため(vtodo.ts は summary は
	// 持つが description は今回未追加 — 既存ファイルを変更しない方針のため raw から直接読む)、
	// raw Component から取得して decodeText でエスケープ解除する(TEXT 値のデコードは
	// values/text-value.ts の責務。semantics 層のレンズと同じやり方 — rawValue 相当を自前で書く)。
	const descriptionProp = vtodo.raw.properties.find((p) => p.name === "DESCRIPTION");
	const notes = descriptionProp !== undefined ? decodeText(descriptionProp.value) : null;

	// X-APPLE-SORT-ORDER。VTodo レンズに型付きアクセサが無い(vtodo.ts は既存ファイルを変更
	// しない方針のため raw から直接読む — DESCRIPTION と同じやり方)。parseInt が NaN を返す
	// (プロパティ無し、または不正な値)場合は null にする(ロスレス優先: 例外にはしない)。
	const sortOrderProp = vtodo.raw.properties.find((p) => p.name === "X-APPLE-SORT-ORDER");
	const parsedSortOrder = sortOrderProp !== undefined ? Number.parseInt(sortOrderProp.value, 10) : Number.NaN;
	const sortOrder = Number.isNaN(parsedSortOrder) ? null : parsedSortOrder;

	// LOCATION(§3.8.1.7)。vtodo.location(このタスクで追加したレンズアクセサ)は raw のまま
	// 返すので、notes と同じく decodeText で意味的文字列に復元する(Task.location の JSDoc 参照)。
	const location = vtodo.location !== undefined ? decodeText(vtodo.location) : null;

	// RRULE 要約。formatRecurrence 参照(degrade 方針含む)。
	const recurrence = formatRecurrence(vtodo, zoneOf, timeZone);

	// 【既存 MCP ツール(list-events-expanded)との差: title/notes は decodeText する】
	// vtodo.summary(既存レンズ)は Property.value の生テキスト(エスケープ済み)をそのまま返す
	// (semantics 層の一貫方針。list-events-expanded の component.summary も同じく raw のまま
	// 応答に出している)。しかし Task DTO は「E-2 UI-ready」— chat UI にそのまま出す前提の
	// 表現なので、SUMMARY\, with\, commas のような生テキストを見せるのはユーザー体験として
	// 誤り。CreateTodo が encodeText で書き込んだ意味的文字列と対称になるよう、Task.title/notes
	// はここで decodeText して意味的文字列に復元する(既存ツールの表面とは非対称になるが、
	// 「新しい DTO 形は意味的文字列」という E-2 の合意を優先する)。
	return {
		id: vtodo.uid ?? "",
		title: vtodo.summary !== undefined ? decodeText(vtodo.summary) : "",
		completed: vtodo.status === "COMPLETED",
		status: vtodo.status ?? null,
		due: dueOut?.due ?? null,
		isAllDay: dueOut?.isAllDay ?? false,
		priority: vtodo.priority ?? 0,
		percentComplete: vtodo.percentComplete ?? null,
		completedAt,
		notes,
		sortOrder,
		location,
		recurrence,
	};
}

// calDateStartEpochMillis は現状 taskFromVTodo から直接は使わない(due の DATE 表現は
// formatCalDateAsIso で十分)。ListTodos の dueBefore/dueAfter フィルタ(list-todos.ts)が
// 「DATE の due をエポックへ変換して比較する」ために同じ変換が要るため、ここから re-export して
// 二重実装を避ける。
export { calDateStartEpochMillis, calDateTimeToEpochMillis };
