-- =============================================================================
-- #45 場所モデル: geocoding 月次 quota カウンタ(GEOCODING_MONTHLY_LIMIT のバックエンド)
-- =============================================================================
--
-- 【このマイグレーションが入れる変更】
--   新規テーブル geocoding_quota を1つ足すだけ(既存テーブルには一切触れない)。
--   Google Maps Places API(Text Search Pro SKU・無料枠 月5,000コール)の無料枠が切れる前に
--   Workers 側で打ち止めるための月次カウンタ。1行 = 1ヶ月("YYYY-MM")。
--
-- 【前方互換(migrations/README 規律)の確認】
-- 新テーブルの追加のみ = expand フェーズの安全な変更。現在デプロイ済みのコードは
-- geocoding_quota を一切参照しないので、migrate がデプロイに先行しても後行しても壊れない
-- (README「新テーブル / 新インデックスの追加のみを1マイグレーションで行う」に合致)。
--
-- 【なぜ month を PRIMARY KEY にするか】
-- 月ごとに1行しか要らず、D1GeocodingQuotaStore.tryConsume の条件付き UPSERT は
-- `ON CONFLICT(month)` を衝突ターゲットにする。PRIMARY KEY(= 暗黙の UNIQUE index)があれば
-- この ON CONFLICT が成立する(0004 の PK/partial index の教訓: ON CONFLICT のターゲットは
-- 一致する制約/index が必要)。month は "YYYY-MM" 固定幅文字列なので TEXT PK で十分。
--
-- 【used の DEFAULT 0 + NOT NULL】
-- 初回は INSERT ... VALUES(month, 1) で1が入るので DEFAULT は実質使わないが、将来
-- 別経路(管理ツールでの手動 UPSERT 等)で month だけ挿入されても壊れないよう保険で 0 既定にする。
--
-- 【D1 適用は deploy パイプライン(migrate→deploy)が自動で行う。ここはファイル追加のみ。】
-- =============================================================================

CREATE TABLE geocoding_quota (
  -- "YYYY-MM"(UTC 基準の月キー。application/geocoding/quota-limited-geocoding.ts の monthKeyUtc)。
  month TEXT PRIMARY KEY,
  -- その月に消費した geocoding 呼び出し回数(= Google への実呼び出し回数)。
  used INTEGER NOT NULL DEFAULT 0
);
