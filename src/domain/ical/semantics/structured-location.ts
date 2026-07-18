// =============================================================================
// structured-location — 場所 / 会議 / proximity の read 派生(設計 05 §1・§2・C1)
// =============================================================================
//
// 【このファイルの位置づけ(read 専用・スキーマ変更ゼロ)】
// 設計 05(docs/design/05-location-and-conference.md・swift-mcp-app 側の正典)の意味モデル
// 「1つの入力欄に畳み込まれた3スロット(場所 / 会議 / 参照 URL)」を、既に本番 D1 にある
// Apple 拡張プロパティから**読み取るだけ**で派生させる純関数群。write(C8・author 規約)は
// このファイルの責務外。新プロパティは一切導入せず、iOS がワイヤに載せている生プロパティ
// (X-APPLE-STRUCTURED-LOCATION / X-APPLE-PROXIMITY / DESCRIPTION の「ビデオ通話」ブロック)を
// 走査して DTO 派生フィールドに畳む(設計 05 §2 の「読み取りは走査した派生フィールドを足すだけ」)。
//
// 【なぜ domain/semantics に置くか(application ではなく)】
// パースは「生プロパティ → 意味的な値」の変換であり、vevent-alarm.ts(開始相対 VALARM の
// 読み取りプリミティブ)と同じ層・同じ流儀。event-dto / task-dto の両方から共有され、かつ
// プラットフォーム非依存の純関数なので、semantics 層の共有カーネルに置くのが対称
// (event-dto.ts が startRelativeAlarmMinutesBefore を semantics から import するのと同じ構図)。
//
// 【degrade 方針(壊れた値で throw しない)】
// values/ 層・vevent-alarm.ts と同じく「1件の壊れた実データで list 全体を 500 にしない」。
// プロパティが在れば best-effort でオブジェクトを返し、個別フィールドがパース不能なら
// そのフィールドだけ null にする(オブジェクト全体を捨てない = 部分情報を温存)。プロパティ
// 自体が無ければ null。throw は一切しない(設計タスク C1 の「壊れた値は null に degrade」)。
// =============================================================================

import type { Component, Property } from "../structure/types";
import { decodeText } from "../values";
import { firstProp, paramFirst, subComponents } from "./helpers";

/**
 * 構造化された場所(設計 05 §2「場所」スロット)。X-APPLE-STRUCTURED-LOCATION から派生する。
 *
 * - title  : X-TITLE パラメータ(表示名。例「岐阜大学」「福登の自宅」)。decodeText 済み。無ければ null。
 * - address: X-ADDRESS パラメータ(住所。Apple は複数行を "\n" リテラルで畳んで入れてくる)。
 *   decodeText 済み(バックスラッシュエスケープ解除 → 実際の改行に戻る)。無ければ null。
 * - geo    : プロパティ値の `geo:lat,lon` URI(RFC 5870)から取った座標。パース不能・無しは null。
 * - radiusMeters: X-APPLE-RADIUS パラメータ(ジオフェンス半径・メートル)。数値化不能・無しは null。
 *
 * X-APPLE-MAPKIT-HANDLE は**読まない**(不透明 blob。設計 05 §1-b「read には X-TITLE / X-ADDRESS /
 * geo だけで足りる。MAPKIT-HANDLE は温存 pass-through」— 生プロパティは Component にそのまま
 * 残るのでロスレス往復は structure 層が担保する。ここで解釈しないだけ)。
 */
export interface StructuredLocation {
	title: string | null;
	address: string | null;
	geo: { lat: number; lon: number } | null;
	radiusMeters: number | null;
}

/**
 * proximity アラーム(設計 05 §1-a「vtodo 自宅到着時に通知」= geofence リマインダーの正体)。
 * VALARM のうち X-APPLE-PROXIMITY を持つものから派生する。
 *
 * - proximity: "ARRIVE"(到着時)| "DEPART"(出発時)。iOS はこの2値のみ送る。想定外の値は
 *   ARRIVE に倒す(型を2値 union に閉じるための安全側 default。DEPART だけ厳密判定する)。
 * - location : その VALARM 内の X-APPLE-STRUCTURED-LOCATION から派生した場所(同形)。
 *   structured-location が無い proximity VALARM でも、全フィールド null の場所を添えて返す
 *   (「位置トリガーはあるが座標が読めない」を握りつぶさず可視化する — degrade 方針)。
 */
