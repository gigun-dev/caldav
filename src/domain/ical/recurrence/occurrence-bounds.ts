// =============================================================================
// OccurrenceBounds — PUT 時に計算する first/last occurrence 索引値(G-3)
// =============================================================================
//
// 【この索引の目的】
// RFC 4791 §9.9 の time-range フィルタは「全 recurrence instance の実効期間を推論して」
// 判定する MUST だが、REPORT のたびに全リソースを展開すると D1 上のコレクションが
// 大きくなるほど遅くなる。sabre/dav 等の先例(docs/modeling/09)にならい、PUT 時点で
// 「このリソースが取りうる最初/最後の実効開始・終了(UTC エポックミリ秒)」を1回だけ
// 計算して calendar_objects に持たせ、REPORT はまず SQL の範囲比較で候補を絞ってから
// 展開する(絞り込みが粗くても、最終判定は expandRecurrenceSet に委ねるので正しさは
// 損なわれない — これは「索引」であって「正」ではない)。
//
// 【NULL の意味(migrations/0002 のコメントと対になる)】
// 計算できない/意味を持たない場合は null を返す。呼び出し側(D1 リポジトリ)は
// NULL を「常に候補に含める」向きに扱う(§9.9 の VTODO 表で全プロパティ欠落の行が
// 常に TRUE になるのと同じ考え方 — 「絞り込めない」は「除外しない」の側に倒す)。
//
// 【無限反復の扱い(last=OCCURRENCE_INDEX_MAX で展開回避)】
// COUNT も UNTIL も無い RRULE は理論上無限に occurrence を生成する。真の last は
// 存在しないので、キャップ値 OCCURRENCE_INDEX_MAX を last とすることで「無限の先まで
// 候補でありうる」ことを表現しつつ、PUT のたびに 2100 年まで全展開する高コストな計算を
// 避ける(first だけは実際に求める必要がある — RDATE や detached override が
// DTSTART より前に来るケースがあるため、単純に DTSTART を答えにはできない)。
// =============================================================================

