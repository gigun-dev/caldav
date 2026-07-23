// =============================================================================
// valarm-write — proximity(位置)VALARM の組み立て(#51 Phase 1)
// =============================================================================
//
// 【この層の責務・valarm.ts(read)との対称】
// valarm.ts は VALARM を包む「読み取り + validate」レンズ(§1-1)。このファイルはその write 側で、
// iOS の「場所リマインダー」= geofence 通知の正体である proximity VALARM をゼロから組み立てる
// (vtodo-write.ts / vevent-write.ts が read レンズと別ファイルで write を担うのと同じ構図)。
//
// 【なぜ「時刻アラーム」と別ファイルか】
// 時刻の絶対 TRIGGER アラーム(due 由来)は vtodo-write.ts が VALARM を直接組み立てている
// (VTodoFields.alarm)。proximity は TRIGGER が「番兵日時 + X-APPLE-PROXIMITY + REFERENCEFRAME 付き
// structured-location」という別種の構造で、structured-location-write.ts の再利用を伴うため、
// 独立した write プリミティブとして切り出す(vtodo-write.ts を proximity 固有の知識で膨らませない)。
//
// 【一次資料: test/domain/ical/fixtures/real-ios/vtodo-proximity-alarm.ics(iOS 26.5 実測 put13)】
// docs/modeling/06 A9・§「位置アラーム」の実測どおり、iOS は位置リマインダーを次の形で PUT する:
//   BEGIN:VALARM
//   ACTION:DISPLAY
//   DESCRIPTION:Reminder
//   TRIGGER;VALUE=DATE-TIME:19760401T005545Z   ← 番兵(位置トリガのプレースホルダ)
//   UID:<UUID>
//   X-APPLE-PROXIMITY:ARRIVE
//   X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-APPLE-REFERENCEFRAME=1;X-TITLE=自宅:geo:...
//   X-WR-ALARMUID:<同じ UUID>
//   END:VALARM
// このファイルは上の構造(プロパティ順・パラメータ順)にバイト忠実(geo 値の座標は実入力次第)。
// =============================================================================

import type { Component, Parameter, Property } from "../structure/types";
import { buildStructuredLocationProperty } from "./structured-location-write";

/**
 * proximity(位置)VALARM を組み立てる入力。
 *
 * 【geo 必須(lat/lon non-optional)の理由】
 * proximity は「その座標の半径 radius に入った/出たら鳴らす」geofence であり、座標無しでは
 * geofence を定義できない(fixtures の実データが geo:0,0 なのは iOS 側で座標未設定のまま作られた
 * 特殊ケースで、サーバー発は必ず実座標を要求する — 呼び出し側 presentation で解決不能なら
 * ツールをエラーにする契約。#51 の「中途半端な iOS 非互換を作らない」裁定)。よって
 * StructuredLocationInput(lat/lon optional・geo 無しは LOCATION へ degrade)とは違い、ここは
 * lat/lon を必須にして「geo の無い proximity」という無意味な状態を型で禁じる。
 */
export interface ProximityAlarmInput {
	/** X-TITLE(場所の表示名。例「自宅」)。 */
	title: string;
	/** X-ADDRESS(住所。省略可)。 */
	address?: string;
	/**
	 * X-APPLE-RADIUS(geofence 半径・メートル。省略可 → 既定 PROXIMITY_DEFAULT_RADIUS_METERS)。
	 * 【なぜ省略時に必ず既定を書くか】radius の無い proximity アラームは iOS で geofence が成立しない
	 * 懸念がある(= 避けたい中途半端な非互換。#51「中途半端な iOS 非互換を作らない」裁定)。実測
	 * fixture も X-APPLE-RADIUS=100 なので、未指定なら実測値 100 を書いて「半径無しの位置アラーム」を作らない。
	 */
	radius?: number;
	/** geo URI の緯度(必須)。 */
	lat: number;
	/** geo URI の経度(必須)。 */
	lon: number;
	/**
	 * X-APPLE-PROXIMITY の向き。"arrive"→ARRIVE(到着時)/ "leave"→DEPART(出発時)。
	 * 【writer は両対応・MCP 公開は arrive のみ】domain は ARRIVE/DEPART を対称に扱う(RFC/実機
	 * どちらにも DEPART は存在する)。presentation の MCP ツール enum は G2(leave の実機ゲート)
	 * 通過まで "arrive" のみ公開する — この非対称は presentation 層の都合であって domain は絞らない。
	 */
	trigger: "arrive" | "leave";
}

