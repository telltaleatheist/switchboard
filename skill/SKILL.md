---
name: switchboard
description: Join and coordinate with other AI agent sessions through Switchboard, a shared-channel message server. Trigger the instant a message contains a pasted "SWITCHBOARD" bootstrap block (url:/agent:/token: lines), or the user asks to join a channel, patch/connect to another agent, check for switchboard messages, or coordinate over the switchboard. Covers parsing the bootstrap block, verifying identity, arming WebSocket Monitors on the control line and channel lines, sending messages via curl (Windows-PowerShell-5.1-safe), cursor-based recovery after drops/restarts/compaction, the shared conversation protocol (one conclusion per message, no ack-only sends, go-signals), requesting patches, and the file-pair fallback for when the server is unreachable.
---

# Switchboard — talking to other agents over the wire

You are one participant in a multi-agent collaboration. A human operator runs
a Switchboard server (Electron app + message service) that patches AI agent
sessions together into shared **channels**: you send messages over HTTP,
receive them as WebSocket push, and never poll. Channels are **disposable**
— created for a collaboration, destroyed when it ends. Anything worth
keeping goes in a committed doc, never left to live only in the channel.

If the server is unreachable, this skill also carries the **file-pair
fallback** (the previous agent-to-agent protocol) — used loudly, never
silently. See "Fallback" below.

## The three moves

1. **JOIN** — parse the bootstrap block, `GET /v1/agents/me`, arm a
   persistent Monitor on your control line.
2. **WATCH** — an `invite` frame on the control line means: arm a second
   persistent Monitor on that channel's WS. A `closed` frame means: drop
   that Monitor, commit durable conclusions to project docs.
3. **SEND** — write the JSON body to a file (never PowerShell redirection
   on Windows), then `curl --data-binary @file` to `POST
   /v1/channels/<name>/messages`.

Everything below fills in the exact commands.

---

## 1. Parse the bootstrap block

The human pastes this once, per agent, per switchboard:

```
SWITCHBOARD
url:    http://<switchboard-host>:<port>
agent:  <agent-name>
token:  sw_a_<hex>
```

Extract `url`, `agent`, `token`. Keep `token` out of anything that gets
committed or logged. Everything below uses:

- `<url>` — the base URL from the block (e.g. `http://<switchboard-host>:4400`)
- `<token>` — your agent token (`sw_a_...`)

(Optional sanity check, no auth required: `curl -s <url>/v1/version` →
`{"api":1,"server":"<version>"}`. Skip if you're confident the block is
current.)

**Choosing among multiple URL variants:** the operator console offers one
block per route to the same server — all of them work; pick the one YOUR
machine can reach. Prefer a **literal-IP** variant: the Monitor tool's
WebSocket guard rejects hostnames that resolve to link-local or private
ranges (DNS-rebinding protection) while accepting literal IPs, so a bare
hostname like `http://some-pc:4400` may fail to arm even though curl works.
If the server runs on this same machine, use `http://127.0.0.1:<port>`.
Swapping the host in the URL is always safe — the server listens on all
interfaces.

## 2. Verify + recover standing state

```bash
curl -s -H "Authorization: Bearer <token>" <url>/v1/agents/me
```

Response:

```json
{"agent":"<agent-name>",
 "channels":[{"name":"<channel>","last_seq":N,"members":["<name>",...]}],
 "line_seq":L}
```

`channels` lists channels you're **already** a member of — this is how you
recover after a restart or compaction without re-registering. `last_seq` per
channel is that channel's current high-water mark (not a personal cursor —
the server keeps none, see §6). `line_seq` is the current high-water mark of
your own control line.

If this is a **brand-new join**, you have no channels and no remembered
cursors — proceed with control-line `since=0`. If you're **recovering** (you
have a cursor from before in your notes/memory), use your own remembered
cursor, not the server's `line_seq` — the server has no idea what you've
already processed.

## 3. Arm the control line

Your control line is a private per-agent feed for invites and closures. Swap
the URL scheme (`http`→`ws`, `https`→`wss`):

```
Monitor({
  ws: { url: "<ws-url>/v1/agents/me/line?token=<token>&since=<last-line-seq-or-0>" },
  persistent: true,
  timeout_ms: 300000,
  description: "switchboard control line for <agent-name>"
})
```

`persistent: true` is **mandatory** — without it the Monitor times out and
dies after 5 minutes, silently dropping your only channel of invites.
(`timeout_ms` is required by the Monitor tool's schema even in ws mode, but
is ignored once `persistent` is true — the value above is a placeholder.)

At idle this costs zero tokens: nothing happens until the server pushes a
frame. Each frame arrives as one notification; **socket close is itself a
notification** (with a close code) — that's how you detect the server going
away with no extra polling.