import type { CalDate } from "../values/cal-date";
import { parseCalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";
import { parseCalDateTime } from "../values/cal-date-time";
import { parsePeriodValue } from "../values/period-value";
import type { Property } from "../structure/types";
import type { VEvent } from "../semantics/vevent";
import type { VTodo } from "../semantics/vtodo";
import type { VJournal } from "../semantics/vjournal";
import type { ICalendarObject } from "../semantics/icalendar-object";
import { firstProp, isCalDateTime, paramFirst, parseDateOrDateTime } from "../semantics/helpers";
import { calDateStartEpochMillis, calDateTimeToEpochMillis, effectiveEventPeriod } from "../timezone";
import { resolveTimeZoneId } from "../timezone/resolver";
import { expandRecurrenceSet } from "./expansion";
import type { RecurrenceIterator } from "./iterator-port";

/**
 * 無限反復(COUNT も UNTIL も無い RRULE)の last occurrence 索引値としてのキャップ。
 * sabre/dav は 2038 年(32bit epoch の伝統的上限)をキャップに使うが、本リポジトリは
 * JS の number epoch にそのような制約が無い。かといって索引の意味(「この先ずっと
 * 候補でありうる」)を表すには実予定と衝突しないくらい先の値であればよく、2038 年は
 * すでに現実の長期予定(住宅ローン返済スケジュール等)と衝突しうる近さなので、
 * 2100 年を採用する(現行実装の想定運用期間を大きく超える、キリの良い値)。
 */
export const OCCURRENCE_INDEX_MAX = Date.UTC(2100, 0, 1);

/** computeOccurrenceBounds の結果。NULL 可(冒頭コメント参照)。 */
export interface OccurrenceBounds {
	readonly firstMillis: number | null;
	readonly lastMillis: number | null;
}

/** computeOccurrenceBounds への入力。マスター/オーバーライドは呼び出し側(application 層)が
 *  ICalendarObject.events()/todos()/journals() から RECURRENCE-ID の有無で分離して渡す。
 *  J-1: VJOURNAL 追加。ical 層は caldav 層の ComponentKind 型に依存させない(層境界。
 *  domain/ical は domain/caldav より内側なので、ここではローカルにリテラルユニオンを持つ)。 */
export interface ComputeOccurrenceBoundsInput {
	readonly componentKind: "VEVENT" | "VTODO" | "VJOURNAL";
	readonly master: VEvent | VTodo | VJournal;
	readonly overrides: readonly VEvent[];
}

export interface ComputeOccurrenceBoundsOptions {
	/** zoned の TZID → IANA 名(resolver 経由を注入)。zoneResolverFor で組み立てるのが典型。 */
	readonly zoneOf: (tzid: string) => string;
	/** 有限反復(COUNT/UNTIL あり)を展開する際の occurrence 数上限。expandRecurrenceSet へそのまま渡す。 */
	readonly maxOccurrences: number;
}

/** PUT 時に注入する zoneOf の作り方を1箇所に集約(occurrence-bounds / calendar-query の両方で使う)。
 *  ICalendarObject 内の VTIMEZONE 群から TZID を引いて resolveTimeZoneId の4段チェーンへ渡す。
 *  対応する VTIMEZONE が無くても resolveTimeZoneId 自身の①②④段(IANA直引き/Windows/エラー)は
 *  機能するので、undefined のまま渡してよい。 */
export function zoneResolverFor(obj: ICalendarObject): (tzid: string) => string {
	const timezones = obj.timezones();
	return (tzid: string): string => {
		const vtimezone = timezones.find((tz) => tz.tzid === tzid);
		return resolveTimeZoneId(tzid, vtimezone).ianaId;
	};
}

// floating の解釈ゾーンは PUT 時点では常に UTC 固定(確定設計メモ)。クエリ時のゾーン差は
// application 層のスラック(TIME_RANGE_TZ_SLACK_MS)で吸収する。
const INSTANT_OPTS_BASE = { floatingTimeZone: "UTC" as const };

/** CalDate | CalDateTime → UTC エポックミリ秒。floatingTimeZone は UTC 固定(この索引専用)。 */
function instantOf(v: CalDate | CalDateTime, zoneOf: (tzid: string) => string): number {
	if (isCalDateTime(v)) {
		return calDateTimeToEpochMillis(v, { zoneOf, ...INSTANT_OPTS_BASE });
	}
	return calDateStartEpochMillis(v, INSTANT_OPTS_BASE.floatingTimeZone);
}

/** RDATE 1プロパティ(カンマ区切り複数値、§3.8.5.2)の各値の「開始」エポックミリ秒列。
 *  PERIOD 形態は start のみ使う(索引は開始点だけ知れば十分。end は expandRecurrenceSet 側の
 *  責務で、ここでは「first の下限候補を集める」ことにしか使わない)。 */
function rdateStartMillisList(p: Property, zoneOf: (tzid: string) => string): number[] {
	const valueType = paramFirst(p, "VALUE")?.toUpperCase();
	const tzid = paramFirst(p, "TZID");
	const out: number[] = [];
	for (const item of p.value.split(",")) {
		if (valueType === "PERIOD") {
			const period = parsePeriodValue(item, tzid);
			out.push(instantOf(period.start, zoneOf));
		} else if (valueType === "DATE") {
			out.push(instantOf(parseCalDate(item), zoneOf));
		} else {
			out.push(instantOf(parseCalDateTime(item, tzid), zoneOf));
		}
	}
	return out;
}

/**
 * VEVENT の bounds を計算する。
 *
 * - 無限反復(RRULE かつ COUNT/UNTIL 無し): 展開を避け、「RRULE 自身の先頭(=DTSTART)」
 *   「RDATE の各開始」「detached になりうる override の実際の開始」の最小値を first とし、
 *   last=OCCURRENCE_INDEX_MAX とする。EXDATE がこの最小値をちょうど除外していた場合、
 *   計算結果は真の first よりわずかに早くなりうるが、索引としては安全側(絞り込みが甘く
 *   なるだけで、真の occurrence を取りこぼす方向には振れない)。
 * - それ以外(単発 / RDATE のみ / COUNT・UNTIL 付き RRULE): 08/G-2 の expandRecurrenceSet に
 *   丸ごと委譲し、[0, OCCURRENCE_INDEX_MAX) で展開した occurrences の start/end の最小/最大を取る。
 *   limitHit(maxOccurrences 到達)なら last は不完全 = 安全側で OCCURRENCE_INDEX_MAX にする。
 */
function computeVEventBounds(
	iterator: RecurrenceIterator,
	master: VEvent,
	overrides: readonly VEvent[],
	opts: ComputeOccurrenceBoundsOptions,
): OccurrenceBounds {
	const dtstart = master.dtstart;
	if (dtstart === undefined) {
		// DTSTART 欠落は本来 I2 で validate 済みのはずだが、precondition 検証前にここへ
		// 来る呼び出しがあっても壊れないよう防御的に null/null(冒頭コメントの契約どおり)。
		return { firstMillis: null, lastMillis: null };
	}

	const rrule = master.rrule;
	const isInfinite = rrule !== undefined && rrule.count === undefined && rrule.until === undefined;

	if (isInfinite) {
		const candidates: number[] = [instantOf(dtstart, opts.zoneOf)];
		for (const p of master.rdate) {
			candidates.push(...rdateStartMillisList(p, opts.zoneOf));
		}
		for (const ov of overrides) {
			if (ov.dtstart !== undefined) candidates.push(instantOf(ov.dtstart, opts.zoneOf));
		}
		return { firstMillis: Math.min(...candidates), lastMillis: OCCURRENCE_INDEX_MAX };
	}

	// 有限(単発 / RDATE のみ / COUNT・UNTIL 付き)。expandRecurrenceSet に委譲する。
	const result = expandRecurrenceSet(
		iterator,
		{ master, overrides, range: { startMillis: 0, endMillis: OCCURRENCE_INDEX_MAX } },
		{ zoneOf: opts.zoneOf, floatingTimeZone: "UTC", maxOccurrences: opts.maxOccurrences },
	);
	if (result.occurrences.length === 0) {
		return { firstMillis: null, lastMillis: null };
	}
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const o of result.occurrences) {
		if (o.startMillis < first) first = o.startMillis;
		if (o.endMillis > last) last = o.endMillis;
	}
	// limitHit(=展開を打ち切った)なら実際の last はもっと先にあるかもしれない。
	// 過剰包含側(index が甘くなる)に倒して安全性を保つ(冒頭コメントの方針)。
	return { firstMillis: first, lastMillis: result.limitHit ? OCCURRENCE_INDEX_MAX : last };
}

