# Hooks (pending Grok Bot support)

Grok **Build** already has hooks (`PreToolUse`, `Stop`, …). Grok **Bot** does not yet expose the same surface.

When it does, add a `hooks.json` here mirroring Claude Code’s rivet-memory pattern:

- `Stop` / `SessionEnd` → convert + ingest the just-finished turn
- Optional `UserPromptSubmit` → light recall priming

Until then: host file watcher (`../host/capture`).
