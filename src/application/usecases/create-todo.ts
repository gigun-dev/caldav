// =============================================================================
// CreateTodo ユースケース — 方向性 E-1 スライス①(MCP からの VTODO 作成)
// =============================================================================
//
// 【この UC が担う範囲】
// chat(MCP `create-todo` ツール)から VTODO を新規作成する。UID/DTSTAMP はサーバーが
// 生成し、domain/ical/semantics/vtodo-write.ts の buildVTodoCalendar で VCALENDAR+VTODO の
// Component ツリーを組み、serialize() で ICS 化してから、既存の PutCalendarObject を
// must-not-exist(If-None-Match:* 相当)で呼ぶ。**独自の保存経路は作らない**
// (PutCalendarObject が担う precondition 検証・ETag 計算・occurrence bounds 索引・
// コレクション変更ログ更新を再実装しないため。CLAUDE.md 長期ビジョン1「MCP/REST/メール
// ハンドラなど複数の入口から呼べる形」の実例そのもの — CreateTodo は DAV PUT の薄いラッパー)。
//
// 【なぜ PutCalendarObject を「合成」するのか(DI の形)】
// このユースケースは PutCalendarObject の完成品インスタンスをコンストラクタで受け取る
// (collectionRepo/resourceRepo/uow/recurrenceIterator を再度バラで受け取らない)。
// 理由: PutCalendarObject 自身が「4つのポートから何を組み立てるか」を知っていればよく、
// CreateTodo はそれを知る必要がない(依存を1段畳んでカプセル化する = 呼び出し側
// (MCP サーバーのファクトリ)の組み立てコードが素直になる)。
//
// 【UID/DTSTAMP の生成方式(Clock/IdGenerator port は導入しない判断)】
// 既存コードベースを調査した結果、UID 生成・現在時刻取得に共通の port
// (Clock/IdGenerator インターフェース)は存在しなかった(grep 済み)。よってこの UC でも
// 素直に `crypto.randomUUID()` と `new Date()` を直接呼ぶ。Workers ランタイムは両方とも
// 標準 Web API として提供しており、テスト時の決定性が必要になったら
// (例: DTSTAMP の往復一致を厳密に検証したいテスト)呼び出し結果を正規表現で緩く検証すれば
// 足りる規模。ここで新しい port を1つ増やすのは、既存の設計慣行から外れる割に得られる
// 価値(テスト容易性)が小さいと判断した(YAGNI。他の UC が port 化する必要に迫られたら
// そのとき一括で導入する)。
// =============================================================================

import {
	buildVTimezone,
	buildVTodoCalendar,
	ICalendarObject,
	isValidIanaZone,
	localFieldsToEpochMillis,
	parseCalDate,
	recurrenceRule,
	serialize,
	toEpochMillis,
	UnsupportedTimeZoneError as DomainUnsupportedTimeZoneError,
	zoneResolverFor,
	type CalDateTime,
	type Component,
	type Frequency,
	type RecurrenceRule,
	type VTodoFields,
	type Weekday,
} from "../../domain/ical";
import { collectionId as mkCollectionId, type PrincipalRef } from "../../domain/caldav";
import { PutCalendarObject, type PutCalendarObjectError } from "./put-calendar-object";
import type { Task } from "./task-dto";
import { taskFromVTodo } from "./task-dto";
import { nowStampFromDate } from "./now-stamp";

// 反復ホライズン・VTIMEZONE 窓の余白(V6)。§3.6.5 の VTIMEZONE は「特定の瞬間に妥当な
// オフセットを説明できればよい」定義なので、本来は due(および UNTIL)の瞬間だけプロービング
// できれば足りるが、境界(月末・年末・タイムゾーンのオフセット改定日)ちょうどに当たった
// ケースを安全側に倒すため前後に余白を持たせる(400日 = 1年+1ヶ月強。DST 検出
// プロービング=zoneHasOffsetTransitions の stepDays=10 に対して十分粗くない幅)。
const WINDOW_MARGIN_MILLIS = 400 * 24 * 60 * 60 * 1000;

// --- 入力 DTO ---

