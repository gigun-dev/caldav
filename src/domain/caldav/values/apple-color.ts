// =============================================================================
// AppleColor — Apple 拡張 calendar-color の色値(値オブジェクト)
// =============================================================================
//
// iOS/macOS はカレンダー一覧の色を WebDAV プロパティ
// `{http://apple.com/ns/ical/}calendar-color` で持ち、値は **#RRGGBBAA**(8 桁 hex)。
// RFC 7986 の COLOR(CSS3 色名)とは別レイヤー・別形式(05-rfc-verification.md 参照)。
//
// 【#RRGGBB(6 桁)も受理する理由】Apple は基本 8 桁(末尾にアルファ)で送るが、
// 手組みデータや他クライアントは 6 桁で送ることがある。iOS 表示には支障ないので寛容に受ける。
//
// 【落とし穴メモ(05 より): symbolic-color 属性は捨てる】
// Apple はプリセット色選択時に calendar-color を `symbolic-color="green"` 付きで
// PROPPATCH してくる(Stalwart #1611)。この VO は **#RRGGBBAA の値だけ**を持ち、
// XML 属性は presentation 層で剥がす。属性を別プロパティ扱いして素朴に保存すると
// 色がリセットされるバグになる。値だけ保存して返せば安全。
// =============================================================================

export class AppleColor {
	// hex は先頭 "#" 付き・大文字正規化した 6 桁 or 8 桁。表示・比較を安定させるため正規化して持つ。
	private constructor(readonly hex: string) {}

	/**
	 * "#RRGGBB" または "#RRGGBBAA"(大文字小文字問わず)からパース。形式外は throw。
	 * presentation 層が XML 属性を剥がした「値だけ」を渡す前提。
	 */
	static parse(raw: string): AppleColor {
		if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) {
			throw new Error(`AppleColor.parse: expected #RRGGBB or #RRGGBBAA, got "${raw}"`);
		}
		// 大文字へ正規化("#ff0000ff" と "#FF0000FF" を同値に)。色名は case-insensitive。
		return new AppleColor(raw.toUpperCase());
	}

	equals(other: AppleColor): boolean {
		return this.hex === other.hex;
	}

	toString(): string {
		return this.hex;
	}
}