/**
 * VTODO の bounds を計算する。RFC 4791 §9.9 の VTODO 実効値表(rfc4791.txt L5103-5137)に
 * 従う。反復展開はしない(VTODO の RRULE 展開は G-3 のスコープ外。反復 VTODO は索引が粗く
 * なるが、SQL 絞り込みの段階でのみ使われ最終判定はしない = 正しさは損なわれない、という
 * 確定設計メモの割り切り)。
 *
 * 【2026-07-13 バグ修正: CREATED/COMPLETED を無条件候補に混ぜていた】
 * 旧実装は「DTSTART/DUE/COMPLETED/CREATED のうち存在するものすべての min/max」という
 * 単純な集合演算で first/last を出していた。だが原文の表(L5104-5137)を読むと、CREATED と
 * COMPLETED は **DTSTART も DUE も無いとき(表の N,N,N,*,* 系の行)にしか登場しない**。
 * DTSTART・DUE が存在する行(L5116-5125)の条件式は DTSTART/DUE/DURATION だけで書かれており
 * CREATED は一切現れない。
 * 実測で踏んだ不整合(単発 終日 VTODO: DTSTART=DUE=2026-12-23, CREATED=2026-07-12 だが
 * 「時刻付き due 07-12 で作成 → update-todo で due を 12-23 に変更」という経緯)はまさに
 * この旧実装の欠陥が原因: firstCandidates に CREATED(07-12)が無条件で混ざり、本来
 * DTSTART=DUE=12-23 のみで決まるべき first が 07-12 まで巻き戻っていた。RFC 4791 §9.9 の
 * time-range フィルタは「絞り込みが甘い(=索引が実際より広い)」なら安全側だが、本件は
 * 逆方向 — CREATED を早い側の候補に混ぜたことで first が「本来より早い」方向にずれるのは
 * まだ安全側(取りこぼしにはならない)だが、CREATED が DUE より後ろの日付だった場合は
 * last が縮む方向にもなり得て、その場合は time-range REPORT の取りこぼしに直結するバグ
 * (タスク A-1 の懸念どおり)。表どおり「行の優先順位に従って一意に決める」実装に直す。
 *
 * 表の各行(DTSTART?/DURATION?/DUE?/COMPLETED?/CREATED? の順、* は don't-care):
 *   Y,Y,N,*,* → first=DTSTART, last=DTSTART+DURATION
 *   Y,N,Y,*,* → first=DTSTART, last=DUE(DUE は DTSTART 以降が RFC 5545 の制約なので min/max 不要)
 *   Y,N,N,*,* → first=last=DTSTART(退化点)
 *   N,N,Y,*,* → first=last=DUE(退化点)
 *   N,N,N,Y,Y → first=min(CREATED,COMPLETED), last=max(CREATED,COMPLETED)
 *   N,N,N,Y,N → first=last=COMPLETED(退化点)
 *   N,N,N,N,Y → first=CREATED, last=無限大(条件が end>CREATED のみで上限が無い →
 *               VEVENT の無限反復と同じ考え方で OCCURRENCE_INDEX_MAX を使う)
 *   N,N,N,N,N → null/null(表の最終行 TRUE = 常に候補、NULL の意味そのもの)
 */
