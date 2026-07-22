// =============================================================================
// D1 repositories — application ポートの Cloudflare D1 アダプタ
// =============================================================================
// SQL 行をドメイン集約へ復元する処理はこの層に閉じ込める。presentation/application は
// D1Database やテーブル名を知らず、テストでは同じポートをインメモリ実装へ差し替えられる。

import {
	AppleColor,
	CalendarCollection,
	CalendarObjectResource,
	Principal,
	SyncChange,
	SyncToken,
	collectionId,
	isComponentKind,
	principalPath,
	resourceUri,
	type CollectionId,
	type ComponentKind,
	type PrincipalPath,
	type PrincipalRef,
	type ResourceUri,
} from "../../domain/caldav";
import type { OccurrenceBounds } from "../../domain/ical/recurrence";
import {
	ConcurrencyConflictError,
	type CalendarCollectionRepository,
	type CalendarObjectResourceRepository,
	type CollectionUnitOfWork,
	type PrincipalRepository,
	type ResourceWritePrecondition,
} from "../../application/ports";

interface CollectionRow {
	owner: string;
	id: string;
	display_name: string;
	supported_components: string | null;
	color: string | null;
	order_number: number | null;
	sync_counter: number;
}

interface ChangeRow {
	uri: string;
	kind: "created" | "modified" | "deleted";
	token: number;
}

interface ResourceRow {
	uri: string;
	ics: string;
}

function parseSupported(raw: string | null): readonly ComponentKind[] | undefined {
	if (raw === null) return undefined;
	const parsed: unknown = JSON.parse(raw);
	// 2026-07-14 回帰修正: 以前は "VEVENT" | "VTODO" をこの関数内でハードコード列挙しており、
	// J-1/J-2 で VJOURNAL が domain の COMPONENT_KINDS に追加された後もここだけ取り残されていた。
	// その結果 VJOURNAL コレクションを MKCALENDAR で作ると次回 hydrate 時にここで throw → 500 に
	// なる回帰を踏んだ(R-1)。許容集合の二重管理が原因なので、domain の isComponentKind を
	// 唯一の判定源として参照する形に直す(infrastructure→domain の依存方向は規約どおり)。
	if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string" || !isComponentKind(v))) {
		throw new Error("D1 contains invalid supported_components");
	}
	return parsed as ComponentKind[];
}

async function hydrateCollection(db: D1Database, row: CollectionRow): Promise<CalendarCollection> {
	const changes = await db.prepare(
		`SELECT uri, kind, token FROM sync_changes
		 WHERE owner = ? AND collection_id = ? ORDER BY token`,
	).bind(row.owner, row.id).all<ChangeRow>();

	return new CalendarCollection({
		id: collectionId(row.id),
		owner: principalPath(row.owner),
		displayName: row.display_name,
		supportedComponents: parseSupported(row.supported_components),
		color: row.color === null ? undefined : AppleColor.parse(row.color),
		order: row.order_number ?? undefined,
		syncCounter: SyncToken.of(row.sync_counter),
		changeLog: changes.results.map(
			(ch) => new SyncChange(resourceUri(ch.uri), ch.kind, SyncToken.of(ch.token)),
		),
	});
}

async function hydrateResource(row: ResourceRow): Promise<CalendarObjectResource> {
	// ETag/UID/kind は ICS から決定的に再導出する。DB列は検索・一意制約用であり、集約の
	// source of truth はロスレスに保存した ICS 本文である。
	return CalendarObjectResource.fromIcs(resourceUri(row.uri), row.ics);
}

export class D1PrincipalRepository implements PrincipalRepository {
	constructor(private readonly db: D1Database) {}

	async findByPath(path: PrincipalPath): Promise<Principal | null> {
		const row = await this.db.prepare(
			"SELECT principal_path, calendar_home_set FROM principals WHERE principal_path = ?",
		).bind(path).first<{ principal_path: string; calendar_home_set: string }>();
		return row ? Principal.create(row.principal_path, row.calendar_home_set) : null;
	}

