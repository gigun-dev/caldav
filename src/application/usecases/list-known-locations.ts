// =============================================================================
// ListKnownLocations ユースケース — C5(設計 05 §3・§5・§6)
// =============================================================================
//
// 【この UC が担う範囲】
// ユーザーの既存 VEVENT(LOCATION の X-APPLE-STRUCTURED-LOCATION)/ VTODO(proximity VALARM の
// X-APPLE-STRUCTURED-LOCATION)を走査し、座標付きの「既知の場所」を distinct に集約して返す。
// 設計 05 §3「履歴(過去に使った場所)」の代替: 端末の入力履歴はサーバーからは読めないが、
// ユーザー自身が過去に保存した構造化場所は D1 に既にある(「福登の自宅」は proximity VALARM 由来 —
// §1-a の実例)。read は structured-location.ts の readStructuredLocation/readProximityAlarm を
// そのまま再利用する(C1 の派生ロジックをここでも信頼する = 二重実装しない)。
//
// 【走査範囲の既定(D1 負荷 vs 有用性のトレードオフ・判断根拠)】
// calendarId 省略時は owner 配下の**全コレクション**を横断する(ListOccurrences の
// resolveCollectionIds と同じ「全体を見る」既定 — todos の calendarId 既定 "tasks" のみとは
// 意図的に非対称: 構造化場所は「予定を作ったカレンダーと、リマインダーを作ったタスクリストの
// どちらにあるか」を利用者もサーバーも事前に知らないため、単一コレクションに絞ると事故りやすい)。
// CalendarObjectResourceRepository.findAllInCollection は「コレクション内の全件を返す」既存契約
// (ports/index.ts のコメント: 「iOS のコレクションは通常数千件未満」を前提に YAGNI で全件走査)
// を踏襲する。ただし複数コレクション横断 × 全件走査は理論上さらに重くなるため、素朴な安全弁として
// MAX_RESOURCES_SCANNED(コレクションをまたいだ走査件数の総上限)を設ける。構造化場所を持つ
// リソースは全体のごく一部という前提（大半の予定/タスクには付かない）なので、この上限に当たるのは
// 極端に大きいアカウントのみであり、C6/C7 でも同じ D1 負荷判断を踏襲する。将来 D1 に
// structured-location 専用の索引列を足せば SQL 側で絞り込めるが、それは C6 以降のスコープ
// (このファイルでは行わない)。
// =============================================================================

import type { PrincipalRef } from "../../domain/caldav";
import { collectionId as mkCollectionId, type CollectionId } from "../../domain/caldav";
import { readProximityAlarm, readStructuredLocation, type Component, type StructuredLocation } from "../../domain/ical";
import type { CalendarCollectionRepository, CalendarObjectResourceRepository } from "../ports";

// 走査件数の総上限(コレクション横断の安全弁。ファイル冒頭コメント参照)。
const MAX_RESOURCES_SCANNED = 2000;

// 返す既知の場所の上限(セミモーダルの候補リストとして現実的な件数。設計 05 §5 モックの
// 「福登の自宅」「岐阜大学」のような数件〜十数件を想定 — 多すぎても選びにくいだけなので絞る)。
const MAX_RESULTS = 20;

// --- 入力 / 出力 DTO ---

export interface ListKnownLocationsInput {
	owner: PrincipalRef;
	/** 走査対象コレクション。省略時は owner 配下の全コレクションを横断する(ファイル冒頭コメント)。 */
	calendarId?: string;
}

/** list-known-locations が返す1件(structured-location.ts の StructuredLocation から title/geo 必須に絞ったもの)。 */
export interface KnownLocation {
	title: string;
	address: string | null;
	lat: number;
	lon: number;
	radius: number | null;
}

export interface ListKnownLocationsOutput {
	locations: KnownLocation[];
}

// 集約用の内部作業単位(recency 判定用の生 LAST-MODIFIED/DTSTAMP を伴う)。
interface Candidate {
	loc: StructuredLocation & { title: string; geo: { lat: number; lon: number } };
	// 「最近使った順」の並び替えキー(裁定: 暫定で recency 採用・設計 05 §6 C5 コメント参照)。
	// LAST-MODIFIED(無ければ DTSTAMP)の生値("YYYYMMDDTHHMMSSZ" 形式・§3.3.5 UTC)をそのまま使う。
	// この形式は固定幅の UTC 文字列なので、辞書式比較 = 時系列比較として妥当(パース不要の軽量比較)。
	recencyKey: string;
	// tie-break 用の安定キー(リソースの uid)。recencyKey が両方欠落(RFC 5545 上 DTSTAMP は
	// 必須プロパティなので実データではほぼ不可能だが、壊れた/非準拠データでは起こりうる)して
	// 空文字同士になった場合でも dedup の勝敗・最終的な並びを決定的にするため保持する。
	uid: string;
}

