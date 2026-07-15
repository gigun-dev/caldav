// =============================================================================
// presentation/mcp/ui/events-diff-client.ts — システム起因(外部)変化のクライアント差分
//                                              (E-3 S2・todos-diff-client の event 版)
// =============================================================================
// 【なぜ純関数として切り出すか】todos-diff-client.ts と全く同じ理由 — ui/ には DOM を叩く
//   ブラウザコードしか無くテスト基盤も無いので、「prev/next の events を突き合わせてシステム起因の
//   変化を検出する」中核ロジックだけを DOM も App も知らない純関数に隔離し、仕様は下記コメントで
//   固定する(テストが担うはずの What をコメントで代替)。
//
// 【todos との違い】イベントに完了は無いので kind は added / edited / removed のみ
//   (completed/reopened は持たない)。edited は start/end/location/notes/recurrence/url/alarms/
//   travelMinutes のいずれかの変化。start/end は before/after を短文で載せ、他は field のみ
//   (長い/表現が割れる値は「編集済み」バッジへ degrade — events-diff.ts のサーバー側と同じ判断)。
//
// 【型は import せず構造的に受ける】agenda-entry.ts の EventItem はこの DiffEvent を構造的に満たす。
// =============================================================================

/** 差分計算に必要な最小フィールド(agenda-entry.ts の EventItem はこれを構造的に満たす)。 */
export interface DiffEvent {
	id: string;
	title: string;
	// 終日 "YYYY-MM-DD" / 時刻付き offset ISO / (start は必須なので null 不可)。
	start: string;
	end: string | null;
	isAllDay: boolean;
	location: string | null;
	url: string | null;
	notes: string | null;
	// 構造化値。等価判定は JSON 文字列化で行うので詳細型は問わず unknown。
	recurrence: unknown;
	alarms: number[];
	travelMinutes: number | null;
}

/** edited の1フィールド変化。before/after は「UI 表示用の短い文字列」(events-diff.ts と同型)。 */
export interface DiffChange {
	field: string;
	before?: string;
	after?: string;
}

/** 削除ゴースト用スナップショット(agenda の EventSnapshot と同型 + sync 印は entry 側で付ける)。 */
export interface DiffRemoved {
	id: string;
	title: string;
	start?: string;
	end?: string;
	isAllDay?: boolean;
}

/**
 * システム起因(外部)変化の検出結果。すべて「サーバーの affected/removed で説明されていない
 * 残差」= ユーザー自身が起こしていない変化だけを含む(explainedIds で除外済み)。
 * - added   : next にだけ存在する id(iOS 等で外部追加された)。
 * - edited  : 両方に存在し start/end/location/notes/recurrence/url/alarms/travelMinutes のいずれかが変化。
 * - removed : prev にだけ存在した id(外部削除)。スナップショットは prev 行から合成する。
 */
export interface SyncDiff {
	added: string[];
	edited: Array<{ id: string; changes: DiffChange[] }>;
	removed: DiffRemoved[];
}

/** 時刻付き ISO / 終日 → 表示用短文("YYYY-MM-DD" or "YYYY-MM-DD HH:MM")。null は undefined。 */
function instantDisplay(iso: string | null, isAllDay: boolean): string | undefined {
	if (iso === null) return undefined;
	if (isAllDay) return iso.slice(0, 10);
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * prev(直前に描画した server events)と next(新しい server events)を突き合わせ、
 * explainedIds(サーバーの affected/removed で既に説明済み = ユーザー起因、+ pending 行)を除いた
 * 「システム起因の残差」を返す純関数。
 *
 * 【入出力の仕様(テスト代替のコメント固定)】
 *   - prev=[](初回)なら next 全件を added として返す(entry 側は初回描画では呼ばない = prev 無し差分なし)。
 *   - edited の changes は start/end に短文 before/after を載せ、その他は field のみ(planEdit が degrade)。
 *   - removed のスナップショットは prev 行から作る(next にはもう無いので prev が唯一の情報源)。
 *   - undefined/null は正規化して比較する(replay スナップショットの旧 DTO でフィールド不在→偽陽性を防ぐ)。
 */
export function computeSyncDiff(
	prev: readonly DiffEvent[],
	next: readonly DiffEvent[],
	explainedIds: ReadonlySet<string>,
): SyncDiff {
	const prevById = new Map(prev.map((e) => [e.id, e]));
	const nextById = new Map(next.map((e) => [e.id, e]));
	const diff: SyncDiff = { added: [], edited: [], removed: [] };

	for (const n of next) {
		if (explainedIds.has(n.id)) continue;
		const p = prevById.get(n.id);
		if (p === undefined) {
			diff.added.push(n.id);
			continue;
		}
		const changes = fieldChanges(p, n);
		if (changes.length > 0) diff.edited.push({ id: n.id, changes });
	}

	for (const p of prev) {
		if (explainedIds.has(p.id)) continue;
		if (nextById.has(p.id)) continue;
		diff.removed.push({
			id: p.id,
			title: p.title,
			...(instantDisplay(p.start, p.isAllDay) !== undefined ? { start: instantDisplay(p.start, p.isAllDay) } : {}),
			...(instantDisplay(p.end, p.isAllDay) !== undefined ? { end: instantDisplay(p.end, p.isAllDay) } : {}),
			isAllDay: p.isAllDay,
		});
	}

	return diff;
}

/** 2行を比較して DiffChange[] を作る(edited 用の下請け)。 */
function fieldChanges(p: DiffEvent, n: DiffEvent): DiffChange[] {
	const changes: DiffChange[] = [];
	if (p.title !== n.title) {
		changes.push({ field: "title", before: p.title, after: n.title });
	}
	if (p.start !== n.start || p.isAllDay !== n.isAllDay) {
		const b = instantDisplay(p.start, p.isAllDay);
		const a = instantDisplay(n.start, n.isAllDay);
		changes.push({ field: "start", ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
	}
	if (p.end !== n.end) {
		const b = instantDisplay(p.end, p.isAllDay);
		const a = instantDisplay(n.end, n.isAllDay);
		changes.push({ field: "end", ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
	}
	if ((p.location ?? null) !== (n.location ?? null)) changes.push({ field: "location" });
	if ((p.url ?? null) !== (n.url ?? null)) changes.push({ field: "url" });
	if ((p.notes ?? null) !== (n.notes ?? null)) changes.push({ field: "notes" });
	if (JSON.stringify(p.recurrence ?? null) !== JSON.stringify(n.recurrence ?? null)) changes.push({ field: "recurrence" });
	if (JSON.stringify(p.alarms ?? []) !== JSON.stringify(n.alarms ?? [])) changes.push({ field: "alarms" });
	if ((p.travelMinutes ?? null) !== (n.travelMinutes ?? null)) changes.push({ field: "travelMinutes" });
	return changes;
}
