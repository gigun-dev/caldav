// =============================================================================
// structured-location-write — 場所 / 会議の write 派生(設計 05 §1・§2・C8)
// =============================================================================
//
// 【この層の責務・structured-location.ts(read)との対称】
// vevent-write.ts / vtodo-write.ts が「新規 Component をゼロから組む write 専用ファイル」を
// vevent.ts / vtodo.ts(read 専用レンズ)と分離しているのと同じ構図で、この作業(C8)は
// structured-location.ts(read)から write を分離する。write は read の**逆写像**であることを
// 徹底し、read 側の型(StructuredLocation)・正規表現(VIDEO_CALL_BLOCK_RE/HTTP_URL_RE、
// structured-location.ts から re-export)をそのまま使い、encode↔decode の往復を保証する。
//
// 【author 規約(設計 05 §1-b・§1-c)を実装する2つの関数】
// - buildStructuredLocationProperty: X-APPLE-STRUCTURED-LOCATION プロパティを1つ組み立てる。
//   LOCATION(表示テキスト)は呼び出し側(vevent-write.ts/vevent-patch.ts)が title から別途 upsert
//   する(このファイルは1プロパティの組み立てに閉じる — read 側 structuredLocationFromProperty が
//   1プロパティの分解に閉じているのと対称)。
// - splitConferenceFromDescription / composeDescriptionWithConference: 会議は独立プロパティを
//   持たず DESCRIPTION に畳み込まれる(設計 05 §1-c)ため、「notes 本文」と「会議ブロック」を
//   合成・分解する対の関数が要る。update-event.ts が「notes だけ変える」「conference だけ変える」を
//   両立するには、既存 DESCRIPTION から現在の notes 本文を取り出す分解(split)が必須
//   (event-dto.ts の Event.notes は会議ブロックを剥がさない生の DESCRIPTION 全文を返す設計 — C1の
//   決定を変えないため、write 側で都度 split する)。
//
// 【X-APPLE-MAPKIT-HANDLE は書かない】読み取り側と同じく、この不透明 blob はサーバー発イベントには
// 不要(Apple Maps 由来の候補選択でのみ付与される情報で、サーバーが作った structuredLocation には
// 対応する MapKit ハンドルが無い)。write しないことで「サーバー発の場所は MapKit 由来ではない」と
// 正直に表現する(捏造しない)。
// =============================================================================

import type { Component, Parameter, Property } from "../structure/types";
import { encodeText } from "../values/text-value";
import { VIDEO_CALL_BLOCK_RE, HTTP_URL_RE } from "./structured-location";

/**
 * structuredLocation 入力(C8・create/update-event の shape から渡される)。
 * title は必須(LOCATION 表示テキストの本体になるため)。
 *
 * 【#45 スライス B: lat/lon を optional に緩和した(geo 無し = 住所のみ受理)】
 * 以前は lat/lon が必須だった(geo の無い structured location は意味を成さない、という判断)。
 * しかし search-location で座標を解決できないケース(住所は分かるが geocoding が0件・枠切れ・
 * キー未設定)でも「title と住所だけで登録したい」需要がある。そこで geo(lat/lon)を optional にし、
 * geo 無しのときは **X-APPLE-STRUCTURED-LOCATION を書かず LOCATION に degrade する**
 * (X-APPLE-STRUCTURED-LOCATION の value 本体は `geo:lat,lon` URI なので、geo が無いと value を
 * 作れない = プロパティ自体が成立しない。RFC 的にも geo URI 抜きの X-APPLE-STRUCTURED-LOCATION は
 * 無意味なので、書かずに LOCATION テキスト側へ住所を併記するのが安全 — 詳細は buildStructuredLocation-
 * Property / structuredLocationHasGeo / structuredLocationDegradeText の各コメント)。
 * lat/lon は「両方あるか両方無いか」のどちらか(片方だけの部分 geo は不正 — 検証は application 層の
 * validateStructuredLocation が担う。ここは型として optional にするだけ)。
 */
export interface StructuredLocationInput {
	title: string;
	address?: string;
	lat?: number;
	lon?: number;
	radius?: number;
}

