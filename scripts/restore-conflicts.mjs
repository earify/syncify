// Restores .conflict-* copies back over their original files.
// Dry-run by default; pass --apply to actually restore.
//
//   node scripts/restore-conflicts.mjs            # list what would be restored
//   node scripts/restore-conflicts.mjs --apply    # restore (original -> .trash, conflict -> original)
import { readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";

const VAULT = process.env.SYNCIFY_VAULT ?? "D:\\.working\\obsidianify";
const APPLY = process.argv.includes("--apply");
const CONFLICT_RE = /^(.+?)\.conflict-([A-Za-z0-9_-]+?)(\.[A-Za-z0-9]+)?$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".trash" || e.name === ".syncify") continue;
      walk(full, out);
    } else if (CONFLICT_RE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const conflictFiles = walk(VAULT);
if (conflictFiles.length === 0) {
  console.log("no conflict files found");
  process.exit(0);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${conflictFiles.length} conflict file(s)\n`);
let restored = 0;
let duplicatesDeleted = 0;
for (const cf of conflictFiles) {
  const name = basename(cf);
  const m = name.match(CONFLICT_RE);
  const original = join(dirname(cf), m[1] + (m[3] ?? ""));
  const tag = m[2];
  const cs = statSync(cf);
  const os = existsSync(original) ? statSync(original) : null;
  const rel = cf.slice(VAULT.length + 1);

  // duplicate check: identical content -> the conflict copy is redundant
  if (os) {
    const ch = sha(readFileSync(cf));
    const oh = sha(readFileSync(original));
    if (ch === oh) {
      console.log(`${rel}\n   duplicate of original — delete conflict copy`);
      if (APPLY) {
        rmSync(cf, { force: true });
        duplicatesDeleted++;
      }
      console.log("");
      continue;
    }
  }

  console.log(`${rel}`);
  console.log(`   conflict : ${cs.size}b  ${cs.mtime.toISOString()}`);
  console.log(`   original : ${os ? os.size + "b  " + os.mtime.toISOString() : "(missing)"}`);

  if (!APPLY) continue;
  try {
    const content = readFileSync(cf);
    if (os) {
      // park the stale original in .trash so nothing is lost
      const trashDir = join(VAULT, ".trash");
      mkdirSync(trashDir, { recursive: true });
      const parked = join(trashDir, `${m[1].replace(/[\\/]/g, "_")}.pre-restore-${tag}`);
      renameSync(original, parked);
      console.log(`   parked original -> .trash/${basename(parked)}`);
    } else {
      mkdirSync(dirname(original), { recursive: true });
    }
    writeFileSync(original, content);
    rmSync(cf, { force: true });
    restored++;
    console.log("   restored ✔");
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
  }
  console.log("");
}

console.log(
  APPLY
    ? `done: ${restored} restored, ${duplicatesDeleted} duplicates deleted`
    : "dry run only — rerun with --apply to restore/delete",
);
