import { ItemView, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type SyncifyPlugin from "./main";
import { errMsg } from "./util";

export const CONFLICT_VIEW_TYPE = "syncify-conflict-view";

interface ConflictEntry {
  conflictPath: string;
  originalPath: string;
}

/** Lists leftover .conflict-* files and lets the user resolve them:
 *  restore the conflict copy over the original, discard it, or open it. */
export class ConflictListView extends ItemView {
  private plugin: SyncifyPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: SyncifyPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType(): string {
    return CONFLICT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sync conflicts";
  }

  getIcon(): string {
    return "alert-triangle";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {}

  /** foo.conflict-<tag>.md -> foo.md */
  private deriveOriginal(path: string): string | null {
    const i = path.indexOf(".conflict-");
    if (i < 0) return null;
    const suffix = path.slice(i + ".conflict-".length);
    const dot = suffix.lastIndexOf(".");
    const ext = dot >= 0 ? suffix.slice(dot) : "";
    return path.slice(0, i) + ext;
  }

  private async scan(): Promise<ConflictEntry[]> {
    const out: ConflictEntry[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (!f.name.includes(".conflict-")) continue;
      const original = this.deriveOriginal(f.path);
      if (!original) continue;
      out.push({ conflictPath: f.path, originalPath: original });
    }
    return out.sort((a, b) => a.conflictPath.localeCompare(b.conflictPath));
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h4", { text: "Sync conflicts" });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Refresh").setIcon("refresh-cw").onClick(async () => {
        await this.render();
      }),
    );

    const entries = await this.scan();
    if (entries.length === 0) {
      contentEl.createDiv({
        text: "No conflict copies. Conflicted files appear here after syncs where both sides changed.",
      });
      return;
    }

    for (const e of entries) {
      const row = contentEl.createDiv("syncify-conflict-row");
      row.createDiv({ text: e.originalPath, cls: "syncify-conflict-path" });
      row.createDiv({ text: e.conflictPath, cls: "syncify-conflict-sub" });
      const actions = row.createDiv("syncify-conflict-actions");

      const restoreBtn = actions.createEl("button", { text: "Restore this version" });
      restoreBtn.addEventListener("click", () => {
        void (async () => {
          restoreBtn.disabled = true;
          try {
            const buf = await this.plugin.engine.readBinary(e.conflictPath);
            await this.plugin.engine.writeBinary(e.originalPath, buf);
            await this.plugin.engine.trashLocalFile(e.conflictPath);
            new Notice(`Restored ${e.originalPath}`);
            await this.render();
          } catch (err) {
            new Notice(`Restore failed: ${errMsg(err)}`, 8000);
            restoreBtn.disabled = false;
          }
        })();
      });

      const openBtn = actions.createEl("button", { text: "Open" });
      openBtn.addEventListener("click", () => {
        void (async () => {
          const file = this.app.vault.getAbstractFileByPath(e.conflictPath);
          if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
        })();
      });

      const discardBtn = actions.createEl("button", { text: "Discard", cls: "mod-warning" });
      discardBtn.addEventListener("click", () => {
        void (async () => {
          discardBtn.disabled = true;
          try {
            await this.plugin.engine.trashLocalFile(e.conflictPath);
            new Notice("Conflict copy discarded");
            await this.render();
          } catch (err) {
            new Notice(`Discard failed: ${errMsg(err)}`, 8000);
            discardBtn.disabled = false;
          }
        })();
      });
    }
  }
}
