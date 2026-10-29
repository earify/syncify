import { requestUrl } from "obsidian";
import type { ChangesResponse, ConflictInfo, FileMeta, PushResult, VaultMeta } from "./protocol";

export class SyncConflictError extends Error {
  constructor(public info: ConflictInfo) {
    super(`conflict on ${info.path}`);
  }
}

export class SyncApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(`${message} (HTTP ${status})`);
  }
}

export interface ShareInfo {
  shareId: string;
  path: string;
  createdAt: number;
  enabled: boolean;
}

export interface DownloadResult {
  data: ArrayBuffer;
  hash: string;
  version: number;
  mtime: number;
  size: number;
}

export interface UploadMeta {
  baseVersion?: number;
  mtime?: number;
  hash?: string;
  seenDeleteVersion?: number;
}

interface ClientOptions {
  serverUrl: string;
  vaultId: string;
  secret: string;
  deviceId: string;
}

/**
 * HTTP client for the syncify server (protocol compatible with eari-sync v1).
 * Uses Obsidian's requestUrl so it works on desktop and mobile, CORS-free.
 */
export class SyncClient {
  constructor(private opts: ClientOptions) {}

  update(opts: Partial<ClientOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  private base(): string {
    return this.opts.serverUrl.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.secret}`,
      "x-vault-id": this.opts.vaultId,
      "x-client-id": this.opts.deviceId,
      ...extra,
    };
  }

  private async call(
    method: string,
    path: string,
    extra: Record<string, string>,
    body?: ArrayBuffer | string,
  ): Promise<{ status: number; headers: Record<string, string>; data: ArrayBuffer; text: string }> {
    const res = await requestUrl({
      url: `${this.base()}${path}`,
      method,
      headers: extra,
      body,
      throw: false,
    });
    if (res.status >= 400) {
      let msg = "request failed";
      let body: unknown;
      try {
        body = res.json;
        const errText = (body as { error?: string } | null)?.error;
        msg = errText ?? msg;
      } catch {
        try {
          msg = res.text || msg;
        } catch {
          // response had no usable body
        }
      }
      throw new SyncApiError(res.status, msg, body);
    }
    return { status: res.status, headers: res.headers, data: res.arrayBuffer, text: res.text };
  }

  async testAuth(): Promise<void> {
    await this.call("POST", "/api/v1/auth/test", {
      "content-type": "application/json",
      "x-vault-id": this.opts.vaultId,
    }, JSON.stringify({ vaultId: this.opts.vaultId, secret: this.opts.secret }));
  }

  async meta(): Promise<VaultMeta> {
    const res = await this.call("GET", `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/meta`, this.headers());
    return JSON.parse(res.text) as VaultMeta;
  }

  async changes(since: number, limit = 500): Promise<ChangesResponse> {
    const res = await this.call(
      "GET",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/changes?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`,
      this.headers(),
    );
    return JSON.parse(res.text) as ChangesResponse;
  }

  async listFiles(): Promise<FileMeta[]> {
    const res = await this.call("GET", `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/files`, this.headers());
    return JSON.parse(res.text) as FileMeta[];
  }

  async download(path: string): Promise<DownloadResult> {
    const res = await this.call(
      "GET",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
      this.headers(),
    );
    return {
      data: res.data,
      hash: String(res.headers["x-hash"] ?? ""),
      version: Number(res.headers["x-version"] ?? 0),
      mtime: Number(res.headers["x-mtime"] ?? 0),
      size: Number(res.headers["x-size"] ?? res.data.byteLength),
    };
  }

  async upload(path: string, data: ArrayBuffer, meta: UploadMeta = {}): Promise<PushResult> {
    const headers = this.headers({
      "content-type": "application/octet-stream",
      "x-base-version": String(meta.baseVersion ?? 0),
      "x-mtime": String(meta.mtime ?? Date.now()),
    });
    if (meta.hash) headers["x-hash"] = meta.hash;
    if (meta.seenDeleteVersion) headers["x-seen-delete-version"] = String(meta.seenDeleteVersion);
    try {
      const res = await this.call(
        "PUT",
        `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        headers,
        data,
      );
      return JSON.parse(res.text) as PushResult;
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 409) {
        const body: unknown = e.body ?? {};
        const b = body as Partial<ConflictInfo>;
        const info: ConflictInfo = {
          error: "conflict",
          path: typeof b.path === "string" ? b.path : path,
          serverVersion: Number(b.serverVersion ?? -1),
          serverHash: typeof b.serverHash === "string" ? b.serverHash : undefined,
          serverSize: typeof b.serverSize === "number" ? b.serverSize : undefined,
          serverMtime: typeof b.serverMtime === "number" ? b.serverMtime : undefined,
          clientVersion: meta.baseVersion ?? 0,
          deleted: !!b.deleted,
        };
        throw new SyncConflictError(info);
      }
      throw e;
    }
  }

  async remove(path: string, baseVersion?: number): Promise<{ version: number; seq: number } | null> {
    const q = baseVersion ? `?baseVersion=${encodeURIComponent(baseVersion)}` : "";
    try {
      const res = await this.call(
        "DELETE",
        `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/files/${path.split("/").map(encodeURIComponent).join("/")}${q}`,
        this.headers(),
      );
      return res.status === 204 ? null : (JSON.parse(res.text) as { version: number; seq: number });
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 404) return null; // already gone
      throw e;
    }
  }

  async move(from: string, to: string, baseVersion?: number): Promise<{ from: string; to: string; version: number; seq: number }> {
    const res = await this.call(
      "POST",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/move`,
      this.headers({ "content-type": "application/json" }),
      JSON.stringify({ from, to, baseVersion: baseVersion ?? 0 }),
    );
    return JSON.parse(res.text) as { from: string; to: string; version: number; seq: number };
  }

  // ---- shares ----------------------------------------------------------------

  async createShare(path: string): Promise<ShareInfo> {
    const res = await this.call(
      "POST",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/shares`,
      this.headers({ "content-type": "application/json" }),
      JSON.stringify({ path }),
    );
    return JSON.parse(res.text) as ShareInfo;
  }

  async listShares(): Promise<ShareInfo[]> {
    const res = await this.call("GET", `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/shares`, this.headers());
    return JSON.parse(res.text) as ShareInfo[];
  }

  async setShareEnabled(shareId: string, enabled: boolean): Promise<void> {
    await this.call(
      "PATCH",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/shares/${encodeURIComponent(shareId)}`,
      this.headers({ "content-type": "application/json" }),
      JSON.stringify({ enabled }),
    );
  }

  async deleteShare(shareId: string): Promise<void> {
    await this.call(
      "DELETE",
      `/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/shares/${encodeURIComponent(shareId)}`,
      this.headers(),
    );
  }

  shareUrl(shareId: string): string {
    return `${this.base()}/share/${shareId}`;
  }

  // ---- websocket -------------------------------------------------------------

  connectWs(onChange: () => void, onStatus?: (connected: boolean) => void): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: number | null = null;
    let pingTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      const url = `${this.base().replace(/^http/, "ws")}/api/v1/vaults/${encodeURIComponent(this.opts.vaultId)}/ws?token=${encodeURIComponent(this.opts.secret)}&cid=${encodeURIComponent(this.opts.deviceId)}`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        onStatus?.(true);
        pingTimer = window.setInterval(() => {
          try {
            ws?.send(JSON.stringify({ type: "ping" }));
          } catch {
            // socket already closing; onclose handles reconnect
          }
        }, 30000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string };
          if (msg.type === "change") onChange();
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        onStatus?.(false);
        cleanupTimers();
        scheduleRetry();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // close on a dead socket is a no-op
        }
      };
    };

    const scheduleRetry = () => {
      if (closed) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, retry++));
      timer = window.setTimeout(connect, delay);
    };

    const cleanupTimers = () => {
      if (pingTimer) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    connect();

    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      cleanupTimers();
      try {
        ws?.close();
      } catch {
        // socket already closed
      }
    };
  }
}
