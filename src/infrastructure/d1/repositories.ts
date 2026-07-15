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
}

export class D1CollectionUnitOfWork implements CollectionUnitOfWork {
	constructor(private readonly db: D1Database) {}

	/**
	 * R-7: CAS (Compare-And-Swap) 化された saveResource/deleteResource が共有する batch 実行
	 * ヘルパー。3文構成(①CAS UPDATE → ②sync_changes INSERT → ③object 側の書き込み)の後半
	 * 2文は呼び出し側が組み立て、ここでは実行と結果判定だけを共通化する。
	 *
	 * 【①の meta.changes === 0 判定を先頭に固定する理由】
	 * ports/index.ts の ConcurrencyConflictError コメントに書いたとおり、①が空振り(0行更新)
	 * したら②③は「baseline が古いまま書かれた」ことになるので、そもそも実行結果を信用しては
	 * いけない。batch() は全文を1トランザクションとして実行するので、①が0行でも②③の SQL 文
	 * 自体は(ガード条件次第で)空振りするか無害な形で走るが、その結果を UoW の成功として
	 * 呼び出し元へ返してしまうと「実は競合していたのに 204/201 を返す」事故になる。よって
	 * batch 結果の先頭要素だけを見て、0行なら即 throw する。
	 *
	 * 【②の PK 制約違反(sync_changes の重複 token)も同じエラーへ正規化する理由】
	 * ①のガード(WHERE sync_counter = :baseline)と②の PK((owner, collection_id, token))は、
	 * 同じ「baseline が古い」という事象を検知する二重の砦になっている。理論上は①が必ず先に
	 * 空振りするはずだが、D1 の batch は複数文を1トランザクションで実行するため「①は通ったが
	 * ②で PK 衝突する」という順序は起こらない設計だとしても、SQLite の制約チェックタイミングや
	 * 将来の実装変更に対して余計な前提を置きたくない。①のガードだけに頼らず、②由来の
	 * 制約違反例外も catch して同じ ConcurrencyConflictError に倒しておくことで、
	 * 「①②のどちらが先に競合を捕まえても呼び出し元の見え方は同じ」という不変条件を保つ。
	 */
	private async executeCasBatch(
		owner: PrincipalRef,
		id: CollectionId,
		statements: D1PreparedStatement[],
	): Promise<void> {
		let results: D1Result[];
		try {
			results = await this.db.batch(statements);
		} catch {
			// 2026-07-15 R-7: sync_changes の PK (owner, collection_id, token) 制約違反は
			// D1/SQLite が例外として投げる(batch 全体が reject される)。この PK は「同じ baseline
			// から2つのリクエストが同時に N+1 を書こうとした」ときの第二の砦(以前はこの
			// constraint error がそのまま呼び出し元まで伝播し、presentation 層で拾われず
			// 生の 500 になっていた — R-7 タスクの背景で説明した「偶発的な砦」の正体)。
			// ここで捕まえて意図した ConcurrencyConflictError に正規化する。
			throw new ConcurrencyConflictError(owner, id);
		}
		// ①(先頭の CAS UPDATE)が0行 = baseline がすでに動いていた = 競合。
		const casResult = results[0];
		if (casResult?.meta.changes === 0) {
			throw new ConcurrencyConflictError(owner, id);
		}
	}

	async saveResource(
		owner: PrincipalRef,
		id: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
		bounds: OccurrenceBounds,
	): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("saveResource requires a recorded collection change");
		const newCounter = collection.syncToken.counter;
		const baselineCounter = collection.baselineSyncCounter.counter;
		await this.executeCasBatch(owner, id, [
			// ① CAS 本体: baseline(hydrate 時に読んだ値)のときだけ new へ進める。
			this.db.prepare(
				"UPDATE calendar_collections SET sync_counter = ? WHERE owner = ? AND id = ? AND sync_counter = ?",
			).bind(newCounter, owner, id, baselineCounter),
			// ② 変更ログ。PK (owner, collection_id, token) が第二の砦(executeCasBatch のコメント参照)。
			this.db.prepare(
				"INSERT INTO sync_changes(owner, collection_id, token, uri, kind) VALUES (?, ?, ?, ?, ?)",
			).bind(owner, id, change.token.counter, change.uri, change.kind),
			// ③ オブジェクト upsert。①が空振り(=競合)だったときに書き込みが混入しないよう、
			// サブクエリで「①が成功して sync_counter が new になっている」ことを再確認してから
			// 実行する(SQLite の batch は複数文を条件分岐できないため、この自己参照 WHERE で
			// ①の成否を③の実行条件へ橋渡しする — ports/index.ts の UoW コメント③参照)。
			// INSERT ... SELECT ... ON CONFLICT は SQLite 3.24+ の UPSERT 構文がそのまま使える
			// (VALUES 由来か SELECT 由来かを問わない)。
			this.db.prepare(
				`INSERT INTO calendar_objects(owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE (SELECT sync_counter FROM calendar_collections WHERE owner = ? AND id = ?) = ?
				 ON CONFLICT(owner, collection_id, uri) DO UPDATE SET
				 etag=excluded.etag, ics=excluded.ics, component_kind=excluded.component_kind,
				 uid=excluded.uid, updated_at=excluded.updated_at,
				 first_occurrence=excluded.first_occurrence, last_occurrence=excluded.last_occurrence`,
			).bind(
				owner, id, resource.uri, resource.etag.hex, resource.rawIcs, resource.componentKind, resource.uid, Date.now(),
				bounds.firstMillis, bounds.lastMillis,
				owner, id, newCounter,
			),
		]);
	}

	async deleteResource(owner: PrincipalRef, id: CollectionId, uri: ResourceUri, collection: CalendarCollection): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("deleteResource requires a recorded collection change");
		const newCounter = collection.syncToken.counter;
		const baselineCounter = collection.baselineSyncCounter.counter;
		await this.executeCasBatch(owner, id, [
			// ① CAS 本体(saveResource と同じ)。
			this.db.prepare(
				"UPDATE calendar_collections SET sync_counter = ? WHERE owner = ? AND id = ? AND sync_counter = ?",
			).bind(newCounter, owner, id, baselineCounter),
			// ② 変更ログ。
			this.db.prepare(
				"INSERT INTO sync_changes(owner, collection_id, token, uri, kind) VALUES (?, ?, ?, ?, ?)",
			).bind(owner, id, change.token.counter, change.uri, change.kind),
			// ③ DELETE 側のガードも同じ自己参照サブクエリで①の成否を確認する。
			this.db.prepare(
				`DELETE FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?
				 AND (SELECT sync_counter FROM calendar_collections WHERE owner = ? AND id = ?) = ?`,
			).bind(owner, id, uri, owner, id, newCounter),
		]);
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
