// =============================================================================
// PUT precondition 検証(ドメインサービス)— RFC 4791 §5.3.2.1
// =============================================================================
//
// 【責務】カレンダーオブジェクトリソースの PUT(新規作成 / 更新)が満たすべき
// precondition を判定し、違反を **値の配列** で返す。HTTP ステータス(403/409)や
// DAV:error XML の組み立ては presentation 層の関心事であり、ここでは一切扱わない
// (03 §2「PROPFIND/REPORT のモデル上の位置づけ」= プロトコル語彙への写像は presentation)。
//
// 【なぜ throw ではなく配列で返すのか】
// semantics 層の validate() と同じ理由(ical/semantics/errors.ts)。§5.3.2.1 の応答は
// DAV:error 直下に「該当した precondition 要素」を列挙する設計で、「最初の1個」より
// 「見つかった全部」を返せたほうがクライアントに親切。よって PreconditionViolation[] を積む。
//
// 【集約横断情報(no-uid-conflict)は関数注入で受ける — ポートの先取りをしない】
// no-uid-conflict(R4)は「同一コレクション内の他リソースの UID」を知る必要がある
// = CalendarObjectResource 集約をまたぐ情報。ここでリポジトリ interface(ポート)を
// 定義して import すると、domain 層に「永続化を引く」責務が漏れ、かつ application 層が
// 決めるべきポートの形を domain が先に固めてしまう。そこで「同 UID を持つ他リソースの uri を
// 引く関数」「対象 uri の既存 UID を引く関数」を **引数(コールバック)** として受け取り、
// その実体(D1 を引く等)は application 層が渡す。domain は「何が必要か」だけを型で示す。
// =============================================================================

import type { Component } from "../ical/structure/types";
import { ICalendarObject, ParseError, parse } from "../ical";
import type { ComponentKind, ResourceUri } from "./values";
import { parseComponentKind } from "./values";

// -----------------------------------------------------------------------------
// precondition 名(RFC 4791 §5.3.2.1 の全 11 個)
// -----------------------------------------------------------------------------
// 型で列挙しておくことで、presentation 層が DAV:error 要素名へ 1:1 マッピングできる。
// 実装済み/未実装は checkPutPreconditions のコメント参照。
// 注意(2026-07-09 原文再照合・05 参照): §5.3.2.1 の表題は "for PUT, COPY, and MOVE" で
// 11 個列挙されるが、**PUT に適用されるのは 10 個**。calendar-collection-location-ok は
// 「COPY/MOVE で Request-URI がカレンダーコレクション自体のとき」専用で PUT では発生しない。
// 型には 1:1 マッピングのため 11 個全部を残す(COPY/MOVE を将来実装したとき使う)。
export type PreconditionName =
	| "supported-calendar-data" //  メディアタイプが text/calendar か(presentation で判定するのが自然。ここでは通常出さない)
	| "valid-calendar-data" //      iCalendar として構文が妥当か(parse 成功)
	| "valid-calendar-object-resource" // §4.1 の制約(R1/R3/R7)+ RFC 5545 の妥当性(I1〜I10)
	| "supported-calendar-component" // コレクションの supported-calendar-component-set に合うか(R2)
	| "no-uid-conflict" //          UID 重複 / UID 変更(R4)
	| "calendar-collection-location-ok" // COPY/MOVE 専用(PUT には適用されない — 上の注意書き参照)
	| "max-resource-size" //        リソースのオクテットサイズ上限(サーバーポリシー)
	| "min-date-time" //            最古日時の下限(サーバーポリシー・要日時展開)
	| "max-date-time" //            最新日時の上限(サーバーポリシー・要日時展開)
	| "max-instances" //            繰り返し展開後のインスタンス数上限(サーバーポリシー・要 RecurrenceExpansion)
	| "max-attendees-per-instance"; //  1インスタンスあたり ATTENDEE 数上限(サーバーポリシー)

/** どの R 番号(03 §2 の不変条件表)に対応するか。診断・テストで追跡しやすくするための任意タグ。 */
export type ResourceRule = "R1" | "R2" | "R3" | "R4" | "R7";