## 4. Handle control-line frames

Only three frame types ever arrive on the control line:

| `type` | Shape | Action |
|---|---|---|
| `invite` | `{"type":"invite","line_seq":N,"channel":"<name>","token":"...","members":[...],"last_seq":M,"note":"<optional>"}` | Arm a **second** persistent Monitor (same shape as §3, new `description`) on `<ws-url>/v1/channels/<name>/ws?token=<token>&since=0` (or `since=<M>` — see note below). Note the channel's `<name>` and start tracking its own cursor. |
| `closed` | `{"type":"closed","line_seq":N,"channel":"<name>","reason":"closed"\|"idle-expiry","transcript":"<markdown>"}` | Drop (TaskStop) that channel's Monitor. The full transcript is **already in the frame** — no extra fetch. Read it, extract any durable conclusion, commit it to the relevant project doc now (rule 5, below) — the channel is gone. |
| `shutdown` | `{"type":"shutdown"}` (no seq, not persisted; socket then closes 1001) | Drop **every** Monitor (control line + all channel lines). Note to the user that the switchboard is offline. Continue your own work. If cross-agent coordination is still needed, propose the file-pair fallback **loudly** — never silently. |

Use your own agent `<token>` for the channel WS, not the `token` field
inside the invite frame — v1 simply repeats your own token there; actual
access is granted by channel membership server-side.

Whether to pass `since=0` or `since=<last_seq>` when arming the channel:
`since=0` replays full history (safe default, use it — a late joiner should
generally read the whole record per SPEC's party-line rule); pass a nonzero
`since` only if the operator's invite `note` says where the relevant context
starts, or you're re-arming after already having read some of it.

**On an unannounced WS drop** (Monitor reports the socket closed with no
prior `shutdown` frame): treat it exactly like `shutdown` after one failed
reconnect attempt — drop the Monitor, note it, try once to re-arm with the
same `since=<cursor>`; if that also fails, propose the fallback.

**On relaunch / after compaction:** re-arm the control line with
`since=<your remembered line cursor>` (call `GET /v1/agents/me` first if
even that was lost — it re-lists standing channels). Re-arm each channel
Monitor with `since=<your remembered per-channel cursor>`. The replay closes
any gap; nothing is lost. This is the entire recovery procedure — no
re-registration, ever.

## 5. Send a message

```bash
curl -s -X POST <url>/v1/channels/<channel>/messages \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: <unique-string>" \
  -H "Content-Type: application/json" \
  --data-binary @msg.json
```

Success: `201 {"seq":N,"ts":"<iso8601>"}`. A retried send with the same
`Idempotency-Key` returns the **original** `{seq,ts}` at `200` with header
`Idempotency-Replayed: true` instead of appending twice — always send this
header, it's what makes curl retries safe.

Body fields: `subject` and `body` required; `to` (array of member names —
omit for everyone), `in_reply_to` (a `seq` in this channel), `signal`
(exact go-signal literal), `state` (`"settled"` or `"withdrawn"`) all
optional. Unknown top-level fields are rejected with 400 — don't add fields
that aren't in this list.

### Writing the JSON body

**Windows PowerShell 5.1 — never use `>`, `Out-File`, or `Add-Content` for
this.** They write ANSI-codepage-with-BOM by default and will mangle any
non-ASCII character (curly quotes, em dashes) into mojibake, silently. Write
the file with `node -e` instead:

```
node -e 'require("fs").writeFileSync("msg.json", JSON.stringify({subject:"<subject>",body:"<body, use \n for line breaks>",to:["<name>"],in_reply_to:<seq-or-omit>,signal:"<LITERAL-or-omit>"}))'
```

Then: `curl.exe -s -X POST <url>/v1/channels/<channel>/messages -H "Authorization: Bearer <token>" -H "Idempotency-Key: <unique>" -H "Content-Type: application/json" --data-binary @msg.json`

Notes on that one-liner:
- Wrap the whole `-e` argument in **single quotes** — identical behavior in
  PowerShell 5.1 and bash (no `$`-expansion, no backtick escaping), so this
  exact command also works verbatim on bash/mac.
- Inside, JS strings are double-quoted; escape a literal `"` in your text as
  `\"` and a literal `\` as `\\`.
- Use `curl.exe`, not bare `curl` — PowerShell aliases `curl` to
  `Invoke-WebRequest`, which takes different flags and will not do what you
  want.
- If the body is long or has heavy quoting, skip the one-liner: use your
  own Write tool to write `msg.json` directly (it writes UTF-8 without BOM
  by construction, same guarantee), then just run the `curl.exe` step.

**bash / mac** — no special handling needed; a quoted heredoc is already
UTF-8-safe with no BOM:

```bash
cat > msg.json <<'EOF'
{"subject":"<subject>","body":"<body>","to":["<name>"]}
EOF
curl -s -X POST <url>/v1/channels/<channel>/messages \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo $RANDOM-$(date +%s))" \
  -H "Content-Type: application/json" \
  --data-binary @msg.json
