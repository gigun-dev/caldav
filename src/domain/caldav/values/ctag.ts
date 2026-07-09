// =============================================================================
// CTag — CalendarServer 拡張 getctag(値オブジェクト・非 RFC)
// =============================================================================
//
// 【CTag とは】RFC には無い CalendarServer 由来の慣行プロパティ
// `{http://calendarserver.org/ns/}getctag`。「コレクション全体が最後に変わってから
// 変わっていないか」を1つの不透明トークンで表す。iOS/macOS は sync-collection REPORT を
// 打つ前にまず PROPFIND で getctag を見て、前回と同じなら「変化なし」と判断して
// REPORT を省略する(帯域節約)。iOS 対応上ほぼ必須(05 の「iOS がコレクションに
// PROPFIND してくるプロパティ」一覧に getctag が含まれる)。
//
// 【なぜ sync カウンタから導出してよいのか — 設計判断】
// CTag に求められる性質は「コレクション内の何か(メンバーの追加/更新/削除)が変われば
// 必ず変わる」の1点だけ(値の形式・単調性は問われない・クライアントには不透明)。
// SyncToken の内部カウンタ(recordChange のたびに +1)はまさにこの性質を満たすので、
// CTag を独立管理せず sync カウンタから機械的に導出する。二重管理して「sync は進んだが
// ctag は据え置き」のようなズレを生む余地を無くすのが狙い。
// ※ただし CTag と SyncToken は「別のプロパティ・別の URI 名前空間」なので、公開値までは
//   共有しない(値を取り違えるとクライアントが混乱する)。ここでは "ctag:{n}" と接頭辞を付け、
//   sync-token の URI とは字面が絶対に一致しないようにしておく。
// =============================================================================

import { SyncToken } from "./sync-token";

export class CTag {
	// value はクライアントに不透明な文字列。形式はサーバーの自由。
	private constructor(readonly value: string) {}

	/**
	 * sync カウンタから CTag を導出する。カウンタが進めば value も必ず変わる。
	 * 接頭辞 "ctag:" は sync-token URI(`.../ns/sync/{n}`)と字面衝突しないための区別
	 * (両者は別プロパティなので、万一同じ経路で扱われても混ざらないようにする保険)。
	 */
	static fromSyncToken(token: SyncToken): CTag {
		return new CTag(`ctag:${token.counter}`);
	}

	/** 既知の値(DB から読み戻し等)から復元。 */
	static of(value: string): CTag {
		if (value.length === 0) {
			throw new Error("CTag.of: value must not be empty");
		}
		return new CTag(value);
	}

	equals(other: CTag): boolean {
		return this.value === other.value;
	}

	toString(): string {
		return this.value;
	}
}
