// =============================================================================
// CalendarObjectResource — RFC 4791 §4.1 カレンダーオブジェクトリソース(集約ルート)
// =============================================================================
//
// 「URL(コレクション内の名前)を持つ1個のカレンダーデータ」。中身は iCalendar コンテキストの
// 集約 ICalendarObject(VCALENDAR)。DAV の都合(uri / etag)を iCalendar 側に持ち込まず、
// この層が iCalendar を payload として抱える(コンテキスト境界。iCalendar は最も内側・03 §2)。
//
// 【集約境界(03 §2 の設計決定)】
// CalendarCollection とは別集約。コレクションはこのリソースを ID(uri)参照するだけで抱え込まない
// (数千件で集約が肥大するのを避ける)。PUT/DELETE 時にコレクションの sync を進める整合性は
// application 層が両集約を1トランザクションで更新して担保する。
//
// 【イミュータブル(readonly)にした判断】
// このリソースは「PUT のたびに丸ごと差し替わる」もので、フィールド単位の部分更新が無い
// (ICS が変われば etag も payload も uid も componentKind も一斉に変わる)。よって可変にする
// 動機が無く、readonly の生成物として扱う。更新は「新しい ICS で fromIcs し直す」= 新インスタンス。
// これは structure/semantics 層がイミュータブルなレンズである方針とも揃う。
// =============================================================================

import { ICalendarObject, parse } from "../ical";
import { ETag, computeETag } from "./values";
import type { ComponentKind, ResourceUri } from "./values";
import {
	PreconditionViolation,
	checkResourceStructure,
	resourceComponentKind,
	firstUid,
} from "./put-preconditions";

/**
 * fromIcs が「リソースとして成立しない ICS」を渡されたときに投げる例外。
 * 内包する violations は put-preconditions と同じ型なので、application 層は
 * これをそのまま PUT 応答(DAV:error)の材料に転用できる。
 *
 * 【なぜ fromIcs は throw で、checkPutPreconditions は配列返しなのか】
 * checkPutPreconditions は「PUT を受理してよいか」の事前診断(全違反を集めてクライアントへ提示)。
 * fromIcs は「妥当なリソースが必ず出来る」ことを型で保証する狭いファクトリで、成立しない入力は
 * 呼び出しの前提違反 = 例外にするのが自然(戻り値の union で毎回分岐させるとドメインが読みにくい)。
 * 通常フローでは application 層が先に checkPutPreconditions を通し、通過後に fromIcs を呼ぶので
 * この例外は基本的に発生しない(防御的なガード)。
 */
export class InvalidResourceError extends Error {
	constructor(readonly violations: PreconditionViolation[]) {
		super(`invalid calendar object resource: ${violations.map((v) => v.detail).join("; ")}`);
		this.name = "InvalidResourceError";
	}
}

export class CalendarObjectResource {
	private constructor(
		/** コレクション内で一意な名前(例 "{uid}.ics")。集約の同一性。 */
		readonly uri: ResourceUri,
		/** 強い ETag。rawIcs のオクテット列から算出(下記 fromIcs)。 */
		readonly etag: ETag,
		/** 格納オクテット列そのもの(ETag の源・ロスレス往復の実体)。GET でそのまま返せる。 */
		readonly rawIcs: string,
		/** iCalendar コンテキストの集約(型付きレンズ)。中身へ型安全にアクセスする窓口。 */
		readonly payload: ICalendarObject,
		/** 主コンポーネント種別(VEVENT/VTODO)。R2 判定や getcontenttype 決定に使う。 */
		readonly componentKind: ComponentKind,
		/** リソースの UID(R3 により単一)。no-uid-conflict のキー。 */
		readonly uid: string,
	) {}

	/**
	 * ICS 文字列からリソースを構築するファクトリ。
	 *   1. parse(ParseError はそのまま伝播 — 通常フローでは事前に checkPutPreconditions が弾く)
	 *   2. リソース内在の妥当性(R1/R3/R7 + I1〜I10)を検証。違反があれば InvalidResourceError。
	 *   3. componentKind / uid を導出
	 *   4. etag を rawIcs から計算(async)
	 *
	 * rawIcs には **引数の ics をそのまま** 保持する(再シリアライズしない)。理由: ETag は
	 * 「格納オクテット列」のハッシュであり、GET でクライアントへ返すのもこの同じオクテット列。
	 * 再シリアライズを挟むと折り畳み位置やプロパティ順が変わりうる = ETag と往復が壊れる
	 * (RFC 4791 §5.3.4「書き換えたら PUT 応答で ETag を返しては MUST NOT」)。
	 */
	static async fromIcs(uri: ResourceUri, ics: string): Promise<CalendarObjectResource> {
		// 1. parse → VCALENDAR レンズ。ParseError は伝播させる(冒頭コメントの方針)。
		const obj = ICalendarObject.fromComponent(parse(ics));

		// 2. リソースの構造制約 R1/R3/R7 のみ(コレクション非依存)。put-preconditions と共有。
		//    I1〜I10(iCalendar 値の妥当性)はここでは課さない — リソースはロスレスに格納でき ETag も
		//    計算できるので、値の不備(TZID 参照切れ等)があってもリソースとしては成立する。
		//    値レベルの検査は PUT 受理判定(checkPutPreconditions)の valid-calendar-object-resource が担う。
		const violations = checkResourceStructure(obj);
		if (violations.length > 0) {
			throw new InvalidResourceError(violations);
		}

		// 3. 種別 / UID 導出(2 を通過しているので単一に定まる)。
		const kind = resourceComponentKind(obj);
		const uid = firstUid(obj);
		if (kind === undefined || uid === undefined) {
			// 理論上ここへは来ない(2 で R1/R3 を通過済み)が、型を絞るための防御。
			throw new InvalidResourceError([
				new PreconditionViolation("valid-calendar-object-resource", "could not derive component kind or UID"),
			]);
		}

		// 4. ETag = SHA-256(格納オクテット列)。ics をそのまま源にする。
		const etag = await computeETag(ics);

		return new CalendarObjectResource(uri, etag, ics, obj, kind, uid);
	}
}
