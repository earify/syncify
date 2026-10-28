// Deploys the built plugin into the PC vault and seeds settings from the
// legacy eari-sync plugin on first deploy.
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const repo = join(here, "..");
const pluginDir = join(repo, "plugin");

const VAULT = process.env.SYNCIFY_VAULT ?? "D:\\.working\\obsidianify";
const target = join(VAULT, ".obsidian", "plugins", "syncify");

const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
  const src = join(pluginDir, f);
  if (!existsSync(src)) {
    console.error(`missing ${src} — run "npm run build -w plugin" first`);
    process.exit(1);
  }
}
mkdirSync(target, { recursive: true });
for (const f of files) copyFileSync(join(pluginDir, f), join(target, f));

// seed data.json once from legacy plugin settings
const dataFile = join(target, "data.json");
if (!existsSync(dataFile)) {
  const legacy = join(VAULT, ".obsidian", "plugins", "eari-sync", "data.json");
  if (existsSync(legacy)) {
    try {
      const old = JSON.parse(readFileSync(legacy, "utf8"));
      const seed = {
        serverUrl: old.serverUrl,
        vaultId: old.vaultId,
        vaultSecret: old.vaultSecret,
        excludePatterns: old.excludePatterns ?? [],
        syncObsidian: old.syncObsidian ?? true,
        deviceClass: undefined,
        obsidianInclude: old.obsidianInclude ?? [],
        maxFileSizeMB: old.maxFileSizeMB ?? 50,
      };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dataFile, JSON.stringify(seed, null, 2), "utf8");
      console.log("seeded data.json from legacy eari-sync settings");
    } catch (e) {
      console.warn("could not seed data.json:", e?.message ?? e);
    }
  }
}

console.log(`deployed to ${target}`);