/**
 * #45 スライス B: この入力が geo(lat/lon 両方)を持つか。持つときだけ X-APPLE-STRUCTURED-LOCATION を
 * 書き、持たないときは LOCATION への degrade に倒す(write 側の分岐の単一情報源)。
 * 片方だけ(部分 geo)は false 扱いにして degrade へ倒す(application 層で弾かれる前提だが、防御的に)。
 */
export function structuredLocationHasGeo(loc: StructuredLocationInput): boolean {
	return typeof loc.lat === "number" && typeof loc.lon === "number";
}

/**
 * #45 スライス B: geo 無しのときに LOCATION プロパティへ書く表示テキストを作る degrade 表現。
 * title を主に、住所(address)があれば改行で併記する(「title\naddress」)。
 *
 * 【なぜ address を LOCATION に畳み込むか】geo 無しでは X-APPLE-STRUCTURED-LOCATION を書けず、
 * address を運ぶ他のプロパティが無い(X-ADDRESS は X-APPLE-STRUCTURED-LOCATION のパラメータで、
 * 親プロパティ抜きには置けない)。LOCATION は自由記述 TEXT(§3.8.1.7)なので、title と住所を
 * 1つのテキストに畳んでおけば「場所名 + 住所」の情報を失わずに済む(iOS のイベント詳細では
 * LOCATION テキストとして1行/複数行表示される。geo が無いので地図ピンは付かないが、これは
 * 座標が取れなかった degrade の受容できる帰結)。title と address が同一なら重複を避けて title のみ。
 */
export function structuredLocationDegradeText(loc: StructuredLocationInput): string {
	if (loc.address !== undefined && loc.address !== "" && loc.address !== loc.title) {
		return `${loc.title}\n${loc.address}`;
	}
	return loc.title;
}

// X-APPLE-STRUCTURED-LOCATION は URI 値型(実データ VALUE=URI 明示。§1-b)。
const VALUE_URI_PARAM: Parameter = { name: "VALUE", values: ["URI"] };

/**
 * 【2026-07-24 実機確認済み・本採用】VEVENT の地図表示を成立させる build 時オプション(VTODO
 * proximity 経路は一切渡さないのでデフォルト値のまま=既存挙動を完全維持する。呼び出し元は
 * buildProximityStructuredLocationProperty(valarm-write.ts)——ここはオプション無しで呼ぶ契約を守ること)。
 * 実機(iOS カレンダー)で「サーバー発 VEVENT が X-APPLE-MAPKIT-HANDLE 無しでも地図ピン + タップ可能な
 * 場所 + 出発時刻(Time to Leave)を表示する」ことを確認できた条件がこの2つ:
 * - omitAddress: true で X-ADDRESS パラメータを一切付けない。X-ADDRESS が付いていると地図が壊れる
 *   (ical-generator issue #236 の報告と一致する実機挙動)。住所情報は ICS 上から失われるが、地図表示を
 *   成立させるための必須トレードオフとして受け入れる(将来住所を運びたくなったら、この
 *   BuildStructuredLocationPropertyOptions の omitAddress を条件付きで false にする設計余地はある)。
 * - defaultRadiusMeters: loc.radius が未指定のときに補完する既定半径。X-APPLE-RADIUS を持たないと
 *   (X-ADDRESS 除去後の)地図が出ない実機挙動を確認したため、VEVENT 側は radius 未指定でも既定値
 *   (呼び出し元が 100 を渡す)を必ず書く。
 * 【X-APPLE-MAPKIT-HANDLE は不要と実証】この不透明バイナリ blob は非公開フォーマットで捏造不可能
 * (デコード調査でも不透明 place ID を含むだけと判明)だが、そもそも地図表示の成立に必須ではなかった
 * ——handle 無しでも上記2条件だけで地図ピン/タップ可能場所/Time to Leave がすべて出た。
 */
export interface BuildStructuredLocationPropertyOptions {
	omitAddress?: boolean;
	defaultRadiusMeters?: number;
}

