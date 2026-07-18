// =============================================================================
// presentation/mcp/ui/location-picker.ts — C4(設計 05 §5)場所/会議セミモーダルの純関数コア
// =============================================================================
// 【位置づけ】agenda-entry.ts の作成フォーム(C3)内セミモーダル(C4)が選ぶ「場所または会議」の
// 選択結果(LocationPickerValue)⇄ create-event 引数(structuredLocation / conference)の変換だけを
// 切り出した純関数モジュール。DOM に触れないので bun test で素早く固定できる(agenda-entry.ts 冒頭
// コメントの方針: 判断は純関数に隔離しテストで境界を固定する。location-view.ts(C1/C2・read 側)と
// 対称の write 側)。
//
// 【出典】docs/design/05-location-and-conference.md §2(3スロット意味モデル)・§5(セミモーダル構成)。
// server.ts の structuredLocationInputSchema / conferenceInputSchema(create-event 引数の shape)に
// フィールド名を合わせる(title/address?/lat/lon/radius? と provider?/url)。
// =============================================================================

/** セミモーダルで確定した「場所または会議」行の選択結果。単一多相・排他(§2・暫定判断)。
 *  一方を選ぶと他方は自動的に上書き(型が discriminated union なので同時に両方は表現できない —
 *  「場所と会議は共存しうるか」は §2 上は3スロットが独立だが、このフォームの1行トリガという UI 制約
 *  から「一方を選んだらもう一方は置換」という暫定判断にした。将来「両方欲しい」需要が出たら
 *  UI 自体を2行に分ける設計変更が要る(親への論点)。 */
export type LocationPickerValue =
	| {
			kind: "place";
			title: string;
			address: string | null;
			lat: number;
			lon: number;
			radius: number | null;
	  }
	| {
			kind: "conference";
			// チップ選択時のラベル("Google Meet"/"Zoom"/"FaceTime"/"その他URL")。表示専用(ICS には
			// 保存されない。conferenceInputSchema.provider と同じ扱い)。
			provider: string | null;
			url: string;
	  };

/** list-known-locations の structuredContent.locations の1要素(サーバー側 KnownLocation と同型)。
 *  ui は末端なので application 層の型は import せずここへ写経する(agenda-entry.ts 冒頭コメントの規律)。 */
export interface KnownLocationView {
	title: string;
	address: string | null;
	lat: number;
	lon: number;
	radius: number | null;
}

/** create-event へ渡す structuredLocation / conference 引数(server.ts の zod shape に合わせた形)。
 *  値が無いフィールドは省略する(zod の optional は「キー自体が無い」ことを期待するため、
 *  undefined を明示的に含めるのではなくキーを作らない)。 */
export interface LocationConferenceArgs {
	structuredLocation?: {
		title: string;
		address?: string;
		lat: number;
		lon: number;
		radius?: number;
	};
	conference?: {
		provider?: string;
		url: string;
	};
}

/** 既知の場所(C5候補)→ LocationPickerValue。list-known-locations の1件をそのまま選択結果へ写す。 */
export function knownLocationToPickerValue(loc: KnownLocationView): LocationPickerValue {
	return { kind: "place", title: loc.title, address: loc.address, lat: loc.lat, lon: loc.lon, radius: loc.radius };
}

/** LocationPickerValue → create-event 引数(structuredLocation / conference の出し分け)。
 *  null(未選択・クリア済み)は両方省略した空オブジェクトを返す(create-event 側は既存 location/url と
 *  同じく「キー無し=未設定」)。 */
export function locationPickerToCreateArgs(value: LocationPickerValue | null): LocationConferenceArgs {
	if (value === null) return {};
	if (value.kind === "place") {
		const structuredLocation: LocationConferenceArgs["structuredLocation"] = {
			title: value.title,
			lat: value.lat,
			lon: value.lon,
		};
		if (value.address !== null) structuredLocation.address = value.address;
		if (value.radius !== null) structuredLocation.radius = value.radius;
		return { structuredLocation };
	}
	const conference: LocationConferenceArgs["conference"] = { url: value.url };
	if (value.provider !== null) conference.provider = value.provider;
	return { conference };
}

/** 「場所または会議」行に出すアイコン名(createIcon のキー)。未選択は呼び出し側が既定(map-pin)を使う。 */
export function locationPickerIconName(value: LocationPickerValue): "map-pin" | "video" {
	return value.kind === "place" ? "map-pin" : "video";
}

/** 「場所または会議」行に出す表示文字列。 */
export function locationPickerLabel(value: LocationPickerValue): string {
	return value.kind === "place" ? value.title : (value.provider ?? value.url);
}

/** C4 のビデオ通話 provider チップの静的リスト(§5 モック順)。「その他URL」も同じ確定経路
 *  (URL 入力必須)に統一する(タスク指示の暫定裁定: provider 選択時は URL 入力を促す)。 */
export const CONFERENCE_PROVIDERS: readonly string[] = ["Google Meet", "Zoom", "FaceTime", "その他URL"];
