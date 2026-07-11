// =============================================================================
// テスト用フェイクリポジトリ実装
// =============================================================================
//
// テストで D1(Cloudflare) の代わりに使うインメモリ実装。
// フェイクは「実装の詳細を持たない最小限のシミュレーション」として作る方針:
//   - Map/Array でデータを保持
//   - 楽観ロックや CASCADE 削除などの挙動はポートの仕様に従い実装する
//   - 非同期を模倣するために `await` を使う(D1 は Promise を返すため)
//
// 【なぜモック(jest.fn 等)ではなくフェイクなのか】
// モックは「このメソッドが何回呼ばれたか」をアサートするが、ユースケースのテストで
// 確認したいのは「結果の状態が正しいか」という観点がほとんど。フェイクはその目的に合う。
// また、モックは実装の詳細(「何を呼んだか」)に依存するため、リファクタリングに脆い。
// =============================================================================

import {
	CalendarCollection,
	CalendarObjectResource,
	Principal,
	collectionId as mkCollectionId,
	resourceUri as mkResourceUri,
	principalPath,
} from "../../src/domain/caldav";
import type {
	CollectionId,
	PrincipalPath,
	PrincipalRef,
	ResourceUri,
	SyncChange,
} from "../../src/domain/caldav";
import type {
	PrincipalRepository,
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
} from "../../src/application/ports";
import type { ComponentKind } from "../../src/domain/caldav";
import { IcaljsRRuleIterator } from "../../src/infrastructure/recurrence/icaljs-rrule-iterator";
import type { OccurrenceBounds } from "../../src/domain/ical/recurrence";

// =============================================================================
// FakePrincipalRepository
// =============================================================================

export class FakePrincipalRepository implements PrincipalRepository {
	// principalPath → Principal のインメモリストア。
	private readonly store = new Map<string, Principal>();

	async findByPath(path: PrincipalPath): Promise<Principal | null> {
		return this.store.get(path) ?? null;
	}

	async save(principal: Principal): Promise<void> {
		this.store.set(principal.principalPath, principal);
	}

	/** テストセットアップ用: プリンシパルを直接挿入する。 */
	seed(principal: Principal): void {
		this.store.set(principal.principalPath, principal);
	}

	/** 現在のストア状態を確認するためのアクセサ(テスト専用)。 */
	all(): Principal[] {
		return [...this.store.values()];
	}
}

// =============================================================================
// FakeCalendarCollectionRepository
// =============================================================================

/** コレクションのキー: `${owner}::${collectionId}` */
function collectionKey(owner: PrincipalRef, id: CollectionId): string {
	return `${owner}::${id}`;
}

export class FakeCalendarCollectionRepository implements CalendarCollectionRepository {
	private readonly store = new Map<string, CalendarCollection>();

	async findAllByOwner(owner: PrincipalRef): Promise<CalendarCollection[]> {
		return [...this.store.values()].filter((c) => c.owner === owner);
	}

	async findById(owner: PrincipalRef, id: CollectionId): Promise<CalendarCollection | null> {
		return this.store.get(collectionKey(owner, id)) ?? null;
	}

	async save(collection: CalendarCollection): Promise<void> {
		this.store.set(collectionKey(collection.owner, collection.id), collection);
	}

	async delete(owner: PrincipalRef, id: CollectionId): Promise<void> {
		this.store.delete(collectionKey(owner, id));
	}

	/** テストセットアップ用: コレクションを直接挿入する。 */
	seed(collection: CalendarCollection): void {
		this.store.set(collectionKey(collection.owner, collection.id), collection);
	}
}

// =============================================================================
// FakeCalendarObjectResourceRepository
// =============================================================================

/** リソースのキー: `${owner}::${collectionId}::${uri}` */
function resourceKey(owner: PrincipalRef, collectionId: CollectionId, uri: ResourceUri): string {
	return `${owner}::${collectionId}::${uri}`;
}

