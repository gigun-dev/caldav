// =============================================================================
// CalendarQuery ユースケース — RFC 4791 §7.8 calendar-query REPORT(G-3)
// =============================================================================
//
// 【この G-3 の実装が担う範囲(確定設計メモ「④ スコープ」。J-4 で VJOURNAL 行を追加)】
// Yes: VCALENDAR>VEVENT の comp-filter 名一致 / VEVENT の time-range フィルタ
//      (RRULE/RDATE/EXDATE/RECURRENCE-ID を含む反復展開 + §9.9 の「いずれか1回でも一致」判定)/
//      CALDAV:timezone による floating の解決ゾーン指定(無ければ UTC)。
//      VJOURNAL の time-range フィルタ(J-4 追加。§9.9 の VJOURNAL 実効値表 + RRULE 反復展開。
//      RDATE/EXDATE は VJournal レンズ未対応のため対象外 — vjournal-expansion.ts 冒頭コメント参照)。
// 半分: VTODO の time-range は SQL 索引(first/last occurrence)による粗い絞り込みのみ。
//       反復 VTODO の展開はしない(G-3 のスコープ外)。非反復 VTODO は索引値が
//       §9.9 の実効値そのものなので、SQL の絞り込みだけでほぼ正確に判定できる。
// No: prop-filter / param-filter / text-match / ネスト comp-filter / CALDAV:expand /
//     limit-recurrence-set / free-busy-query は presentation 層
//     (parseCalendarQueryFilter)が検出して unsupported=true を立て、このユースケースを
//     呼ぶ前に 403 supported-filter で弾く(呼び出し側 index.ts の責務)。
//
// 【2段階フィルタの理由】
// 1. repository.findInCollectionByTimeRange で SQL 側の粗い絞り込み(first/last occurrence
//    索引、migrations/0002)を行い、コレクション全件を毎回展開するコストを避ける。
// 2. 得られた候補を実際に expandRecurrenceSet で展開し、range と重なる occurrence が
//    1件でもあれば採用する(RFC 4791 §9.9「いずれか1つの instance がマッチすれば
//    コンポーネント全体がマッチする」)。SQL 側の絞り込みが粗くても、この最終判定が
//    正しさを担保する。
// =============================================================================

import type { CalendarObjectResource } from "../../domain/caldav";
import type { CollectionId, PrincipalRef } from "../../domain/caldav";
import {
	expandRecurrenceSet,
	vjournalOverlapsRange,
	zoneResolverFor,
	type RecurrenceIterator,
} from "../../domain/ical/recurrence";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

/** presentation 層(parseCalendarQueryFilter)から渡ってくる、time-range の実測範囲。
 *  RFC 4791 §9.9 の半開区間 [startMillis, endMillis) と同じ規約。片側欠落は
 *  presentation 層が 0 / OCCURRENCE_INDEX_MAX へ正規化済みで渡してくる。 */
export interface CalendarQueryTimeRange {
	readonly startMillis: number;
	readonly endMillis: number;
}

export interface CalendarQueryInput {
	owner: PrincipalRef;
	collectionId: CollectionId;
	/** comp-filter で指定されたトップレベルコンポーネント名。 */
	componentKind: "VEVENT" | "VTODO" | "VJOURNAL";
	/** time-range 要素が無ければ undefined(comp-filter のみ = 絞り込みなしで全件)。 */
	range?: CalendarQueryTimeRange;
	/** CALDAV:timezone で指定された floating の解決ゾーン(IANA 名。presentation 層が
	 *  VTIMEZONE を resolveTimeZoneId で解決済み)。省略時は UTC(§7.3 のデフォルト)。 */
	floatingTimeZone?: string;
}

export interface CalendarQueryOutput {
	resources: CalendarObjectResource[];
}

// PUT 時(occurrence-bounds.ts)と同じ懸念: time-range フィルタでの展開も無限に走らせない。
// PUT の索引計算より件数が小さくて済む想定(1リクエストの1レンジに収まる分だけ見れば良い)だが、
// 同じ「呼び出し側が意識して決める」設計方針(expansion.ts の maxOccurrences コメント)に
// 従い、ここでも明示定数を持つ。値は PUT 側(OCCURRENCE_INDEX_MAX_OCCURRENCES)と揃えておく
// — 別の値にする積極的な理由がなく、揃えたほうが「同じ入力なら同じだけ見える」という
// 直感を壊さない。
const CALENDAR_QUERY_MAX_OCCURRENCES = 3000;

/**
 * time-range の floating ゾーン差を吸収するスラック(ミリ秒)。
 *
 * 【なぜ必要か】
 * PUT 時の occurrence bounds(migrations/0002)は floatingTimeZone="UTC" 固定で計算している
 * (確定設計メモ)。しかしクライアントが calendar-query に CALDAV:timezone を付けて
 * 別ゾーンを指定した場合、floating な DTSTART の実際の epoch は UTC 解釈時とズレる
 * (最大で UTC⇔UTC-12〜UTC+14 の差、約26時間ぶんの理論上限があるが、実運用のタイムゾーンは
 * せいぜい ±14h に収まる)。SQL 側の索引は UTC 前提で作られているため、そのままの
 * rangeStart/rangeEnd で絞り込むと「floating イベントが別ゾーン解釈では range 内なのに
 * 索引上は範囲外に見えて SQL で落とされる」事故が起きうる。
 * これを防ぐため、SQL へ渡す前に range を前後 24h(スラック)広げてから
 * findInCollectionByTimeRange を呼ぶ。広げた分の誤検出(false positive)は後段の
 * expandRecurrenceSet(スラック無しの本来の window)が正確な floatingTimeZone で
 * 再判定するので、最終結果の正しさには影響しない(SQL 側はあくまで候補の粗い絞り込み)。
 */