/**
 * VEVENT 専用オプション(2026-07-24 実機確認済み・単一情報源)。vevent-write.ts / vevent-patch.ts の
 * 両方の upsert 呼び出しがこの同じ定数を渡すことで「X-ADDRESS 無し・X-APPLE-RADIUS=100 既定」を統一する
 * (2箇所にマジックナンバー 100 を重複させない)。
 */
export const VEVENT_STRUCTURED_LOCATION_OPTIONS: BuildStructuredLocationPropertyOptions = {
	omitAddress: true,
	defaultRadiusMeters: 100,
};

/**
 * StructuredLocationInput → X-APPLE-STRUCTURED-LOCATION プロパティ(設計 05 §1-b の author 規約)。
 * 値は `geo:lat,lon`(read 側 parseGeoUri の逆)。X-TITLE/X-ADDRESS は TEXT なので encodeText して
 * パラメータ値に入れる(シリアライズ時に COMMA/SEMICOLON/COLON を含めば serializer が自動で
 * DQUOTE 化する — structure/edit.ts の upsertProperty コメント・serialize/*.ts 参照。ここでは
 * decodeText の逆である encodeText だけ担い、QUOTED 判定はしない)。
 * X-APPLE-RADIUS は数値をそのまま文字列化(read 側 parseRadiusMeters の逆)。
 *
 * options は2026-07-24 実機確認済みの VEVENT 地図表示オプション(上記コメント参照)。省略時は完全に
 * 元の挙動(X-ADDRESS 付与・radius は指定時のみ)なので、VTODO proximity 経路(valarm-write.ts)は
 * options を渡さず今まで通り動く——バイト忠実テストが green のまま保たれるのはこの後方互換のおかげ。
 */
export function buildStructuredLocationProperty(
	loc: StructuredLocationInput,
	options?: BuildStructuredLocationPropertyOptions,
): Property {
	// #45 スライス B: geo 無しでここに来るのは呼び出し側のバグ(write 側は structuredLocationHasGeo で
	// 分岐して geo 有りのときだけ呼ぶ契約)。value 本体の geo:lat,lon URI を作れないので防御的に throw する
	// (黙って壊れた `geo:undefined,undefined` を書かない — vevent-write の「表現できない入力を黙って
	// 壊さない」方針と同じ)。
	if (!structuredLocationHasGeo(loc)) {
		throw new Error("buildStructuredLocationProperty: lat/lon required (geo-less input must degrade to LOCATION)");
	}
	const parameters: Parameter[] = [VALUE_URI_PARAM, { name: "X-TITLE", values: [encodeText(loc.title)] }];
	if (!options?.omitAddress && loc.address !== undefined && loc.address !== "") {
		parameters.push({ name: "X-ADDRESS", values: [encodeText(loc.address)] });
	}
	// 2026-07-24 実機確認済み: options.defaultRadiusMeters があれば loc.radius 未指定時の既定値として使う
	// (実機で「効いた」形式は X-APPLE-RADIUS を常に持つため。VTODO 側は options 無し=従来どおり
	// loc.radius 未指定なら X-APPLE-RADIUS 自体を書かない)。
	const radius = loc.radius ?? options?.defaultRadiusMeters;
	if (radius !== undefined) {
		parameters.push({ name: "X-APPLE-RADIUS", values: [String(radius)] });
	}
	return { name: "X-APPLE-STRUCTURED-LOCATION", parameters, value: `geo:${loc.lat},${loc.lon}` };
}

/**
 * X-APPLE-STRUCTURED-LOCATION プロパティを Component から upsert する(VEVENT/VTODO 共有可能な
 * 汎用ヘルパー。vevent-write.ts/vevent-patch.ts がこれを呼ぶ。同名プロパティは単一出現前提
 * — structure/edit.ts upsertProperty と同じ制約)。
 * options は buildStructuredLocationProperty へそのまま透過する(2026-07-24 実機確認済みオプション。
 * VEVENT 呼び出し元だけが渡す想定 — VTODO proximity は upsertStructuredLocationProperty を使わず
 * buildProximityStructuredLocationProperty 経由で buildStructuredLocationProperty を直接呼ぶので、
 * ここに options を足しても proximity 経路には無関係)。
 */