export class FakeCalendarObjectResourceRepository implements CalendarObjectResourceRepository {
	private readonly store = new Map<string, CalendarObjectResource>();
	// G-3: PUT 経由(FakeCollectionUnitOfWork.saveResource)で計算された bounds を、D1 の
	// first_occurrence/last_occurrence 列の代わりにインメモリで保持する。
	// findInCollectionByTimeRange のテスト用フェイク実装が参照する。
	private readonly boundsStore = new Map<string, OccurrenceBounds>();

	async findAllInCollection(
		owner: PrincipalRef,
		collectionId: CollectionId,
	): Promise<CalendarObjectResource[]> {
		const prefix = `${owner}::${collectionId}::`;
		return [...this.store.entries()]
			.filter(([k]) => k.startsWith(prefix))
			.map(([, v]) => v);
	}

	async findByUri(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uri: ResourceUri,
	): Promise<CalendarObjectResource | null> {
		return this.store.get(resourceKey(owner, collectionId, uri)) ?? null;
	}

	async findManyByUri(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uris: ResourceUri[],
	): Promise<CalendarObjectResource[]> {
		return uris
			.map((u) => this.store.get(resourceKey(owner, collectionId, u)))
			.filter((r): r is CalendarObjectResource => r !== undefined);
	}

	async findUriByUid(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uid: string,
	): Promise<ResourceUri | null> {
		const prefix = `${owner}::${collectionId}::`;
		for (const [k, r] of this.store) {
			if (k.startsWith(prefix) && r.uid === uid) {
				return r.uri;
			}
		}
		return null;
	}

	async getUidAtUri(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uri: ResourceUri,
	): Promise<string | null> {
		return this.store.get(resourceKey(owner, collectionId, uri))?.uid ?? null;
	}

	/** テストセットアップ用: リソースを直接挿入する。bounds を省略すると null/null(未索引)。 */
	seed(
		owner: PrincipalRef,
		collectionId: CollectionId,
		resource: CalendarObjectResource,
		bounds: OccurrenceBounds = { firstMillis: null, lastMillis: null },
	): void {
		const key = resourceKey(owner, collectionId, resource.uri);
		this.store.set(key, resource);
		this.boundsStore.set(key, bounds);
	}

	/**
	 * G-3: calendar-query REPORT ユースケースのテスト用フェイク実装。
	 * D1 実装の WHERE 句(NULL は常に候補に含める)と同じ判定をインメモリで再現する。
	 */
	async findInCollectionByTimeRange(
		owner: PrincipalRef,
		collectionId: CollectionId,
		componentKind: ComponentKind,
		rangeStartMillis: number,
		rangeEndMillis: number,
	): Promise<CalendarObjectResource[]> {
		const prefix = `${owner}::${collectionId}::`;
		const result: CalendarObjectResource[] = [];
		for (const [k, r] of this.store) {
			if (!k.startsWith(prefix)) continue;
			if (r.componentKind !== componentKind) continue;
			const bounds = this.boundsStore.get(k) ?? { firstMillis: null, lastMillis: null };
			const lastOk = bounds.lastMillis === null || bounds.lastMillis > rangeStartMillis;
			const firstOk = bounds.firstMillis === null || bounds.firstMillis < rangeEndMillis;
			if (lastOk && firstOk) result.push(r);
		}
		return result;
	}

	/** テスト検証用: 保存されている bounds を直接読む。 */
	boundsOf(owner: PrincipalRef, collectionId: CollectionId, uri: ResourceUri): OccurrenceBounds | undefined {
		return this.boundsStore.get(resourceKey(owner, collectionId, uri));
	}

	/** 指定キーのリソースを削除する(UoW 実装から呼ばれる)。 */
	remove(owner: PrincipalRef, collectionId: CollectionId, uri: ResourceUri): void {
		this.store.delete(resourceKey(owner, collectionId, uri));
	}

	/** 全リソース数(テスト検証用)。 */
	count(): number {
		return this.store.size;
	}
}

