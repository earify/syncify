import { App, ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type SyncifyPlugin from "./main";
import { errMsg } from "./util";

export const TRASH_VIEW_TYPE = "syncify-trash-view";

interface TrashEntry {
  path: string;
  version: number;
  size: number;
  hash: string;
  deletedAt: number;
  expiresAt: number;
}

/** Browse files kept in the server trash (30-day retention) and restore them.
 *  Restoring re-creates the file on the server; it then syncs back down. */
export class TrashListView extends ItemView {
  private plugin: SyncifyPlugin;
  private filterText = "";

  constructor(leaf: WorkspaceLeaf, plugin: SyncifyPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType(): string {
    return TRASH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "File versions (server trash)";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {}

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h4", { text: "File versions (server trash)" });
    contentEl.createEl("p", {
      text: "Deleted files are kept on the server for 30 days. Restore brings a file back on the server; it then syncs down to this device.",
      cls: "setting-item-description",
    });

    const controls = contentEl.createDiv("syncify-trash-controls");
    const search = controls.createEl("input", { type: "text", placeholder: "Filter by path..." });
    search.addClass("syncify-trash-filter");
    search.value = this.filterText;
    search.addEventListener("input", () => {
      this.filterText = search.value;
      void this.renderList();
    });

    new Setting(controls).addButton((b) =>
      b.setButtonText("Refresh").setIcon("refresh-cw").onClick(async () => {
        await this.renderList();
      }),
    );

    contentEl.createDiv("syncify-trash-list");
    await this.renderList();
  }

  private async renderList(): Promise<void> {
    const { contentEl } = this;
    const list = contentEl.querySelector(".syncify-trash-list");
    if (!list) return;
    list.empty();

    let entries: TrashEntry[] = [];
    try {
      entries = await this.plugin.client.listTrash();
    } catch (e) {
      list.createEl("div", { text: `Failed to list trash: ${errMsg(e)}`, cls: "mod-warning" });
      return;
    }
    entries.sort((a, b) => b.deletedAt - a.deletedAt);

    const q = this.filterText.toLowerCase();
    const shown = q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries;

    if (shown.length === 0) {
      list.createEl("div", { text: "No matching trashed files." });
      return;
    }

    for (const t of shown) {
      const row = list.createDiv("syncify-trash-row");
      const date = new Date(t.deletedAt).toISOString().slice(0, 16).replace("T", " ");
      row.createDiv({ text: t.path, cls: "syncify-trash-path" });
      row.createDiv({ text: `deleted ${date} - ${t.size} bytes`, cls: "syncify-trash-meta" });

      const restoreBtn = row.createEl("button", { text: "Restore" });
      restoreBtn.addEventListener("click", async () => {
        restoreBtn.disabled = true;
        try {
          await this.plugin.client.restoreFromTrash(t.path);
          new Notice(`Restored ${t.path} on the server; it will sync down shortly`);
          row.remove();
        } catch (err) {
          new Notice(`Restore failed: ${errMsg(err)}`, 8000);
          restoreBtn.disabled = false;
        }
      });
    }
  }
}
