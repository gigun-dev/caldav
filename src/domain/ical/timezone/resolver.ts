// =============================================================================
// timezone/resolver — TZID → IANA タイムゾーン名の解決チェーン(docs/modeling/08 §6-2)
// =============================================================================
//
// 【この層の責務】
// CalDateTime の zoned 形態が持つ TZID(生文字列。中身は未検証 — cal-date-time.ts の
// 設計)を、実際にオフセット計算できる IANA 名(例 "Asia/Tokyo")へ落とす。
// オフセット計算そのものは instant.ts(Intl/ICU)の責務で、ここは「名前の解決」だけ。
//
// 【なぜ解決チェーンが要るか(08 §3 の流派決着)】
// 「IANA tzdb を正、VTIMEZONE は保存のみ」が業界標準(sabre / Stalwart / Xandikos)。
// しかしクライアントが TZID に入れてくる文字列は IANA 名とは限らない:
//   - Outlook/Exchange: Windows 名("Tokyo Standard Time")
//   - libical/Lightning: "/mozilla.org/20070129_1/Asia/Tokyo" のようなグローバル一意
//     プレフィックス付き(RFC 5545 §3.2.19)。X-LIC-LOCATION に IANA 名を併記する。
// sabre/vobject の TimeZoneUtil も「①IANA 直引き → ②Windows 名マップ → ③VTIMEZONE の
// X-LIC-LOCATION 等からの推測 → ④明示エラー」の順で解く(08 §3)。本作もこれに倣う。
//
// 【暗黙フォールバック禁止(08 §3 落とし穴リスト)】
// 全て外れたら勝手に UTC 等へ倒さず TimezoneResolutionError を throw する。Home Assistant の
// 「終日イベントが EST で前日 20 時開始」型の事故は、解決失敗を暗黙フォールバックで
// 握り潰したことが原因。ここで例外にすれば application 層が precondition エラーへ写像できる。
// =============================================================================

import type { VTimezone } from "../semantics/vtimezone";
import { rawValue } from "../semantics/helpers";
import { TimezoneResolutionError } from "./errors";
import { windowsToIana } from "./windows-zones";

/**
 * 解決結果。どの経路で解けたか(via)も返す — デバッグ・ログ・テストで
 * 「意図した経路で解けているか」を確認できるようにするため(暗黙の Windows/推測経路に
 * 気づかず依存する事故を防ぐ)。
 */
export type TimezoneResolution = {
	/** 解決後の IANA 名(Intl.DateTimeFormat に渡せる)。 */
	ianaId: string;
	/** 解決経路。 iana=直引き / windows=Windows 名マップ / x-lic-location=VTIMEZONE の X-LIC-LOCATION / tzid-suffix=グローバル一意プレフィックスの末尾から推測。 */
	via: "iana" | "windows" | "x-lic-location" | "tzid-suffix";
};

// isValidIanaZone の結果キャッシュ。Intl.DateTimeFormat のインスタンス生成は安くないので、
// 「この文字列は IANA ゾーンとして valid か」の真偽値だけを Map に貯める。
// ゾーン名の集合は有限(tzdb で数百)なので Map が無限に膨らむ心配はない。
const validZoneCache = new Map<string, boolean>();

/**
 * 文字列が IANA タイムゾーン名として有効かを判定する。
 *
 * 判定は「Intl.DateTimeFormat に timeZone として渡して例外が出ないか」で行う
 * (ICU の tzdb がゾーンを知っているかの実挙動をそのまま使う。学習済み知識で
 * ゾーン一覧をハードコードしない — tzdb は週次更新される)。
 * 空文字・不正名は RangeError を投げるので false。結果は Map でキャッシュ。
 */
export function isValidIanaZone(id: string): boolean {
	// 空文字は Intl が「システム既定ゾーン」に化けることがある実装差を避けるため即 false。
	if (id === "") return false;
	const cached = validZoneCache.get(id);
	if (cached !== undefined) return cached;
	let ok: boolean;
	try {
		// timeZone が未知なら RangeError。これが唯一の「妥当性」判定手段(ICU 内蔵 tzdb 準拠)。
		new Intl.DateTimeFormat("en-US", { timeZone: id });
		ok = true;
	} catch {
		ok = false;
	}
	validZoneCache.set(id, ok);
	return ok;
}

