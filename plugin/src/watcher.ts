import { App, EventRef, TAbstractFile } from "obsidian";
import type { SyncEngine } from "./engine";

/**
 * Watches vault events and asks the engine to sync. Our own writes are
 * suppressed by the engine so we don't loop.
 */
export class VaultWatcher {
  private debounceTimer: number | null = null;
  private pendingPaths = new Set<string>();
  private paused = false;
  private refs: EventRef[] = [];

  constructor(
    private app: App,
    private engine: SyncEngine,
    private onChangeDetected: (paths: string[]) => void,
    private debounceMs = 2000,
  ) {}

  /** Registers vault event listeners; returns refs for registerEvent(). */
  start(): EventRef[] {
    this.refs = [
      this.app.vault.on("create", (f) => this.mark(f)),
      this.app.vault.on("modify", (f) => this.mark(f)),
      this.app.vault.on("delete", (f) => this.mark(f)),
      this.app.vault.on("rename", (f, oldPath) => {
        this.engine.suppress(oldPath);
        this.mark(f);
      }),
    ];
    // adapter-level changes (config files) don't always fire vault events;
    // the auto-sync timer covers those.
    return this.refs;
  }

  stop(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();
    this.refs = [];
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  private mark(f: TAbstractFile): void {
    if (this.paused) return;
    if (this.engine.isSuppressed(f.path)) return;
    this.pendingPaths.add(f.path);
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      const paths = Array.from(this.pendingPaths);
      this.pendingPaths.clear();
      this.debounceTimer = null;
      if (paths.length > 0) this.onChangeDetected(paths);
    }, this.debounceMs);
  }
}
