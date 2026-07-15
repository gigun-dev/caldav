// =============================================================================
// presentation/mcp/ui/row-key.ts — 行同一性の合成キー + 系列(id)グルーピングの共有純関数
//                                   (docs/modeling/12 §7.1/§7.3・2026-07-16 実機FB 起点)
// =============================================================================
// 【なぜこのモジュールが要るか(2026-07-16 実機FB の経緯)】
//   単発イベントを平日 RRULE に変更したら、展開された各日の occurrence 行が全て「編集済み」
//   バッジを帯び、🔁 も消えて「別イベントの羅列」に見えるバグが出た。本番 D1 の生データは
//   完全に正常で、原因はカード側が becoming/選択/スワイプを **id 単独キー** で引いていたこと。
//   展開 occurrence の id は全行マスター UID(occurrence の識別は recurrenceId — §3 どおり)
//   なので、id 単独では系列の全行が同じキーに衝突する。
//
// 【二層分離の確定規約(§7.1)— なぜ「全部合成キー化」しないのか(Why not)】
//   - 「行の同一性」(DOM dataset・selectedId/swipeId・描画の一意性)= 合成キー rowKey。
//   - 「mutate・in-flight 状態」(pendingIds / optimisticEdits / optimisticDeletes /
//     affectedById)= マスター id 単位のまま。mutate 粒度はマスター単位(§3「mutate は
//     id(マスター)単位」)で、系列への並行編集はサーバー上も同一リソース。pending が
//     マスター単位で直列化するのは正しく、合成キー化すると「同一リソースへの二重送信」を
//     許してしまう。実機で問題だったのは「無言 no-op」の UX であってキー粒度ではない。
//
// 【todos との共有】todos の行は反復展開が無い(recurrenceId は常に null 相当)ので、
//   recurrenceId=null でこの同じ関数を呼べば key = "id\0" となり単に id と1対1。将来 todos が
//   同じ選択モデルへ寄せるときにそのまま流用できる形にしてある(§4 共有カーネル方針)。
// =============================================================================

/** rowKey が必要とする最小の構造(EventItem / TodoItem が構造的に満たす)。 */
export interface RowIdentity {
	id: string;
	// 反復展開された occurrence の識別子(RECURRENCE-ID)。単発・todos は null。
	recurrenceId?: string | null;
}

/**
 * 行の同一性 = 合成キー `id + "\0" + (recurrenceId ?? "")`(modeling/12 §7.1 の規定どおり)。
 * 【区切りが "\0" の理由(Why not 空白等)】id(UID)は空白やほぼ任意の可視文字を含みうるが、
 * NUL は iCalendar のテキストにも URL 由来の UID にも現れない=衝突しない唯一安全な区切り。
 * dataset へは実行時プロパティ代入で入れるだけ(HTML へ静的シリアライズしない)ので NUL でも問題ない。
 */
export function rowKey(row: RowIdentity): string {
	return `${row.id}\0${row.recurrenceId ?? ""}`;
}

/** rowKey → マスター id を取り出す逆関数(削除・pending 判定など「id 単位の層」へ渡すとき用)。 */
export function idOfRowKey(key: string): string {
	const sep = key.indexOf("\0");
	// "\0" 無し = rowKey を通っていない生 id(draft 行など)をそのまま返す防御。
	return sep === -1 ? key : key.slice(0, sep);
}

/**
 * 系列グルーピング: rows を `Map<id, row[]>`(出現順保持)にまとめる。
 * computeSyncDiff の id 単位 diff(§7.3)が使う。【Why not Map(rows.map(r=>[r.id,r]))】
 * 従来のこの書き方は同一 id の occurrence 列を「最後の1件」に潰しており、RRULE 展開で
 * 同じ id が複数行来ると diff が壊れていた(2026-07-16 実機FB のバグそのもの)。
 */
export function groupById<T extends { id: string }>(rows: readonly T[]): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const row of rows) {
		const bucket = map.get(row.id);
		if (bucket === undefined) map.set(row.id, [row]);
		else bucket.push(row);
	}
	return map;
}
