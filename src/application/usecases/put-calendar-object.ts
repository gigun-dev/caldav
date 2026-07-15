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
	ETag,
	SyncToken,
	type PutPreconditionInput,
	type ServerPolicy,
	resourceUri,
	// firstUid は domain/caldav の内部ヘルパーで公開 API には含まれていないため、
	// application 層では ICalendarObject のレンズ経由(events()[0]?.uid 等)で UID を取得する。
} from "../../domain/caldav";
// 2026-07-14 R-2: 以前は Step 3 の ETag 比較専用に `(await import("../../domain/caldav")).ETag`
// という動的 import を都度呼んでいた(理由の記載なし)。evaluateMustMatch を同期関数に
// できるよう ETag を上の value import に合流させ、type-only import は削除した。
import type { CollectionId, PrincipalRef, ResourceUri } from "../../domain/caldav";
import {
	ConcurrencyConflictError,
	type CalendarCollectionRepository,
	type CalendarObjectResourceRepository,
	type CollectionUnitOfWork,
	type ResourceWritePrecondition,
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
 * - { kind: "must-exist" }: If-Match:* に相当。RFC 7232 §3.1「field-value が "*" のとき、
 *   条件はオリジンサーバーが対象リソースの current representation を『持っていない』場合に
 *   false になる」— つまり ETag の値そのものは見ず「存在すること」だけが条件。存在すれば
 *   常に通す(既存 ETag との値比較はしない)。存在しなければ 412。
 * - { kind: "must-match"; etag: string }: If-Match:"<etag>"(カンマ区切りで複数可)に相当。
 *   更新専用。RFC 7232 §3.1 ABNF は `If-Match = "*" / 1#entity-tag` — "*" 以外は
 *   1個以上の entity-tag のリストで、リストのいずれか1つでも現在の ETag と一致すれば成立する
 *   (同節「the condition is false if none of the listed tags match」)。この etag フィールドは
 *   ヘッダの生の値(カンマ区切りかもしれない生文字列)をそのまま保持し、リスト分解と
 *   個々の比較は execute() 内(evaluateMustMatch)で行う。
 * - { kind: "unconditional" }: 条件なし(If-None-Match / If-Match なし)。常に上書きする。
 *
 * 【なぜ型で分けるのか】
 * "unconditional" は iOS のリソース削除後の再作成など特殊なケースで使われる。
 * must-not-exist と must-match を混同すると重大な競合バグになるため、判別可能ユニオンで型安全を確保。
 *
 * 【2026-07-14 バグ修正(R-2)】以前は If-Match: * が If-None-Match: * と非対称に扱われ
 * (presentation 層の rawEtagCondition が "*" 以外の if-match をすべて must-match の
 * etag 値として素通ししていた)、must-match の evaluateMustMatch に "*" がそのまま渡って
 * ETag.fromHex("*") が例外を投げ 500 になっていた。RFC 7232 §3.1 は If-Match: * を
 * 「リソースが存在すること」の条件と定義しており ETag 値比較ではないため、must-exist を
 * 独立した kind として切り出した。あわせてカンマ区切り複数 ETag(§3.1 の 1#entity-tag)にも
 * 対応した(以前は先頭の1個としか比較しない実装ですらなかった — if-match ヘッダ全体を
 * 1本の hex 文字列として fromHex に渡していたため、複数指定は必ず 500 になっていた)。
 */
export type ETagCondition =
	| { kind: "must-not-exist" }
	| { kind: "must-exist" }
	| { kind: "must-match"; etag: string }
	| { kind: "unconditional" };

/**
 * If-Match ヘッダの値(カンマ区切りで複数の entity-tag を許す。RFC 7232 §3.1 ABNF
 * `1#entity-tag`)を個々の候補文字列(quoted のまま)に分解する。
 *
 * 【delete-calendar-object.ts と共有する理由】DELETE の If-Match 評価でも全く同じ分解が
 * 要る。delete 側は既に CollectionNotFoundError をこのファイルから import している実績が
 * あり(同じ「2つの usecase が同じ小さな語彙を共有する」構図)、新規ファイルを立てるほどの
 * 分量でもないためここに集約してエクスポートする。
 *
 * 【厳密な ABNF パーサにしない判断】entity-tag は理論上 quoted-string(引用符内にカンマを
 * 含みうる)だが、このプロジェクトの ETag は SHA-256 hex 文字列のみ(etag.ts 参照)で
 * カンマを含む値を生成しない。よって単純なカンマ split で実務上十分(YAGNI — 他実装の
 * ETag と混在待受けする実需が出たら再検討)。
 */
export function splitEtagList(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * If-Match の候補リストの中に、現在の ETag と一致するものが1つでもあるかを判定する
 * (RFC 7232 §3.1: いずれか一致すれば条件成立)。
 *
 * 【弱い ETag(W/ プレフィックス)の扱い】RFC 7232 §3.1「An origin server MUST use the
 * strong comparison function when comparing entity-tags for If-Match」。弱い比較子付きの
 * 候補は強い比較(バイト同一性)では絶対に一致しないため、hex 化を試みず即座に不一致として
 * 扱う。iOS を含めこのプロジェクトで弱い ETag を送るクライアントは実質観測されていないが
 * (etag.ts 冒頭コメント参照)、来た場合に 500 落ちさせないための安全側の分岐として残す。
 *
 * 【不正 hex を 412 側へ倒す判断】壊れたクライアントが不正な形式の ETag を送ってきた場合、
 * ETag.fromHex は例外を投げる。ここで例外を伝播させると「壊れた If-Match で 500」という
 * R-2 で修正した元のバグと同種の事故を再発させるため、catch して「一致しない」= 412 に倒す
 * (500 より 412 の方がクライアントにとって解釈可能な応答)。
 */
function evaluateMustMatch(rawHeaderValue: string, existingETag: ETag): boolean {
	return splitEtagList(rawHeaderValue).some((candidate) => {
		if (candidate.startsWith("W/")) return false;
		const hex = candidate.replace(/^"|"$/g, "");
		try {
			return existingETag.equals(ETag.fromHex(hex));
		} catch {
			return false;
		}
	});
}

/**
 * `If` ヘッダに書かれた1つの DAV:sync-token State-token 条件。
 * presentation 層(if-header.ts の IfStateCondition)から生の token 文字列だけを
 * 受け取る(URI としての妥当性判定・カウンタ抽出は SyncToken.fromUri に委ねる — token の
 * 解釈は application/domain の仕事という層分担。RFC 原文の解釈も domain 層〈SyncToken〉に
 * 閉じ込めたい)。
 */
export interface SyncTokenIfCondition {
	negate: boolean;
	/** State-token の中身(`<` `>` を除いた Coded-URL 文字列)。 */
	token: string;
}

/**
 * RFC 6578 §5 の If ヘッダ sync-token precondition。
 * `groups` は OR-of-AND(RFC 4918 §10.4.3: 複数 List は OR、1 List 内の Condition は AND)。
 * presentation 層(if-header.ts の syncTokenListsFor)がすでに「このコレクションを指す
 * List だけ」に絞り込んだ結果を渡してくる想定。
 *
 * 【空配列の意味】`groups: []` は「If ヘッダにこのコレクション向けの sync-token 条件が
 * 無かった」= unconditional。usecase 側は無条件で処理を続ける(412 にしない)。
 */
export interface SyncTokenIfPrecondition {
	/** SyncToken.fromUri に渡す base(= コレクションの絶対 URL。sync-token URI 生成と同じ base)。 */
	base: string;
	groups: SyncTokenIfCondition[][];
}

/**
 * If ヘッダの sync-token precondition が「現在のコレクション状態に対して真」かどうかを判定する。
 *
 * 評価規則(RFC 4918 §10.4.3〜§10.4.4 に沿う):
 *   - 各 Condition は「token を fromUri で解釈でき、かつそのカウンタが現在の
 *     collectionSyncToken と一致する」なら true("Not" 付きなら反転)。
 *   - トークンが解釈不能(他サーバー由来・壊れた形式)な場合は「一致する状態token が
 *     このリソースに無い」として false 扱い(§10.4.4「Handling unmapped URLs: treat as
 *     if the URL identified a resource that exists but does not have the specified
 *     state」に倣う。sync-token は「コレクションの現在状態」という単一の state しか
 *     持たないので、それ以外はすべて「無い」)。
 *   - 1つの List(AND)は全 Condition が true のとき true。
 *   - groups(OR)はいずれか1つの List が true なら全体が true。
 *   - groups が空配列なら precondition なし = true(呼び出し側で早期リターンする想定だが、
 *     ここでも矛盾なく true を返す)。
 */
export function evaluateSyncTokenIfPrecondition(
	precondition: SyncTokenIfPrecondition,
	collectionSyncToken: SyncToken,
): boolean {
	if (precondition.groups.length === 0) return true;
	return precondition.groups.some((conditions) =>
		conditions.every((condition) => {
			const parsed = SyncToken.fromUri(precondition.base, condition.token);
			const matches = parsed.valid && parsed.token.equals(collectionSyncToken);
			return condition.negate ? !matches : matches;
		}),
	);
}

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
	/**
	 * `If` ヘッダの DAV:sync-token precondition(RFC 6578 §5)。省略 or groups 空配列で
	 * unconditional。
	 */
	ifSyncToken?: SyncTokenIfPrecondition;
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
				: condition.kind === "must-exist"
					? "Resource does not exist (If-Match: * failed)"
					: `ETag mismatch: expected "${(condition as { kind: "must-match"; etag: string }).etag}"`,
		);
		this.name = "ETagConditionError";
	}
}

