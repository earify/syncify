import type { App } from "obsidian";
import { normalizePath } from "./protocol";

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

/** ArrayBuffer -> base64 (chunked btoa, mobile-safe). */
export function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/** base64 -> ArrayBuffer (chunked atob, mobile-safe). */
export function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** UTF-8 string -> ArrayBuffer. */
export function strToBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).slice().buffer as ArrayBuffer;
}

/** Type predicate: narrow an unknown value to a string-keyed record. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Human-readable message from an unknown thrown value. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