	async save(principal: Principal): Promise<void> {
		await this.db.prepare(
			`INSERT INTO principals(principal_path, calendar_home_set) VALUES (?, ?)
			 ON CONFLICT(principal_path) DO UPDATE SET calendar_home_set = excluded.calendar_home_set`,
		).bind(principal.principalPath, principal.calendarHomeSet).run();
	}
}

export class D1CalendarCollectionRepository implements CalendarCollectionRepository {
	constructor(private readonly db: D1Database) {}

	async findAllByOwner(owner: PrincipalRef): Promise<CalendarCollection[]> {
		const rows = await this.db.prepare(
			"SELECT * FROM calendar_collections WHERE owner = ? ORDER BY order_number, id",
		).bind(owner).all<CollectionRow>();
		return Promise.all(rows.results.map((row) => hydrateCollection(this.db, row)));
	}

	async findById(owner: PrincipalRef, id: CollectionId): Promise<CalendarCollection | null> {
		const row = await this.db.prepare(
			"SELECT * FROM calendar_collections WHERE owner = ? AND id = ?",
		).bind(owner, id).first<CollectionRow>();
		return row ? hydrateCollection(this.db, row) : null;
	}

	async save(collection: CalendarCollection): Promise<void> {
		await this.db.prepare(
			`INSERT INTO calendar_collections
			 (owner, id, display_name, supported_components, color, order_number, sync_counter)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(owner, id) DO UPDATE SET
			 display_name=excluded.display_name,
			 supported_components=excluded.supported_components,
			 color=excluded.color,
			 order_number=excluded.order_number,
			 sync_counter=excluded.sync_counter`,
		).bind(
			collection.owner,
			collection.id,
			collection.displayName,
			collection.supportedComponents === undefined
				? null
				: JSON.stringify(collection.supportedComponents),
			collection.color?.toString() ?? null,
			collection.order ?? null,
			collection.syncToken.counter,
		).run();
	}

	async delete(owner: PrincipalRef, id: CollectionId): Promise<void> {
		await this.db.prepare(
			"DELETE FROM calendar_collections WHERE owner = ? AND id = ?",
		).bind(owner, id).run();
	}
}

export class D1CalendarObjectResourceRepository implements CalendarObjectResourceRepository {
	constructor(private readonly db: D1Database) {}

	async findAllInCollection(owner: PrincipalRef, id: CollectionId): Promise<CalendarObjectResource[]> {
		const rows = await this.db.prepare(
			"SELECT uri, ics FROM calendar_objects WHERE owner = ? AND collection_id = ? ORDER BY uri",
		).bind(owner, id).all<ResourceRow>();
		return Promise.all(rows.results.map(hydrateResource));
	}

	async findByUri(owner: PrincipalRef, id: CollectionId, uri: ResourceUri): Promise<CalendarObjectResource | null> {
		const row = await this.db.prepare(
			"SELECT uri, ics FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
		).bind(owner, id, uri).first<ResourceRow>();
		return row ? hydrateResource(row) : null;
	}

	async findManyByUri(owner: PrincipalRef, id: CollectionId, uris: ResourceUri[]): Promise<CalendarObjectResource[]> {
		if (uris.length === 0) return [];
		const placeholders = uris.map(() => "?").join(",");
		const rows = await this.db.prepare(
			`SELECT uri, ics FROM calendar_objects
			 WHERE owner = ? AND collection_id = ? AND uri IN (${placeholders})`,
		).bind(owner, id, ...uris).all<ResourceRow>();
		return Promise.all(rows.results.map(hydrateResource));
	}

	async findUriByUid(owner: PrincipalRef, id: CollectionId, uid: string): Promise<ResourceUri | null> {
		const row = await this.db.prepare(
			"SELECT uri FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uid = ?",
		).bind(owner, id, uid).first<{ uri: string }>();
		return row ? resourceUri(row.uri) : null;
	}