export interface CreateTodoInput {
	owner: PrincipalRef;
	/** SUMMARY(必須)。空文字は許可しない判断は zod 側(presentation)で先に弾く想定だが、
	 *  domain の buildVTodoCalendar 自体は空文字も許容する(VTODO の SUMMARY は RFC 上 OPTIONAL
	 *  かつ空 TEXT も文法上不正ではないため、UC 層で余計な制約を足さない)。 */
	title: string;
	/** DESCRIPTION。省略可。 */
	notes?: string;
	/**
	 * 期日。2形態をサポートする(V6 で時刻付きに対応):
	 *   - "YYYY-MM-DD"(終日)
	 *   - "YYYY-MM-DDTHH:MM:SS"(時刻付き・offset 無しの壁時計。timeZone と組で解釈する)
	 * offset 付き ISO8601("...+09:00"/"...Z")は**受け付けない**(下記 InvalidDueError の
	 * コメント参照 — TZID を導出できず iOS の壁時計モデルと不整合になるため)。
	 */
	due?: string;
	/**
	 * due が時刻付き("YYYY-MM-DDTHH:MM:SS")のときの IANA タイムゾーン(必須)。
	 * DTSTART;TZID=.../DUE;TZID=... とサーバー生成 VTIMEZONE の両方に使う。終日 due
	 * または due 省略時は無視する。暗黙 UTC フォールバックはしない(resolver 層の既存原則
	 * どおり — timezone/resolver.ts の「暗黙フォールバック禁止」コメント参照)。
	 */
	timeZone?: string;
	/** PRIORITY(§3.8.1.9)。0-9。省略時はプロパティを立てない(未設定)。 */
	priority?: number;
	/** 保存先コレクション ID。省略時は "tasks"(provision-default-collections.ts の既定 VTODO コレクション)。 */
	calendarId?: string;
	/**
	 * 反復指定(タスク③)。MCP `create-todo` の chat 語彙(iOS リマインダーの繰り返し UI に
	 * 合わせた素朴な形)をそのまま受け取り、この UC 内でドメインの RecurrenceRule に変換する
	 * (変換・不変条件検証をこの UC に集約する設計判断。下の buildRecurrenceRule 参照)。
	 * 指定時は due が必須(RRULE は DTSTART をアンカーにするため — RecurrenceRequiresDueError)。
	 */
	recurrence?: CreateTodoRecurrenceInput;
}

/** MCP `create-todo` の recurrence 入力(zod 前段は presentation 層が担う。ここは素朴な形のまま)。 */
export interface CreateTodoRecurrenceInput {
	frequency: "daily" | "weekly" | "monthly" | "yearly";
	/** INTERVAL(§3.3.10)。省略時は RRULE に INTERVAL を出さない(既定 1 を補完しない。ロスレス方針)。 */
	interval?: number;
	/** BYDAY(序数無し)。weekly でのみ有効(下記バリデーション参照)。 */
	weekdays?: readonly Weekday[];
	/** COUNT(§3.3.10)。until と排他。 */
	count?: number;
	/** UNTIL を "YYYY-MM-DD" で指定。count と排他。DATE 型で RRULE に出す(下記コメント参照)。 */
	until?: string;
}

// --- 出力 DTO ---

export interface CreateTodoOutput {
	task: Task;
}

// --- エラー型 ---

/**
 * due が受理可能な2形態("YYYY-MM-DD" / "YYYY-MM-DDTHH:MM:SS")のどちらにも一致しなかった
 * ときのエラー。
 * 【2026-07-13 V6 更新: offset 付き ISO8601 を明示的に拒否する理由】
 * "...+09:00"/"...Z" のような offset 付き ISO8601 を許すと「offset からタイムゾーンを
 * 一意に逆引きできない」問題にぶつかる(+09:00 は Asia/Tokyo にも Asia/Jayapura にもなりうる)。
 * DTSTART;TZID=... には IANA ゾーン名(TZID)が要るので、offset だけでは復元できない。
 * iOS も壁時計 + TZID のモデルで DTSTART/DUE を送ってくる(実機キャプチャ
 * real-ios/vtodo-recurring-master.ics)ので、その形(壁時計 + 別引数 timeZone)を要求する方が
 * 素直。よって offset 付き ISO8601 は形式エラーとして拒否し、"YYYY-MM-DDTHH:MM:SS"
 * (offset 無し壁時計)+ timeZone 引数の組を要求する。
 */
