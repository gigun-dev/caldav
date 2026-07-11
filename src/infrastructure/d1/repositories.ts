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
	principalPath,
	resourceUri,
	type CollectionId,
	type ComponentKind,
	type PrincipalPath,
	type PrincipalRef,
	type ResourceUri,
} from "../../domain/caldav";
import type { OccurrenceBounds } from "../../domain/ical/recurrence";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
	PrincipalRepository,
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
	if (!Array.isArray(parsed) || parsed.some((v) => v !== "VEVENT" && v !== "VTODO")) {
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
}

export class D1CollectionUnitOfWork implements CollectionUnitOfWork {
	constructor(private readonly db: D1Database) {}

	async saveResource(
		owner: PrincipalRef,
		id: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
		bounds: OccurrenceBounds,
	): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("saveResource requires a recorded collection change");
		await this.db.batch([
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
			this.db.prepare(
				"UPDATE calendar_collections SET sync_counter = ? WHERE owner = ? AND id = ?",
			).bind(collection.syncToken.counter, owner, id),
			this.db.prepare(
				"INSERT INTO sync_changes(owner, collection_id, token, uri, kind) VALUES (?, ?, ?, ?, ?)",
			).bind(owner, id, change.token.counter, change.uri, change.kind),
		]);
	}

	async deleteResource(owner: PrincipalRef, id: CollectionId, uri: ResourceUri, collection: CalendarCollection): Promise<void> {
		const change = collection.changes.at(-1);
		if (!change) throw new Error("deleteResource requires a recorded collection change");
		await this.db.batch([
			this.db.prepare(
				"DELETE FROM calendar_objects WHERE owner = ? AND collection_id = ? AND uri = ?",
			).bind(owner, id, uri),
			this.db.prepare(
				"UPDATE calendar_collections SET sync_counter = ? WHERE owner = ? AND id = ?",
			).bind(collection.syncToken.counter, owner, id),
			this.db.prepare(
				"INSERT INTO sync_changes(owner, collection_id, token, uri, kind) VALUES (?, ?, ?, ?, ?)",
			).bind(owner, id, change.token.counter, change.uri, change.kind),
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
