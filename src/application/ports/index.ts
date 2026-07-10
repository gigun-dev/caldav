// =============================================================================
// application/ports — リポジトリインターフェース(ポート&アダプタのポート側)
// =============================================================================
//
// 【なぜこの層が必要か】
// domain 層は「何のデータが必要か」を関数引数(コールバック)で示すだけで、永続化の手段を知らない
// (put-preconditions.ts の findUidOwner/existingUidAt がその例)。application 層は「どんな問い合わせ
// ができれば十分か」を型で固め、infrastructure 層(D1 アダプタ等)がそれを実装する。
// この「ポートの型」はアーキテクチャの境界線であり、ここを変えると D1/テスト双方の実装が変わる
// ことを意識して設計する。
//
// 【MCP/REST/メールハンドラから呼べる設計】
// CLAUDE.md 長期ビジョン: ユースケースは DAV 専用にしない。よってポートも HTTP/DAV 語彙
// (XML 要素名・WebDAV プロパティ名など)を一切含まない。
//
// 【CollectionUnitOfWork の必要性】
// CalendarObjectResource と CalendarCollection(syncCounter/SyncChange)は別集約だが、
// PUT/DELETE の際は「オブジェクト保存 + 変更ログ更新」を原子的に行わなければならない
// (03 §2「集約横断の整合は application 層がトランザクションで保つ」)。
// D1 の batch API はこの原子性を1往復で実現できるため、ユニットオブワーク(UoW)インターフェースを
// ポートとして定義し、D1 実装がバッチに書き出す形にする。
// =============================================================================

import type {
	Principal,
	CalendarCollection,
	CalendarObjectResource,
	SyncChange,
} from "../../domain/caldav";
import type { CollectionId, PrincipalPath, PrincipalRef, ResourceUri } from "../../domain/caldav";

// =============================================================================
// PrincipalRepository — プリンシパル(ユーザー)の永続化ポート
// =============================================================================

/**
 * プリンシパルの読み書きポート。
 *
 * 【責務の範囲】
 * 認証の「解決」(資格情報 → プリンシパル)は認証アダプタの仕事。ここはすでに解決済みの
 * プリンシパルエンティティを DB に保存・取得するだけ。
 * 実装は D1 の `principals` テーブルを想定するが、インメモリ(テスト)でも差し替え可能。
 */
export interface PrincipalRepository {
	/**
	 * プリンシパルパスで検索する。存在しなければ null。
	 * 認証ミドルウェアが「このパスのプリンシパルは実在するか」を確認するときに使う。
	 */
	findByPath(path: PrincipalPath): Promise<Principal | null>;

	/**
	 * プリンシパルを保存する(upsert)。
	 * 新規作成・再設定のどちらにも対応する(idempotent。ProvisionDefaultCollections ユースケース
	 * を冪等にするためには save も冪等である必要があるため)。
	 */
	save(principal: Principal): Promise<void>;
}

// =============================================================================
// CalendarCollectionRepository — カレンダーコレクションの永続化ポート
// =============================================================================

/**
 * コレクションの読み書きポート。
 *
 * 【SyncChange の扱い】
 * SyncChange は CalendarCollection 集約内のエンティティとして集約と同時に永続化する。
 * 「コレクションのメタデータ更新」と「変更ログの追記」を別テーブルへの個別書き込みにすると
 * 不整合が起きうるため、save はコレクション + ログ全体を一括で扱う。
 * ただし大量ログが積み上がる長期運用では変更ログの剪定(pruning)が必要になるかもしれない
 * (現時点では設計しない — YAGNI。最初にシンプルに動かし、必要になったら対処)。
 */
export interface CalendarCollectionRepository {
	/**
	 * オーナー(プリンシパル)配下の全コレクションを返す。
	 * PROPFIND Depth:1 (カレンダーリスト取得)で使う。
	 */
	findAllByOwner(owner: PrincipalRef): Promise<CalendarCollection[]>;

	/**
	 * コレクション ID + オーナーで単一コレクションを取得する。
	 * 存在しなければ null。
	 * PUT/DELETE でコレクションが存在するか確認 + syncCounter を取得するために使う。
	 */
	findById(owner: PrincipalRef, id: CollectionId): Promise<CalendarCollection | null>;

	/**
	 * コレクションを保存(upsert)。
	 * 新規作成(MKCALENDAR)と既存更新(PROPPATCH / syncCounter 更新)の両方に使う。
	 * SyncChange 一覧も含めて保存する(コレクションと変更ログは常に一緒に永続化)。
	 */
	save(collection: CalendarCollection): Promise<void>;

	/**
	 * コレクションを削除する。
	 * 配下の CalendarObjectResource も一括削除する必要がある(CASCADE)。
	 * これをポート側で要求することで、インフラ側で CASCADE DELETE を実装する責務を明確にする。
	 */
	delete(owner: PrincipalRef, id: CollectionId): Promise<void>;
}

// =============================================================================
// CalendarObjectResourceRepository — カレンダーオブジェクトリソースの読み取りポート
// =============================================================================

