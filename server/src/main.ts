import { buildServer } from "./index.js";
import { defaultDataDir, ensureDataDirs, loadConfig } from "./config.js";
import { openDb } from "./db.js";

async function main() {
  const dataDir = defaultDataDir();
  ensureDataDirs(dataDir);
  const cfg = loadConfig(dataDir);
  const db = openDb(dataDir);
  const app = await buildServer(cfg, db);
  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    console.log(`syncify server listening on ${cfg.host}:${cfg.port} (data: ${dataDir})`);
  } catch (e) {
    console.error("failed to start:", e);
    process.exit(1);
  }
}

main();
