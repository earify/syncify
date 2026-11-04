import { App, Notice, TFile } from "obsidian";
import { canonicalKey, defaultExcludes, isExcluded, type Change } from "./protocol";
import { SyncClient, SyncApiError, SyncConflictError, type DownloadResult } from "./api";
import { SyncLog } from "./log";
import type { SyncifySettings } from "./settings";
import {
  base64ToBuf,
  bufToBase64,
  strToBuf,
  conflictPathFor,
  ensureDir,
  errMsg,
  isRecord,
  parentDir,
  sha256Hex,
} from "./util";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export interface IndexEntry {
  version: number;
  hash: string;
  size?: number;
  mtime?: number;
}

export interface Tombstone {
  version: number; // server file version at the time of deletion
  at: number; // local epoch ms when the deletion was recorded
}

export interface SyncIndex {
  lastSeq: number;
  initialized: boolean;
  files: Record<string, IndexEntry>;
  /** Deletion tombstones: paths we deliberately removed, so stale server
   *  changes (and full-resync replays) never resurrect them. */
  deleted?: Record<string, Tombstone>;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  deleted: number;
  skipped: number;
  conflicts: number;
  errors: string[];
  durationMs: number;
  reason: string;
}

export type SyncState = "idle" | "syncing" | "error";

export interface ManualProgress {
  message: string;
  done: number;
  total: number | null;
}

interface LocalFileStat {
  path: string;
  size: number;
  mtime: number;
}

/** Single-file snapshot that carries the whole config folder (manual sync). */
const CONFIG_BUNDLE_PATH = ".syncify-config/config-bundle.json";

interface UploadWork {
  path: string;
  hash: string;
  stat: { size: number; mtime: number };
  entry?: IndexEntry;
}

/** Server request spacing (~8 req/s keeps us under the 600/min limit). */
const REQUEST_SPACING_MS = 125;
/** Parallel server requests during sync. */
const CONCURRENCY = 4;

export class SyncEngine {
  index: SyncIndex = { lastSeq: 0, initialized: false, files: {} };
  state: SyncState = "idle";
  lastReport: SyncReport | null = null;

  private syncing = false;
  private queued = false;
  private queueReason = "queued";
  private suppressed = new Map<string, number>();
  private cooldownUntil = 0;
  private configWalkCount = 0;
  /** Last manual-load snapshot contents (full local paths). Device-local. */
  private configManifest: string[] = [];

  private get configManifestPath(): string {
    return ".syncify/config-manifest.json";
  }

