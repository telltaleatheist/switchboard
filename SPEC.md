# Switchboard — Specification (v1)

Status: **draft for review** · Date: 2026-08-17 · Author: Owen + Claude

Switchboard is an Electron app that hosts a small message service and an
operator console. It replaces file-based agent-to-agent bridges (the
`agent-bridge` skill's markdown file pairs) with channels: multiple AI agent sessions on
multiple machines join a shared channel, send messages over HTTP, and receive
them as real-time WebSocket push — no polling loops, no files, no manual
lifecycle.

The name is the design: a **switchboard** is an operator that connects many
parties, patches them together on demand, and tears lines down when calls end.

---

## 1. Roles and topology

Three kinds of participant:

| Role | What it is | How it talks to the server |
|---|---|---|
| **Server** | One Node process holding channels + messages in SQLite | — |
| **Operator** | The human, via the Electron app (control panel) | Same `/v1` API as agents, with an operator token |
| **Agent** | An AI session (Claude Code or anything that can curl) | REST to send/read, WebSocket (or long-poll) to watch |

One switchboard per user: the Electron app spawns the server as a child
process on launch and shuts it down on quit. The switchboard exists while
the app is open; when the app closes, agents disconnect (gracefully — §5a).
Agents on any machine reach it over whatever network path exists (LAN,
tailnet) — the app displays the URLs agents can use. Friends who receive the
app run their own; nothing federates.

The server core stays a plain Node module with no Electron dependency —
purely for testability and hygiene, not because a standalone mode is a v1
feature (it isn't).

### Reference deployment (the author's two-machine setup)

- The app runs on whichever machine is convenient; agents on other machines
  reach it over the LAN or a tailnet, e.g. `http://my-pc.my-tailnet:4400`.
- All state — SQLite DB, archives — lives in the app's userData directory.
  One folder to back up, one folder to delete for a factory reset.

---

## 2. Engineering principles

- **No silent fallbacks.** A required value that is missing, a body that is
  not valid UTF-8, an unknown channel, a bad token — all fail loudly with a
  4xx and a human-readable error body. Nothing is coerced or guessed.
- **Boring and dependency-light.** Node + SQLite + a WebSocket library.
  No ORM, no framework, no message broker. The server should be small enough
  to read in one sitting.
- **The API freezes early and evolves additively.** (§6 "Versioning".)
  This is the lesson of the rejected library-API daemon: a daemon whose logic
  churns is always stale. Switchboard's server has no domain logic to churn —
  it appends messages and reads messages. Protocol intelligence lives in the
  agents and their skill docs, never in the server.
- **Server time is THE time.** Clients never send timestamps or ids; the
  server assigns both. (Self-reported timestamps have already produced
  messages dated a day ahead in production.)
- **Token economy is a first-class design constraint.** Every frame that
  wakes an agent costs a full model turn with full context loaded. The system
  is designed so idle costs zero and irrelevant traffic never reaches an
  agent (§7).

---

## 3. Message model

### Channel

| Field | Notes |
|---|---|
| `name` | slug, unique among open channels, e.g. `bookforge-sync` |
| `status` | `open` \| `closed` |
| `created_at` | server time |
| `members` | list of agent names + join times |

Channels are **disposable by design**: created for a collaboration, destroyed
when it ends. Durable conclusions belong in committed docs and memory, never
in the channel (carried over unchanged from the agent-bridge protocol).

### Message

| Field | Assigned by | Notes |
|---|---|---|
| `seq` | server | per-channel, monotonic, gapless. This IS the message number agents cite. |
| `ts` | server | ISO-8601 UTC |
| `sender` | server | derived from the auth token — self-misattribution is structurally impossible |
| `to` | client, optional | list of member names. Omitted = everyone. Controls **push** only, never visibility (§7) |
| `subject` | client, required | conclusion-carrying, per protocol |
| `body` | client, required | markdown, strict UTF-8. Invalid bytes → 400, loudly (kills the PowerShell-5.1 mojibake trap at send time) |
| `in_reply_to` | client, optional | a `seq` in the same channel |
| `signal` | client, optional | exact literal go-signal string (see below) |
| `state` | client, optional | `settled` \| `withdrawn` — marks a state change on the thread referenced by `in_reply_to` |

### Go-signals

A go-signal is an exact literal string agreed in advance by the parties
(e.g. `FOUNDRY-GO-DEPLOY`), carried in the structured `signal` field. The
server does not interpret it — it exists so that:

- watchers can match it mechanically (Monitor pattern-match on the frame),
- with three parties on one channel there is no ambiguity about whose
  signal a message carries: the literal itself names the recipient/action.

### Cursors — client-held, server-stateless

The server stores **no per-member read state**. Each agent remembers the last
`seq` it processed (in its own scratch/memory/context) and passes
`since=<seq>` when reading or reconnecting. Consequences:

- Recovery after compaction, restart, or WS drop is always the same single
  move: `GET …/messages?since=N`.
- The server has one less concept whose semantics could ever force a v2.
- A brand-new member catches up by reading from `since=0` (full replay).

### Protocol rules carried over from the file-pair era

These made agent conversation efficient and are retained verbatim, living in
the skill doc (not enforced by the server):

1. One message = one subject-carrying unit; the subject states the conclusion.
2. **No acknowledgment-only messages.** Silence after an answer IS the ack.
3. Answer by the other side's numbering (`in_reply_to`); mark state changes
   (`state: settled` / `withdrawn`).
4. Go-signals are exact literals agreed in advance, watched mechanically.
5. Durable conclusions ALSO go to committed docs; the channel is disposable.

---

## 4. The control line and orchestration

This is what makes it a switchboard rather than a chat server.

### Registration — one paste, once, per agent

The operator creates an agent in the UI (name it, e.g. `bookforge-pc`) and
gets a **bootstrap block** to paste into that agent's session:

```
SWITCHBOARD
url:    http://my-pc.my-tailnet:4400
agent:  bookforge-pc
token:  sw_a_9f2kq…
```

The agent (via the updated skill) then:
1. `GET /v1/agents/me` — verifies the token, learns its standing state
   (any channels it's already in, from before a compaction/restart).
2. Arms a Monitor on its **control line**:
   `ws://…/v1/agents/me/line?token=…&since=N`.

The control line is a private per-agent feed from the switchboard itself.
At idle it costs **zero tokens** — a WebSocket Monitor is event-driven.

### Patching — how a connection is forged

The operator (in the Electron app) selects agents and says *patch these
together*. The server:

1. Creates the channel.
2. Pushes an **invitation frame** down each selected agent's control line:

```json
{ "type": "invite", "channel": "bookforge-sync", "token": "sw_c_x81m…",
  "members": ["bookforge-pc", "bookforge-mac"], "last_seq": 0,
  "note": "optional operator note: what this collaboration is for" }
```

3. Each agent's Monitor wakes; it arms a second Monitor on the channel's WS
   and (if `last_seq > 0`) catches up via `since`. The connection is forged —
   no human re-pasting, no discovering where the other agent put a file.

Agents may also request patches themselves
(`POST /v1/patch-requests {"with": ["bookforge-mac"], "purpose": "…"}`);
the request surfaces in the operator UI for one-click approval. In v1 the
operator approves every patch — agents cannot open lines to each other
unilaterally.

### Teardown

Closing a channel (operator UI, or any member via API) pushes a `closed`
frame with the archive to every member's control line, then destroys the
channel. Members drop their channel Monitors on receipt.

---

## 5. Lifecycle

- **Create** → **join** (via invitation or bootstrap) → **converse** →
  **close**.
- **Close** renders the full channel as a **markdown transcript** in the
  familiar bridge-file format (dated, signed, numbered sections):
  - returned in the close response and in the `closed` control-line frame,
    so the closing/receiving agents can commit durable conclusions to the
    relevant repo's docs (that responsibility stays with agents, per
    protocol rule 5);
  - a copy is kept in the app's data directory under `archives/`; the
    operator UI can browse and export them, and purge old ones (§11).
- **Idle expiry:** a channel with no messages for 14 days (configurable) is
  auto-closed-and-archived, with `reason: "idle-expiry"` in the frame.
  Abandoned collaborations don't accumulate.

## 5a. Graceful shutdown and self-healing

The switchboard lives and dies with the Electron app, so shutdown is a
first-class event, not an error:

- **On app quit:** the server broadcasts a `{"type": "shutdown"}` frame on
  every control line and channel socket, closes all WebSockets cleanly,
  checkpoints SQLite (WAL), and exits. Nothing is left dangling — no orphan
  child process, no stray sockets, no half-written state.
- **Agents receiving `shutdown`:** drop their Monitors, note that the
  switchboard is offline, and continue their own work. If cross-agent
  coordination is needed while it's down, the file-pair fallback applies —
  proposed loudly, never silently (§8).
- **On app relaunch:** everything persists in SQLite — agents, tokens, open
  channels, messages, cursor-addressable history. Agents reconnect with the
  same bootstrap credentials and `since=<cursor>`; the replay closes any gap.
  A restart is invisible to the protocol: no re-registration, no lost
  messages, no manual repair. This is the self-healing property, and it's
  why cursors (not connections) are the source of truth.
- **Hard crash (no shutdown frame):** the WS drop still fires each agent's
  Monitor; agents treat an unannounced drop exactly like `shutdown` after
  one failed reconnect attempt. Recovery on relaunch is identical.

---

## 6. API surface

Complete list. Small enough to freeze on day one.

```
GET  /v1/version                          → {api: 1, server: "0.1.0"}

# Agent-facing
GET  /v1/agents/me                        → identity, standing channels
WS   /v1/agents/me/line?since=N           → control line (invites, closures)
POST /v1/channels/{name}/messages         → send; returns {seq, ts}
GET  /v1/channels/{name}/messages?since=N[&wait=30][&for=me]
                                          → catch-up; wait= long-polls;
                                            for=me applies push filtering to pull
GET  /v1/channels/{name}                  → info, members, last_seq
POST /v1/channels/{name}/close            → archive + destroy; returns transcript
WS   /v1/channels/{name}/ws?since=N       → replay from N, then live frames
POST /v1/patch-requests                   → agent asks operator for a patch

# Operator-facing (operator token required)
POST /v1/agents                           → register agent, returns bootstrap block
POST /v1/channels                         → create channel + send invitations
GET  /v1/channels?status=…                → list
GET  /v1/agents                           → list, with connection status
GET  /v1/archives · GET /v1/archives/{id} → browse/export transcripts
```

Auth: `Authorization: Bearer <token>` everywhere (WS: `token=` query param,
since Monitor supplies only a URL). Agent tokens are scoped to that agent's
identity; channel membership is tracked server-side, so an agent token works
on exactly the channels that agent has been invited into. Operator tokens can
do everything. This is a home-lab trust model — but a leaked agent token
still only lets the holder speak *as that agent on its channels*, not
administer the switchboard.

### Idempotency

`Idempotency-Key: <any-unique-string>` header on send. The server stores the
key with the result; a retried send returns the original `{seq, ts}` instead
of appending twice. Solves curl-retry-after-timeout duplicates.

### Versioning and skew

- `/v1` never changes incompatibly. Evolution is additive-only: new optional
  fields, new endpoints. Unknown fields in requests are rejected (no silent
  fallbacks), so additions ride in new optional fields with defaults.
- A client checks `GET /v1/version` once at bootstrap. If a `/v2` ever
  exists it runs alongside `/v1`, which keeps serving.
- The server carries no domain logic that could churn — the reason this
  clears the bar that killed the library-API daemon.

---

## 7. Token economy: pull is transparent, push is addressed

The core cost model: **every frame that reaches an agent's Monitor wakes a
full model turn.** Design accordingly.

- **Pull is transparent (party-line).** The channel's history contains every
  message, and any member may read all of it (`since=0`). No hidden side
  conversations; a late joiner or a suspicious agent can always see the whole
  record.
- **Push is addressed.** The `to:` field controls *delivery*, not
  *visibility*. The server filters each member's WS feed server-side: a
  member receives only frames addressed to it or to everyone. An agent is
  never woken by traffic that isn't for it. (Filtering must be server-side —
  client-side filtering still wakes the agent, which is the entire cost.)
- **Idle is free.** WS Monitors are event-driven; a connected, silent
  switchboard consumes zero agent tokens.
- **Protocol rules do the rest.** No ack-only messages means no wake for
  "got it"; conclusion-carrying subjects mean a woken agent triages in one
  read.

Rule of thumb baked into the skill doc: in a 3+ member channel, address (`to:`)
everything that isn't genuinely for everyone.

---

## 8. Client story — a Claude Code session, end to end

**Bootstrap** (pasted once): the block in §4. The skill turns it into:

```bash
# 1. verify + recover standing state
curl -s -H "Authorization: Bearer $TOKEN" $URL/v1/agents/me
# 2. arm the control line (Monitor tool, {ws:{url}})
#    ws://…/v1/agents/me/line?token=…&since=<last control seq, else 0>
```

**Send** (from any shell; on Windows, write the JSON body to a temp file
UTF-8-safely — e.g. via `node -e` — and `curl.exe --data-binary @file`,
never PowerShell 5.1 redirection):

```bash
curl -s -X POST $URL/v1/channels/bookforge-sync/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: bfpc-$(random)" \
  -H "Content-Type: application/json" \
  --data-binary @msg.json
```

**Watch:** one Monitor per channel WS + one on the control line, using
Monitor's native WebSocket mode — `Monitor({ws: {url}, persistent: true})`.
No file, no shell process, no polling: the server pushes a frame, the agent
gets a notification. `persistent: true` is required (the default timeout
would kill the watch after 5 minutes). Each incoming frame is a complete
message JSON — no follow-up fetch needed. Socket close itself surfaces as a
notification with the close code, which is what makes shutdown detection
(§5a) work with zero polling.

(Agents without a WS-capable watcher use the long-poll form instead:
`GET …/messages?since=N&wait=30` in a loop.)

**Recover** (after compaction, session restart, or WS drop): the cursor is
the source of truth, not the connection. Re-arm Monitors with
`since=<last seq processed>`; the server replays the gap, then streams live.
`GET /v1/agents/me` re-lists standing channels if even that was lost.

### Migration note for the `agent-bridge` skill

The skill is rewritten to describe **Switchboard as the preferred transport**
with the file-pair protocol retained as the documented fallback. The
protocol rules (§3) are transport-independent and stay in the skill verbatim.
The fallback triggers loudly: if the server is unreachable at send time, the
agent reports it and proposes falling back to file pairs — it does not fall
back silently.

---

## 9. Multi-party semantics

- **Party line:** everyone can see everything (pull); no DMs in v1. Push
  addressing (§7) is a delivery optimization, not a privacy feature.
- **Go-signals with 3+ watchers:** each party watches for its own agreed
  literal in the `signal` field. Literals name their recipient by
  convention (`<RECIPIENT>-GO-<ACTION>`), so a shared channel can carry
  multiple independent signal protocols without collision.
- **Late join:** an invitation carries `last_seq`; the new member replays
  history from `since=0` (or from wherever the operator's note says the
  relevant context starts) before speaking.

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| App closed (clean) | `shutdown` frame → agents drop Monitors knowingly; reconnect-with-cursor on relaunch (§5a) |
| App crashed / unreachable | curl fails / WS drops loudly → agent reports it and falls back to file pairs per skill (never silently) |
| WS drop | Monitor fires on close; agent re-arms with `since=cursor`; replay closes the gap. Messages cannot be lost — the cursor, not the connection, is truth |
| Duplicate send | `Idempotency-Key` returns the original result |
| Clock disagreement | Impossible by construction: server assigns all timestamps |
| Encoding | Non-UTF-8 body → 400 at send time, loudly |
| Token leaked to a log | Blast radius = speak as one agent on its channels; operator revokes/reissues that one agent token in the UI |

---

## 11. The Electron app

Electron + Angular (the BookForge stack). The UI consumes the same `/v1`
API as agents — it is just another client, holding an operator token.

v1 features:

- First launch: **host here** (spawn embedded server) or **connect to
  existing** (URL + operator token).
- Agents pane: register an agent → copy bootstrap block; see who's
  connected (live WS status); revoke/reissue tokens.
- Channels pane: create/patch (select agents → invitations sent), close,
  see idle timers.
- **Live channel view:** watch a conversation as it happens — the human
  reads the party line without being a member or costing any agent tokens.
- Pending patch-requests from agents, one-click approve/deny.
- Archives browser: read and export closed-channel transcripts.
- **Cleanup button:** "clear conversations older than [N] days" (default
  30) — purges closed-channel archives and their messages from SQLite in
  one action. Open channels are never touched by this (idle-expiry closes
  them first). Keeping the DB easy to clean is a design requirement, not
  an afterthought.
- Tray icon + native notification on patch-requests (the two things
  Electron buys over a web page).

---

## 12. Non-goals for v1

Explicitly out, each because it would restart version churn or grow scope:

- DMs / private sub-channels (push addressing covers the real need)
- Attachments (bodies are markdown text; big artifacts belong in repos)
- Message editing or deletion (append-only, like the files were)
- E2E encryption (network trust = LAN/tailnet; tokens are the boundary)
- Federation / server-to-server anything
- Presence, typing indicators, read receipts (protocol rule: silence is the ack)
- Any server-side understanding of protocol rules
- Mobile, web-hosted multi-tenant service, accounts

---

## 13. Open items (decided provisionally; overridable at review)

1. Port **4400** (arbitrary; unused on all three machines — confirm).
2. Idle expiry default **14 days**.
3. Archives kept until purged via the UI's "clear conversations older than
   [N] days" button (default N = 30).
4. Patch-requests **require operator approval** in v1; an auto-approve
   toggle per agent-pair is an easy v1.1 if approval friction annoys.
