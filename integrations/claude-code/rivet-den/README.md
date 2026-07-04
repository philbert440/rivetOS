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
- `RIVET_DEN_TERM=off` — don't send terminal lines at all (see below)

Hooks are best-effort and always exit 0: a den outage can never disrupt the
session. Translator state (todo diffs, transcript offsets) lives under
`~/.cache/rivet-den/` and is cleaned up on SessionEnd. Events ship as one
ordered batch (`POST /events`); pre-batch servers get sequential fallback.

## What the den shows — read this before pointing it anywhere shared

**The den displays your session's actual content**: prompt text, the agent's
replies, and — on the desk terminal — real command lines and the tail of
their output. Anyone who can reach the den-server sees it. The translator
redacts obvious secret shapes (`KEY=…`/`token: …` values, `Bearer` headers,
AWS/GitHub/Slack/`sk-` style tokens) from terminal lines, but that is
best-effort pattern matching, **not** a security boundary — a secret echoed
in an unrecognized shape goes through verbatim.

Policy: treat den access = session-transcript access. Keep den-servers
loopback or LAN + token-gated; set `RIVET_DEN_TERM=off` if command output on
your machine may carry credentials you don't control.