	async getUidAtUri(owner: PrincipalRef, id: CollectionId, uri: ResourceUri): Promise<string | null> {
		const row = await this.db.prepare(
			"SELECT uid FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
		).bind(owner, id, uri).first<{ uid: string }>();
		return row?.uid ?? null;
	}

	/**
	 * G-3: time-range フィルタ向けの粗い絞り込み。migrations/0002 の索引列を使う。
	 * NULL(未索引/期間概念なし)は常に候補に含める(=絞り込まれない)。ポートの契約どおり
	 * 「取りこぼしはしないが多少多く返してよい」ので、ここでは正確なオーバーラップまでは
	 * 見ない(呼び出し側 CalendarQuery が expandRecurrenceSet で最終判定する)。
	 */
	async findInCollectionByTimeRange(
		owner: PrincipalRef,
		id: CollectionId,
		componentKind: ComponentKind,
		rangeStartMillis: number,
		rangeEndMillis: number,
	): Promise<CalendarObjectResource[]> {
		const rows = await this.db.prepare(
			`SELECT uri, ics FROM calendar_objects
			 WHERE owner = ? AND collection_id = ? AND component_kind = ?
			 AND (last_occurrence IS NULL OR last_occurrence > ?)
			 AND (first_occurrence IS NULL OR first_occurrence < ?)
			 ORDER BY uri`,
		).bind(owner, id, componentKind, rangeStartMillis, rangeEndMillis).all<ResourceRow>();
		return Promise.all(rows.results.map(hydrateResource));
	}

	/**
	 * E-1 レイテンシ改善(2026-07-14): ListTodos 向けの VTODO 限定取得。
	 * ports/index.ts のコメントどおり、STATUS(完了状態)列が無いのでここでは component_kind
	 * だけを SQL 側で絞る(完了状態は呼び出し側 UC がメモリで判定する)。
	 *
	 * 【索引が効くか】calendar_objects の PRIMARY KEY は (owner, collection_id, uri) なので
	 * owner+collection_id の等値条件だけで対象行はすでに B-tree 上で連続範囲に絞られている
	 * (findAllInCollection と同じ土台)。そこに component_kind = ? を additional filter として
	 * 掛けても、絞り込み対象の行数自体は PK 検索の時点で「そのコレクション内の行」まで
	 * 減っているため、component_kind 専用の複合索引を新設するほどの効果は見込みにくい
	 * (calendar_objects_time_range 索引のような owner/collection_id 以降の追加列と違い、
	 * component_kind は等値条件1つだけなのでフルスキャンでも対象行数は小さい)。よって今回は
	 * 新規索引を追加せず、既存 PK の範囲内で WHERE 句フィルタするだけに留める。
	 * 転送量削減(VEVENT/VJOURNAL の ICS 本文を D1→Worker 間で運ばない)が主目的。
	 */
	async findVTodosInCollection(owner: PrincipalRef, id: CollectionId): Promise<CalendarObjectResource[]> {
		const rows = await this.db.prepare(
			"SELECT uri, ics FROM calendar_objects WHERE owner = ? AND collection_id = ? AND component_kind = 'VTODO' ORDER BY uri",
		).bind(owner, id).all<ResourceRow>();
		return Promise.all(rows.results.map(hydrateResource));
	}

