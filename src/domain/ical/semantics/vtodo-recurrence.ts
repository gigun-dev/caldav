// =============================================================================
// vtodo-recurrence — 反復 VTODO の完了(D4 モデル。E-1 スライス②-c)
// =============================================================================
//
// 【D4 モデルの要旨(docs/modeling/06-ios-behavior-verification.md §D4/§D9 の実機所見)】
// iOS は反復 VTODO を1回完了させるとき、単純に STATUS:COMPLETED をマスターへ書かない。
// 代わりに「新しい UID を持つ“完了スナップショット”を1件作り(RRULE を持たない・STATUS:
// COMPLETED 済みの単発 VTODO)、マスター自身は DTSTART/DUE を次の occurrence へ前進させて
// STATUS:NEEDS-ACTION のまま残す」という2リソースモデルを取る。このファイルはその2つの
// 変換をそれぞれ独立した純関数として提供する(オーケストレーション — 2 PUT の実行順序 —は
// application/usecases/recurring-completion.ts の責務。ここでは Component の変換のみ)。
//
// 【なぜ2つの関数を分けるか】
// buildCompletionSnapshot と advanceMasterToNextOccurrence は「同じ入力(マスター VTODO)から
// 別々の出力を作る」独立した変換であり、互いの結果に依存しない(advance の結果を snapshot が
// 必要とすることはなく、その逆もない)。1関数に混ぜると「スナップショットを作る条件」と
// 「マスターを前進できるか」という異なる関心がテストしにくい形で結合する。
// recurring-completion.ts が両方を常に呼ぶ(2026-07-13 V8 実機実測より前は「advance が
// exhausted なら1 PUT」という分岐があったが、実機は最終回もスナップショットを作ることが
// 判明したため均一化した。下記 AdvanceResult のコメント参照)。
//
// 【iterator/zoneOf/uid/now をすべて引数注入にする理由】
// このファイルは domain/ical 層(オニオンの最内層)に置く。RecurrenceIterator は
// recurrence/iterator-port.ts の port(実装は infrastructure)、zoneOf は VTIMEZONE 解決の
// 結果を注入する関数(occurrence-bounds.ts の zoneResolverFor と同じ形)、uid/now は
// crypto.randomUUID()/Date という副作用のある値。この層は一切の外部技術・非決定性を
// 直接呼ばない(既存の vtodo-stamp.ts/vtodo-patch.ts と同じ「純関数・DI で受け取る」規律)。
// =============================================================================

import type { Component } from "../structure/types";
import { removeProperty, upsertProperty } from "../structure/edit";
import { applyCompletion, shiftAbsoluteAlarmTriggers } from "./vtodo-patch";
import type { NowStamp } from "./vtodo-stamp";
import { firstProp, isCalDateTime, parseDateOrDateTime, rawValue } from "./helpers";
import type { CalDate } from "../values/cal-date";
import { formatCalDate } from "../values/cal-date";
import type { CalDateTime } from "../values/cal-date-time";
import { formatCalDateTime, toEpochMillis } from "../values/cal-date-time";
import type { RecurrenceRule, RecurUntil } from "../values/recurrence-rule";
import { formatRecurrenceRule, parseRecurrenceRule } from "../values/recurrence-rule";
import { calDateStartEpochMillis, calDateTimeToEpochMillis } from "../timezone";
import type { RecurrenceIterator, RecurrenceWallClockFields } from "../recurrence/iterator-port";

// ---------------------------------------------------------------------------
// buildCompletionSnapshot — 「今回の occurrence を完了した」単発 VTODO を組み立てる
// ---------------------------------------------------------------------------

/**
 * buildCompletionSnapshot の識別子入力。呼び出し側(recurring-completion.ts)が
 * crypto.randomUUID() 等で採番したものを渡す(この層は乱数/UUID 生成を直接呼ばない —
 * ファイル冒頭コメントの DI 方針)。
 */
export interface CompletionSnapshotIds {
	/** スナップショット VTODO 自身の新 UID。 */
	readonly uid: string;
	/**
	 * VALARM ごとに新しい ID を1つ払い出す。呼び出し側は VALARM の数だけ異なる値を返す関数を
	 * 渡す(例: `() => crypto.randomUUID()`)。UID と X-WR-ALARMUID には**同じ VALARM 内では
	 * 同じ値**を書く(iOS 実機の観測どおり。下記ループ内で1回だけ呼んで使い回す)。
	 */
	readonly nextAlarmUid: () => string;
}

