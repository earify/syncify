import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SyncifyPlugin from "./main";
import { errMsg } from "./util";

export interface SyncifySettings {
  serverUrl: string;
  vaultId: string;
  vaultSecret: string;
  deviceId: string;
  autoSync: boolean;
  autoSyncIntervalSec: number;
  /** Sync shortly after local file changes (watcher debounce). */
  syncOnFileChange: boolean;
  /** Skip auto sync when the device reports a cellular connection. */
  wifiOnly: boolean;
  /** The config folder (.obsidian) is NEVER auto-synced. Manual upload/load
   *  commands respect these include/exclude rules (relative to configDir,
   *  deepest matching rule wins, "" = root rule, no rules = sync all). */
  configRules: Array<{ path: string; include: boolean }>;
  excludePatterns: string[];
  maxFileSizeMB: number;
  conflictPolicy: "copy" | "server";
  debug: boolean;
}

export function defaultSettings(deviceId: string): SyncifySettings {
  return {
    serverUrl: "",
    vaultId: "",
    vaultSecret: "",
    deviceId,
    autoSync: true,
    autoSyncIntervalSec: 30,
    syncOnFileChange: true,
    wifiOnly: false,
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
      row.addClass("syncify-depth-" + Math.min(depth, 6));
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
    const rootRow = box.createDiv("syncify-tree-row syncify-tree-root");
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
      })
      .addExtraButton((b) =>
        b
          .setIcon("copy")
          .setTooltip("Copy vault secret to clipboard")
          .onClick(async () => {
            if (!s.vaultSecret) {
              new Notice("No vault secret set");
              return;
            }
            await navigator.clipboard.writeText(s.vaultSecret);
            new Notice("Vault secret copied to clipboard");
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
      .setDesc("Sync notes and attachments automatically on a timer, on WebSocket pushes and when Obsidian regains focus")
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

    new Setting(containerEl).setName(`Config folder (${this.app.vault.configDir})`).setHeading();

    new Setting(containerEl)
      .setName("WiFi-only auto sync (mobile)")
      .setDesc("Skip automatic syncs while the device reports a cellular connection. Manual syncs are unaffected.")
      .addToggle((t) =>
        t.setValue(s.wifiOnly).onChange(async (v) => {
          s.wifiOnly = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Manual config sync")
      .setDesc(
        `The config folder is NEVER auto-synced. Use the commands below (or the command palette) to upload your config to the server or load the server's config onto this device. The tree picks which entries are included.`,
      );

    const treeBox = containerEl.createDiv("syncify-config-tree");
    treeBox.createEl("p", {
      text: `Checked entries are included in manual upload/load, unchecked are skipped. Deeper choices override their parents.`,
      cls: "setting-item-description",
    });
    void this.renderConfigTree(treeBox);

    new Setting(containerEl)
      .setName("Run manual config sync")
      .setDesc("Upload replaces the server's selected config with this device's; Load replaces this device's selected config with the server's. Neither deletes files.")
      .addButton((b) =>
        b
          .setButtonText("Upload to server")
          .setCta()
          .onClick(async () => {
            const btn = b.buttonEl;
            btn.disabled = true;
            b.setButtonText("Uploading…");
            try {
              await this.plugin.uploadConfig();
            } catch (e) {
              new Notice(`Config upload failed: ${errMsg(e)}`, 8000);
            } finally {
              btn.disabled = false;
              b.setButtonText("Upload to server");
            }
          }),
      )
      .addButton((b) =>
        b
          .setButtonText("Load from server")
          .onClick(async () => {
            const btn = b.buttonEl;
            btn.disabled = true;
            b.setButtonText("Loading…");
            try {
              await this.plugin.loadConfig();
            } catch (e) {
              new Notice(`Config load failed: ${errMsg(e)}`, 8000);
            } finally {
              btn.disabled = false;
              b.setButtonText("Load from server");
            }
          }),
      );

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
