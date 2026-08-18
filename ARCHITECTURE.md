# Switchboard — Build Architecture & Wire Contracts

This document refines SPEC.md into exact build contracts. Where it is more
specific than SPEC.md, **this document wins**. Read SPEC.md first for intent.

Environment: Windows 11 dev box, Node **v20.19.5**, npm 10.8.2. Package
manager is npm. TypeScript strict mode everywhere.

## Repository layout — hard boundaries

```
switchboard/
  SPEC.md  ARCHITECTURE.md
  server/    independent npm package — pure Node, ZERO Electron imports
  app/       independent npm package — Electron main + preload
  ui/        Angular workspace — the operator console (renderer)
  skill/     the rewritten agent-facing skill doc (SKILL.md)
```

Each area is owned by one builder. **Never write outside your directory.**
Integration (wiring app → server + ui builds) happens in a later pass.

---

## server/ — the switchboard core

- Runtime: Node 20, TypeScript, compiled with `tsc` to `server/dist/`.
- Dependencies: `better-sqlite3`, `ws`. Dev: `typescript`, `@types/*`.
  **No framework, no ORM** — `node:http` with a small hand-rolled router.
- Tests: `node:test` (zero-dep), run against a real server on an ephemeral
  port with a temp data dir. `npm test` must pass.
- Scripts: `build` (tsc), `start` (node dist/index.js), `test`.

### CLI contract (how the Electron app runs it)

```
node server/dist/index.js --port 4400 --host 0.0.0.0 --data-dir <path>
```

- All three flags required — missing flag = print error to stderr, exit 1
  (no silent defaults for the embedded case; a plain `npm start` dev
  convenience may pass its own defaults explicitly).
- On ready, print exactly one JSON line to stdout:
  `{"ready":true,"port":4400,"operatorToken":"sw_o_<hex>"}`
- **Shutdown protract:** read stdin line-by-line; on `{"cmd":"shutdown"}`
  do the graceful sequence (broadcast `{"type":"shutdown"}` on every open
  WS, close sockets, WAL-checkpoint SQLite, exit 0). Also handle
  SIGINT/SIGTERM the same way, best-effort. Parent kills after 5 s timeout.

### Tokens

- Agent tokens: `sw_a_` + 32 hex chars (crypto random). Stored in SQLite as
  SHA-256 hex **hash only**. Plaintext is returned exactly once — in the
  create/reissue response. Reissue invalidates the old token.
- Operator token: `sw_o_` + 32 hex — **ephemeral, per-boot, in-memory
  only**, emitted on the ready line. The embedded parent (Electron main) is
  the only operator; nothing operator-related persists.
- Auth: `Authorization: Bearer <token>` on REST; `?token=` query param on
  WS URLs (Monitor can only pass a URL).

### SQLite schema (better-sqlite3, WAL mode)

```sql
meta(key TEXT PRIMARY KEY, value TEXT)                  -- schema_version
agents(id INTEGER PK, name TEXT UNIQUE, token_hash TEXT,
       created_at TEXT, line_seq INTEGER DEFAULT 0)
channels(id INTEGER PK, name TEXT, status TEXT,          -- open|closed
         created_at TEXT, closed_at TEXT, last_seq INTEGER DEFAULT 0,
         note TEXT)
channel_members(channel_id, agent_id, joined_at, UNIQUE(channel_id, agent_id))
messages(id INTEGER PK, channel_id, seq, ts, sender_id,
         to_json TEXT,          -- JSON array of names, NULL = everyone
         subject TEXT, body TEXT, in_reply_to INTEGER,
         signal TEXT, state TEXT, UNIQUE(channel_id, seq))
line_events(id INTEGER PK, agent_id, seq, ts, frame_json,
            UNIQUE(agent_id, seq))                       -- control-line feed
idempotency(key TEXT, agent_id, result_json, created_at,
            UNIQUE(key, agent_id))
patch_requests(id INTEGER PK, requester_id, with_json, purpose,
               status TEXT, created_at TEXT)             -- pending|approved|denied
archives(id INTEGER PK, channel_name, closed_at, reason, transcript TEXT)
```

- Open-channel `name` is unique among `status='open'` (a closed channel's
  name is reusable).
- `seq` starts at 1, gapless per channel. `line_seq` likewise per agent.
- Timestamps: ISO-8601 UTC with milliseconds, server clock, always.

### REST surface (all under /v1, JSON in/out)

Agent-token endpoints:

