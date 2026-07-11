# rivet-memory overlay — phone-specific scripts

These are the hand-customized shell pieces baked into `app/src/main/assets/rivet-memory-overlay.bin`
(extracted into the proot rootfs by `RivetRuntime.ensureMemoryPlugin`). The bulk of the overlay
(the esbuild-bundled `*.mjs` capture workers + MCP server, plugin manifests, skills) is assembled
from the canonical stash at `/rivet-shared/rivet-phone/memory-plugin/` — only the files below are
phone-specific and tracked here for review.

- `rivet-memory-offline.sh` → `/opt/rivet-memory-offline.sh` — durable offline outbox sourced by both
  hook launchers. The bundle's own spool is ephemeral (its detached worker deletes the spool file even
  when the PG write fails), so a capture made off-mesh is lost. This persists every payload + its argv
  and replays the backlog (idempotent by session_key) once datahub PG is TCP-reachable. Detached drain;
  never blocks a session.
- `claude/rivet-memory-hook.sh` → `/opt/rivet-memory/bin/rivet-memory-hook.sh` — Claude hook launcher
  (sets RIVETOS_CAPTURE_AGENT=rivet-phone-claude), now routed through the offline outbox.
- `grok/grok-memory-hook.sh` → `/opt/rivet-memory-grok/bin/grok-memory-hook.sh` — Grok hook launcher
  (rivet-phone-grok), routed through the outbox (stores the per-event arg so replays use the original event).

To rebuild the overlay: extract the current `.bin`, drop these in at the paths above, bump
`MEMORY_OVERLAY_REV` in `RivetRuntime.kt`, re-tar (`tar -czf rivet-memory-overlay.bin -C <root> .`).
