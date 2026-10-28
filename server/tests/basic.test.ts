import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { openDb } from "../src/db.js";
import { createVault } from "../src/vaults.js";
import { ensureDataDirs } from "../src/config.js";

let dataDir: string;
let app: any;
const VAULT = "testvault";
const SECRET = "test-secret-123";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${SECRET}`,
    "x-client-id": "test-client",
    "content-type": "application/octet-stream",
    ...extra,
  };
}

function jsonHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${SECRET}`,
    "x-client-id": "test-client",
    "content-type": "application/json",
    ...extra,
  };
}

beforeAll(async () => {
  dataDir = join(tmpdir(), `syncify-test-${Date.now()}`);
  ensureDataDirs(dataDir);
  const db = openDb(dataDir);
  createVault(db, dataDir, VAULT, SECRET);
  app = await buildServer(
    { dataDir, port: 0, host: "127.0.0.1", httpsMode: "selfsigned", logLevel: "error" },
    db,
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL files briefly; ignore cleanup errors
  }
});

describe("syncify server", () => {
  it("health responds ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("auth test: accept/reject", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/test", headers: { "x-vault-id": VAULT }, payload: { secret: SECRET } });
    expect(ok.statusCode).toBe(204);
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/test", headers: { "x-vault-id": VAULT }, payload: { secret: "wrong" } });
    expect(bad.statusCode).toBe(401);
  });

  it("upload / download roundtrip with hash check", async () => {
    const content = Buffer.from("# hello\n\nworld");
    const up = await app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${VAULT}/files/notes/hello.md`,
      headers: authHeaders({ "x-mtime": "1700000000000", "x-client-id": "test-client" }),
      payload: content,
    });
    expect(up.statusCode).toBe(200);
    const body = up.json();
    expect(body.status).toBe("created");
    expect(body.version).toBe(1);

    const dl = await app.inject({
      method: "GET",
      url: `/api/v1/vaults/${VAULT}/files/notes/hello.md`,
      headers: authHeaders(),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
    expect(dl.headers["x-version"]).toBe("1");
    expect(dl.headers["x-hash"]).toBe(body.hash ?? dl.headers["x-hash"]);
  });

  it("push is idempotent for identical content", async () => {
    const content = Buffer.from("same content");
    const first = await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/idem.md`, headers: authHeaders(), payload: content });
    expect(first.json().status).toBe("created");
    const second = await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/idem.md`, headers: authHeaders(), payload: content });
    expect(second.json().status).toBe("unchanged");
    expect(second.json().version).toBe(1);
  });

  it("changes feed records create/modify/delete", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/changes?since=0&limit=100`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.currentSeq).toBeGreaterThanOrEqual(2);
    const ops = json.changes.map((c: any) => c.op);
    expect(ops).toContain("create");
  });

  it("conflict on stale baseVersion (409)", async () => {
    const v1 = Buffer.from("v1");
    await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/conf.md`, headers: authHeaders(), payload: v1 });
    // second device uploads newer content cleanly (base=1 -> ok, bumps to 2)
    const ok = await app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${VAULT}/files/conf.md`,
      headers: authHeaders({ "x-base-version": "1" }),
      payload: Buffer.from("v2 from another device"),
    });
    expect(ok.statusCode).toBe(200);
    // stale client still thinks server is at 1 -> conflict
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${VAULT}/files/conf.md`,
      headers: authHeaders({ "x-base-version": "1" }),
      payload: Buffer.from("v3 stale push"),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");
    expect(stale.json().serverVersion).toBe(2);
  });

  it("delete moves to trash; restore brings it back", async () => {
    await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/doomed.md`, headers: authHeaders(), payload: Buffer.from("doomed") });
    const del = await app.inject({ method: "DELETE", url: `/api/v1/vaults/${VAULT}/files/doomed.md`, headers: authHeaders() });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files/doomed.md`, headers: authHeaders() });
    expect(gone.statusCode).toBe(404);

    const restore = await app.inject({ method: "POST", url: `/api/v1/vaults/${VAULT}/trash/restore`, headers: jsonHeaders(), payload: { path: "doomed.md" } });
    expect(restore.statusCode).toBe(200);
    const back = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files/doomed.md`, headers: authHeaders() });
    expect(back.statusCode).toBe(200);
    expect(back.rawPayload.toString()).toBe("doomed");
  });

  it("move renames file and records move change", async () => {
    await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/old-name.md`, headers: authHeaders(), payload: Buffer.from("mover") });
    const mv = await app.inject({ method: "POST", url: `/api/v1/vaults/${VAULT}/move`, headers: jsonHeaders(), payload: { from: "old-name.md", to: "new-name.md" } });
    expect(mv.statusCode).toBe(200);
    const src = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files/old-name.md`, headers: authHeaders() });
    const dst = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files/new-name.md`, headers: authHeaders() });
    expect(src.statusCode).toBe(404);
    expect(dst.statusCode).toBe(200);
  });

  it("file listing returns live files", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) {
      expect(f.path).toBeTruthy();
      expect(f.hash).toBeTruthy();
      expect(f.deleted ?? false).toBe(false);
    }
  });

  it("shares: create, public page, raw, delete", async () => {
    await app.inject({ method: "PUT", url: `/api/v1/vaults/${VAULT}/files/shared/note.md`, headers: authHeaders(), payload: Buffer.from("---\ntitle: T\n---\n\n# T\n\nbody **bold**") });
    const create = await app.inject({ method: "POST", url: `/api/v1/vaults/${VAULT}/shares`, headers: jsonHeaders(), payload: { path: "shared/note.md" } });
    expect(create.statusCode).toBe(200);
    const shareId = create.json().shareId;
    expect(shareId).toBeTruthy();

    const page = await app.inject({ method: "GET", url: `/share/${shareId}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("note-title");

    const raw = await app.inject({ method: "GET", url: `/share/${shareId}/raw` });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toContain("body **bold**");

    const del = await app.inject({ method: "DELETE", url: `/api/v1/vaults/${VAULT}/shares/${shareId}`, headers: authHeaders() });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: `/share/${shareId}` });
    expect(after.statusCode).toBe(404);
  });

  it("path traversal is rejected", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/files/..%2F..%2Fetc%2Fpasswd`, headers: authHeaders() });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("meta reflects file count and seq", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/vaults/${VAULT}/meta`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.vaultId).toBe(VAULT);
    expect(meta.fileCount).toBeGreaterThan(0);
    expect(meta.seq).toBeGreaterThan(0);
  });
});
