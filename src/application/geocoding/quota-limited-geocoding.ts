// =============================================================================
// QuotaLimitedGeocoding — GeocodingPort に月次 quota ガードを被せるデコレータ(#45 追加要件)
// =============================================================================
//
// 【なぜ「アダプタ内部」ではなく application 層のデコレータにするか(層の筋)】
// コーディネータ要件は「Google Maps API の無料枠が切れる前に Workers 側で rate limit をかける」。
// これを GooglePlacesGeocodingAdapter(infrastructure)の内部に埋めると、
//   - 「上限をどう数えるか(D1 カウンタ)」という別の外部技術(D1)への依存が Google アダプタに
//     混ざり、アダプタが2つの infra を抱えて単体テストしづらくなる。
//   - プロバイダを差し替えた(GSI/Apple)ときに quota ロジックも書き直しになる。
// quota は「どのプロバイダでも共通に効かせたい横断的関心事」なので、GeocodingPort ⇄ GeocodingPort の
// デコレータとして application 層に置き、内側(Google アダプタ)と quota ストア(D1)を合成する。
// これで「Google 呼び出しの写像」と「枠管理」を別々の port 実装として独立にテストできる。
//
// 【消費のタイミング(要件 #4: Google への実呼び出しの直前のみ)】
// searchLocation が呼ばれた時点で「これから Google を1回叩く」ことが確定しているので、inner を
// 呼ぶ直前に quota を予約(tryConsume)する。known-locations 先引きで解決したケースやバリデーション
// エラーは、そもそも search-location ツール(presentation)に到達する前に分岐して searchLocation を
// 呼ばないため、ここには来ない = 消費されない。inner(Google)が HTTP エラーで失敗しても「実呼び出しは
// 発生した」ので予約は戻さない(rate limit は試行回数で数えるのが素直・無料枠も試行で減る)。
// =============================================================================

import type {
	GeocodingPort,
	GeocodingQuotaStore,
	LocationCandidate,
	SearchLocationOptions,
} from "../ports";
import { GeocodingQuotaExceededError } from "../ports";

/**
 * "YYYY-MM"(UTC)の月キーを作る。月が変われば別キー = 別カウンタ行 = 自動リセット。
 * 【なぜ UTC 固定か】単一ユーザーの iOS 運用でも、月境界の厳密さより「実装・テストの決定性」を優先する
 * (ローカルタイムだと Workers の実行 colo で境界がぶれる)。無料枠のリセットも Google 側の請求月と
 * 厳密一致させる必要はない(保守的な上限で十分マージンを取るため。既定 1000 は下の LIMIT コメント参照)。
 */
export function monthKeyUtc(now: Date): string {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth() + 1; // getUTCMonth は 0-based。
	return `${y}-${String(m).padStart(2, "0")}`;
}

export class QuotaLimitedGeocoding implements GeocodingPort {
	constructor(
		private readonly inner: GeocodingPort,
		private readonly quota: GeocodingQuotaStore,
		private readonly monthlyLimit: number,
		// クロックを注入可能にする(テストで月境界・上限到達を決定的に再現するため)。既定は実時刻。
		private readonly now: () => Date = () => new Date(),
	) {}

	async searchLocation(query: string, opts?: SearchLocationOptions): Promise<LocationCandidate[]> {
		const month = monthKeyUtc(this.now());
		// Google 呼び出しの直前に1枠を atomic に予約する(GeocodingQuotaStore.tryConsume の契約:
		// used < limit のときだけ +1。並行呼び出しでも単一 SQL 文で単調増加が保証される)。
		const reservation = await this.quota.tryConsume(month, this.monthlyLimit);
		if (!reservation.ok) {
			// 上限到達 = ブロック。inner(Google)は一切呼ばない(= 課金される実呼び出しを発生させない)。
			throw new GeocodingQuotaExceededError(month, this.monthlyLimit);
		}
		return this.inner.searchLocation(query, opts);
	}
}
