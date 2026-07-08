// =============================================================================
// CalDateTime — RFC 5545 §3.3.5 DATE-TIME 値型(iCalendar 最大の落とし穴)
// =============================================================================
//
// 【なぜ3形態を判別可能ユニオンにするのか — モデル図 §1-2 の最重要ポイント】
// §3.3.5 は DATE-TIME に「時刻をどう解釈するか」で3つの形態を定める:
//   ① FORM #1 ローカル時刻(floating): 例 20260708T090000
//      → タイムゾーン情報なし。「観測者のローカル時刻」。DST や移動で絶対時刻が変わる。
//   ② FORM #2 UTC 時刻: 例 20260708T000000Z(末尾 Z)
//      → 絶対時刻。唯一この形態だけがタイムゾーン非依存で比較・エポック変換できる。
//   ③ FORM #3 TZID 付きローカル: DTSTART;TZID=Asia/Tokyo:20260708T090000
//      → 値の構文は floating と同一。TZID は「パラメータ」由来なので、
//        値文字列だけからは floating と区別できない。だから parse は (value, tzid?) を取る。
//
// これらを1つの JS Date に潰すと、①③を勝手に UTC 扱いしてしまい time-range フィルタ
// (RFC 4791 §7.8)や RRULE 展開で意味がずれる。よって Date には絶対に変換せず、
// kind タグ付きのユニオンで「どの形態か」を型として保持する。
//
// 【この層でやらないこと(重要・コメントで明記せよという要件)】
// ③ zoned の「絶対時刻への解決」はやらない。TZID → UTC オフセットの解決には
// 同じ VCALENDAR 内の VTIMEZONE(§3.6.5)が必要で、それは iCalendar の別の集約の
// 情報。値オブジェクト単体では解決不能。解決は将来のドメインサービス
// (RecurrenceExpansion / time-range 評価)の責務(モデル図 §1-4)。
// したがって比較・エポック変換ヘルパーは ② UTC 形態にのみ提供する。
// =============================================================================

import { InvalidValueError } from "./errors";
import { validateYmd } from "./cal-date";

// 年月日時分秒の生フィールド。3形態で共通。
interface DateTimeFields {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number; // 0-23
	readonly minute: number; // 0-59
	readonly second: number; // 0-60(60 は正のうるう秒。後述)
}

/**
 * DATE-TIME 値(§3.3.5)。kind で3形態を判別する。
 *
 * - floating: タイムゾーン非依存のローカル時刻。
 * - utc: Z 付き絶対時刻。
 * - zoned: TZID 付きローカル。tzid はパラメータ由来なので値に含める。
 *   ※ tzid の中身(Asia/Tokyo 等)の妥当性はここでは検証しない。
 *     VTIMEZONE と突き合わせるのは集約側の仕事(I8)。文字列としてそのまま保持する。
 */
export type CalDateTime =
	| ({ readonly kind: "floating" } & DateTimeFields)
	| ({ readonly kind: "utc" } & DateTimeFields)
	| ({ readonly kind: "zoned"; readonly tzid: string } & DateTimeFields);

// date(8桁)+ "T" + time(6桁)+ 任意の "Z"。§3.3.5 の構文。
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

/**
 * 時分秒の範囲を検証(実在日は validateYmd 側)。理由文字列を返す(問題なければ null)。
 *
 * 【うるう秒(秒=60)の扱い — 要件どおりの判断をここに残す】
 * §3.3.5 は正のうるう秒として秒=60 を許す。RFC は「非対応実装は 59 と等価に解釈 SHOULD」
 * と言うが、本実装は「受理して 60 のまま保持」する(要件で簡明さ優先と指示)。
 * 60 を保持する理由: ロスレス往復(20260630T235960Z がそのまま戻る)を壊さないため。
 * ただしエポック変換時だけは JS Date が 60 を分に繰り上げてしまうので 59 にクランプする
 * (toEpochMillis 参照)。「保持は 60・計算時のみ 59」という妥協。
 */
function validateTime(hour: number, minute: number, second: number): string | null {
	if (hour < 0 || hour > 23) return `hour out of range: ${hour}`;
	if (minute < 0 || minute > 59) return `minute out of range: ${minute}`;
	// 秒は 0-60。60 はうるう秒として受理(上のコメント参照)。
	if (second < 0 || second > 60) return `second out of range: ${second}`;
	return null;
}

// 共通の実在検証。日付(validateYmd)+ 時刻(validateTime)。
function validateFields(f: DateTimeFields, raw: string): void {
	const dErr = validateYmd(f.year, f.month, f.day);
	if (dErr !== null) throw new InvalidValueError("DATE-TIME", raw, dErr);
	const tErr = validateTime(f.hour, f.minute, f.second);
	if (tErr !== null) throw new InvalidValueError("DATE-TIME", raw, tErr);
}

