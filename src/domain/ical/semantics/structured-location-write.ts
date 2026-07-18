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
 * read 側 StructuredLocation(全フィールド nullable)とは非対称: write は「これから設定する値」
 * なので lat/lon(geo)と title は必須(geo の無い structured location は意味を成さない・
 * タイトルが無いと LOCATION 表示テキストが空になる)。
 */
export interface StructuredLocationInput {
	title: string;
	address?: string;
	lat: number;
	lon: number;
	radius?: number;
}

// X-APPLE-STRUCTURED-LOCATION は URI 値型(実データ VALUE=URI 明示。§1-b)。
const VALUE_URI_PARAM: Parameter = { name: "VALUE", values: ["URI"] };

/**
 * StructuredLocationInput → X-APPLE-STRUCTURED-LOCATION プロパティ(設計 05 §1-b の author 規約)。
 * 値は `geo:lat,lon`(read 側 parseGeoUri の逆)。X-TITLE/X-ADDRESS は TEXT なので encodeText して
 * パラメータ値に入れる(シリアライズ時に COMMA/SEMICOLON/COLON を含めば serializer が自動で
 * DQUOTE 化する — structure/edit.ts の upsertProperty コメント・serialize/*.ts 参照。ここでは
 * decodeText の逆である encodeText だけ担い、QUOTED 判定はしない)。
 * X-APPLE-RADIUS は数値をそのまま文字列化(read 側 parseRadiusMeters の逆)。
 */
export function buildStructuredLocationProperty(loc: StructuredLocationInput): Property {
	const parameters: Parameter[] = [VALUE_URI_PARAM, { name: "X-TITLE", values: [encodeText(loc.title)] }];
	if (loc.address !== undefined && loc.address !== "") {
		parameters.push({ name: "X-ADDRESS", values: [encodeText(loc.address)] });
	}
	if (loc.radius !== undefined) {
		parameters.push({ name: "X-APPLE-RADIUS", values: [String(loc.radius)] });
	}
	return { name: "X-APPLE-STRUCTURED-LOCATION", parameters, value: `geo:${loc.lat},${loc.lon}` };
}

/**
 * X-APPLE-STRUCTURED-LOCATION プロパティを Component から upsert する(VEVENT/VTODO 共有可能な
 * 汎用ヘルパー。vevent-write.ts/vevent-patch.ts がこれを呼ぶ。同名プロパティは単一出現前提
 * — structure/edit.ts upsertProperty と同じ制約)。
 */
export function upsertStructuredLocationProperty(component: Component, loc: StructuredLocationInput): Component {
	const prop = buildStructuredLocationProperty(loc);
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
