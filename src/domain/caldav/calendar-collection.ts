// =============================================================================
// CalendarCollection — RFC 4791 §4.2 カレンダーコレクション(集約ルート)
// =============================================================================
//
// 「カレンダー(オブジェクトを入れる器)」。iOS の1カレンダー / 1リマインダーリストに対応。
// メンバー(CalendarObjectResource)は **ID 参照** で持ち、集約内に抱え込まない
// (数千件で集約が肥大する。03 §2 の設計決定)。代わりに保持するのは:
//   - コレクションのメタデータ(displayName / supportedComponents / color / order)
//   - 同期状態(syncCounter)と変更ログ(SyncChange[])
// これらから SyncToken(RFC 6578)と CTag(getctag)を導出する。
//
// 【可変(mutable)にした判断】
// recordChange は「カウンタを +1 して変更ログに1件追加する」状態遷移。これをイミュータブルに
// (毎回コレクション全体 + 全ログをコピーした新インスタンスで)返すと、1リクエストで複数の
// PUT/DELETE を捌くとき変更ログの配列を都度コピーし続けることになり無駄が大きい。
// Workers は1リクエスト=単一スレッドで共有状態の競合が無く、集約はエンティティ(同一性を持ち
// 状態が変わるもの)なので、ここは素直に可変にする。structure/semantics 層(値・レンズ)を
// イミュータブルにしたのとは、扱う対象(値 vs 状態を持つエンティティ)が違うので方針を分ける。
// =============================================================================

import { AppleColor, CTag, SyncToken } from "./values";
import type { CollectionId, ComponentKind, PrincipalRef, ResourceUri } from "./values";

/** メンバーに起きた変化の種別。RFC 6578 の変更ログの各エントリが持つ。 */
export type ChangeKind = "created" | "modified" | "deleted";

/**
 * SyncChange — CalendarCollection 集約内のエンティティ(RFC 6578)。
 * 「どのメンバー(uri)が、どう変わり(kind)、どの時点(token)で」を記録する変更ログの1行。
 * token はその変更を記録した瞬間のカウンタ(= recordChange 後の新しい値)。
 * changesSince が「クライアントのトークン以降」を絞り込む基準になる。
 */
export class SyncChange {
	constructor(
		readonly uri: ResourceUri,
		readonly kind: ChangeKind,
		readonly token: SyncToken,
	) {}
}

/**
 * changesSince の1件。sync-collection REPORT 応答へ写す前の中間表現。
 * - "changed": 現在も存在し、追加 or 更新された(応答では 200 + etag。created/modified の区別は
 *   RFC 上クライアントに不要なので畳んで "changed" にする)。
 * - "removed": 削除された(応答では 404。§3.2 Marshalling: 削除は 404、前作の 410 は誤り)。
 */
export type SyncReport = { uri: ResourceUri; change: "changed" | "removed" };

/**
 * changesSince の結果。
 * - valid: トークンを解釈でき差分を計算できた。changes と、応答に載せる newToken を返す。
 * - invalid: クライアントのトークンが本コレクションの現在値より未来を指す等、差分計算不能。
 *   → application 層は valid-sync-token precondition 失敗(full resync 要求)へ写す。
 */
export type ChangesSinceResult =
	| { valid: true; changes: SyncReport[]; newToken: SyncToken }
	| { valid: false };

/** CalendarCollection のコンストラクタ入力(名前付き引数で可読性を上げる)。 */
export interface CalendarCollectionInit {
	id: CollectionId;
	/** 所有プリンシパルへの ID 参照(集約横断は ID で。03 §2)。 */
	owner: PrincipalRef;
	displayName: string;
	/**
	 * 受け入れるコンポーネント種別。undefined = supported-calendar-component-set プロパティ不在
	 * = 全種別受理 MUST(R2/§5.2.3)。空配列ではなく undefined で「不在」を表す
	 * (空配列は「何も受け入れない」の意になり全受理と正反対なので、区別する)。
	 */
	supportedComponents?: readonly ComponentKind[];
	color?: AppleColor;
	order?: number;
	/** 復元時の同期カウンタ。新規作成なら省略(= 初期値 0)。 */
	syncCounter?: SyncToken;
	/** 復元時の変更ログ。新規作成なら省略(= 空)。DB から読み戻すとき渡す。 */
	changeLog?: readonly SyncChange[];
}

export class CalendarCollection {
	readonly id: CollectionId;
	readonly owner: PrincipalRef;
	// 以下メタデータは PROPPATCH で変わりうるが、本タスクのスコープ(sync)では読み取りだけ使う。
	// 変更 API(rename 等)は PROPPATCH ユースケース実装時に追加する。今は生成時に確定。
	readonly displayName: string;
	readonly supportedComponents?: readonly ComponentKind[];
	readonly color?: AppleColor;
	readonly order?: number;

	// 同期状態。recordChange で進むので可変(冒頭コメントの判断)。
	private _syncCounter: SyncToken;
	// 変更ログ本体(可変)。外部へは readonly ビュー(changes ゲッター)で見せる。
	private readonly _changeLog: SyncChange[];

	constructor(init: CalendarCollectionInit) {
		this.id = init.id;
		this.owner = init.owner;
		this.displayName = init.displayName;
		this.supportedComponents = init.supportedComponents;
		this.color = init.color;
		this.order = init.order;
		this._syncCounter = init.syncCounter ?? SyncToken.initial();
		this._changeLog = init.changeLog !== undefined ? [...init.changeLog] : [];
	}

	// ---------------------------------------------------------------------------
	// 導出値(SyncToken / CTag / 変更ログビュー)
	// ---------------------------------------------------------------------------

