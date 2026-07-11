-- =============================================================================
-- J-1: VJOURNAL を calendar_objects.component_kind の CHECK 制約に追加
-- =============================================================================
--
-- 【なぜテーブル再作成(12-step)が要るのか】
-- SQLite/D1 は `ALTER TABLE ... DROP CONSTRAINT` も CHECK 制約の書き換えも直接サポートしない
-- (SQLite の ALTER TABLE は列追加・列リネーム・テーブルリネーム程度しかできない)。
-- CHECK (component_kind IN ('VEVENT', 'VTODO')) を ('VEVENT', 'VTODO', 'VJOURNAL') に
-- 広げるには、SQLite 公式が案内する「12-step」手順(新テーブルを作って中身を移し、
-- 旧テーブルを捨てて新テーブルをリネームする)を踏むしかない。
-- https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
--
-- 【0001 + 0002 の定義を完全再現する意図】
-- calendar_objects は 0001_init.sql で作られたあと 0002_occurrence_index.sql で
-- first_occurrence / last_occurrence 列と calendar_objects_time_range 索引を ALTER で
-- 追加されている。再作成にあたっては、0001 の列定義(PRIMARY KEY / UNIQUE / FOREIGN KEY を
-- 含む)と 0002 の追加列・追加索引を「両方とも」漏れなく再現しないと、過去のマイグレーション
-- が入れた制約や索引が静かに失われてしまう(その場に居合わせないと気づけない事故)。
-- そのため以下の新テーブル定義は 0001+0002 の calendar_objects の最終形そのものに
-- component_kind の CHECK だけを変えたもの。
--
-- 【既存データの保全】
-- 本番 D1(dogfooding 運用)には既に calendar_objects 行がある前提。DROP TABLE 前に
-- INSERT ... SELECT で全行を新テーブルへコピーする(列順を厳密に元テーブルへ合わせる —
-- SELECT * の列順は CREATE TABLE の列定義順に従うので、新旧の列定義順を一致させておけば
-- 単純な `INSERT INTO new SELECT * FROM old` で安全にコピーできる)。
--
-- 【D1 適用は本タスクのスコープ外】
-- J-1 は「ファイル追加 + コードのみ」(完了条件)。このマイグレーションを実際に
-- `wrangler d1 migrations apply` するのは別途の作業。
-- =============================================================================

-- Step 1: 外部キー制約を一時的に無効化(テーブル再作成中は整合性チェックを止める。
-- SQLite 公式手順の前提条件)。
PRAGMA foreign_keys = OFF;

-- Step 2〜4: 新テーブルを作成(0001 の列定義 + 0002 の追加列を完全再現、CHECK だけ拡張)。
CREATE TABLE calendar_objects_new (
  owner TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  etag TEXT NOT NULL,
  ics TEXT NOT NULL,
  -- ここが今回の変更点: VJOURNAL を受理する種別に追加。
  component_kind TEXT NOT NULL CHECK (component_kind IN ('VEVENT', 'VTODO', 'VJOURNAL')),
  uid TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 0002 で ALTER TABLE ADD COLUMN された2列(NULL 可の意味は 0002 冒頭コメント参照)。
  first_occurrence INTEGER,
  last_occurrence INTEGER,
  PRIMARY KEY (owner, collection_id, uri),
  UNIQUE (owner, collection_id, uid),
  FOREIGN KEY (owner, collection_id)
    REFERENCES calendar_collections(owner, id) ON DELETE CASCADE
);

-- Step 5: 既存データを新テーブルへコピー。列順は上の CREATE TABLE 定義順と一致させてある
-- (0001 の列 → 0002 で追加された列、という並びを保持)ので SELECT * で安全に移せる。
INSERT INTO calendar_objects_new
SELECT owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence
FROM calendar_objects;

-- Step 6: 旧テーブルを破棄。
DROP TABLE calendar_objects;

-- Step 7: 新テーブルを本来の名前へリネーム。
ALTER TABLE calendar_objects_new RENAME TO calendar_objects;

-- Step 8〜9: 0001/0002 で定義されていた索引を再作成(テーブル再作成で失われるため)。
CREATE INDEX calendar_objects_uid
  ON calendar_objects(owner, collection_id, uid);
CREATE INDEX calendar_objects_time_range
  ON calendar_objects(owner, collection_id, first_occurrence, last_occurrence);

-- Step 10: 外部キー制約を再度有効化。
PRAGMA foreign_keys = ON;
