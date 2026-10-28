import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertInsideVault, rejectSymlink, safeRelativePath } from "./paths.js";

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(absPath: string): string {
  return sha256Buffer(readFileSync(absPath));
}

export function ensureParent(absPath: string): void {
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function absPathFor(vaultFilesDir: string, relPath: string): string {
  const safe = safeRelativePath(relPath);
  const full = join(vaultFilesDir, safe);
  assertInsideVault(vaultFilesDir, full);
  return full;
}

export async function writeAtomic(
  vaultFilesDir: string,
  relPath: string,
  data: Buffer,
  mtime?: number,
): Promise<{ size: number; hash: string }> {
  const full = absPathFor(vaultFilesDir, relPath);
  rejectSymlink(full);
  ensureParent(full);
  const tmp = `${full}.tmp-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data);
  const { openSync, fsyncSync, closeSync, utimesSync } = await import("node:fs");
  const fd = openSync(tmp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, full);
  if (mtime) utimesSync(full, new Date(mtime), new Date(mtime));
  const st = statSync(full);
  return { size: st.size, hash: sha256File(full) };
}

export function readFileSyncSafe(vaultFilesDir: string, relPath: string): Buffer {
  const full = absPathFor(vaultFilesDir, relPath);
  rejectSymlink(full);
  return readFileSync(full);
}

export function fileExists(vaultFilesDir: string, relPath: string): boolean {
  try {
    const full = absPathFor(vaultFilesDir, relPath);
    rejectSymlink(full);
    return existsSync(full);
  } catch {
    return false;
  }
}

export function deleteFilePhysical(vaultFilesDir: string, relPath: string): void {
  const full = absPathFor(vaultFilesDir, relPath);
  rejectSymlink(full);
  if (existsSync(full)) unlinkSync(full);
}

export function moveFilePhysical(vaultFilesDir: string, fromRel: string, toRel: string): void {
  const from = absPathFor(vaultFilesDir, fromRel);
  const to = absPathFor(vaultFilesDir, toRel);
  rejectSymlink(from);
  rejectSymlink(to);
  ensureParent(to);
  renameSync(from, to);
}

export function listAllFiles(vaultFilesDir: string, base = ""): string[] {
  const out: string[] = [];
  const dir = base ? join(vaultFilesDir, base) : vaultFilesDir;
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isSymbolicLink()) continue;
    const rel = base ? `${base}/${name}` : name;
    if (st.isDirectory()) out.push(...listAllFiles(vaultFilesDir, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

export { createReadStream };
