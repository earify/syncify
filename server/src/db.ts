import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS vault_counters (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id),
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_vault_deleted ON files(vault_id, deleted);
CREATE TABLE IF NOT EXISTS changes (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL,
  size INTEGER,
  mtime INTEGER,
  hash TEXT,
  version INTEGER NOT NULL,
  from_path TEXT,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_changes_vault_seq ON changes(vault_id, seq);
CREATE TABLE IF NOT EXISTS shares (
  share_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_vault ON shares(vault_id);
CREATE INDEX IF NOT EXISTS idx_shares_enabled ON shares(enabled);
CREATE TABLE IF NOT EXISTS trash (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  trash_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path, deleted_at)
);
`;

export class Db {
  public readonly db: DatabaseSync;

  constructor(path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    const v = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    if (!v) this.db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  integrityCheck(): boolean {
    const row = this.db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    return !!row && Object.values(row)[0] === "ok";
  }
}

export function openDb(dataDir: string): Db {
  return new Db(`${dataDir}/database/eari-sync.sqlite`);
}