	/**
	 * レイテンシ案2(2026-07-22): owner 配下の time-range 一致リソースを、collection_id 付きで
	 * 1 クエリ取得する。findInCollectionByTimeRange の WHERE を「collection_id 等値」から
	 * 「owner 等値 + (任意) collection_id IN(...)」に緩めただけで、time-range 部分は同一。
	 *
	 * 【索引が効くか】migrations/0002 の calendar_objects_time_range は
	 * (owner, collection_id, component_kind, last_occurrence, first_occurrence) を想定した複合索引。
	 * 全横断(collection_id 条件なし)でも先頭 owner + component_kind の等値でプレフィックスが効く
	 * (collection_id を飛ばすと last/first_occurrence は範囲索引としては使えないが、owner スコープ内の
	 * 行数は現実 ~数千未満なのでスキャンは軽い。旧経路の N 往復を 1 往復に畳む効果が支配的)。
	 *
	 * 【IN 句プレースホルダ上限】D1/SQLite の bound parameter 上限は 999。collectionIds は
	 * calendarIds 指定(UI の表示フィルタ)由来で現実 ~7 件程度なので上限に触れない。将来
	 * 数百コレクションを一度に指定する需要が出たら分割 IN が要るが、今は YAGNI(コメントで明示)。
	 */
	async findByOwnerTimeRange(
		owner: PrincipalRef,
		componentKind: ComponentKind,
		rangeStartMillis: number,
		rangeEndMillis: number,
		collectionIds?: readonly CollectionId[],
	): Promise<{ collectionId: CollectionId; resource: CalendarObjectResource }[]> {
		// 空配列は「どのコレクションにもマッチしない」= 空結果(ports の契約)。全横断(undefined)と
		// 区別してここで早期 return する(SQL に `IN ()` を書くと SQLite で構文エラーになるため)。
		if (collectionIds !== undefined && collectionIds.length === 0) return [];

		// collectionIds 指定時のみ IN 句を追加する。undefined(全横断)なら collection_id 条件を付けない。
		const inClause =
			collectionIds !== undefined
				? ` AND collection_id IN (${collectionIds.map(() => "?").join(",")})`
				: "";
		const stmt = this.db.prepare(
			`SELECT collection_id, uri, ics FROM calendar_objects
			 WHERE owner = ? AND component_kind = ?
			 AND (last_occurrence IS NULL OR last_occurrence > ?)
			 AND (first_occurrence IS NULL OR first_occurrence < ?)${inClause}
			 ORDER BY collection_id, uri`,
		).bind(
			owner,
			componentKind,
			rangeStartMillis,
			rangeEndMillis,
			...(collectionIds ?? []),
		);
		const rows = await stmt.all<ResourceRow & { collection_id: string }>();
		return Promise.all(
			rows.results.map(async (row) => ({
				collectionId: collectionId(row.collection_id),
				resource: await hydrateResource(row),
			})),
		);
	}
}

export class D1CollectionUnitOfWork implements CollectionUnitOfWork {
	constructor(private readonly db: D1Database) {}