/**
 * 生の値文字列 → CalDateTime(§3.3.5)。
 *
 * @param raw   値文字列(例 "20260708T090000" / "20260708T000000Z")
 * @param tzid  TZID パラメータの値(あれば)。プロパティのパラメータから渡す設計。
 *
 * 形態の決定ロジック:
 *   - 末尾 Z あり            → utc
 *   - 末尾 Z なし + tzid あり → zoned
 *   - 末尾 Z なし + tzid なし → floating
 *
 * 【MUST NOT の強制】§3.2.19/§3.3.5: TZID を UTC 値(Z付き)に付けてはならない。
 * つまり「Z あり + tzid あり」は矛盾なのでエラーにする(I8)。
 */
export function parseCalDateTime(raw: string, tzid?: string): CalDateTime {
	const m = DATE_TIME_RE.exec(raw);
	if (m === null) {
		throw new InvalidValueError("DATE-TIME", raw, "must be YYYYMMDDTHHMMSS with optional trailing Z");
	}
	const fields: DateTimeFields = {
		year: Number(m[1]),
		month: Number(m[2]),
		day: Number(m[3]),
		hour: Number(m[4]),
		minute: Number(m[5]),
		second: Number(m[6]),
	};
	validateFields(fields, raw);

	const hasZ = m[7] === "Z";

	if (hasZ) {
		if (tzid !== undefined) {
			// Z(UTC)と TZID の併用は §3.3.5 で MUST NOT。データの矛盾なので拒否。
			throw new InvalidValueError("DATE-TIME", raw, "TZID parameter must not be combined with a UTC ('Z') value");
		}
		return { kind: "utc", ...fields };
	}
	if (tzid !== undefined) {
		// tzid は空文字を許さない(パラメータとして無意味)。それ以外は中身を検証せず保持。
		if (tzid === "") {
			throw new InvalidValueError("DATE-TIME", raw, "TZID parameter is empty");
		}
		return { kind: "zoned", tzid, ...fields };
	}
	return { kind: "floating", ...fields };
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}
function pad4(n: number): string {
	return n.toString().padStart(4, "0");
}

/**
 * CalDateTime → 生の値文字列(§3.3.5)。
 *
 * 注意: zoned の TZID は「値」ではなく「パラメータ」なので、この format は値部分
 * (floating と同じ構文)しか返さない。TZID=... の付与は Property を組み立てる
 * parse/serialize 層の仕事。ここで tzid を混ぜると値とパラメータの責務が混ざる。
 * 呼び出し側が tzid を別途取り出せるよう、値オブジェクトには tzid を保持してある。
 */
export function formatCalDateTime(dt: CalDateTime): string {
	const body = `${pad4(dt.year)}${pad2(dt.month)}${pad2(dt.day)}T${pad2(dt.hour)}${pad2(dt.minute)}${pad2(dt.second)}`;
	// UTC 形態だけ末尾 Z を付ける。floating / zoned は付けない(zoned の TZ 情報はパラメータ側)。
	return dt.kind === "utc" ? `${body}Z` : body;
}

// ---------------------------------------------------------------------------
// UTC 形態専用ヘルパー(比較・エポック変換)
// ---------------------------------------------------------------------------
// floating / zoned に対しては提供しない。理由はファイル冒頭の設計決定を参照
// (絶対時刻が定まらない = 比較の基準がない)。型で「utc のみ」を要求する。

/** kind: "utc" だけを受ける型別名。ヘルパーの引数を型で縛るため。 */
export type CalDateTimeUtc = Extract<CalDateTime, { kind: "utc" }>;

/**
 * UTC 日時 → エポックミリ秒(1970-01-01T00:00:00Z 起点)。
 *
 * うるう秒(秒=60)は JS の Date.UTC が分へ繰り上げてしまい絶対時刻が1秒ずれるため、
 * 計算時のみ 59 にクランプする(ファイル冒頭のうるう秒方針どおり。保持は 60 のまま)。
 */
export function toEpochMillis(dt: CalDateTimeUtc): number {
	const sec = dt.second === 60 ? 59 : dt.second;
	// Date.UTC は month が 0 始まり。month-1 する。
	return Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, sec);
}

/**
 * UTC 日時どうしの比較。a<b → -1, a==b → 0, a>b → 1。
 * time-range フィルタや UNTIL 判定でソート・境界比較に使う想定。
 * UTC 同士でしか呼べないので、比較の意味が常に well-defined。
 */
export function compareUtc(a: CalDateTimeUtc, b: CalDateTimeUtc): -1 | 0 | 1 {
	const da = toEpochMillis(a);
	const db = toEpochMillis(b);
	if (da < db) return -1;
	if (da > db) return 1;
	return 0;
}
