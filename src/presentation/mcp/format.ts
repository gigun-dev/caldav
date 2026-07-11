// =============================================================================
// mcp/format — MCP ツール応答の時刻表現ヘルパー(G-5)
// =============================================================================
//
// 【なぜここに置くか(「応答 TZ 分離」09 §1)】
// domain/application 層は epoch ms のまま扱い、ISO8601 の offset 付き文字列化
// (人間/LLM が読む MCP 応答の形)は presentation 層の責務とする
// (compute-free-busy.ts / list-occurrences.ts のコメントと同じ方針)。
// XML(DAV)と同様、MCP も「プロトコル固有の表現知識」を presentation に隔離する。
// =============================================================================

import { getZoneOffsetMillis } from "../../domain/ical/timezone/instant";
import { isValidIanaZone } from "../../domain/ical/timezone/resolver";

// resolver.ts の isValidIanaZone をそのまま MCP ツールの入力検証に再利用する
// (「不正な IANA ゾーン名はエラー」という要件を、ゾーン判定ロジックを二重実装せずに満たす)。
export { isValidIanaZone };

/**
 * 2桁ゼロ埋め。ISO8601 のオフセット/日付フィールド組み立てで繰り返し使うので小関数化。
 */
function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * offset 付き ISO8601 文字列を組み立てる。
 *
 * 【UTC は "Z"、それ以外は "±HH:MM"(2桁固定)にする理由】
 * RFC 3339 / ISO8601 のどちらの表記でも valid だが、UTC を "+00:00" と書くより "Z" の方が
 * MCP クライアント(LLM)側の可読性が高い(慣行としても "Z" が主流)。offset 分は IANA
 * ゾーンでも常に整数分(既知のゾーンに端数秒オフセットは無い)なので "±HH:MM" で表現しきれる。
 *
 * @param millis  UTC エポックミリ秒。
 * @param timeZone 表示に使う IANA ゾーン名(呼び出し側が isValidIanaZone で検証済みの前提)。
 */
export function epochToIso(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	// 壁時計 = UTC + offset(instant.ts の getZoneOffsetMillis と同じ規約)。
	const wallMillis = millis + offsetMillis;
	const wall = new Date(wallMillis);

	// Date の "UTC" アクセサを使って壁時計フィールドを取り出す(wallMillis 自体はもう
	// 「UTC 時刻としてみなした壁時計」なので、ローカル TZ 依存のメソッドは使わない —
	// instant.ts の「ランタイム TZ 非依存」方針をここでも踏襲する)。
	const year = wall.getUTCFullYear();
	const month = pad2(wall.getUTCMonth() + 1);
	const day = pad2(wall.getUTCDate());
	const hour = pad2(wall.getUTCHours());
	const minute = pad2(wall.getUTCMinutes());
	const second = pad2(wall.getUTCSeconds());
	const datePart = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

	if (offsetMillis === 0) return `${datePart}Z`;

	const sign = offsetMillis < 0 ? "-" : "+";
	const absMinutesTotal = Math.round(Math.abs(offsetMillis) / 60000);
	const offsetHour = pad2(Math.floor(absMinutesTotal / 60));
	const offsetMinute = pad2(absMinutesTotal % 60);
	return `${datePart}${sign}${offsetHour}:${offsetMinute}`;
}

/**
 * DATE 値(終日イベント)用の "YYYY-MM-DD" 表示。
 * timeZone は calDateStartEpochMillis で「そのゾーンの現地 00:00」として epoch 化された値を
 * 逆算するために使う(epochToIso と同じオフセット計算で壁時計へ戻し、日付部分だけ取り出す)。
 */
export function formatDateOnly(millis: number, timeZone: string): string {
	const offsetMillis = getZoneOffsetMillis(timeZone, millis);
	const wall = new Date(millis + offsetMillis);
	return `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

// offset 付き ISO8601 かどうかを先に正規表現で検証する。"Z" または "±HH:MM"(コロン任意) を
// 末尾に要求することで、floating(offset 無し。例 "2026-07-11T10:00:00")を Date.parse に
// 渡す前に確実に弾く。Date.parse は環境依存の挙動(V8 は offset 無しをローカル TZ 扱いする
// 実装があり、instant.ts が禁じる「ランタイムのローカル TZ 依存」を暗黙に踏んでしまう)
// があるため、そもそも floating を Date.parse に渡さないことが重要(落とし穴回避)。
const OFFSET_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * offset 付き ISO8601 文字列 → UTC エポックミリ秒。
 *
 * floating(offset 無し)は throw する(呼び出し側 = MCP ツールハンドラが catch して
 * isError 応答に変換する契約。SUDO モデリングの「入力の曖昧さをサーバーの暗黙解釈で
 * 埋めない」方針。calDateTimeToEpochMillis の floating 既定 UTC とは異なる文脈 —
 * こちらは MCP ツールの「入力」なので、暗黙補完せずクライアントに明示させる)。
 */
export function parseIsoToEpoch(s: string): number {
	if (!OFFSET_ISO_PATTERN.test(s)) {
		throw new RangeError(`parseIsoToEpoch: offset (Z or ±HH:MM) required, got floating or malformed timestamp: "${s}"`);
	}
	const millis = Date.parse(s);
	if (Number.isNaN(millis)) {
		throw new RangeError(`parseIsoToEpoch: unparsable timestamp: "${s}"`);
	}
	return millis;
}