| Method/path | Body → Response |
|---|---|
| `GET /v1/version` | (no auth) → `{api:1, server:"0.1.0"}` |
| `GET /v1/agents/me` | → `{agent, channels:[{name, last_seq, members:[names]}], line_seq}` |
| `POST /v1/channels/{name}/messages` | `{subject, body, to?, in_reply_to?, signal?, state?}` → 201 `{seq, ts}` |
| `GET /v1/channels/{name}/messages?since=N[&wait=S][&for=me]` | → `{messages:[Message], last_seq}`; `wait` long-polls (max 60 s) when no news; `for=me` applies push filtering to pull |
| `GET /v1/channels/{name}` | → `{name, status, members, last_seq, created_at, note, last_message_at}` (`last_message_at` ISO-8601 or null — the UI's idle display needs it) |
| `POST /v1/channels/{name}/close` | `{}` → `{transcript}` (also archives + pushes `closed` line frames) |
| `POST /v1/patch-requests` | `{with:[names], purpose}` → 201 `{id, status:"pending"}` |

Operator-token endpoints (agent tokens get 403):

| Method/path | Body → Response |
|---|---|
| `POST /v1/agents` | `{name}` → 201 `{name, token}` (plaintext, once) |
| `POST /v1/agents/{name}/reissue` | → `{name, token}` |
| `GET /v1/agents` | → `{agents:[{name, created_at, connected:bool, channels:[names]}]}` |
| `POST /v1/channels` | `{name, members:[names], note?}` → 201 `{name, invited:[names]}` (pushes invites) |
| `GET /v1/channels?status=open\|closed` | → `{channels:[...]}` (each item: same shape as `GET /v1/channels/{name}`, incl. `last_message_at`) |
| `GET /v1/patch-requests?status=pending` | → `{requests:[{id, requester, with:[names], purpose, status, created_at}]}` (`requester` = name resolved from requester_id, mirroring how `sender` resolves on messages) |
| `POST /v1/patch-requests/{id}/approve` | `{name?}` → creates channel + invites (requester + with) |
| `POST /v1/patch-requests/{id}/deny` | → `{}` |
| `GET /v1/archives` / `GET /v1/archives/{id}` | list / full transcript |
| `POST /v1/maintenance/purge` | `{older_than_days}` → `{deleted}` (closed/archived only) |

Message object on the wire:
`{seq, ts, sender, to, subject, body, in_reply_to, signal, state}`
(`sender` = agent name resolved from token; `to` = array or null.)

Rules (fail loudly, per SPEC §2):

- Body must be valid UTF-8 JSON; unknown top-level fields → 400 with the
  field named. Non-member `to:` names → 400. Body > 1 MB → 413.
- `Idempotency-Key` header on message send: on replay return the stored
  result, 200, plus header `Idempotency-Replayed: true`.
- Errors: `{"error":"human-readable reason"}` with 400/401/403/404/409/413.
- 401 unknown/bad token; 403 valid token but wrong scope (not a member /
  not operator); 404 unknown channel; 409 open-channel name collision.

### WebSocket surface

- `GET /v1/channels/{name}/ws?token=…&since=N` (HTTP upgrade, `ws` lib).
  On connect: replay messages with seq > N (push-filtered for this agent),
  then stream live. No hello frame — an idle connect wakes nobody.
- `GET /v1/agents/me/line?token=…&since=N` — same replay-then-live over
  `line_events`.
- Frames (one JSON object per text frame):
  - `{"type":"message","channel":name,"message":Message}`
  - `{"type":"invite","line_seq":N,"channel":name,"token":"sw_c_…","members":[…],"last_seq":M,"note":str}` (line only)
  - `{"type":"closed","line_seq":N,"channel":name,"reason":"closed|idle-expiry","transcript":str}` (line only)
  - `{"type":"shutdown"}` (both, not persisted, no seq) then close 1001.
- **Push filtering is server-side**: a channel-WS member receives a message
  frame only if `to` is null or includes its name. **The sender is never
  live-pushed its own message** — the send's 201 `{seq,ts}` is its
  confirmation, and an echo would cost the sender a model turn for nothing.
  Replay (`since=N` on connect) and history reads DO include the agent's own
  messages: catch-up after a restart or compaction may need them back.
  History reads without `for=me` return everything (party-line pull).
- Channel invite tokens: **v1 simplification — the invite's `token` field
  repeats the agent's own token**; membership (tracked in
  `channel_members`) is what grants channel access. The field exists so the
  frame shape never has to change if per-channel tokens ever appear.

### Lifecycle mechanics

- Close: render transcript (markdown, bridge-file style: header with
  channel/name/dates, then one `## [seq] sender — ts — subject` section per
  message with body, `> in reply to [n]` and signal/state annotations),
  insert into `archives`, push `closed` line frames to all members, close
  channel WSes (code 1000, reason "channel-closed"), mark channel closed.
- Idle expiry: hourly sweep; open channels with no message for
  `idle_days` (default 14) get closed with reason `idle-expiry`.
