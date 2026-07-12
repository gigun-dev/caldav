// =============================================================================
// task-dto — Task DTO(E-2 UI-ready・全 todo 系ユースケース共通)
// =============================================================================
//
// 【この DTO の位置づけ】
// CreateTodo / ListTodos(E-1 スライス①)が共に返す出力の形。将来の CompleteTodo/UpdateTodo/
// DeleteTodo(スライス②以降)も同じ Task 形を使う想定なので、application 層内の共有モジュールに
// 切り出す(UC ごとに同じ変換ロジックを重複させない)。
//
// 【日時整形をここで持つ理由(presentation/mcp/format.ts を import しない)】
// 仕様上は「日時整形は format.ts 流用」という指示があったが、format.ts は
// src/presentation/mcp/format.ts に置かれており、application → presentation の import は
// 依存の向きが逆(オニオンアーキテクチャ違反。CI の層境界チェックにも引っかかる)。
// よってロジックは流用しつつ、実体はこのファイルにコピーして application 層内に閉じる
// (中身は format.ts の epochToIso/formatDateOnly と同じ計算— offset 付き ISO8601 組み立て・
// IANA ゾーンでの現地日付抽出。二重実装ではあるが、10行強の純関数で「意味のある共有」より
// 「層境界の健全性」を優先した判断。将来 domain/ical/timezone 配下に格上げしてもよい)。
// =============================================================================

import type { VTodo } from "../../domain/ical/semantics";
import type { CalDate, CalDateTime } from "../../domain/ical/values";
import { decodeText } from "../../domain/ical/values";
import { calDateStartEpochMillis, calDateTimeToEpochMillis, getZoneOffsetMillis } from "../../domain/ical/timezone";

// CalDate | CalDateTime の判別。semantics/helpers.ts の isCalDateTime は semantics/index.ts の
// 公開 API に含まれていない(意図的に内部ヘルパー扱い)ため、mcp/server.ts の
// list-events-expanded と同じ判定手法(CalDateTime だけが持つ "kind" フィールドの有無)を
// ここでも踏襲する(ical/index.ts の「index 経由でのみ import」方針を守りつつ、
// 新しい公開 API を増やさずに済ませる)。
function isCalDateTime(v: CalDate | CalDateTime): v is CalDateTime {
	return "kind" in v;
}

