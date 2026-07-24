// =============================================================================
// timezone/instant — IANA ゾーンでのローカル時刻 ⇄ UTC エポック変換(Intl/ICU 利用)
// =============================================================================
//
// 【なぜ Intl.DateTimeFormat か(08 §3)】
// Cloudflare Workers(workerd)は Temporal 未対応(workerd discussion #6716)だが、
// Intl.DateTimeFormat は ICU 内蔵 tzdb 込みで使える(tzdb は週次更新)。TZID→UTC 変換が
// 追加依存ゼロで手に入る。VTIMEZONE の RRULE を自前評価するエンジンは作らない(08 §3 の
// 「IANA tzdb を正」決着)。ここは「IANA 名 + 壁時計フィールド ⇄ エポックミリ秒」の純変換。
//
// 【ランタイム TZ 非依存(08 §3 落とし穴リスト)】
// 本番は TZ=UTC、wrangler dev はローカル TZ(workerd #2328)。process のローカル TZ に
// 依存する API(Date のローカルメソッド、TZ 未指定の Date コンストラクタ解釈)は一切使わない。
// 全ての時刻演算は「明示した IANA ゾーン」と「UTC エポックミリ秒」だけで閉じる。
// =============================================================================

import type { CalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";
import { toEpochMillis } from "../values/cal-date-time";

// ゾーンごとの Intl.DateTimeFormat をキャッシュする。フォーマッタ生成は安くない上に、
// getZoneOffsetMillis は展開(数千 occurrence)で高頻度に呼ばれるため。キーは IANA 名。
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(ianaId: string): Intl.DateTimeFormat {
	const cached = formatterCache.get(ianaId);
	if (cached !== undefined) return cached;
	// hourCycle:"h23" が必須(落とし穴): 既定の en-US は真夜中を "24" と出す実装があり、
	// Date.UTC(... , 24, ...) が翌日 00:00 へ繰り上がってオフセットが 24h ずれる。
	// h23 は 0〜23 に固定するのでこの事故を防ぐ。
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: ianaId,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatterCache.set(ianaId, fmt);
	return fmt;
}

/**
 * 指定 UTC 瞬間における、そのゾーンの UTC からのオフセット(ミリ秒)。
 *   壁時計 = UTC + offset。例: Asia/Tokyo は常に +9h = +32400000。
 *
 * 手順: フォーマッタで「その瞬間のそのゾーンの壁時計」を年月日時分秒に分解し、
 * それを Date.UTC で数値化(= wallMillis)して、元の utcMillis との差をとる。
 * DST の有無・歴史的オフセット変更は ICU が面倒を見るので、この式だけで正しい。
 */
export function getZoneOffsetMillis(ianaId: string, utcMillis: number): number {
	const parts = formatterFor(ianaId).formatToParts(new Date(utcMillis));
	// formatToParts は順不同・リテラル片(区切り文字)混在なので type で拾う。
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const p = parts.find((x) => x.type === type);
		// year/month/... は必ず含まれる設定なので undefined は来ない想定。保険で 0。
		return p !== undefined ? Number(p.value) : 0;
	};
	const wallMillis = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return wallMillis - utcMillis;
}

/** localFieldsToEpochMillis に渡す壁時計フィールド。 */
export interface LocalFields {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number; // 0-23
	minute: number; // 0-59
	second: number; // 0-59(呼び出し側でうるう秒 60 はクランプ済みの想定。下でも保険クランプ)
}

/**
 * 「あるゾーンの壁時計フィールド」→ UTC エポックミリ秒。
 *
 * 【2パス方式(オフセットが時刻自身に依存する鶏卵問題の解法)】
 * 欲しいのは「この壁時計になる UTC 瞬間」。だがオフセットはその UTC 瞬間に依存するので
 * 一発では解けない。そこで:
 *   guess     = Date.UTC(壁時計をそのまま UTC とみなす)   … オフセット 0 の仮の瞬間
 *   off1      = getZoneOffset(guess)                        … guess 付近のオフセット
 *   candidate = guess - off1                                … 一次近似の UTC 瞬間
 *   off2      = getZoneOffset(candidate)                    … 正しい側のオフセット
 *   result    = guess - off2
 * DST 境界を跨ぐと off1 と off2 が食い違うが、2 パス目で「候補瞬間の実オフセット」を
 * 使うため通常時刻は厳密に解ける。
 *
 * 【DST の穴・重なりの決定性(落とし穴リスト・テストで固定)】
 * - 春の「存在しない壁時計」(例 America/New_York 2026-03-08 02:30。ローカルは 02:00→03:00 に
 *   飛び 02:30 は実在しない): この 2 パス方式では結果が 2026-03-08T06:30Z になる。
 *   これは遷移(07:00Z)より前=EST 側で、壁時計に直すと 01:30 EST に当たる
 *   (「穴」の直前側へ倒れる)。RFC が一意に定める値ではない実装依存挙動。
 * - 秋の「2 回現れる壁時計」(例 2026-11-01 01:30。ローカルは 02:00→01:00 に戻り 01:30 が
 *   2 度現れる): 結果は 2026-11-01T05:30Z=「最初の出現(EDT 側)」に解決される。
 * どちらも決定的だが RFC が一意に定める値ではないので、テストで実測値を固定し
 * このコメントに明記する(ICU/tzdb 更新で値が変わったら気づけるように)。
 */