	/**
	 * saveResource/deleteResource が共有する batch 実行ヘルパー。3文構成
	 * (①採番 UPDATE → ②sync_changes INSERT → ③object 側の書き込み)の後半2文は呼び出し側が
	 * 組み立て、ここでは実行と結果判定だけを共通化する。
	 *
	 * 【S-B (2026-07-16): R-7 のコレクション CAS を廃止した経緯】
	 * R-7 では①を `UPDATE ... SET sync_counter = :new WHERE ... AND sync_counter = :baseline`
	 * (hydrate 時点の baseline との比較 CAS)にしていたが、これは**別リソースへの並行書き込み
	 * まで 412 にする過剰ガード**だと実機で判明した(iOS の PUT・LLM の update-event・カードの
	 * 保存が別々のリソースでも重なると「変更を保存できません」— docs/modeling/12 §7.4)。
	 * RFC 6578 が要求するのは「sync-token(counter)が単調に進み後退しないこと」であって、
	 * 書き込みの CAS 比較粒度とは独立(コレクション CAS は 6578 由来でなく実装都合だった)。
	 * よって:
	 *   - 書き込みの競合検知は **リソース単位の ETag(If-Match/must-match)に一本化**する
	 *     (put-calendar-object.ts Step 3 が唯一の前提条件。412 の唯一の意図経路)。
	 *   - ①は baseline 条件なしの `SET sync_counter = sync_counter + 1`(アトミック
	 *     インクリメント)にする。単調増加はこれだけで保たれる(後退しない・6578 は無傷)。
	 *
	 * 【①の meta.changes === 0 判定を残す理由(意味は変わった)】
	 * baseline 廃止後、①が0行になるのは「calendar_collections の行そのものが無い」とき
	 * だけ(並行する MKCALENDAR 削除など極端なケース)。これは楽観ロック競合ではないが、
	 * ②③が親不在のまま書かれる(sync_changes の token サブクエリが NULL になる等)のを
	 * 成功として返してはいけないので、引き続き先頭要素を検査して throw する。
	 * ConcurrencyConflictError(→412)ではなく素の Error(→500)に倒す: クライアントに
	 * 「取得し直して再送」を促しても行が無ければ直らないため。
	 *
	 * 【②の制約違反 catch を残す理由(create 経路の TOCTOU + 最後の防波堤)】
	 * ②の token は「①でインクリメントした後の counter」を同一トランザクション内のサブクエリで
	 * 読むため、SQLite の書き込み直列化の下では PK (owner, collection_id, token) 衝突は
	 * 原理的に起きないはず。それでも catch を残すのは:
	 *   - S-B: create 経路(③が素の INSERT)で並行 create が先に入っていた場合、
	 *     calendar_objects の PK 制約違反がここに来る(= 同一 URI への TOCTOU create を検知)。
	 *   - D1 の実行モデルや将来の実装変更に余計な前提を置かない(R-7 で「偶発的な砦が生の 500 に
	 *     なっていた」反省の再発防止)。
	 * 万一ここに来たら ConcurrencyConflictError(412)に正規化する — クライアントが再送すれば
	 * 直る種類の失敗として扱うのが 500 より安全。
	 *
	 * 【S-B: etagCas フラグで「0 行」の解釈を切り替える】
	 * - etagCas=false(create/overwrite 経路): ①②③はゲート無しなので、①が0行 = コレクション行
	 *   不在(競合ではなく構造異常)。素の Error(→500)に倒す — 再送しても直らないため。
	 * - etagCas=true(match 経路): ①②③すべてを expected etag の EXISTS/AND でゲートしている。
	 *   etag がずれていれば①②③とも0行 no-op になるので、**末尾③の 0 行**を見て
	 *   ConcurrencyConflictError(→412)に倒す(= 同一リソースの TOCTOU を DB 側で検知)。
	 *   ここでは①ではなく③を見る: match 経路で①が0行になるのは「行不在 or etag ずれ」の両方だが、
	 *   どちらも「取得し直して再送」で解ける競合なので、③の0行=競合の一本判定で足りる。
	 */
	private async executeWriteBatch(
		owner: PrincipalRef,
		id: CollectionId,
		statements: D1PreparedStatement[],
		etagCas: boolean,
	): Promise<void> {
		let results: D1Result[];
		try {
			results = await this.db.batch(statements);
		} catch {
			// PK 制約違反等(上のコメント【②の制約違反 catch を残す理由】)。
			throw new ConcurrencyConflictError(owner, id);
		}
		if (etagCas) {
			// match 経路: 末尾③(object 書き込み)が0行 = expected etag とずれた = 競合。
			const objResult = results[results.length - 1];
			if (objResult?.meta.changes === 0) {
				throw new ConcurrencyConflictError(owner, id);
			}
		} else {
			// create/overwrite 経路: ①(先頭の採番 UPDATE)が0行 = コレクション行不在(構造異常)。
			const bumpResult = results[0];
			if (bumpResult?.meta.changes === 0) {
				throw new Error(
					`calendar_collections row missing during write: ${owner} / ${id} (was it deleted concurrently?)`,
				);
			}
		}
	}

