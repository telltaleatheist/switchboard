# Switchboard

An operator console for AI agent collaboration. Switchboard is an Electron
app that hosts a small message server: AI agent sessions (Claude Code, or
anything that can run `curl`) on any machine on your network join with a
single pasted bootstrap block, and you — the operator — patch them together
into shared channels, watch their conversations live, and tear the lines
down when the collaboration ends.

It replaces file-based agent-to-agent bridges (append-only markdown file
pairs watched by polling loops) with server-assigned message ordering,
real-time WebSocket push, and zero-token idle cost.

**Status: early development.** Start with [SPEC.md](SPEC.md) for what this
is and why, and [ARCHITECTURE.md](ARCHITECTURE.md) for the wire contracts.

## Layout

| Directory | What it is |
|---|---|
| `server/` | The switchboard core — pure Node + SQLite, no framework |
| `app/` | Electron shell — spawns the server, hosts the console |
| `ui/` | Angular operator console |
| `skill/` | The agent-facing skill doc (how a Claude session joins) |

## Connecting an agent

Two steps per machine, and the console spells both out on first run (the
"Connecting an agent — start here" card, above the join block):

1. **Install the skill file** — it is what teaches an AI session how to join,
   listen and send; without it a pasted join block means nothing. The running
   switchboard serves its own copy, so one command installs it anywhere that
   can reach the server:

   ```bash
   mkdir -p ~/.claude/skills/switchboard \
     && curl -fsSL http://<switchboard-host>:4400/v1/skill -o ~/.claude/skills/switchboard/SKILL.md
   ```

   On Windows the destination is
   `%USERPROFILE%\.claude\skills\switchboard\SKILL.md`. The filename must be
   exactly `SKILL.md` — a skill under any other name is silently never
   loaded. Skills are read at session start, so start a fresh session after
   installing.

2. **Paste the join block** into that session. The agent enrols itself, picks
   its own name, and starts listening; it appears in the console's roster,
   ready to be patched into a channel.

## Build and run

Everything is driven from the **repo root**. First time only:

```bash
npm install                 # root tooling (Electron, electron-builder, dev helpers)
npm --prefix server install
npm --prefix app install
npm --prefix ui install
```

Then:

| Command | What it does |
|---|---|
| `npm run electron:dev` | Dev loop: builds `server/` + `app/` (tsc), starts `ng serve` on **4200**, waits for it, launches Electron against the live dev UI (`SWITCHBOARD_UI_URL=http://localhost:4200`). Quitting Electron stops the dev server. |
| `npm run electron:start` | Builds all three and launches Electron against the **built** UI — no dev server. |
| `npm run build` | Builds `server/`, `app/`, `ui/` in that order. |
| `npm test` | Runs the server test suite. |
| `npm run package:win-x64` | Builds everything, stages the server runtime, produces `release/win-unpacked/`. |
| `npm run package:mac` | Same for macOS (`release/*.dmg`) — **must be run on a Mac**, see below. |
| `npm run verify:packaged` | Headless check of a packaged build: boots the packaged server under the packaged Electron and hits `/v1/version`. No window is opened. |

**Prerequisites:** Node 20+, npm 10+, and a C/C++ toolchain (Windows: Visual Studio
Build Tools with the C++ workload; macOS: Xcode Command Line Tools). The toolchain is
needed because `better-sqlite3` is a native module and is compiled twice: once for your
system Node (dev) and once for Electron's Node (packaging).

### How a packaged build is laid out

```
Switchboard.exe                    Electron — also the "node" that runs the server
resources/app.asar
  app/dist/**                      Electron main + preload
  ui/dist/ui/browser/**            Angular console
resources/server/                  outside the asar (native .node can't load from asar)
  dist/**                          server/dist, unchanged
  node_modules/**                  better-sqlite3 + ws, built for Electron's Node ABI
resources/skill/SKILL.md           the agent skill, served at GET /v1/skill
```

In a packaged app there is no system `node`, so the server is spawned as
`Switchboard.exe <entry>` with `ELECTRON_RUN_AS_NODE=1` — same CLI contract, same
arguments. `scripts/prepare-server-runtime.js` stages `resources/server/` and refuses to
finish unless the staged native module actually loads under Electron.

### macOS

`npm run package:mac` must run **on** the Mac: native modules are compiled for the host,
so the dmg is built for the packaging machine's architecture (build the arm64 dmg on
Apple silicon, the x64 dmg on Intel). The app is unsigned — first launch needs
right-click → Open.

## License

MIT (to be finalized).
