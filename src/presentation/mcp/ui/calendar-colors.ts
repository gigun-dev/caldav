// =============================================================================
// presentation/mcp/ui/calendar-colors.ts — カレンダー id → 表示色の決定的割当(純関数)
// =============================================================================
// 【なぜこのモジュールが要るか(2026-07-22 agenda カード色ドット)】
//   アジェンダカード(agenda-app.ts / agenda-entry.ts)は複数コレクションの予定を合成表示する。
//   「どの予定がどのカレンダー由来か」を一目で示すために、行の左と表示フィルタシートで色ドット/
//   丸チェックを描く。その色は「同じカレンダーには常に同じ色」でなければ凡例として機能しない
//   (再描画・refetch を跨いでも不変であること)。サーバーから calendar-color を read する経路は
//   まだ無い(下記 Why not 参照)ので、id から決定的にパレットへ割り当てる純関数でまず成立させる。
//
// 【なぜ純モジュール(ui/ 配下)として切り出すか】
//   ①bun:test で単体検証したい(同 id→同色・分布の性質を機械的に固定する)。②agenda-app.ts は
//   サーバー側の静的 HTML 文字列で DOM を持たない一方、agenda-entry.ts はブラウザ実行コード。両者が
//   同じパレット定義を共有する(app 側は CSS 変数や凡例に、entry 側は実際の描画に)ため、単一の真実の
//   ソースとして独立させる。ui/ は「ブラウザで実行される末端コード」隔離区画(icons.ts と同格)で、
//   .dependency-cruiser.cjs の 'mcp-ui-is-terminal' 制約下でも定数 export だけなら他 src へ import しない。
//
// 【将来: calendar-color プロパティ優先(Why not いま実装しない)】
//   CalDAV / Apple 拡張のコレクションには calendar-color(#RRGGBB[AA])プロパティがあり(create-calendar
//   の color 引数・domain の AppleColor が既に存在する)、本来はユーザーが設定した色を尊重すべき。
//   ただし list-calendars / list-events-expanded の応答はまだ color を運んでいない(wire 形に無い)。
//   応答に color を足す(server 側・vm 側の additive 拡張)のは別スコープなので、まずは id ハッシュで
//   成立させ、「color を read できるようになったらそちらを優先し、未設定のときだけ本関数へフォールバック
//   する」形へ差し替える(呼び出し側で `readColor(id) ?? colorForCalendarId(id)` にするだけで済む設計)。

/**
 * カレンダー色パレット(8色)。iOS カレンダーのカラーピッカーに寄せたシステムカラー系
 * (systemBlue/Green/Orange/Red/Purple/Pink/Teal/Indigo 相当)を採用する — アジェンダカードの
 * 語彙が iOS カレンダーである以上、色相もその文法に合わせると学習コストがゼロになる。
 *
 * 【8色にした理由】少なすぎる(4色等)と実運用のコレクション数(実測 ~7)で衝突が頻発し凡例が
 * 破綻する。多すぎると隣接色の判別が難しくなる(小さな色ドット 10-13px では色差が要る)。8 は
 * 「~7 コレクションを概ね一意に塗り分けられ、かつ各色が十分に離れている」下限として選んだ
 * (完全な衝突回避は保証しない — 9個目以降は必ずどれかと同色になる。凡例は「だいたい別色」で
 * 足り、厳密な一意性は将来 calendar-color プロパティが担う想定)。順序は色相環上で隣が続かない
 * ように散らし、index が近いカレンダー同士でも色が似すぎないようにしている。
 */
export const CALENDAR_PALETTE: readonly string[] = [
	"#007aff", // systemBlue
	"#34c759", // systemGreen
	"#ff9500", // systemOrange
	"#ff3b30", // systemRed
	"#af52de", // systemPurple
	"#ff2d55", // systemPink
	"#30b0c7", // systemTeal
	"#5856d6", // systemIndigo
];

/**
 * FNV-1a(32bit)ハッシュ。id 文字列を決定的に 32bit 符号なし整数へ畳む。
 * 【なぜ FNV-1a か】content-hash.ts が既に fnv1a を使っている(このリポジトリの「軽量・決定的な
 * 非暗号ハッシュ」の既定選択)ので語彙を揃える。ただし content-hash.ts の fnv1aHex は16進文字列を
 * 返す用途向けで、ここでは % 演算のため数値が欲しいので、依存を増やさず必要な数値版だけを持つ
 * (import で結合するほどのものではない小さな純関数 — 意図的な軽い重複)。
 * 暗号強度は不要(衝突耐性でなく「同 id→同値」の決定性だけが要件)。
 */
function fnv1a32(input: string): number {
	// FNV-1a 32bit: offset basis 2166136261、prime 16777619。>>> 0 で符号なし 32bit に正規化する。
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// Math.imul で 32bit 乗算のオーバーフローを正しく畳む(素朴な * だと 53bit 超で精度が落ちる)。
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * カレンダー id を CALENDAR_PALETTE の1色へ決定的に割り当てる。
 * 同じ id は常に同じ色を返す(refetch / 再描画を跨いで不変 = 凡例として機能する要件)。
 * @param calendarId コレクション id(list-events-expanded の event.calendarId 等)
 * @returns "#RRGGBB" のパレット色
 */
export function colorForCalendarId(calendarId: string): string {
	const index = fnv1a32(calendarId) % CALENDAR_PALETTE.length;
	return CALENDAR_PALETTE[index];
}

/**
 * 【2026-07-23 K2-UI①: 実色対応】呼び出し側が「合成規則」を毎回書かなくて済むよう、上のファイル冒頭
 * コメント(「将来: calendar-color プロパティ優先」)で予告していた合成をこの1関数にまとめる。
 * list-calendars/create-calendar/update-calendar の応答は Apple 拡張 calendar-color(AppleColor)を
 * `color` として運ぶようになった(server.ts 側の対応は既存済み)。ユーザーが iOS 側で明示的に選んだ
 * 実色があるなら、id ハッシュの暫定パレット色より優先して尊重するのが正しい — 本モジュール冒頭の
 * 「実色を read できたら優先」という設計意図をそのまま実装する。
 *
 * @param realColor list-calendars 等が返す実色("#RRGGBB"/"#RRGGBBAA")。未設定/取得前は undefined。
 * @param calendarId フォールバック計算(colorForCalendarId)に使う id。
 * @returns 実色があればそれをそのまま(AppleColor の toString() 表現を透過で返す。CSS の
 *   background 等は 8桁 hex の下2桁(アルファ)も解釈できるためそのまま渡してよい)、
 *   無ければ colorForCalendarId のパレット色にフォールバックする。
 *
 * 【空文字列も未設定扱いにする理由】JSON 往復や手動テストで `color: ""` が来るケース(サーバー側は
 * 送らない設計だが、構造的に否定はできない)を「実色あり」と誤読して透明/無効な CSS 色を描画するのを
 * 避ける安全側の判定(`!== undefined && !== ""` の2条件)。
 */
export function resolveCalendarColor(realColor: string | undefined, calendarId: string): string {
	if (realColor !== undefined && realColor !== "") return realColor;
	return colorForCalendarId(calendarId);
}