/**
 * radius 未指定時の既定 geofence 半径(メートル)。fixtures/real-ios/vtodo-proximity-alarm.ics の
 * 実測値そのまま(X-APPLE-RADIUS=100)。radius 無しでは iOS の geofence が成立しないリスクがあるため、
 * 「半径無しの proximity」を作らないよう常に半径を書く既定にする(#51「中途半端な iOS 非互換を作らない」裁定)。
 */
export const PROXIMITY_DEFAULT_RADIUS_METERS = 100;

/**
 * proximity VALARM の TRIGGER 固定値(§3.8.6.3 の DATE-TIME 生値。UTC)。
 *
 * 【なぜ固定の番兵か(実測値そのまま)】
 * X-APPLE-PROXIMITY がある VALARM では「発火は時刻ではなく位置」なので TRIGGER 自体は意味を持た
 * ないが、RFC 5545 §3.6.6 は TRIGGER を無条件 REQUIRED にしている(valarm.ts の validate も要求)。
 * iOS は「時刻トリガ無しの印」として 1976-04-01T00:55:45Z という過去のダミー日時を入れてくる
 * (fixtures/real-ios/vtodo-proximity-alarm.ics 実測)。この実測値を**そのまま固定で書く**のが、
 * Apple 自身の read 実装との相互運用が保証される唯一の形 — 別の値(例: 現在時刻や 19700101)を
 * 入れると Apple がどう解釈するかは未検証(実機で確認していないものを推測で変えない)。
 */
export const PROXIMITY_TRIGGER_PLACEHOLDER = "19760401T005545Z";

// TRIGGER;VALUE=DATE-TIME(§3.8.6.3。既定は相対だが位置アラームは絶対 DATE-TIME で番兵を書く)。
const TRIGGER_VALUE_DATETIME_PARAMS: readonly Parameter[] = [{ name: "VALUE", values: ["DATE-TIME"] }];

// X-APPLE-REFERENCEFRAME=1: VALARM 内の structured-location にだけ付く実測パラメータ
// (VEVENT 直下の X-APPLE-STRUCTURED-LOCATION には付かない — vevent-write.ts は書かない)。
// 意味は Apple 非公開だが、実データに忠実に付けることで相互運用を保つ(値は実測どおり "1")。
const REFERENCEFRAME_PARAM: Parameter = { name: "X-APPLE-REFERENCEFRAME", values: ["1"] };

/**
 * proximity 用の X-APPLE-STRUCTURED-LOCATION プロパティを組み立てる(structured-location-write.ts の
 * buildStructuredLocationProperty を再利用しつつ、VALARM 固有の差分だけを薄く被せる)。
 *
 * 【VEVENT 版との2つの差分(fixtures 実測)】
 *  (1) X-APPLE-REFERENCEFRAME=1 を足す(VEVENT 側は書かない)。
 *  (2) パラメータ順が VEVENT 版(VALUE, X-TITLE, X-ADDRESS, X-APPLE-RADIUS)と違い、実測は
 *      VALUE, X-APPLE-RADIUS, X-APPLE-REFERENCEFRAME, X-TITLE の順。バイト忠実のためこの順に並べ替える。
 * encodeText(X-TITLE/X-ADDRESS)や geo:lat,lon の value 組み立てといった符号化ロジックは
 * buildStructuredLocationProperty から再利用する(二重実装しない — DRY より「符号化の単一情報源」を優先)。
 */
