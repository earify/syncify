import { App, Notice, PluginSettingTab, Setting, Platform } from "obsidian";
import type SyncifyPlugin from "./main";
import { errMsg } from "./util";

export interface SyncifySettings {
  serverUrl: string;
  vaultId: string;
  vaultSecret: string;
  deviceId: string;
  deviceName: string;
  autoSync: boolean;
  autoSyncIntervalSec: number;
  /** Sync shortly after local file changes (watcher debounce). */
  syncOnFileChange: boolean;
  syncObsidian: boolean;
  /** Include/exclude rules for the config folder, relative to configDir.
   *  path "" is the root rule. Deepest matching rule wins. No rules = sync all. */
  configRules: Array<{ path: string; include: boolean }>;
  excludePatterns: string[];
  maxFileSizeMB: number;
  conflictPolicy: "copy" | "server";
  debug: boolean;
}

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iOS";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isMobileApp) return "Mobile";
  return "PC";
}

export function defaultSettings(deviceId: string): SyncifySettings {
  return {
    serverUrl: "",
    vaultId: "",
    vaultSecret: "",
    deviceId,
    deviceName: defaultDeviceName(),
    autoSync: true,
    autoSyncIntervalSec: 30,
    syncOnFileChange: true,
    syncObsidian: true,
    configRules: [],
    excludePatterns: [],
    maxFileSizeMB: 50,
    conflictPolicy: "copy",
    debug: false,
  };
}

interface ConfigTreeNode {
  name: string;
  path: string; // relative to configDir
  isFolder: boolean;
  children?: ConfigTreeNode[];
}

export class SyncifySettingTab extends PluginSettingTab {
  private plugin: SyncifyPlugin;