	/**
	 * ①採番 UPDATE + ②sync_changes INSERT を組み立てる(save/delete 共通)。
	 * precondition が match のときだけ、①②を expected etag の EXISTS でゲートして
	 * 「etag がずれていたら counter を進めず変更ログも書かない」ようにする(③だけをガードすると
	 * batch は atomic でも 0 行は error でないため①②が commit されてしまい、counter だけ進んで
	 * ③が空振りする不整合が起きる。だから①②③を揃ってゲートする — executeWriteBatch のコメント)。
	 */
	private bumpAndLogStatements(
		owner: PrincipalRef,
		id: CollectionId,
		uri: ResourceUri,
		kind: string,
		precondition: ResourceWritePrecondition,
	): D1PreparedStatement[] {
		if (precondition.kind === "match") {
			const expected = precondition.expectedEtag;
			// EXISTS ゲート: 対象リソースの現在 etag が expected と一致するときだけ進む。
			return [
				this.db.prepare(
					`UPDATE calendar_collections SET sync_counter = sync_counter + 1
					 WHERE owner = ? AND id = ?
					   AND EXISTS (SELECT 1 FROM calendar_objects
					               WHERE owner = ? AND collection_id = ? AND uri = ? AND etag = ?)`,
				).bind(owner, id, owner, id, uri, expected),
				this.db.prepare(
					`INSERT INTO sync_changes(owner, collection_id, token, uri, kind)
					 SELECT owner, id, sync_counter, ?, ? FROM calendar_collections
					 WHERE owner = ? AND id = ?
					   AND EXISTS (SELECT 1 FROM calendar_objects
					               WHERE owner = ? AND collection_id = ? AND uri = ? AND etag = ?)`,
				).bind(uri, kind, owner, id, owner, id, uri, expected),
			];
		}
		// create / overwrite: ゲート無しのアトミックインクリメント + サブクエリ採番。
		// 別リソースへの並行書き込みが重なっても両方成功し、counter は +1 ずつ進む
		// (単調増加 = RFC 6578 のトークン後退なしを維持)。token をメモリ値でなく DB 側で
		// 採番する理由は下の②コメント参照。
		return [
			this.db.prepare(
				"UPDATE calendar_collections SET sync_counter = sync_counter + 1 WHERE owner = ? AND id = ?",
			).bind(owner, id),
			this.db.prepare(
				`INSERT INTO sync_changes(owner, collection_id, token, uri, kind)
				 SELECT owner, id, sync_counter, ?, ? FROM calendar_collections WHERE owner = ? AND id = ?`,
			).bind(uri, kind, owner, id),
		];
	}

