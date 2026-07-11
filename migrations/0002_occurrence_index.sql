-- =============================================================================
-- G-3: first/last occurrence 索引 + calendar-query time-range フィルタ
-- =============================================================================
--
-- calendar_objects に「このリソースが取りうる最初/最後の実効開始・終了(UTC エポック
-- ミリ秒)」を持たせる。REPORT calendar-query の time-range フィルタ(RFC 4791 §9.9)は
-- まずこの2列で SQL 側の候補を絞り込み、最終判定(反復展開してオーバーラップを見る)は
-- application 層(CalendarQuery ユースケース)が担う。sabre/dav 等の先例(docs/modeling/09)に
-- ならった「粗い索引 + 精密な最終フィルタ」の2段構え。
--
-- 別テーブルにせず calendar_objects へ列追加する理由: first/last は「このリソース1件」の
-- 派生属性であって独立の集約ではない(導出インデックスなので CalendarObjectResource 集約自体には
-- 持たせない設計だが、永続化はリソース行に同居させるのが素直。1:1 の別テーブルは JOIN コストが
-- 増えるだけで得るものがない)。
--
-- NULL 可にする理由(重要): 「未索引」または「期間概念を持たない」を NULL で表す。
--   - PUT のたびに first/last を計算するが、壊れた RRULE・TZ 解決不能などで計算に失敗したら
--     null/null を書く(occurrence-bounds.ts の契約: throw せず null/null を返す)。
--   - VTODO で DTSTART/DUE/COMPLETED/CREATED が全部欠落している場合も null/null
--     (RFC 4791 §9.9 の VTODO 実効値表: 該当プロパティが全て欠落している行は
--     「常に time-range にマッチする(TRUE)」。NULL を「常に候補に含める」向きに
--     SQL 側で扱うことで、この表の最終行と結果的に一致させられる)。
-- D1CalendarObjectResourceRepository.findInCollectionByTimeRange の WHERE 句は
--   (last_occurrence IS NULL OR last_occurrence > ?) AND (first_occurrence IS NULL OR first_occurrence < ?)
-- という形にする — NULL 列は常に条件を満たす(=絞り込まれない)ので、「索引が無い/引けない」
-- リソースを取りこぼす事故を防ぐ。正しさの最終的な担保は SQL ではなく application 層の
-- expandRecurrenceSet による再判定であり、SQL 側の絞り込みが甘い(過剰包含)だけなら
-- 結果の正しさには影響しない(性能上の最適化に過ぎない)。
--
-- 既存行のバックフィルはしない。既存行は NULL のまま = 「常に候補」として安全側に倒れる
-- (取りこぼしは起きない。次回 PUT で埋まる)。運用中の calendar_objects が非常に大きい
-- 場合にバックフィルバッチを足すことは将来検討するが、確定設計メモのスコープ外(G-3 では
-- 「スキーマファイル追加とコードのみ、D1 適用は不要」)。
--
-- 複合索引の効き方: (owner, collection_id, first_occurrence, last_occurrence) の順にしたのは
-- WHERE 句が常に owner + collection_id の等値条件から始まり(コレクション単位のクエリ)、
-- その後 first/last の範囲条件が続くため。owner/collection_id で絞ってから範囲条件を評価する
-- 木構造になるので、コレクションが分かれていれば索引はコレクションごとに小さく効率よく効く。
-- =============================================================================

ALTER TABLE calendar_objects ADD COLUMN first_occurrence INTEGER;
ALTER TABLE calendar_objects ADD COLUMN last_occurrence INTEGER;

CREATE INDEX calendar_objects_time_range
  ON calendar_objects(owner, collection_id, first_occurrence, last_occurrence);
