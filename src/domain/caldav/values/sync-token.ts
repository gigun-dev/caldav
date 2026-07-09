// =============================================================================
// SyncToken — RFC 6578 §3.2 の同期トークン(値オブジェクト)
// =============================================================================
//
// 【最重要: 公開形式は「有効な URI」であることが MUST(RFC 6578 §3.2, §6.2)】
// 前作 hono-caldav は裸の整数カウンタをそのまま sync-token として返していたが、これは
// RFC 違反(05-rfc-verification.md 訂正1)。§3.2 は DAV:sync-token の値を「有効な URI」と
// 規定する。クライアントには不透明(中身を解釈してはならない)だが、サーバー内部では
// 意味を持ってよい。
//
// 【内部表現 = 単調増加の整数カウンタ】
// 差分計算(changesSince)には「順序」だけが必要十分。整数カウンタなら
//   - 「トークン t 以降の変更」= 変更ログのうち counter > t のもの、と単純比較で出せる
//   - コレクションの状態が進むたびに +1 するだけで一意・単調・比較可能
// という利点がある。公開時にだけ URI へ包む(下記 toUri)。
//
// 【URI 形式を `{base}/ns/sync/{n}` にした根拠】
// RFC は「有効な URI であること」しか要求しない(形式は完全にサーバーの自由・不透明)。
// そこで「人間がログで見て意味が分かる」かつ「base からの相対で衝突しない」形として
//   {base}/ns/sync/{counter}
// を採用した。`ns/sync` は "namespace: sync" の意で、将来 base 直下に別種の
// サーバー内部 URI(例 ns/ctag)を生やしても衝突しないよう1階層挟んでいる。
// counter を末尾に置くのは fromUri でのパースを単純な「末尾の整数」抽出にするため。
// ※この形式は完全に内部都合。クライアントは不透明値として丸ごと保存・返送するだけ。
// =============================================================================

/**
 * SyncToken.fromUri の結果。
 *
 * 【なぜ判別可能ユニオンで返すのか】
 * クライアントは前回受け取った sync-token を丸ごと送り返してくるが、その値が
 *   - このサーバーが過去に発行した正規のトークン(valid)
 *   - 他サーバー由来 / 破損 / 手組みの、解釈不能なトークン(invalid)
 * のどちらかは事前に分からない。invalid の場合 RFC 6578 は valid-sync-token
 * precondition 失敗(→ full resync 要求)につながる。呼び出し側(application 層)が
 * この2ケースを型で分岐できるよう、例外ではなく判別可能ユニオンで返す。
 * raw を残すのはログ・エラー応答に元の値を載せられるようにするため。
 */
export type SyncTokenParse = { valid: true; token: SyncToken } | { valid: false; raw: string };

// URI パスの固定セグメント。冒頭コメントの設計理由参照。定数化して toUri/fromUri で共有し、
// 「片方だけ形式を変えて往復が壊れる」事故を防ぐ。
const SYNC_PATH_SEGMENT = "ns/sync";

/** base 末尾の "/" を1個だけ取り除く。base が "https://h/cal/" でも "https://h/cal" でも同じ URI を作るため。 */
function stripTrailingSlash(base: string): string {
	return base.endsWith("/") ? base.slice(0, -1) : base;
}

export class SyncToken {
	// counter は 0 以上の整数。0 は「コレクション作成直後(まだ何も変更が記録されていない)」を表す。
	private constructor(readonly counter: number) {}

	/**
	 * 初期トークン(counter=0)。コレクション新規作成時の同期原点。
	 * ※クライアントの「初回同期」(空の DAV:sync-token を送ってくる。§3.4)とは別概念。
	 *   初回同期は「baseline 無し」であって counter=0 のトークンを送ってくるわけではない。
	 */
	static initial(): SyncToken {
		return new SyncToken(0);
	}

	/** 既知のカウンタ値(DB から読み戻した値等)から復元する。負値・非整数は throw。 */
	static of(counter: number): SyncToken {
		if (!Number.isInteger(counter) || counter < 0) {
			throw new Error(`SyncToken.of: counter must be a non-negative integer, got ${counter}`);
		}
		return new SyncToken(counter);
	}

	/** 次のトークン(counter+1)。recordChange が状態を1歩進めるたびに使う。単調増加を保証。 */
	next(): SyncToken {
		return new SyncToken(this.counter + 1);
	}

	/**
	 * 公開 URI 形式へ。base はコレクションの URL 等(サーバーが決める名前空間の起点)。
	 * 例: toUri("https://dav.example/cal/work") → "https://dav.example/cal/work/ns/sync/42"
	 */
	toUri(base: string): string {
		return `${stripTrailingSlash(base)}/${SYNC_PATH_SEGMENT}/${this.counter}`;
	}

	/**
	 * クライアントが送ってきた URI を解釈する。base はそのコレクションの起点(toUri と同一を渡す)。
	 * 期待する形 `{base}/ns/sync/{整数}` に一致しなければ invalid(他サーバー由来等)として返す。
	 *
	 * 判定を「prefix 一致 + 末尾が \d+」に限定する理由: 余計な寛容さ(末尾スラッシュ許容など)を
	 * 足すと、別コレクションのトークンを取り違える危険が増す。トークンは自分が発行した厳密な
	 * 形だけを正規として受け入れ、少しでも外れたら invalid にする(安全側に倒す)。
	 */
	static fromUri(base: string, uri: string): SyncTokenParse {
		const prefix = `${stripTrailingSlash(base)}/${SYNC_PATH_SEGMENT}/`;
		if (!uri.startsWith(prefix)) {
			return { valid: false, raw: uri };
		}
		const tail = uri.slice(prefix.length);
		// 末尾は 0 以上の整数のみ。先頭ゼロ("007")等は自分で発行しないので受け付けない
		// (\d+ は "007" も通すが、Number 化で 7 になり toUri の再出力と一致しなくなるだけで害はない。
		//  ここでは厳密さより「発行した形と往復する」ことを優先し \d+ を許容する)。
		if (!/^\d+$/.test(tail)) {
			return { valid: false, raw: uri };
		}
		return { valid: true, token: new SyncToken(Number(tail)) };
	}

	/** カウンタの等価比較。 */
	equals(other: SyncToken): boolean {
		return this.counter === other.counter;
	}

	/** ログ・テスト表示用。内部カウンタが見えるようにしておく(URI 化には base が要るため簡易表現)。 */
	toString(): string {
		return `SyncToken(${this.counter})`;
	}
}
