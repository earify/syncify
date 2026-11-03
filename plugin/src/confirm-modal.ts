import { App, Modal } from "obsidian";

/** Confirmation modal with a (capped) list of planned changes. */
export class ListConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private titleText: string,
    private lines: string[],
    private onConfirm: () => void,
    private onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.titleText });

    const list = contentEl.createDiv("syncify-confirm-list");
    const MAX = 200;
    for (const line of this.lines.slice(0, MAX)) {
      list.createEl("div", { text: line, cls: "syncify-confirm-line" });
    }
    if (this.lines.length > MAX) {
      list.createEl("div", { text: `...and ${this.lines.length - MAX} more`, cls: "syncify-confirm-more" });
    }

    const buttons = contentEl.createDiv("syncify-confirm-buttons");
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.confirmed = false;
      this.close();
    });
    const ok = buttons.createEl("button", { text: "Confirm", cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.confirmed) this.onCancel();
  }
}

/** Promise-based helper: resolves true when the user confirms. */
export function confirmList(app: App, titleText: string, lines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    new ListConfirmModal(
      app,
      titleText,
      lines,
      () => resolve(true),
      () => resolve(false),
    ).open();
  });
}
