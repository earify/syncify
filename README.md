# syncify

Self-hosted Obsidian vault sync — fresh rewrite of eari-sync.

- **Plugin** (this repo): Obsidian client, works on desktop + mobile
- **Server** (Termux standalone): https://github.com/earify/syncify-server

## Structure

- `shared/` — protocol types (wire-compatible with eari-sync v1 servers)
- `server/` — Node 22.5+ server (Fastify + `node:sqlite`, zero native deps, Termux-friendly)
- `plugin/` — Obsidian plugin (works desktop + mobile, uses `requestUrl`)
- `scripts/` — deploy helpers

## Commands

```bash
npm install          # install all workspaces
npm run build        # build shared + server + plugin
npm test             # server test suite (vitest)
npm run deploy:plugin  # copy plugin build into the PC vault + seed settings
```

Server CLI (from `server/`):

```bash
npm run cli -- init --vault <id> --secret <secret>
npm run cli -- doctor
npm run start        # listen (env: EARI_SYNC_DATA_DIR / PORT / HOST / CERT / KEY)
```

## Protocol (v1, legacy-compatible)

- `POST /api/v1/auth/test`
- `GET  /api/v1/vaults/:id/meta`
- `GET  /api/v1/vaults/:id/changes?since=&limit=`
- `GET  /api/v1/vaults/:id/files` (new: list live files)
- `GET/PUT/DELETE /api/v1/vaults/:id/files/*`
- `POST /api/v1/vaults/:id/move`
- `GET  /api/v1/vaults/:id/trash`, `POST .../trash/restore`
- `GET  /api/v1/vaults/:id/ws?token=&cid=` (WebSocket change notifications)
- Shares: `POST/GET /api/v1/vaults/:id/shares`, `PATCH/DELETE .../shares/:shareId`, public `GET /share/:shareId[/raw]`

Auth: `Authorization: Bearer <vault secret>` + `X-Vault-Id` / `X-Client-Id`.

## Plugin behavior

- Pull replays the server change log (`lastSeq`), hash-matching before download so
  re-syncs are cheap.
- Push hash-detects changes (size+mtime fast path), uploads with `X-Base-Version`;
  identical content is an idempotent no-op server-side.
- Conflicts keep the local edit as `name.conflict-<device>-<ts>.ext` (or take the
  server version per settings); remote deletes of locally-modified files are kept.
- `.obsidian` config syncs too (caches/workspace and the plugin's own folder excluded).
- Auto sync: timer + vault events + WebSocket push + visibilitychange.
- Commands: Sync now / Force full resync / Copy share link / Shared notes view / Export diagnostics.

## Deploy targets

- Plugin: `D:\.working\obsidianify\.obsidian\plugins\syncify` (auto on `npm run deploy:plugin`)
- Server: phone Termux `~/eari-sync` (data dir `~/eari-sync-data`), restart via
  `bash ~/eari-sync/scripts/restart.sh` — legacy data dir/config is read as-is.
