import type { App } from "obsidian";
import { normalizePath } from "@syncify/shared";

export function sha256Hex(data: ArrayBuffer): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", data)
    .then((buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** `notes/foo.md` -> `notes/foo.conflict-<tag>.md` */
export function conflictPathFor(path: string, tag: string): string {
  const dir = parentDir(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const cp = dir ? `${dir}/${stem}.conflict-${tag}${ext}` : `${stem}.conflict-${tag}${ext}`;
  return normalizePath(cp);
}

/** Create every missing folder segment of `dir` ("" is a no-op). */
export async function ensureDir(app: App, dir: string): Promise<void> {
  if (!dir) return;
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    try {
      if (!(await app.vault.adapter.exists(cur))) await app.vault.adapter.mkdir(cur);
    } catch {
      // already exists races are fine
    }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
