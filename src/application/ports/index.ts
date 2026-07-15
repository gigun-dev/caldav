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

// G-5: MCP 入口の認証ポート(AuthenticationPort / AuthContext / AuthResult)。
// 契約の詳細は authentication.ts のコメントを参照(このファイルは既存の書式に合わせ re-export のみ)。
export * from "./authentication";
import type { ComponentKind } from "../../domain/caldav";
import type { OccurrenceBounds } from "../../domain/ical/recurrence";

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

	/**
	 * G-3: calendar-query REPORT の time-range フィルタ向け。first_occurrence/last_occurrence
	 * 索引列(migrations/0002)を使って粗く絞り込んだ候補を返す。
	 *
	 * 【SQL の絞り込みは「粗い」ことを許容する契約】
	 * 呼び出し側(CalendarQuery ユースケース)は、この結果に対してさらに expandRecurrenceSet で
	 * 精密なオーバーラップ判定を行う。よってこのメソッドは「範囲窓 [rangeStartMillis,
	 * rangeEndMillis) と重なりうる候補を過不足なく含む(取りこぼしはしないが多少多く返してよい)」
	 * ことだけを保証すればよい。TZ 知識(floating のスラック等)はここに持ち込まない —
	 * 呼び出し側が窓を広げてから渡す(repository は「言われた窓で引くだけ」)。
	 * NULL の first/last(未索引 or 期間概念なし)は常に候補に含める(migrations/0002 のコメント)。
	 *
	 * @param componentKind VEVENT/VTODO どちらの comp-filter か。
	 * @param rangeStartMillis 窓の開始(半開区間の下限)。
	 * @param rangeEndMillis 窓の終了(半開区間の上限、非包含)。
	 */
	findInCollectionByTimeRange(
		owner: PrincipalRef,
		collectionId: CollectionId,
		componentKind: ComponentKind,
		rangeStartMillis: number,
		rangeEndMillis: number,
	): Promise<CalendarObjectResource[]>;

	/**
	 * E-1 レイテンシ改善(2026-07-14): ListTodos 向けに「コレクション内の VTODO のみ」を
	 * SQL 側で絞り込んで返す。findAllInCollection だと VEVENT/VJOURNAL も含めて全件を
	 * D1 から引いてから ICS を全パースしていた(本番実測で list-todos avg 706ms の主因)。
	 *
	 * 【完了状態(STATUS:COMPLETED)は SQL 化しなかった判断】
	 * calendar_objects テーブルに STATUS 相当の列が無い(migrations/0001,0003 参照。
	 * component_kind はあるが完了状態は無い)。列追加には SQLite の CHECK 制約の都合上
	 * 0003_vjournal.sql と同じ「12-step テーブル再作成」が要り、かつ既存 ICS 全行への
	 * バックフィル(PUT 時にしか STATUS を列へ複製できないので、既存行は再 PUT されるまで
	 * NULL のまま)も必要になる。前方互換規律(migrations/README.md)の手続きコストに対して、
	 * このタスクのスコープでは kind 絞りだけでも「カレンダーと同一コレクションに VEVENT が
	 * 混在するケース」で十分効く(iOS の既定運用ではむしろ tasks コレクションは VTODO のみで
	 * 均一なことが多く、その場合は kind 絞りの効果は薄いが、退行は起きない)。完了状態の
	 * SQL 化は STATUS 列追加の migration を切ってから別スライスで行う。
	 *
	 * @param collectionId 対象コレクション。ListTodos の既定は "tasks" だが calendarId で変更可。
	 */
	findVTodosInCollection(owner: PrincipalRef, collectionId: CollectionId): Promise<CalendarObjectResource[]>;
}

// =============================================================================
// CollectionUnitOfWork — 原子的な書き込みポート
// =============================================================================