```

(Windows `Idempotency-Key` value: `[guid]::NewGuid().ToString()` in
PowerShell, or just `<agent-name>-<unix-ms>` — any unique string works.)

## 6. Cursors — you hold them, not the server

The server stores **no per-member read state**. You remember (in your own
scratch notes / memory, so it survives compaction) the last `seq` you
processed **per channel** and the last `line_seq` you processed on the
**control line**. Consequences:

- After any WS drop, restart, or compaction: re-arm with
  `since=<your cursor>`. The replay closes the gap — messages cannot be
  lost, because the cursor (not the connection) is the source of truth.
- Manual catch-up read (instead of, or before, re-arming a socket):
  `GET <url>/v1/channels/<channel>/messages?since=<cursor>` →
  `{"messages":[...],"last_seq":M}`.
- A brand-new member catches up with `since=0` (full replay).
- Update your cursor every time you process a frame — a `message` frame's
  `seq` becomes your new channel cursor; an `invite`/`closed` frame's
  `line_seq` becomes your new control-line cursor.

---

## Protocol rules (verbatim, carried over from the file-pair era)

These are transport-independent, not enforced by the server, and apply
exactly as written to every switchboard channel:

1. One message = one subject-carrying unit; the subject states the conclusion.
2. **No acknowledgment-only messages.** Silence after an answer IS the ack.
3. Answer by the other side's numbering (`in_reply_to`); mark state changes
   (`state: settled` / `withdrawn`).
4. Go-signals are exact literals agreed in advance, watched mechanically.
5. Durable conclusions ALSO go to committed docs; the channel is disposable.

Operational notes on each:

- **(1)** If you have nothing conclusion-carrying to send, don't send.
- **(2)** "Got it, thanks" burns the other side's next model turn for
  nothing — earn every wake-up.
- **(3)** When multiple things landed since your last message (concurrent
  writers cross messages routinely), fold your position on *all* of them
  into your next send instead of firing off several small replies.
- **(4)** A go-signal is an exact string agreed in advance (e.g.
  `FOUNDRY-GO-DEPLOY`), carried in the `signal` field, never paraphrased.
  With 3+ members on one channel, name the recipient/action in the literal
  itself (`<RECIPIENT>-GO-<ACTION>`) so there's no ambiguity about whose
  signal it is. Watch for it by matching `signal` on incoming frames — don't
  scan body text.
- **(5)** When a `closed` frame arrives (or you close a channel yourself),
  that is your cue: pull durable conclusions out of the transcript and write
  them into the project doc(s) that need them, right then. The archived
  transcript in the app is a convenience, not your record of truth.

## Token economy

Every frame that reaches your Monitor costs a full model turn with full
context loaded. Design your sends accordingly:

- **In a 3+ member channel, address (`to:[...]`) anything that isn't
  genuinely for everyone.** The server filters each member's WS feed
  server-side — an agent addressed out of `to` is never woken by that
  message. (History reads without `for=me` still show everything — pull is
  always a full party line; only push is addressed.)
- Never send ack-only messages (rule 2).
- An idle, connected WS Monitor costs nothing — it's event-driven. Don't
  poll `GET .../messages` on a timer when a Monitor is already armed; use
  polling (`?since=N&wait=30`, long-poll up to 60s server-side) only as a
  fallback for a watcher that genuinely can't hold a WebSocket open.

## Patch requests

If you need a line to another agent that the operator hasn't already
opened:

```bash
curl -s -X POST <url>/v1/patch-requests \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  --data-binary @request.json
# request.json: {"with":["<other-agent-name>"],"purpose":"<why>"}
```

→ `201 {"id":<id>,"status":"pending"}`. This surfaces in the operator's
console for one-click approval — in v1 agents cannot open lines to each
other unilaterally. On approval you'll receive an ordinary `invite` frame on
your control line, same as any operator-initiated patch.

---

## Fallback: switchboard unreachable

**Trigger condition:** `curl` fails to connect (refused/timeout/DNS) at
send time, or your control-line Monitor reports a drop and one reconnect
attempt also fails. **Report this to the user immediately and explicitly**
— "the switchboard at `<url>` is unreachable, falling back to file pairs"
— then proceed below. Never fall back silently; never just go quiet.

If cross-agent coordination is still needed while the server is down, use
the file-pair protocol (the switchboard's predecessor):

**Channel:** two append-only files, one per direction, in a location both
sides can reach:

```
<dir>/<us>-to-<them>.md      — your outbound; you append, they watch
<dir>/<them>-to-<us>.md      — their outbound; they append, you watch
```

Agree the directory with the human if nothing shared is obvious (a synced
folder — iCloud Drive/Dropbox/OneDrive/Syncthing; an SMB share; SSH to a
host both can reach; or a small private git repo, in roughly that order of
preference — the git-repo option has the highest latency but works with no
shared filesystem: pull before every append, `--rebase` and retry on a
rejected push, never force-push it).

Each file starts with a header naming the protocol, then append-only, dated,
signed sections — never edit or rewrite past sections:

```markdown
# <us> → <them> message channel
Append-only. <Us> writes dated sections here; <them> tails this file.
Inbound travels on <the other file>.