	/** 現在の同期トークン(内部カウンタ)。公開時は toUri(base) で URI 化する。 */
	get syncToken(): SyncToken {
		return this._syncCounter;
	}

	/** 現在の CTag(getctag)。sync カウンタから導出(ctag.ts の判断)。 */
	get ctag(): CTag {
		return CTag.fromSyncToken(this._syncCounter);
	}

	/** 変更ログの読み取り専用ビュー。 */
	get changes(): readonly SyncChange[] {
		return this._changeLog;
	}

	/**
	 * このコレクションが指定種別を受け入れるか(R2)。
	 * supportedComponents が undefined(プロパティ不在)なら全受理 MUST → 常に true。
	 */
	accepts(kind: ComponentKind): boolean {
		return this.supportedComponents === undefined || this.supportedComponents.includes(kind);
	}

	/**
	 * PROPPATCH で変更可能な表示メタデータを差し替えた新しい集約を返す。
	 *
	 * メンバー変更ではないため sync-token / changeLog は進めない。Apple のカレンダー色や
	 * 表示順を変更しただけで calendar-object の同期差分を捏造しないためである。一方、D1 へ
	 * 復元可能な完全な集約として返し、application 層が readonly フィールドを破壊的に変更せずに
	 * 保存できるようにする。
	 */
	withMetadata(input: {
		displayName?: string;
		color?: AppleColor;
		order?: number;
	}): CalendarCollection {
		return new CalendarCollection({
			id: this.id,
			owner: this.owner,
			displayName: input.displayName ?? this.displayName,
			supportedComponents: this.supportedComponents,
			color: input.color ?? this.color,
			order: input.order ?? this.order,
			syncCounter: this._syncCounter,
			changeLog: this._changeLog,
		});
	}

	// ---------------------------------------------------------------------------
	// 状態遷移: メンバー変更の記録
	// ---------------------------------------------------------------------------
	/**
	 * メンバー(uri)に変化(created/modified/deleted)が起きたことを記録する。
	 * カウンタを1歩進め(= 新しい SyncToken)、その値をタグ付けした SyncChange をログ末尾に積む。
	 * これにより syncToken も ctag も自動で進む(二重管理しない。ctag.ts の判断)。
	 *
	 * ※application 層が「CalendarObjectResource の PUT/DELETE」と同一トランザクションで呼ぶ
	 *   (集約横断の整合性。03 §2)。ここでは「起きた事実」を記録するだけで、実際の永続化順序や
	 *   トランザクション境界は application/infrastructure の責務。
	 */
	recordChange(uri: ResourceUri, kind: ChangeKind): void {
		this._syncCounter = this._syncCounter.next();
		this._changeLog.push(new SyncChange(uri, kind, this._syncCounter));
	}

	// ---------------------------------------------------------------------------
	// sync-collection: クライアントのトークン以降の差分を導出(RFC 6578)
	// ---------------------------------------------------------------------------
	/**
	 * since(クライアントが前回受け取ったトークン)以降の変更を、応答用の SyncReport[] に畳んで返す。
	 * since が undefined = 初回同期(空の DAV:sync-token。§3.4)。
	 *
	 * 【§3.5 の細則をここに実装する】
	 *   - 同期間隔内に「追加→削除」されたメンバーは removed として報告 MUST。
	 *     → uri ごとに「最後の変更」を採用する(下記 fold)。最後が deleted なら removed。
	 *   - created→modified のように複数回変わっても、クライアントに必要なのは最終状態だけなので
	 *     1件("changed")に畳む。
	 *
	 * 【初回同期(since=undefined)での removed の扱い】
	 *   初回はクライアントが1件も知らない状態。過去に作られてから削除されたメンバーを removed で
	 *   報告しても、クライアントは元々持っていないので無意味(むしろ 404 のノイズ)。よって初回だけは
	 *   net-removed を報告しない(= 現存メンバーだけを changed として返す)。§3.4 の「現在のメンバーを
	 *   返す」に沿う。increment 同期(since 有り)では §3.5 どおり removed を報告する。
	 *
	 * 【invalid トークンの区別】
	 *   since.counter が現在のカウンタより大きい(未来を指す)なら、このコレクションでは説明できない
	 *   トークン(他サーバー由来 / 破損 / DB ロールバック後)なので { valid:false } を返す。
	 *   (SyncToken 形式そのものが壊れているケースは、そもそも SyncToken.fromUri が invalid を返して
	 *    ここまで来ない。ここで見るのは「形式は正しいがカウンタが範囲外」のケース。)
	 */
	changesSince(since: SyncToken | undefined): ChangesSinceResult {
		const base = since?.counter;

		// invalid: 未来のトークン。差分の起点にできない。
		if (base !== undefined && base > this._syncCounter.counter) {
			return { valid: false };
		}

		// base より後(初回は全件)の変更を、uri ごとに「最後の1件」へ畳む。
		// _changeLog は recordChange の append 順 = カウンタ昇順なので、後勝ちで Map に入れれば
		// 各 uri の最終変更が残る(Map は同一キー再 set で値は更新・挿入位置は最初のまま)。
		const lastByUri = new Map<string, SyncChange>();
		for (const ch of this._changeLog) {
			if (base !== undefined && ch.token.counter <= base) continue;
			lastByUri.set(ch.uri, ch);
		}

		const changes: SyncReport[] = [];
		for (const ch of lastByUri.values()) {
			if (ch.kind === "deleted") {
				// 初回同期では removed を出さない(上記コメント)。
				if (base === undefined) continue;
				changes.push({ uri: ch.uri, change: "removed" });
			} else {
				// created / modified はどちらも「現存し変わった」= changed に畳む。
				changes.push({ uri: ch.uri, change: "changed" });
			}
		}

		return { valid: true, changes, newToken: this._syncCounter };
	}
}
