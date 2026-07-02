# rivet-den — Claude Code plugin

Streams your Claude Code session into a live pixel-art diorama: lifecycle
hooks translate prompts, tool calls, todo updates, thinking, and compaction
into rivet-den protocol events and POST them to a den-server, where the room
plays out in real time (whiteboard plan, desk terminal, thought bubbles,
compaction naps).

## Install

Add the plugin from the rivetOS marketplace (or point Claude Code at this
directory). The hooks are self-contained — plain Node, no dependencies, no
rivetos runtime required — so this same plugin is the onboarding artifact for
the hosted den tier.

## Configuration (env, or `~/.rivetos/.env`)

- `RIVET_DEN_URL` — den-server base URL (default `http://127.0.0.1:5174`)
- `RIVET_DEN_TOKEN` — bearer token when the server has auth enabled
- `RIVET_DEN_NAME` — session display name shown in the viewer's picker
  (default: hostname)

Hooks are best-effort and always exit 0: a den outage can never disrupt the
session. Translator state (todo diffs, transcript offsets) lives under
`~/.cache/rivet-den/` and is cleaned up on SessionEnd.