export function upsertStructuredLocationProperty(
	component: Component,
	loc: StructuredLocationInput,
	options?: BuildStructuredLocationPropertyOptions,
): Component {
	const prop = buildStructuredLocationProperty(loc, options);
	const index = component.properties.findIndex((p) => p.name === "X-APPLE-STRUCTURED-LOCATION");
	const properties =
		index === -1 ? [...component.properties, prop] : component.properties.map((p, i) => (i === index ? prop : p));
	return { ...component, properties };
}

/** X-APPLE-STRUCTURED-LOCATION プロパティを取り除く(構造化場所の除去。update-event の null patch 用)。 */
export function removeStructuredLocationProperty(component: Component): Component {
	return { ...component, properties: component.properties.filter((p) => p.name !== "X-APPLE-STRUCTURED-LOCATION") };
}

/**
 * conference 入力(C8・create/update-event の shape)。provider は自由記述のラベル(設計 05 §1-c
 * 「provider チップは静的リスト + 任意 URL」— サーバーはドメインで判定しないので provider を
 * ICS に書く場所は無い。呼び出し側の説明用メタデータとして受け取るだけで、ワイヤには url だけが
 * 載る。捨てて良い情報だが、shape として受理はしておく — 将来カードが provider ラベル付き候補を
 * 渡してきても弾かないための余地。zod describe に「provider は表示用ヒントで ICS には出ない」と
 * 明記する)。
 */
export interface ConferenceInput {
	provider?: string;
	url: string;
}

// 会議ブロックの区切り(設計 05 §1-c 実データ。日本語 UI の語彙で書く — read 側は英語ブロックも
// 認識するが、サーバーが新規に書くときは実データに忠実な日本語ブロックで統一する。将来 Accept-Language
// 等でクライアント言語を判別できるようになったら再訪する余地はあるが、今は「実機で見た形」を書く
// のが一番安全 = 少なくとも Apple 自身の read 実装との相互運用が保証される)。
const VIDEO_CALL_BLOCK_HEADER = "----( ビデオ通話 )----";
const VIDEO_CALL_BLOCK_FOOTER = "---===---";

/** ConferenceInput → DESCRIPTION に埋め込む「ビデオ通話」ブロック本文(ヘッダ+URL+フッタ)。 */
export function buildConferenceBlock(conference: ConferenceInput): string {
	return `${VIDEO_CALL_BLOCK_HEADER}\n${conference.url}\n${VIDEO_CALL_BLOCK_FOOTER}`;
}

/**
 * notes 本文(素の DESCRIPTION テキスト・会議ブロックなし)と conference を1つの DESCRIPTION に
 * 合成する。両方 undefined なら undefined(DESCRIPTION 自体を書かない)。
 *
 * 【連結順序(裁定)】notes が先、会議ブロックは末尾に空行区切りで追記する。paiza 実例(設計 05
 * §1-c)は「お知らせ本文 → ビデオ通話ブロック → 続きの本文」のように本文中に埋め込まれる形だったが、
 * それは Apple 純正クライアントが書いたものであり、サーバー側の author 規約としては「本文はまるごと
 * 温存し、会議ブロックは末尾に足す」方が壊れにくい(本文中の任意の位置に挿入すると、notes 自体に
 * 会議ブロックと紛らわしいテキストが含まれていた場合の split 誤爆リスクが増える)。
 *
 * 【意図的な仕様差分(2026-07-18 監査で「事故か意図か判別しにくい」と指摘された2点・明記して固定)】
 * この author 規約により、Apple 産の DESCRIPTION(本文中間にブロック・英語ヘッダ「----( Video Call
 * )----」)をサーバーが一度でも書き換えると、以下2点は**意図的に**発生する — バグではないので直さない:
 * ①ブロックが末尾へ再配置される(上記の「末尾に足す」規約どおり。本文中間の位置は復元しない)。
 * ②ヘッダが日本語「----( ビデオ通話 )----」に書き換わる(VIDEO_CALL_BLOCK_HEADER 定数は英語ヘッダを
 * read はできる/write はしない — 上の「実データに忠実な日本語ブロックで統一する」コメント参照。
 * read 側 VIDEO_CALL_BLOCK_RE は英語ヘッダも認識するので compose→split の往復自体は壊れない)。
 * この2点は「サーバーが一度でも書き込んだ DESCRIPTION は author 規約の形に正規化される」という
 * 一貫した仕様であり、split 自体のバグ(監査#4・段落連結)とは別物。
 */
