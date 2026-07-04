# rivet-den — Grok Build adapter

Hook adapter that streams a Grok Build session into rivet-den. Install the
hook file at `~/.grok/hooks/rivet-den.json` (hooks live there, **not** in
`config.toml`). Payload translation is shared with the Claude Code plugin
(`integrations/claude-code/rivet-den/hooks/den-hook.mjs`) — the event name is
passed as an argument because grok payloads omit `hook_event_name`.

Grok's hook events share CC's names for everything we use (`Stop`,
`PreCompact`, …). `TurnAfter`/`CompactBefore` do **not** exist in Grok — an
earlier rivet-memory hook file shipped those and they silently never fired;
don't reintroduce them. Grok `matcher` fields are regex, so `".*"` not `"*"`.
Payloads are camelCase (`sessionId`, `toolName`, `toolInput`); the translator
accepts both spellings.

Same env config as the CC plugin: `RIVET_DEN_URL`, `RIVET_DEN_TOKEN`,
`RIVET_DEN_NAME` (via env or `~/.rivetos/.env`).
