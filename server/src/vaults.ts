import type { Db } from "./db.js";
import { hashSecret, verifySecret } from "./auth.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { vaultFilesDir, vaultStagingDir, vaultTrashDir } from "./config.js";

export interface VaultRow {
  id: string;
  secret_hash: string;
  created_at: number;
  settings_json: string;
}

export function createVault(db: Db, dataDir: string, id: string, secret: string): { id: string; secret: string } {
  const now = Date.now();
  db.transaction(() => {
    db.db
      .prepare("INSERT INTO vaults(id, secret_hash, created_at, settings_json) VALUES (?,?,?,?)")
      .run(id, hashSecret(secret), now, "{}");
    db.db.prepare("INSERT INTO vault_counters(vault_id, seq) VALUES (?,0)").run(id);
  });
  for (const d of [vaultFilesDir(dataDir, id), vaultStagingDir(dataDir, id), vaultTrashDir(dataDir, id)]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return { id, secret };
}

export function getVault(db: Db, id: string): VaultRow | undefined {
  return db.db.prepare("SELECT * FROM vaults WHERE id = ?").get(id) as VaultRow | undefined;
}

export function verifyVault(db: Db, id: string, secret: string): boolean {
  const v = getVault(db, id);
  if (!v) return false;
  return verifySecret(secret, v.secret_hash);
}

export function rotateSecret(db: Db, id: string, newSecret: string): void {
  const v = getVault(db, id);
  if (!v) throw new Error("vault not found");
  db.db.prepare("UPDATE vaults SET secret_hash = ? WHERE id = ?").run(hashSecret(newSecret), id);
}

export function deleteVault(db: Db, id: string): void {
  db.transaction(() => {
    db.db.prepare("DELETE FROM trash WHERE vault_id = ?").run(id);
    db.db.prepare("DELETE FROM changes WHERE vault_id = ?").run(id);
    db.db.prepare("DELETE FROM files WHERE vault_id = ?").run(id);
    db.db.prepare("DELETE FROM vault_counters WHERE vault_id = ?").run(id);
    db.db.prepare("DELETE FROM vaults WHERE id = ?").run(id);
  });
}

export function listVaults(db: Db): string[] {
  const rows = db.db.prepare("SELECT id FROM vaults ORDER BY id").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getSeq(db: Db, vaultId: string): number {
  const row = db.db.prepare("SELECT seq FROM vault_counters WHERE vault_id = ?").get(vaultId) as
    | { seq: number }
    | undefined;
  return row ? row.seq : 0;
}

export function incrementSeq(db: Db, vaultId: string): number {
  db.db.prepare("UPDATE vault_counters SET seq = seq + 1 WHERE vault_id = ?").run(vaultId);
  return getSeq(db, vaultId);
}
