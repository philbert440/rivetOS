# Design Decisions

Answers to the open questions from ARCHITECTURE.md. Decided 2026-03-28.

## 1. Config format → YAML
YAML over TOML. More familiar, more expressive for nested config like channel bindings.

## 2. Heartbeat/cron → TBD
Could go either way. Decide when we need it.

## 3. Multi-instance → Configurable
Support both modes:
- **Single process** (default): one process, multiple agents. Simpler deployment.
- **Multi-process**: one process per agent. For when resource isolation matters.

Config flag to choose. Start with single process.

## 4. Streaming → Yes, required
Stream LLM responses to channels in real-time. This is a must-have, not a nice-to-have.
Phil relies heavily on seeing reasoning and tool calls as they happen, plus steer depends on
being able to see what the agent is doing mid-turn.

Implementation: Provider.chat() returns an async iterator or uses a callback for streaming chunks.
Channel.send() supports incremental message editing (Telegram editMessageText, Discord msg.edit).

## 5. Plugin discovery → Auto-discover
Scan `plugins/` directory structure. Convention over configuration:
- `plugins/channels/*/` → channel plugins
- `plugins/providers/*/` → provider plugins
- `plugins/memory/*/` → memory plugins
- `plugins/tools/*/` → tool plugins

Each plugin exports a factory function. Config file references plugin by directory name.
If a plugin directory exists but isn't referenced in config, it's ignored (not auto-loaded).

Discovery is automatic, activation is explicit. Best of both worlds.

## 6. Existing data → Migration required
66K messages + 2K summaries in phil_memory on CT 106. Cannot lose any of it.

Strategy: Write a migration script that reads from the existing LCM `messages` and `summaries`
tables and maps them into the RivetOS `transcripts` schema. Run once. Keep both tables — the
old ones become read-only archive, new ones are the live store.

## 7. Voice → Same process, wired into workspace
Voice plugin runs in the same process as text channels. The xAI Realtime API client gets
access to the same workspace files and memory, so voice Rivet has the same context as
text Rivet.

This means voice sessions can reference workspace files, memory search results, and
recent conversation context — same agent, different interface.

## 8. Web dashboard → Later
Not in v0.1. Focus on the runtime. Dashboard is a separate concern that can be added
as a plugin later (Svelte, React, whatever — it just hits the Runtime API).

## 9. Workspace file reloading → On restart or /new
Workspace files are loaded on startup and cached. They refresh on:
- Process restart
- `/new` command (clears session, reloads workspace)

No file watching in v0.1. If you edit SOUL.md, `/new` picks it up.
Can add file watching later as an enhancement if the restart friction is annoying.

## 10. Session persistence → Yes, survives restarts
Conversation history persists in postgres. On restart, the active session
resumes where it left off (loads recent history from transcript store).

`/new` is the explicit "forget everything and start fresh" command.
Restart is just "I went away and came back."

This means: no lost context on deploys, crashes, or gateway bounces.
The thing OpenClaw should have done.