/**
 * マスター VTODO の「現在の occurrence」を完了扱いにしたスナップショット Component を作る。
 *
 * 【fixture 突合せで確定した変換内容(test/domain/ical/fixtures/real-ios/ の2本)】
 * 1. RRULE/RDATE/EXDATE を除去する(スナップショットは単発 VTODO — この UC は VTODO の
 *    RDATE/EXDATE を書き込む経路を持たないため通常は無いはずだが、ロスレス往復で稀に
 *    紛れ込んだ場合に備えて明示的に除去する)。
 * 2. UID をこのスナップショット専用の新 UID に差し替える(マスターの UID とは別物になる —
 *    D4 モデルの核心。同一 UID のまま STATUS:COMPLETED にすると「反復全体が完了した」
 *    ように見えてしまう)。
 * 3. applyCompletion(vtodo-patch.ts)で STATUS:COMPLETED / COMPLETED / PERCENT-COMPLETE:100
 *    の三点セットを立てる。
 * 4. CREATED/LAST-MODIFIED/DTSTAMP を now.utcRaw に upsert する。stampCreate(vtodo-stamp.ts)を
 *    使わない理由: stampCreate は X-APPLE-SORT-ORDER も書くが、fixture(completed-instance.ics)
 *    にはこのプロパティが無い(iOS 自身が送ってこない)。fixture 忠実を優先し、この4プロパティ
 *    だけを直接 upsert する。
 * 5. DTSTART/DUE には触れない — マスターの現在値(=いま完了させる occurrence の時刻)を
 *    そのままスナップショットへ引き継ぐ(fixture の DTSTART/DUE がマスターと同一なことで確認済み)。
 * 6. VALARM を再採番する。TRIGGER/ACTION/DESCRIPTION 等 UID 以外のプロパティ・VALARM 以外の
 *    サブコンポーネントには一切触れない(ロスレス方針)。
 */
export function buildCompletionSnapshot(masterVtodo: Component, ids: CompletionSnapshotIds, now: NowStamp): Component {
	let out = masterVtodo;

	// --- 1: RRULE/RDATE/EXDATE 除去(単発化) --------------------------------------
	out = removeProperty(out, "RRULE");
	out = removeProperty(out, "RDATE");
	out = removeProperty(out, "EXDATE");

	// --- 2: UID 差し替え -----------------------------------------------------------
	out = upsertProperty(out, "UID", ids.uid);

	// --- 3: 完了三点セット -----------------------------------------------------------
	out = applyCompletion(out, now);

	// --- 4: CREATED/LAST-MODIFIED/DTSTAMP を完了時刻へ(X-APPLE-SORT-ORDER は書かない。上記コメント参照) ---
	out = upsertProperty(out, "CREATED", now.utcRaw);
	out = upsertProperty(out, "LAST-MODIFIED", now.utcRaw);
	out = upsertProperty(out, "DTSTAMP", now.utcRaw);

	// --- 6: VALARM の UID / X-WR-ALARMUID を再採番 ----------------------------------
	// 【なぜ「既に UID がある/X-WR-ALARMUID がある」ときだけ upsert するのか】
	// マスター VALARM に無いプロパティを新設してしまうと「サーバーが勝手に VALARM の形を
	// 変えた」ことになりロスレス方針(edit.ts の upsertProperty コメント)に反する。iOS 由来の
	// VALARM は常に両方持つ(fixture 参照)が、将来サーバー生成 VALARM 等に UID しか無い/
	// どちらも無いケースが来ても壊れないよう、存在確認してから upsert する防御的な書き方にする。
	const components = out.components.map((c) => {
		if (c.name !== "VALARM") return c;
		const id = ids.nextAlarmUid(); // 1 VALARM につき1回だけ呼ぶ(UID と X-WR-ALARMUID で使い回す)。
		let alarm = c;
		if (alarm.properties.some((p) => p.name === "UID")) {
			alarm = upsertProperty(alarm, "UID", id);
		}
		if (alarm.properties.some((p) => p.name === "X-WR-ALARMUID")) {
			alarm = upsertProperty(alarm, "X-WR-ALARMUID", id);
		}
		return alarm;
	});
	out = { ...out, components };

	return out;
}

