import { normalize, sep } from "node:path";
import { lstatSync } from "node:fs";
import { normalizePath } from "@syncify/shared";

/** Validate + canonicalize a client-supplied vault-relative path. */
export function safeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("invalid path");
  if (input.includes("\0")) throw new Error("null byte in path");
  const norm = normalizePath(input);
  if (norm.length === 0) throw new Error("empty path");
  const resolved = normalize(norm);
  if (resolved.startsWith("..") || resolved.includes("../")) throw new Error("path traversal");
  return norm;
}

export function assertInsideVault(vaultFilesDir: string, targetPath: string): void {
  const base = normalize(vaultFilesDir);
  const target = normalize(targetPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error("path escapes vault directory");
  }
}

export function rejectSymlink(absPath: string): void {
  try {
    const st = lstatSync(absPath);
    if (st.isSymbolicLink()) throw new Error("symlink not allowed");
    if (!st.isFile() && !st.isDirectory()) throw new Error("unsupported file type");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // not exists yet, ok
    throw e;
  }
}
