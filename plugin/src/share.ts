import { ItemView, Notice, WorkspaceLeaf, Setting, TFile } from "obsidian";
import type { ShareInfo } from "./api";
import type { SyncClient } from "./api";

export const SHARE_VIEW_TYPE = "syncify-share-view";

export class ShareListView extends ItemView {
  private client: SyncClient;

  constructor(leaf: WorkspaceLeaf, client: SyncClient) {
    super(leaf);
    this.client = client;
    this.navigation = false;
  }

  getViewType(): string {
    return SHARE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Shared notes";
  }

  getIcon(): string {
    return "share-2";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {}

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h4", { text: "Shared notes" });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Refresh")
        .setIcon("refresh-cw")
        .onClick(async () => {
          await this.render();
        }),
    );

    let shares: ShareInfo[] = [];
    try {
      shares = await this.client.listShares();
    } catch (e: any) {
      contentEl.createEl("div", { text: `Failed to list shares: ${e?.message ?? e}`, cls: "mod-warning" });
      return;
    }
    if (shares.length === 0) {
      contentEl.createEl("div", { text: "No shared notes yet. Use the command palette: “Copy share link for current note”." });
      return;
    }

    for (const s of shares) {
      const row = contentEl.createDiv("share-list-item");
      if (!s.enabled) row.addClass("disabled");
      const path = row.createSpan({ cls: "share-path", text: s.path });
      path.setAttribute("title", s.path);

      new Setting(row)
        .addExtraButton((b) =>
          b
            .setIcon("copy")
            .setTooltip("Copy link")
            .onClick(async () => {
              await navigator.clipboard.writeText(this.client.shareUrl(s.shareId));
              new Notice("Link copied");
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon(s.enabled ? "eye-off" : "eye")
            .setTooltip(s.enabled ? "Disable" : "Enable")
            .onClick(async () => {
              await this.client.setShareEnabled(s.shareId, !s.enabled);
              await this.render();
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash-2")
            .setTooltip("Delete")
            .onClick(async () => {
              await this.client.deleteShare(s.shareId);
              await this.render();
            }),
        );
    }
  }
}
