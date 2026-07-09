// =============================================================================
// Principal — RFC 5397 / RFC 4791 §6.2 プリンシパル(集約ルート)
// =============================================================================
//
// 「認証済みユーザーの DAV 上の表現」。認証コンテキスト(方式未定・03 §4)が資格情報から
// 解決した1ユーザーと 1:1 対応する。DAV 的にはほぼデータだけの集約:
//   - principalPath: URL 上の同一性(current-user-principal がこれを指す)
//   - calendarHomeSet: このユーザーのカレンダー群の起点 URL(calendar-home-set。iOS が
//     ここを PROPFIND してコレクション一覧を得る)
//
// 【CalendarCollection との関係は ID 参照】
// Principal は自分の配下コレクションを抱え込まない(CalendarCollection.owner が principalPath を
// ID 参照する向き。03 §2 の集約分離)。よってここに collections: [] のような配列は持たせない。
//
// 【認証方式に依存させない】
// パスワードや OAuth トークン等の資格情報はここに持たない(03 §4: ドメインは PrincipalResolver
// 越しにしか認証に触れない)。この集約が持つのは「解決後のユーザーの DAV 上の姿」だけ。
// =============================================================================

import { principalPath } from "./values";
import type { PrincipalPath } from "./values";

export class Principal {
	private constructor(
		/** URL 上の同一性(例 "/principals/users/alice/")。集約の同一性そのもの。 */
		readonly principalPath: PrincipalPath,
		/** calendar-home-set の URL(このユーザーのコレクション群の起点)。 */
		readonly calendarHomeSet: string,
	) {}

	/**
	 * プリンシパルを生成する。principalPath は文字列でも受け取れるようにし、
	 * その場で識別子 VO へ通す(空・不正パスを弾く)。既に PrincipalPath VO を持っているなら
	 * それをそのまま渡してもよい(principalPath() は冪等な検証)。
	 */
	static create(path: string | PrincipalPath, calendarHomeSet: string): Principal {
		// path が VO(branded string)でも生 string でも、principalPath() に通せば検証済み VO になる。
		const p = principalPath(path);
		if (calendarHomeSet.length === 0) {
			throw new Error("Principal.create: calendarHomeSet must not be empty");
		}
		return new Principal(p, calendarHomeSet);
	}

	/** 同一性は principalPath(URL 上の同一性)で判定する。 */
	equals(other: Principal): boolean {
		return this.principalPath === other.principalPath;
	}
}