/**
 * CollectionUnitOfWork が(防波堤として)投げる書き込み競合エラー。
 * - HTTP: 412 Precondition Failed(presentation 層でマッピング。app.ts の errorResponse 参照)。
 *
 * 【S-B (2026-07-16): R-7 のコレクション CAS は廃止 — このエラーの役割は縮小した】
 * R-7 では「collection の baseline counter を条件にした CAS UPDATE の空振り」を検知する
 * 主役だったが、そのコレクション粒度 CAS は別リソースへの並行書き込みまで 412 にする
 * 過剰ガードだと実機で判明した(docs/modeling/12 §7.4)。書き込みの競合検知は
 * **リソース単位の ETag(put-calendar-object.ts Step 3 の must-match)に一本化**され、
 * 412 の意図した経路は ETagConditionError になった。このエラー型が残っているのは:
 *   - D1 実装で sync_changes の PK 制約違反等、理論上到達しないはずの競合の現れを
 *     生の 500 でなく「再送すれば直る 412」へ正規化する最後の防波堤(repositories.ts の
 *     executeWriteBatch コメント参照)。
 *   - presentation 層の 412 マッピング(app.ts)自体は据え置きで害がない。
 *
 * 【なぜ domain ではなく application/ports に置くのか】
 * 書き込みが競合したという事実は集約(CalendarCollection)のドメイン不変条件の話ではなく、
 * 永続化層が複数リクエストを直列化できない(D1 は行ロックを明示的に取れない)ことに起因する
 * 技術的関心事。domain 層は「起きたことを記録する」役割だけを持ち、「記録が競合したとき
 * どうするか」は infrastructure/application の責務なので、エラー型もここ(ports)に置く。
 *
 * 【再試行ロジックをここに持ち込まない判断(R-7 から継続、S-B で一部変更)】
 * UoW は「保存する」ことだけを知っていればよく、リトライは持たない。S-B で
 * update-event/update-todo(意味的パッチを持つ UC)には「ETag 不一致時に1回だけ
 * re-read→re-patch」の自動リトライを入れたが、それは UC 層の判断(パッチの再適用が
 * 安全だと UC だけが知っている)であって UoW の責務ではない。
 */
export class ConcurrencyConflictError extends Error {
	readonly kind = "ConcurrencyConflictError" as const;
	constructor(
		readonly owner: PrincipalRef,
		readonly collectionId: CollectionId,
	) {
		super(`Concurrent write conflict on calendar collection: ${owner} / ${collectionId}`);
		this.name = "ConcurrencyConflictError";
	}
}

/**
 * カレンダーオブジェクトリソースの保存 + コレクションの変更ログ更新を原子的に行う UoW。
 *
 * 【S-B (2026-07-16) 契約: アトミック採番 + ETag 一本化(R-7 の CAS 契約を置換)】
 * saveResource/deleteResource は競合検知をしない(書き込みの前提条件はリソース単位の ETag
 * として put-calendar-object.ts Step 3 が判定済み)。実装(D1CollectionUnitOfWork)は
 *   ① `UPDATE calendar_collections SET sync_counter = sync_counter + 1`(baseline 条件なしの
 *      アトミックインクリメント)を batch の先頭に置く。別リソースへの並行書き込みは両方成功し、
 *      counter はそれぞれ +1 ずつ進む(RFC 6578 のトークン単調性はこれだけで保たれる —
 *      6578 が要求するのは「後退しないこと」であって、書き込みの比較粒度ではない)。
 *   ② sync_changes の token は「①適用後の DB 側 counter」を同一トランザクション内の
 *      サブクエリで読んで採番する(メモリ上の recordChange 後の値は並行時に古くなりうるため
 *      使わない — repositories.ts の②コメント参照)。
 *   ③ calendar_objects の upsert/delete は素の文(R-7 の自己参照ガードは①の CAS とともに撤去)。
 *
 * 【なぜ R-7 のコレクション CAS を捨てたか】別リソースへの並行書き込みまで 412 にする
 * 過剰ガードだった(実機で iOS PUT × LLM update-event × カード保存が衝突 —
 * docs/modeling/12 §7.4)。コレクション CAS は RFC 6578 由来ではなく実装都合であり、
 * リソース単位 ETag が守るべき不変条件(lost update 防止)を過不足なく守る。
 *
 * 【ボツ案 (architect 却下): SELECT FOR UPDATE 相当のロック】
 * D1(SQLite ベース)には行ロックを明示的に取る構文が無く、batch() の原子性は「同一トランザクション
 * として実行される」ことのみを保証する(実行順に他クライアントを締め出すロックではない)。
 * よって「読んでからロックする」型の悲観ロックは実装できない。CAS(書き込み時に基準値を検証)
 * のほうが D1 の実行モデルに素直に乗る。
 *
 * 【ボツ案 (architect 却下): DO による直列化】
 * Durable Object を1コレクションにつき1つ立てて全書き込みをそこへ直列化する案は、CalDAV の
 * 書き込みパスすべてに DO 呼び出しを挟む大改修になり、R-7 のスコープ(「偶発的な砦を意図した
 * 設計に昇格させる」)を大きく超える。将来の書き込みスループット要求次第では検討に値するが、
 * 今は YAGNI。
 *
 * 【S-B 追補 (2026-07-16): 同一リソースの整合検知は DB 側 ETag CAS で閉じた】
 * R-7 は「etag 列 CAS 単独」案を採番の一意性を理由に却下したが、採番は上の①②(アトミック
 * インクリメント + トランザクション内サブクエリ)で CAS なしに守れることが分かった。そこで
 * S-B では③(calendar_objects への書き込み)に **expected etag 条件**を足し、リソース単位の
 * TOCTOU 窓を DB 側で閉じた:
 *   - must-match(更新)経路: ③を `... WHERE ... AND etag = :expectedOldEtag`(lookup 時に
 *     読んだ etag)にし、①②も同じ etag の EXISTS でゲートする。etag がずれていれば①②③とも
 *     0 行 no-op になり、実装は末尾③の 0 行を見て ConcurrencyConflictError を投げる。
 *     → 「lookup してから書くまでに他者が同じリソースを書いた」を DB 側で検知(窓が閉じる)。
 *   - must-not-exist(新規)経路: ③は素の INSERT(ON CONFLICT なし)。並行 create が先に
 *     入っていれば PK 制約違反 → ConcurrencyConflictError(TOCTOU create も閉じる)。
 *   - unconditional / must-exist(overwrite)経路: 従来どおり last-writer-wins(素の UPSERT/
 *     DELETE)。クライアントが明示的に無条件上書きを要求した経路なので etag CAS は掛けない。
 * **別リソースへの並行書き込みは etag(と uri)が別なので互いに影響せず、S-B の目的(R-7 の
 * 過剰 412 の解消)はそのまま維持される** — ETag CAS はあくまで「同じ 1 リソース」への
 * 競合だけを 412 にする。ETagConditionError(presentation のメモリ判定)と
 * ConcurrencyConflictError(この DB 側 CAS)は、どちらで競合を捕まえても update-event/
 * update-todo の自動リトライ(1回 re-read→re-patch)が発火するよう正規化されている。
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

/**
 * S-B (2026-07-16): リソース書き込みの前提条件(DB 側 ETag CAS の粒度を決める)。
 * put-calendar-object / delete-calendar-object が「メモリで読んだ ETagCondition と existing」から
 * 導出して UoW に渡す。UoW 実装(D1CollectionUnitOfWork)はこれを③の SQL に写す。
 *
 * - `create`: リソースがまだ無い前提(If-None-Match:*)。③は素の INSERT で、並行 create の
 *   PK 制約違反を ConcurrencyConflictError に写す。
 * - `match`: 既存 etag が expectedEtag と一致する前提(If-Match:<etag>)。③に etag 条件を付け、
 *   ①②も同 etag でゲートする。0 行 = ずれ = ConcurrencyConflictError。
 * - `overwrite`: 無条件上書き(unconditional / If-Match:*)。etag CAS は掛けず last-writer-wins。
 */
