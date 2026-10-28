import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { existsSync, createReadStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dbPath,
  defaultDataDir,
  ensureDataDirs,
  loadConfig,
  saveConfig,
  vaultFilesDir,
  vaultStagingDir,
  vaultTrashDir,
  type RuntimeConfig,
} from "./config.js";
import { openDb, type Db } from "./db.js";
import { createVault, getSeq, listVaults, rotateSecret, verifyVault } from "./vaults.js";
import { getFileRow, listChangesSince, listLiveFiles, markDeleted, recordChange, upsertFileRow } from "./changes.js";
import {
  createReadStream as _crs,
  deleteFilePhysical,
  fileExists,
  moveFilePhysical,
  sha256Buffer,
  writeAtomic,
} from "./files.js";
import { safeRelativePath } from "./paths.js";
import { registerShareRoutes } from "./shares.js";
import type { WsMessage } from "@syncify/shared";

const WS_CLIENTS = new Map<string, Set<any>>();

function getSecret(req: any): string {
  const h = req.headers["authorization"] || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function broadcast(vaultId: string, seq: number, excludeCid?: string): void {
  const set = WS_CLIENTS.get(vaultId);
  if (!set) return;
  const msg = JSON.stringify({ type: "change", vaultId, seq } satisfies WsMessage);
  for (const ws of set) {
    if (excludeCid && ws.cid === excludeCid) continue;
    try {
      ws.send(msg);
    } catch {}
  }
}

export async function buildServer(cfg: RuntimeConfig, db: Db) {
  let httpsOpts: any;
  if (cfg.certPath && cfg.keyPath && existsSync(cfg.certPath) && existsSync(cfg.keyPath)) {
    httpsOpts = { cert: readFileSync(cfg.certPath), key: readFileSync(cfg.keyPath) };
    console.log("HTTPS enabled using", cfg.certPath);
  } else {
    console.warn("WARNING: no TLS cert configured; running HTTP (dev only).");
  }
  const app = Fastify({ logger: { level: cfg.logLevel }, bodyLimit: 1024 * 1024 * 1024, https: httpsOpts });

  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // ---- health / misc -------------------------------------------------------
  app.get("/health", async () => ({ ok: true, time: Date.now(), server: "syncify" }));

  app.get("/ca.crt", async (_req, reply) => {
    if (!cfg.caCertPath || !existsSync(cfg.caCertPath)) return reply.code(404).send({ error: "no CA configured" });
    reply.header("Content-Type", "application/x-x509-ca-cert");
    reply.header("Content-Disposition", 'attachment; filename="syncify-ca.crt"');
    return reply.send(readFileSync(cfg.caCertPath));
  });

  // ---- auth ----------------------------------------------------------------
  app.post(
    "/api/v1/auth/test",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const vaultId = (req.headers["x-vault-id"] as string) || (req.body as any)?.vaultId;
      const secret = getSecret(req) || (req.body as any)?.secret;
      if (!vaultId || !secret) return reply.code(400).send({ error: "missing vaultId/secret" });
      if (!(await verifyVault(db, vaultId, secret))) return reply.code(401).send({ error: "unauthorized" });
      return reply.code(204).send();
    },
  );

  // ---- vault meta ------------------------------------------------------------
  app.get("/api/v1/vaults/:vaultId/meta", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const files = db.db.prepare("SELECT COUNT(*) as c FROM files WHERE vault_id=? AND deleted=0").get(vaultId) as any;
    const trash = db.db.prepare("SELECT COUNT(*) as c FROM trash WHERE vault_id=?").get(vaultId) as any;
    return { vaultId, seq: getSeq(db, vaultId), fileCount: files?.c ?? 0, trashCount: trash?.c ?? 0 };
  });

  // ---- changes ---------------------------------------------------------------
  app.get("/api/v1/vaults/:vaultId/changes", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const q = req.query as any;
    const since = Number(q.since ?? 0);
    const limit = Math.min(Number(q.limit ?? 500), 2000);
    const res = listChangesSince(db, vaultId, since, limit);
    return {
      changes: res.changes,
      nextSeq: res.changes.length ? res.changes[res.changes.length - 1].seq : since,
      hasMore: res.hasMore,
      currentSeq: res.currentSeq,
    };
  });

  // ---- file listing (new: enables reliable full resync) ----------------------
  app.get("/api/v1/vaults/:vaultId/files", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    return listLiveFiles(db, vaultId);
  });

  // ---- download --------------------------------------------------------------
  app.get("/api/v1/vaults/:vaultId/files/*", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const rel = (req.params as any)["*"];
    let path: string;
    try {
      path = safeRelativePath(rel);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    if (!fileExists(vdir, path)) return reply.code(404).send({ error: "not found" });
    const row = getFileRow(db, vaultId, path);
    const full = join(vdir, path);
    reply.header("X-Hash", row?.hash ?? "");
    reply.header("X-Version", String(row?.version ?? 0));
    reply.header("X-Mtime", String(row?.mtime ?? 0));
    reply.header("X-Size", String(row?.size ?? 0));
    reply.type("application/octet-stream");
    return reply.send(createReadStream(full));
  });

  // ---- upload ----------------------------------------------------------------
  app.put("/api/v1/vaults/:vaultId/files/*", async (req, reply) => {
    const { vaultId } = req.params as any;
    const secret = getSecret(req);
    if (!(await verifyVault(db, vaultId, secret))) return reply.code(401).send({ error: "unauthorized" });
    const rel = (req.params as any)["*"];
    let path: string;
    try {
      path = safeRelativePath(rel);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const baseVersion = Number(req.headers["x-base-version"] ?? 0);
    const mtime = Number(req.headers["x-mtime"] ?? Date.now());
    const clientHash = (req.headers["x-hash"] as string) || "";
    const clientId = (req.headers["x-client-id"] as string) || "";

    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    const existing = getFileRow(db, vaultId, path);

    // deleted-on-server guard: stale client must not resurrect.
    if (existing && existing.deleted === 1) {
      const seenDelete = Number(req.headers["x-seen-delete-version"] ?? 0);
      if (!(seenDelete && seenDelete >= existing.version)) {
        return reply.code(409).send({
          error: "conflict",
          deleted: true,
          path,
          serverVersion: existing.version,
          clientVersion: baseVersion,
        });
      }
    }

    const bodyBuf = req.body as Buffer;
    if (!Buffer.isBuffer(bodyBuf)) return reply.code(400).send({ error: "expected binary body" });
    const contentHash = sha256Buffer(bodyBuf);
    if (clientHash && clientHash !== contentHash) return reply.code(400).send({ error: "hash mismatch" });

    // idempotent no-op when identical content is already stored
    if (existing && existing.deleted === 0 && existing.hash === contentHash) {
      return { path, version: existing.version, seq: getSeq(db, vaultId), status: "unchanged" };
    }

    // conflict: server has newer different content
    if (existing && existing.deleted === 0 && baseVersion && existing.version !== baseVersion) {
      return reply.code(409).send({
        error: "conflict",
        path,
        serverVersion: existing.version,
        serverHash: existing.hash,
        serverSize: existing.size,
        serverMtime: existing.mtime,
        clientVersion: baseVersion,
      });
    }

    const newVersion = (existing?.version ?? 0) + 1;
    const res = await writeAtomic(vdir, path, bodyBuf, mtime);

    db.transaction(() => {
      upsertFileRow(db, vaultId, path, {
        size: res.size,
        mtime,
        hash: res.hash,
        version: newVersion,
        updatedBy: clientId,
        deleted: false,
      });
      const op: "create" | "modify" = existing && existing.deleted === 0 ? "modify" : "create";
      recordChange(db, vaultId, { path, op, size: res.size, mtime, hash: res.hash, version: newVersion, clientId });
    });

    const seq = getSeq(db, vaultId);
    broadcast(vaultId, seq, clientId);
    return { path, version: newVersion, seq, status: existing && existing.deleted === 0 ? "updated" : "created" };
  });

  // ---- delete ----------------------------------------------------------------
  app.delete("/api/v1/vaults/:vaultId/files/*", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const rel = (req.params as any)["*"];
    let path: string;
    try {
      path = safeRelativePath(rel);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const baseVersion = Number((req.query as any).baseVersion ?? 0);
    const clientId = (req.headers["x-client-id"] as string) || "";
    const existing = getFileRow(db, vaultId, path);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (existing.deleted === 1) return reply.code(204).send();

    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    const tdir = vaultTrashDir(cfg.dataDir, vaultId);
    const trashName = `${Date.now()}-${path.replace(/\//g, "_")}`;
    const trashPath = join(tdir, trashName);
    if (!existsSync(tdir)) mkdirSync(tdir, { recursive: true });
    if (fileExists(vdir, path)) {
      mkdirSync(dirname(trashPath), { recursive: true });
      renameSync(join(vdir, path), trashPath);
    }
    const newVersion = existing.version + 1;
    const now = Date.now();
    const retentionDays = 30;
    db.transaction(() => {
      markDeleted(db, vaultId, path, newVersion, clientId);
      db.db
        .prepare(
          `INSERT INTO trash(vault_id,path,version,size,hash,deleted_at,trash_path,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(vaultId, path, newVersion, existing.size, existing.hash, now, trashPath, now + retentionDays * 86400000);
      recordChange(db, vaultId, {
        path,
        op: "delete",
        size: existing.size,
        mtime: existing.mtime,
        hash: existing.hash,
        version: newVersion,
        clientId,
      });
    });
    const seq = getSeq(db, vaultId);
    broadcast(vaultId, seq, clientId);
    return { path, version: newVersion, seq };
  });

  // ---- move ----------------------------------------------------------------
  app.post("/api/v1/vaults/:vaultId/move", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body as any;
    let from: string;
    let to: string;
    try {
      from = safeRelativePath(body.from);
      to = safeRelativePath(body.to);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const baseVersion = Number(body.baseVersion ?? 0);
    const clientId = (req.headers["x-client-id"] as string) || "";
    const existing = getFileRow(db, vaultId, from);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (getFileRow(db, vaultId, to)) return reply.code(409).send({ error: "destination exists" });
    if (baseVersion && existing.version !== baseVersion) {
      return reply.code(409).send({
        error: "conflict",
        path: from,
        serverVersion: existing.version,
        clientVersion: baseVersion,
      });
    }
    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    moveFilePhysical(vdir, from, to);
    const newVersion = existing.version + 1;
    db.transaction(() => {
      db.db.prepare("DELETE FROM files WHERE vault_id=? AND path=?").run(vaultId, from);
      upsertFileRow(db, vaultId, to, {
        size: existing.size,
        mtime: existing.mtime,
        hash: existing.hash,
        version: newVersion,
        updatedBy: clientId,
        deleted: false,
      });
      recordChange(db, vaultId, {
        path: to,
        op: "move",
        size: existing.size,
        mtime: existing.mtime,
        hash: existing.hash,
        version: newVersion,
        fromPath: from,
        clientId,
      });
    });
    const seq = getSeq(db, vaultId);
    broadcast(vaultId, seq, clientId);
    return { from, to, version: newVersion, seq };
  });

  // ---- trash -----------------------------------------------------------------
  app.get("/api/v1/vaults/:vaultId/trash", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const rows = db.db
      .prepare("SELECT * FROM trash WHERE vault_id=? ORDER BY deleted_at DESC")
      .all(vaultId) as any[];
    return rows.map((r) => ({
      path: r.path,
      version: r.version,
      size: r.size,
      hash: r.hash,
      deletedAt: r.deleted_at,
      expiresAt: r.expires_at,
    }));
  });

  app.post("/api/v1/vaults/:vaultId/trash/restore", async (req, reply) => {
    const { vaultId } = req.params as any;
    if (!(await verifyVault(db, vaultId, getSecret(req)))) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body as any;
    let path: string;
    try {
      path = safeRelativePath(body.path);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const row = db.db
      .prepare("SELECT * FROM trash WHERE vault_id=? AND path=? ORDER BY deleted_at DESC LIMIT 1")
      .get(vaultId, path) as any;
    if (!row) return reply.code(404).send({ error: "not in trash" });
    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    mkdirSync(dirname(join(vdir, path)), { recursive: true });
    if (existsSync(row.trash_path)) renameSync(row.trash_path, join(vdir, path));
    const newVersion = row.version + 1;
    db.transaction(() => {
      upsertFileRow(db, vaultId, path, {
        size: row.size,
        mtime: Date.now(),
        hash: row.hash,
        version: newVersion,
        deleted: false,
      });
      db.db.prepare("DELETE FROM trash WHERE vault_id=? AND path=? AND deleted_at=?").run(vaultId, path, row.deleted_at);
      recordChange(db, vaultId, {
        path,
        op: "create",
        size: row.size,
        mtime: Date.now(),
        hash: row.hash,
        version: newVersion,
        clientId: (req.headers["x-client-id"] as string) || "",
      });
    });
    const seq = getSeq(db, vaultId);
    broadcast(vaultId, seq, (req.headers["x-client-id"] as string) || "");
    return { path, version: newVersion, seq };
  });

  // ---- cleanup expired trash -------------------------------------------------
  app.get("/api/v1/maintenance/cleanup", async (req, reply) => {
    const secret = getSecret(req);
    const vaults = listVaults(db);
    if (!vaults.length) return { cleaned: 0 };
    // allow only if caller can auth at least one vault (admin-ish endpoint)
    let authorized = false;
    for (const v of vaults) if (verifyVault(db, v, secret)) authorized = true;
    if (!authorized) return reply.code(401).send({ error: "unauthorized" });
    let n = 0;
    for (const v of vaults) n += cleanupExpiredTrash(db, cfg.dataDir, v);
    return { cleaned: n };
  });

  // ---- WebSocket ---------------------------------------------------------------
  app.register(async (fastify) => {
    fastify.get("/api/v1/vaults/:vaultId/ws", { websocket: true }, (socket, req) => {
      const { vaultId } = req.params as any;
      const token = (req.query as any).token || getSecret(req);
      if (!verifyVault(db, vaultId, token)) {
        try {
          socket.send(JSON.stringify({ type: "auth_fail" } satisfies WsMessage));
        } catch {}
        socket.close();
        return;
      }
      (socket as any).cid = (req.query as any).cid || "";
      if (!WS_CLIENTS.has(vaultId)) WS_CLIENTS.set(vaultId, new Set());
      WS_CLIENTS.get(vaultId)!.add(socket);
      socket.send(JSON.stringify({ type: "auth_ok", vaultId, seq: getSeq(db, vaultId) } satisfies WsMessage));
      socket.on("message", (raw: any) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong" } satisfies WsMessage));
        } catch {}
      });
      socket.on("close", () => {
        WS_CLIENTS.get(vaultId)?.delete(socket);
      });
    });
  });

  registerShareRoutes(app, cfg, db);
  return app;
}

export function cleanupExpiredTrash(db: Db, _dataDir: string, vaultId: string): number {
  const rows = db.db
    .prepare("SELECT rowid AS rid, trash_path FROM trash WHERE expires_at < ?")
    .all(Date.now()) as any[];
  let n = 0;
  for (const r of rows) {
    try {
      if (r.trash_path && existsSync(r.trash_path)) rmSync(r.trash_path, { force: true });
    } catch {}
    db.db.prepare("DELETE FROM trash WHERE rowid = ?").run(r.rid);
    n++;
  }
  return n;
}

export { defaultDataDir, ensureDataDirs, loadConfig, saveConfig, openDb, dbPath, vaultFilesDir, vaultStagingDir, vaultTrashDir };
