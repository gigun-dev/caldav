-- =============================================================================
-- R2: ソフトデリート(deleted_at + restore)— docs/modeling/15 §A-3 R2
-- =============================================================================
--
-- 【このマイグレーションが入れる変更】
--   1. calendar_objects に `deleted_at INTEGER NULL` を足す(tombstone 時刻・エポック ms)。
--      NULL = 生きている行、非 NULL = ソフトデリート済み(= restore 可能な「ゴミ箱」)。
--   2. UID 一意性を **partial unique index(WHERE deleted_at IS NULL)** に張り替える。
--      これにより「ソフトデリート後に同じ UID を再作成する」ことが合法になる
--      (docs/next-directions.md「2026-07-23 R2 RFC 検証完了」: RFC 4791 の UID 一意性は
--       "stored / in use" 空間の話であり、tombstone 済みの行は in use ではない。partial
--       unique index 案は適合、と原文照合で裏取り済み)。
--
-- 【なぜ URI 一意性(PRIMARY KEY)は partial にしないのか — 前方互換の判断】
-- タスク仕様は「UID/URI の uniqueness を partial unique index へ張り替え」と書くが、
-- URI 側は **PRIMARY KEY (owner, collection_id, uri) を全一意のまま維持** する。理由:
--   - 現在デプロイ済みのコードは overwrite(無条件上書き)経路で
--     `INSERT ... ON CONFLICT(owner, collection_id, uri) DO UPDATE` を発行する
--     (repositories.ts saveResource)。SQLite の ON CONFLICT の衝突ターゲットは、
--     WHERE 句を持たない `ON CONFLICT(cols)` では **partial unique index に一致しない**
--     (partial は `ON CONFLICT(cols) WHERE ...` の明示が要る)。URI を partial 化すると
--     旧コードの UPSERT が「一致する制約が無い」で実行時エラーになり、migrations/README の
--     前方互換規律(migrate 先行でも旧コードが壊れないこと)を破る。
--   - URI 再利用の要件(仕様 #4: ソフトデリート済み URI へ新規 PUT すると旧ゴーストが
--     restore 一覧に「同 URI の亡霊」として残る)は、**新規 PUT 時に旧ゴーストの uri を
--     退避 rename する**ことで満たす(repositories.ts saveResource の rename 文)。PK が
--     全一意でも、ゴーストを別 uri へ逃がしてから新行を INSERT すれば衝突しない。
-- したがって URI は PK 全一意 + ゴースト rename、UID は partial unique の非対称構成にする。
-- (この非対称は artisan の設計判断。RFC 検証済み要件の核は UID 側の partial 化であり、
--  URI の "unmapped 化" は rename で担保する。親へ論点として申し送る。)
--
-- 【なぜ 12-step テーブル再作成が要るのか】
-- deleted_at 列の追加(ADD COLUMN・NULL 可)は前方互換だが、既存の
-- `UNIQUE (owner, collection_id, uid)` **テーブル制約** を外す(= UID を index 側へ移す)
-- には SQLite の制約上テーブル再作成が要る(0003_vjournal.sql と同じ 12-step 手順。
-- SQLite は ALTER TABLE で制約の DROP をサポートしない)。
-- https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
--
-- 【前方互換(migrations/README 規律)の確認】
-- この再作成の「実効的なスキーマ差分」は (a) NULL 可の deleted_at 追加 (b) UID 一意性の
-- 全一意 → partial 化(= 緩める方向)の2点で、どちらも現在デプロイ済みコードと後方互換:
--   - 旧コードは INSERT 時に deleted_at を知らない → 既定 NULL が入り、partial unique index
--     の対象(生きている行)として従来どおり UID 一意性が効く。
--   - 旧コードの物理 DELETE は行を消すだけで、partial index も PK も無傷。
-- よって migrate がデプロイに先行しても旧コードは壊れない(README の expand フェーズ)。
--
-- 【0001+0002+0003 の最終形を完全再現する意図】
-- calendar_objects は 0001(基本列 + PK/UNIQUE/FK)→ 0002(first/last_occurrence + 索引)→
-- 0003(component_kind CHECK に VJOURNAL 追加)を経た。再作成では 0003 の最終形に
-- deleted_at を足し、UNIQUE(uid) 制約だけを index へ移す。列順は 0003 の SELECT * コピーと
-- 同じ「0001 列 → 0002 追加列」の並びを保ち、末尾に deleted_at を足す。
--
-- 【D1 適用は deploy パイプライン(migrate→deploy)が自動で行う。ここはファイル追加のみ。】
-- =============================================================================

