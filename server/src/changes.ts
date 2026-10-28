import type { Db } from "./db.js";
import type { Change, Op } from "@syncify/shared";
import { getSeq, incrementSeq } from "./vaults.js";

export function recordChange(
  db: Db,
  vaultId: string,
  change: Omit<Change, "seq" | "createdAt"> & { createdAt?: number },
): Change {
  const seq = incrementSeq(db, vaultId);
  const createdAt = change.createdAt ?? Date.now();
  const c: Change = {
    seq,
    path: change.path,
    op: change.op,
    size: change.size,
    mtime: change.mtime,
    hash: change.hash,
    version: change.version,
    fromPath: change.fromPath,
    clientId: change.clientId,
    createdAt,
  };
  db.db
    .prepare(
      `INSERT INTO changes(vault_id,seq,path,op,size,mtime,hash,version,from_path,client_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      vaultId,
      seq,
      c.path,
      c.op,
      c.size ?? null,
      c.mtime ?? null,
      c.hash ?? null,
      c.version,
      c.fromPath ?? null,
      c.clientId ?? null,
      createdAt,
    );
  return c;
}

export function listChangesSince(
  db: Db,
  vaultId: string,
  since: number,
  limit = 500,
): { changes: Change[]; currentSeq: number; hasMore: boolean } {
  const rows = db.db
    .prepare(`SELECT * FROM changes WHERE vault_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(vaultId, since, limit + 1) as any[];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const changes: Change[] = slice.map((r) => ({
    seq: r.seq,
    path: r.path,
    op: r.op as Op,
    size: r.size ?? undefined,
    mtime: r.mtime ?? undefined,
    hash: r.hash ?? undefined,
    version: r.version,
    fromPath: r.from_path ?? undefined,
    clientId: r.client_id ?? undefined,
    createdAt: r.created_at,
  }));
  const currentSeq = getSeq(db, vaultId);
  return { changes, currentSeq, hasMore };
}

export function getFileRow(db: Db, vaultId: string, path: string): any {
  return db.db.prepare("SELECT * FROM files WHERE vault_id = ? AND path = ?").get(vaultId, path);
}

export function upsertFileRow(
  db: Db,
  vaultId: string,
  path: string,
  meta: { size: number; mtime: number; hash: string; version: number; updatedBy?: string; deleted?: boolean },
): void {
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO files(vault_id,path,size,mtime,hash,version,deleted,updated_at,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vault_id,path) DO UPDATE SET
         size=excluded.size, mtime=excluded.mtime, hash=excluded.hash,
         version=excluded.version, deleted=excluded.deleted, updated_at=excluded.updated_at,
         updated_by=excluded.updated_by`,
    )
    .run(
      vaultId,
      path,
      meta.size,
      meta.mtime,
      meta.hash,
      meta.version,
      meta.deleted ? 1 : 0,
      now,
      meta.updatedBy ?? null,
    );
}

export function markDeleted(db: Db, vaultId: string, path: string, version: number, updatedBy?: string): void {
  db.db
    .prepare(`UPDATE files SET deleted=1, version=?, updated_at=?, updated_by=? WHERE vault_id=? AND path=?`)
    .run(version, Date.now(), updatedBy ?? null, vaultId, path);
}

export function listLiveFiles(db: Db, vaultId: string): any[] {
  return db.db
    .prepare(`SELECT path, size, mtime, hash, version FROM files WHERE vault_id = ? AND deleted = 0 ORDER BY path`)
    .all(vaultId) as any[];
}
