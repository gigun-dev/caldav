// =============================================================================
// timezone/vtimezone-write — IANA ゾーン名 → VTIMEZONE Component 生成(V6 新設)
// =============================================================================
//
// 【この層の責務】
// instant.ts は「TZID(生文字列)⇄ UTC エポック」の変換だけを担い、VTIMEZONE の生成には
// 関与しない(index.ts のコメントどおり「VTIMEZONE の逐語評価はしない」方針)。しかし
// V6(時刻付き due)では、サーバー自身が新規に組み立てる VTODO に DTSTART/DUE;TZID を
// 使う以上、RFC 5545 §3.6.5 が要求する VTIMEZONE を**サーバーが同梱**しなければならない
// (§3.6.5 のコメント: DTSTART;TZID 等 TZID 付きプロパティを使うカレンダーは、対応する
// VTIMEZONE を VCALENDAR に含めるのが前提)。IANA tzdb を正とする方針(index.ts)は
// 崩さず、「TZID→VTIMEZONE 生成」も Intl/ICU から導出することでこの一貫性を保つ。
//
// 【Phase 1: 固定オフセットゾーンのみ(DST は errors.ts の UnsupportedTimeZoneError)】
// RFC 5545 の正しい DST VTIMEZONE は STANDARD/DAYLIGHT の交互 RRULE(または RDATE 列挙)が
// 要る。これを Intl.DateTimeFormat の限られた API(特定瞬間のオフセット/略称しか取れない)
// から機械的に正しく導出するのは本タスクのスコープを超える難度で、生半可に実装すると
// 「境界年で不正確な VTIMEZONE」を黙って出してしまう(iOS 側で誤動作しても気づけない)。
// よって窓内にオフセット遷移が1回でもあれば throw して塞ぐ(Phase 2 で本格対応)。
// 固定オフセットゾーン(Asia/Tokyo、UTC 系、Asia/Kathmandu の +05:45 等)は歴史的な
// 過去の1回限りの改定(例 Asia/Tokyo の 1951 年 JST 制定)を除けば運用中に遷移が無いので、
// 「窓(実際に使う期間)内に遷移が無いか」だけをプロービングで確認すれば十分に安全。
// =============================================================================

import type { Component } from "../structure/types";
import { getZoneOffsetMillis } from "./instant";
import { UnsupportedTimeZoneError } from "./errors";

/**
 * 指定 UTC 期間 [startMillis, endMillis] を stepDays 刻みでプロービングし、
 * そのゾーンのオフセットが一度でも変化すれば true(= DST 等の遷移がある)を返す。
 *
 * 【なぜ「刻み」で妥協するか(厳密な遷移検出ではない)】
 * オフセット変化点を二分探索等で厳密に特定することもできるが、この関数の目的は
 * 「Phase 1 の固定オフセット前提を崩さずに使えるか」の判定だけなので、粗い刻みで
 * 変化の有無さえ検知できれば十分(誤検出の方向は「遷移が無いのに検出漏れ」だが、
 * stepDays=10 は DST 切替の最短周期(半年程度)よりずっと細かく、実用上見逃さない)。
 * 厳密な遷移時刻の特定が要る用途(Phase 2 の RRULE 導出)が出たら別関数を足す。
 */
export function zoneHasOffsetTransitions(
	ianaId: string,
	startMillis: number,
	endMillis: number,
	stepDays = 10,
): boolean {
	if (endMillis < startMillis) {
		throw new RangeError(`zoneHasOffsetTransitions: endMillis (${endMillis}) < startMillis (${startMillis})`);
	}
	const stepMillis = stepDays * 24 * 60 * 60 * 1000;
	const baseline = getZoneOffsetMillis(ianaId, startMillis);
	for (let t = startMillis; t <= endMillis; t += stepMillis) {
		if (getZoneOffsetMillis(ianaId, t) !== baseline) return true;
	}
	// 末尾ちょうど endMillis を刻みが飛び越える場合があるので、最後に endMillis 自体も確認する
	// (例: 窓が stepDays の非整数倍で、最後の反復が endMillis の手前で止まるケース)。
	if (getZoneOffsetMillis(ianaId, endMillis) !== baseline) return true;
	return false;
}

/** ±HHMM 形式のオフセット文字列を組み立てる(TZOFFSETTO/TZOFFSETFROM の値構文 §3.8.3.4)。 */
function formatOffsetHHMM(offsetMillis: number): string {
	const sign = offsetMillis < 0 ? "-" : "+";
	const totalMinutes = Math.round(Math.abs(offsetMillis) / 60000);
	const hh = Math.floor(totalMinutes / 60)
		.toString()
		.padStart(2, "0");
	const mm = (totalMinutes % 60).toString().padStart(2, "0");
	return `${sign}${hh}${mm}`;
}

