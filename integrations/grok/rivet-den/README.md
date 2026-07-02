# rivet-den — Grok Build adapter

Hook adapter that streams a Grok Build session into rivet-den. Install the
hook file at `~/.grok/hooks/rivet-den.json` (hooks live there, **not** in
`config.toml`). Payload translation is shared with the Claude Code plugin
(`integrations/claude-code/rivet-den/hooks/den-hook.mjs`) — the event name is
passed as an argument because grok payloads omit `hook_event_name`, and
`TurnAfter`/`CompactBefore` map to the same den events as CC's
`Stop`/`PreCompact`.

Same env config as the CC plugin: `RIVET_DEN_URL`, `RIVET_DEN_TOKEN`,
`RIVET_DEN_NAME` (via env or `~/.rivetos/.env`).