function computeVTodoBounds(todo: VTodo, opts: ComputeOccurrenceBoundsOptions): OccurrenceBounds {
	const dtstart = todo.dtstart;
	const due = todo.due;
	const duration = todo.duration;
	const completed = todo.completed;
	// CREATED(§3.8.7.1)は VTodo レンズにアクセサが無い(このタスク以前は使われていなかった)。
	// ロスレス保持の原則どおり raw から直接読む(レンズに専用アクセサを追加するほどでもない
	// 1回きりの参照。他の I 系検証等が CREATED を使うようになったらレンズへ格上げする)。
	const createdProp = firstProp(todo.raw, "CREATED");
	const created = createdProp !== undefined ? parseDateOrDateTime(createdProp) : undefined;

	const at = (v: CalDate | CalDateTime): number => instantOf(v, opts.zoneOf);

	if (dtstart !== undefined && duration !== undefined) {
		const end = effectiveEventPeriod({ dtstart, duration }, { zoneOf: opts.zoneOf, floatingTimeZone: "UTC" }).endMillis;
		return { firstMillis: at(dtstart), lastMillis: end };
	}
	if (dtstart !== undefined && due !== undefined) {
		return { firstMillis: at(dtstart), lastMillis: at(due) };
	}
	if (dtstart !== undefined) {
		const v = at(dtstart);
		return { firstMillis: v, lastMillis: v };
	}
	if (due !== undefined) {
		const v = at(due);
		return { firstMillis: v, lastMillis: v };
	}
	if (completed !== undefined && created !== undefined) {
		const c1 = at(completed);
		const c2 = at(created);
		return { firstMillis: Math.min(c1, c2), lastMillis: Math.max(c1, c2) };
	}
	if (completed !== undefined) {
		const v = at(completed);
		return { firstMillis: v, lastMillis: v };
	}
	if (created !== undefined) {
		// 条件式が (end > CREATED) のみで上限が無い(L5134)。VEVENT の無限反復
		// (isInfinite ブロック)と同じ「先まで候補でありうる」を OCCURRENCE_INDEX_MAX で表す。
		return { firstMillis: at(created), lastMillis: OCCURRENCE_INDEX_MAX };
	}
	return { firstMillis: null, lastMillis: null };
}