  constructor(app: App, plugin: SyncifyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // NOTE: deliberately NOT implementing getSettingDefinitions() — on Obsidian
  // 1.13+/1.14 the framework renders the declarative definitions INSTEAD of
  // display(), which hides the config tree and every display()-only control.

  /** Effective include state of a config-relative path under the current rules.
   *  Deepest matching rule wins; path "" (root) is the fallback. */
  private effectiveConfigState(rules: Array<{ path: string; include: boolean }>, rel: string): boolean {
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

  /** Mixed state: any descendant disagrees with the node's effective state. */
  private nodeIsMixed(
    rules: Array<{ path: string; include: boolean }>,
    node: ConfigTreeNode,
    nodeState: boolean,
  ): boolean {
    const differs = (n: ConfigTreeNode): boolean =>
      this.effectiveConfigState(rules, n.path) !== nodeState || (n.children ?? []).some(differs);
    return (node.children ?? []).some(differs);
  }

  private async renderConfigTree(box: HTMLElement): Promise<void> {
    const cfg = this.app.vault.configDir;
    const rules = this.plugin.settings.configRules ?? [];
    let tree: ConfigTreeNode[] = [];
    try {
      tree = await this.buildConfigTree(cfg, 0);
    } catch (e) {
      box.createEl("p", { text: `Could not list config folder: ${errMsg(e)}`, cls: "mod-warning" });
      return;
    }

    const setRule = (path: string, include: boolean) => {
      const list = this.plugin.settings.configRules;
      const existing = list.find((r) => r.path === path);
      if (existing) existing.include = include;
      else list.push({ path, include });
      void this.plugin.saveSettings();
    };

    const rerender = () => {
      box.empty();
      void this.renderConfigTree(box);
    };

    const renderNode = (container: HTMLElement, node: ConfigTreeNode, depth: number): void => {
      if (rendered >= MAX_TREE_ROWS) return;
      rendered++;
      const state = this.effectiveConfigState(rules, node.path);
      const hasOwnRule = rules.some((r) => r.path === node.path);
      const row = container.createDiv("syncify-tree-row");
      row.style.paddingLeft = `${depth * 16 + 4}px`;
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = state;
      cb.indeterminate = this.nodeIsMixed(rules, node, state);
      cb.addEventListener("change", () => {
        setRule(node.path, cb.checked);
        rerender();
      });
      row.createSpan({ text: node.name, cls: "syncify-tree-name" });
      if (hasOwnRule && !state) row.createSpan({ text: "excluded", cls: "syncify-tree-tag" });
      for (const child of node.children ?? []) renderNode(container, child, depth + 1);
    };

    let rendered = 0;
    const MAX_TREE_ROWS = 400;

    // root rule row — the fallback for every unlisted path
    const rootState = this.effectiveConfigState(rules, "");
    const rootRow = box.createDiv("syncify-tree-row");
    rootRow.style.display = "flex";
    rootRow.style.alignItems = "center";
    rootRow.style.gap = "6px";
    rootRow.style.fontWeight = "600";
    const rootCb = rootRow.createEl("input", { type: "checkbox" });
    rootCb.checked = rootState;
    rootCb.indeterminate = tree.some((n) => this.effectiveConfigState(rules, n.path) !== rootState);
    rootCb.addEventListener("change", () => {
      setRule("", rootCb.checked);
      rerender();
    });
    rootRow.createSpan({ text: `${cfg} (everything)`, cls: "syncify-tree-name" });

    const list = box.createDiv("syncify-tree-list");
    for (const n of tree) renderNode(list, n, 0);
    if (rendered >= MAX_TREE_ROWS) {
      list.createEl("p", {
        text: "List truncated — untick large subtrees you don't need to browse into.",
        cls: "setting-item-description",
      });
    }
  }

  private async buildConfigTree(folder: string, depth: number): Promise<ConfigTreeNode[]> {
    if (depth > 6) return [];
    const cfg = this.app.vault.configDir;
    const listed = await this.app.vault.adapter.list(folder);
    const nodes: ConfigTreeNode[] = [];
    for (const d of listed.folders) {
      const rel = d.slice(cfg.length + 1);
      const name = rel.split("/").pop() ?? rel;
      if (name === "node_modules") {
        // treat as a leaf: follows its parent folder's state
        nodes.push({ name, path: rel, isFolder: true });
        continue;
      }
      nodes.push({ name, path: rel, isFolder: true, children: await this.buildConfigTree(d, depth + 1) });
    }
    for (const f of listed.files) {
      const rel = f.slice(cfg.length + 1);
      nodes.push({ name: rel.split("/").pop() ?? rel, path: rel, isFolder: false });
    }
    return nodes.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("syncify server base URL")
      .addText((t) =>
        t.setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim().replace(/\/+$/, "");
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Vault ID")
      .addText((t) =>
        t.setValue(s.vaultId).onChange(async (v) => {
          s.vaultId = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Vault secret")
      .setDesc("Shown once when the vault was initialized on the server")
      .addText((t) => {
        t.setValue(s.vaultSecret).onChange(async (v) => {
          s.vaultSecret = v.trim();
          await this.plugin.saveSettings();
        });
        t.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Label used in conflicts and server change log")
      .addText((t) =>
        t.setValue(s.deviceName).onChange(async (v) => {
          s.deviceName = v.trim() || defaultDeviceName();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify server URL, vault ID and secret")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const btn = b.buttonEl;
          btn.disabled = true;
          b.setButtonText("Testing…");
          try {
            await this.plugin.client.testAuth();
            new Notice("syncify: connection OK");
          } catch (e) {
            new Notice(`syncify: connection failed (${errMsg(e)})`);
          } finally {
            btn.disabled = false;
            b.setButtonText("Test");
          }
        }),
      );

    new Setting(containerEl).setName("Sync behavior").setHeading();

    new Setting(containerEl)
      .setName("Auto sync (interval)")
      .setDesc("Sync automatically on a timer, on WebSocket pushes and when Obsidian regains focus")
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.applyAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("Auto sync interval (seconds)")
      .setDesc("Seconds between automatic background syncs")
      .addText((t) =>
        t.setValue(String(s.autoSyncIntervalSec)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 5) {
            s.autoSyncIntervalSec = Math.floor(n);
            await this.plugin.saveSettings();
            this.plugin.applyAutoSync();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync on file changes")
      .setDesc("Sync shortly after you edit, create, delete or rename files (independent of the interval)")
      .addToggle((t) =>
        t.setValue(s.syncOnFileChange).onChange(async (v) => {
          s.syncOnFileChange = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync config folder")
      .setDesc(`Sync plugin/theme settings under ${this.app.vault.configDir} (caches, workspace and this plugin's folder are always excluded)`)
      .addToggle((t) =>
        t.setValue(s.syncObsidian).onChange(async (v) => {
          s.syncObsidian = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (s.syncObsidian) {
      const box = containerEl.createDiv("syncify-config-tree");
      box.createEl("p", {
        text: `Pick exactly which files and folders inside ${this.app.vault.configDir} sync. Checked = sync, unchecked = skip, dash = partially selected. Deeper choices override their parents; unticked entries stop syncing (server copies are left untouched).`,
        cls: "setting-item-description",
      });
      void this.renderConfigTree(box);
    }

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("Glob patterns, one per line (e.g. Private/**)")
      .addTextArea((t) => {
        t.setValue(s.excludePatterns.join("\n")).onChange(async (v) => {
          s.excludePatterns = v
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.addClass("syncify-textarea");
      });

    new Setting(containerEl)
      .setName("Conflict policy")
      .setDesc("copy: keep local edit as a .conflict file; server: discard local edit")
      .addDropdown((d) =>
        d
          .addOption("copy", "Keep local copy")
          .addOption("server", "Take server version")
          .setValue(s.conflictPolicy)
          .onChange(async (v) => {
            s.conflictPolicy = v as SyncifySettings["conflictPolicy"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Files larger than this are skipped")
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.maxFileSizeMB = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose log to console; needed for diagnostics export")
      .addToggle((t) =>
        t.setValue(s.debug).onChange(async (v) => {
          s.debug = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Force full resync")
      .setDesc("Rebuild the local index and pull everything from the server, then push local changes. Local files are not deleted.")
      .addButton((b) =>
        b.setButtonText("Resync").onClick(async () => {
          await this.plugin.engine?.forceFullResync();
        }),
      );

    new Setting(containerEl)
      .setName("Export diagnostics")
      .setDesc("Write recent sync log entries to the vault (.syncify/diagnostics.txt)")
      .addButton((b) =>
        b.setButtonText("Export").onClick(async () => {
          await this.plugin.exportDiagnostics();
        }),
      );
  }
}