export interface ProximityAlarm {
	proximity: "ARRIVE" | "DEPART";
	location: StructuredLocation;
}

/**
 * 会議 / 参照 URL の判別結果(設計 05 §1-c・§2「会議」スロット)。
 *
 * - url   : 「参加(Join)」として開くべき URL。
 * - source: "description"(DESCRIPTION の「ビデオ通話」区切りブロック由来)| "url"(URL プロパティ由来)。
 *
 * 会議でない(URL が message: 等の非 http・かつ DESCRIPTION に会議ブロックも無い)場合は null を返し、
 * その URL は「参照 URL」スロット(既存 Event.url の生値)のまま扱う(設計 05 §2)。
 */
export interface Conference {
	url: string;
	source: "url" | "description";
}

// -----------------------------------------------------------------------------
// StructuredLocation の読み取り
// -----------------------------------------------------------------------------

/**
 * X-APPLE-STRUCTURED-LOCATION プロパティ1つから StructuredLocation を派生する(best-effort)。
 * プロパティが在る前提で呼ぶ(在否判定は呼び出し側 readStructuredLocation / readProximityAlarm)。
 *
 * 【パラメータの折り返し・QUOTED 耐性はパーサーが吸収済み】
 * 実データは長い1行で来て RFC 5545 §3.1 の line folding(CRLF+WSP)で複数物理行に折られる
 * (設計 05 §1-a/§1-b の実例も折り返しあり)。parse/parser.ts の unfold が論理行に戻すので、
 * ここに来る時点で Property は連結済み。X-ADDRESS の QUOTED 形(`X-ADDRESS="〒..., ..."`・
 * カンマを含むため引用符で囲む)も、parser が DQUOTE を剥がして values[0] に1値で入れてくれる
 * (types.ts の Parameter 契約: quoted か否かはシリアライズ時に再決定するので保持しない)。
 * よってここでは paramFirst でそのまま読めば、非 QUOTED(`\n` 区切り)/QUOTED 両方に耐える。
 */
export function structuredLocationFromProperty(p: Property): StructuredLocation {
	// X-TITLE / X-ADDRESS はいずれも人間可読テキスト。Apple は住所を "501-1112\n岐阜県..." のように
	// バックスラッシュエスケープ("\n")で複数行を1パラメータに畳むので、TEXT の decode を通して
	// 実際の改行に戻す(§3.3.11 の decodeText。未知エスケープは寛容にそのまま = 壊れ耐性)。
	// パラメータ値の caret-encoding(RFC 6868)は iOS 実データで観測されないため対象外
	// (観測されたら追加する。今は Apple が使う "\n" 流儀だけ解く — 過剰実装しない)。
	return {
		title: decodeMaybe(paramFirst(p, "X-TITLE")),
		address: decodeMaybe(paramFirst(p, "X-ADDRESS")),
		geo: parseGeoUri(p.value),
		radiusMeters: parseRadiusMeters(paramFirst(p, "X-APPLE-RADIUS")),
	};
}

/**
 * Component(VEVENT / VTODO 直下)の X-APPLE-STRUCTURED-LOCATION を読む。無ければ null。
 * 設計 05 §1-b の「vevent の場所 = LOCATION(表示テキスト)+ X-APPLE-STRUCTURED-LOCATION(構造化)」の
 * 後者を担う(表示テキスト LOCATION は既存 DTO の location フィールドが読む)。
 */
export function readStructuredLocation(c: Component): StructuredLocation | null {
	const p = firstProp(c, "X-APPLE-STRUCTURED-LOCATION");
	if (p === undefined) return null;
	return structuredLocationFromProperty(p);
}

// -----------------------------------------------------------------------------
// ProximityAlarm の読み取り
// -----------------------------------------------------------------------------

