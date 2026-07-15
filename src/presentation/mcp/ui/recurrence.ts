// =============================================================================
// presentation/mcp/ui/recurrence.ts — RRULE 要約の整形 + プリセット相互写像(共有カーネル)
// =============================================================================
// 【なぜ切り出すか】todos(リマインダー)と agenda(イベント)は同じ recurrence 契約
//   (frequency none/daily/weekly/monthly/yearly + interval/weekdays/count/until・同じ degrade 規約)を
//   共有する(docs/modeling/12 §2「recurrence 入力は todo と同一 shape」)。人間可読整形
//   (「毎週 月・水」)とプリセット(iOS 語彙 ⇄ ツール引数)の写像を二重管理しないため集約する。
//   DTO は chat 語彙 + 構造化フィールドをロスレスに渡し、UI が閲覧者言語(日本語)へ整形する
//   (task-dto.ts / event-dto.ts の判断と対になる純関数)。
//
// 【DOM を持ち込まない】format.ts と同じ制約(主 tsconfig でもコンパイルされる)。ここは純関数
//   だけ。プリセット chips の DOM 組み立ては entry 側が担う(このモジュールは写像だけ提供)。
// =============================================================================

/** RRULE 要約(task-dto.ts / event-dto.ts の recurrence と同型を写経)。frequency は通常 chat 語彙
 *  (daily/weekly/monthly/yearly)だが、degrade 時は生 RRULE / 生 FREQ が入りうる。 */
export interface RecurrenceSummary {
	frequency: string;
	interval: number;
	weekdays: string[] | null;
	count: number | null;
	until: string | null;
}

