// =============================================================================
// values/ 層 共通エラー(RFC 5545 §3.3 の値型コーデックが投げる唯一の例外型)
// =============================================================================
//
// 【なぜ専用エラークラスを1つだけ用意するか】
// values/ 層の各コーデック(CalDateTime / DurationValue / RecurrenceRule …)は
// 「生の値文字列 → 型付き値」への変換で不変条件違反を検出したら throw する。
// 呼び出し側(将来の parse/ 層)は「どの値型の・どの入力で・なぜ失敗したか」を
// まとめて拾いたい。個別に Error を投げ分けると catch 側が型を絞れないため、
// 値型コーデック共通の一種類に統一する(値型名は valueType フィールドで区別)。
//
// 【設計判断: TypeError などの組み込み例外は使わない】
// 組み込み例外だと「ライブラリ内部のバグ由来のエラー」と「不正な入力データ由来の
// エラー」が区別できない。CalDAV では後者はクライアントへ 4xx を返すべきもので、
// 前者は 500。InvalidValueError かどうかで両者を判別できるようにしておく。
// =============================================================================

/**
 * RFC 5545 §3.3 の値型パースに失敗したことを表す例外。
 *
 * - valueType: 失敗した値型の名前(例 "DATE-TIME", "DURATION", "RECUR")。
 *   RFC の VALUE 名に寄せておくと、将来 presentation 層で precondition
 *   `valid-calendar-data` に紐付けやすい。
 * - input: 失敗した生の入力文字列(そのまま。デバッグとログのため)。
 * - reason: 人間可読の失敗理由。
 */
export class InvalidValueError extends Error {
	readonly valueType: string;
	readonly input: string;
	readonly reason: string;

	constructor(valueType: string, input: string, reason: string) {
		// メッセージには3要素すべてを埋め込む。テスト・ログでこの1行を見れば
		// 原因が特定できるようにしておく(担当タスクの要件: 「どの値型・どの入力で
		// 失敗したかをメッセージに」)。
		super(`Invalid ${valueType} value: ${reason} (input: ${JSON.stringify(input)})`);
		this.name = "InvalidValueError";
		this.valueType = valueType;
		this.input = input;
		this.reason = reason;

		// TypeScript(target ESNext)+ Error 継承の定番。instanceof を効かせるため
		// プロトタイプチェーンを明示的に張り直す。target を下げたときの保険でもある。
		Object.setPrototypeOf(this, InvalidValueError.prototype);
	}
}