// ---------------------------------------------------------------------------
// advanceMasterToNextOccurrence — マスターの DTSTART/DUE を次の occurrence へ前進させる
// ---------------------------------------------------------------------------

/**
 * 【2026-07-13 V8 本番実機実測で確定した契約(旧 "exhausted" 分岐からの変更)】
 * 旧仕様は「UNTIL を越えた/COUNT が尽きた」場合に "exhausted" を返し、呼び出し側は前進を
 * 諦めてマスターへその場 applyCompletion していた(スナップショット無し・1 PUT)。
 * しかし本番実機(iOS 26.5・FREQ=DAILY;UNTIL・2 occurrence を最後まで完了)を見たところ、
 * iOS は**最終 occurrence でも**完了スナップショットを作り、かつマスターの DTSTART/DUE を
 * 「UNTIL/COUNT を無視した次の生ステップ」へ前進させ、その上で STATUS:COMPLETED を立てていた
 * (RRULE は UNTIL 込みで不変)。つまり「前進できるかどうか」の分岐点は UNTIL/COUNT ではなく
 * 「iterate() が次の壁時計候補を1件も返せない(病的ケース)かどうか」だけになる。
 *
 * - "advanced": 常に「次の生ステップ」(UNTIL/COUNT を無視して FREQ 上あり得る次の候補)へ
 *   前進した結果。`seriesEnded` は「この生ステップが UNTIL を越えた、または今回の occurrence が
 *   COUNT 上の最後だった」ことを示すフラグで、STATUS をどちらにすべきか(NEEDS-ACTION か
 *   COMPLETED か)は呼び出し側(recurring-completion.ts)がこのフラグを見て決める。
 *   この関数自身はもう STATUS を決めない(下記の責務分離コメント参照)。
 * - "no-next-step": 1000 件走査しても次の生ステップが1件も見つからなかった病的ケースのみ
 *   (BYxxx の組み合わせが不整合で実質的に「二度と発生しない」RRULE 等)。実機でこの経路が
 *   踏まれる状況は想定していない(理論上の保険)。呼び出し側はこのときだけ前進を諦め、
 *   その場 applyCompletion するフォールバックを取る。
 */
export type AdvanceResult =
	| { readonly kind: "advanced"; readonly vtodo: Component; readonly seriesEnded: boolean }
	| { readonly kind: "no-next-step" };

/**
 * 「次候補を探すために消費する iterate() の壁時計フィールド数」の上限。COUNT も UNTIL も
 * 現実的な範囲に収まっていれば数件で見つかるはずだが、病的な BYxxx の組み合わせ
 * (例: BYMONTHDAY=31;FREQ=MONTHLY で該当月がほぼ無い等)が「次の1件」を見つけるまでに
 * 大量の壁時計を要求してくるケースへの保険。定数名・値そのものに RFC 上の根拠は無い
 * (Fable 設計メモの「保険」という位置づけそのまま)。
 */
const MAX_ADVANCE_SCAN = 1000;

/**
 * マスター VTODO の DTSTART/DUE を「現在の DTSTART より後の最初の occurrence」へ前進させる。
 *
 * 【展開規約は expansion.ts(RecurrenceExpansion)と同一だが、ここでは複製する】
 * expansion.ts の instantOfDateValue/wallFieldsOf/reconstructCalDateTime/
 * ruleWithoutBoundsForIterator/untilEpochOf は非公開(export されていない)関数で、
 * G-1/G-2 の完成物(expansion.ts)は変更しない方針(CLAUDE.md 準拠のタスク指示)のため、
 * このファイル内に同じロジックをそのまま複製する(calendarDaysBetween を独自複製した
 * expansion.ts 自身の前例と同じ判断)。壁時計のまま列挙し、UTC 化は個別に行う鉄則
 * (expansion.ts 冒頭コメント)もここで踏襲する。
 *
 * @param masterVtodo    前進対象のマスター VTODO(RRULE を持つ前提)。
 * @param iterator       RRULE 反復 port(DI)。
 * @param zoneOf         zoned の TZID → IANA 名の解決(zoneResolverFor で組み立てたものを渡す)。
 * @param floatingTimeZone floating/DATE を解釈するゾーン。既定 "UTC"(PUT 時点の確定設計に揃える)。
 */