function buildProximityStructuredLocationProperty(input: ProximityAlarmInput): Property {
	// buildStructuredLocationProperty は StructuredLocationInput(lat/lon optional)を取るが、
	// ProximityAlarmInput は geo 必須なので必ず geo 有りで呼べる(structuredLocationHasGeo=true)。
	const base = buildStructuredLocationProperty({
		title: input.title,
		address: input.address,
		lat: input.lat,
		lon: input.lon,
		// radius 未指定は既定 100 に補完する(PROXIMITY_DEFAULT_RADIUS_METERS のコメント参照 —
		// 半径無しの proximity は iOS の geofence が成立しないリスクがあるため、常に半径を書く)。
		radius: input.radius ?? PROXIMITY_DEFAULT_RADIUS_METERS,
	});
	const byName = (name: string): Parameter | undefined => base.parameters.find((p) => p.name === name);

	// 実測のパラメータ順に組み直す: VALUE=URI, [X-APPLE-RADIUS], X-APPLE-REFERENCEFRAME=1, X-TITLE, [X-ADDRESS]。
	// X-TITLE は必須(buildStructuredLocationProperty が常に付ける)。RADIUS/ADDRESS は入力次第で optional。
	const params: Parameter[] = [{ name: "VALUE", values: ["URI"] }];
	const radius = byName("X-APPLE-RADIUS");
	if (radius !== undefined) params.push(radius);
	params.push(REFERENCEFRAME_PARAM);
	params.push(byName("X-TITLE")!); // 常に存在(base の contract)。
	const address = byName("X-ADDRESS");
	if (address !== undefined) params.push(address); // 実測 fixture には無いが、VEVENT 版と同じく TITLE の後に置く。

	// value(geo:lat,lon)は base のまま(符号化は buildStructuredLocationProperty が担う)。
	return { name: "X-APPLE-STRUCTURED-LOCATION", parameters: params, value: base.value };
}

/**
 * proximity(位置)VALARM を1つ組み立てる(fixtures/real-ios/vtodo-proximity-alarm.ics にバイト忠実)。
 *
 * 【UID = X-WR-ALARMUID を同値にする】iOS はこの2つを同じ UUID にして VALARM を一意識別する
 * (時刻アラーム vtodo-write.ts と同じ規約)。crypto.randomUUID() を toUpperCase() で採番する
 * (実測 UID が大文字 UUID のため — fixtures の BE34B460-... 参照)。同一 VALARM 内で必ず同値。
 *
 * 【プロパティ順(実測)】ACTION → DESCRIPTION → TRIGGER → UID → X-APPLE-PROXIMITY →
 * X-APPLE-STRUCTURED-LOCATION → X-WR-ALARMUID。RFC 5545 は順序に意味を持たせないが、実測順を
 * 再現して diff/テストを安定させ、Apple の read 実装が最も素直に解釈する形に揃える。
 */
export function buildProximityAlarm(input: ProximityAlarmInput): Component {
	// UID と X-WR-ALARMUID は同値の大文字 UUID(実測)。1回だけ採番して両方に使う。
	const uid = crypto.randomUUID().toUpperCase();
	// trigger を Apple の語彙へ写す(arrive→ARRIVE / leave→DEPART。writer は両対応)。
	const proximity = input.trigger === "leave" ? "DEPART" : "ARRIVE";

	return {
		name: "VALARM",
		properties: [
			// ACTION:DISPLAY(§3.8.6.1)。iOS の位置通知もこの1択(fixtures 実測)。
			{ name: "ACTION", parameters: [], value: "DISPLAY" },
			// DESCRIPTION は ACTION:DISPLAY で REQUIRED(§3.6.6)。iOS は固定文字列 "Reminder" を送る。
			{ name: "DESCRIPTION", parameters: [], value: "Reminder" },
			// TRIGGER は番兵固定値(PROXIMITY_TRIGGER_PLACEHOLDER のコメント参照)。
			{ name: "TRIGGER", parameters: [...TRIGGER_VALUE_DATETIME_PARAMS], value: PROXIMITY_TRIGGER_PLACEHOLDER },
			{ name: "UID", parameters: [], value: uid },
			// X-APPLE-PROXIMITY(Apple 拡張)。位置トリガの向き(ARRIVE/DEPART)。
			{ name: "X-APPLE-PROXIMITY", parameters: [], value: proximity },
			// X-APPLE-STRUCTURED-LOCATION(REFERENCEFRAME=1 付き・実測パラメータ順)。
			buildProximityStructuredLocationProperty(input),
			// X-WR-ALARMUID(iOS 拡張)。UID と同値。
			{ name: "X-WR-ALARMUID", parameters: [], value: uid },
		],
		components: [],
	};
}
