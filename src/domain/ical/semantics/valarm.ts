// =============================================================================
// VAlarm — RFC 5545 §3.6.6 VALARM コンポーネントのレンズ
// =============================================================================
//
// VALARM は VEVENT / VTODO のサブコンポーネント(通知・アラーム)。iOS はアラームを
// ローカルで鳴らすが、往復保持は必要(サーバーは中身を保存して返すだけ)。
// よってこのレンズも「読み取り + validate」だけで、独自構造には変換しない(§1-1)。
//
// 【VALARM の必須プロパティ規則(05-rfc-verification.md の細則より)】
//   - ACTION と TRIGGER は常に必須。
//   - ACTION=DISPLAY      → DESCRIPTION 必須。
//   - ACTION=EMAIL        → DESCRIPTION + SUMMARY + ATTENDEE 必須。
//   - ACTION=AUDIO        → 追加必須なし(ATTACH は任意)。
//   - DURATION と REPEAT は「片方があれば両方」必須(繰り返し通知の間隔と回数はセット)。
// これらは 03 の I1〜I10 表に番号が無い細則なので、InvariantViolation の invariant は
// "VALARM" タグにする(errors.ts の InvariantId 参照)。
// =============================================================================

import type { Component } from "../structure/types";
import { InvariantViolation } from "./errors";
import { firstProp } from "./helpers";

export class VAlarm {
	// レンズは内部 Component を包むだけ。private にして「Component へ勝手に触らせない」。
	private constructor(private readonly component: Component) {}

	/**
	 * VALARM コンポーネントからレンズを作る。名前が VALARM 以外はプログラミングエラー
	 * (呼び出し側が subComponents("VALARM") で絞ってから渡す契約)なので throw する。
	 */
	static fromComponent(c: Component): VAlarm {
		if (c.name !== "VALARM") {
			throw new Error(`VAlarm.fromComponent: expected VALARM component, got ${c.name}`);
		}
		return new VAlarm(c);
	}

	/** 内部 Component への読み取り専用アクセス(上位レンズがまれに生プロパティを見たいとき用)。 */
	get raw(): Component {
		return this.component;
	}

	/** ACTION の値(列挙値なので大文字化して返す。§3.1: 列挙値は case-insensitive)。 */
	get action(): string | undefined {
		return firstProp(this.component, "ACTION")?.value.toUpperCase();
	}

	// ---------------------------------------------------------------------------
	// validate: VALARM の必須プロパティ規則(上のコメント参照)
	// ---------------------------------------------------------------------------
	// 書き込みアクセサを持たないのと同様、ここも「読み取り + 診断」のみ。将来 PUT
	// ユースケースで VALARM を組み立てるようになったら書き込み側を足す(errors.ts の方針)。
	validate(): InvariantViolation[] {
		const violations: InvariantViolation[] = [];
		const v = (message: string): void => {
			violations.push(new InvariantViolation("VALARM", "VALARM", message));
		};

		const action = this.action;
		const hasTrigger = firstProp(this.component, "TRIGGER") !== undefined;

		// ACTION+TRIGGER は無条件必須。
		if (action === undefined) v("ACTION is required (RFC 5545 §3.6.6)");
		if (!hasTrigger) v("TRIGGER is required (RFC 5545 §3.6.6)");

		const has = (name: string): boolean => firstProp(this.component, name) !== undefined;

		// ACTION 別の追加必須。ACTION が無ければ上で報告済みなので、ここは値がある時だけ精査。
		if (action === "DISPLAY") {
			if (!has("DESCRIPTION")) v("ACTION=DISPLAY requires DESCRIPTION (§3.6.6)");
		} else if (action === "EMAIL") {
			if (!has("DESCRIPTION")) v("ACTION=EMAIL requires DESCRIPTION (§3.6.6)");
			if (!has("SUMMARY")) v("ACTION=EMAIL requires SUMMARY (§3.6.6)");
			if (!has("ATTENDEE")) v("ACTION=EMAIL requires ATTENDEE (§3.6.6)");
		}
		// ACTION=AUDIO や未知の X- ACTION には追加必須を課さない(RFC は AUDIO に必須追加なし)。

		// DURATION / REPEAT は「片方があれば両方」MUST(05 細則)。XOR なら違反。
		const hasDuration = has("DURATION");
		const hasRepeat = has("REPEAT");
		if (hasDuration !== hasRepeat) {
			v("DURATION and REPEAT must be present together (only one found) (§3.6.6)");
		}

		return violations;
	}
}