/**
 * VJOURNAL の bounds を計算する(J-1)。RFC 4791 §9.9 の VJOURNAL 実効値表は
 *
 *   DTSTART あり・DATE-TIME → (start <= DTSTART)     AND (end > DTSTART)
 *   DTSTART あり・DATE      → (start <  DTSTART+P1D) AND (end > DTSTART)
 *   DTSTART 無し            → FALSE(常に不一致)
 *
 * という「効果的な duration」を定義している(DATE なら +P1D、DATE-TIME なら 0 秒)。
 *
 * 【DTSTART 無しを FALSE ではなく null/null にする理由(このタスクの確定設計)】
 * この索引は「SQL 側の粗い絞り込み」であって最終判定ではない(冒頭コメント参照)。
 * §9.9 の表どおり DTSTART 無しを「絶対に time-range にマッチしない」として除外する索引を
 * 書いてしまうと、時間概念を持たない VJOURNAL(§3.6.3: "does not take up time on a calendar"
 * — そもそも DTSTART が無い運用が普通にありうる)が SQL 側で恒久的に候補から落ちてしまう。
 * 一方この J-1 タスクは「calendar-query の VJOURNAL+time-range 自体を unsupported として
 * 403 で弾く」設計(xml.ts の parseCalendarQueryFilter・J-4 送り)なので、この bounds が
 * 実際に time-range 絞り込みへ使われることは現状無い。だが将来 J-4 で VJOURNAL の
 * time-range REPORT を実装するときに「索引が間違って恒久除外していた」状態から始めたくない
 * ため、NULL(常に候補)の安全側に倒しておく — 0002 の NULL の意味(「絞り込めない」は
 * 「除外しない」の側に倒す)と整合させる判断。
 *
 * 【反復 VJOURNAL の扱い】
 * VTODO と同じ割り切り(computeVTodoBounds のコメント参照)で展開しない。反復の有無に
 * 関わらず単発の DTSTART のみを見て first/last を出す — RRULE 付き VJOURNAL の展開自体が
 * J-4 のスコープ外なので、索引を精密化する意味がない(どうせ最終判定で使われない)。
 */
function computeVJournalBounds(journal: VJournal, opts: ComputeOccurrenceBoundsOptions): OccurrenceBounds {
	const dtstart = journal.dtstart;
	if (dtstart === undefined) {
		// DTSTART 無し → 冒頭コメントのとおり null/null(常に候補。§9.9 の FALSE とは意図的に不一致)。
		return { firstMillis: null, lastMillis: null };
	}

	const first = instantOf(dtstart, opts.zoneOf);
	if (isCalDateTime(dtstart)) {
		// DATE-TIME: 効果的 duration は 0 秒 → first と last は同一点。
		return { firstMillis: first, lastMillis: first };
	}
	// DATE: 効果的 duration は +P1D(§9.9 の表どおり)。
	return { firstMillis: first, lastMillis: first + 24 * 60 * 60 * 1000 };
}

/**
 * PUT 時に呼ぶ、first/last occurrence 索引値の計算本体。
 *
 * 【失敗時は throw せず null/null(重要)】
 * 壊れた RRULE・TZ 解決不能(TimezoneResolutionError)など、計算中に何が起きても
 * この関数は例外を外へ投げない。索引はキャッシュであって「正」ではなく、索引が
 * 埋まらなくても time-range フィルタの正しさは NULL の扱い(常に候補に含める)で
 * 保たれる。一方 PUT 自体は(precondition を満たす限り)必ず成功させたい —
 * 索引計算の失敗で PUT が 500 になるような設計は避ける。
 */
export function computeOccurrenceBounds(
	iterator: RecurrenceIterator,
	input: ComputeOccurrenceBoundsInput,
	opts: ComputeOccurrenceBoundsOptions,
): OccurrenceBounds {
	try {
		if (input.componentKind === "VTODO") {
			return computeVTodoBounds(input.master as VTodo, opts);
		}
		if (input.componentKind === "VJOURNAL") {
			return computeVJournalBounds(input.master as VJournal, opts);
		}
		return computeVEventBounds(iterator, input.master as VEvent, input.overrides, opts);
	} catch {
		return { firstMillis: null, lastMillis: null };
	}
}