/**
 * precondition 違反。1件 = DAV:error 直下の1要素に対応。
 * - precondition: どの precondition に該当したか(presentation が要素名へ写像)。
 * - detail: 人間可読の理由(RFC 節番号入り推奨)。
 * - rule: 対応する R 番号(あれば)。
 * - conflictHref: no-uid-conflict のとき、衝突相手リソースの uri(§5.3.2.1: DAV:href で返す SHOULD)。
 *
 * InvariantViolation(ical/semantics)を継承しない理由: あちらは RFC 5545 の不変条件、
 * こちらは RFC 4791 の precondition と、別 RFC・別語彙。型を分けて presentation の写像を明確にする。
 */
export class PreconditionViolation {
	constructor(
		readonly precondition: PreconditionName,
		readonly detail: string,
		readonly rule?: ResourceRule,
		readonly conflictHref?: ResourceUri,
	) {}

	toString(): string {
		const r = this.rule ? ` (${this.rule})` : "";
		return `[${this.precondition}${r}] ${this.detail}`;
	}
}

// -----------------------------------------------------------------------------
// サーバーポリシー(上限系 precondition の閾値)
// -----------------------------------------------------------------------------
/**
 * 上限系 precondition の設定。すべて任意で、未指定 = その上限を課さない(無制限)。
 *
 * 【当面の位置づけ】max-resource-size 以外は「繰り返し展開後のインスタンス数」や
 * 「日時の絶対範囲」を要し、RecurrenceExpansion(ical §1-4・未実装)や日時解決が前提になる。
 * よって現状は **形(型)だけ用意し、max-resource-size のみ実判定** する。残りは閾値を渡しても
 * 現状は評価されない(将来 expansion 実装時に有効化する)。この「形だけ先に置く」判断の理由:
 * precondition 名の集合を最初から型で固定しておけば、後から実装を足すときに presentation の
 * 写像表を作り直さずに済むため。
 */
export interface ServerPolicy {
	/** リソース ICS のオクテット長上限(バイト)。未指定なら無制限。 */
	maxResourceSize?: number;
	/** 許容する最古の日時(未実装: 要日時展開)。 */
	minDateTime?: never;
	/** 許容する最新の日時(未実装: 要日時展開)。 */
	maxDateTime?: never;
	/** 繰り返し展開後のインスタンス数上限(未実装: 要 RecurrenceExpansion)。 */
	maxInstances?: never;
	/** 1インスタンスあたり ATTENDEE 上限(未実装)。 */
	maxAttendeesPerInstance?: never;
}

/** 既定ポリシー = 無制限。当面の既定値(コア価値は RFC 準拠 + iOS 対応で、上限は後回し)。 */
export const UNLIMITED_POLICY: ServerPolicy = {};

// -----------------------------------------------------------------------------
// checkPutPreconditions の入力
// -----------------------------------------------------------------------------
export interface PutPreconditionInput {
	/** PUT 本文(格納しようとしている ICS のオクテット列)。 */
	ics: string;
	/** 置き先のリソース URI(コレクション内の名前)。no-uid-conflict の「自分自身」判定に使う。 */
	targetUri: ResourceUri;
	/**
	 * コレクションが受け入れるコンポーネント種別。
	 * undefined = supported-calendar-component-set プロパティ不在 = **全種別受理 MUST**(R2/§5.2.3)。
	 */
	supportedComponents?: readonly ComponentKind[];
	/**
	 * 同 UID を持つ「他の」リソースの uri を引く関数(集約横断・関数注入。冒頭コメント参照)。
	 * 無ければ undefined を返す。実装(D1 を引く等)は application 層が渡す。
	 */
	findUidOwner: (uid: string) => ResourceUri | undefined;
	/**
	 * targetUri に現在存在するリソースの UID を引く関数(更新時の UID 変更検出用)。
	 * 新規作成(未マップ URI への PUT)なら undefined を返す。
	 */
	existingUidAt: (uri: ResourceUri) => string | undefined;
	/** 上限系ポリシー(省略時 UNLIMITED_POLICY)。 */
	policy?: ServerPolicy;
}

// -----------------------------------------------------------------------------
// メイン: PUT precondition を順に判定
// -----------------------------------------------------------------------------
/**
 * PUT precondition を判定して違反配列を返す(空 = 全通過)。
 *
 * 判定順序には意味がある: parse 不能(valid-calendar-data)なら以降は判定不能なので即返す。
 * それ以外は互いに独立なので全部評価して「見つかった全違反」を積む。
 */