/**
 * Intl の "short" タイムゾーン名から TZNAME(§3.6.5 で OPTIONAL)の値を取り出す。
 * "JST"/"EST" のような略称なら採用し、"GMT+9"/"GMT+05:45" のような Intl の
 * フォールバック表現(略称が無いゾーンで Intl が生成する形)は「意味のある略称ではない」
 * ため省略する(TZNAME に "GMT+9" を書いても情報量が無く、iOS 実機キャプチャにも
 * この形の TZNAME は出てこない — vtodo-write.ts と同じ「実データに揃える」方針)。
 */
function shortTzNameFor(ianaId: string, atMillis: number): string | undefined {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: ianaId, timeZoneName: "short" }).formatToParts(
		new Date(atMillis),
	);
	const tzNamePart = parts.find((p) => p.type === "timeZoneName");
	if (tzNamePart === undefined) return undefined;
	// GMT/UTC 系の数値オフセット表現("GMT+9", "GMT+05:45", "UTC" 単体含む)は略称として
	// 採用しない。"GMT" だけの厳密一致(UTC/Etc/GMT 系)は許容してもよいが、実データに
	// 無い形をわざわざ対応する価値が薄いので、数字を含む GMT± 表現だけを弾く単純な判定にする。
	if (/^(GMT|UTC)[+-]/.test(tzNamePart.value)) return undefined;
	return tzNamePart.value;
}

/** buildVTimezone の窓引数。この期間内でオフセット遷移が無いことを検証する。 */
export interface VTimezoneWindow {
	readonly startMillis: number;
	readonly endMillis: number;
}

/**
 * IANA ゾーン名 + 窓 → RFC 5545 §3.6.5 準拠の最小 VTIMEZONE Component。
 *
 * 【DTSTART:19700101T000000 固定の理由】
 * 固定オフセットゾーンでは STANDARD の「その観測規則が適用される最初の瞬間」を
 * 正確に遡って求める必要が実務上ない(遷移が無い前提を満たしている以上、
 * どの過去時点を DTSTART にしてもオフセット解釈は窓内で不変)。1970-01-01 を選ぶのは
 * DATE-TIME(floating)として最も見慣れた epoch 起点であり、iOS 実機キャプチャの
 * "19510909T010000"(Asia/Tokyo の JST 制定日)のような正確な歴史的日付を Intl から
 * 逆算する API が無い(Intl.DateTimeFormat は「特定瞬間のオフセット」しか返さず、
 * 「このオフセットになった最初の瞬間」の探索は提供しない)ため、正確性より
 * 「必ず正しく解釈される固定値」を選んだ(RFC 上 DTSTART の実際の日付に意味はなく、
 * STANDARD の観測規則が及ぶ範囲を画定するだけ — TZOFFSETFROM=TZOFFSETTO なので
 * この STANDARD は「その日以降ずっとこのオフセット」を表す)。
 */
export function buildVTimezone(ianaId: string, window: VTimezoneWindow): Component {
	if (zoneHasOffsetTransitions(ianaId, window.startMillis, window.endMillis)) {
		throw new UnsupportedTimeZoneError(ianaId);
	}

	// 窓の代表時刻として due 相当(呼び出し側の契約: window.startMillis を「due − 400日」に
	// 設定してもらう想定なので、代表値には窓の中央寄りではなく startMillis を使う—
	// 遷移が無いと確認済みなので窓内のどの瞬間でもオフセットは同じで、選び方に意味はない)。
	const offsetMillis = getZoneOffsetMillis(ianaId, window.startMillis);
	const offsetRaw = formatOffsetHHMM(offsetMillis);
	const tzName = shortTzNameFor(ianaId, window.startMillis);

	const standard: Component = {
		name: "STANDARD",
		properties: [
			{ name: "DTSTART", parameters: [], value: "19700101T000000" },
			{ name: "TZOFFSETFROM", parameters: [], value: offsetRaw },
			{ name: "TZOFFSETTO", parameters: [], value: offsetRaw },
			...(tzName !== undefined ? [{ name: "TZNAME", parameters: [], value: tzName }] : []),
		],
		components: [],
	};

	return {
		name: "VTIMEZONE",
		properties: [{ name: "TZID", parameters: [], value: ianaId }],
		components: [standard],
	};
}
