// =============================================================================
// presentation/mcp/ui/todos-diff-client.ts — システム起因(外部)変化のクライアント差分
//                                             (E-2 スライス④ 純関数コア)
// =============================================================================
// 【なぜ純関数として切り出すか】
//   このディレクトリ(ui/)には DOM を叩くブラウザコードしか無く、専用のテスト基盤も無い
//   (test/ 側は Workers/Node で走り DOM を持たないレーンなので ui/ のロジックを直接は
//   叩けない)。よって「prev/next の tasks を突き合わせてシステム起因の変化を検出する」
//   中核ロジックだけを、DOM も App も知らない純関数として本ファイルに隔離する。
//   仕様は下記コメント(入出力の対応表)で固定する = テストコードが担うはずの What を
//   コメントで代替する(このリポジトリの「テスト基盤が無ければ純関数+仕様コメント」方針)。
//
// 【mcp-ui-is-terminal との関係】
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' は「ui/ → src/ 内の他コード」への import を
//   禁止するが、ui/ 内どうし(このファイル ← todos-entry.ts)の import は禁止対象外
//   (to.pathNot が ^src/presentation/mcp/ui を除外している)。よってこのファイルは ui/ 内に
//   置き、todos-entry.ts から相対 import する(bun build がバンドル時に単一 ESM へ inline する
//   ので、生成物 todos-bundle.ts は従来どおり1ファイルのまま)。
//
// 【型は import せず構造的に受ける(ui は末端という設計方針)】
//   application 層の Task も todos-entry.ts の TodoItem も import しない(前者は境界違反、後者は
//   循環 import になる)。代わりに「差分計算に必要なフィールドだけ」を DiffTask として本ファイルで
//   宣言する。TodoItem は DiffTask の上位互換(全フィールドを含む)なので、entry 側は自分の
//   TodoItem[] をそのまま渡せる(構造的部分型)。契約がズレたら typecheck:ui か実機で気づく前提。
// =============================================================================

/** 差分計算に必要な最小フィールド(todos-entry.ts の TodoItem はこれを構造的に満たす)。 */
export interface DiffTask {
	id: string;
	title: string;
	completed: boolean;
	// due の形式は TodoItem と同じ: 終日 "YYYY-MM-DD" / 時刻付き offset ISO "...T09:00:00+09:00" / null。
	due: string | null;
	isAllDay: boolean;
	// PRIORITY 0-9(0=未設定)。表示語("高/中/低/なし")への正規化は下記 priorityWord が行う。
	priority: number;
	// E-2 スライス⑤: notes/recurrence の外部編集も becoming(編集済み)として拾えるようにする。
	// これらは before/after を載せない(長文・構造化値なので planEdit が「編集済み」バッジへ degrade)。
	// notes は string|null、recurrence は等価判定を JSON 文字列化で行うため詳細型は問わず unknown。
	// TodoItem はこの2フィールドを持つので構造的部分型は保たれる(entry の confirmedTasks を渡せる)。
	notes: string | null;
	recurrence: unknown;
}

/** edited の1フィールド変化。before/after は「UI 表示用の短い文字列」(サーバー todos-diff.ts の
 *  changes と同型)。due は client の生 due 文字列をそのまま載せる(entry の formatDueMeta が
 *  replace(" ","T") → formatDue で相対化するので、生 offset ISO でも表示短文でも通る)。 */
export interface DiffChange {
	field: string;
	before?: string;
	after?: string;
}

/** 削除ゴースト用スナップショット(entry の TaskSnapshot と同型 + sync 印)。 */
export interface DiffRemoved {
	id: string;
	title: string;
	due?: string;
	isAllDay?: boolean;
}

/**
 * システム起因(外部)変化の検出結果。すべて「サーバーの affected/removed で説明されていない
 * 残差」= ユーザー自身が起こしていない変化だけを含む(explainedIds で除外済み)。
 * - added    : next にだけ存在する id(iOS 等で外部追加された)。
 * - completed: 両方に存在し completed が false→true(外部完了)。
 * - reopened : 両方に存在し completed が true→false(外部再開)。
 * - edited   : 両方に存在し completed 不変で title/due/priority のいずれかが変化(外部編集)。
 * - removed  : prev にだけ存在した id(外部削除)。スナップショットは prev 行から合成する。
 */
export interface SyncDiff {
	added: string[];
	completed: string[];
	reopened: string[];
	edited: Array<{ id: string; changes: DiffChange[] }>;
	removed: DiffRemoved[];
}

/** PRIORITY(0-9)→ 表示語。サーバー todos-diff.ts の formatPriorityDisplay と同じ区分に揃える
 *  (0=なし / 1-4=高 / 5=中 / 6-9=低)。ズレると同じ「優先度変更」が UI 内で2つの語彙になるため
 *  意図的に写経する(import はできない = ui は末端)。 */
export function priorityWord(priority: number): string {
	if (priority <= 0) return "なし";
	if (priority <= 4) return "高";
	if (priority === 5) return "中";
	return "低";
}