export class InvalidDueError extends Error {
	readonly kind = "InvalidDueError" as const;
	constructor(readonly due: string) {
		super(
			'due must be "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM:SS" (timed, paired with timeZone). ' +
				`Offset ISO8601 (e.g. with "Z" or "+09:00") is not accepted — a TZID cannot be derived from an offset alone: "${due}"`,
		);
		this.name = "InvalidDueError";
	}
}

/**
 * due が時刻付き("YYYY-MM-DDTHH:MM:SS")なのに timeZone が省略されたときのエラー。
 * 【暗黙 UTC フォールバック禁止】timezone/resolver.ts と同じ原則(Home Assistant の
 * 「終日イベントが EST で前日 20 時開始」型の事故を避ける)を CreateTodo の入力検証でも守る。
 */
export class DueTimeZoneRequiredError extends Error {
	readonly kind = "DueTimeZoneRequiredError" as const;
	constructor(readonly due: string) {
		super(`due "${due}" is time-of-day; timeZone is required (no implicit UTC fallback)`);
		this.name = "DueTimeZoneRequiredError";
	}
}

/** timeZone が IANA タイムゾーン名として無効だったときのエラー(isValidIanaZone が false)。 */
export class InvalidTimeZoneError extends Error {
	readonly kind = "InvalidTimeZoneError" as const;
	constructor(readonly timeZone: string) {
		super(`timeZone is not a valid IANA time zone name: "${timeZone}"`);
		this.name = "InvalidTimeZoneError";
	}
}

/**
 * timeZone が DST(夏時間)遷移を持つゾーンで、VTIMEZONE 生成(Phase 1)が対応できないときの
 * エラー。domain 層の timezone/errors.ts UnsupportedTimeZoneError をこの application 層の
 * kind タグ付き型に写像する(他のエラーと同じ instanceof 判別の一貫性のため。domain の例外を
 * そのまま MCP まで素通りさせない — 既存の InvalidDueError 等と同じ扱い)。
 */
export class UnsupportedTimeZoneError extends Error {
	readonly kind = "UnsupportedTimeZoneError" as const;
	constructor(readonly timeZone: string) {
		super(
			`timeZone "${timeZone}" has DST offset transitions; server-generated VTIMEZONE (Phase 1) ` +
				"supports fixed-offset zones only (e.g. Asia/Tokyo). DST zones (e.g. America/New_York) are not yet supported.",
		);
		this.name = "UnsupportedTimeZoneError";
	}
}

/**
 * recurrence を指定したのに due が無いときのエラー。
 * 【設計判断】RRULE は DTSTART をアンカーにする(§3.8.5.3)ので、我々の実装(due が
 * DTSTART/DUE の値そのもの)では due 無しに RRULE だけ立てることができない。zod では
 * 「他のフィールドの有無」を跨いだ相関チェックが冗長になりがちなので、application 層で
 * 明示的にエラーにする(InvalidDueError と型を分けたのは、原因が「due の形式」ではなく
 * 「due の不在」であることをメッセージ・catch 分岐の両方で区別できるようにするため)。
 */
export class RecurrenceRequiresDueError extends Error {
	readonly kind = "RecurrenceRequiresDueError" as const;
	constructor() {
		super("recurrence requires due (RRULE needs a DTSTART anchor); specify due together with recurrence");
		this.name = "RecurrenceRequiresDueError";
	}
}

/**
 * count と until を両方指定したときのエラー。
 * 【RFC 根拠】§3.3.10 recur ABNF のコメント「The UNTIL or COUNT rule parts are OPTIONAL,
 * but they MUST NOT occur in the same 'recur'.」(I5)。recurrence-rule.ts の recurrenceRule()
 * も同じ不変条件を検証するが、ここで早期に弾いて MCP ツール利用者にわかりやすいメッセージを
 * 返す(recurrenceRule() 側のメッセージは values 層向けの汎用文言のため)。
 */
export class RecurrenceCountUntilConflictError extends Error {
	readonly kind = "RecurrenceCountUntilConflictError" as const;
	constructor() {
		super("recurrence.count and recurrence.until must not both be specified (RFC 5545 I5)");
		this.name = "RecurrenceCountUntilConflictError";
	}
}

