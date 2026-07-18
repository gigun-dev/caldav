// =============================================================================
// presentation/mcp/ui/format.ts — 日付/時刻整形の共有純関数(共有カーネル第1号)
// =============================================================================
// 【なぜ切り出すか(docs/modeling/12 §4「共有カーネル戦略の実践第1号」)】
//   todos-entry.ts と agenda-entry.ts が「終日 "YYYY-MM-DD" / 時刻付き offset ISO」という
//   同じ due/start 規約を持ち、その日付部分/時刻部分の切り出し・日数差・ローカル日付キーの
//   算出を全く同じロジックで必要とする。二重管理して片方だけ直す事故を防ぐため、DOM も App も
//   知らない純関数だけをここに集約する。将来 WebUI/Swift が使う contract 整形関数の種でもある。
//
// 【DOM を持ち込まない(重要な制約)】
//   このファイルは主 tsconfig(Workers 向け・DOM lib 無し)でもコンパイルされる(exclude は
//   *-entry.ts と icons.ts だけ)。よって document/window 等の DOM API は使わない — 純粋な
//   Date 演算と文字列操作だけにする。DOM を組む部品(chips 等)はここではなく entry 側 or
//   別の ui 限定モジュールに置く。
//
// 【mcp-ui-is-terminal との関係】ui/ 内どうしの import は許可される(.dependency-cruiser.cjs の
//   pathNot が ^src/presentation/mcp/ui を除外)。bun build がバンドル時に inline するので、
//   生成物 *-bundle.ts は従来どおり1ファイルのまま。
// =============================================================================

/** 曜日1文字(日→土)。formatDue / アジェンダの日付見出しが共用する。 */
export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** ローカル(閲覧デバイス)の "YYYY-MM-DD"。Date#toISOString は UTC になってしまい
 *  日本の朝などで日付がズレるため、getFullYear 系で手組みする(todos-entry から移設)。 */
export function localDateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** due/start の「日付部分」("YYYY-MM-DD")。終日はそのまま、時刻付きは自ゾーンの壁時計日付。 */
export function wallDatePart(instant: string): string {
	return instant.slice(0, 10);
}

/** 時刻付き due/start の壁時計 "HH:MM"(offset ISO の T 以降先頭5文字)。時刻なしは ""。 */
export function wallTimePart(instant: string): string {
	const t = instant.split("T")[1];
	return t === undefined ? "" : t.slice(0, 5);
}

/** "YYYY-MM-DD" 同士の日数差(a - today)。両方を UTC 深夜として引き算する
 *  (ローカル深夜だと DST 切替日に ±1h ずれて日数が壊れるため UTC で計算)。 */
export function dayDiff(dateKey: string, todayKey: string): number {
	const toUtc = (k: string): number => {
		const [y, m, d] = k.split("-").map(Number);
		return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
	};
	return Math.round((toUtc(dateKey) - toUtc(todayKey)) / 86_400_000);
}

/** "YYYY-MM-DD" に日数を加減した "YYYY-MM-DD"(UTC 深夜基準。DST ズレ回避は dayDiff と同じ理由)。
 *  agenda-entry.ts の終日イベント「終了」既定日算出(開始+1日)で使う(2026-07-18 監査#2)。 */
export function addDaysToDateKey(dateKey: string, days: number): string {
	const [y, m, d] = dateKey.split("-").map(Number);
	const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
	const dt = new Date(t);
	return localDateKeyUtc(dt);
}

/** addDaysToDateKey 専用: UTC 基準の Date から "YYYY-MM-DD" を組む(localDateKey はローカル基準なので
 *  UTC 演算結果には使えない — 呼び出し元の環境 TZ によっては日付がズレる)。 */
function localDateKeyUtc(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** "YYYY-MM-DD" の曜日1文字(その日付のローカル深夜から取る。カレンダー上の曜日は世界共通なので
 *  ゾーン換算は不要)。範囲外は ""(防御)。 */
export function weekdayOf(dateKey: string): string {
	const [y, m, d] = dateKey.split("-").map(Number);
	return WEEKDAYS[new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay()] ?? "";
}