export function composeDescriptionWithConference(
	notes: string | undefined,
	conference: ConferenceInput | undefined,
): string | undefined {
	const notesTrimmed = notes !== undefined && notes !== "" ? notes : undefined;
	if (conference === undefined) return notesTrimmed;
	const block = buildConferenceBlock(conference);
	return notesTrimmed !== undefined ? `${notesTrimmed}\n\n${block}` : block;
}

/**
 * DESCRIPTION(decode 済みテキスト)から「会議ブロックを除いた素の notes」と「会議 URL」を分解する
 * (composeDescriptionWithConference の逆写像)。update-event が「notes だけ変える」「conference
 * だけ変える」ときに、変えない側を既存 DESCRIPTION から復元するために使う。
 *
 * 【ブロックが無ければ全体を notes として返す】DESCRIPTION に会議ブロックが無いのは「会議未設定」の
 * ケース(compose と対称)。
 * 【ブロック除去後の空行整理】compose が `notes + "\n\n" + block` で連結する契約なので、除去時も
 * 前後に残る余分な改行(区切りの "\n\n" や、notes 無しでブロックだけだった場合の先頭/末尾の空行)を
 * trim する。これをしないと「conference だけ除去 → notes に空行が残る」が繰り返し update されるたびに
 * 空行が蓄積する事故になる。
 */
export function splitConferenceFromDescription(
	description: string | undefined,
): { notes: string | undefined; conference: string | undefined } {
	if (description === undefined) return { notes: undefined, conference: undefined };
	const match = VIDEO_CALL_BLOCK_RE.exec(description);
	if (match === null) return { notes: description, conference: undefined };
	const urlMatch = HTTP_URL_RE.exec(match[1]!);
	const conferenceUrl = urlMatch !== null ? urlMatch[0] : undefined;
	// ブロック全体(match[0])を本文から取り除く。compose が付ける "\n\n" 区切りも一緒に剥がすため、
	// ブロックの直前にある改行を最大2つまで含めて除去範囲を広げる(欲張らず compose の契約分だけ)。
	const before = description.slice(0, match.index).replace(/\n{1,2}$/, "");
	const after = description.slice(match.index + match[0]!.length).replace(/^\n{1,2}/, "");
	// 【2026-07-18 監査#4・段落連結バグ修正】旧実装は `${before}${after}` で区切りなしに連結していた。
	// compose 側は「notes 末尾にブロックを追記」(§1-c 裁定コメント参照)しか作らないので before は
	// 常に notes 全文・after は常に "" になり、この関数単体では顕在化しなかった。しかし split は
	// compose の逆写像として「本文の途中にブロックがある DESCRIPTION」(Apple 純正クライアントが
	// 書いた実データ・上のコメントで触れている paiza 実例のような形)も受理する必要があり、その場合
	// before/after が両方非空になって「ブロック前後のテキストが区切りなしで連結される」データ変形が
	// 起きていた(監査で発見。テストが本文中間ケースを持っていなかったため見逃していた)。
	// before/after が両方非空のときだけ空行(\n\n)を1つ挟む(compose の区切り契約と対称に保つ)。
	// 片方だけ非空(ブロックが先頭/末尾)のときは元々の trim 済み文字列をそのまま使い、余分な空行を
	// 作らない。
	const notesRaw = before !== "" && after !== "" ? `${before}\n\n${after}` : `${before}${after}`;
	return { notes: notesRaw !== "" ? notesRaw : undefined, conference: conferenceUrl };
}
