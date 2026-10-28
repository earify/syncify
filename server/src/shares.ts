import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { verifyVault } from "./vaults.js";
import { safeRelativePath } from "./paths.js";
import { vaultFilesDir, type RuntimeConfig } from "./config.js";
import { renderSharedPage } from "./html.js";

export interface ShareRow {
  share_id: string;
  vault_id: string;
  path: string;
  created_at: number;
  enabled: number;
  password_hash: string | null;
  revision: number;
}

export function genShareId(): string {
  return randomBytes(12).toString("base64url");
}

export function getBearerSecret(req: { headers: Record<string, unknown> }): string {
  const h = req.headers["authorization"] || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] as string).trim() : "";
}

export function createShare(db: Db, vaultId: string, relPath: string): ShareRow {
  const existing = db.db
    .prepare("SELECT * FROM shares WHERE vault_id = ? AND path = ?")
    .get(vaultId, relPath) as unknown as ShareRow | undefined;
  if (existing) {
    db.db.prepare("UPDATE shares SET enabled = 1 WHERE share_id = ?").run(existing.share_id);
    return db.db.prepare("SELECT * FROM shares WHERE share_id = ?").get(existing.share_id) as unknown as ShareRow;
  }
  const shareId = genShareId();
  db.db
    .prepare(
      "INSERT INTO shares (share_id, vault_id, path, created_at, enabled, password_hash, revision) VALUES (?,?,?,?,?,?,?)",
    )
    .run(shareId, vaultId, relPath, Date.now(), 1, null, 0);
  return db.db.prepare("SELECT * FROM shares WHERE share_id = ?").get(shareId) as unknown as ShareRow;
}

export function listShares(db: Db, vaultId: string): ShareRow[] {
  return db.db
    .prepare("SELECT * FROM shares WHERE vault_id = ? ORDER BY created_at DESC")
    .all(vaultId) as unknown as ShareRow[];
}

export function setEnabled(db: Db, vaultId: string, shareId: string, enabled: boolean): boolean {
  const r = db.db
    .prepare("UPDATE shares SET enabled = ? WHERE share_id = ? AND vault_id = ?")
    .run(enabled ? 1 : 0, shareId, vaultId);
  return r.changes > 0;
}

export function deleteShare(db: Db, vaultId: string, shareId: string): boolean {
  const r = db.db.prepare("DELETE FROM shares WHERE share_id = ? AND vault_id = ?").run(shareId, vaultId);
  return r.changes > 0;
}

export function resolveShare(db: Db, shareId: string): ShareRow | undefined {
  const r = db.db.prepare("SELECT * FROM shares WHERE share_id = ?").get(shareId);
  return r ? (r as unknown as ShareRow) : undefined;
}

function safeFileName(p: string): string {
  const parts = p.split("/");
  return (parts[parts.length - 1] || "note.md").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function registerShareRoutes(app: any, cfg: RuntimeConfig, db: Db): void {
  app.post("/api/v1/vaults/:vaultId/shares", async (req: any, reply: any) => {
    const { vaultId } = req.params;
    const secret = getBearerSecret(req);
    if (!verifyVault(db, vaultId, secret)) return reply.code(401).send({ error: "unauthorized" });
    const body: any = req.body ?? {};
    if (typeof body.path !== "string") return reply.code(400).send({ error: "path required" });
    let path: string;
    try {
      path = safeRelativePath(body.path);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const vdir = vaultFilesDir(cfg.dataDir, vaultId);
    if (!existsSync(join(vdir, path))) {
      return reply.code(404).send({ error: "file does not exist on server - sync it first" });
    }
    const share = createShare(db, vaultId, path);
    return { shareId: share.share_id, path: share.path, createdAt: share.created_at, enabled: !!share.enabled };
  });

  app.get("/api/v1/vaults/:vaultId/shares", async (req: any, reply: any) => {
    const { vaultId } = req.params;
    const secret = getBearerSecret(req);
    if (!verifyVault(db, vaultId, secret)) return reply.code(401).send({ error: "unauthorized" });
    return listShares(db, vaultId).map((r) => ({
      shareId: r.share_id,
      path: r.path,
      createdAt: r.created_at,
      enabled: !!r.enabled,
    }));
  });

  app.patch("/api/v1/vaults/:vaultId/shares/:shareId", async (req: any, reply: any) => {
    const { vaultId, shareId } = req.params;
    const secret = getBearerSecret(req);
    if (!verifyVault(db, vaultId, secret)) return reply.code(401).send({ error: "unauthorized" });
    const body: any = req.body ?? {};
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
    const ok = setEnabled(db, vaultId, shareId, enabled);
    if (!ok) return reply.code(404).send({ error: "share not found" });
    return { shareId, enabled };
  });

  app.delete("/api/v1/vaults/:vaultId/shares/:shareId", async (req: any, reply: any) => {
    const { vaultId, shareId } = req.params;
    const secret = getBearerSecret(req);
    if (!verifyVault(db, vaultId, secret)) return reply.code(401).send({ error: "unauthorized" });
    const ok = deleteShare(db, vaultId, shareId);
    if (!ok) return reply.code(404).send({ error: "share not found" });
    return reply.code(204).send();
  });

  app.get("/share/:shareId", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const { shareId } = req.params;
    const share = resolveShare(db, shareId);
    if (!share || !share.enabled) return reply.code(404).send({ error: "not found" });
    const vdir = vaultFilesDir(cfg.dataDir, share.vault_id);
    if (!vdir || !share.path) return reply.code(404).send({ error: "not found" });
    const full = join(vdir, share.path);
    if (!existsSync(full)) return reply.code(404).send({ error: "file missing" });
    let content = "";
    try {
      content = readFileSync(full, "utf8");
    } catch {
      return reply.code(404).send({ error: "file missing" });
    }
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(renderSharedPage(share.path, content));
  });

  app.get("/share/:shareId/raw", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const { shareId } = req.params;
    const share = resolveShare(db, shareId);
    if (!share || !share.enabled) return reply.code(404).send({ error: "not found" });
    const vdir = vaultFilesDir(cfg.dataDir, share.vault_id);
    const full = join(vdir, share.path);
    if (!existsSync(full)) return reply.code(404).send({ error: "file missing" });
    let content = "";
    try {
      content = readFileSync(full, "utf8");
    } catch {
      return reply.code(404).send({ error: "file missing" });
    }
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", "inline; filename=" + safeFileName(share.path));
    return reply.send(content);
  });
}