/** MCP/将来 REST から共通で返す todo の表現(方向性 E-2 の UI-ready DTO 合意)。 */
export interface Task {
	id: string;
	title: string;
	completed: boolean;
	/** STATUS の生値(NEEDS-ACTION/COMPLETED/IN-PROCESS/CANCELLED 等)。未設定は null。 */
	status: string | null;
	/** "YYYY-MM-DD"(終日)または ISO8601(時刻付き)。DUE 無しは null。 */
	due: string | null;
	/** due が VALUE=DATE(終日)かどうか。due が null のときは false。 */
	isAllDay: boolean;
	/** PRIORITY(0-9)。未設定(プロパティ無し)は 0 として返す(§3.8.1.9 の「0=未定義」に合わせる)。 */
	priority: number;
	/** PERCENT-COMPLETE(0-100)。未設定は null。 */
	percentComplete: number | null;
	/** COMPLETED(完了時刻)。ISO8601(UTC MUST なので常に "...Z")。未設定は null。 */
	completedAt: string | null;
	/** DESCRIPTION。未設定は null。 */
	notes: string | null;
	/**
	 * X-APPLE-SORT-ORDER(Apple 拡張・INTEGER)。E-1 スライス②-a で追加。stampCreate が
	 * CFAbsoluteTime(2001-01-01 UTC 起点秒)で書き込む値をそのまま読み戻す(vtodo-stamp.ts
	 * 参照)。iOS 実機の並び順と一致させるための値なので、意味解釈(逆算して Date に戻す等)は
	 * せず生の INTEGER を渡す。未設定・不正値(NaN)は null。
	 */
	sortOrder: number | null;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

// presentation/mcp/format.ts の epochToIso と同じ計算(ファイル冒頭コメントの層境界判断により複製)。
function epochToIsoLocal(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	const wall = new Date(millis + offsetMillis);
	const datePart =
		`${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
		`T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}`;
	if (offsetMillis === 0) return `${datePart}Z`;
	const sign = offsetMillis < 0 ? "-" : "+";
	const absMinutesTotal = Math.round(Math.abs(offsetMillis) / 60000);
	return `${datePart}${sign}${pad2(Math.floor(absMinutesTotal / 60))}:${pad2(absMinutesTotal % 60)}`;
}

// CalDate(VALUE=DATE)は「その日付そのもの」を返せばよく、タイムゾーンでの現地化は不要
// (formatDateOnly はエポックミリ秒からゾーンで日付を逆算するためのものだが、CalDate は
// そもそも年月日フィールドを直接持っているので、ここでは素直にフィールドから組み立てる)。
function formatCalDateAsIso(d: CalDate): string {
	return `${d.year.toString().padStart(4, "0")}-${pad2(d.month)}-${pad2(d.day)}`;
}

/**
 * due(CalDate | CalDateTime)を Task.due の表現に変換する。
 * @param zoneOf zoned の TZID → IANA 名の解決(zoneResolverFor で組み立てたものを渡す)。
 * @param timeZone DATE-TIME を表示するゾーン(floating の既定解釈にも使う)。
 */
function formatDue(
	due: CalDate | CalDateTime,
	zoneOf: (tzid: string) => string,
	timeZone: string,
): { due: string; isAllDay: boolean } {
	if (!isCalDateTime(due)) {
		return { due: formatCalDateAsIso(due), isAllDay: true };
	}
	const millis = calDateTimeToEpochMillis(due, { zoneOf, floatingTimeZone: timeZone });
	return { due: epochToIsoLocal(millis, timeZone), isAllDay: false };
}

/**
 * VTodo レンズ(読み取り専用)から Task DTO を組み立てる。
 * @param zoneOf zoned な DUE の TZID 解決。呼び出し側が zoneResolverFor(icalendarObject) で作る。
 * @param timeZone due/completedAt を表示するゾーン。省略時は UTC。
 */
export function taskFromVTodo(
	vtodo: VTodo,
	zoneOf: (tzid: string) => string = (tzid) => tzid,
	timeZone = "UTC",
): Task {
	const due = vtodo.due;
	const dueOut = due !== undefined ? formatDue(due, zoneOf, timeZone) : null;

	const completed = vtodo.completed;
	// COMPLETED は §3.8.2.1 で UTC DATE-TIME MUST。vtodo.completed の型は due と同じ
	// CalDate|CalDateTime の union(vtodo.ts のアクセサ定義。COMPLETED が DATE 形態を
	// 取ることは RFC 上ありえないが、型としては union のまま公開されている)。
	// 万一 CalDate や utc 以外の CalDateTime が来ても、ここでは落とさず(ロスレス優先)
	// isCalDateTime の分岐で吸収する — CalDate は「その日の 00:00」として扱う。
	const completedAt = completed === undefined
		? null
		: isCalDateTime(completed)
			? epochToIsoLocal(calDateTimeToEpochMillis(completed, { zoneOf, floatingTimeZone: "UTC" }), "UTC")
			: epochToIsoLocal(calDateStartEpochMillis(completed, "UTC"), "UTC");

	// DESCRIPTION(§3.8.1.5)。VTodo レンズに型付きアクセサが無いため(vtodo.ts は summary は
	// 持つが description は今回未追加 — 既存ファイルを変更しない方針のため raw から直接読む)、
	// raw Component から取得して decodeText でエスケープ解除する(TEXT 値のデコードは
	// values/text-value.ts の責務。semantics 層のレンズと同じやり方 — rawValue 相当を自前で書く)。
	const descriptionProp = vtodo.raw.properties.find((p) => p.name === "DESCRIPTION");
	const notes = descriptionProp !== undefined ? decodeText(descriptionProp.value) : null;

	// X-APPLE-SORT-ORDER。VTodo レンズに型付きアクセサが無い(vtodo.ts は既存ファイルを変更
	// しない方針のため raw から直接読む — DESCRIPTION と同じやり方)。parseInt が NaN を返す
	// (プロパティ無し、または不正な値)場合は null にする(ロスレス優先: 例外にはしない)。
	const sortOrderProp = vtodo.raw.properties.find((p) => p.name === "X-APPLE-SORT-ORDER");
	const parsedSortOrder = sortOrderProp !== undefined ? Number.parseInt(sortOrderProp.value, 10) : Number.NaN;
	const sortOrder = Number.isNaN(parsedSortOrder) ? null : parsedSortOrder;

	// 【既存 MCP ツール(list-events-expanded)との差: title/notes は decodeText する】
	// vtodo.summary(既存レンズ)は Property.value の生テキスト(エスケープ済み)をそのまま返す
	// (semantics 層の一貫方針。list-events-expanded の component.summary も同じく raw のまま
	// 応答に出している)。しかし Task DTO は「E-2 UI-ready」— chat UI にそのまま出す前提の
	// 表現なので、SUMMARY\, with\, commas のような生テキストを見せるのはユーザー体験として
	// 誤り。CreateTodo が encodeText で書き込んだ意味的文字列と対称になるよう、Task.title/notes
	// はここで decodeText して意味的文字列に復元する(既存ツールの表面とは非対称になるが、
	// 「新しい DTO 形は意味的文字列」という E-2 の合意を優先する)。
	return {
		id: vtodo.uid ?? "",
		title: vtodo.summary !== undefined ? decodeText(vtodo.summary) : "",
		completed: vtodo.status === "COMPLETED",
		status: vtodo.status ?? null,
		due: dueOut?.due ?? null,
		isAllDay: dueOut?.isAllDay ?? false,
		priority: vtodo.priority ?? 0,
		percentComplete: vtodo.percentComplete ?? null,
		completedAt,
		notes,
		sortOrder,
	};
}

// calDateStartEpochMillis は現状 taskFromVTodo から直接は使わない(due の DATE 表現は
// formatCalDateAsIso で十分)。ListTodos の dueBefore/dueAfter フィルタ(list-todos.ts)が
// 「DATE の due をエポックへ変換して比較する」ために同じ変換が要るため、ここから re-export して
// 二重実装を避ける。
export { calDateStartEpochMillis, calDateTimeToEpochMillis };
