import { Plugin, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { SyncClient } from "./api";
import { SyncEngine } from "./engine";
import { SyncLog } from "./log";
import { SyncifySettingTab, defaultSettings, type SyncifySettings } from "./settings";
import { SHARE_VIEW_TYPE, ShareListView } from "./share";
import { VaultWatcher } from "./watcher";
import { ensureDir, errMsg } from "./util";

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

  async onload(): Promise<void> {
    const stored: StoredData | null = await this.loadData();
    const deviceId =
      stored?.deviceId && typeof stored.deviceId === "string"
        ? stored.deviceId
        : (window.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.settings = { ...defaultSettings(deviceId), ...(stored ?? {}) } as SyncifySettings;
    if (!this.settings.deviceId) this.settings.deviceId = deviceId;
    if (stored?.deviceId !== this.settings.deviceId) {
      // persist immediately so every reload keeps the same device identity
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
      callback: () => void this.engine.syncNow("manual"),
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

    // ribbon + status bar
    this.addRibbonIcon("refresh-cw", "Syncify: sync now", () => void this.engine.syncNow("ribbon"));
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
    if (!this.settings.autoSync) return;
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
      const content = `# syncify diagnostics\n- time: ${new Date().toISOString()}\n- plugin: ${this.manifest.version}\n- server: ${this.settings.serverUrl}\n- vaultId: ${this.settings.vaultId}\n- device: ${this.settings.deviceName} (${this.settings.deviceId})\n- lastSeq: ${this.engine.index.lastSeq}\n- tracked files: ${Object.keys(this.engine.index.files).length}\n\n## last report\n\`\`\`\n${JSON.stringify(this.engine.lastReport, null, 2)}\n\`\`\`\n\n## log\n\`\`\`\n${this.log.formatted()}\n\`\`\`\n`;
      await this.app.vault.adapter.write(`${dir}/diagnostics.txt`, content);
      new Notice(`Diagnostics written to ${dir}/diagnostics.txt`);
    } catch (e) {
      new Notice(`Diagnostics export failed: ${errMsg(e)}`);
    }
  }
}
