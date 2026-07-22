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

/** "YYYY-MM-DD" の曜日インデックス(0=日 … 6=土)。その日付のローカル深夜の getDay を取る。
 *  カレンダー上の曜日は世界共通(壁日付の曜日はゾーンに依らず一意)なのでゾーン換算は不要 —
 *  new Date(y,m-1,d) はローカル深夜だが、getDay はその「壁日付」の曜日を返すので実行環境の TZ に
 *  依らず安定する。範囲外は 0(防御。呼び出し側で "YYYY-MM-DD" 前提)。 */
export function weekdayIndexOf(dateKey: string): number {
	const [y, m, d] = dateKey.split("-").map(Number);
	return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay();
}

/** "YYYY-MM-DD" の曜日1文字(その日付のローカル深夜から取る。カレンダー上の曜日は世界共通なので
 *  ゾーン換算は不要)。範囲外は ""(防御)。 */
export function weekdayOf(dateKey: string): string {
	return WEEKDAYS[weekdayIndexOf(dateKey)] ?? "";
}

// =============================================================================
// 月グリッド計算(agenda 月ビュー用・2026-07-22 ロードマップ②)
// =============================================================================
// 【なぜ純関数として format.ts に置くか(main 裁定・確定済み設計判断3)】
//   月ビューのグリッド(月初・addMonths・42 セル列挙)は「月またぎ・年またぎ・うるう年」で壊れ
//   やすい日付算術の塊で、DOM を組む前に単体テストで固めておきたい。DOM/App を知らない純粋な
//   Date/文字列演算だけなのでこのファイル(共有カーネル)へ集約し、bun:test で境界を機械的に固定
//   する(mcp-ui-month-grid.test.ts)。entry 側は結果の date キー列/YearMonth を受け取って描画と
//   レンジ算出に使うだけにする(How は entry・What はテスト、の書き分け方針どおり)。
//
// 【日曜始まりにした理由】iOS カレンダーの既定(地域設定で月曜始まりもあるが、まずは iOS US 既定の
//   日曜始まりに合わせる)。モック agenda-views-v6.html の renderGrid が `start.setDate(1 - getDay())`
//   で日曜始まりにしているのと同じ規約(index=0 が日曜)。月曜始まりは将来 locale 対応で足す(起票)。

/** 年月(month は 1-12。JS Date の 0-11 とは意図的にずらす — "YYYY-MM" の表示や算術と桁を揃え、
 *  呼び出し側での ±1 混乱を減らすため)。 */
export interface YearMonth {
	year: number;
	month: number; // 1-12
}

/** "YYYY-MM-DD" が属する YearMonth を取り出す(月ビューの初期カーソル = 今日の年月に使う)。 */
export function yearMonthOf(dateKey: string): YearMonth {
	const [y, m] = dateKey.split("-").map(Number);
	return { year: y ?? 0, month: m ?? 1 };
}

/** YearMonth に月を加減する(delta は負可)。年またぎは正しく桁上げ/桁下げする。
 *  【実装】0-11 系へ一旦落として new Date で正規化…ではなく、month-1+delta を 12 で割った商/剰余で
 *  手計算する(new Date は「日」も持つため月末日の繰り上がり等の副作用が混じりやすい — 月だけを
 *  動かしたいこの用途では純粋な整数演算の方が安全で意図が明確)。剰余の負数対策で ((r % 12) + 12) % 12。 */
export function addMonths(ym: YearMonth, delta: number): YearMonth {
	const zeroBased = ym.month - 1 + delta; // 0-11 系の通し月
	const year = ym.year + Math.floor(zeroBased / 12);
	const month = ((zeroBased % 12) + 12) % 12; // 負の剰余を 0-11 に正規化
	return { year, month: month + 1 };
}

/** YearMonth の月初 "YYYY-MM-DD"。 */
export function firstDayKeyOf(ym: YearMonth): string {
	return `${ym.year}-${String(ym.month).padStart(2, "0")}-01`;
}

/** 月グリッド(日曜始まり・6週=42セル固定)の日付キー列を左上→右下の順で列挙する。
 *  月初の曜日ぶんだけ前月にはみ出した日曜から始め、常に 42 個返す(末尾は翌月にはみ出す)。
 *  6週固定にする理由: セル数が月によって 28〜42 で変動するとグリッドの高さが毎月跳ねて落ち着かない
 *  (iOS カレンダーも 6 週固定)。UTC 基準の addDaysToDateKey で足すので DST/TZ に依らず安定。 */
export function monthGridDays(ym: YearMonth): string[] {
	const firstKey = firstDayKeyOf(ym);
	const leading = weekdayIndexOf(firstKey); // 月初が日曜なら 0・土曜なら 6
	const start = addDaysToDateKey(firstKey, -leading); // グリッド左上(直前の日曜)
	const days: string[] = [];
	for (let i = 0; i < 42; i++) days.push(addDaysToDateKey(start, i));
	return days;
}

/** 月グリッドが実際にカバーする範囲を「絶対 timeMin/timeMax」の offset ISO で返す(確定済み設計判断2:
 *  月ビュー突入時に currentRange をこの 42 セル分へ差し替えて refresh-events する)。
 *  from = グリッド左上(日曜)のローカル深夜 / to = グリッド右下の翌日のローカル深夜(排他終端で
 *  最終セルの当日を丸ごと含める)。offset は「その日付のローカル offset」を Date から引く(DST 境界を
 *  跨いでも各端の当日 offset を使う)。実行環境(ブラウザ)のローカル TZ = 閲覧デバイスの TZ。 */
export function monthGridRange(ym: YearMonth): { from: string; to: string } {
	const days = monthGridDays(ym);
	const firstCell = days[0] ?? firstDayKeyOf(ym);
	const lastCell = days[days.length - 1] ?? firstCell;
	return {
		from: localMidnightIso(firstCell),
		to: localMidnightIso(addDaysToDateKey(lastCell, 1)),
	};
}

/** "YYYY-MM-DD" のローカル深夜(00:00:00)を offset 付き ISO8601 にする(server の timeMin/timeMax が
 *  offset ISO を要求するため。parseIsoToEpoch は Z / ±HH:MM を受理する)。offset は new Date の
 *  getTimezoneOffset(その日付のローカル offset・分)から組む — 実行環境が閲覧デバイスなので
 *  「デバイスの壁時計 00:00」を正しく絶対時刻へ写せる。
 *  【テストしない Why】返り値は実行環境の TZ に依存するため決定的テストに向かない(月グリッドの
 *  日付キー算術は monthGridDays/addMonths でテスト済み)。ここは薄い offset 整形だけに留める。 */
export function localMidnightIso(dateKey: string): string {
	const [y, m, d] = dateKey.split("-").map(Number);
	const dt = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 0, 0, 0);
	const offMin = -dt.getTimezoneOffset(); // JST なら +540(getTimezoneOffset は符号が逆)
	const sign = offMin >= 0 ? "+" : "-";
	const abs = Math.abs(offMin);
	const oh = String(Math.floor(abs / 60)).padStart(2, "0");
	const om = String(abs % 60).padStart(2, "0");
	return `${dateKey}T00:00:00${sign}${oh}:${om}`;
}
