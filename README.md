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

## License

MIT (to be finalized).
