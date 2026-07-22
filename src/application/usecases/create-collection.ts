// =============================================================================
// CreateCollection ユースケース — RFC 4791 §5.3.1 MKCALENDAR
// =============================================================================
//
// カレンダーコレクションを新規作成する。
//
// 【iOS での呼ばれ方】
// iOS/macOS はアカウント追加時に MKCALENDAR を送るとは限らない(前作観測: iOS は
// 既存コレクションを PROPFIND で発見するだけで、自分からは MKCALENDAR を送らないことが多い)。
// しかし CalDAV クライアントライブラリ(tsdav 等)や MCP ツールから呼ばれうるため、
// このユースケースは実装しておく(CLAUDE.md 長期ビジョン: 複数入口から呼べる)。
//
// 【MKCALENDAR の workerd での問題】
// docs/modeling/06-ios-behavior-verification.md C1: workerd は MKCALENDAR の HTTP メソッドを
// 501 で弾く。presentation 層で MKCALENDAR を MKCOL の拡張として受ける、または
// 開発環境でプロキシが書き換える必要がある。このユースケース自体は HTTP 非依存なので無関係。
//
// 【冪等性】
// 同じ ID のコレクションが既存の場合は CollectionAlreadyExistsError を throw する。
// (CalDAV の MKCALENDAR は「新規作成」専用で、既存への上書きは 405 Method Not Allowed)
//
// 【K1: displayName 重複ガード(2026-07-23 追記、同日レビューで opt-in 化)】
// 上記の id 一致チェックだけでは防げない実害が本番で発覚した: MCP の create-calendar は id
// 省略時に displayName から slug を作るが、非 ASCII(日本語等)displayName は slugify で情報が
// 潰れて degenerate 判定になり crypto.randomUUID() にフォールバックする(server.ts
// slugifyForCollectionId 参照)。つまり「同じ日本語 displayName で create-calendar を2回呼ぶ」
// と、id は毎回別の UUID になるため id 一致チェックをすり抜け、同名コレクションが際限なく
// 複製されるバグがあった。id だけでなく displayName の重複も UC 層でガードすることで、
// slug 生成側の改善(このコミットでは安定 slug 化も同時に実施)と二重に防御する。
//
// 【なぜ「常時ガード」ではなく execute() の opt-in フラグ(rejectDuplicateDisplayName)にしたか】
// 最初の実装は無条件でガードしていたが、レビューで「iOS/iCloud は同名リマインダーリスト・
// カレンダーを正当に許す(displayname の一意性は DAV/CalDAV 仕様上も要求されていない)」と
// 指摘を受けて修正した。CreateCollection は DAV(MKCALENDAR)と MCP(create-calendar)の両方が
// 共有する UC であり、ここで無条件に拒否すると iOS の正当な MKCALENDAR 操作まで壊してしまう
// (しかも presentation 層に MKCALENDAR 用の 409 マッピングがまだ無いため、拒否時に 500 化する
// 恐れすらあった)。
//   - 責務分界: DAV クライアント(iOS/macOS 等)は自分のコレクション群を GUI 上で意図的に
//     管理しており、「同名で複数作る」ことがユーザーの明示的な選択でありうる。一方 MCP の
//     create-calendar はエージェント(LLM)が呼ぶツールであり、「同じ displayName で2回叩く」は
//     たいていエージェントの誤爆(前回の呼び出し結果を見失って再実行する等)であって、ユーザーの
//     意図した重複ではない。同じ UC でも呼び出し元によってこの区別が意味を持つため、呼び出し元
//     (presentation 層)が「自分はエージェント入口である」と申告するフラグにした。
//   - Why not(UC 無条件ガード案): 「DAV も含めて全経路で同名拒否」にすれば実装は単純だが、
//     iOS の正当な操作を壊すリスクの方が「エージェントの誤爆」より実害が大きいと判断し却下。
//   - Why not(逆に DAV 側だけ明示的に「重複許可」フラグを渡す案): 既定値を「ガードする」にすると
//     DAV 経路(将来 presentation/dav 層で MKCALENDAR ハンドラを実装するとき)側で明示的に
//     オプトアウトし忘れるリスクがあり、iOS の正当操作を壊す方向に倒れやすい。デフォルトは
//     「ガードしない」= DAV 経路は無改修のまま安全(fail-safe)にし、MCP ハンドラ側だけが
//     明示的に true を渡す設計の方が事故りにくいと判断した。
// 【比較の正規化: NFC + trim + 大文字小文字】
// - NFC 正規化: 日本語含む Unicode 文字列は合成済み(NFC)/分解済み(NFD)の2表現がありえ、
//   見た目同じ displayName でもバイト列が違うと文字列比較で別物扱いになってしまう
//   (例: macOS のファイルシステムは NFD を好む傾向があり、クライアント側の入力経路によっては
//   NFD で届く可能性がゼロではない)。normalize("NFC") で表現を揃えてから比較する。
// - trim: 前後の空白だけが違う displayName(コピペ事故等)を別名として通してしまうと、この
//   ガードの目的(同名の意図しない複製を防ぐ)を果たせないため除去する。
// - toLowerCase: CalDAV クライアント/MCP どちらから見ても "Work" と "work" は人間には
//   同じ意図に見えることが多く、大文字小文字だけの違いで複製を許すと結局同じ実害が起きうる。
//   ASCII 前提の単純な toLowerCase() だが、displayName の大文字小文字ゆれは主に英数字圏の
//   入力揺れを想定しており、非 ASCII 文字は toLowerCase() の対象外でもそのまま比較に使われる
//   ので実害は無い。
// 【全件走査(findAllByOwner)を使う判断】
// displayName 用の専用インデックス/検索メソッドを ports に足す案もあったが、1ユーザーあたりの
// コレクション数は数十件規模(iOS のカレンダー/リマインダーリスト相当)であり、MKCALENDAR/
// create-calendar は頻繁に叩かれる操作でもないため、全件走査で十分と判断した(YAGNI)。
// 将来コレクション数が増えて問題になったら、findByOwnerAndDisplayName のような専用メソッドを
// ports に追加する。
// =============================================================================