export function advanceMasterToNextOccurrence(
	masterVtodo: Component,
	iterator: RecurrenceIterator,
	zoneOf: (tzid: string) => string,
	floatingTimeZone = "UTC",
): AdvanceResult {
	const dtstartProp = firstProp(masterVtodo, "DTSTART");
	if (dtstartProp === undefined) {
		// DTSTART は VTODO の RRULE 前進に必須(§3.6.2 の RRULE 使用は DTSTART 前提)。
		// 呼び出し側(recurring-completion.ts)は rrule ありの VTODO でしか呼ばない契約なので、
		// ここに来るのは壊れたデータ。expansion.ts の同種の throw に倣う。
		throw new Error("advanceMasterToNextOccurrence: VTODO has no DTSTART");
	}
	const dtstart = parseDateOrDateTime(dtstartProp);

	const rruleRaw = rawValue(masterVtodo, "RRULE");
	if (rruleRaw === undefined) {
		throw new Error("advanceMasterToNextOccurrence: VTODO has no RRULE");
	}
	const rrule = parseRecurrenceRule(rruleRaw);

	const instantOpts = { zoneOf, floatingTimeZone };
	const currentEpoch = instantOfDateValue(dtstart, instantOpts);

	const isDate = !isCalDateTime(dtstart);
	// UNTIL だけでなく COUNT も除いた「生の」ルールを iterator に渡す(下記関数コメント参照)。
	// COUNT 付きのまま渡すと、最終 occurrence(COUNT=1 が消費し切った状態)の完了時に iterator が
	// 「もう1件も返せない」状態になり、"次の生ステップ" を探せなくなってしまう
	// (2026-07-13 V8 実機実測で「最終回も前進する」ことが確定したため、この除去が必須になった)。
	const ruleForIterator = ruleWithoutBoundsForIterator(rrule, isDate);
	const untilEpoch = rrule.until !== undefined ? untilEpochOf(rrule.until, instantOpts) : undefined;
	const dtstartFields = wallFieldsOf(dtstart);

	// --- 次候補の探索(先頭は dtstart 自身。currentEpoch より真に大きい最初の値を採用) -----
	let nextLocal: CalDate | CalDateTime | undefined;
	let nextEpoch = 0;
	let scanned = 0;
	for (const wf of iterator.iterate(ruleForIterator, dtstartFields, isDate)) {
		if (scanned >= MAX_ADVANCE_SCAN) break;
		scanned++;
		const localValue = isDate ? { year: wf.year, month: wf.month, day: wf.day } : reconstructCalDateTime(dtstart as CalDateTime, wf);
		const epoch = instantOfDateValue(localValue, instantOpts);
		if (epoch <= currentEpoch) continue; // dtstart 自身、または同epochの重複は前進候補にならない。
		nextLocal = localValue;
		nextEpoch = epoch;
		break;
	}

	if (nextLocal === undefined) {
		// 1000 件走査しても currentEpoch より後が見つからなかった = 病的ケース(理論上の保険。
		// 実機でこの経路を踏む状況は確認できていない — AdvanceResult コメント参照)。
		return { kind: "no-next-step" };
	}

	// --- seriesEnded 判定(前進処理そのものは止めない — 2026-07-13 V8 実機実測で確定) ---------
	// 【UNTIL(inclusive。§3.3.10: occurrence == UNTIL は含む)】
	// 「次の生ステップが UNTIL を越えた」ら、その生ステップは RFC 上は存在しない occurrence だが、
	// iOS は実機上「それでも DTSTART/DUE をそこへ前進させ、STATUS だけ COMPLETED にする」動きを
	// 見せた(本番実機: UNTIL=20260714 の最終回完了で DTSTART が UNTIL 越えの 07-15 になった)。
	// 【COUNT】今回の occurrence の完了時点で rrule.count <= 1(=今回が数え上げ上の最後)だった
	// ケースも同様に「越えた」とみなす。
	const seriesEnded = (untilEpoch !== undefined && nextEpoch > untilEpoch) || (rrule.count !== undefined && rrule.count <= 1);

	let out = masterVtodo;

	// --- RRULE の書き戻し -----------------------------------------------------------------
	// UNTIL は前進しても常に不変(実機実測どおり・上下 seriesEnded どちらの場合も同じ)。
	if (rrule.count !== undefined) {
		if (seriesEnded) {
			// 【推定・実機未検証】COUNT 由来で今回が最後だったケースの RRULE 書き戻しは
			// 2026-07-13 時点で実機実測が無い(実機で確認できたのは UNTIL 系列の最終回のみ)。
			// UNTIL 系列で「RRULE(UNTIL 含め)は前進しても不変」だった実測と平仄を合わせ、
			// ここでも count を減算せず不変に保つ判断を採用する。可逆な判断であり、後日 COUNT
			// 系列の実機実測が取れ次第、ここだけ直せばよい(count-1 等への変更を想定)。
			// ボツ案: 「continuation と同様に count-1 する」も検討したが、count=1→count=0 という
			// 「もう発生しない」ことを RRULE 自身が語る形になり、STATUS:COMPLETED と情報が
			// 重複する(RRULE 側だけで見ても矛盾は起きない)ため、両論あり得ると判断し保留した。
		} else {
			// 【COUNT を1減らす理由(§3.3.10「DTSTART は常に最初の occurrence」)】
			// 前進後は「新しい DTSTART」が反復の起点になる。元の COUNT は「元 DTSTART から数えて
			// 何回」なので、前進した新マスターにとっては「新 DTSTART から数えて (COUNT-1) 回」が
			// 残りの正しい回数になる。
			const newRule: RecurrenceRule = { ...rrule, count: rrule.count - 1 };
			out = upsertProperty(out, "RRULE", formatRecurrenceRule(newRule));
		}
	}
	// UNTIL のみ(COUNT 無し)のときは常に RRULE 不変(fixture 実測どおり)。

	// --- DTSTART 書き戻し(元の parameters=TZID/VALUE=DATE 等を流用) ---------------------
	out = upsertProperty(out, "DTSTART", formatDateValue(nextLocal), dtstartProp.parameters);

	// --- DUE 書き戻し(DUE-DTSTART の壁時計差を保持) -------------------------------------
	const dueProp = firstProp(out, "DUE");
	if (dueProp !== undefined) {
		const due = parseDateOrDateTime(dueProp);
		// 【TZID 相違の限界】DUE と DTSTART が異なる TZID を持つ病的なケースでは、この
		// 「壁時計フィールドをそのまま Date.UTC の暦カウンタとして差分を取る」計算は
		// (どちらも「同じゾーンの壁時計」という前提が崩れるため)本来の経過時間とズレうる。
		// VTodo.validate() の I6 相当検証(DUE の値型は DTSTART と一致 MUST)は形態
		// (floating/utc/zoned)一致までは強制していないため、この限界は理論上残る。
		// iOS 実機は DTSTART/DUE を同一 TZID で送るのが通例(fixture もそう)なので、
		// このスライスでは対応せず限界として明記するに留める(Fable 確定設計どおり)。
		const diffMs = wallClockMillis(due) - wallClockMillis(dtstart);
		const newDue = withNewWallClockFields(due, wallClockMillis(nextLocal) + diffMs);
		out = upsertProperty(out, "DUE", formatDateValue(newDue), dueProp.parameters);
	}
	// DUE 無しなら何もしない(spec どおり)。

	// --- VALARM 絶対トリガーの前進(2026-07-13 追加。本番 D1 実機検証 V3 で判明した欠落) ---
	// 【seriesEnded に関わらず同じロジックを適用する】このシフト自体は「マスターを次の生
	// ステップへ前進させる」処理の一部であり、STATUS が NEEDS-ACTION になるか COMPLETED に
	// なるかとは独立(前進する以上、絶対トリガーも前進すべき値は変わらない)。
	// 【実機未検証の注記】この「最終回でも VALARM を同じロジックで前進させる」という判断は、
	// V8 実機実測(VALARM 無しの反復)からの類推であり、VALARM 付きの最終回パターン自体は
	// 実機で確認できていない(推定)。
	// 【DUE の壁時計差保持(上のブロック)とは別物 — 混同しないこと】
	// DUE は「DTSTART との壁時計フィールドの見た目上の差」を保持する(TZ を見ない暦カウンタ差分)。
	// 対して VALARM 絶対トリガー(TRIGGER;VALUE=DATE-TIME、常に UTC — §3.8.6.3 trigabs 文法。
	// docs/rfc/rfc5545.txt で確認済み)は "絶対時刻" そのものなので、前進させるべきは
	// 「occurrence の絶対エポックの差」= triggerShiftMs = nextEpoch - currentEpoch。
	// 本番実測(CAP-RRULE2・FREQ=DAILY・DTSTART 20260712T010000+09:00→20260713T010000+09:00)で
	// iOS が VALARM を 20260712T160000Z → 20260713T160000Z へちょうど +86400000ms 前進させて
	// いることを確認済み(= DTSTART の壁時計差 86400000ms と一致。夏時間を跨ぐ TZID では
	// 壁時計差と絶対時刻差がズレうるが、trigabs は UTC 絶対値そのものなので "絶対時刻差" が
	// 常に正しい前進量— DUE のような「TZ 非依存の壁時計差」ロジックを流用してはいけない)。
	const triggerShiftMs = nextEpoch - currentEpoch;
	out = shiftAbsoluteAlarmTriggers(out, triggerShiftMs);

	// 【STATUS の決定はこの関数の責務から外した(2026-07-13)】
	// 旧実装はここで無条件に applyReopen(STATUS:NEEDS-ACTION に戻す)を呼んでいたが、それは
	// 「前進 = 継続」しかなかった旧契約(exhausted 時はこの関数を素通りしていた)の名残。
	// 新契約では advanced が「継続」と「最終回」の両方をカバーするため、STATUS をどちらに
	// すべきか(NEEDS-ACTION か COMPLETED か)は seriesEnded の値次第になり、それを知っているのは
	// 呼び出し側(recurring-completion.ts — applyCompletion/applyReopen のどちらを当てるか判断する
	// 場所)であって、この関数ではない。DTSTART/DUE/RRULE/VALARM の前進という「時刻・反復定義の
	// 変換」に責務を絞り、STATUS という「完了状態の解釈」を混ぜないことで、テスト・呼び出し側
	// それぞれの関心を分離する。

	// LAST-MODIFIED/DTSTAMP はここでは触らない。呼び出し側(recurring-completion.ts)が
	// stampUpdate を後から呼ぶ既存規律(vtodo-stamp.ts 冒頭コメント「生成プロパティの単一情報源」)
	// に合わせ、この純関数はフィールドの前進だけに責務を絞る。

	return { kind: "advanced", vtodo: out, seriesEnded };
}

