import { App, Modal, ProgressBarComponent } from "obsidian";

/** Modal showing start / progress / finish states for manual config sync. */
export class SyncifyProgressModal extends Modal {
  private declare statusEl: HTMLElement;
  private declare bar: ProgressBarComponent;
  private declare countEl: HTMLElement;

  constructor(app: App, private titleText: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncify-progress-modal");
    contentEl.createEl("h3", { text: this.titleText });
    this.statusEl = contentEl.createEl("p", { text: "Starting…", cls: "syncify-progress-status" });
    const barContainer = contentEl.createDiv("syncify-progress-bar");
    this.bar = new ProgressBarComponent(barContainer);
    this.bar.setValue(0);
    this.countEl = contentEl.createEl("p", { text: "", cls: "syncify-progress-count" });
  }

  /** Live progress: 0-100 percent plus a done/total counter. */
  progress(done: number, total: number | null): void {
    if (total && total > 0) this.bar.setValue(Math.min(100, Math.round((done / total) * 100)));
    else this.bar.setValue(Math.min(99, done % 100));
    this.countEl.setText(total != null ? `${done} / ${total}` : String(done));
  }

  message(text: string): void {
    this.statusEl.setText(text);
  }

  /** Final state; the modal closes itself shortly after. */
  finish(text: string): void {
    this.statusEl.setText(text);
    this.bar.setValue(100);
    this.countEl.setText("");
    window.setTimeout(() => this.close(), 1600);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
