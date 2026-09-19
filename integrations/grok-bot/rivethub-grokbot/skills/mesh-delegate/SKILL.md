---
name: rivethub-mesh-delegate
description: >-
  Use when handing work to another Rivet mesh node from Grok Bot without
  patching the app.
---
# RivetHub mesh delegation (Grok Bot)

## What works today
- **Outbound** to other RivetOS nodes via the den/mesh task API (or local RivetOS when this computer is a mesh member).
- **Inbound** to RivetOS agents on this computer (CLI harnesses). That path is separate from Grok Bot UI threads.

## What does not
- Injecting into or resuming a **Grok Bot chat thread** from mesh. No public app API for that yet.
- Treating Grok Bot sidebar bots as RivetOS harness executors.

## Practice
1. Prefer one clear teammate / node affinity; ask before fanning out.
2. Pass goal, acceptance criteria, budget, and `requestedBy`.
3. Poll the task id; don’t clone repos or restart RivetOS to delegate.
4. When Grok Bot gains **hooks**, prefer hook-driven capture + wake over file watchers.

Until mesh tools are exposed on this plugin’s MCP, use the documented den/RivetOS endpoints for your hub (see README).