// ---------------------------------------------------------------------------
// VALARM 絶対トリガーの shift は domain/ical/semantics/vtodo-patch.ts の
// shiftAbsoluteAlarmTriggers に共有化した(2026-07-13。update-todo.ts の due 変更でも
// 同じ変換が必要になったため反復専用ファイルから patch 系プリミティブへ引き上げた —
// 詳細な判別ロジックのコメント(trigabs 判定・位置アラーム除外等)は移設先を参照)。
// ---------------------------------------------------------------------------
// 内部ヘルパー(expansion.ts の非公開ヘルパーのローカル複製 + このファイル固有のもの)
// ---------------------------------------------------------------------------

/** CalDate | CalDateTime → UTC エポックミリ秒。expansion.ts の instantOfDateValue の複製。 */
function instantOfDateValue(v: CalDate | CalDateTime, opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string }): number {
	if (isCalDateTime(v)) {
		return calDateTimeToEpochMillis(v, opts);
	}
	return calDateStartEpochMillis(v, opts.floatingTimeZone);
}

/** RecurrenceIterator に渡す壁時計フィールドへ変換する。expansion.ts の wallFieldsOf の複製。 */
function wallFieldsOf(v: CalDate | CalDateTime): RecurrenceWallClockFields {
	if (isCalDateTime(v)) {
		return { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second === 60 ? 59 : v.second };
	}
	return { year: v.year, month: v.month, day: v.day, hour: 0, minute: 0, second: 0 };
}