/**
 * カレンダーオブジェクトリソースの読み書きポート。
 *
 * 【書き込み(PUT/DELETE)は CollectionUnitOfWork 経由】
 * PUT/DELETE はリソース保存とコレクション変更ログを原子的に行う必要があるため、
 * 書き込みメソッドはこのポートに置かず CollectionUnitOfWork に委ねる。
 * このポートは「読み取り専用」+ findUidOwner/existingUidAt(PUT 事前検証用)に限定することで、
 * 「書き込みには必ず UoW を使う」という設計を型で強制する。
 */
export interface CalendarObjectResourceRepository {
	/**
	 * コレクション内の全リソースを返す。
	 * calendar-multiget や sync-collection の全件取得に使う。
	 * 件数が多い場合、将来的にページングや部分取得を追加したくなるかもしれないが、
	 * 今は最初から YAGNI で全件返す(iOS のコレクションは通常数千件未満)。
	 */
	findAllInCollection(owner: PrincipalRef, collectionId: CollectionId): Promise<CalendarObjectResource[]>;

	/**
	 * URI 指定でリソースを1件取得する。存在しなければ null。
	 * GET / HEAD、および PUT の If-Match 検証に使う。
	 */
	findByUri(owner: PrincipalRef, collectionId: CollectionId, uri: ResourceUri): Promise<CalendarObjectResource | null>;

	/**
	 * 複数 URI を一括取得する。
	 * calendar-multiget REPORT 向け。個別に findByUri を N 回呼ぶより1クエリで取れる方が
	 * D1 の往復コストを抑えられる(N+1 クエリ問題の回避)。
	 * 存在しない URI に対応する要素は結果に含まれない(null は含まず単純に省く)。
	 */
	findManyByUri(owner: PrincipalRef, collectionId: CollectionId, uris: ResourceUri[]): Promise<CalendarObjectResource[]>;

	/**
	 * 同じ UID を持つリソースの URI を返す(存在しなければ null)。
	 * PUT precondition の no-uid-conflict 判定(R4)で使う。
	 * findUidOwner(uid) = targetUri ならば「同じリソースの更新」なので衝突ではない。
	 */
	findUriByUid(owner: PrincipalRef, collectionId: CollectionId, uid: string): Promise<ResourceUri | null>;

	/**
	 * 指定 URI に現在保存されているリソースの UID を返す(存在しなければ null)。
	 * PUT precondition の「UID 変更禁止」(R4b: 更新時に UID が変わっていないか)で使う。
	 */
	getUidAtUri(owner: PrincipalRef, collectionId: CollectionId, uri: ResourceUri): Promise<string | null>;
}

// =============================================================================
// CollectionUnitOfWork — 原子的な書き込みポート
// =============================================================================

/**
 * カレンダーオブジェクトリソースの保存 + コレクションの変更ログ更新を原子的に行う UoW。
 *
 * 【なぜ UoW インターフェースを別に切るのか】
 * CalendarObjectResource と CalendarCollection は別集約だが、「オブジェクトを PUT/DELETE する」
 * という操作は必ずコレクションの syncCounter を進める。D1 の batch API では複数の SQL を
 * 1リクエストで原子的に実行できる。この「複数集約の横断更新」を
 *   ① CalendarObjectResourceRepository に save/delete を生やす
 *   ② CollectionRepository に commit を呼ぶ
 * という2ステップで別々に行うと、途中で失敗したとき整合が取れなくなる。
 * UoW インターフェースに「リソース操作 + コレクション変更ログ更新」をまとめて渡し、
 * D1 実装がこれを1バッチに収める設計にする。
 *
 * 【実装 hint (infrastructure 側)】
 * D1 実装では:
 *   - saveResource → "UPSERT INTO calendar_objects ..."
 *   - deleteResource → "DELETE FROM calendar_objects WHERE ..."
 *   - 上記に伴い "UPDATE calendar_collections SET sync_counter = ? WHERE ..." +
 *                 "INSERT INTO sync_changes ..." を同一バッチで積む
 */
export interface CollectionUnitOfWork {
	/**
	 * リソースを保存(upsert)してコレクションに変更を記録する。
	 * @param owner - コレクションのオーナー
	 * @param collectionId - 保存先コレクション ID
	 * @param resource - 保存する CalendarObjectResource
	 * @param collection - 変更ログを更新したい CalendarCollection
	 *   (recordChange を呼んだ後の状態を渡す。UoW 実装はこの状態を DB に書く)
	 * @param changeKind - "created" か "modified" か(変更ログのエントリ種別)
	 */
	saveResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
	): Promise<void>;

	/**
	 * リソースを削除してコレクションに変更を記録する。
	 * @param owner - コレクションのオーナー
	 * @param collectionId - 削除先コレクション ID
	 * @param uri - 削除するリソースの URI
	 * @param collection - 変更ログを更新したい CalendarCollection
	 *   (recordChange を呼んだ後の状態を渡す。UoW 実装はこの状態を DB に書く)
	 */
	deleteResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uri: ResourceUri,
		collection: CalendarCollection,
	): Promise<void>;
}