import {
	CalendarCollection,
	collectionId as mkCollectionId,
	principalPath,
	type AppleColor,
} from "../../domain/caldav";
import type {
	CollectionId,
	ComponentKind,
	PrincipalRef,
	CalendarCollectionInit,
} from "../../domain/caldav";
import type { CalendarCollectionRepository } from "../ports";

// --- 入力 DTO ---

export interface CreateCollectionInput {
	owner: PrincipalRef;
	/** コレクション ID(URL パスセグメント)。例 "work" / "personal"。 */
	collectionId: string;
	/** 表示名(displayName プロパティ)。 */
	displayName: string;
	/**
	 * 受け入れるコンポーネント種別(supported-calendar-component-set)。
	 * 未指定 = 全種別受理(RFC 4791 §5.2.3)。
	 */
	supportedComponents?: readonly ComponentKind[];
	/** Apple 独自: カレンダーの色(calendar-color)。 */
	color?: AppleColor;
	/** Apple 独自: カレンダーの表示順(calendar-order)。 */
	order?: number;
	/**
	 * K1: true の場合のみ、同じ owner に同じ displayName(正規化して比較)のコレクションが
	 * 既存なら CollectionDisplayNameConflictError で拒否する。既定 false(= 従来どおり
	 * displayName の重複を許す)。
	 * 【なぜ既定 false か】DAV(MKCALENDAR)経路の挙動を変えないため(iOS/iCloud は同名の
	 * リマインダーリスト・カレンダーを正当に許す。上の【K1】コメントの Why not 参照)。
	 * MCP の create-calendar ハンドラ(server.ts)だけがエージェントの誤爆防止として true を渡す。
	 */
	rejectDuplicateDisplayName?: boolean;
}

// --- 出力 DTO ---

export interface CreateCollectionOutput {
	/** 作成されたコレクション。 */
	collection: CalendarCollection;
}

// --- エラー型 ---