/**
 * weekly 以外の frequency に weekdays を指定したときのエラー。
 * 【設計判断(安全側を選ぶ)】RFC 5545 §3.3.10 は BYDAY を monthly/yearly でも許容するが、
 * それは「序数付き BYDAY」(例 2MO, -1SU)としての用法であり、序数無し BYDAY(例 "MO"だけ)を
 * monthly/yearly に付けたときの意味は曖昧(「毎月の月曜すべて」等、複数 occurrence/期間に
 * 展開されうる)。一方 weekly の序数無し BYDAY は「その週の指定曜日」という一義的な意味を持つ
 * (recurrence-rule.ts の I 系検証も序数付き BYDAY を monthly/yearly 限定にしているだけで、
 * 序数無し BYDAY を weekly 限定とはしていない=values 層は通してしまう)。chat からの
 * ゼロ知識入力でこの曖昧さを黙って解釈するより、weekly 限定に絞って明示的にエラーにする方が
 * 安全側(誤った反復パターンを黙って作ってしまうより、失敗して再入力を促す方がまし)と判断した。
 * monthly/yearly の曜日指定(序数付き BYDAY)が必要になったら、そのとき専用の入力語彙を
 * 別途設計する(YAGNI)。
 */
export class RecurrenceWeekdaysRequireWeeklyError extends Error {
	readonly kind = "RecurrenceWeekdaysRequireWeeklyError" as const;
	constructor(readonly frequency: string) {
		super(`recurrence.weekdays is only valid when frequency is "weekly", got "${frequency}"`);
		this.name = "RecurrenceWeekdaysRequireWeeklyError";
	}
}

export type CreateTodoError =
	| InvalidDueError
	| DueTimeZoneRequiredError
	| InvalidTimeZoneError
	| UnsupportedTimeZoneError
	| RecurrenceRequiresDueError
	| RecurrenceCountUntilConflictError
	| RecurrenceWeekdaysRequireWeeklyError
	| PutCalendarObjectError;

// YYYY-MM-DD の厳密マッチ(終日 due)。値の実在性チェックは domain の calDate ファクトリに委ねる。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DDTHH:MM:SS の厳密マッチ(時刻付き due・offset 無しの壁時計。V6)。
// offset 付き("Z"/"+09:00" 等)はこの正規表現に一致しない = InvalidDueError で弾かれる
// (InvalidDueError のコメントに理由を明記)。
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * epoch ミリ秒 → VALARM TRIGGER / RRULE UNTIL 用の UTC 生値("YYYYMMDDTHHMMSSZ")。
 * 【now-stamp.ts の nowStampFromDate と同じ組み立て手法】対象が「今」ではなく「特定の
 * epoch」である点だけが違う。あちらは NowStamp{utcRaw, unixSeconds} という別の型
 * (X-APPLE-SORT-ORDER 用の unixSeconds を含む)を返す契約になっており、ここでは
 * utcRaw 相当の文字列だけで十分なため(不要なフィールドを持つ型を無理に使い回さない判断。
 * 2026-07-13 alarm 入力の専用ヘルパーだったものを epoch 直接変換に一般化した)。
 */
function epochMillisToUtcRaw(epochMillis: number): string {
	const d = new Date(epochMillis);
	return `${d.getUTCFullYear().toString().padStart(4, "0")}` +
		`${(d.getUTCMonth() + 1).toString().padStart(2, "0")}` +
		`${d.getUTCDate().toString().padStart(2, "0")}T` +
		`${d.getUTCHours().toString().padStart(2, "0")}` +
		`${d.getUTCMinutes().toString().padStart(2, "0")}` +
		`${d.getUTCSeconds().toString().padStart(2, "0")}Z`;
}

// chat 語彙の frequency ("daily"等) → ドメインの Frequency("DAILY"等)。
const FREQUENCY_MAP: Record<CreateTodoRecurrenceInput["frequency"], Frequency> = {
	daily: "DAILY",
	weekly: "WEEKLY",
	monthly: "MONTHLY",
	yearly: "YEARLY",
};