export function checkPutPreconditions(input: PutPreconditionInput): PreconditionViolation[] {
	const violations: PreconditionViolation[] = [];

	// --- valid-calendar-data: まず parse できるか(§4.1 の前に構文が妥当であること)------
	let obj: ICalendarObject;
	try {
		const component = parse(input.ics);
		// parse はトップレベル単一を強制するが、VCALENDAR 以外(BEGIN:VEVENT が直接来た等)は
		// fromComponent が throw する。これも「構文としては読めても iCalendar オブジェクトでない」
		// = valid-calendar-data 違反として扱う。
		obj = ICalendarObject.fromComponent(component);
	} catch (e) {
		if (e instanceof ParseError) {
			return [new PreconditionViolation("valid-calendar-data", `iCalendar parse failed: ${e.message}`)];
		}
		// fromComponent の「VCALENDAR でない」等。ParseError 以外の Error はここで valid-calendar-data に写す。
		return [new PreconditionViolation("valid-calendar-data", `not a valid VCALENDAR object: ${(e as Error).message}`)];
	}

	// --- valid-calendar-object-resource: R1 + R3 + R7 + I1〜I10 -----------------------
	violations.push(...checkValidCalendarObjectResource(obj));

	// --- supported-calendar-component: R2 ---------------------------------------------
	violations.push(...checkSupportedComponent(obj, input.supportedComponents));

	// --- no-uid-conflict: R4 ----------------------------------------------------------
	violations.push(...checkNoUidConflict(obj, input.targetUri, input.findUidOwner, input.existingUidAt));

	// --- max-resource-size(サーバーポリシー・実判定するのはこれだけ)------------------
	const maxSize = input.policy?.maxResourceSize;
	if (maxSize !== undefined) {
		// オクテット長で判定(§5.3.2.1: max-resource-size はサイズ上限)。UTF-8 バイト数で数える
		// — 「文字数」ではなく「格納オクテット列」の大きさが問われるため。
		const octets = new TextEncoder().encode(input.ics).length;
		if (octets > maxSize) {
			violations.push(
				new PreconditionViolation("max-resource-size", `resource is ${octets} octets, exceeds max ${maxSize}`),
			);
		}
	}

	return violations;
}

// -----------------------------------------------------------------------------
// valid-calendar-object-resource(R1 / R3 / R7 / I1〜I10)
// -----------------------------------------------------------------------------
/**
 * リソースの **構造的** 内在制約 R1/R3/R7 だけを判定する(CalDAV §4.1)。
 * iCalendar の値レベルの妥当性(I1〜I10)は含まない。
 *
 * 【なぜ R1/R3/R7 と I1〜I10 を分けるのか — 呼び出し側の責務差】
 *   - fromIcs(CalendarObjectResource ファクトリ)は「格納オクテット列をロスレスに抱える
 *     リソースが作れるか」だけを問う。R1/R3/R7(単一種別・単一 UID・METHOD 無し)が満たされれば
 *     uri/etag/uid/componentKind は一意に定まり、リソースとして成立する。TZID 参照切れ(I8)等の
 *     iCalendar 値の不備があっても、データは丸ごと保存でき ETag も計算できる(往復は壊れない)。
 *     よって fromIcs は R1/R3/R7 のみを課す(タスク仕様: fromIcs は R1/R3/R7 を検証)。
 *   - checkPutPreconditions の valid-calendar-object-resource は「PUT を受理してよいか」なので、
 *     R1/R3/R7 に加えて I1〜I10(iCalendar 値の妥当性)まで見る(下の checkValidCalendarObjectResource)。
 *
 * ※「VCALENDAR は1つ」(R1 の一部)は parse 層がトップレベル単一を強制済みで、ここへは
 *   VCALENDAR 1個の状態でしか来ない。
 */