export class ListKnownLocations {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
	) {}

	async execute(input: ListKnownLocationsInput): Promise<ListKnownLocationsOutput> {
		const collectionIds = await this.resolveCollectionIds(input.owner, input.calendarId);

		const candidates: Candidate[] = [];
		let scanned = 0;
		outer: for (const collectionId of collectionIds) {
			const resources = await this.resourceRepo.findAllInCollection(input.owner, collectionId);
			for (const resource of resources) {
				if (scanned >= MAX_RESOURCES_SCANNED) break outer;
				scanned++;

				// VEVENT(LOCATION の X-APPLE-STRUCTURED-LOCATION・§1-b)+ VTODO(proximity VALARM の
				// 場所・§1-a)の両方を、component 単位で走査する(events()/todos() は同一リソース内の
				// master + occurrence override を返しうるが、構造化場所は master 側にだけ書かれる
				// のが実データの実態 — override 分も含めて走査しても「同じ場所を二重に候補へ足す」
				// だけで実害は無い。dedup で1件に畳まれる)。
				for (const vevent of resource.payload.events()) {
					this.collectFrom(vevent.raw, resource.uid, candidates);
				}
				for (const vtodo of resource.payload.todos()) {
					this.collectFrom(vtodo.raw, resource.uid, candidates);
				}
			}
			if (scanned >= MAX_RESOURCES_SCANNED) break;
		}

		return { locations: dedupeAndSort(candidates) };
	}

	/**
	 * 1つの VEVENT/VTODO Component から構造化場所を集める(直下の X-APPLE-STRUCTURED-LOCATION +
	 * VALARM 内 proximity の場所の両方)。title/geo が両方揃っている(=候補として意味を成す)ものだけ
	 * 拾う(タイトル無し・座標無しの部分情報は「既知の場所」候補として選べないので捨てる — C1 の
	 * degrade 方針とは異なり、write 支援ツールのここでは「選択可能な候補」であることを要求する)。
	 */
	private collectFrom(component: Component, uid: string, out: Candidate[]): void {
		const recencyKey = rawValue(component, "LAST-MODIFIED") ?? rawValue(component, "DTSTAMP") ?? "";

		const direct = readStructuredLocation(component);
		if (direct !== null && direct.title !== null && direct.geo !== null) {
			out.push({ loc: direct as Candidate["loc"], recencyKey, uid });
		}

		const proximity = readProximityAlarm(component);
		if (proximity !== null && proximity.location.title !== null && proximity.location.geo !== null) {
			out.push({ loc: proximity.location as Candidate["loc"], recencyKey, uid });
		}
	}

	/** calendarId 指定時はその1件、省略時は owner 配下の全コレクション(ファイル冒頭コメント)。 */
	private async resolveCollectionIds(owner: PrincipalRef, calendarId: string | undefined): Promise<CollectionId[]> {
		if (calendarId !== undefined) return [mkCollectionId(calendarId)];
		const collections = await this.collectionRepo.findAllByOwner(owner);
		return collections.map((c) => c.id);
	}
}

/** Property の生値を名前で引く(semantics/helpers.ts の firstProp と同じだが、依存を増やさず
 *  ここに閉じた最小実装 — 探しているのは LAST-MODIFIED/DTSTAMP の2プロパティだけなので十分)。 */
function rawValue(c: Component, name: string): string | undefined {
	return c.properties.find((p) => p.name === name)?.value;
}

/**
 * 「新しい順」の比較(降順)。recencyKey が同点なら uid の辞書式昇順比較で決定的に順序付ける
 * (F: recencyKey 単独では両方 "" のケースで不定になっていた・上のコメント参照)。
 * Array.sort の慣習どおり、a が先(新しい/勝つ)なら負、b が先なら正、0 なら完全に同点
 * (理論上 uid が同じ = 同一リソース由来で同じ場所を2回拾った場合のみ起こり、順序はどちらでも実害が無い)。
 */
function compareCandidate(a: Candidate, b: Candidate): number {
	if (a.recencyKey !== b.recencyKey) return a.recencyKey > b.recencyKey ? -1 : 1;
	if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
	return 0;
}

/**
 * title + 座標(小数第6位で丸め・約11cm精度)で dedup し、recencyKey 降順(新しい順)で並べる。
 * 同じ場所が複数イベント/タスクで使われていても1件に畳み、そのうち最も新しい recencyKey を勝たせる
 * (「最近使った順」を裏付ける最新の利用実績を採用)。radius/address は「最も新しい出現」の値を採用
 * (古い出現の半径が変わっていた場合も直近の値を優先する自然な判断)。
 */
function dedupeAndSort(candidates: Candidate[]): KnownLocation[] {
	const byKey = new Map<string, Candidate>();
	for (const c of candidates) {
		const key = `${c.loc.title}|${c.loc.geo.lat.toFixed(6)}|${c.loc.geo.lon.toFixed(6)}`;
		const existing = byKey.get(key);
		// recencyKey が同点(典型的には両方 "" — LAST-MODIFIED/DTSTAMP 双方欠落)のときは
		// uid の辞書式比較で決定的に勝敗を付ける(F: tie-break 追加。recencyKey だけだと
		// 同点はどちらが Map に残るか走査順依存になり dedup/並びが不定になっていた)。
		if (existing === undefined || compareCandidate(c, existing) < 0) {
			byKey.set(key, c);
		}
	}
	const merged = [...byKey.values()].sort((a, b) => compareCandidate(a, b));
	return merged.slice(0, MAX_RESULTS).map((c) => ({
		title: c.loc.title,
		address: c.loc.address,
		lat: c.loc.geo.lat,
		lon: c.loc.geo.lon,
		radius: c.loc.radiusMeters,
	}));
}