/**
 * CreateTodoRecurrenceInput(chat 語彙) → RecurrenceRule(ドメイン型)への変換 + 不変条件検証。
 *
 * 【until の値型を due に揃える理由(I6・2026-07-13 V6 で分岐に変更)】
 * RFC 5545 §3.3.10「The value of the UNTIL rule part MUST have the same value type as the
 * "DTSTART" property.」に従い、DTSTART の値型と UNTIL の値型を一致させる必要がある
 * (update-todo.ts で判明した同種の罠 — I6 不変条件)。V6 以前は due が常に DATE だったので
 * 常に RecurUntil{type:"date"} で足りたが、時刻付き due(DATE-TIME)を統合した以上、
 * DTSTART が DATE-TIME のときは UNTIL も DATE-TIME(UTC)にしないと値型不一致になる。
 * @param dueTimeInfo due が DATE-TIME のときの壁時計時刻(hour/minute/second)+ 解決済み
 *   timeZone。UNTIL の「日付」は input.until("YYYY-MM-DD")から、「時刻」は due と同じ
 *   時刻を流用する(iOS の反復リマインダーは「n回目の期限と同じ時刻に終了する」という
 *   直感的な意味になるようにする設計判断 — RFC は UNTIL の時刻をどう選ぶべきかまでは
 *   規定していない[値型が一致してさえいればよい]ので、ここはこの実装のポリシー)。
 *   due が DATE(終日)のときは undefined を渡す(＝従来どおり RecurUntil{type:"date"})。
 */
function buildRecurrenceRule(
	input: CreateTodoRecurrenceInput,
	dueTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined,
): RecurrenceRule {
	if (input.count !== undefined && input.until !== undefined) {
		throw new RecurrenceCountUntilConflictError();
	}
	if (input.weekdays !== undefined && input.weekdays.length > 0 && input.frequency !== "weekly") {
		throw new RecurrenceWeekdaysRequireWeeklyError(input.frequency);
	}

	let until: RecurrenceRule["until"];
	if (input.until !== undefined) {
		if (dueTimeInfo === undefined) {
			until = { type: "date", date: parseCalDate(input.until.replace(/-/g, "")) };
		} else {
			const [y, m, d] = input.until.split("-").map(Number);
			const untilMillis = localFieldsToEpochMillis(
				{ year: y!, month: m!, day: d!, hour: dueTimeInfo.hour, minute: dueTimeInfo.minute, second: dueTimeInfo.second },
				dueTimeInfo.timeZone,
			);
			// UTC フィールドへ変換(RecurUntil の date-time は utc|floating 限定。ここは常に utc)。
			const dt = new Date(untilMillis);
			const utcDateTime: CalDateTime = {
				kind: "utc",
				year: dt.getUTCFullYear(),
				month: dt.getUTCMonth() + 1,
				day: dt.getUTCDate(),
				hour: dt.getUTCHours(),
				minute: dt.getUTCMinutes(),
				second: dt.getUTCSeconds(),
			};
			until = { type: "date-time", dateTime: utcDateTime as Extract<CalDateTime, { kind: "utc" }> };
		}
	}

	return recurrenceRule({
		freq: FREQUENCY_MAP[input.frequency],
		interval: input.interval,
		count: input.count,
		until,
		byDay:
			input.frequency === "weekly" && input.weekdays !== undefined
				? input.weekdays.map((weekday) => ({ weekday }))
				: undefined,
	});
}

export class CreateTodo {
	constructor(private readonly putCalendarObject: PutCalendarObject) {}

