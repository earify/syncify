import { Plugin, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { SyncClient } from "./api";
import { SyncEngine } from "./engine";
import { SyncLog } from "./log";
import { SyncifySettingTab, defaultSettings, type SyncifySettings } from "./settings";
import { SHARE_VIEW_TYPE, ShareListView } from "./share";
import { VaultWatcher } from "./watcher";;
import { ensureDir, errMsg, isRecord } from "./util";

const DATA_VERSION = 1;

interface StoredData extends Partial<SyncifySettings> {
  dataVersion?: number;
}

export default class SyncifyPlugin extends Plugin {
  declare settings: SyncifySettings;
  client!: SyncClient;
  engine!: SyncEngine;
  log = new SyncLog(false);
  private watcher!: VaultWatcher;
  private autoTimer: number | null = null;
  private lastAutoSync = 0;
  private stopWs: (() => void) | null = null;
  private wsConnected = false;
  private statusEl: HTMLElement | null = null;
  private syncNotice: Notice | null = null;

  async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    const rec: Record<string, unknown> = isRecord(raw) ? raw : {};
    const stored: Partial<StoredData> = Object.assign({}, rec);
    const deviceId =
      typeof stored.deviceId === "string" && stored.deviceId
        ? stored.deviceId
        : (window.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.settings = { ...defaultSettings(deviceId), ...stored };
    if (!this.settings.deviceId) this.settings.deviceId = deviceId;
    if (stored.deviceId !== this.settings.deviceId) {
      // persist immediately so every reload keeps the same device identity
      await this.saveData({ ...this.settings, dataVersion: DATA_VERSION });
    }
    // migrate 0.1.4–0.1.7 config scope modes into configRules
    if (rec["obsidianMode"] === "selected" || rec["obsidianMode"] === "exclude") {
      const rootInclude = rec["obsidianMode"] === "exclude";
      const inc = rec["obsidianInclude"];
      const entries = Array.isArray(inc) ? inc.filter((x): x is string => typeof x === "string") : [];
      this.settings.configRules = [
        { path: "", include: rootInclude },
        ...entries.map((p) => ({ path: p, include: !rootInclude })),
      ];
      await this.saveData({ ...this.settings, dataVersion: DATA_VERSION });
    }
    this.log.setDebug(this.settings.debug);

    this.client = new SyncClient({
      serverUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      secret: this.settings.vaultSecret,
      deviceId: this.settings.deviceId,
    });
    this.engine = new SyncEngine(
      this.app,
      this.client,
      () => this.settings,
      this.log,
      () => this.updateStatus(),
    );
    await this.engine.loadIndex();

    this.watcher = new VaultWatcher(this.app, this.engine, () => {
      void this.requestAutoSync("file-change");
    });
    for (const ref of this.watcher.start()) this.registerEvent(ref);

    this.registerView(SHARE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ShareListView(leaf, this.client));

    // commands
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.runManualSync(),
    });
    this.addCommand({
      id: "force-full-resync",
      name: "Force full resync",
      callback: () => void this.engine.forceFullResync(),
    });
    this.addCommand({
      id: "copy-share-link",
      name: "Copy share link for current note",
      callback: () => void this.copyShareLink(),
    });
    this.addCommand({
      id: "open-share-view",
      name: "Open shared notes view",
      callback: () => void this.openShareView(),
    });
    this.addCommand({
      id: "export-diagnostics",
      name: "Export diagnostics",
      callback: () => void this.exportDiagnostics(),
    });
    this.addCommand({
      id: "upload-config",
      name: "Upload config to server",
      callback: () => void this.uploadConfig(),
    });
    this.addCommand({
      id: "load-config",
      name: "Load config from server",
      callback: () => void this.loadConfig(),
    });

    // ribbon + status bar
    this.addRibbonIcon("refresh-cw", "Syncify: sync now", () => this.runManualSync());
    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    this.addSettingTab(new SyncifySettingTab(this.app, this));

    // auto sync timer
    this.applyAutoSync();

    // WS live updates
    this.connectWs();

    // resync-ish trigger when app becomes visible again (mobile-friendly)
    const onVis = () => {
      if (!document.hidden && this.settings.autoSync) void this.requestAutoSync("visibility");
    };
    document.addEventListener("visibilitychange", onVis);
    this.register(() => document.removeEventListener("visibilitychange", onVis));

    // one initial sync shortly after startup so the vault converges immediately
    const startupTimer = window.setTimeout(() => void this.requestAutoSync("startup"), 4000);
    this.register(() => window.clearTimeout(startupTimer));
  }

  onunload(): void {
    if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
    this.stopWs?.();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, dataVersion: DATA_VERSION });
    this.client.update({
      serverUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      secret: this.settings.vaultSecret,
      deviceId: this.settings.deviceId,
    });
    this.log.setDebug(this.settings.debug);
    this.connectWs();
  }

  applyAutoSync(): void {
    if (this.autoTimer !== null) {
      window.clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    if (this.settings.autoSync && this.settings.autoSyncIntervalSec >= 5) {
      this.autoTimer = this.registerInterval(
        window.setInterval(() => {
          void this.requestAutoSync("timer");
        }, this.settings.autoSyncIntervalSec * 1000),
      );
    }
  }

  private async requestAutoSync(reason: string): Promise<void> {
    // two independent triggers: the interval (autoSync) and local file edits (syncOnFileChange)
    const allowed = reason === "file-change" ? this.settings.syncOnFileChange : this.settings.autoSync;
    if (!allowed) return;
    if (!this.settings.vaultId || !this.settings.vaultSecret) return;
    if (this.engine.isCoolingDown) return;
    const now = Date.now();
    if (now - this.lastAutoSync < 4000) return;
    this.lastAutoSync = now;
    await this.engine.syncNow(reason);
  }

  private connectWs(): void {
    this.stopWs?.();
    this.stopWs = null;
    if (!this.settings.vaultId || !this.settings.vaultSecret) return;
    this.stopWs = this.client.connectWs(
      () => {
        void this.requestAutoSync("ws");
      },
      (connected) => {
        this.wsConnected = connected;
        this.updateStatus();
      },
    );
  }

  /** Manual "Sync now": shows a live corner notice for start/progress/end. */
  private runManualSync(): void {
    if (this.syncNotice) this.syncNotice.hide();
    const notice = new Notice("syncify: sync started...", 0);
    this.syncNotice = notice;
    void this.engine
      .syncNow("manual", (p) => {
        notice.setMessage(`syncify: sync - ${p.message}`);
      })
      .then((rep) => {
        notice.hide();
        this.syncNotice = null;
        if (rep) {
          new Notice(
            `syncify: sync complete - up:${rep.pushed} down:${rep.pulled} del:${rep.deleted} conflict:${rep.conflicts} err:${rep.errors.length}`,
            6000,
          );
        }
      })
      .catch((e) => {
        notice.hide();
        this.syncNotice = null;
        new Notice(`Sync failed: ${errMsg(e)}`, 8000);
      });
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const el = this.statusEl;
    el.empty();
    const rep = this.engine.lastReport;
    if (this.engine.state === "syncing") {
      const s = el.createSpan({ text: "syncify: syncing…", cls: "syncify-status-syncing" });
      s.setAttribute("title", "sync in progress");
      return;
    }
    let text = "syncify: idle";
    let cls = "syncify-status-ok";
    if (this.engine.state === "error") {
      text = "syncify: error";
      cls = "syncify-status-err";
    } else if (rep) {
      text = `syncify: ↑${rep.pushed} ↓${rep.pulled}`;
    }
    if (this.wsConnected) text += " ●";
    const s = el.createSpan({ text, cls });
    if (rep) {
      const errs = rep.errors.length > 0 ? `\nerrors:\n- ${rep.errors.slice(0, 5).join("\n- ")}` : "";
      s.setAttribute(
        "title",
        `last sync (${rep.reason}): ↑${rep.pushed} sent, ↓${rep.pulled} received, ✕${rep.deleted} deleted, =${rep.skipped} skipped, conflicts: ${rep.conflicts}${errs}`,
      );
    }
  }

  private async copyShareLink(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (!(active instanceof TFile)) {
      new Notice("Open a note to share");
      return;
    }
    try {
      // make sure the file exists on the server first
      if (!this.engine.index.files[active.path]) {
        new Notice("Syncing file first…");
        await this.engine.syncNow("share-prepush");
      }
      const share = await this.client.createShare(active.path);
      const url = this.client.shareUrl(share.shareId);
      await navigator.clipboard.writeText(url);
      new Notice(`Share link copied:\n${url}`, 8000);
    } catch (e) {
      new Notice(`Share failed: ${errMsg(e)}`, 8000);
    }
  }

  private async openShareView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SHARE_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: SHARE_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ShareListView) await view.render();
  }

  async exportDiagnostics(): Promise<void> {
    const dir = ".syncify";
    try {
      await ensureDir(this.app, dir);
      const content = `# syncify diagnostics\n- time: ${new Date().toISOString()}\n- plugin: ${this.manifest.version}\n- server: ${this.settings.serverUrl}\n- vaultId: ${this.settings.vaultId}\n- deviceId: ${this.settings.deviceId}\n- lastSeq: ${this.engine.index.lastSeq}\n- tracked files: ${Object.keys(this.engine.index.files).length}\n\n## last report\n\`\`\`\n${JSON.stringify(this.engine.lastReport, null, 2)}\n\`\`\`\n\n## log\n\`\`\`\n${this.log.formatted()}\n\`\`\`\n`;
      await this.app.vault.adapter.write(`${dir}/diagnostics.txt`, content);
      new Notice(`Diagnostics written to ${dir}/diagnostics.txt`);
    } catch (e) {
      new Notice(`Diagnostics export failed: ${errMsg(e)}`);
    }
  }

  async uploadConfig(): Promise<void> {
    const notice = new Notice("syncify: config upload started...", 0);
    try {
      const r = await this.engine.manualUploadConfig((p) => {
        notice.setMessage(
          `syncify: config upload - ${p.message}${p.total != null ? ` (${p.done}/${p.total})` : ` (${p.done})`}`,
        );
      });
      notice.hide();
      new Notice(`syncify: config upload complete - up:${r.uploaded} del:${r.deleted} skip:${r.skipped} err:${r.errors.length}`, 8000);
      for (const err of r.errors.slice(0, 3)) this.log.error(err);
    } catch (e) {
      notice.hide();
      new Notice(`Config upload failed: ${errMsg(e)}`, 8000);
    }
  }

  async loadConfig(): Promise<void> {
    const notice = new Notice("syncify: config load started...", 0);
    try {
      const r = await this.engine.manualLoadConfig((p) => {
        notice.setMessage(
          `syncify: config load - ${p.message}${p.total != null ? ` (${p.done}/${p.total})` : ` (${p.done})`}`,
        );
      });
      notice.hide();
      new Notice(`syncify: config load complete - got:${r.loaded} del:${r.deleted} skip:${r.skipped} err:${r.errors.length}`, 8000);
      for (const err of r.errors.slice(0, 3)) this.log.error(err);
    } catch (e) {
      notice.hide();
      new Notice(`Config load failed: ${errMsg(e)}`, 8000);
    }
  }
}