/** iterator が返した壁時計を dtstart と同じ kind へ組み戻す。expansion.ts の reconstructCalDateTime の複製。 */
function reconstructCalDateTime(dtstart: CalDateTime, wf: RecurrenceWallClockFields): CalDateTime {
	const base = { year: wf.year, month: wf.month, day: wf.day, hour: wf.hour, minute: wf.minute, second: wf.second };
	switch (dtstart.kind) {
		case "utc":
			return { kind: "utc", ...base };
		case "floating":
			return { kind: "floating", ...base };
		case "zoned":
			return { kind: "zoned", tzid: dtstart.tzid, ...base };
	}
}

/**
 * RRULE から UNTIL・COUNT を除いた(DATE dtstart なら BYSECOND/BYMINUTE/BYHOUR も除いた)コピー。
 * expansion.ts の ruleWithoutUntilForIterator を出発点に複製したが、この関数は「UNTIL だけ」
 * ではなく「反復を打ち切りうる境界(UNTIL/COUNT)を両方除いた"生の"ルール」を返す必要がある
 * ため、複製時に COUNT 除去を追加し、実態に合わせて改名した(2026-07-13。旧名
 * ruleWithoutUntilForIterator のままだと COUNT も除いている事実が読み取れず誤解を招くため)。
 * 【なぜ COUNT も除くか】advanceMasterToNextOccurrence は「次の生ステップ」(UNTIL/COUNT を
 * 無視した FREQ 上あり得る次の occurrence)を探す必要がある。COUNT 付きのまま iterator に
 * 渡すと、COUNT を使い切った状態(今回が最終 occurrence)からは iterator が1件も返せず、
 * 「次の生ステップへ前進する」という新契約(seriesEnded)を満たせなくなる。
 */
