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
			// #45 スライス B/C: geo(lat/lon)は null 可(座標無しの既知場所・地図検索で解決できなかった
			// 住所のみの場所)。null のとき create/update へは lat/lon を省いて渡す(degrade — サーバー側
			// structuredLocation の lat/lon optional 契約に対応。iOS の地図ピンは付かないが場所名/住所は残る)。
			lat: number | null;
			lon: number | null;
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
	// #45 スライス C: geo を null 可にした(list-known-locations が座標無しの既知場所も返しうる場合に
	// ピッカーが表示・選択できるように点検)。現状の list-known-locations UC は geo 有りだけを返すため
	// 実際に null が来るのは将来の拡張時だが、型を先に緩めておくことで「geo 無しの既知場所は選べない」
	// という暗黙の前提を UI 側から取り除く(親への論点: UC が geo 無しを emit すべきかは別途判断)。
	lat: number | null;
	lon: number | null;
	radius: number | null;
}

/** create-event へ渡す structuredLocation / conference 引数(server.ts の zod shape に合わせた形)。
 *  値が無いフィールドは省略する(zod の optional は「キー自体が無い」ことを期待するため、
 *  undefined を明示的に含めるのではなくキーを作らない)。 */
export interface LocationConferenceArgs {
	structuredLocation?: {
		title: string;
		address?: string;
		// #45 スライス B: lat/lon は optional(座標無しの degrade を許す。サーバーの structuredLocation
		// 入力 shape が lat/lon optional + 両方 or 両方無しの refine を持つのに合わせる)。
		lat?: number;
		lon?: number;
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
		};
		// #45 スライス B/C: geo は両方揃っているときだけ渡す(片方だけは不可 = サーバーの refine が弾く)。
		// null(座標無し)のときは lat/lon を省いて degrade(住所のみで登録・地図ピンなし)。
		if (value.lat !== null && value.lon !== null) {
			structuredLocation.lat = value.lat;
			structuredLocation.lon = value.lon;
		}
		if (value.address !== null) structuredLocation.address = value.address;
		if (value.radius !== null) structuredLocation.radius = value.radius;
		return { structuredLocation };
	}
	const conference: LocationConferenceArgs["conference"] = { url: value.url };
	if (value.provider !== null) conference.provider = value.provider;
	return { conference };
}

/**
 * 既存イベントの C1 派生3スロット(structuredLocation / conference)→ セミモーダルの初期選択値。
 * 【2026-07-23 追加(編集詳細への C4 移植)】locationPickerToCreateArgs の逆写像(read 側)。
 *
 * 【出し分けの判断】
 *   - structuredLocation は title があれば "place" として復元する。#45 スライス B で geo(lat/lon)が
 *     optional になったため、geo 無しの構造化場所(GEO 無しの混在データや、search-location で座標を
 *     解決できず degrade 登録した場所)も "place" として編集トリガ行に復元できる(lat/lon は null に
 *     なり、保存時に再び degrade で省かれる)。以前は geo===null を「未選択」に落としていたが
 *     (structuredLocation の lat/lon が必須だった当時の制約)、その前提は解消された。
 *     title すら無い場合のみ下の会議判定へフォールする。
 *   - conference は source==="description"(= conference 入力欄が書いた DESCRIPTION の
 *     「ビデオ通話」ブロック由来)のときだけ拾う。source==="url" は既存の url フィールド
 *     (参照 URL)がたまたま http(s) だったのを読み取り側が会議として分類しただけで、
 *     conference フィールドとして書き込んだものではない(structured-location.ts 冒頭コメント
 *     参照)。ここを "conference" として拾ってしまうと、URL 行にも同じ値が出たまま
 *     トリガ行にも複製表示され、かつ保存時に conference:{...} を新規に書き込んでしまい
 *     「読んだだけなのに書いた」事故になる。汎用 URL と会議 URL を別プロパティに保つという
 *     タスクの要請から、source==="url" はここでは無視し url フィールド(呼び出し側の別行)に
 *     委ねる。
 */
export function structuredToLocationPickerValue(
	structured: { title: string | null; address: string | null; geo: { lat: number; lon: number } | null; radiusMeters: number | null } | null,
	conference: { url: string; source: "url" | "description" } | null,
): LocationPickerValue | null {
	// #45 スライス C: geo(structured.geo)は null 可に緩和した。title さえあれば「場所」として選択値に
	// できる(geo null = 座標無しの place → 保存時に degrade で lat/lon を省く)。以前は geo===null を
	// 「未選択」に落としていたが(下記の旧コメント参照)、B で structuredLocation の geo が optional に
	// なったので、geo 無し構造化場所も編集トリガ行に「場所」として復元できるようにする。
	if (structured !== null && structured.title !== null) {
		return {
			kind: "place",
			title: structured.title,
			address: structured.address,
			lat: structured.geo?.lat ?? null,
			lon: structured.geo?.lon ?? null,
			radius: structured.radiusMeters,
		};
	}
	if (conference !== null && conference.source === "description") {
		return { kind: "conference", provider: null, url: conference.url };
	}
	return null;
}

/** 直前の初期値と現在の選択値を比較する(locationPickerToUpdateArgs の変更検出に使う内部ヘルパー)。 */
function sameLocationPickerValue(a: LocationPickerValue | null, b: LocationPickerValue | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind !== b.kind) return false;
	if (a.kind === "place" && b.kind === "place") {
		return a.title === b.title && a.address === b.address && a.lat === b.lat && a.lon === b.lon && a.radius === b.radius;
	}
	if (a.kind === "conference" && b.kind === "conference") {
		return a.provider === b.provider && a.url === b.url;
	}
	return false;
}

/** update-event へ渡す structuredLocation / conference の三値パッチ(server.ts の update-event 契約に
 *  合わせた write 側)。キー自体が無い=変更なし・null=対応スロットのみ除去・オブジェクト=設定。 */
export interface LocationConferenceUpdateArgs {
	structuredLocation?: LocationConferenceArgs["structuredLocation"] | null;
	conference?: LocationConferenceArgs["conference"] | null;
}

/**
 * トリガ行の初期値(prev)と現在の選択値(next)を比較し、update-event の structuredLocation /
 * conference パッチへ変換する。
 * 【なぜ「置換元スロットも一緒に null にするか」】LocationPickerValue は排他的単一選択(冒頭コメント
 * 参照)なので、"place" → "conference" のように種別が変わったときは、旧種別のスロットを明示的に
 * null で除去しないと、update-event が「省略=変更しない」と解釈して古いデータが残ってしまう
 * (例: 場所を消して会議に差し替えたつもりが、構造化場所が温存されたまま会議も追加された状態になる)。
 */
export function locationPickerToUpdateArgs(
	next: LocationPickerValue | null,
	prev: LocationPickerValue | null,
): LocationConferenceUpdateArgs {
	if (sameLocationPickerValue(next, prev)) return {};
	const args: LocationConferenceUpdateArgs = {};
	if (next === null) {
		// クリア: 元が場所だったか会議だったかで除去対象のスロットを出し分ける。
		if (prev?.kind === "place") args.structuredLocation = null;
		if (prev?.kind === "conference") args.conference = null;
		return args;
	}
	const created = locationPickerToCreateArgs(next);
	if (created.structuredLocation !== undefined) {
		args.structuredLocation = created.structuredLocation;
		if (prev?.kind === "conference") args.conference = null; // 種別が変わった → 旧スロットを除去
	} else if (created.conference !== undefined) {
		args.conference = created.conference;
		if (prev?.kind === "place") args.structuredLocation = null;
	}
	return args;
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
