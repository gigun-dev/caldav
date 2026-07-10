-- CalDAV の集約を D1 に保存する初期スキーマ。
-- owner と collection_id を全テーブルのキーに含め、将来のマルチユーザー化でも
-- 別プリンシパルのリソースが混ざらないことを DB 制約でも保証する。
PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  principal_path TEXT PRIMARY KEY,
  calendar_home_set TEXT NOT NULL
);

CREATE TABLE calendar_collections (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  supported_components TEXT,
  color TEXT,
  order_number INTEGER,
  sync_counter INTEGER NOT NULL DEFAULT 0 CHECK (sync_counter >= 0),
  PRIMARY KEY (owner, id),
  FOREIGN KEY (owner) REFERENCES principals(principal_path) ON DELETE CASCADE
);

CREATE TABLE calendar_objects (
  owner TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  etag TEXT NOT NULL,
  ics TEXT NOT NULL,
  component_kind TEXT NOT NULL CHECK (component_kind IN ('VEVENT', 'VTODO')),
  uid TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, collection_id, uri),
  UNIQUE (owner, collection_id, uid),
  FOREIGN KEY (owner, collection_id)
    REFERENCES calendar_collections(owner, id) ON DELETE CASCADE
);

CREATE TABLE sync_changes (
  owner TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  token INTEGER NOT NULL CHECK (token > 0),
  uri TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'modified', 'deleted')),
  PRIMARY KEY (owner, collection_id, token),
  FOREIGN KEY (owner, collection_id)
    REFERENCES calendar_collections(owner, id) ON DELETE CASCADE
);

CREATE INDEX calendar_objects_uid
  ON calendar_objects(owner, collection_id, uid);
CREATE INDEX sync_changes_since
  ON sync_changes(owner, collection_id, token);