	async execute(input: CreateTodoInput): Promise<CreateTodoOutput> {
		let due: VTodoFields["due"];
		// due が DATE-TIME のときだけ埋まる補助情報。VALARM の TRIGGER・VTIMEZONE の窓・
		// recurrence の UNTIL 値型分岐で使い回す(同じ壁時計フィールドを何度も再パースしない)。
		let dueEpochMillis: number | undefined;
		let dueTimeInfo: { hour: number; minute: number; second: number; timeZone: string } | undefined;

		if (input.due !== undefined) {
			if (DATE_ONLY_RE.test(input.due)) {
				// buildVTodoCalendar は VALUE=DATE の生値(YYYYMMDD、区切りなし)を要求する
				// (values/cal-date.ts の DATE 構文 §3.3.4)。"YYYY-MM-DD" から区切りを剥がすだけ。
				due = { type: "DATE", raw: input.due.replace(/-/g, "") };
			} else {
				const m = DATE_TIME_LOCAL_RE.exec(input.due);
				if (m === null) {
					// 空文字・offset 付き ISO8601・その他不正な形式はすべてここに落ちる
					// (InvalidDueError のコメントに offset 拒否の理由を明記)。
					throw new InvalidDueError(input.due);
				}
				// timeZone は「省略しない」「暗黙 UTC にしない」の2段検証(resolver 層の既存原則)。
				if (input.timeZone === undefined) {
					throw new DueTimeZoneRequiredError(input.due);
				}
				if (!isValidIanaZone(input.timeZone)) {
					throw new InvalidTimeZoneError(input.timeZone);
				}
				const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
				const localFields = {
					year: Number(y),
					month: Number(mo),
					day: Number(d),
					hour: Number(h),
					minute: Number(mi),
					second: Number(s),
				};
				dueEpochMillis = localFieldsToEpochMillis(localFields, input.timeZone);
				dueTimeInfo = { hour: localFields.hour, minute: localFields.minute, second: localFields.second, timeZone: input.timeZone };
				// buildVTodoCalendar は VALUE=DATE-TIME の生値(YYYYMMDDTHHMMSS、区切りなし)を
				// 要求する(values/cal-date-time.ts の DATE-TIME 構文 §3.3.5)。
				due = { type: "DATE-TIME", raw: `${y}${mo}${d}T${h}${mi}${s}`, tzid: input.timeZone };
			}
		}

		let recurrence: RecurrenceRule | undefined;
		if (input.recurrence !== undefined) {
			// RRULE は DTSTART をアンカーにするため due 必須(vtodo-write.ts の防御的 throw と
			// 対称。ここが本線で、あちらは呼び出し側のバグを捕まえる最終防衛線)。
			if (due === undefined) {
				throw new RecurrenceRequiresDueError();
			}
			recurrence = buildRecurrenceRule(input.recurrence, dueTimeInfo);
		}

		// VTIMEZONE + VALARM は due が DATE-TIME のときだけ組み立てる(終日 due は iOS 実機観測
		// どおり VALARM 無し・VTIMEZONE 不要)。
		// 【2026-07-13 V6: 独立 alarm フィールドを廃止し due に統合】旧実装は「due とは独立の
		// alarm 入力(offset ISO8601)」を任意指定で受け、VALARM 生成を due と切り離していた。
		// V5 実機検証で「iOS はサーバー発 VALARM でも通知する」ことが確定した(docs/modeling/06)
		// ため、「時刻付き due = その時刻に通知する」という自然な意味に統合した方が概念として
		// 正しいと判断(概念ミスマッチの解消。未リリース内部 API なので後方互換コストもゼロ)。
		// 時刻付き due には常に VALARM を付ける(任意指定ではなくなった)。
		let vtimezone: Component | undefined;
		let alarm: { triggerUtcRaw: string; uid: string } | undefined;
		if (due !== undefined && due.type === "DATE-TIME") {
			const dueMillis = dueEpochMillis!; // 上のパース分岐で必ず設定されている。

			// 反復ホライズン: recurrence に UNTIL(date-time)があればその瞬間、無ければ
			// due + 3年。暦年での加算は setUTCFullYear を使う(365日固定の単純計算だと
			// うるう年でホライズンが1日ずれるため — 3年先までの窓を大きめに取る用途なので
			// 1日のずれ自体は実害無いが、意図が伝わる書き方を優先した)。
			let horizonMillis: number;
			if (recurrence?.until !== undefined && recurrence.until.type === "date-time") {
				// buildRecurrenceRule はここでは常に kind:"utc" の CalDateTime を作る(上のコメント
				// 参照)。RecurUntil.dateTime の型は utc|floating の union(RRULE パース経路も
				// 共有する型のため)なので、floating は理論上ここに来ない前提を型ガードで表す
				// (来た場合は「UTC として解釈した壁時計」を素直に epoch 化するフォールバックにする
				// — 暗黙 UTC 扱いは floating の既定と同じ設計判断で、resolver.ts のコメントとも
				// 整合する)。
				const dt = recurrence.until.dateTime;
				horizonMillis = dt.kind === "utc" ? toEpochMillis(dt) : localFieldsToEpochMillis(dt, "UTC");
			} else {
				const horizon = new Date(dueMillis);
				horizon.setUTCFullYear(horizon.getUTCFullYear() + 3);
				horizonMillis = horizon.getTime();
			}

			try {
				vtimezone = buildVTimezone(due.tzid, {
					startMillis: dueMillis - WINDOW_MARGIN_MILLIS,
					endMillis: horizonMillis + WINDOW_MARGIN_MILLIS,
				});
			} catch (error) {
				// domain 層の UnsupportedTimeZoneError(DST ゾーン)を application 層の kind
				// タグ付きエラーへ写像する(他のエラーと同じ instanceof 判別の一貫性のため —
				// このファイル冒頭 UnsupportedTimeZoneError クラスのコメント参照)。
				if (error instanceof DomainUnsupportedTimeZoneError) {
					throw new UnsupportedTimeZoneError(due.tzid);
				}
				throw error;
			}

			// VALARM の TRIGGER は due 時刻の絶対 UTC(§3.8.6.3: trigabs は UTC MUST)。
			alarm = { triggerUtcRaw: epochMillisToUtcRaw(dueMillis), uid: crypto.randomUUID() };
		}

		const uid = crypto.randomUUID();
		// DTSTAMP は UTC MUST(§3.8.7.2。VTodo.validate() の I2 も検証している)。
		// values/cal-date-time.ts の formatCalDateTime は CalDateTime 型を要求するが、
		// ここでは Date から直接 UTC 文字列を組み立てる方が簡潔なので専用コーデックは経由しない
		// (「現在時刻 → DTSTAMP 生値」という一方向の単純な変換であり、往復性を保証する必要が
		// ないため values/ 層の CalDateTime ファクトリを通す価値が薄いと判断)。
		// 【②-b で抽出】この変換は now-stamp.ts の nowStampFromDate に一本化した
		// (UpdateTodo/CompleteTodo も同じ変換を必要とするため。挙動は変更していない)。
		const now = nowStampFromDate(new Date());

		const fields: VTodoFields = {
			uid,
			now,
			summary: input.title,
			description: input.notes,
			due,
			vtimezone,
			priority: input.priority,
			recurrence,
			alarm,
		};
		const component = buildVTodoCalendar(fields);
		const ics = serialize(component);

		const collectionId = mkCollectionId(input.calendarId ?? "tasks");
		const result = await this.putCalendarObject.execute({
			owner: input.owner,
			collectionId,
			resourceUri: `${uid}.ics`,
			ics,
			condition: { kind: "must-not-exist" },
		});

		// 保存直後の Task DTO は「今組み立てた fields」から素朴に導出できるが、taskFromVTodo
		// (list-todos.ts と共通の DTO 変換)にロジックを一本化するため、いま組み立てた
		// component をそのまま domain レンズ(ICalendarObject)経由で読み直す(ics を
		// 再 parse する必要はない — component 自体が既に Component ツリーなので)。
		const obj = ICalendarObject.fromComponent(component);
		const vtodo = obj.todos()[0];
		if (vtodo === undefined) {
			// buildVTodoCalendar が必ず VTODO を1つ作るのでここには到達しないはずだが、
			// 型上 todos()[0] は undefined を返しうるため防御的に扱う。
			throw new Error("CreateTodo: internal error — built VTODO not found after round-trip");
		}
		void result; // 現状 Task DTO には ETag を含めない(E-2 UI-ready DTO の合意どおり)ので握りつぶす。

		// zoneResolverFor(obj): due が DATE-TIME(zoned)のとき TZID→IANA 名解決が要る
		// (list-todos.ts と同じパターン。obj が VTIMEZONE を含む VCALENDAR のレンズなので
		// これで解決できる — zoneResolverFor は ICalendarObject を要求する raw Component ではない)。
		return { task: taskFromVTodo(vtodo, zoneResolverFor(obj), input.timeZone ?? "UTC") };
	}
}