export function localFieldsToEpochMillis(fields: LocalFields, ianaId: string): number {
	// うるう秒 60 は Date.UTC が分へ繰り上げるので計算時のみ 59 にクランプ
	// (cal-date-time.ts の toEpochMillis と同じ方針: 保持は 60・計算時 59)。
	const sec = fields.second === 60 ? 59 : fields.second;
	const guess = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, sec);
	const off1 = getZoneOffsetMillis(ianaId, guess);
	const candidate = guess - off1;
	const off2 = getZoneOffsetMillis(ianaId, candidate);
	return guess - off2;
}

/**
 * localFieldsToEpochMillis の逆変換: UTC エポックミリ秒 → 指定ゾーンでの壁時計フィールド。
 *
 * 【2026-07-24 追加理由】create-event の「時刻付きイベントで end 省略時に start+1h を補完する」
 * 機能のために必要になった(壁時計を保ったまま TZID 付き VEventDateValue を組み直すには、
 * 「start の壁時計に1時間足した後の壁時計」が要る — epoch を直接 ICS の raw 文字列にはできない)。
 * これまで instant.ts はローカル→UTC の一方向しか公開していなかった(getZoneOffsetMillis は
 * オフセット計算の内部部品であり、フィールド分解までは外に出していなかった)ので、既存の
 * formatterFor キャッシュをそのまま再利用する形で対称の変換を追加する。
 *
 * DST 境界(繰り返し/欠落する壁時計)は generic に発生しうるが、この関数はある1瞬間(一意)を
 * 入力に取るので localFieldsToEpochMillis のような多義性の問題は無い — Intl が返す壁時計は
 * その瞬間について一意に決まる。
 */
export function epochMillisToLocalFields(utcMillis: number, ianaId: string): LocalFields {
	const parts = formatterFor(ianaId).formatToParts(new Date(utcMillis));
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const p = parts.find((x) => x.type === type);
		return p !== undefined ? Number(p.value) : 0;
	};
	return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/**
 * CalDateTime → UTC エポックミリ秒。kind で分岐する。
 *
 * @param opts.zoneOf           zoned の TZID を IANA 名へ解決する関数(resolver 経由を注入)。
 *                              値オブジェクトは TZID の生文字列しか持たないので、解決は外から渡す。
 * @param opts.floatingTimeZone floating を解釈するゾーン。**既定 "UTC"**(下記)。
 *
 * 【floating の既定を "UTC" と明示する理由(RFC 4791 §7.3 / 08 §3)】
 * §7.3 は floating の解決を「①リクエストの timezone → ②calendar-timezone プロパティ →
 * ③どちらも無ければサーバー任意(MAY)」と定める。③の「任意」を暗黙にせず UTC と固定する
 * (Home Assistant の前日ズレ事故の型を避ける)。呼び出し側が calendar-timezone を持っていれば
 * floatingTimeZone にそれを渡して上書きする設計。
 */
export function calDateTimeToEpochMillis(
	dt: CalDateTime,
	opts: { zoneOf: (tzid: string) => string; floatingTimeZone?: string },
): number {
	switch (dt.kind) {
		case "utc":
			// 既に絶対時刻。values 層の toEpochMillis を再利用(うるう秒クランプもそちらに含む)。
			return toEpochMillis(dt);
		case "zoned":
			// TZID → IANA 名を解決してから壁時計を UTC 化。
			return localFieldsToEpochMillis(dt, opts.zoneOf(dt.tzid));
		case "floating": {
			// 既定 UTC(暗黙にしない)。呼び出し側が calendar-timezone 等を持てば上書きされる。
			const zone = opts.floatingTimeZone ?? "UTC";
			return localFieldsToEpochMillis(dt, zone);
		}
	}
}

/**
 * CalDate(終日の日付)→ そのゾーンでの現地 00:00 の UTC エポックミリ秒。
 * DATE 値の「実効瞬間」は §9.9 で「現地 00:00」なので、時分秒 0 で localFieldsToEpochMillis。
 * どのゾーンで 00:00 とみなすかは呼び出し側が決める(floating と同じく既定 UTC を渡す想定)。
 */
export function calDateStartEpochMillis(d: CalDate, timeZone: string): number {
	return localFieldsToEpochMillis({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 }, timeZone);
}