/**
 * Component 配下の VALARM から proximity アラームを1件読む(複数あれば先頭のみ・v1)。
 * proximity を持つ VALARM が無ければ null。
 *
 * 【判定基準(設計 05 §1-a)】X-APPLE-PROXIMITY プロパティを持つ VALARM が geofence リマインダー。
 * 番兵 TRIGGER(19760401T005545Z)は Apple の「時刻トリガ無しの印」だが、判定には使わない
 * (X-APPLE-PROXIMITY の存在が十分条件。番兵日付は将来 Apple が変えうるので依存しない)。
 *
 * 【既存 alarms 配列との非干渉(既存挙動を壊さない側に倒す)】
 * 時刻ベースの alarms(event-dto.ts の readStartRelativeAlarms)は vevent-alarm.ts の
 * isStartRelativeAlarm が「X-APPLE-PROXIMITY を持つ VALARM は false」で既に除外している
 * (同ファイル isStartRelativeAlarm のコメント: 位置アラームは時刻に依存せず別種)。よって
 * proximity VALARM を新たに proximityAlarm として読み出しても、時刻 alarms 側には二重計上されない
 * (task-dto.ts には元々 alarms フィールド自体が無いので VTODO 側も干渉ゼロ)。既存テストは不変。
 */
export function readProximityAlarm(c: Component): ProximityAlarm | null {
	for (const alarm of subComponents(c, "VALARM")) {
		const prox = firstProp(alarm, "X-APPLE-PROXIMITY");
		if (prox === undefined) continue; // 時刻ベース VALARM は proximity ではない。
		// ARRIVE / DEPART のみ(§3.1 相当で値は case-insensitive 想定 → 大文字化して照合)。
		// 想定外値は ARRIVE に倒す(型 union を閉じる安全側 default。実害は表示ラベルのみ)。
		const proximity = prox.value.toUpperCase() === "DEPART" ? "DEPART" : "ARRIVE";
		const locProp = firstProp(alarm, "X-APPLE-STRUCTURED-LOCATION");
		// 場所プロパティが無い proximity VALARM でも、全 null の場所を添えて返す(位置トリガーの
		// 存在自体を握りつぶさない)。在れば structuredLocationFromProperty で best-effort 派生。
		const location = locProp !== undefined ? structuredLocationFromProperty(locProp) : emptyStructuredLocation();
		return { proximity, location };
	}
	return null;
}

// -----------------------------------------------------------------------------
// Conference の読み取り(URL / DESCRIPTION 走査)
// -----------------------------------------------------------------------------

// Apple の DESCRIPTION 内「ビデオ通話」区切りブロック(設計 05 §1-c)。日本語 UI は
// `----( ビデオ通話 )----` 〜 `---===---`、英語 UI は `----( Video Call )----`。括弧内の前後空白は
// 実装ゆらぎに備えて任意許容する。[\s\S]*? で改行含む最短一致でブロック本文を捕捉する
// (decode 済み DESCRIPTION に対して適用する = 折り返し解除後・実改行入りのテキストを走査)。
//
// 【C8 で export した理由(read 専用ファイルだが正規表現だけ write 側と共有する)】
// structured-location-write.ts(C8・author 規約の encode)が「DESCRIPTION から会議ブロックを
// 除いた残り(=素の notes)」を取り出す splitConferenceFromDescription で同じブロック検出が要る。
// 正規表現を2箇所に複製すると日本語/英語ブロックの語彙が変わったときにズレる事故が起きるため、
// このファイルを「ブロック記法の唯一の情報源」としてここから re-export する(値のロジック自体は
// 変えない・read/write の責務分離は保ったまま定数だけ共有)。
export const VIDEO_CALL_BLOCK_RE = /----\(\s*(?:ビデオ通話|Video Call)\s*\)----([\s\S]*?)---===---/;
// http(s) URL の素朴な抽出(空白まで)。会議リンクは1行1 URL で入るので空白境界で十分。
export const HTTP_URL_RE = /https?:\/\/[^\s]+/;

