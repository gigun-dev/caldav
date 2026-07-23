// =============================================================================
// #locationMatchQuality(geocoding 解決品質ゲート): クエリと geocoding 候補の一致度を測る純関数。
// =============================================================================
// 【背景・なぜこれが要るか】Google Places はゴミ文字列を投げても必ず何かの候補を返す
// (実例: 「まったく存在しない架空ZZZ検証場所」→「魚彩ダイニングまったく」京都)。#51 の
// autoResolveLocation は geocoding の先頭候補を無条件に採用していたため、本番受け入れで
// 「無関係な場所に位置リマインダー/地図ピンが黙って付く」FAIL が出た。ここは server.ts の
// autoResolveLocation から呼ばれ、候補を採用してよいかのゲート判定に使う(呼び出し側の実装は
// server.ts 側。ここは依存を持たない純関数に留め、テストしやすくする)。
//
// 【依存を持たない理由】GeocodingPort/StructuredLocationInput 等の型を知らない(query/title/address
// という素の文字列だけを扱う)。server.ts 側の語彙変更に引きずられず単体で組み立て・検証できる。

/**
 * マッチング用に文字列を正規化する。
 *
 * 【何を落とすか】
 * - NFKC 正規化: 全角英数・半角カナなどの表記ゆれを統一(「２丁目」と「2丁目」を同一視するため)。
 * - lowercase: 大文字小文字の表記ゆれを吸収。
 * - \p{P}(句読点)\p{S}(記号)\p{N}(数字): 住所の丁目番地・郵便番号・ハイフン等はクエリと候補で
 *   粒度が揃わないことが多く(例: 「1丁目10-1」vs「１丁目１０−１」も NFKC 後は同じだが、番地の
 *   有無自体が揺れる)、一致判定のノイズになりやすいため丸ごと除去する。
 * - \p{Lm}(修飾文字): 長音符ー(U+30FC)や踊り字ゝゞ等がここに分類される。「スタバ」のような
 *   長音を省いた口語短縮形と正式名称「スターバックス」を一致させるため除去する
 *   (2026-07-24 較正: ー を残す実装だと bench の q06「岐阜駅前のスタバ」が2-gram一致率 0.286 で
 *   閾値 0.3 を割り込み false reject した。除去すると 0.429 に上がり通る。長音を落としても
 *   誤って別語を一致させるリスクは低いと判断)。
 * - 〒(〒): \p{S} で基本カバーされるが、環境依存を避けるため明示しておく。
 * - \s: 全角スペースを含む空白(住所の区切りスペースの有無はクエリ側に依存しないノイズ)。
 */
export function normalizeForMatch(s: string): string {
	return s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}\p{N}\p{Lm}〒\s]/gu, "");
}

/**
 * query が geocoding 候補(title/address)とどれだけ一致するかを 0〜1 のスコアで返す。
 *
 * 【判定の2段構え】
 * 1. 正規化後の双方向部分一致(query が title/address に含まれる、または title が query に含まれる)
 *    なら 1.0。「品川の叙々苑」→「叙々苑 品川プリンスホテル店」のように語順が入れ替わる/助詞が
 *    挟まる自然な言い回しをまず素朴な包含関係で拾う(bigram だけに頼ると短い一致語でもスコアが
 *    伸びにくいケースがあるため、まずここで確実な一致を弾く)。
 * 2. 部分一致が無ければ、クエリの文字バイグラム(2-gram)集合のうち `title + " " + address` の
 *    正規化連結に出現する割合を返す。ランダムなゴミ文字列(「asdfgh zzz」)や無関係な地名
 *    (「まったく存在しない架空ZZZ検証場所」→「魚彩ダイニングまったく」)を低スコアに落とす一方、
 *    多少の言い換え・表記ゆれは救えるバランスとして bigram を採用(完全一致や単語分割は日本語の
 *    分かち書きが要るため避けた)。
 *
 * 【2文字未満の特例】正規化後のクエリが2文字未満だとバイグラムを1つも作れず判定不能になる
 * (空集合の一致率は 0/0 で NaN になってしまう)。「駅」のような短い1文字クエリを誤って
 * reject しないよう、判定不能側に倒して 1.0(=ゲートを素通り)を返す。false reject(正しい候補を
 * 弾く)より false accept(ゴミ候補を通す)の方が実害が小さい局所判断 — もっとも短いクエリで
 * ゴミ候補が返るケースは稀な上、後段でユーザーに候補名を見せて是正できる。
 */
export function locationMatchScore(query: string, title: string, address: string | null): number {
	const nq = normalizeForMatch(query);
	if (nq.length < 2) return 1.0;

	const nTitle = normalizeForMatch(title);
	const nCombined = normalizeForMatch(`${title} ${address ?? ""}`);
	if (nTitle.includes(nq) || nCombined.includes(nq) || nq.includes(nTitle)) return 1.0;

	const bigrams = new Set<string>();
	for (let i = 0; i < nq.length - 1; i++) bigrams.add(nq.slice(i, i + 2));
	let hits = 0;
	for (const bigram of bigrams) {
		if (nCombined.includes(bigram)) hits++;
	}
	return hits / bigrams.size;
}

// 【0.3 という値について】2026-07-23 の docs/research/geocoding-bench-2026-07-23.md(18クエリ)+
// 「まったく存在しない架空ZZZ検証場所」1例からの較正前・暫定値。「通すべき18件」の最低スコアは
// 0.429(岐阜駅前のスタバ)、「弾くべき」ゴミ例は 0.188 なのでこの間に閾値を置けば bench 上は
// 分離できるが、サンプル数が少なく本番の多様なクエリを代表していない。誤って正しい候補を弾く方が
// (テキストのみ登録に degrade するだけなので)実害が小さいと判断し、0.429 側にかなり寄せた保守的な
// 値にしている。telemetry(TELEMETRY_LOCATION_META_KEY 経由で server.ts が score を記録)の実績が
// 貯まったら、reject 分布と accept 分布を見て調整すること。
export const LOCATION_MATCH_THRESHOLD = 0.3;
