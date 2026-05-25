# Grok Memory Capture

This directory contains the capture system that writes Grok Build sessions into the shared RivetOS memory store.

## Design Goals

- **Never block Grok**: All hook handlers must return extremely fast.
- **Rich capture**: Turns, tool calls (with full input + result), and especially pre-compaction messages.
- **Best effort**: Failures are logged but must never impact the user's Grok session.
- **Safe against concurrent hooks**: Uses advisory locks per sessionKey. Full deduplication (e.g. ON CONFLICT) can be added later if needed.

## Architecture

We use the proven "spool + detached worker" pattern (inspired by the Claude Code implementation) combined with rich event support from the Hermes design.

1. Grok hook fires → `grok-memory-hook.sh` is called with the event name.
2. The script pipes the payload to `grok-memory-capture.ts --hook <event>`.
3. The capture module writes a small JSON file to a temp spool directory and immediately spawns (or reuses) a detached worker, then exits.
4. The worker (`--worker`) reads the spool file(s) and performs the actual database writes using the same patterns as the Claude capture.

## Current Supported Events

- `PostToolUse` / tool-related events → Captures tool name + input + result
- `TurnAfter` / turn completion → Captures user + assistant content
- `CompactBefore` → Captures messages about to be discarded during compaction (highest value for long sessions)
- `SessionEnd` → Marks the conversation as inactive

## Wiring into Grok

See the example in `../hooks/hooks.json`.

You will likely need to adjust event names as Grok's hook system evolves. The important ones for memory are anything that gives you:
- User prompts
- Assistant responses
- Tool calls + results
- Pre-compaction / compaction events

## Database Schema

Writes to the standard RivetOS tables:
- `ros_conversations` (with `agent = 'rivet-grok'`)
- `ros_messages`

The same tables used by `rivet-claude` and `rivet-hermes`.

## Smoke Test

From the repo root (after `npm install`):

```bash
npx tsx integrations/grok/rivet-memory/capture/test/smoke.test.ts
```

The test verifies the `--hook` path spools a well-formed `CaptureOp` JSON
without needing a live Postgres (it points `RIVETOS_ENV_FILE` at `/dev/null`
so the detached worker fails fast and the spool file persists for
inspection). Exits non-zero on failure.

## Future Improvements

- Shared capture client library with the Claude implementation
- Optional direct (non-spool) path when running inside certain Grok contexts
- Wire the smoke test into the project's `vitest` runner