export type ResourceWritePrecondition =
	| { kind: "create" }
	| { kind: "match"; expectedEtag: string }
	| { kind: "overwrite" };

export interface CollectionUnitOfWork {
	/**
	 * リソースを保存(upsert)してコレクションに変更を記録する。
	 * @param owner - コレクションのオーナー
	 * @param collectionId - 保存先コレクション ID
	 * @param resource - 保存する CalendarObjectResource
	 * @param collection - 変更ログを更新したい CalendarCollection
	 *   (recordChange を呼んだ後の状態を渡す。UoW 実装は末尾の変更(uri/kind)を変更ログへ書く。
 *   token はメモリ値でなく DB 側で採番する — S-B、上の契約①②参照)
	 * @param bounds - G-3: PUT 時に計算した first/last occurrence 索引値(occurrence-bounds.ts)。
	 *   CalendarObjectResource 集約自体には持たせない(bounds は導出インデックスであって
	 *   集約の状態ではない — 確定設計メモの判断)。D1 実装は calendar_objects の
	 *   first_occurrence/last_occurrence 列へ書く。null は「未索引/期間概念なし」として
	 *   NULL を書く(migrations/0002 のコメント参照)。
	 * @param precondition - S-B: DB 側 ETag CAS の粒度(ResourceWritePrecondition)。
	 *   create=新規 / match=etag 一致更新 / overwrite=無条件上書き。
	 */
	saveResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
		bounds: OccurrenceBounds,
		precondition: ResourceWritePrecondition,
	): Promise<void>;

	/**
	 * リソースを削除してコレクションに変更を記録する。
	 * @param owner - コレクションのオーナー
	 * @param collectionId - 削除先コレクション ID
	 * @param uri - 削除するリソースの URI
	 * @param collection - 変更ログを更新したい CalendarCollection
	 *   (recordChange を呼んだ後の状態を渡す。UoW 実装は末尾の変更(uri/kind)を変更ログへ書く。
 *   token はメモリ値でなく DB 側で採番する — S-B、上の契約①②参照)
	 * @param precondition - S-B: DB 側 ETag CAS の粒度。match=If-Match 付き削除(etag 一致時のみ)/
	 *   overwrite=無条件削除。create は削除では使わない。
	 */
	deleteResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uri: ResourceUri,
		collection: CalendarCollection,
		precondition: ResourceWritePrecondition,
	): Promise<void>;
}