  private async loadConfigManifest(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.configManifestPath)) {
        const raw = await this.app.vault.adapter.read(this.configManifestPath);
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.configManifest = parsed.filter((x): x is string => typeof x === "string");
        }
      }
    } catch {
      this.configManifest = [];
    }
  }

  private async saveConfigManifest(): Promise<void> {
    try {
      await ensureDir(this.app, ".syncify");
      await this.app.vault.adapter.write(this.configManifestPath, JSON.stringify(this.configManifest));
    } catch (e) {
      this.log.warn(`config manifest save failed: ${errMsg(e)}`);
    }
  }
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  /** Renames detected by the watcher, applied to the server as move ops. */
  private pendingRenames: Array<{ from: string; to: string }> = [];

  private get configDir(): string {
    return this.app.vault.configDir;
  }

  private get indexDir(): string {
    return `${this.configDir}/plugins/syncify`;
  }

  private get indexPath(): string {
    return `${this.indexDir}/index.json`;
  }

  private hardExcludes(): string[] {
    return [
      ...defaultExcludes(this.configDir),
      `${this.configDir}/plugins/syncify/**`,
      ".trash/**",
      ".syncify/**",
    ];
  }

  get isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  /** Serialize request starts with a minimum spacing — smooth rate limiting
   *  with no long stalls, safe under the server's per-minute limit even when
   *  several requests are in flight. */
  private async throttle(): Promise<void> {
    const p = this.gate.then(async () => {
      const wait = this.lastRequestAt + REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.gate = p.catch(() => {});
    await p;
  }

  private startCooldown(ms = 60000): void {
    this.cooldownUntil = Date.now() + ms;
    this.log.warn(`rate limited by server; cooling down ${Math.round(ms / 1000)}s`);
  }

  private static isRateLimit(e: unknown): boolean {
    return e instanceof SyncApiError && e.status === 429;
  }

  constructor(
    private app: App,
    private client: SyncClient,
    private getSettings: () => SyncifySettings,
    private log: SyncLog,
    private onStateChange: () => void,
  ) {}

  // ---- deletion tombstones ------------------------------------------------------

  private tombstone(path: string, version: number): void {
    if (!this.index.deleted) this.index.deleted = {};
    this.index.deleted[canonicalKey(path)] = { version, at: Date.now() };
  }

  private tombstoneVersion(path: string): number | undefined {
    return this.index.deleted?.[canonicalKey(path)]?.version;
  }

  private clearTombstone(path: string): void {
    if (this.index.deleted) delete this.index.deleted[canonicalKey(path)];
  }

  // ---- suppression (ignore events caused by our own writes) -------------------

  suppress(path: string): void {
    this.suppressed.set(canonicalKey(path), Date.now() + 8000);
  }

  isSuppressed(path: string): boolean {
    const key = canonicalKey(path);
    const until = this.suppressed.get(key);
    if (!until) return false;
    if (until < Date.now()) {
      this.suppressed.delete(key);
      return false;
    }
    return true;
  }

  isExcluded(path: string): boolean {
    return isExcluded(path, [...this.hardExcludes(), ...this.getSettings().excludePatterns]);
  }

  // ---- persistence -------------------------------------------------------------

  async loadIndex(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.indexPath)) {
        const raw = await this.app.vault.adapter.read(this.indexPath);
        const parsed = JSON.parse(raw) as Partial<SyncIndex>;
        this.index = {
          lastSeq: Number(parsed.lastSeq ?? 0),
          initialized: !!parsed.initialized,
          files: parsed.files ?? {},
          deleted: parsed.deleted ?? {},
        };
      }
    } catch (e) {
      this.log.warn(`index load failed, starting fresh: ${errMsg(e)}`);
      this.index = { lastSeq: 0, initialized: false, files: {}, deleted: {} };
    }
  }

  async saveIndex(): Promise<void> {
    try {
      await ensureDir(this.app, this.indexDir);
      // prune tombstones: cap at 500 newest, drop entries older than 90 days
      const deleted = this.index.deleted ?? {};
      const cutoff = Date.now() - 90 * 86400000;
      for (const [p, t] of Object.entries(deleted)) {
        if (t.at < cutoff) delete deleted[p];
      }
      const keys = Object.keys(deleted);
      if (keys.length > 500) {
        keys
          .sort((a, b) => (deleted[a]?.at ?? 0) - (deleted[b]?.at ?? 0))
          .slice(0, keys.length - 500)
          .forEach((k) => delete deleted[k]);
      }
      await this.app.vault.adapter.write(this.indexPath, JSON.stringify(this.index));
    } catch (e) {
      this.log.warn(`index save failed: ${errMsg(e)}`);
    }
  }

  // ---- local file access helpers -------------------------------------------------

  /** Auto-sync scan: notes/attachments only — the config folder is manual-sync only. */
  private async collectLocalFiles(): Promise<LocalFileStat[]> {
    const out: LocalFileStat[] = [];
    for (const f of this.app.vault.getFiles()) {
      out.push({ path: canonicalKey(f.path), size: f.stat.size, mtime: f.stat.mtime });
    }
    return out;
  }

  /** Recursive config walk for MANUAL sync (respects tree rules, not hard excludes). */
  private async collectConfigFiles(dir: string, depth: number): Promise<LocalFileStat[]> {
    const out: LocalFileStat[] = [];
    if (depth > 10 || this.configWalkCount > 100000) return out;
    let listed;
    try {
      listed = await this.app.vault.adapter.list(dir);
    } catch (e) {
      this.log.warn(`config dir scan failed for ${dir}: ${errMsg(e)}`);
      return out;
    }
    for (const p of listed.files) {
      this.configWalkCount++;
      if (this.configSyncAllowed(p)) {
        try {
          const st = await this.app.vault.adapter.stat(p);
          if (st && st.type === "file") out.push({ path: canonicalKey(p), size: st.size, mtime: st.mtime });
        } catch {
          // stat race (file vanished mid-scan): skip
        }
      }
    }
    for (const d of listed.folders) {
      out.push(...(await this.collectConfigFiles(d, depth + 1)));
    }
    return out;
  }

  /** Whether a vault path is inside the config folder and allowed by current config-sync settings.
   *  Deepest matching configRule wins, root rule ("") is the fallback. */
  private configSyncAllowed(path: string): boolean {
    if (!path.startsWith(`${this.configDir}/`)) return true;
    const rel = path.slice(this.configDir.length + 1);
    const rules = this.getSettings().configRules ?? [];
    let include = true;
    let best = -1;
    for (const r of rules) {
      const matches = r.path === "" || rel === r.path || rel.startsWith(r.path + "/");
      if (matches && r.path.length > best) {
        include = r.include;
        best = r.path.length;
      }
    }
    return include;
  }

  private async localExists(path: string): Promise<boolean> {
    try {
      return await this.app.vault.adapter.exists(path);
    } catch {
      return false;
    }
  }

  private async localStat(path: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const st = await this.app.vault.adapter.stat(path);
      if (!st || st.type !== "file") return null;
      return { size: st.size, mtime: st.mtime };
    } catch {
      return null;
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return this.app.vault.readBinary(f);
    return this.app.vault.adapter.readBinary(path);
  }

  /** Write a local file (exposed for the conflict review view). */
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await ensureDir(this.app, parentDir(path));
    this.suppress(path);
    await this.app.vault.adapter.writeBinary(path, data);
  }

  /** Move a local file to the trash (exposed for the conflict review view). */
  async trashLocalFile(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    this.suppress(path);
    if (f) {
      try {
        // respects the user's trash preference (system/local)
        await this.app.fileManager.trashFile(f);
        return;
      } catch {
        // fileManager unavailable or refused -> fall back to local trash
      }
    }
    try {
      await this.app.vault.adapter.trashLocal(path);
    } catch {
      try {
        await this.app.vault.adapter.remove(path);
      } catch {
        // nothing more we can do; server copy stays for recovery
      }
    }
  }

  // ---- sync ----------------------------------------------------------------------

  async syncNow(
    reason = "manual",
    onProgress?: (p: { message: string; done: number; total: number | null }) => void,
  ): Promise<SyncReport | null> {
    if (this.syncing) {
      this.queued = true;
      this.queueReason = reason;
      this.log.debug(`sync already running; queued (${reason})`);
      return null;
    }
    if (this.isCoolingDown && reason !== "manual") {
      this.log.debug("sync skipped: rate-limit cooldown active");
      return null;
    }
    this.syncing = true;
    this.state = "syncing";
    this.onStateChange();
    onProgress?.({ message: "Pulling remote changes...", done: 0, total: null });
    const started = Date.now();
    const report: SyncReport = {
      pulled: 0,
      pushed: 0,
      deleted: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
      durationMs: 0,
      reason,
    };
    try {
      await this.pullPass(report, onProgress);
      await this.movePass(report);
      await this.pushPass(report, onProgress);
      this.index.initialized = true;
    } catch (e) {
      if (SyncEngine.isRateLimit(e)) this.startCooldown();
      report.errors.push(errMsg(e));
      this.log.error(`sync failed (${reason}): ${errMsg(e)}`);
    } finally {
      report.durationMs = Date.now() - started;
      this.lastReport = report;
      this.state = report.errors.length > 0 ? "error" : "idle";
      this.syncing = false;
      this.onStateChange();
      await this.saveIndex();
      onProgress?.({ message: "Done", done: 1, total: 1 });
    }
    if (this.queued) {
      this.queued = false;
      const r = this.queueReason;
      this.queueReason = "queued";
      // run queued sync after the current one fully settles
      window.setTimeout(() => {
        void this.syncNow(r).then((rep) => {
          if (rep) this.log.info(`queued sync done (${rep.reason}): ↑${rep.pushed} ↓${rep.pulled}`);
        });
      }, 100);
    }
    this.log.info(
      `sync (${reason}) ↑${report.pushed} ↓${report.pulled} ✕${report.deleted} =${report.skipped} conflict:${report.conflicts} err:${report.errors.length}`,
    );
    return report;
  }

  /** Order-preserving chunks with unique paths per chunk, so chunk items can
   *  be applied in parallel without reordering same-path changes. */
  private chunkChanges(changes: Change[], size: number): Change[][] {
    const chunks: Change[][] = [];
    let cur: Change[] = [];
    const inCur = new Set<string>();
    for (const c of changes) {
      if (cur.length >= size || inCur.has(c.path)) {
        chunks.push(cur);
        cur = [];
        inCur.clear();
      }
      cur.push(c);
      inCur.add(c.path);
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
  }

  /** Queue a rename so the next sync uses the server move op (no
   *  delete+create duplicates on other devices). Moves into trash folders are
   *  treated as deletions and handled by the deletion loop instead. */
  renameDetected(from: string, to: string): void {
    if (to === ".trash" || to.startsWith(".trash/")) return;
    if (to === this.configDir || to.startsWith(`${this.configDir}/`)) return;
    if (from === this.configDir || from.startsWith(`${this.configDir}/`)) return;
    const fromKey = canonicalKey(from);
    const toKey = canonicalKey(to);
    if (fromKey === toKey) return;
    this.pendingRenames.push({ from: fromKey, to: toKey });
  }

  /** Apply queued renames via the server move op. */
  private async movePass(report: SyncReport): Promise<void> {
    const renames = this.pendingRenames.splice(0);
    for (const r of renames) {
      const entry = this.index.files[r.from];
      if (!entry) continue; // never synced -> the push pass handles 'to' as new
      if (this.index.files[r.to]) continue; // destination already tracked -> push handles it
      try {
        await this.throttle();
        const res = await this.client.move(r.from, r.to, entry.version);
        delete this.index.files[r.from];
        this.index.files[r.to] = { version: res.version, hash: entry.hash, size: entry.size, mtime: entry.mtime };
        report.pushed++;
      } catch (e) {
        if (SyncEngine.isRateLimit(e)) throw e;
        // stale/conflict -> fall back to the normal delete+create push flow
        this.log.warn(`move ${r.from} -> ${r.to} deferred to push: ${errMsg(e)}`);
      }
    }
  }

  private async pullPass(
    report: SyncReport,
    onProgress?: (p: { message: string; done: number; total: number | null }) => void,
  ): Promise<void> {
    let since = this.index.lastSeq;
    let guard = 0;
    while (guard++ < 10000) {
      const res = await this.client.changes(since, 500);
      for (const chunk of this.chunkChanges(res.changes, CONCURRENCY)) {
        await Promise.all(
          chunk.map(async (c) => {
            try {
              await this.applyChange(c, report);
              onProgress?.({ message: "Pulling remote changes...", done: report.pulled, total: null });
            } catch (e) {
              if (SyncEngine.isRateLimit(e)) throw e;
              report.errors.push(`pull ${c.path}: ${errMsg(e)}`);
            }
          }),
        );
      }
      since = res.hasMore ? res.nextSeq : res.currentSeq;
      this.index.lastSeq = since;
      if (!res.hasMore) break;
    }
  }

  private async applyChange(c: Change, report: SyncReport): Promise<void> {
    const key = canonicalKey(c.path);
    if (key === this.configDir || key.startsWith(`${this.configDir}/`)) {
      // config folder is manual-sync only
      report.skipped++;
      return;
    }
    if (key === CONFIG_BUNDLE_PATH || key.startsWith(`${CONFIG_BUNDLE_PATH.slice(0, -1)}/`)) {
      // the manual-sync snapshot is device-agnostic; never pull it into the index
      report.skipped++;
      return;
    }
    if (this.isExcluded(key)) {
      report.skipped++;
      return;
    }
    if (c.op === "delete") {
      const entry = this.index.files[key];
      const exists = await this.localExists(key);
      if (!exists) {
        delete this.index.files[key];
        report.skipped++;
        return;
      }
      if (!entry) {
        // No baseline (first sync / fresh install): we can't know whether the
        // local copy is stale, so KEEP it. Push will reconcile with the server.
        this.log.info(`remote delete with no baseline; keeping local ${key}`);
        report.conflicts++;
        return;
      }
      if (entry.hash && c.hash && entry.hash !== c.hash) {
        // local diverged from what we knew; remote delete would lose it
        this.log.warn(`remote delete of locally-changed file kept: ${key}`);
        report.conflicts++;
        return;
      }
      await this.trashLocalFile(key);
      delete this.index.files[key];
      this.tombstone(key, c.version);
      report.deleted++;
      return;
    }
    if (c.op === "move") {
      const fromKey = canonicalKey(c.fromPath ?? "");
      const toKey = key;
      const fromFile = this.app.vault.getAbstractFileByPath(fromKey);
      try {
        this.suppress(fromKey);
        this.suppress(toKey);
        if (fromFile) {
          await ensureDir(this.app, parentDir(toKey));
          await this.app.vault.rename(fromFile, toKey);
        } else if (await this.localExists(fromKey)) {
          const data = await this.app.vault.adapter.readBinary(fromKey);
          await ensureDir(this.app, parentDir(toKey));
          await this.app.vault.adapter.writeBinary(toKey, data);
          await this.app.vault.adapter.remove(fromKey);
        } else {
          report.skipped++;
          return;
        }
        const entry = this.index.files[fromKey];
        if (entry) {
          delete this.index.files[fromKey];
          this.index.files[toKey] = entry;
        }
        report.pulled++;
      } catch (e) {
        report.errors.push(`move ${fromKey} -> ${toKey}: ${errMsg(e)}`);
      }
      return;
    }

    // create / modify
    const entry = this.index.files[key];
    const tsv = this.tombstoneVersion(key);
    if (tsv !== undefined) {
      if ((c.version ?? 0) > tsv) {
        // re-created on the server after our deletion -> intentional resurrect
        this.log.info(`re-created on server after delete; resurrecting ${key}`);
        this.clearTombstone(key);
      } else {
        // stale replay of pre-deletion history -> keep it deleted
        this.log.info(`stale change for deleted ${key} (v${c.version} <= tombstone v${tsv}); skipping`);
        report.skipped++;
        return;
      }
    }
    if (entry && entry.hash && c.hash && entry.hash === c.hash && entry.version >= c.version) {
      report.skipped++;
      return;
    }

    const local = await this.localStat(key);
    if (!local) {
      // server-only file -> download
      await this.throttle();
      const dl = await this.client.download(c.path);
      if (c.hash && dl.hash && dl.hash !== c.hash) {
        this.log.warn(`download hash mismatch for ${key}; will retry next sync`);
      }
      await this.writeBinary(key, dl.data);
      this.index.files[key] = {
        version: dl.version || c.version,
        hash: dl.hash || c.hash || "",
        size: dl.data.byteLength,
        mtime: Date.now(),
      };
      report.pulled++;
      return;
    }

    const localBuf = await this.readBinary(key);
    const localHash = await sha256Hex(localBuf);
    if (c.hash && localHash === c.hash) {
      // server content already matches local; just record it
      this.index.files[key] = { version: c.version, hash: c.hash, size: local.size, mtime: local.mtime };
      report.skipped++;
      return;
    }
    if (!entry) {
      // First sync on this device: no baseline. Keep whichever side is newer
      // (local mtime vs the server change time); push will reconcile with the server.
      if (local.mtime >= (c.mtime ?? 0)) {
        this.log.debug(`first-sync: keeping local ${key} (mtime ${local.mtime} >= ${c.mtime ?? 0})`);
        report.skipped++;
      } else {
        await this.throttle();
        const dl = await this.client.download(c.path);
        await this.writeBinary(key, dl.data);
        this.index.files[key] = {
          version: dl.version || c.version,
          hash: dl.hash || c.hash || "",
          size: dl.data.byteLength,
          mtime: Date.now(),
        };
        report.pulled++;
      }
      return;
    }
    if (localHash === entry.hash) {
      // local untouched since last sync -> safe to take server version
      await this.throttle();
      const dl = await this.client.download(c.path);
      if (c.hash && dl.hash && dl.hash !== c.hash) {
        this.log.warn(`download hash mismatch for ${key}; will retry next sync`);
      }
      await this.writeBinary(key, dl.data);
      this.index.files[key] = {
        version: dl.version || c.version,
        hash: dl.hash || c.hash || "",
        size: dl.data.byteLength,
        mtime: Date.now(),
      };
      report.pulled++;
      return;
    }

    // both diverged -> conflict
    await this.handlePullConflict(key, localBuf, localHash, c, report);
  }

  private async handlePullConflict(
    key: string,
    localBuf: ArrayBuffer,
    localHash: string,
    remote: Change,
    report: SyncReport,
  ): Promise<void> {
    const s = this.getSettings();
    await this.throttle();
    const dl = await this.client.download(remote.path);
    const serverBuf = dl.data;

    // auto-resolve trivial conflicts — no .conflict file, no data loss
    if (localBuf.byteLength === 0 && serverBuf.byteLength > 0) {
      await this.writeBinary(key, serverBuf);
      this.index.files[key] = { version: dl.version, hash: dl.hash || remote.hash || "", size: serverBuf.byteLength, mtime: Date.now() };
      this.log.info(`conflict on ${key}: local copy was empty, took server version`);
      return;
    }
    if (serverBuf.byteLength === 0 && localBuf.byteLength > 0) {
      const up = await this.client.upload(key, localBuf, { baseVersion: 0, hash: localHash, mtime: Date.now() });
      this.index.files[key] = { version: up.version, hash: localHash, size: localBuf.byteLength, mtime: Date.now() };
      this.log.info(`conflict on ${key}: server copy was empty, kept local version`);
      return;
    }

    report.conflicts++;
    if (s.conflictPolicy === "server") {
      this.log.warn(`conflict on ${key}: taking server version`);
      await this.writeBinary(key, serverBuf);
      this.index.files[key] = { version: dl.version, hash: dl.hash || remote.hash || "", size: serverBuf.byteLength, mtime: Date.now() };
      return;
    }
    const tag = `${s.deviceId.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const cpath = conflictPathFor(key, tag);
    this.log.warn(`conflict on ${key}: local copy kept at ${cpath}`);
    try {
      await this.writeBinary(cpath, localBuf);
      const up = await this.client.upload(cpath, localBuf, { baseVersion: 0, hash: localHash, mtime: Date.now() });
      this.index.files[cpath] = { version: up.version, hash: localHash, size: localBuf.byteLength, mtime: Date.now() };
    } catch (e) {
      report.errors.push(`conflict copy upload ${cpath}: ${errMsg(e)}`);
    }
    await this.writeBinary(key, serverBuf);
    this.index.files[key] = { version: dl.version, hash: dl.hash || remote.hash || "", size: serverBuf.byteLength, mtime: Date.now() };
  }

  private async pushPass(
    report: SyncReport,
    onProgress?: (p: { message: string; done: number; total: number | null }) => void,
  ): Promise<void> {
    const files = await this.collectLocalFiles();
    const seen = new Set<string>();
    const work: UploadWork[] = [];
    for (const f of files) {
      seen.add(f.path);
      if (this.isExcluded(f.path)) continue;
      if (this.getSettings().maxFileSizeMB > 0 && f.size > this.getSettings().maxFileSizeMB * 1024 * 1024) {
        report.skipped++;
        continue;
      }
      const entry = this.index.files[f.path];
      if (entry && entry.size === f.size && entry.mtime === f.mtime) continue;
      try {
        const buf = await this.readBinary(f.path);
        const hash = await sha256Hex(buf);
        if (entry && entry.hash === hash) {
          this.index.files[f.path] = { version: entry.version, hash, size: f.size, mtime: f.mtime };
          continue;
        }
        work.push({ path: f.path, hash, stat: { size: f.size, mtime: f.mtime }, entry });
      } catch (e) {
        report.errors.push(`read ${f.path}: ${errMsg(e)}`);
      }
    }

    // uploads with bounded concurrency (re-reads local files, bounded memory)
    let aborted = false;
    let cursor = 0;
    onProgress?.({ message: "Uploading local changes...", done: report.pushed, total: null });
    const workers = Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
      while (cursor < work.length && !aborted) {
        const w = work[cursor++];
        try {
          await this.throttle();
          const buf = await this.readBinary(w.path);
          await this.pushOne(w.path, buf, w.hash, w.stat, w.entry, report);
          onProgress?.({ message: "Uploading local changes...", done: report.pushed, total: null });
        } catch (e) {
          if (SyncEngine.isRateLimit(e)) {
            aborted = true;
            this.startCooldown();
            report.errors.push(`push paused (rate limited) at ${w.path}: ${errMsg(e)}`);
          } else {
            report.errors.push(`push ${w.path}: ${errMsg(e)}`);
          }
        }
      }
    });
    await Promise.all(workers);

    // local deletions -> server (sequential, throttled)
    if (this.index.initialized && !aborted) {
      onProgress?.({ message: "Applying local deletions...", done: report.deleted, total: null });
      for (const key of Object.keys(this.index.files)) {
        if (seen.has(key)) continue;
        if (
          this.isExcluded(key) ||
          key === this.configDir ||
          key.startsWith(`${this.configDir}/`) ||
          key === CONFIG_BUNDLE_PATH ||
          key.startsWith(`${CONFIG_BUNDLE_PATH.slice(0, -1)}/`)
        ) {
          // never auto-delete config files or the config snapshot; untrack only
          delete this.index.files[key];
          continue;
        }
        try {
          const ver = this.index.files[key].version;
          this.suppress(key);
          await this.throttle();
          await this.client.remove(key, ver);
          delete this.index.files[key];
          this.tombstone(key, ver);
          report.deleted++;
        } catch (e) {
          if (SyncEngine.isRateLimit(e)) throw e;
          report.errors.push(`delete ${key}: ${errMsg(e)}`);
        }
      }
    }
  }

  private async pushOne(
    path: string,
    buf: ArrayBuffer,
    hash: string,
    stat: { size: number; mtime: number },
    entry: IndexEntry | undefined,
    report: SyncReport,
  ): Promise<void> {
    // re-creating over our own server-side delete: acknowledge it explicitly
    const tsVer = entry ? undefined : this.tombstoneVersion(path);
    try {
      const res = await this.client.upload(path, buf, {
        baseVersion: entry?.version ?? 0,
        mtime: stat.mtime,
        hash,
        seenDeleteVersion: tsVer,
      });
      this.index.files[path] = { version: res.version, hash, size: stat.size, mtime: stat.mtime };
      if (tsVer !== undefined) this.clearTombstone(path);
      report.pushed++;
    } catch (e) {
      if (e instanceof SyncConflictError) {
        await this.handlePushConflict(path, buf, hash, stat, e, report);
      } else {
        throw e;
      }
    }
  }

  private async handlePushConflict(
    path: string,
    buf: ArrayBuffer,
    hash: string,
    stat: { size: number; mtime: number },
    e: SyncConflictError,
    report: SyncReport,
  ): Promise<void> {
    const s = this.getSettings();
    if (e.info.deleted) {
      // server deleted it; re-upload intentionally marks seen delete
      const res = await this.client.upload(path, buf, {
        baseVersion: 0,
        mtime: stat.mtime,
        hash,
        seenDeleteVersion: e.info.serverVersion,
      });
      this.index.files[path] = { version: res.version, hash, size: stat.size, mtime: stat.mtime };
      report.pushed++;
      this.log.warn(`recreated ${path} after server-side delete`);
      return;
    }

    await this.throttle();
    const dl = await this.client.download(path);
    const serverBuf = dl.data;

    // auto-resolve trivial conflicts — no .conflict file, no data loss
    if (serverBuf.byteLength === 0 && buf.byteLength > 0) {
      const res = await this.client.upload(path, buf, { baseVersion: 0, mtime: stat.mtime, hash });
      this.index.files[path] = { version: res.version, hash, size: stat.size, mtime: stat.mtime };
      this.log.info(`conflict on ${path}: server copy was empty, kept local version`);
      return;
    }
    if (buf.byteLength === 0 && serverBuf.byteLength > 0) {
      await this.writeBinary(path, serverBuf);
      this.index.files[path] = { version: dl.version, hash: dl.hash, size: serverBuf.byteLength, mtime: Date.now() };
      this.log.info(`conflict on ${path}: local copy was empty, took server version`);
      return;
    }

    report.conflicts++;
    if (s.conflictPolicy === "server") {
      await this.writeBinary(path, serverBuf);
      this.index.files[path] = { version: dl.version, hash: dl.hash, size: serverBuf.byteLength, mtime: Date.now() };
      this.log.warn(`conflict on ${path}: took server version`);
      return;
    }
    const tag = `${s.deviceId.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const cpath = conflictPathFor(path, tag);
    await this.writeBinary(cpath, buf);
    const up = await this.client.upload(cpath, buf, { baseVersion: 0, mtime: stat.mtime, hash });
    this.index.files[cpath] = { version: up.version, hash, size: stat.size, mtime: stat.mtime };
    await this.writeBinary(path, serverBuf);
    this.index.files[path] = { version: dl.version, hash: dl.hash, size: serverBuf.byteLength, mtime: Date.now() };
    this.log.warn(`conflict on ${path}: local copy kept at ${cpath}`);
  }

  /** Manual: snapshot this device's selected config files to the server as a
   *  single bundle file. Add/overwrite only — nothing is ever deleted. */
  async manualUploadConfig(
    onProgress?: (p: ManualProgress) => void,
    dryRun = false,
  ): Promise<{
    uploaded: number;
    deleted: number;
    skipped: number;
    errors: string[];
    plan: { uploads: string[]; deletes: string[] };
  }> {
    const report = {
      uploaded: 0,
      deleted: 0,
      skipped: 0,
      errors: [] as string[],
      plan: { uploads: [] as string[], deletes: [] as string[] },
    };
    const cfgRoot = `${this.configDir}/`;
    // the snapshot path was tombstoned by an older buggy run; clear it so the
    // upload below can re-create the snapshot cleanly
    if (!dryRun) this.clearTombstone(CONFIG_BUNDLE_PATH);
    onProgress?.({ message: "Scanning config folder…", done: 0, total: null });
    const files = (await this.collectConfigFiles(cfgRoot, 0)).map((f) => f.path).filter((p) => !this.isExcluded(p));
    const files_ = files.map((p) => canonicalKey(p));
    const localSet = new Set(files_);

    let serverFiles: Array<{ path: string; hash: string }> = [];
    if (!dryRun) {
      try {
        serverFiles = await this.client.listFiles();
      } catch (e) {
        report.errors.push(`list server files: ${errMsg(e)}`);
      }
    }
    const serverByPath = new Map(serverFiles.map((f) => [f.path, f]));

    const entries: Array<{ path: string; b64: string; hash: string }> = [];
    onProgress?.({ message: "Packing config files…", done: 0, total: files.length });
    for (const p of files) {
      try {
        const buf = await this.readBinary(p);
        const hash = await sha256Hex(buf);
        entries.push({ path: p, b64: bufToBase64(buf), hash });
        onProgress?.({ message: "Packing config files…", done: entries.length, total: files.length });
      } catch (e) {
        report.errors.push(`read ${p}: ${errMsg(e)}`);
      }
    }

    const bundle = JSON.stringify({ version: 1, createdAt: Date.now(), count: entries.length, files: entries });
    const payload = strToBuf(bundle);
    if (dryRun) {
      for (const e0 of entries) {
        const remote = serverByPath.get(e0.path);
        if (!remote || remote.hash !== e0.hash) report.plan.uploads.push(e0.path);
      }
      onProgress?.({ message: "Preview ready", done: 1, total: 1 });
      return report;
    }
    try {
      await this.client.upload(CONFIG_BUNDLE_PATH, payload, { baseVersion: 0, mtime: Date.now() });
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 409) {
        // snapshot file was deleted on the server earlier; re-create deliberately
        await this.client.upload(CONFIG_BUNDLE_PATH, payload, {
          baseVersion: 0,
          mtime: Date.now(),
          seenDeleteVersion: 999999,
        });
      } else {
        throw e;
      }
    }
    report.uploaded = entries.length;

    // mirror deletions: allowed server config files deleted locally -> delete on server
    const allowedServer = serverFiles.filter(
      (f) => f.path.startsWith(cfgRoot) && this.configSyncAllowed(f.path) && !this.isExcluded(f.path),
    );
    if (dryRun) {
      for (const f of allowedServer) {
        if (!localSet.has(f.path)) report.plan.deletes.push(f.path);
      }
      onProgress?.({ message: "Preview ready", done: 1, total: 1 });
      return report;
    }
    onProgress?.({ message: "Removing server extras…", done: 0, total: null });
    for (const f of allowedServer) {
      if (localSet.has(f.path)) continue;
      try {
        this.suppress(f.path);
        await this.throttle();
        await this.client.remove(f.path);
        report.deleted++;
        onProgress?.({ message: "Removing server extras…", done: report.deleted, total: null });
      } catch (e) {
        if (SyncEngine.isRateLimit(e)) throw e;
        report.errors.push(`delete ${f.path}: ${errMsg(e)}`);
      }
    }

    this.configManifest = files_.slice();
    await this.saveConfigManifest();
    return report;
  }

  /** Manual: download the server's config snapshot and extract it over this
   *  device's config folder. Overwrites only — never deletes local files.
   *  Never touches the sync index. */
  async manualLoadConfig(
    onProgress?: (p: ManualProgress) => void,
    dryRun = false,
  ): Promise<{
    loaded: number;
    deleted: number;
    skipped: number;
    errors: string[];
    plan: { loads: string[] };
  }> {
    const report = {
      loaded: 0,
      deleted: 0,
      skipped: 0,
      errors: [] as string[],
      plan: { loads: [] as string[] },
    };
    onProgress?.({ message: "Fetching server config…", done: 0, total: null });
    let dl: DownloadResult;
    try {
      dl = await this.client.download(CONFIG_BUNDLE_PATH);
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 404) {
        throw new Error("no config snapshot on the server yet — upload from a device first");
      }
      throw e;
    }
    let bundle: { files?: Array<{ path: string; b64?: string }> } = {};
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(dl.data));
      if (isRecord(parsed) && Array.isArray(parsed.files)) {
        bundle = parsed as { files?: Array<{ path: string; b64?: string }> };
      }
    } catch (e) {
      throw new Error(`config snapshot is corrupted: ${errMsg(e)}`);
    }
    const entries = Array.isArray(bundle.files) ? bundle.files : [];
    const loadedSet = new Set<string>();
    onProgress?.({ message: "Loading config files…", done: 0, total: entries.length });
    let loadedCount = 0;
    for (const e of entries) {
      if (typeof e.path !== "string" || typeof e.b64 !== "string") continue;
      if (!this.configSyncAllowed(e.path) || this.isExcluded(e.path)) {
        report.skipped++;
        continue;
      }
      try {
        if (dryRun) {
          report.plan.loads.push(e.path);
          report.loaded++;
          continue;
        }
        await this.writeBinary(e.path, base64ToBuf(e.b64));
        loadedSet.add(e.path);
        loadedCount++;
        onProgress?.({ message: "Loading config files…", done: loadedCount, total: entries.length });
        report.loaded++;
      } catch (err) {
        report.errors.push(`load ${e.path}: ${errMsg(err)}`);
      }
    }
    // mirror deletions: files we loaded before but that are gone from the
    // server snapshot were deleted by the uploading device
    await this.loadConfigManifest();
    if (dryRun) {
      onProgress?.({ message: "Preview ready", done: 1, total: 1 });
      return report;
    }
    onProgress?.({ message: "Applying server deletions…", done: 0, total: null });
    for (const prev of this.configManifest) {
      if (loadedSet.has(prev)) continue;
      if (!this.configSyncAllowed(prev) || this.isExcluded(prev)) continue;
      if (await this.localExists(prev)) {
        this.suppress(prev);
        await this.trashLocalFile(prev);
        report.deleted++;
        onProgress?.({ message: "Applying server deletions…", done: report.deleted, total: null });
      }
    }
    this.configManifest = Array.from(loadedSet);
    await this.saveConfigManifest();
    // config paths are not part of auto-sync: drop stale index entries
    const cfgRoot = `${this.configDir}/`;
    for (const key of Object.keys(this.index.files)) {
      if (key.startsWith(cfgRoot)) delete this.index.files[key];
    }
    return report;
  }

  async forceFullResync(): Promise<void> {
    this.log.info("force full resync requested");
    // tombstones survive: deleted files must stay deleted across the replay
    this.index = { lastSeq: 0, initialized: false, files: {}, deleted: this.index.deleted ?? {} };
    await this.saveIndex();
    const rep = await this.syncNow("full-resync");
    if (rep) {
      new Notice(
        `syncify: full resync done — ↑${rep.pushed} ↓${rep.pulled} conflicts:${rep.conflicts} errors:${rep.errors.length}`,
        8000,
      );
    }
  }
}
