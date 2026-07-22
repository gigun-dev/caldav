// =============================================================================
// presentation/mcp/ui/day-timeline.ts — 日タイムライン(③)の重なりレイアウト純関数
//                                        (2026-07-22 ロードマップ③・agenda-views-v7.html の正)
// =============================================================================
// 【このモジュールの位置づけ(How はここ・What はテスト、の書き分け)】
//   日ビューの「時刻軸に予定ブロックを絶対配置し、重なりは等幅の列に分割する」ための純関数だけを
//   置く。DOM/App は一切触らない(format.ts と同じ制約 — 主 tsconfig は DOM lib 無しでもここを
//   コンパイルするので document/window は使わない)。列分割の境界(隣接・終端一致・鎖状部分重複・
//   日跨ぎ clamp・0分イベント)は壊れやすい塊なので、DOM を組む前に mcp-ui-day-timeline.test.ts で
//   機械的に固定する。renderDayView(agenda-entry.ts)は結果(LaidOutBlock[])を受け取って
//   left%/width%/top/height に写すだけにする。
//
// 【iOS カレンダー日ビューの重なり規約(準拠したい振る舞い)】
//   - 隣接(前の予定の終端 = 次の予定の始端)は「重ならない」= 同じ列を再利用する(半開区間 [s,e))。
//   - 同時刻に重なる予定は、クラスタ(相互に重なりで連結した成分)ごとに等幅の列へ分割する。
//   - 列の本数(colCount)は「クラスタ内の同時刻の最大重なり数」で全ブロック統一する。greedy が
//     たまたま使った列数ではない(main 裁定)。理由: 鎖状に部分重複する 3 件でも同時刻の最大は 2 なら
//     幅は 1/2 にしたい(1/3 にすると無駄な空列ができて iOS と見た目がずれる)。区間グラフの彩色は
//     「最大クリーク = ある瞬間の最大同時本数」で足りる(start 昇順の greedy が最適彩色を達成する)ので、
//     colCount = maxOverlap を全ブロックへ配れば col < colCount が常に成り立つ(テストで固定)。
// =============================================================================

// 閲覧デバイスの localDateKey(今日判定)。ui/ 内どうしの import は許可(mcp-ui-is-terminal の pathNot)。
import { localDateKey } from "./format";

/** 1 日(分)。0:00〜24:00 の 1440 分。日跨ぎ予定はこの範囲へ clamp する。 */
export const DAY_MIN = 1440;

/**
 * 0分イベント(end 無し・start===end)や極端に短い予定の「最小の可視高さ(分換算)」。
 * 【なぜ 20 分か】iOS カレンダーは 0 分の点予定でもタイトルが読める最小の帯を確保する。48px/h の
 * 目盛だと 20 分 = 16px でタイトル 1 行がぎりぎり乗る高さ。値そのものは表示都合の定数なので、
 * 目盛高さを変えたらここも見直す(2026-07-22 初期値・可逆)。
 * 【clamp を overlap 計算にも効かせる Why】最小幅 clamp を「見た目の高さ」だけに使い overlap は生の
 * 区間で計算する案も検討したが、同時刻の 0 分予定 2 件が「重ならない」判定になって重なって描かれる
 * 不整合が出る。clamp 後の区間で overlap も列分割も一貫して計算する方が破綻しない(このモジュールの
 * 出力 startMin/endMin はそのまま高さに使う=見た目と重なり判定が常に一致する)。
 */
export const MIN_BLOCK_MIN = 20;

/** レイアウト前の時刻付きブロック(1 日内の分。startMin/endMin は day-clamp 前の生値でよい)。 */
export interface TimedBlock {
	/** 行同一性(rowKey)。レイアウト後に元イベントへ引き戻すための不透明キー。 */
	key: string;
	/** 日内開始(分)。0 未満(前日から継続)や 1440 超(翌日へ継続)を渡してよい(clamp する)。 */
	startMin: number;
	/** 日内終了(分)。end 無しは startMin と同値を渡す(0分 → 最小幅 clamp が効く)。 */
	endMin: number;
}

/** レイアウト後のブロック(絶対配置の入力)。startMin/endMin は clamp 済み(そのまま高さに使える)。 */
export interface LaidOutBlock extends TimedBlock {
	/** 0-based 列インデックス(0 <= col < colCount を常に満たす)。 */
	col: number;
	/** この列分割の本数 = クラスタ内の同時刻最大重なり数(全ブロックで統一)。 */
	colCount: number;
}

/** [lo, hi] へ clamp。 */
function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** 生の startMin/endMin を [0, DAY_MIN] に収め、0分/極短は MIN_BLOCK_MIN の高さへ広げる。 */
function normalize(b: TimedBlock): TimedBlock {
	let s = clamp(b.startMin, 0, DAY_MIN);
	let e = clamp(b.endMin, 0, DAY_MIN);
	if (e < s) e = s; // 防御(壊れた入力で end<start でも落とさない)
	if (e - s < MIN_BLOCK_MIN) {
		// まず下方向へ広げる。日末(24:00)に貼り付いていて広げ切れないなら start を引き上げる。
		e = Math.min(DAY_MIN, s + MIN_BLOCK_MIN);
		if (e - s < MIN_BLOCK_MIN) s = Math.max(0, e - MIN_BLOCK_MIN);
	}
	return { key: b.key, startMin: s, endMin: e };
}

