import { App, Notice, PluginSettingTab, Setting, Platform, type SettingDefinitionItem } from "obsidian";
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
  syncObsidian: boolean;
  obsidianInclude: string[];
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
    serverUrl: "https://sync.earify.net:8443",
    vaultId: "",
    vaultSecret: "",
    deviceId,
    deviceName: defaultDeviceName(),
    autoSync: true,
    autoSyncIntervalSec: 30,
    syncObsidian: true,
    obsidianInclude: [],
    excludePatterns: [],
    maxFileSizeMB: 50,
    conflictPolicy: "copy",
    debug: false,
  };
}

export class SyncifySettingTab extends PluginSettingTab {
  private plugin: SyncifyPlugin;

  constructor(app: App, plugin: SyncifyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative definitions power Obsidian 1.13+ settings search. The classic
   * display() below remains the rendered UI; these mirror its simple controls.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: "Server URL", control: { type: "text", key: "serverUrl", placeholder: "https://your-server:8443" } },
      { name: "Vault ID", control: { type: "text", key: "vaultId" } },
      { name: "Vault secret", control: { type: "secret", key: "vaultSecret" } },
      { name: "Device name", control: { type: "text", key: "deviceName" } },
      { name: "Auto sync", control: { type: "toggle", key: "autoSync" } },
      { name: "Auto sync interval (seconds)", control: { type: "number", key: "autoSyncIntervalSec" } },
      { name: "Sync config folder", control: { type: "toggle", key: "syncObsidian" } },
      { name: "Max file size (MB)", control: { type: "number", key: "maxFileSizeMB" } },
      { name: "Debug logging", control: { type: "toggle", key: "debug" } },
    ];
  }

  override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override setControlValue(key: string, value: unknown): void {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    void this.plugin.saveSettings();
    this.plugin.applyAutoSync();
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
      .setName("Auto sync")
      .setDesc("Sync automatically on a timer and on file changes")
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.applyAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("Auto sync interval (seconds)")
      .setDesc("Minimum seconds between automatic syncs")
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
      .setName("Sync .obsidian config")
      .setDesc(`Sync plugin/theme settings under ${this.app.vault.configDir} (excluding caches and this plugin's folder)`)
      .addToggle((t) =>
        t.setValue(s.syncObsidian).onChange(async (v) => {
          s.syncObsidian = v;
          await this.plugin.saveSettings();
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
