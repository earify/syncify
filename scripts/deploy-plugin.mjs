// Deploys the built plugin into the PC vault.
// Settings are deliberately NOT seeded — a fresh install starts blank and the
// user enters their own server URL / vault credentials.
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const repo = join(here, "..");

const VAULT = process.env.SYNCIFY_VAULT ?? "D:\\.working\\obsidianify";
const target = join(VAULT, ".obsidian", "plugins", "syncify");

// standard Obsidian layout: main.js / manifest.json / styles.css at repo root
const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
  if (!existsSync(join(repo, f))) {
    console.error(`missing ${join(repo, f)} — run "npm run build -w plugin" first`);
    process.exit(1);
  }
}
mkdirSync(target, { recursive: true });
for (const f of files) copyFileSync(join(repo, f), join(target, f));

console.log(`deployed to ${target}`);