// =============================================================================
// FakeCollectionUnitOfWork
// =============================================================================

/**
 * フェイク UoW。リソースリポジトリとコレクションリポジトリを両方更新する。
 * D1 バッチのような「原子性」はインメモリでは模倣しないが、
 * 「更新の副作用(両方のストアが変わる)」は再現する。
 */
export class FakeCollectionUnitOfWork implements CollectionUnitOfWork {
	constructor(
		private readonly resourceRepo: FakeCalendarObjectResourceRepository,
		private readonly collectionRepo: FakeCalendarCollectionRepository,
	) {}

	async saveResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		resource: CalendarObjectResource,
		collection: CalendarCollection,
		bounds: OccurrenceBounds,
	): Promise<void> {
		// リソースを保存(bounds も一緒に。D1 実装が同一行へ書くのと同じ扱い)。
		this.resourceRepo.seed(owner, collectionId, resource, bounds);
		// コレクション(syncCounter / changeLog 更新済みのはず)を保存。
		this.collectionRepo.seed(collection);
	}

	async deleteResource(
		owner: PrincipalRef,
		collectionId: CollectionId,
		uri: ResourceUri,
		collection: CalendarCollection,
	): Promise<void> {
		// リソースを削除。
		this.resourceRepo.remove(owner, collectionId, uri);
		// コレクションを保存。
		this.collectionRepo.seed(collection);
	}
}

// =============================================================================
// テストフィクスチャ生成ヘルパー
// =============================================================================

// G-3: PutCalendarObject / CalendarQuery が RRULE 展開に使う RecurrenceIterator port の
// 実装。ここでも本物の ical.js アダプタを使う(port 自体はテスト対象外で、フェイクにする
// 意味が薄い — expansion.test.ts と同じ判断)。
export const TEST_RECURRENCE_ITERATOR = new IcaljsRRuleIterator();

/** テスト用のデフォルトオーナー。 */
export const TEST_OWNER = principalPath("/principals/users/test/") as PrincipalRef;

/** テスト用のデフォルトコレクション ID。 */
export const TEST_COLLECTION_ID = mkCollectionId("calendar");

/** テスト用の最小限 ICS(VEVENT 1件)。uid は引数で変更可能。 */
export function makeVEventIcs(uid = "test-uid-001", summary = "Test Event"): string {
	// CRLF は RFC 5545 §3.1 必須。bun test 環境でも CRLF で組む。
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		"DTSTART:20260710T100000Z",
		"DTEND:20260710T110000Z",
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

/** テスト用の最小限 ICS(VTODO 1件)。 */
export function makeVTodoIcs(uid = "test-todo-001", summary = "Test Todo"): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

/** テスト用の最小限 ICS(VJOURNAL 1件)。J-1: 方向性 J のユースケーステスト用。 */
export function makeVJournalIcs(uid = "test-journal-001", summary = "Test Journal"): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VJOURNAL",
		`UID:${uid}`,
		"DTSTAMP:20260101T000000Z",
		`SUMMARY:${summary}`,
		"END:VJOURNAL",
		"END:VCALENDAR",
	].join("\r\n");
}

/** テスト用のデフォルトコレクションを作成して返す。J-1: supportedComponents に VJOURNAL も
 *  指定できるよう ComponentKind 全体を受け付ける(旧シグネチャは VEVENT|VTODO のみだった)。 */
export function makeTestCollection(
	owner: PrincipalRef = TEST_OWNER,
	id: string = "calendar",
	opts: { supportedComponents?: readonly ComponentKind[]; displayName?: string } = {},
): CalendarCollection {
	return new CalendarCollection({
		id: mkCollectionId(id),
		owner,
		displayName: opts.displayName ?? "Test Calendar",
		supportedComponents: opts.supportedComponents,
	});
}

/** テスト用プリンシパル。 */
export function makeTestPrincipal(path = "/principals/users/test/"): Principal {
	return Principal.create(path, `/calendars/${path.split("/").filter(Boolean).pop()}/`);
}