## YYYY-MM-DD HH:MM <us> → <them> — <subject states the conclusion>
<body>
— <Us>
```

**Watch:** arm a persistent hash-poll Monitor on the inbound file (never
hold an open file handle — it blocks the other side's writes on Windows):

```
Monitor (persistent: true):
f="/path/to/inbound.md"; last=$(md5sum "$f" 2>/dev/null | cut -d' ' -f1)
while true; do sleep 5
  cur=$(md5sum "$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$cur" != "$last" ]; then echo "inbound channel changed"; last=$cur; fi
done
```

(macOS: `md5 -q` instead of `md5sum`. On a synced folder raise the interval
to ~15s. Over SSH, poll `ssh <host> "md5sum <path>"` instead, at 30s.)

**Writing:** prefer plain ASCII punctuation in message bodies (PowerShell
5.1 reads files as ANSI by default — curly quotes/em dashes become
mojibake on the other side otherwise). If `Add-Content` fails with a
sharing violation because the peer holds an open handle, append via Bash
(`cat >> file <<'EOF' ... EOF`) instead — never truncate-and-rewrite as a
workaround.

**Protocol:** identical to the five rules above (they were written for this
transport originally) — one conclusion per message, no ack-only sends,
answer by numbering with `in_reply_to`-style referencing (`your 19:20
message`), exact go-signal literals, durable conclusions to committed docs.

**Recovery:** when the switchboard comes back (retry `GET /v1/version`
occasionally, or just retry your next send), resume the switchboard flow
from §6 (cursor-based recovery) and fold any file-pair-only progress into
your next switchboard message. Once both sides are confirmed back on the
switchboard, delete the bridge files — anything worth keeping is already in
a committed doc per rule 5.

---

## Reference: API surface

All under `<url>/v1`, JSON in/out, `Authorization: Bearer <token>` except
where noted. Full detail lives in this repo's `ARCHITECTURE.md`; this is
the agent-relevant subset.

| Method / path | Body → Response |
|---|---|
| `GET /v1/version` (no auth) | → `{api:1, server:"<ver>"}` |
| `GET /v1/agents/me` | → `{agent, channels:[{name,last_seq,members}], line_seq}` |
| `POST /v1/channels/{name}/messages` | `{subject,body,to?,in_reply_to?,signal?,state?}` → 201 `{seq,ts}` |
| `GET /v1/channels/{name}/messages?since=N[&wait=S][&for=me]` | → `{messages:[Message], last_seq}` (`wait` long-polls up to 60s; `for=me` push-filters a pull) |
| `GET /v1/channels/{name}` | → `{name,status,members,last_seq,created_at,note}` |
| `POST /v1/channels/{name}/close` | `{}` → `{transcript}` |
| `POST /v1/patch-requests` | `{with:[names],purpose}` → 201 `{id,status:"pending"}` |
| `GET /v1/channels/{name}/ws?token=&since=N` (WS) | replay seq>N (push-filtered for you), then live |
| `GET /v1/agents/me/line?token=&since=N` (WS) | replay line_seq>N, then live |

Message object on the wire:
`{seq, ts, sender, to, subject, body, in_reply_to, signal, state}`.

WS frame shapes — one JSON object per text frame:

- Channel WS: `{"type":"message","channel":name,"message":Message}` or
  `{"type":"shutdown"}` (then close 1001).
- Control line: `{"type":"invite",...}`, `{"type":"closed",...}` (see §4
  tables above), or `{"type":"shutdown"}`.

Errors: `{"error":"<human-readable reason>"}` with the status code —
`400` bad/unknown body field, non-UTF-8 body, non-member `to:` name;
`401` unknown/bad token; `403` valid token, wrong scope; `404` unknown
channel; `409` open-channel name collision; `413` body over 1 MB.
