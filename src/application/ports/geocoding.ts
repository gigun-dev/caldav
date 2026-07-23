// =============================================================================
// GeocodingPort — 「場所の文字列を座標付き候補に解決する」プロバイダ非依存ポート
// =============================================================================
//
// 【なぜ application 層にこのポートを置くのか】
// AuthenticationPort / TelemetryPort と同じ思想(authentication.ts 冒頭コメント参照):
// 「何を解決したいか(店名・施設名・住所 → title/address/geo の候補)」は application/
// presentation の関心事だが、「どのプロバイダで解決するか(Google Places / GSI / Apple Maps)」
// は外部技術の詳細であり infrastructure に隠す。search-location MCP ツール(presentation)は
// この語彙だけを見て候補を得る。
//
// 【プロバイダ語彙を漏らさない(重要)】
// docs/research/geocoding-bench-2026-07-23.md の実測で Google Places Text Search (New) を主力に
// 選んだが、この型には Google 固有の語(displayName / formattedAddress / places:searchText /
// FieldMask など)を一切出さない。将来 GSI/Apple へ差し替え・多段化(住所は GSI で裏取り等)する
// 余地を型で潰さないため、語彙は「title / address / geo」という3点セット(structuredLocation の
// 素材)に閉じる。structuredLocation の write 側(structured-location-write.ts)がこの3点セットを
// そのまま X-APPLE-STRUCTURED-LOCATION / LOCATION に写せる形に揃えている。
//
// 【geo は必須(候補としての最低要件)】
// LocationCandidate.geo は必須にする。geocoding の存在意義は「iOS の地図表示が効く座標を与える」
// ことにあり(スライス B の degrade は "座標が取れなかったとき" 住所だけで登録する別経路)、
// 座標の無い候補を geocoding が返す意味は無い。infrastructure アダプタは座標が取れない生レスポンス
// 要素を候補から落とす責務を持つ(google-places-geocoding.ts のマッピング参照)。
// =============================================================================

/**
 * geocoding が返す「解決済みの場所候補」1件。structuredLocation の3スロット素材そのもの。
 * - title  : 表示名(店名・施設名。住所クエリだと住所断片が入ることもある — プロバイダ依存の best-effort)。
 * - address: 整形済み住所(表示用の補足テキスト)。プロバイダが返さなければ null。
 * - geo    : WGS84 座標(必須。ファイル冒頭「geo は必須」参照)。
 */
export interface LocationCandidate {
	readonly title: string;
	readonly address: string | null;
	readonly geo: { readonly lat: number; readonly lon: number };
}

/** searchLocation のオプション(将来の言語/地域/件数の上書き用。今は未使用だが seam を開けておく)。 */
export interface SearchLocationOptions {
	/** 返す候補の最大件数(既定はアダプタ側の maxResultCount)。 */
	readonly limit?: number;
}

/**
 * 場所解決ポート。「文字列を候補配列に解決する」だけの最小契約。
 * 【エラーの扱い】解決 0 件は空配列(例外ではない)。設定不備・上限超過は下の専用エラーを throw する
 * (呼び出し側 search-location ツールが人間可読メッセージへ変換する)。
 */
export interface GeocodingPort {
	searchLocation(query: string, opts?: SearchLocationOptions): Promise<LocationCandidate[]>;
}

// -----------------------------------------------------------------------------
// ポートが投げる型付きエラー(presentation が errKind / 人間可読メッセージへ写す)
// -----------------------------------------------------------------------------

/**
 * geocoding プロバイダの資格情報(API キー)が未設定のときのエラー。
 * 【なぜ「起動時 throw」ではなく「呼び出し時 throw」なのか(CONFIRM_SECRET と同じ縮退)】
 * GOOGLE_MAPS_API_KEY は wrangler.jsonc の secrets.required に載せるが、キー未設定でも Worker の
 * 起動・他ツールの動作は正常でなければならない(Workers Builds の deploy を壊さない・observability の
 * 他機能を巻き込まない)。よってアダプタは空キーでも構築でき、search-location を実際に呼んだときだけ
 * このエラーを投げる。server.ts は propose-* の confirmSecret 未設定と同じく「管理者に設定を依頼」の
 * 人間可読メッセージに変換する。
 */
export class GeocodingNotConfiguredError extends Error {
	readonly kind = "GeocodingNotConfiguredError" as const;
	constructor() {
		super("geocoding provider is not configured (API key missing)");
		this.name = "GeocodingNotConfiguredError";
	}
}

/**
 * 月次の解決枠(quota)を使い切ったときのエラー(コーディネータ追加要件)。
 * 【なぜ 500 で落とさず型付きエラーにするか】Google Maps の無料枠が切れる前に Workers 側で
 * 打ち止めるのが目的なので、超過は「異常」ではなく「想定内の縮退」。search-location は
 * 「今月の解決枠を使い切りました。住所のみでの登録(structuredLocation の degrade)は引き続き可能」
 * という人間可読メッセージを返し、telemetry の errKind に quota 超過を区別できる値を載せる
 * (呼び出し回数 × errKind で「枠に当たった頻度」を観測して上限調整の材料にする)。
 */
export class GeocodingQuotaExceededError extends Error {
	readonly kind = "GeocodingQuotaExceededError" as const;
	constructor(
		readonly month: string,
		readonly limit: number,
	) {
		super(`geocoding monthly quota exceeded for ${month} (limit=${limit})`);
		this.name = "GeocodingQuotaExceededError";
	}
}

// -----------------------------------------------------------------------------
// GeocodingQuotaStore — 月次カウンタの「予約(reserve)」ポート
// -----------------------------------------------------------------------------

/**
 * 月次 quota カウンタの永続化ポート(D1 実装は infrastructure/geocoding/d1-geocoding-quota-store.ts)。
 *
 * 【なぜ「increment」ではなく「tryConsume(予約)」の1メソッドにするか】
 * コーディネータ要件「上限到達で呼び出しをブロック」「並行呼び出しでの単調増加」を満たすには、
 * 「上限チェック」と「+1」を**不可分(atomic)**に行う必要がある。read-then-write の2段だと
 * 並行時に上限を超えて増えてしまう(TOCTOU)。よってポートは「1枠を予約できたか?」を1回で返す
 * 契約にし、D1 実装は条件付き UPSERT(used < limit のときだけ +1、RETURNING で確定値を返す)
 * 1文で実現する(単一 SQL 文なので atomic — d1-geocoding-quota-store.ts 参照)。
 *
 * 【消費のタイミング(要件 #4)】この予約は「Google への実呼び出しの直前」にだけ行う。
 * known-locations 先引きで解決した場合やバリデーションエラーでは呼ばない(= 消費しない)。
 * その配線は QuotaLimitedGeocoding デコレータ(inner.searchLocation の直前で reserve)が担う。
 */
export interface GeocodingQuotaStore {
	/**
	 * 指定月の枠を1つ予約する。used < limit なら used を +1 して { ok: true, used } を返す。
	 * 既に used >= limit なら増やさず { ok: false, used } を返す(上限到達 = ブロック)。
	 *
	 * @param month "YYYY-MM"(UTC 基準の月キー。月が変われば別行 = 自動リセット)。
	 * @param limit その月の上限(env で設定可能・既定 1000)。
	 */
	tryConsume(month: string, limit: number): Promise<{ ok: boolean; used: number }>;
}
