// =============================================================================
// PutCalendarObject ユースケース — RFC 4791 §5.3.2 PUT
// =============================================================================
//
// 【このユースケースが担う範囲】
// カレンダーオブジェクトリソース(VEVENT/VTODO を含む ICS)を PUT(新規作成 or 更新)する。
// HTTP の If-None-Match:* / If-Match ヘッダに相当する楽観ロック条件は、プロトコル非依存な
// 形で ETagCondition として受け取る(DAV/HTTP ヘッダの parse は presentation 層の仕事)。
//
// 【precondition の判定は domain 層に委ねる】
// checkPutPreconditions(domain サービス)を呼んで violations を収集し、あれば
// PreconditionError を throw することで presentation 層が 412/403/409 へマッピングできる。
//
// 【DAV に依存しない】
// 入力 DTO に HTTP ヘッダ・XML 要素名等は一切含まない。このユースケースは将来 MCP ツール
// ("create_event") から呼ばれても成立する設計にする。
// =============================================================================

import {
	CalendarObjectResource,
	CalendarCollection,
	checkPutPreconditions,
	PreconditionViolation,
	UNLIMITED_POLICY,
	type PutPreconditionInput,
	type ServerPolicy,
	resourceUri,
	// firstUid は domain/caldav の内部ヘルパーで公開 API には含まれていないため、
	// application 層では ICalendarObject のレンズ経由(events()[0]?.uid 等)で UID を取得する。
} from "../../domain/caldav";
import type { ETag } from "../../domain/caldav";
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import type {
	CalendarCollectionRepository,
	CalendarObjectResourceRepository,
	CollectionUnitOfWork,
} from "../ports";
// G-3: PUT 時に first/last occurrence 索引(bounds)を計算する。RecurrenceIterator は
// RRULE 反復だけを domain の外へ委譲する port(実装は infrastructure/recurrence の
// ical.js アダプタ)なので、application 層はここでも port 型にしか依存しない。
import {
	computeOccurrenceBounds,
	zoneResolverFor,
	type OccurrenceBounds,
	type RecurrenceIterator,
} from "../../domain/ical/recurrence";

// 有限反復(COUNT/UNTIL 付き RRULE)の展開を PUT のたびに行う際の occurrence 数上限。
// Radicale の rrule 展開上限(実運用で問題にならない値として先例がある)に倣った暫定値。
// 将来「サーバーポリシーとして可変にする」なら ServerPolicy(put-preconditions.ts)へ
// 昇格させる。今はリテラルのまま置く(YAGNI — 可変にする実需がまだ無い)。
const OCCURRENCE_INDEX_MAX_OCCURRENCES = 3000;

// =============================================================================
// 入力 DTO
// =============================================================================

/**
 * ETag に基づく楽観ロック条件。HTTP の If-None-Match / If-Match を抽象化したもの。
 *
 * - { kind: "must-not-exist" }: If-None-Match:* に相当。新規作成専用。すでに存在すれば 412。
 * - { kind: "must-match"; etag: string }: If-Match:"<etag>" に相当。更新専用。ETag が一致しなければ 412。
 * - { kind: "unconditional" }: 条件なし(If-None-Match / If-Match なし)。常に上書きする。
 *
 * 【なぜ型で分けるのか】
 * "unconditional" は iOS のリソース削除後の再作成など特殊なケースで使われる。
 * must-not-exist と must-match を混同すると重大な競合バグになるため、判別可能ユニオンで型安全を確保。
 */
export type ETagCondition =
	| { kind: "must-not-exist" }
	| { kind: "must-match"; etag: string }
	| { kind: "unconditional" };

/** PutCalendarObject の入力。 */
export interface PutCalendarObjectInput {
	/** コレクションのオーナー(プリンシパル)。 */
	owner: PrincipalRef;
	/** 保存先コレクション ID。 */
	collectionId: CollectionId;
	/** 保存先リソースの URI(コレクション内の名前。例 "event-uuid.ics")。 */
	resourceUri: string;
	/** PUT 本文(ICS 文字列)。 */
	ics: string;
	/** ETag に基づく楽観ロック条件。省略時は unconditional。 */
	condition?: ETagCondition;
	/** サーバーポリシー(max-resource-size 等)。省略時は無制限。 */
	policy?: ServerPolicy;
}

// =============================================================================
// 出力 DTO
// =============================================================================