-- Step 1: 外部キー制約を一時的に無効化(テーブル再作成の SQLite 公式手順の前提)。
PRAGMA foreign_keys = OFF;

-- Step 2: 新テーブル。0003 の最終形 + deleted_at。UNIQUE(owner,collection_id,uid) は
-- 意図的に外す(partial unique index へ移すため)。PK(uri)は全一意のまま維持。
CREATE TABLE calendar_objects_new (
  owner TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  etag TEXT NOT NULL,
  ics TEXT NOT NULL,
  component_kind TEXT NOT NULL CHECK (component_kind IN ('VEVENT', 'VTODO', 'VJOURNAL')),
  uid TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  first_occurrence INTEGER,
  last_occurrence INTEGER,
  -- R2: tombstone 時刻(エポック ms)。NULL = 生存、非 NULL = ソフトデリート済み。
  deleted_at INTEGER,
  PRIMARY KEY (owner, collection_id, uri),
  FOREIGN KEY (owner, collection_id)
    REFERENCES calendar_collections(owner, id) ON DELETE CASCADE
);

-- Step 3: 既存データを新テーブルへコピー。旧行はすべて生存扱い(deleted_at = NULL)。
-- 列順は上の CREATE TABLE と一致させ、deleted_at だけ NULL リテラルを補う
-- (SELECT * だと旧テーブルに deleted_at 列が無く列数がずれるため、明示列指定 + NULL)。
INSERT INTO calendar_objects_new
  (owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence, deleted_at)
SELECT
  owner, collection_id, uri, etag, ics, component_kind, uid, updated_at, first_occurrence, last_occurrence, NULL
FROM calendar_objects;

-- Step 4: 旧テーブルを破棄して新テーブルをリネーム。
DROP TABLE calendar_objects;
ALTER TABLE calendar_objects_new RENAME TO calendar_objects;

-- Step 5: 索引を再作成。
-- (a) UID の一意性 = **partial unique index**(生きている行のみ)。これが R2 の核心:
--     ソフトデリート済み行は対象外なので、同 UID の再作成が合法になる。
CREATE UNIQUE INDEX calendar_objects_uid_live
  ON calendar_objects(owner, collection_id, uid) WHERE deleted_at IS NULL;
-- (b) 0001 にあった非一意の UID 索引(検索用)。partial unique とは別に、全行(削除済み
--     含む)を引ける索引として残す。
CREATE INDEX calendar_objects_uid
  ON calendar_objects(owner, collection_id, uid);
-- (c) 0002 の time-range 索引(再作成で失われるため復元)。
CREATE INDEX calendar_objects_time_range
  ON calendar_objects(owner, collection_id, first_occurrence, last_occurrence);
-- (d) R2: list-deleted(ゴミ箱一覧)と物理 purge(30日 TTL)向けの索引。
--     list-deleted は owner スコープで deleted_at IS NOT NULL を deleted_at 降順に引く。
--     purge は deleted_at < cutoff を全 owner 横断で引くので、先頭列を deleted_at にした
--     索引も別に持たせる(owner を前置しない purge 用)。
CREATE INDEX calendar_objects_deleted
  ON calendar_objects(owner, deleted_at);
CREATE INDEX calendar_objects_purge
  ON calendar_objects(deleted_at);

-- Step 6: 外部キー制約を再度有効化。
PRAGMA foreign_keys = ON;
