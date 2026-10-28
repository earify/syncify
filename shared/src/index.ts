// syncify shared protocol types (server + plugin).
// Wire-compatible with the original eari-sync protocol so the plugin can talk
// to both the legacy server and the new server.

export type Op = "create" | "modify" | "delete" | "move";

export interface FileMeta {
  path: string; // vault-relative POSIX path
  size: number;
  mtime: number; // ms since epoch
  hash: string; // sha256 hex
  version: number;
  deleted?: boolean;
}

export interface Change {
  seq: number;
  path: string;
  op: Op;
  size?: number;
  mtime?: number;
  hash?: string;
  version: number;
  fromPath?: string; // for move
  clientId?: string;
  createdAt: number;
}

export interface ChangesResponse {
  changes: Change[];
  nextSeq: number; // highest seq returned (or current if none)
  hasMore: boolean;
  currentSeq: number; // server's current seq
}

export interface PushResult {
  path: string;
  version: number;
  seq: number;
  status: "created" | "updated" | "unchanged";
}

export interface ConflictInfo {
  error: "conflict";
  path: string;
  serverVersion: number;
  serverHash?: string;
  serverSize?: number;
  serverMtime?: number;
  clientVersion: number;
  deleted?: boolean;
}

export interface VaultMeta {
  vaultId: string;
  seq: number;
  fileCount: number;
  trashCount: number;
}

export interface WsMessage {
  type: "change" | "ping" | "pong" | "auth" | "auth_ok" | "auth_fail" | "error";
  vaultId?: string;
  seq?: number;
  token?: string;
  message?: string;
}

export interface ServerSettings {
  port: number;
  dataDir: string;
  httpsMode: "letsencrypt" | "selfsigned";
  certPath?: string;
  keyPath?: string;
  caCertPath?: string;
}

export const DEFAULT_EXCLUDES = [
  ".git/**",
  ".obsidian/cache/**",
  ".obsidian/workspace*.json",
  ".syncify/**",
  "**/.DS_Store",
  "**/Thumbs.db",
];

/** Normalize a vault-relative POSIX path. Rejects traversal. */
export function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((x) => x.length > 0 && x !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") throw new Error("path traversal not allowed");
    out.push(part);
  }
  return out.join("/");
}

/** Canonical index key: POSIX-normalized, no trailing slash, case preserved. */
export function canonicalKey(p: string): string {
  return normalizePath(p);
}

/**
 * Minimal glob matcher. Supports `**` (any depth), `*` (within segment),
 * `?` (single char). Paths are POSIX-style.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").trim();
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // consume consecutive stars
        while (g[i + 1] === "*") i++;
        // `**` or `**/` -> any chars including /
        if (g[i + 1] === "/") {
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function isExcluded(path: string, patterns: string[]): boolean {
  const key = canonicalKey(path);
  for (const p of patterns) {
    if (!p) continue;
    try {
      if (globToRegExp(p).test(key)) return true;
    } catch {
      // bad pattern: exact match fallback
      if (key === canonicalKey(p)) return true;
    }
  }
  return false;
}