- Purge: delete archives + closed channels (+ their messages) older than N
  days. Open channels never touched.

---

## app/ — Electron shell

- Its own package.json. Deps: `electron` (latest stable). TypeScript,
  `tsc` to `app/dist/`. Keep packaging config minimal for now
  (electron-builder config may be stubbed; packaging is a later pass).
- Main process duties:
  1. Spawn the server: `child_process.spawn(process.execPath is NOT it —
     use configured node in dev)`. Dev contract: spawn
     `node ../server/dist/index.js --port 4400 --host 0.0.0.0 --data-dir
     <app.getPath('userData')>/switchboard-data`. (Packaged mode —
     `ELECTRON_RUN_AS_NODE` fork — is a later pass; leave a TODO seam.)
  2. Read stdout lines until the `{"ready":true,...}` JSON line; capture
     port + operatorToken. Surface stderr lines to the app's log.
  3. Open a BrowserWindow loading `../ui/dist/ui/browser/index.html`
     (dev override: `SWITCHBOARD_UI_URL` env, e.g. http://localhost:4200).
  4. **Graceful quit:** on `before-quit`, write `{"cmd":"shutdown"}\n` to
     the child's stdin, wait up to 5 s for exit, then kill. Never leave an
     orphan.
  5. Tray icon with Open/Quit. Closing the window hides to tray; Quit does
     the graceful sequence.
- Preload (contextIsolation on, nodeIntegration off) exposes exactly:

```ts
window.switchboard = {
  getConfig(): Promise<{
    baseUrl: string;          // http://127.0.0.1:<port> for the UI itself
    operatorToken: string;
    advertisedUrls: string[]; // http://<hostname/LAN-IPs>:<port> for paste blocks
  }>
}
```

  `advertisedUrls` = `os.hostname()` + non-internal IPv4s from
  `os.networkInterfaces()`, each as `http://<x>:<port>`.
- Verification bar: `tsc` clean. Do NOT launch the GUI (integration pass
  does that); a `npm run typecheck` script is enough.

---

## ui/ — Angular operator console

- Angular latest stable (`ng new` — standalone components, no NgModules),
  builds with `ng build` to `ui/dist/ui/browser/`. Plain CSS, no component
  library, no extra deps. Dark-theme-friendly, information-dense, calm.
- Gets config via `window.switchboard.getConfig()`; when absent (running in
  a plain browser for dev) fall back to `localStorage`
  (`switchboard.baseUrl`, `switchboard.operatorToken`) and show a small
  banner saying so. Missing config = visible error state, never silent.
- Panes (SPEC §11): Agents (register → show bootstrap block once, copy
  button, per-`advertisedUrls` variants; connected status; reissue),
  Channels (create/patch via agent multi-select; close; idle timers), Live
  channel view (WS subscribe with operator token — operator sees ALL frames
  unfiltered), Patch requests (approve/deny), Archives (browse, export
  .md download, purge-older-than-[N]-days button, default 30).
- Bootstrap block text the UI generates:

```
SWITCHBOARD
url:    <advertised url>
agent:  <name>
token:  <plaintext token>
```

- Poll-refresh lists lightly (10 s) + refresh on window focus; the live
  view uses the WS. Verification bar: `ng build` succeeds.

Note: the server's WS push-filters by *member name*; the operator token is
not a member. Server rule: **operator-token WS connections to a channel
receive all frames unfiltered** (server/ must implement this).

---

## skill/ — the rewritten agent-facing skill

`skill/SKILL.md`, drop-in replacement style for the author's existing
`agent-bridge` skill (a private local skill; its path is provided to the
builder out of band — read it for tone/format/frontmatter conventions and
do not modify that live copy).
Content: Switchboard as preferred transport (bootstrap-block parsing, curl
send recipes that are PowerShell-5.1-safe — write JSON body with `node -e`,
send with `curl.exe --data-binary @file`, never PS redirection; Monitor
`{ws:{url}, persistent:true}` watching; cursor recovery after
compaction/WS drop), the five protocol rules verbatim from SPEC §3, and the
file-pair protocol retained as the loud, explicit fallback when the
switchboard is unreachable.

---

## Cross-cutting rules for all builders

- Fail loudly. No silent defaults, no swallowed errors, no `catch {}`.
- Dependency-light is a feature. Justify every new dependency in one line
  in your report.
- Write UTF-8 files without BOM. Beware PowerShell 5.1 (`Out-File` writes
  BOM/ANSI) — prefer the Bash tool or file-writing tools.
- Windows reserved filenames (NUL, CON, …) must never be created.
- Everything compiles (`tsc`/`ng build`) and server tests pass before you
  report done.