/**
 * 会議 / 参照 URL を判別する(設計 05 §1-c・§2 のヒューリスティック)。
 *
 * @param url   URL プロパティの生値(Event.url。未設定は null)。URI 値型なので decode しない生値。
 * @param notes DESCRIPTION の decode 済みテキスト(Event.notes)。会議ブロックはここに畳まれる。
 *
 * 【判定順(設計 05 §1-c)】
 *   (1) DESCRIPTION に「ビデオ通話」区切りブロックがあり、その中に https URL があれば
 *       → それを会議(source:"description")とする。本物の招待(paiza 面談の実例)はこの形で、
 *         URL プロパティ側は message: スキーム(お知らせメールを開く参照リンク)になっている。
 *   (2) 無ければ、URL プロパティ値が http(s) なら → 会議(source:"url")。単独の会議リンクは
 *       Apple が URL に直入れする(`URL;VALUE=URI:https://meet.google.com/abc` の実例)。
 *   (3) どちらでもない(URL が message: 等の非 http・会議ブロックも無い)→ null(= 参照 URL のまま)。
 *
 * 【ドメインのホワイトリスト判定はしない(ボツ案・財産)】
 * meet.google.com / zoom.us 等の「会議ドメイン allowlist」で会議判定する案は採らない。設計 05 §1-c
 * の裁定どおり、Apple 自身が任意 URL を「参加」ボタンにする(ユーザー実機で URL:x.com も「参加」に
 * なった)ため、ドメインを絞ると Apple の実挙動と乖離する。「http(s) URL が会議ブロックにある/URL に
 * 直入れされている」という構造だけで判定する(§7 ボツ案「video-call ドメインのホワイトリスト」)。
 */
export function readConference(url: string | null, notes: string | null): Conference | null {
	// (1) DESCRIPTION の「ビデオ通話」ブロックを最優先で見る。
	if (notes !== null) {
		const block = VIDEO_CALL_BLOCK_RE.exec(notes);
		if (block !== null) {
			const inBlock = HTTP_URL_RE.exec(block[1]!);
			if (inBlock !== null) {
				return { url: inBlock[0], source: "description" };
			}
			// ブロックはあるが中に http URL が無い = 会議として成立しないので (2) へ落ちる
			// (壊れた/空のブロックで参照 URL を潰さない)。
		}
	}
	// (2) URL プロパティが http(s) 直入れなら会議。message: 等の非 http は会議ではない。
	if (url !== null && HTTP_URL_RE.test(url)) {
		// 先頭一致で判定する(url 全体が URL 値。test は部分一致なので startsWith 相当に締める)。
		if (/^https?:\/\//i.test(url)) {
			return { url, source: "url" };
		}
	}
	// (3) 会議ではない → 参照 URL のまま(呼び出し側の既存 url フィールドが生値を保持する)。
	return null;
}

// -----------------------------------------------------------------------------
// 内部ヘルパー
// -----------------------------------------------------------------------------

/** 全フィールド null の StructuredLocation(proximity VALARM に場所が無いときのプレースホルダ)。 */
function emptyStructuredLocation(): StructuredLocation {
	return { title: null, address: null, geo: null, radiusMeters: null };
}

/** パラメータ値を decodeText する(undefined はそのまま null に落とす)。 */
function decodeMaybe(raw: string | undefined): string | null {
	return raw !== undefined ? decodeText(raw) : null;
}

/**
 * `geo:lat,lon` URI(RFC 5870)から座標を取る。パース不能は null(degrade)。
 * 例: "geo:35.463012,136.737202" → { lat: 35.463012, lon: 136.737202 }。
 * `;u=35` 等の geo URI パラメータや第3成分(高度)は座標判定に不要なので切り落とす。
 */
function parseGeoUri(value: string): { lat: number; lon: number } | null {
	// スキームは小文字 "geo:" が正だが、寛容に case-insensitive で剥がす(壊れ耐性)。
	const m = /^geo:/i.exec(value);
	if (m === null) return null;
	// ";" 以降(geo URI パラメータ)を捨ててから "," で緯度・経度に割る。
	const coords = value.slice(m[0].length).split(";")[0]!;
	const parts = coords.split(",");
	if (parts.length < 2) return null;
	const lat = Number.parseFloat(parts[0]!);
	const lon = Number.parseFloat(parts[1]!);
	if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
	return { lat, lon };
}

/** X-APPLE-RADIUS(メートル)を数値化する。空・数値化不能は null。 */
function parseRadiusMeters(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number.parseFloat(raw);
	return Number.isNaN(n) ? null : n;
}
