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
// 【2026-07-23 K1 → 撤回の経緯(displayName 重複ガードは Why not として記録)】
// K1(同日午前): MCP の create-calendar は id 省略時に displayName から slug を作るが、
// 非 ASCII(日本語等)displayName は slugify で情報が潰れて degenerate 判定になり
// crypto.randomUUID() にフォールバックしていた(旧 server.ts slugifyForCollectionId)。
// このため「同じ日本語 displayName で create-calendar を2回呼ぶ」と id が毎回別の UUID になり
// id 一致チェックをすり抜けて同名コレクションが複製される実害(「テストコレクション」が2件・
// 両方ランダム UUID・空)が本番で起きた。K1 はこれを displayName の重複を UC 層で検出して拒否
// する CollectionDisplayNameConflictError(rejectDuplicateDisplayName opt-in フラグ)で対処した。
//
// 【K1 拒否 → 冪等返却への修正(同日中盤)、さらにユーザー裁定で全面撤回(同日終盤)】
// 拒否は「2回目がエラーになる」ため冪等でないと指摘され、いったん「既存を成功として返す」方式
// に直したが、レビューで根本的な問題定義の誤りが指摘された: 実害の原因は「同じ displayName で
// 意図的に2つ作った」ことではなく「1回の依頼がランダム UUID のせいで再送のたびに別コレクションに
// なった」こと(トランスポート/エージェント側のリトライ)。「同じ名前のリストをもう1つ意図的に
// 作る」は iOS/iCloud 同様 MCP でも正当な操作であり、displayName の一意性を UC 層で強制する
// (拒否であれ黙って既存に化けさせるのであれ)こと自体が誤った治療だったと判断し、この UC からは
// displayName 重複検出の仕組み一式(CollectionDisplayNameConflictError・
// rejectDuplicateDisplayName フラグ・findAllByOwner 全件走査)を完全に撤去した。
//   - Why not(displayName 正規化一致で問答無用に統合する案・K1〜中盤で採っていた): 「同じ名前の
//     リストをもう1つ作りたい」という正当な意図を、id が別々でも displayName だけを見て
//     問答無用に「既存への統合(拒否 or 既存返却)」にすり替えてしまう。iOS が同名の複数リストを
//     許容している以上、MCP だけがこれを禁止/矯正する理由は無い。
//   - Why not(displayName の重複を「よくある誤爆」とみなして MCP 入口だけ矯正する案): 「エージェント
//     はリトライしがちだから displayName で名寄せする」という当初の推論は、実害の実際の原因
//     (id 側がランダムだったことによる再送時の別 id 化)を取り違えていた。原因が id 側にあるなら
//     治療も id 側(下記の「安定 id への収束」)で行うべきで、displayName 側を触る必要は無かった。
// 【残す判断: 冪等性は「安定 id への収束」で実現する(id 側の治療)】
// id 省略時の自動生成 id を「同じ displayName なら同じ id 候補になる」よう安定化させておけば
// (slugifyForCollectionId のハッシュ fallback。server.ts 参照)、同一リクエストの再送は自然に
// 同じ id にぶつかり、CollectionAlreadyExistsError の通常の重複検出(この UC がもともと持っていた
// id 一致チェック)で捕捉できる。「id は同じで displayName も一致」を「同一リクエストの再送」、
// 「id は同じだが displayName が違う」を「slug/hash 衝突」として区別する判断は presentation 層
// (server.ts create-calendar ハンドラ)に置く(この UC はこれまでどおり id 一致で無条件に
// CollectionAlreadyExistsError を投げるだけで、判断ロジックを持たせない — DAV 経路にも影響を
// 与えないための最小責務)。
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
 * displayName 比較用の正規化(NFC 正規化 + trim + lowercase)。
 * 【2026-07-23: UC 層の displayName 重複検出は撤去したが、この関数自体は presentation 層
 * (server.ts create-calendar ハンドラ)がまだ使う】id 一致(CollectionAlreadyExistsError)を
 * 「同一リクエストの再送(displayName も一致)」と「slug/hash 衝突(displayName が別物)」に
 * 区別するために、ハンドラ側でこの正規化比較を使う(冒頭の大きいコメント参照)。UC からの
 * export はそのまま維持し、正規化ロジックの実体をここ1箇所に保つ(ハンドラ側で再実装しない)。
 * - NFC 正規化: 日本語含む Unicode 文字列は合成済み(NFC)/分解済み(NFD)の2表現がありえ、
 *   見た目同じ displayName でもバイト列が違うと文字列比較で別物扱いになってしまう
 *   (macOS のファイルシステムは NFD を好む傾向があり、クライアント側の入力経路によっては
 *   NFD で届く可能性がゼロではない)。normalize("NFC") で表現を揃えてから比較する。
 * - trim: 前後の空白だけが違う displayName(コピペ事故等)を「同一リクエストの再送ではない」
 *   と誤判定しないための正規化。
 * - toLowerCase: "Work" と "work" は人間には同じ意図に見えることが多く、大文字小文字だけの
 *   違いで「別物」と誤判定しないための正規化。ASCII 前提の単純な toLowerCase() だが、
 *   非 ASCII 文字はこの関数の対象外でもそのまま比較に使われるので実害は無い。
 * export するのはテスト(create-collection.test.ts / mcp-server.test.ts)から直接境界値を
 * 検証したいため(slugifyForCollectionId を server.test.ts から export しているのと同じ流儀)。
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