const TIME_RANGE_TZ_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * CalendarQuery ユースケース(RFC 4791 §7.8/§9.9)。
 *
 * VEVENT は反復展開して §9.9 の「いずれか1回でも一致」判定を行う。VTODO は SQL の索引
 * 絞り込みだけで採用する(反復 VTODO の展開はしない。確定設計メモの割り切り)。
 */
export class CalendarQuery {
	constructor(
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: CalendarQueryInput): Promise<CalendarQueryOutput> {
		// --- range 無し(comp-filter のみ): componentKind で絞った全件を返す ---------------
		if (input.range === undefined) {
			const all = await this.resourceRepo.findAllInCollection(input.owner, input.collectionId);
			return { resources: all.filter((r) => r.componentKind === input.componentKind) };
		}

		// --- SQL 側の粗い絞り込み(スラックを加算してから)---------------------------------
		// スラック加算はこのユースケース(application 層)の責務。repository はスラックの
		// 存在を知らず「言われた窓で引くだけ」に留める(TZ 知識を infrastructure に漏らさない
		// 確定設計メモの方針)。
		const candidates = await this.resourceRepo.findInCollectionByTimeRange(
			input.owner,
			input.collectionId,
			input.componentKind,
			input.range.startMillis - TIME_RANGE_TZ_SLACK_MS,
			input.range.endMillis + TIME_RANGE_TZ_SLACK_MS,
		);

		// --- VTODO: SQL 絞り込みのみで採用(展開しない)------------------------------------
		if (input.componentKind === "VTODO") {
			return { resources: candidates };
		}

		const range = input.range; // TS の絞り込み用ローカル束縛。

		// --- VJOURNAL: 候補を1件ずつ展開し、range(スラック無しの本来の窓)と重なる
		//     instance が1件でもあれば採用する(J-4。§9.9 の VJOURNAL 実効値表 + RRULE 反復)---
		if (input.componentKind === "VJOURNAL") {
			const matched: CalendarObjectResource[] = [];
			for (const candidate of candidates) {
				const obj = candidate.payload;
				const journals = obj.journals();
				const master = journals.find((j) => j.recurrenceId === undefined);
				if (master === undefined) continue; // マスターが無い壊れたリソースは判定不能 = 除外(VEVENT 分岐と同じ方針)。
				const overrides = journals.filter((j) => j.recurrenceId !== undefined);
				const zoneOf = zoneResolverFor(obj);
				try {
					const hit = vjournalOverlapsRange(
						this.recurrenceIterator,
						{ master, overrides, range },
						{ zoneOf, floatingTimeZone: input.floatingTimeZone ?? "UTC", maxOccurrences: CALENDAR_QUERY_MAX_OCCURRENCES },
					);
					if (hit) matched.push(candidate);
				} catch {
					// 壊れた RRULE 等で展開が例外を投げても、その1件を無視して他の候補の判定は続ける
					// (VEVENT 分岐・occurrence-bounds.ts と同じ「索引/フィルタの失敗で REPORT 全体を
					// 壊さない」方針)。
					continue;
				}
			}
			return { resources: matched };
		}

		// --- VEVENT: 候補を1件ずつ展開し、range(スラック無しの本来の窓)と重なる
		//     occurrence が1件でもあれば採用する(§9.9)---------------------------------------
		const matched: CalendarObjectResource[] = [];
		for (const candidate of candidates) {
			// candidate.payload は CalendarObjectResource.fromIcs 時に既に parse 済みの
			// ICalendarObject。ここで rawIcs を再 parse する必要は無い(二重 parse を避ける)。
			const obj = candidate.payload;
			const events = obj.events();
			const master = events.find((e) => e.recurrenceId === undefined);
			if (master === undefined) continue; // マスターが無い壊れたリソースは判定不能 = 除外。

			const overrides = events.filter((e) => e.recurrenceId !== undefined);
			const zoneOf = zoneResolverFor(obj);
			try {
				const result = expandRecurrenceSet(
					this.recurrenceIterator,
					{ master, overrides, range },
					{ zoneOf, floatingTimeZone: input.floatingTimeZone ?? "UTC", maxOccurrences: CALENDAR_QUERY_MAX_OCCURRENCES },
				);
				if (result.occurrences.length > 0) matched.push(candidate);
			} catch {
				// 壊れた RRULE 等で展開が例外を投げても、その1件を無視して他の候補の判定は続ける
				// (occurrence-bounds.ts と同じ「索引/フィルタの失敗で REPORT 全体を壊さない」方針)。
				continue;
			}
		}
		return { resources: matched };
	}
}