export function checkResourceStructure(obj: ICalendarObject): PreconditionViolation[] {
	const violations: PreconditionViolation[] = [];

	// 非 VTIMEZONE の主コンポーネント群(VEVENT/VTODO や、未サポートの VJOURNAL 等も含む生の Component)。
	const primaries = nonTimezoneComponents(obj);

	// --- R1: 種別は1種類のみ ----------------------------------------------------------
	// primaries が空(VTIMEZONE だけ、または空 VCALENDAR)も「主コンポーネント不在」として R1 違反にする
	// — カレンダーオブジェクトリソースは中身の主コンポーネントを必ず1種持つ、という前提。
	const kinds = new Set(primaries.map((c) => c.name));
	if (kinds.size === 0) {
		violations.push(
			new PreconditionViolation("valid-calendar-object-resource", "no calendar component (only VTIMEZONE or empty) (§4.1)", "R1"),
		);
	} else if (kinds.size > 1) {
		violations.push(
			new PreconditionViolation(
				"valid-calendar-object-resource",
				`resource must contain a single component type, found: ${[...kinds].join(", ")} (§4.1/§9.6)`,
				"R1",
			),
		);
	}

	// --- R3: 全コンポーネント同一 UID -------------------------------------------------
	// マスター + RECURRENCE-ID オーバーライドは「同一 UID の VEVENT が複数」並ぶのが正(§3.8.4.4)。
	// よって「UID が複数種あるか」だけを見る(件数ではなく distinct UID 数)。
	const uids = new Set<string>();
	let missingUid = false;
	for (const c of primaries) {
		const uid = propValue(c, "UID");
		if (uid === undefined) missingUid = true;
		else uids.add(uid);
	}
	if (uids.size > 1) {
		violations.push(
			new PreconditionViolation("valid-calendar-object-resource", `all components must share one UID, found: ${[...uids].join(", ")} (§4.1)`, "R3"),
		);
	}
	// UID 欠落そのものは I2(iCalendar)側でも報告されるが、R3 の文脈(「同一 UID」)としても
	// 一言残す。ただし primaries が空のときは R1 で既に報告済みなので二重にしない。
	if (missingUid && primaries.length > 0 && uids.size <= 1) {
		violations.push(
			new PreconditionViolation("valid-calendar-object-resource", "a component is missing UID (§4.1/§3.6.1)", "R3"),
		);
	}

	// --- R7: METHOD MUST NOT ----------------------------------------------------------
	// METHOD 付き = iTIP メッセージ。通常コレクションのリソースには入らない(§4.1)。
	if (obj.method !== undefined) {
		violations.push(
			new PreconditionViolation("valid-calendar-object-resource", `resource must not contain a METHOD property (found ${obj.method}) (§4.1)`, "R7"),
		);
	}

	return violations;
}

/**
 * valid-calendar-object-resource の完全判定 = 構造(R1/R3/R7)+ iCalendar 値の妥当性(I1〜I10)。
 * checkPutPreconditions から呼ぶ。fromIcs は使わない(上の checkResourceStructure だけ使う)。
 *
 * I1〜I10 は ical/semantics の validate() が返す全違反を valid-calendar-object-resource へ写す
 * (タスク指定: I1〜I10 の違反はこの precondition に集約)。invariant 番号は detail 先頭に残す。
 */
export function checkValidCalendarObjectResource(obj: ICalendarObject): PreconditionViolation[] {
	const violations = checkResourceStructure(obj);
	for (const iv of obj.validate()) {
		violations.push(
			new PreconditionViolation("valid-calendar-object-resource", `${iv.invariant} ${iv.component}: ${iv.message}`),
		);
	}
	return violations;
}

// -----------------------------------------------------------------------------
// supported-calendar-component(R2)
// -----------------------------------------------------------------------------
/**
 * コレクションが受け入れる種別か判定(§5.2.3)。
 * supported が undefined(プロパティ不在)なら全種別受理 MUST → 違反ゼロ。
 * それ以外は、リソースの主コンポーネント種別が supported に含まれるか、および
 * そもそも本サーバーがサポートする種別(VEVENT/VTODO)か、を見る。
 */
export function checkSupportedComponent(
	obj: ICalendarObject,
	supported: readonly ComponentKind[] | undefined,
): PreconditionViolation[] {
	const violations: PreconditionViolation[] = [];
	const primaries = nonTimezoneComponents(obj);
	// 主コンポーネントの distinct 種別名。R1 が別途「1種のみ」を見るので通常 1 要素だが、
	// R1 違反時でも各種別について supported 判定はしておく(全違反を集める方針)。
	const kinds = new Set(primaries.map((c) => c.name));

	for (const name of kinds) {
		const kind = parseComponentKind(name);
		if (kind === undefined) {
			// VJOURNAL 等、本サーバー未サポートの種別。supported の指定に関わらず受けられない。
			violations.push(
				new PreconditionViolation("supported-calendar-component", `component ${name} is not supported by this server (§5.2.3)`, "R2"),
			);
			continue;
		}
		// supported 指定があり、その中に無ければ違反。undefined(不在)なら全受理でスキップ。
		if (supported !== undefined && !supported.includes(kind)) {
			violations.push(
				new PreconditionViolation(
					"supported-calendar-component",
					`collection does not accept ${kind} (accepts: ${supported.join(", ")}) (§5.2.3)`,
					"R2",
				),
			);
		}
	}
	return violations;
}

