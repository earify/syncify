export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;

/** In-memory ring buffer of sync log entries; mirrors to console when debug. */
export class SyncLog {
  private entries: LogEntry[] = [];

  constructor(private debugEnabled = false) {}

  setDebug(on: boolean): void {
    this.debugEnabled = on;
  }

  log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { t: Date.now(), level, msg };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    if (this.debugEnabled || level === "error") {
      const line = `[syncify] ${msg}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  debug(msg: string): void {
    this.log("debug", msg);
  }

  info(msg: string): void {
    this.log("info", msg);
  }

  warn(msg: string): void {
    this.log("warn", msg);
  }

  error(msg: string): void {
    this.log("error", msg);
  }

  recent(max = MAX_ENTRIES): LogEntry[] {
    return this.entries.slice(-max);
  }

  formatted(): string {
    return this.recent()
      .map((e) => {
        const time = new Date(e.t).toISOString();
        return `${time} [${e.level}] ${e.msg}`;
      })
      .join("\n");
  }
}