/** PutCalendarObject の成功結果。 */
export interface PutCalendarObjectOutput {
	/** 保存されたリソースの新しい ETag。PUT 応答の ETag ヘッダ値として使う。 */
	etag: ETag;
	/** 作成か更新かを示す。presentation 層が 201 / 204 を選ぶために使う。 */
	created: boolean;
}

// =============================================================================
// エラー型
// =============================================================================

/**
 * ETag 条件不一致エラー。
 * - HTTP: 412 Precondition Failed
 *
 * 【なぜ PreconditionError と分けるのか】
 * CalDAV の precondition(valid-calendar-data 等)は DAV:error XML で返す必要があるが、
 * ETag 条件不一致は通常の HTTP 412 で良く、DAV:error は不要なため別型にする。
 */
export class ETagConditionError extends Error {
	readonly kind = "ETagConditionError" as const;
	constructor(
		readonly condition: ETagCondition,
		/** 現在の ETag(存在する場合)。 */
		readonly currentETag: ETag | null,
	) {
		super(
			condition.kind === "must-not-exist"
				? "Resource already exists (If-None-Match: * failed)"
				: `ETag mismatch: expected "${(condition as { kind: "must-match"; etag: string }).etag}"`,
		);
		this.name = "ETagConditionError";
	}
}

/**
 * CalDAV precondition 違反エラー。
 * - HTTP: 403 (supported-calendar-data 等) または 409 (no-uid-conflict)
 * - 応答: DAV:error 要素に violations を列挙
 *
 * violations を配列で持つのは、複数の precondition 違反を一度にクライアントへ伝えるため
 * (checkPutPreconditions が「全違反収集」方式なので、ここでも全件を保持する)。
 */
export class CalDAVPreconditionError extends Error {
	readonly kind = "CalDAVPreconditionError" as const;
	constructor(readonly violations: PreconditionViolation[]) {
		super(`CalDAV precondition failed: ${violations.map((v) => v.toString()).join(", ")}`);
		this.name = "CalDAVPreconditionError";
	}
}

/**
 * コレクションが見つからないエラー。
 * - HTTP: 409 Conflict (RFC 4918 §9.7: 親コレクションが無い状態への PUT は 409)
 */
export class CollectionNotFoundError extends Error {
	readonly kind = "CollectionNotFoundError" as const;
	constructor(readonly collectionId: CollectionId) {
		super(`Calendar collection not found: ${collectionId}`);
		this.name = "CollectionNotFoundError";
	}
}

/** PutCalendarObject が throw しうるエラーの型ユニオン。presentation 層のマッピング用。 */
export type PutCalendarObjectError =
	| ETagConditionError
	| CalDAVPreconditionError
	| CollectionNotFoundError;

// =============================================================================
// ユースケース本体
// =============================================================================

/**
 * PutCalendarObject ユースケース。
 *
 * 依存するポートを constructor injection で受け取る(DI。テストではフェイクを渡す)。
 *
 * 【処理フロー】
 * 1. コレクションの存在確認
 * 2. ETag 条件チェック(楽観ロック)
 * 3. CalDAV precondition チェック(domain サービス委譲)
 * 4. リソース構築 + 保存(UoW)+ コレクション変更ログ更新
 */
export class PutCalendarObject {
	constructor(
		private readonly collectionRepo: CalendarCollectionRepository,
		private readonly resourceRepo: CalendarObjectResourceRepository,
		private readonly uow: CollectionUnitOfWork,
		// G-3: occurrence bounds 計算用の RRULE 反復 port。DI で注入する(テストはフェイクを渡す)。
		private readonly recurrenceIterator: RecurrenceIterator,
	) {}