/**
 * 既に同じ ID のコレクションが存在するエラー。
 * - HTTP: 405 Method Not Allowed (RFC 4791: MKCALENDAR は既存コレクションに対して 405)
 *   または 409 Conflict。presentation 層がマッピングを決める。
 */
export class CollectionAlreadyExistsError extends Error {
	readonly kind = "CollectionAlreadyExistsError" as const;
	constructor(readonly collectionId: CollectionId) {
		super(`Calendar collection already exists: ${collectionId}`);
		this.name = "CollectionAlreadyExistsError";
	}
}

/**
 * K1: 同じ owner に同じ displayName(NFC 正規化 + trim + 大文字小文字を無視して比較)の
 * コレクションが既に存在するエラー。
 * - id は別でも displayName が同じなら意図しない複製とみなして拒否する(上の【K1】コメント参照)。
 * - 既存コレクションの id/displayName を保持しておく: presentation 層(MCP ハンドラ等)が
 *   「これを使えばいいのでは」とモデルに提案できるようにするため(単に拒否するだけだと
 *   モデルが同じ入力でリトライを繰り返しかねない)。
 * - HTTP マッピング: MKCALENDAR 経由で displayName 重複が起きた場合も CollectionAlreadyExistsError
 *   と同様に 409 Conflict 相当として扱ってよい(presentation 層の判断に委ねる。ここでは決めない)。
 */
export class CollectionDisplayNameConflictError extends Error {
	readonly kind = "CollectionDisplayNameConflictError" as const;
	constructor(
		readonly existingCollectionId: CollectionId,
		readonly existingDisplayName: string,
	) {
		super(
			`Calendar collection with the same display name already exists: ` +
				`id=${existingCollectionId}, displayName=${existingDisplayName}`,
		);
		this.name = "CollectionDisplayNameConflictError";
	}
}

/**
 * displayName 比較用の正規化。上の【K1】コメントの理由により NFC 正規化 + trim + lowercase。
 * export するのはテスト(create-collection.test.ts)から直接境界値を検証したいため
 * (slugifyForCollectionId を server.test.ts から export しているのと同じ流儀)。
 */
export function normalizeDisplayNameForComparison(displayName: string): string {
	return displayName.normalize("NFC").trim().toLowerCase();
}

// --- ユースケース ---

export class CreateCollection {
	constructor(private readonly collectionRepo: CalendarCollectionRepository) {}

	async execute(input: CreateCollectionInput): Promise<CreateCollectionOutput> {
		// 識別子 VO 化(不正な ID 文字列は InvalidIdentifierError を throw)。
		const id = mkCollectionId(input.collectionId);

		// 既存チェック(id 一致)。
		const existing = await this.collectionRepo.findById(input.owner, id);
		if (existing) {
			throw new CollectionAlreadyExistsError(id);
		}

		// K1: displayName 重複チェック(id は別でも同名なら拒否)。opt-in(呼び出し元が
		// rejectDuplicateDisplayName:true を渡したときだけ)。既定 false の理由は上の
		// CreateCollectionInput.rejectDuplicateDisplayName のコメント参照(DAV 経路の
		// 挙動を変えない fail-safe デフォルト)。
		if (input.rejectDuplicateDisplayName) {
			// findAllByOwner で owner 配下の全コレクションを取り、正規化した displayName を比較する
			// (全件走査の是非は上の【K1】コメント参照)。
			const normalizedInputName = normalizeDisplayNameForComparison(input.displayName);
			const siblings = await this.collectionRepo.findAllByOwner(input.owner);
			const duplicate = siblings.find(
				(c) => normalizeDisplayNameForComparison(c.displayName) === normalizedInputName,
			);
			if (duplicate) {
				throw new CollectionDisplayNameConflictError(duplicate.id, duplicate.displayName);
			}
		}

		// CalendarCollection を構築して保存する。
		const init: CalendarCollectionInit = {
			id,
			owner: input.owner,
			displayName: input.displayName,
			supportedComponents: input.supportedComponents,
			color: input.color,
			order: input.order,
		};
		const collection = new CalendarCollection(init);
		await this.collectionRepo.save(collection);

		return { collection };
	}
}