// -----------------------------------------------------------------------------
// no-uid-conflict(R4)
// -----------------------------------------------------------------------------
/**
 * UID 重複・UID 変更を判定(§4.1/§5.3.2.1)。
 *   (a) 新リソースの UID を、同一コレクション内の「別の」リソースが既に使っている → 衝突
 *       → 衝突相手 uri を conflictHref に載せる(SHOULD)
 *   (b) targetUri に既存リソースがあり、その UID を別 UID に変えようとしている → 禁止(更新で UID 変更不可)
 *
 * UID 導出は R3 が通っている前提(単一 UID)。R3 違反時は UID が定まらないので、
 * ここでは「最初に見つかった UID」を代表として使う(R4 判定はベストエフォート・
 * どのみち R3 違反で PUT は拒否される)。
 */
export function checkNoUidConflict(
	obj: ICalendarObject,
	targetUri: ResourceUri,
	findUidOwner: (uid: string) => ResourceUri | undefined,
	existingUidAt: (uri: ResourceUri) => string | undefined,
): PreconditionViolation[] {
	const violations: PreconditionViolation[] = [];
	const newUid = firstUid(obj);
	if (newUid === undefined) {
		// UID が全く無い。R1/R3/I2 側で報告されるので、ここでは UID 衝突判定を行わない。
		return violations;
	}

	// (a) 別リソースが同 UID を保持しているか。
	const owner = findUidOwner(newUid);
	if (owner !== undefined && owner !== targetUri) {
		violations.push(
			new PreconditionViolation(
				"no-uid-conflict",
				`UID "${newUid}" is already used by another resource`,
				"R4",
				owner, // DAV:href で返す衝突相手(§5.3.2.1 SHOULD)
			),
		);
	}

	// (b) 更新時の UID 変更禁止。
	const existingUid = existingUidAt(targetUri);
	if (existingUid !== undefined && existingUid !== newUid) {
		violations.push(
			new PreconditionViolation(
				"no-uid-conflict",
				`cannot change UID of existing resource (was "${existingUid}", now "${newUid}")`,
				"R4",
			),
		);
	}

	return violations;
}

// -----------------------------------------------------------------------------
// 共有ヘルパー(fromIcs からも使う種別/UID 導出)
// -----------------------------------------------------------------------------

/** VCALENDAR 直下の、VTIMEZONE を除いた主コンポーネント群(生 Component)。 */
export function nonTimezoneComponents(obj: ICalendarObject): readonly Component[] {
	return obj.raw.components.filter((c) => c.name !== "VTIMEZONE");
}

/**
 * リソースの主コンポーネント種別(VEVENT/VTODO)を導出する。
 * R1 が通っていれば1種に定まる。定まらない/未サポート種別なら undefined
 * (呼び出し側 = fromIcs はこれを「構築不能」として扱う)。
 */
export function resourceComponentKind(obj: ICalendarObject): ComponentKind | undefined {
	const kinds = new Set(nonTimezoneComponents(obj).map((c) => c.name));
	if (kinds.size !== 1) return undefined;
	const [only] = [...kinds];
	return parseComponentKind(only!);
}

/** リソースの UID(R3 が通っていれば単一)。primaries の最初の UID を返す。 */
export function firstUid(obj: ICalendarObject): string | undefined {
	for (const c of nonTimezoneComponents(obj)) {
		const uid = propValue(c, "UID");
		if (uid !== undefined) return uid;
	}
	return undefined;
}

/** Component から指定プロパティ(大文字正規化済み前提)の生値を1つ引く。 */
function propValue(c: Component, name: string): string | undefined {
	const p = c.properties.find((prop) => prop.name === name);
	return p?.value;
}