/**
 * 重なりレイアウト。開始昇順 → 貪欲な列割当。colCount はクラスタ(相互重なり連結成分)内の
 * 「同時刻の最大重なり数」で統一する(main 裁定)。
 *
 * 【手順】
 *   1. 各ブロックを normalize(day-clamp + 0分の最小幅 clamp)。
 *   2. 開始昇順(同開始は終了昇順 → key 昇順)で安定ソート。
 *   3. 連結成分(クラスタ)を割る: 走査中の clusterEnd(それまでの最大 endMin)より次の start が
 *      「以上(>=)」なら非重複=新クラスタ。半開区間なので終端一致(end===start)は非重複(別クラスタ)。
 *   4. クラスタごとに maxOverlap(ある瞬間の最大同時本数)を求める → colCount。
 *   5. 貪欲な列割当: 各ブロックを「最後の endMin <= 自分の startMin」の最も左の列へ入れる。無ければ新列。
 *      クラスタ境界では全列が空く(前クラスタの end <= 新 start)ので列番号は自然に 0 から再開する。
 */
export function layoutOverlaps(blocks: TimedBlock[]): LaidOutBlock[] {
	if (blocks.length === 0) return [];
	const norm = blocks.map(normalize);
	// 安定ソート: 開始昇順 → 終了昇順 → key 昇順(決定的にする=テストの期待値を固定できる)。
	const sorted = norm
		.map((b, i) => ({ b, i }))
		.sort((x, y) => x.b.startMin - y.b.startMin || x.b.endMin - y.b.endMin || (x.b.key < y.b.key ? -1 : x.b.key > y.b.key ? 1 : 0))
		.map((w) => w.b);

	// --- 3. クラスタ割当(連結成分)---
	const clusterId: number[] = [];
	let cid = -1;
	let clusterEnd = Number.NEGATIVE_INFINITY;
	for (const b of sorted) {
		if (b.startMin >= clusterEnd) {
			cid++;
			clusterEnd = b.endMin;
		} else {
			clusterEnd = Math.max(clusterEnd, b.endMin);
		}
		clusterId.push(cid);
	}

	// --- 4. クラスタごとの maxOverlap(= colCount)---
	// 端点掃引: 同座標では end(-1)を start(+1)より先に処理する(半開区間なので end===start は非重複)。
	const colCountByCluster = new Map<number, number>();
	{
		const byCluster = new Map<number, TimedBlock[]>();
		sorted.forEach((b, idx) => {
			const c = clusterId[idx]!;
			const arr = byCluster.get(c);
			if (arr === undefined) byCluster.set(c, [b]);
			else arr.push(b);
		});
		for (const [c, arr] of byCluster) {
			const events: Array<{ t: number; delta: number }> = [];
			for (const b of arr) {
				events.push({ t: b.startMin, delta: 1 });
				events.push({ t: b.endMin, delta: -1 });
			}
			// t 昇順、同 t は delta 昇順(-1 が先)。
			events.sort((a, e) => a.t - e.t || a.delta - e.delta);
			let cur = 0;
			let max = 0;
			for (const ev of events) {
				cur += ev.delta;
				if (cur > max) max = cur;
			}
			colCountByCluster.set(c, Math.max(1, max));
		}
	}

	// --- 5. 貪欲な列割当 ---
	const columnEnds: number[] = []; // 各列の「最後に入れたブロックの endMin」
	const out: LaidOutBlock[] = [];
	sorted.forEach((b, idx) => {
		let col = -1;
		for (let i = 0; i < columnEnds.length; i++) {
			if (columnEnds[i]! <= b.startMin) {
				col = i;
				columnEnds[i] = b.endMin;
				break;
			}
		}
		if (col === -1) {
			col = columnEnds.length;
			columnEnds.push(b.endMin);
		}
		out.push({ key: b.key, startMin: b.startMin, endMin: b.endMin, col, colCount: colCountByCluster.get(clusterId[idx]!) ?? 1 });
	});
	return out;
}

/**
 * 現在時刻の赤線の top(分・0〜1440)。表示日(dayKey)が閲覧デバイスの今日でなければ null。
 *
 * 【now を引数で受ける理由(feedback.ts の isCommitting と同じ流儀)】この関数自体はタイマーも
 * 状態も持たず、呼び出し側(60 秒タイマー / visibilitychange)が Date を渡す。境界(日跨ぎ・今日以外)を
 * そのまま now に渡して assert できるテスト容易性のため。
 *
 * 【分は端数を残す(秒 → 分の小数)】60 秒タイマーで更新するが、初回描画時に「10:30:45」なら
 * 630.75 分として位置を出す(1 分刻みのカクつきを避ける・実害の無い精度)。
 */
export function nowLineTopMin(now: Date, dayKey: string): number | null {
	if (localDateKey(now) !== dayKey) return null;
	return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}