	async saveResource(
		owner: PrincipalRef,
		id: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
		bounds: OccurrenceBounds,
		precondition: ResourceWritePrecondition,
	): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("saveResource requires a recorded collection change");
		// ①② 採番 + 変更ログ。
		// 【②の token をメモリ値でなく DB 側で採番する理由】メモリ上の collection.syncToken.counter は
		// 「hydrate 時点 + recordChange 回数」でしかなく、並行書き込みで DB 側が先に進んでいると
		// 古い token を書いて PK 衝突する。DB 側でインクリメントした現在値を同一トランザクション内で
		// 読めば、並行2本でも token は必ず別値になり PK (owner, collection_id, token) と整合する。
		// 【なぜ RETURNING でなくサブクエリか】D1 の batch() は文間で結果を受け渡せない(①の
		// RETURNING 値を②の bind に使えない)。batch は1トランザクションとして文順に実行される
		// (D1 docs: "executed sequentially and atomically")ので、②のサブクエリは①適用後の値を
		// 必ず読む — これが D1 で成立する唯一のアトミック採番。
		const statements = this.bumpAndLogStatements(owner, id, resource.uri, change.kind, precondition);
		// ③ オブジェクト書き込み。precondition ごとに文を変える(ports の ResourceWritePrecondition
		// コメント参照)。
		if (precondition.kind === "match") {
			// S-B: etag CAS 更新。UPSERT ではなく UPDATE ... WHERE etag = :expected にすることで、
			// 「lookup 時に読んだ etag のままのときだけ」書く(= 同一リソースの TOCTOU を閉じる)。
			// UPDATE を使う理由: match 経路は必ず既存行を更新するので INSERT 分岐は不要で、
			// WHERE に etag 条件を素直に書けて 0 行判定が明快になる(UPSERT だと row 不在時に
			// INSERT が走ってしまい etag ずれ検知にならない)。
			statements.push(
				this.db.prepare(
					`UPDATE calendar_objects
					 SET etag = ?, ics = ?, component_kind = ?, uid = ?, updated_at = ?,
					     first_occurrence = ?, last_occurrence = ?
					 WHERE owner = ? AND collection_id = ? AND uri = ? AND etag = ?`,
				).bind(
					resource.etag.hex, resource.rawIcs, resource.componentKind, resource.uid, Date.now(),
					bounds.firstMillis, bounds.lastMillis,
					owner, id, resource.uri, precondition.expectedEtag,
				),
			);
		} else if (precondition.kind === "create") {
			// S-B: 新規作成。素の INSERT(ON CONFLICT なし)。並行 create が先に入っていれば PK
			// 制約違反 → executeWriteBatch の catch で ConcurrencyConflictError(TOCTOU create を検知)。
			statements.push(
				this.db.prepare(
					`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).bind(
					owner, id, resource.uri, resource.etag.hex, resource.rawIcs, resource.componentKind, resource.uid, Date.now(),
					bounds.firstMillis, bounds.lastMillis,
				),
			);
		} else {
			// overwrite: 無条件上書き(unconditional / If-Match:*)。素の UPSERT で last-writer-wins。
			statements.push(
				this.db.prepare(
					`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(owner, collection_id, uri) DO UPDATE SET
					 etag=excluded.etag, ics=excluded.ics, component_kind=excluded.component_kind,
					 uid=excluded.uid, updated_at=excluded.updated_at,
					 first_occurrence=excluded.first_occurrence, last_occurrence=excluded.last_occurrence`,
				).bind(
					owner, id, resource.uri, resource.etag.hex, resource.rawIcs, resource.componentKind, resource.uid, Date.now(),
					bounds.firstMillis, bounds.lastMillis,
				),
			);
		}
		await this.executeWriteBatch(owner, id, statements, precondition.kind === "match");
	}

	async deleteResource(
		owner: PrincipalRef,
		id: CollectionId,
		uri: ResourceUri,
		collection: CalendarCollection,
		precondition: ResourceWritePrecondition,
	): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("deleteResource requires a recorded collection change");
		const statements = this.bumpAndLogStatements(owner, id, uri, change.kind, precondition);
		// ③ DELETE 本体。match(If-Match 付き削除)は etag 一致時のみ削除する CAS、
		// それ以外(overwrite)は無条件削除。create は削除では使わない(ports コメント)。
		if (precondition.kind === "match") {
			statements.push(
				this.db.prepare(
					"DELETE FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ? AND etag = ?",
				).bind(owner, id, uri, precondition.expectedEtag),
			);
		} else {
			statements.push(
				this.db.prepare(
					"DELETE FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
				).bind(owner, id, uri),
			);
		}
		await this.executeWriteBatch(owner, id, statements, precondition.kind === "match");
	}
}

export interface D1Repositories {
	principals: D1PrincipalRepository;
	collections: D1CalendarCollectionRepository;
	resources: D1CalendarObjectResourceRepository;
	uow: D1CollectionUnitOfWork;
}

export function createD1Repositories(db: D1Database): D1Repositories {
	return {
		principals: new D1PrincipalRepository(db),
		collections: new D1CalendarCollectionRepository(db),
		resources: new D1CalendarObjectResourceRepository(db),
		uow: new D1CollectionUnitOfWork(db),
	};
}