function ruleWithoutBoundsForIterator(rule: RecurrenceRule, isDate: boolean): RecurrenceRule {
	const { until: _until, count: _count, bySecond, byMinute, byHour, ...rest } = rule;
	if (!isDate) {
		return { ...rest, bySecond, byMinute, byHour };
	}
	return { ...rest };
}

/** RRULE UNTIL の epoch。expansion.ts の untilEpochOf の複製。 */
function untilEpochOf(until: RecurUntil, opts: { zoneOf: (tzid: string) => string; floatingTimeZone: string }): number {
	if (until.type === "date") {
		return calDateStartEpochMillis(until.date, opts.floatingTimeZone);
	}
	if (until.dateTime.kind === "utc") {
		return toEpochMillis(until.dateTime);
	}
	return calDateTimeToEpochMillis(until.dateTime, opts);
}

/** CalDate | CalDateTime → 生の値文字列(DTSTART/DUE 書き戻し用)。 */
function formatDateValue(v: CalDate | CalDateTime): string {
	return isCalDateTime(v) ? formatCalDateTime(v) : formatCalDate(v);
}

/**
 * 「壁時計フィールドをそのまま暦カウンタとして」ミリ秒化する(DUE-DTSTART の差分計算専用。
 * expansion.ts/occurrence-bounds.ts の instantOfDateValue とは別物 — あちらは zoneOf を使って
 * “絶対時刻” に変換するが、ここでは TZ を一切考慮せず「年月日時分秒のフィールドの見た目上の
 * 差」だけを知りたい。DUE-DTSTART が同じ TZID なら、この壁時計差は前進後もそのまま
 * 成立する[Fable 確定設計 item7]。calendarDaysBetween(expansion.ts が独自複製した
 * Date.UTC ベースの「TZ 非依存の暦カウンタ」という考え方)を時刻付きまで拡張したもの)。
 */
function wallClockMillis(v: CalDate | CalDateTime): number {
	if (isCalDateTime(v)) {
		// うるう秒(60)はカレンダーカウンタ上でも 59 にクランプする(cal-date-time.ts の
		// 「保持は60・計算時のみ59」方針をここでも踏襲)。
		return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second === 60 ? 59 : v.second);
	}
	return Date.UTC(v.year, v.month - 1, v.day);
}

/** wallClockMillis の逆変換を「template と同じ kind/tzid」で組み立てる。 */
function withNewWallClockFields(template: CalDate | CalDateTime, ms: number): CalDate | CalDateTime {
	const d = new Date(ms);
	const base = {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
	if (!isCalDateTime(template)) {
		return { year: base.year, month: base.month, day: base.day };
	}
	switch (template.kind) {
		case "utc":
			return { kind: "utc", ...base };
		case "floating":
			return { kind: "floating", ...base };
		case "zoned":
			return { kind: "zoned", tzid: template.tzid, ...base };
	}
}