/**
 * S-B (2026-07-16): 「同一リソースの書き込み競合」= update-event/update-todo が1回だけ
 * 自動 re-read→re-patch する対象かを判定する共通述語。
 *
 * 競合は2つの層のどちらでも捕まりうる(ports の ConcurrencyConflictError コメントの正規化):
 *   - ETagConditionError(condition=must-match): Step 3 のメモリ判定での早期弾き。
 *   - ConcurrencyConflictError: UoW の DB 側 ETag CAS(③の0行)。メモリ判定通過後の TOCTOU。
 * どちらも「lookup してから書くまでに同じリソースが動いた」ことを表し、意味的パッチの再適用で
 * 安全に解ける。must-not-exist / must-exist の ETagConditionError は「そもそも作れない/無い」
 * を表し再試行しても直らないのでリトライ対象にしない(condition.kind で絞る)。
 *
 * 【なぜ両 UC 共通の free 関数にするか】update-event と update-todo で完全に同じ判定なので、
 * 判別ロジックの二重管理を避けてここ(両エラー型が定義されている put-calendar-object)に集約する。
 * ConcurrencyConflictError は ports から import する(この関数のためだけの循環にはならない —
 * put-calendar-object は既に ports を型で参照している)。
 */
export function isSameResourceConflict(error: unknown): boolean {
	if (error instanceof ETagConditionError) return error.condition.kind === "must-match";
	return error instanceof ConcurrencyConflictError;
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

/**
 * `If` ヘッダの DAV:sync-token precondition 不一致エラー(RFC 6578 §5)。
 * - HTTP: 412 Precondition Failed(§5.2 の例のとおり)。
 *
 * 【なぜ ETagConditionError と分けるのか】どちらも 412 にマッピングされる点は同じだが、
 * 条件の主体が別(ETag = リソース、sync-token = コレクション)であり、エラーメッセージ・
 * デバッグ時の切り分けのために型を分ける(R-2 の ETagConditionError / CalDAVPreconditionError
 * の分離判断を踏襲)。
 */
export class SyncTokenIfConditionError extends Error {
	readonly kind = "SyncTokenIfConditionError" as const;
	constructor(readonly precondition: SyncTokenIfPrecondition) {
		super("If header DAV:sync-token precondition failed (collection has changed)");
		this.name = "SyncTokenIfConditionError";
	}
}

/** PutCalendarObject が throw しうるエラーの型ユニオン。presentation 層のマッピング用。 */
export type PutCalendarObjectError =
	| ETagConditionError
	| SyncTokenIfConditionError
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

		// --- Step 1b: `If` ヘッダの sync-token precondition チェック(RFC 6578 §5) ---
		// コレクションの現在 token(collection.syncToken)は Step 1 で取得済みの集約から取れる
		// ため、追加の D1 読みは発生しない(タスクの制約どおり)。groups が空(= このコレクションへの
		// sync-token 条件が If ヘッダに無かった)なら evaluateSyncTokenIfPrecondition は無条件で
		// true を返すので、ここでの分岐は「precondition ありのときだけ 412 の可能性がある」形になる。
		if (input.ifSyncToken && !evaluateSyncTokenIfPrecondition(input.ifSyncToken, collection.syncToken)) {
			throw new SyncTokenIfConditionError(input.ifSyncToken);
		}

		// --- Step 2: 現在のリソース状態を取得(ETag 条件検証 + UID 変更検出に必要) ---
		const existing = await this.resourceRepo.findByUri(input.owner, input.collectionId, uri);

		// --- Step 3: ETag 条件チェック(楽観ロック) ---
		// RFC 7232 §3.1/§3.2 に沿って3種の条件をそれぞれ評価する:
		//   - If-None-Match:*(must-not-exist)は「存在しないこと」が条件。
		//   - If-Match:*(must-exist)は「(ETag の値によらず)存在すること」が条件
		//     — §3.1「the condition is false if the origin server does not have a current
		//     representation for the target resource」。ETag 値の比較はしない。
		//   - If-Match:"<etag>"(must-match、カンマ区切りで複数可)は「候補のいずれか1つが
		//     現在の ETag と一致すること」が条件(§3.1)。
		if (condition.kind === "must-not-exist" && existing !== null) {
			throw new ETagConditionError(condition, existing.etag);
		}
		if (condition.kind === "must-exist" && existing === null) {
			// 2026-07-14 R-2 修正: 以前は If-Match: * が独立した kind を持たず must-match 側に
			// 丸められ、"*" を hex として ETag.fromHex に渡して例外 → 500 になっていた
			// (このファイル冒頭 ETagCondition コメント参照)。存在しない場合だけ 412、
			// 存在すれば下の分岐に触れず素通りする。
			throw new ETagConditionError(condition, null);
		}
		if (condition.kind === "must-match" && (existing === null || !evaluateMustMatch(condition.etag, existing.etag))) {
			throw new ETagConditionError(condition, existing?.etag ?? null);
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

		// S-B (2026-07-16): DB 側 ETag CAS の粒度(ResourceWritePrecondition)を Step 3 で
		// 判定した condition と existing から導出する。Step 3 のメモリ判定は「安価な早期弾き
		// (UX 上の即時 412)」、この DB 側 CAS は「lookup〜書き込みの TOCTOU 窓を閉じる最終
		// 防波堤」— 役割が違うので二重でも矛盾しない(ports の ConcurrencyConflictError コメント)。
		//   - must-match: 既存 etag(Step 3 通過 = existing 非 null かつ一致)で etag CAS 更新。
		//     expected は「今まさに一致を確認した etag」= existing.etag.hex。lookup 後に他者が
		//     書いていれば DB 側で etag がずれて 0 行 → ConcurrencyConflictError。
		//   - must-not-exist: 新規作成(create)。並行 create は PK 違反で弾く。
		//   - must-exist / unconditional: existing の有無で create か overwrite。overwrite は
		//     クライアントが無条件上書きを要求した経路なので etag CAS を掛けず last-writer-wins。
		const writePrecondition: ResourceWritePrecondition =
			condition.kind === "must-match"
				? { kind: "match", expectedEtag: (existing as CalendarObjectResource).etag.hex }
				: condition.kind === "must-not-exist"
					? { kind: "create" }
					: existing === null
						? { kind: "create" }
						: { kind: "overwrite" };
		await this.uow.saveResource(input.owner, input.collectionId, resource, collection, bounds, writePrecondition);

		return {
			etag: resource.etag,
			created: existing === null,
		};
	}
}