/**
 * TZID → IANA 名の解決(08 §6-2 の4段チェーン)。
 *
 * @param tzid       CalDateTime.zoned が持つ生の TZID(未検証文字列)。
 * @param vtimezone  同一 VCALENDAR 内の対応 VTIMEZONE レンズ(あれば)。③の推測材料。
 * @throws TimezoneResolutionError 全段外れたとき(暗黙フォールバックしない)。
 *
 * 解決順:
 *  ① IANA 直引き: tzid そのもの / 先頭 "/" を剥がしたもの(§3.2.19 グローバル一意プレフィックス)。
 *  ② Windows 名マップ: windowsToIana(tzid)。
 *  ③ VTIMEZONE 推測: (a) X-LIC-LOCATION の値(libical/Lightning が埋める IANA 名)
 *                     (b) tzid を "/" 分割し末尾 2〜3 セグメントの "Area/Location" を試す。
 *  ④ 全滅 → throw。
 */
export function resolveTimeZoneId(tzid: string, vtimezone?: VTimezone): TimezoneResolution {
	// --- ① IANA 直引き ------------------------------------------------------
	// まず素の tzid。次に先頭 "/" を剥がしたもの。RFC 5545 §3.2.19 は「グローバルに
	// 一意な TZID は "/" で始めてよい」と定めており、"/Asia/Tokyo" のような形が来る。
	// 先頭 "/" だけ剥がせば IANA 名になるケースを直引きの一部として拾う。
	if (isValidIanaZone(tzid)) {
		return { ianaId: tzid, via: "iana" };
	}
	if (tzid.startsWith("/")) {
		const stripped = tzid.slice(1);
		if (isValidIanaZone(stripped)) {
			return { ianaId: stripped, via: "iana" };
		}
	}

	// --- ② Windows 名マップ -------------------------------------------------
	// "Tokyo Standard Time" 等。windowsToIana は大文字小文字を無視して引く(表記ゆれ対策)。
	const win = windowsToIana(tzid);
	if (win !== undefined) {
		// 表の値は代表 IANA 名なので基本 valid だが、ICU のエイリアス差で外れる可能性を
		// 排除するため valid のときだけ採用する(外れたら以降の推測段へ落とす)。
		if (isValidIanaZone(win)) {
			return { ianaId: win, via: "windows" };
		}
	}

	// --- ③ VTIMEZONE からの推測 --------------------------------------------
	if (vtimezone !== undefined) {
		// (a) X-LIC-LOCATION: libical 系が VTIMEZONE に埋める IANA 名(例 "Asia/Tokyo")。
		// レンズ経由の型付きアクセサはこのプロパティに無いので raw から rawValue で読む
		// (X- 拡張プロパティは semantics 層のアクセサ対象外 — ロスレス保持の原則)。
		const xLic = rawValue(vtimezone.raw, "X-LIC-LOCATION");
		if (xLic !== undefined && isValidIanaZone(xLic)) {
			return { ianaId: xLic, via: "x-lic-location" };
		}
	}

	// (b) TZID 末尾からの "Area/Location" 推測。VTIMEZONE の有無に関わらず tzid 文字列だけで試せる。
	// 例 "/mozilla.org/20070129_1/Asia/Tokyo" → 末尾 2 セグメント "Asia/Tokyo" が valid。
	// "America/Argentina/Buenos_Aires" のような 3 セグメント地域もあるので 2 と 3 を試す。
	const segments = tzid.split("/").filter((s) => s !== "");
	// 長い候補(3)を先に試す: "America/Argentina/Buenos_Aires" を "Argentina/Buenos_Aires" と
	// 誤って 2 セグメントで拾わないため(2 セグメント側は invalid になるので実害は無いが、
	// 明示的に長い方を優先しておく)。
	for (const take of [3, 2]) {
		if (segments.length >= take) {
			const candidate = segments.slice(segments.length - take).join("/");
			if (isValidIanaZone(candidate)) {
				return { ianaId: candidate, via: "tzid-suffix" };
			}
		}
	}

	// --- ④ 全滅 → 明示エラー(暗黙フォールバック禁止。08 §3)---------------
	throw new TimezoneResolutionError(
		tzid,
		"not a valid IANA zone, not a known Windows zone name, " +
			"and no IANA name could be inferred from VTIMEZONE X-LIC-LOCATION or the TZID suffix",
	);
}