/** BYDAY の weekday コード → 日本語1文字。序数付き("2MO" 等)はここに無い = degrade シグナル。 */
export const WEEKDAY_JA: Record<string, string> = { SU: "日", MO: "月", TU: "火", WE: "水", TH: "木", FR: "金", SA: "土" };
/** frequency(chat 語彙)→ 「毎日/毎週/毎月/毎年」。語彙外(生 RRULE/生 FREQ)はここに無い。 */
export const RECUR_EVERY: Record<string, string> = { daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年" };
/** interval>1 のときの単位。「2週ごと」の「週」等。monthly は「か月」。 */
export const RECUR_UNIT: Record<string, string> = { daily: "日", weekly: "週", monthly: "か月", yearly: "年" };

/**
 * 繰り返しバッジのテキスト部分(⟳ アイコンは呼び出し側が前置する)を返す。
 * 返り値 "" = アイコンのみに degrade(テキストは出さない)。仕様:
 *   - daily → 毎日 / weekly+weekdays → 毎週 月・水 / monthly → 毎月 / yearly → 毎年
 *   - interval>1 → 「2週ごと」等 / 語彙外 frequency・序数 BYDAY → ""(アイコンのみ)
 * 序数付き BYDAY や語彙外 FREQ を無理に日本語化すると誤訳になるので安全側 degrade(todos-entry から移設)。
 */
export function formatRecurrence(rec: RecurrenceSummary): string {
	if (!(rec.frequency in RECUR_EVERY)) return "";
	if (rec.weekdays !== null && rec.weekdays.some((w) => !(w in WEEKDAY_JA))) return "";
	if (rec.interval > 1) {
		return `${rec.interval}${RECUR_UNIT[rec.frequency] ?? ""}ごと`;
	}
	if (rec.frequency === "weekly" && rec.weekdays !== null && rec.weekdays.length > 0) {
		const days = rec.weekdays.map((w) => WEEKDAY_JA[w]).join("・");
		return `${RECUR_EVERY[rec.frequency]} ${days}`;
	}
	return RECUR_EVERY[rec.frequency] ?? "";
}

/** until("YYYY-MM-DD" or offset ISO)→ 表示用日付(時刻付きなら " HH:MM" を添える)。 */
export function formatUntilDate(until: string): string {
	const datePart = until.slice(0, 10);
	const hasTime = until.includes("T");
	if (!hasTime) return datePart;
	const time = until.split("T")[1]?.slice(0, 5) ?? "";
	return time === "" ? datePart : `${datePart} ${time}`;
}

/** 繰り返しの完全表記(詳細展開用)。終了条件(count/until)込みで1文にする。
 *  例:「毎週 月・水・10回まで」。degrade 形は基部を「繰り返し(生値)」にして情報を失わない。 */
export function formatRecurrenceFull(rec: RecurrenceSummary): string {
	const badge = formatRecurrence(rec);
	const base = badge !== "" ? badge : `繰り返し(${rec.frequency})`;
	const parts = [base];
	if (rec.count !== null) parts.push(`${rec.count}回まで`);
	if (rec.until !== null) parts.push(`${formatUntilDate(rec.until)} まで`);
	return parts.join("・");
}

// =============================================================================
// プリセット(iOS リマインダー/カレンダー語彙 ⇄ ツール引数)の相互写像
// =============================================================================
// モックのプリセットメニュー(しない/毎日/平日/週末/毎週/隔週/毎月/3か月ごと/6か月ごと/毎年)を
// create/update ツールの recurrence 引数への糖衣として扱う。語彙外(序数 BYDAY・複雑形・語彙外
// FREQ)は「カスタム」表示にして送信しない(安全側 degrade)。

/** メニュー選択状態を表すキー。custom は「既存値が語彙外」= グレー表示・選択不可の第3状態。 */
export type RecurPreset =
	| "none"
	| "daily"
	| "weekday"
	| "weekend"
	| "weekly"
	| "biweekly"
	| "monthly"
	| "quarterly"
	| "halfyearly"
	| "yearly"
	| "custom";

/** create/update の recurrence 引数(サーバー契約: "none"=除去・全置換)。 */
export interface RecurArgs {
	frequency: "none" | "daily" | "weekly" | "monthly" | "yearly";
	interval?: number;
	weekdays?: string[];
	count?: number;
	until?: string;
}

/** プリセット → 表示ラベル(メニューと値行の表示で共用)。 */
export const PRESET_LABEL: Record<RecurPreset, string> = {
	none: "しない",
	daily: "毎日",
	weekday: "平日",
	weekend: "週末",
	weekly: "毎週",
	biweekly: "隔週",
	monthly: "毎月",
	quarterly: "3か月ごと",
	halfyearly: "6か月ごと",
	yearly: "毎年",
	custom: "カスタム",
};
/** メニューに並べる順(モック準拠。custom は現在値が custom のときだけ末尾に選択状態で見せる)。 */
export const PRESET_MENU_ORDER: readonly RecurPreset[] = [
	"none",
	"daily",
	"weekday",
	"weekend",
	"weekly",
	"biweekly",
	"monthly",
	"quarterly",
	"halfyearly",
	"yearly",
];

/** プリセット → RecurArgs(モックのマップ)。custom は null(送信しない印)。 */
export function presetToArgs(preset: RecurPreset, weekdays: string[]): RecurArgs | null {
	switch (preset) {
		case "none":
			return { frequency: "none" };
		case "daily":
			return { frequency: "daily" };
		case "weekday":
			return { frequency: "weekly", weekdays: ["MO", "TU", "WE", "TH", "FR"] };
		case "weekend":
			return { frequency: "weekly", weekdays: ["SA", "SU"] };
		case "weekly":
			return { frequency: "weekly", ...(weekdays.length > 0 ? { weekdays } : {}) };
		case "biweekly":
			return { frequency: "weekly", interval: 2, ...(weekdays.length > 0 ? { weekdays } : {}) };
		case "monthly":
			return { frequency: "monthly" };
		case "quarterly":
			return { frequency: "monthly", interval: 3 };
		case "halfyearly":
			return { frequency: "monthly", interval: 6 };
		case "yearly":
			return { frequency: "yearly" };
		case "custom":
			return null; // 語彙外 = 触らない(送信しない)
	}
}

/** 逆写像: 既存 recurrence → メニュー選択状態(preset)+ 曜日チップの選択曜日。
 *  語彙外 frequency / 序数 BYDAY / 想定外 interval は "custom"(グレー・編集送信しない)。 */
export function recurrenceToPreset(rec: RecurrenceSummary | null): { preset: RecurPreset; weekdays: string[] } {
	if (rec === null) return { preset: "none", weekdays: [] };
	const known = (rec.weekdays ?? []).every((w) => w in WEEKDAY_JA);
	if (!(rec.frequency in RECUR_EVERY) || !known) {
		return { preset: "custom", weekdays: (rec.weekdays ?? []).filter((w) => w in WEEKDAY_JA) };
	}
	const wd = rec.weekdays ?? [];
	const iv = rec.interval;
	if (rec.frequency === "daily") return iv === 1 ? { preset: "daily", weekdays: [] } : { preset: "custom", weekdays: [] };
	if (rec.frequency === "yearly") return iv === 1 ? { preset: "yearly", weekdays: [] } : { preset: "custom", weekdays: [] };
	if (rec.frequency === "monthly") {
		if (iv === 1) return { preset: "monthly", weekdays: [] };
		if (iv === 3) return { preset: "quarterly", weekdays: [] };
		if (iv === 6) return { preset: "halfyearly", weekdays: [] };
		return { preset: "custom", weekdays: [] };
	}
	// weekly
	if (iv === 2) return { preset: "biweekly", weekdays: wd };
	if (iv === 1) {
		const set = new Set(wd);
		const isWeekday = wd.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((d) => set.has(d));
		const isWeekend = wd.length === 2 && ["SA", "SU"].every((d) => set.has(d));
		if (isWeekday) return { preset: "weekday", weekdays: wd };
		if (isWeekend) return { preset: "weekend", weekdays: wd };
		return { preset: "weekly", weekdays: wd };
	}
	return { preset: "custom", weekdays: wd };
}

/** 繰り返し値行の表示テキスト(「毎週 日・土」「毎月」「しない」等)。custom(語彙外)は「カスタム」。
 *  詳細ページの繰り返し行が使う(SheetDraft 由来の preset + weekdays を受ける)。 */
export function recurValueText(preset: RecurPreset, weekdays: string[]): string {
	const base = PRESET_LABEL[preset];
	if ((preset === "weekly" || preset === "biweekly") && weekdays.length > 0) {
		const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
		const days = order
			.filter((c) => weekdays.includes(c))
			.map((c) => WEEKDAY_JA[c])
			.join("・");
		return `${base} ${days}`;
	}
	return base;
}