	async execute(input: PutCalendarObjectInput): Promise<PutCalendarObjectOutput> {
		// --- 識別子の VO 化 ---
		// presentation 層から来た生文字列を domain の branded type に変換。
		// 不正な URI 文字列(空・スペース含む等)はここで例外になる。
		const uri = resourceUri(input.resourceUri);
		const condition = input.condition ?? { kind: "unconditional" };

		// --- Step 1: コレクションの存在確認 ---
		// RFC 4791 §5.3.2: カレンダーコレクションが存在しなければ PUT は 409 になる。
		// コレクション自体のメタデータ(supportedComponents)は precondition 判定にも必要。
		const collection = await this.collectionRepo.findById(input.owner, input.collectionId);
		if (!collection) {
			throw new CollectionNotFoundError(input.collectionId);
		}

		// --- Step 2: 現在のリソース状態を取得(ETag 条件検証 + UID 変更検出に必要) ---
		const existing = await this.resourceRepo.findByUri(input.owner, input.collectionId, uri);

		// --- Step 3: ETag 条件チェック(楽観ロック) ---
		// RFC 7232 §6: If-None-Match:* は「存在しないこと」が条件。
		//              If-Match:"<etag>" は「ETag が一致すること」が条件。
		if (condition.kind === "must-not-exist" && existing !== null) {
			throw new ETagConditionError(condition, existing.etag);
		}
		if (condition.kind === "must-match") {
			if (existing === null || !existing.etag.equals(
				// 文字列で来た ETag を VO に変換して比較。
				// 不正な形式の ETag は ETag.fromHex が例外を投げるが、presentation 層が
				// HTTP ヘッダ形式(引用符あり)を除去してから渡す設計のため、ここでは生 hex が来る想定。
				(await import("../../domain/caldav")).ETag.fromHex(condition.etag.replace(/^"|"$/g, ""))
			)) {
				throw new ETagConditionError(condition, existing?.etag ?? null);
			}
		}

		// --- Step 4: CalDAV precondition チェック(domain サービス委譲) ---
		// RFC 4791 §5.3.2.1 の precondition 群を checkPutPreconditions に委ねる。
		// findUidOwner/existingUidAt はコールバックとして渡し、domain が DB 知識を持たないようにする
		// (put-preconditions.ts の冒頭コメント「関数注入」の方針)。
		const preconditionInput: PutPreconditionInput = {
			ics: input.ics,
			targetUri: uri,
			supportedComponents: collection.supportedComponents,
			policy: input.policy ?? UNLIMITED_POLICY,
			findUidOwner: (uid: string) => {
				// 同期的コールバック — ポートの非同期が使えない。
				// そのため Step 2 の「コレクション全件」情報を事前に取得することが理想だが、
				// checkPutPreconditions はシンクロナスコールバックを要求する設計(domain 層を async
				// にしたくなかった理由: domain は副作用を持たない純粋関数が望ましい)。
				// よって findUriByUid は precondition チェック前に別途クエリする。
				// （この値は Step 4a で事前に取得済み: _uidOwner 変数参照）
				return _uidOwner ?? undefined;
			},
			existingUidAt: (_uri) => {
				// 同様に、既存リソースの UID は Step 2 の existing から取得済み。
				return existing?.uid ?? undefined;
			},
		};

		// 事前クエリ: 同 UID を持つ他リソースの URI を取得(findUidOwner コールバック用)。
		// ICS から UID を取れるのは parse 後なので、checkPutPreconditions 内で UID が判明した後に
		// コールバックが呼ばれる。このクエリは precondition チェック前に実施するため、
		// まず ICS を軽く parse して UID を取り出す必要があるが、それは domain の仕事。
		// ここでは「checkPutPreconditions が UID を判明させた後にコールバックを呼ぶ」タイミングで
		// DB クエリを実行したい — しかしシンクロナスコールバックでは非同期 DB クエリが使えない。
		//
		// 【解決策】UID を事前に特定する2段階アプローチ:
		//   1. domain の parse を呼んで UID を先に取り出す(重複 parse になるが許容する)
		//   2. そのUID で findUriByUid を事前クエリ
		//   3. 結果をクロージャ変数 _uidOwner に持たせる
		// これにより「コールバックが呼ばれたとき = DB クエリ結果はすでにある」状態を作る。
		let _uidOwner: ResourceUri | null = null;
		try {
			// parse を先行実行して UID を取り出す。parse 失敗は checkPutPreconditions でも検出されるので、
			// ここの例外は無視して precondition チェックに任せる。
			// ICalendarObject には .uid アクセサが無い(集約は Component のレンズであり UID は
			// サブコンポーネントの属性)ため、VCALENDAR 直下の非 VTIMEZONE コンポーネントから
			// UID プロパティを素直に拾う。VTIMEZONE を除く最初の主コンポーネントの UID を見る。
			const { parse, ICalendarObject } = await import("../../domain/ical");
			const component = parse(input.ics);
			const obj = ICalendarObject.fromComponent(component);
			// VTIMEZONE 以外の最初のサブコンポーネントの UID プロパティ値を取得。
			const primaryComp = obj.raw.components.find((c) => c.name !== "VTIMEZONE");
			const uid = primaryComp?.properties.find((p) => p.name === "UID")?.value;
			if (uid) {
				_uidOwner = await this.resourceRepo.findUriByUid(input.owner, input.collectionId, uid);
			}
		} catch {
			// parse 失敗 = valid-calendar-data 違反。checkPutPreconditions が検出する。
		}

		const violations = checkPutPreconditions(preconditionInput);
		if (violations.length > 0) {
			throw new CalDAVPreconditionError(violations);
		}

		// --- Step 5: リソース構築 ---
		// CalendarObjectResource.fromIcs は precondition 通過後に呼ぶ(事前に checkPutPreconditions
		// で妥当性を保証済みなので InvalidResourceError は発生しないはず。念のため伝播させる)。
		const resource = await CalendarObjectResource.fromIcs(uri, input.ics);

		// --- Step 5b: G-3 occurrence bounds(first/last)を計算 -----------------------
		// マスター(RECURRENCE-ID 無し)/ オーバーライド(RECURRENCE-ID 有り)を分離して
		// computeOccurrenceBounds へ渡す。VEVENT はオーバーライドを持ちうるが VTODO/VJOURNAL は
		// この設計では持たない(反復 VTODO/VJOURNAL の展開自体を G-3/J-1 のスコープ外にしている)。
		// zoneOf は resource.payload(この PUT で保存する ICS 自身の VTIMEZONE)から組み立てる
		// — floating の解決ゾーンは PUT 時点で UTC 固定(確定設計メモ)。
		const zoneOf = zoneResolverFor(resource.payload);
		let bounds: OccurrenceBounds;
		if (resource.componentKind === "VEVENT") {
			const events = resource.payload.events();
			const master = events.find((e) => e.recurrenceId === undefined);
			const overrides = events.filter((e) => e.recurrenceId !== undefined);
			// master が無い(=検証をすり抜けた壊れたデータ)場合は索引を諦めて null/null。
			// computeOccurrenceBounds 自体も内部失敗を null/null で吸収するが、
			// master 不在はその入力を構築できない時点の話なのでここで先に弾く。
			bounds = master === undefined
				? { firstMillis: null, lastMillis: null }
				: computeOccurrenceBounds(
					this.recurrenceIterator,
					{ componentKind: "VEVENT", master, overrides },
					{ zoneOf, maxOccurrences: OCCURRENCE_INDEX_MAX_OCCURRENCES },
				);
		} else if (resource.componentKind === "VJOURNAL") {
			// J-1: VJOURNAL のオーバーライドは events 相当のものが journals() から取れる
			// (VEVENT と同じ「同一 UID・RECURRENCE-ID の有無でマスター/オーバーライドを分離」の
			// 形だが、VJOURNAL は展開しないので overrides は bounds 計算には使わない — VTODO と同様
			// master 単体だけを見る。それでも journals() から拾う理由は「将来 J-4 で反復展開を
			// 足すときにこの分離ロジックをそのまま使い回せるように」という設計の前振り)。
			const master = resource.payload.journals().find((j) => j.recurrenceId === undefined);
			bounds = master === undefined
				? { firstMillis: null, lastMillis: null }
				: computeOccurrenceBounds(
					this.recurrenceIterator,
					{ componentKind: "VJOURNAL", master, overrides: [] },
					{ zoneOf, maxOccurrences: OCCURRENCE_INDEX_MAX_OCCURRENCES },
				);
		} else {
			const master = resource.payload.todos()[0];
			bounds = master === undefined
				? { firstMillis: null, lastMillis: null }
				: computeOccurrenceBounds(
					this.recurrenceIterator,
					{ componentKind: "VTODO", master, overrides: [] },
					{ zoneOf, maxOccurrences: OCCURRENCE_INDEX_MAX_OCCURRENCES },
				);
		}

		// --- Step 6: コレクションの変更ログ更新 + 原子的保存(UoW) ---
		// recordChange でコレクションの状態を進め、その状態を UoW に渡して原子的に書く。
		const changeKind = existing === null ? "created" : "modified";
		collection.recordChange(uri, changeKind);
		await this.uow.saveResource(input.owner, input.collectionId, resource, collection, bounds);

		return {
			etag: resource.etag,
			created: existing === null,
		};
	}
}