/**
 * prev(直前に描画した server tasks)と next(新しい server tasks)を突き合わせ、
 * explainedIds(サーバーの affected/removed で既に説明済み = ユーザー起因)を除いた
 * 「システム起因の残差」を返す純関数。
 *
 * 【入出力の仕様(テスト代替のコメント固定)】
 *   - prev が空(初回 = tasks===null 相当。entry 側で空配列を渡すか呼ばない)なら next の
 *     全行が「追加」に見えてしまうため、entry 側は初回描画では本関数を呼ばない(prev 無し=差分なし)。
 *     本関数自体は prev=[] を渡されれば next 全件を added として返す(呼び出し側責務の明確化)。
 *   - completed と field 変化が同時に起きた行は completed/reopened を優先し edited には入れない
 *     (完了/再開の方が突出した出来事。サーバー側 affected の意味論とも揃える)。
 *   - edited の changes は title/due/priority のみ検出する(notes/sortOrder 等は UI に出さないので無視)。
 *     title は before/after を載せる(entry の planEdit が長さで degrade 判断する)。
 *     due は client 生 due をそのまま before/after に載せる(片側が null なら省く = 「なし」補完は entry)。
 *     priority は priorityWord で表示語化(0→"なし" は「値あり↔なし」の遷移として載せる)。
 *   - removed のスナップショットは prev 行から作る(next にはもう無いので prev が唯一の情報源)。
 *     due は prev.due(null なら省略)。
 *
 * @param prev 直前に描画に使った server tasks(entry の module 変数 tasks の旧値)。
 * @param next 新しい server tasks(応答の structuredContent.tasks)。
 * @param explainedIds サーバーが affected/removed で説明済みの id 集合(+ entry 側が触りたくない
 *        pending 行の id もここに載せる = degrade ガード。詳細は todos-entry.ts の呼び出し元コメント)。
 */
export function computeSyncDiff(
	prev: readonly DiffTask[],
	next: readonly DiffTask[],
	explainedIds: ReadonlySet<string>,
): SyncDiff {
	const prevById = new Map(prev.map((t) => [t.id, t]));
	const nextById = new Map(next.map((t) => [t.id, t]));

	const diff: SyncDiff = { added: [], completed: [], reopened: [], edited: [], removed: [] };

	// next 側走査: 追加 / 完了 / 再開 / 編集。
	for (const n of next) {
		if (explainedIds.has(n.id)) continue; // ユーザー起因(or pending)は残差から除外
		const p = prevById.get(n.id);
		if (p === undefined) {
			diff.added.push(n.id);
			continue;
		}
		if (p.completed !== n.completed) {
			// 完了状態の変化を最優先(field 変化が同時でも completed/reopened として扱う)。
			if (n.completed) diff.completed.push(n.id);
			else diff.reopened.push(n.id);
			continue;
		}
		const changes = fieldChanges(p, n);
		if (changes.length > 0) diff.edited.push({ id: n.id, changes });
	}

	// prev 側走査: 削除(prev にしか無い id)。
	for (const p of prev) {
		if (explainedIds.has(p.id)) continue;
		if (nextById.has(p.id)) continue;
		diff.removed.push({
			id: p.id,
			title: p.title,
			...(p.due !== null ? { due: p.due } : {}),
			isAllDay: p.isAllDay,
		});
	}

	return diff;
}

/** 2行の title/due/priority を比較して DiffChange[] を作る(edited 用の下請け)。
 *  値の等価は素朴な文字列/数値比較で十分(due は同じ生形式が来る前提。offset まで一致して
 *  初めて「同じ due」= 秒未満やゾーン表現の揺れは E-1 の task-dto が既に正規化済み)。 */
function fieldChanges(p: DiffTask, n: DiffTask): DiffChange[] {
	const changes: DiffChange[] = [];
	if (p.title !== n.title) {
		changes.push({ field: "title", before: p.title, after: n.title });
	}
	if (p.due !== n.due) {
		// 片側 null は「その側のキーを省く」= entry 側で「なし」に補完される(サーバー contract と同じ扱い)。
		changes.push({
			field: "due",
			...(p.due !== null ? { before: p.due } : {}),
			...(n.due !== null ? { after: n.due } : {}),
		});
	}
	// 優先度は「表示語」ベースで比較する。数値 1↔3 のような同一区分内(どちらも「高」)の変化は
	// UI 上は不可視なので変化として拾わない(「高 → 高」の無意味な差分表示を避ける)。
	// 区分をまたぐ(なし↔高 等)ときだけ edited の priority 変化として載せる。
	const pw = priorityWord(p.priority);
	const nw = priorityWord(n.priority);
	if (pw !== nw) {
		changes.push({ field: "priority", before: pw, after: nw });
	}
	// notes(E-2 スライス⑤): 外部でメモが編集/追加/削除されたら「編集済み」として拾う。before/after は
	// 載せない — メモは長文で meta 行のインライン差分に収まらないため、entry の planEdit が field だけの
	// 変更を「編集済み」バッジ + 「他N件」に degrade する(既存の title-only 編集と同じ扱い)。
	// undefined と null は正規化して比較する(2026-07-15)。claude.ai の replay は「その応答が
	// 作られた時点の DTO」を渡すため、フィールド追加(スライス⑤の notes/recurrence 等)以前の
	// スナップショットでは undefined になり、素朴比較だと全行が偽陽性の edited になる。
	if ((p.notes ?? null) !== (n.notes ?? null)) {
		changes.push({ field: "notes" });
	}
	// recurrence(E-2 スライス⑤): 反復設定の外部変更も同様に拾う。構造化オブジェクトなので等価判定は
	// JSON 文字列化で行う(サーバー由来で両者のキー順は同一 = 安定比較。null 同士は "null" で一致)。
	// before/after は載せない(繰り返しの整形は表示層依存で meta インラインに乗らない)→ 「編集済み」degrade。
	if (JSON.stringify(p.recurrence ?? null) !== JSON.stringify(n.recurrence ?? null)) {
		changes.push({ field: "recurrence" });
	}
	return changes;
}
