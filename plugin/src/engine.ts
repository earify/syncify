import { App, Notice, TFile } from "obsidian";
import { canonicalKey, defaultExcludes, isExcluded, normalizePath, type Change } from "./protocol";
import { SyncClient, SyncApiError, SyncConflictError } from "./api";
import { SyncLog } from "./log";
import type { SyncifySettings } from "./settings";
import { conflictPathFor, ensureDir, errMsg, parentDir, sha256Hex } from "./util";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export interface IndexEntry {
  version: number;
  hash: string;
  size?: number;
  mtime?: number;
}

export interface SyncIndex {
  lastSeq: number;
  initialized: boolean;
  files: Record<string, IndexEntry>;
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

interface LocalFileStat {
  path: string;
  size: number;
  mtime: number;
}

export class SyncEngine {
  index: SyncIndex = { lastSeq: 0, initialized: false, files: {} };
  state: SyncState = "idle";
  lastReport: SyncReport | null = null;

  private syncing = false;
  private queued = false;
  private queueReason = "queued";
  private suppressed = new Map<string, number>();
  private cooldownUntil = 0;
  private opsSincePause = 0;

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

  /** Slow down writes/downloads so we stay well under the server rate limit. */
  private async pace(): Promise<void> {
    if (++this.opsSincePause >= 100) {
      this.opsSincePause = 0;
      await sleep(2500);
    }
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
        };
      }
    } catch (e) {
      this.log.warn(`index load failed, starting fresh: ${errMsg(e)}`);
      this.index = { lastSeq: 0, initialized: false, files: {} };
    }
  }

  async saveIndex(): Promise<void> {
    try {
      await ensureDir(this.app, this.indexDir);
      await this.app.vault.adapter.write(this.indexPath, JSON.stringify(this.index));
    } catch (e) {
      this.log.warn(`index save failed: ${errMsg(e)}`);
    }
  }

  // ---- local file access helpers -------------------------------------------------

  private async collectLocalFiles(): Promise<LocalFileStat[]> {
    const out: LocalFileStat[] = [];
    for (const f of this.app.vault.getFiles()) {
      out.push({ path: canonicalKey(f.path), size: f.stat.size, mtime: f.stat.mtime });
    }
    const s = this.getSettings();
    if (s.syncObsidian) {
      try {
        const listed = await this.app.vault.adapter.list("/");
        const include = s.obsidianInclude.map((p) => normalizePath(p));
        for (const p of listed.files) {
          if (!p.startsWith(`${this.configDir}/`)) continue;
          if (include.length > 0 && !include.some((pref) => p === pref || p.startsWith(pref + "/"))) continue;
          try {
            const st = await this.app.vault.adapter.stat(p);
            if (st && st.type === "file") out.push({ path: canonicalKey(p), size: st.size, mtime: st.mtime });
          } catch {
            // stat race (file vanished mid-scan): skip
          }
        }
      } catch (e) {
        this.log.warn(`config dir scan failed: ${errMsg(e)}`);
      }
    }
    return out;
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

  private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await ensureDir(this.app, parentDir(path));
    this.suppress(path);
    await this.app.vault.adapter.writeBinary(path, data);
  }

  private async trashLocalFile(path: string): Promise<void> {
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

  async syncNow(reason = "manual"): Promise<SyncReport | null> {
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
      await this.pullPass(report);
      await this.pushPass(report);
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

  private async pullPass(report: SyncReport): Promise<void> {
    let since = this.index.lastSeq;
    let guard = 0;
    while (guard++ < 10000) {
      const res = await this.client.changes(since, 500);
      for (const c of res.changes) {
        try {
          await this.applyChange(c, report);
        } catch (e) {
          if (SyncEngine.isRateLimit(e)) throw e;
          report.errors.push(`pull ${c.path}: ${errMsg(e)}`);
        }
      }
      since = res.hasMore ? res.nextSeq : res.currentSeq;
      this.index.lastSeq = since;
      if (!res.hasMore) break;
    }
  }

  private async applyChange(c: Change, report: SyncReport): Promise<void> {
    const key = canonicalKey(c.path);
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
    if (entry && entry.hash && c.hash && entry.hash === c.hash && entry.version >= c.version) {
      report.skipped++;
      return;
    }

    const local = await this.localStat(key);
    if (!local) {
      // server-only file -> download
      await this.pace();
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
        await this.pace();
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
      await this.pace();
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
    report.conflicts++;
    if (s.conflictPolicy === "server") {
      this.log.warn(`conflict on ${key}: taking server version`);
      const dl = await this.client.download(remote.path);
      await this.writeBinary(key, dl.data);
      this.index.files[key] = { version: dl.version, hash: dl.hash || remote.hash || "", size: dl.data.byteLength, mtime: Date.now() };
      return;
    }
    const tag = `${s.deviceName.replace(/[^A-Za-z0-9_-]+/g, "") || "device"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const cpath = conflictPathFor(key, tag);
    this.log.warn(`conflict on ${key}: local copy kept at ${cpath}`);
    try {
      await this.writeBinary(cpath, localBuf);
      const up = await this.client.upload(cpath, localBuf, { baseVersion: 0, hash: localHash, mtime: Date.now() });
      this.index.files[cpath] = { version: up.version, hash: localHash, size: localBuf.byteLength, mtime: Date.now() };
    } catch (e) {
      report.errors.push(`conflict copy upload ${cpath}: ${errMsg(e)}`);
    }
    const dl = await this.client.download(remote.path);
    await this.writeBinary(key, dl.data);
    this.index.files[key] = { version: dl.version, hash: dl.hash || remote.hash || "", size: dl.data.byteLength, mtime: Date.now() };
  }

  private async pushPass(report: SyncReport): Promise<void> {
    const files = await this.collectLocalFiles();
    const seen = new Set<string>();
    for (const f of files) {
      seen.add(f.path);
      if (this.isExcluded(f.path)) continue;
      if (this.getSettings().maxFileSizeMB > 0 && f.size > this.getSettings().maxFileSizeMB * 1024 * 1024) {
        report.skipped++;
        continue;
      }
      const entry = this.index.files[f.path];
      if (entry && entry.size === f.size && entry.mtime === f.mtime) continue;
      let buf: ArrayBuffer;
      let hash: string;
      try {
        buf = await this.readBinary(f.path);
        hash = await sha256Hex(buf);
      } catch (e) {
        report.errors.push(`read ${f.path}: ${errMsg(e)}`);
        continue;
      }
      if (entry && entry.hash === hash) {
        this.index.files[f.path] = { version: entry.version, hash, size: f.size, mtime: f.mtime };
        continue;
      }
      try {
        await this.pace();
        await this.pushOne(f.path, buf, hash, f, report);
      } catch (e) {
        if (SyncEngine.isRateLimit(e)) throw e;
        report.errors.push(`push ${f.path}: ${errMsg(e)}`);
      }
    }

    // local deletions -> server
    if (this.index.initialized) {
      for (const key of Object.keys(this.index.files)) {
        if (seen.has(key)) continue;
        if (this.isExcluded(key)) {
          delete this.index.files[key];
          continue;
        }
        try {
          this.suppress(key);
          await this.pace();
          await this.client.remove(key, this.index.files[key].version);
          delete this.index.files[key];
          report.deleted++;
        } catch (e: any) {
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
    report: SyncReport,
  ): Promise<void> {
    const entry = this.index.files[path];
    try {
      const res = await this.client.upload(path, buf, {
        baseVersion: entry?.version ?? 0,
        mtime: stat.mtime,
        hash,
      });
      this.index.files[path] = { version: res.version, hash, size: stat.size, mtime: stat.mtime };
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
    report.conflicts++;
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
    if (s.conflictPolicy === "server") {
      const dl = await this.client.download(path);
      await this.writeBinary(path, dl.data);
      this.index.files[path] = { version: dl.version, hash: dl.hash, size: dl.data.byteLength, mtime: Date.now() };
      this.log.warn(`conflict on ${path}: took server version`);
      return;
    }
    const tag = `${s.deviceName.replace(/[^A-Za-z0-9_-]+/g, "") || "device"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const cpath = conflictPathFor(path, tag);
    await this.writeBinary(cpath, buf);
    const up = await this.client.upload(cpath, buf, { baseVersion: 0, mtime: stat.mtime, hash });
    this.index.files[cpath] = { version: up.version, hash, size: stat.size, mtime: stat.mtime };
    const dl = await this.client.download(path);
    await this.writeBinary(path, dl.data);
    this.index.files[path] = { version: dl.version, hash: dl.hash, size: dl.data.byteLength, mtime: Date.now() };
    this.log.warn(`conflict on ${path}: local copy kept at ${cpath}`);
  }

  async forceFullResync(): Promise<void> {
    this.log.info("force full resync requested");
    this.index = { lastSeq: 0, initialized: false, files: {} };
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
