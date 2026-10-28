import { defaultDataDir, ensureDataDirs, loadConfig, dbPath } from "./config.js";
import { openDb } from "./db.js";
import { createVault, listVaults, rotateSecret, getSeq } from "./vaults.js";
import { generateSecret } from "./auth.js";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

const cmd = process.argv[2];

async function init() {
  const dataDir = defaultDataDir();
  ensureDataDirs(dataDir);
  const db = openDb(dataDir);
  const vaultId: string = arg("--vault") ?? "default";
  let secret: string = arg("--secret") ?? generateSecret(32);
  try {
    createVault(db, dataDir, vaultId, secret);
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) {
      rotateSecret(db, vaultId, secret);
      console.log(`Vault '${vaultId}' already exists; secret rotated.`);
    } else throw e;
  }
  db.close();
  console.log("");
  console.log("=== syncify initialized ===");
  console.log("Data dir :", dataDir);
  console.log("Vault ID :", vaultId);
  console.log("Vault Secret (save this, shown once):", secret);
  console.log("");
}

async function doctor() {
  const dataDir = defaultDataDir();
  console.log("Data dir:", dataDir);
  if (!existsSync(dataDir)) {
    console.log("FAIL: data dir missing. Run init.");
    process.exit(1);
  }
  const db = openDb(dataDir);
  console.log("DB integrity:", db.integrityCheck() ? "OK" : "FAIL");
  const vaults = listVaults(db);
  console.log("Vaults:", vaults.join(", ") || "(none)");
  for (const v of vaults) console.log(`  ${v}: seq=${getSeq(db, v)}`);
  db.close();
  const cfg = loadConfig(dataDir);
  console.log("Port:", cfg.port, "host:", cfg.host, "httpsMode:", cfg.httpsMode);
  if (cfg.httpsMode === "letsencrypt") {
    console.log("Cert:", cfg.certPath, existsSync(cfg.certPath ?? "") ? "OK" : "MISSING");
    console.log("Key :", cfg.keyPath, existsSync(cfg.keyPath ?? "") ? "OK" : "MISSING");
  }
  console.log("doctor done.");
}

async function backup() {
  const dataDir = defaultDataDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(dataDir, "backups", `backup-${ts}`);
  mkdirSync(out, { recursive: true });
  cpSync(dataDir, out, {
    recursive: true,
    filter: (src) => !src.includes("/backups/") && !src.includes("\\backups\\"),
  });
  console.log("Backup created:", out);
}

async function mainCli() {
  if (cmd === "init") await init();
  else if (cmd === "doctor") await doctor();
  else if (cmd === "backup") await backup();
  else {
    console.log(`Usage: cli <init|doctor|backup> [--vault id] [--secret s]  (db: ${dbPath(defaultDataDir())})`);
    process.exit(1);
  }
}

mainCli().catch((e) => {
  console.error(e);
  process.exit(1);
});
