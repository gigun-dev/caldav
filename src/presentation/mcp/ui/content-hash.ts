// =============================================================================
// presentation/mcp/ui/content-hash.ts — MCP Apps の ui:// URI を content-address 化するための hash util
// =============================================================================
// 【背景(2026-07-17 キャッシュバスティング S1)】
// claude.ai は MCP のカード ui:// リソースを URI 単位でキャッシュしうる(SEP-1865 仕様が MAY で
// 許可)。デプロイで HTML(CSS/骨格/バンドル)を変更しても、ホストが古いキャッシュを返し続ける
// リスクがある。対策として ui:// URI 自体に配信 HTML の hash を埋め込み(content-address 化)、
// HTML が変わるたびに URI も変わるようにする。同じ URI = 同じ内容が保証されるので、ホストの
// キャッシュ TTL に関わらず新 HTML は新 URI を経由して即座に伝播する(旧 URI は
// server.ts でエイリアス登録し後方互換を保つ)。
//
// 【なぜ crypto.subtle(SHA-256 等)ではなく FNV-1a か】
// crypto.subtle.digest は Promise を返す非同期 API。TODOS_UI_URI/AGENDA_UI_URI は
// モジュールロード時に評価される top-level const(server.ts の登録コードが同期的に参照する)
// なので、async な hash 関数は使えない(top-level await は Workers の module worker 形式では
// 使えるが、依存する側が同期 import で済む設計を崩したくない)。また目的は「衝突しにくい暗号強度」
// ではなく「内容が変わったら URI も変わる」という cache-busting のキーとして十分な性質だけ
// なので、暗号強度は要らない(Why not crypto.subtle)。FNV-1a は実装が数行で済み、依存も
// 増やさず、十分な分散を持つ非暗号ハッシュとして広く使われている。
// =============================================================================

/**
 * FNV-1a (32bit) を計算し、8桁の 16進数(hex)文字列で返す。
 * 【なぜ 8桁固定か】32bit 値は最大でも 8桁の hex(0xffffffff)に収まる。0 埋めして桁数を
 * 固定することで URI の見た目が安定し、正規表現での検証(todos-app.test.ts 等)もしやすくなる。
 */
export function fnv1aHex(input: string): string {
	// FNV-1a 32bit: offset basis / prime は仕様で定められた定数(http://www.isthe.com/chongo/tech/comp/fnv/)。
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		// charCodeAt は UTF-16 code unit 単位。HTML 文字列(実質 ASCII/UTF-16 BMP がほぼ全て)を
		// 対象にする限り、コードポイントの厳密な UTF-8 変換までは不要(cache-busting のキーとして
		// 十分な分散が得られればよく、正規化の厳密さを求める用途ではないため)。
		hash ^= input.charCodeAt(i);
		// 32bit 乗算を Math.imul で行う(通常の `*` は 2^53 超で精度が落ちるため、32bit 整数乗算には
		// Math.imul が必須)。FNV prime = 0x01000193。
		hash = Math.imul(hash, 0x01000193);
	}
	// 符号なし 32bit に変換してから hex 化(>>> 0 で符号ビットを潰す)。8桁に 0 埋め。
	return (hash >>> 0).toString(16).padStart(8, "0");
}
