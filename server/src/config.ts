import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface RuntimeConfig {
  dataDir: string;
  port: number;
  host: string;
  httpsMode: "letsencrypt" | "selfsigned";
  certPath?: string;
  keyPath?: string;
  caCertPath?: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

// Legacy-compatible default/env names so this server can take over an
// existing eari-sync data directory without migration.
const DEFAULT_DATA_DIR = join(homedir(), "eari-sync-data");

export function defaultDataDir(): string {
  return process.env.EARI_SYNC_DATA_DIR
    ? resolve(process.env.EARI_SYNC_DATA_DIR)
    : process.env.SYNCIFY_DATA_DIR
      ? resolve(process.env.SYNCIFY_DATA_DIR)
      : DEFAULT_DATA_DIR;
}

const SUBDIRS = ["", "config", "vaults", "database", "backups", "logs", "staging"];

export function ensureDataDirs(dataDir: string): void {
  for (const sub of SUBDIRS) {
    const p = join(dataDir, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

export function loadConfig(dataDir: string): RuntimeConfig {
  const cfgPath = join(dataDir, "config", "server.json");
  let file: Partial<RuntimeConfig> = {};
  if (existsSync(cfgPath)) {
    try {
      file = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      file = {};
    }
  }
  return {
    dataDir,
    port: Number(process.env.EARI_SYNC_PORT ?? process.env.SYNCIFY_PORT ?? file.port ?? 8443),
    host: process.env.EARI_SYNC_HOST ?? process.env.SYNCIFY_HOST ?? file.host ?? "0.0.0.0",
    httpsMode:
      (process.env.EARI_SYNC_HTTPS_MODE as RuntimeConfig["httpsMode"]) ??
      file.httpsMode ??
      "selfsigned",
    certPath: process.env.EARI_SYNC_CERT ?? process.env.SYNCIFY_CERT ?? file.certPath,
    keyPath: process.env.EARI_SYNC_KEY ?? process.env.SYNCIFY_KEY ?? file.keyPath,
    caCertPath: process.env.EARI_SYNC_CA ?? process.env.SYNCIFY_CA ?? file.caCertPath,
    logLevel:
      (process.env.EARI_SYNC_LOG_LEVEL as RuntimeConfig["logLevel"]) ??
      (process.env.SYNCIFY_LOG_LEVEL as RuntimeConfig["logLevel"]) ??
      file.logLevel ??
      "info",
  };
}

export function saveConfig(dataDir: string, patch: Partial<RuntimeConfig>): void {
  ensureDataDirs(dataDir);
  const cfgPath = join(dataDir, "config", "server.json");
  let existing: Partial<RuntimeConfig> = {};
  if (existsSync(cfgPath)) {
    try {
      existing = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  writeFileSync(cfgPath, JSON.stringify({ ...existing, ...patch }, null, 2), "utf8");
}

export function vaultDir(dataDir: string, vaultId: string): string {
  return join(dataDir, "vaults", vaultId);
}

export function vaultFilesDir(dataDir: string, vaultId: string): string {
  return join(vaultDir(dataDir, vaultId), "files");
}

export function vaultStagingDir(dataDir: string, vaultId: string): string {
  return join(vaultDir(dataDir, vaultId), "staging");
}

export function vaultTrashDir(dataDir: string, vaultId: string): string {
  return join(vaultDir(dataDir, vaultId), "trash");
}

export function dbPath(dataDir: string): string {
  return join(dataDir, "database", "eari-sync.sqlite");
}
