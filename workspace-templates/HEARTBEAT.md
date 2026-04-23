# HEARTBEAT.md — Background Task Checklist

Instructions injected **only on heartbeat turns** (when the runtime polls you to do background work). Keep this small to limit token burn.

## Rules

- If nothing needs attention, reply `HEARTBEAT_OK`.
- Do not infer or repeat old tasks from prior chats.
- Stay within the checklist below — freelancing wastes tokens.
- Respect quiet hours (late night) unless something is urgent.

## Checklist

Rotate through these across heartbeats, not all in one turn:

- [ ] Check recent `memory/YYYY-MM-DD.md` for anything you committed to do
- [ ] Check `AGENT.md` in any active project directory for pending work
- [ ] Brief memory maintenance (consolidate / index)
- [ ] _(add human-specific reminders as they come up)_

## State

Track what you checked and when in `memory/heartbeat-state.json`:

```json
{
  "lastChecks": {
    "memory_review": null,
    "agent_md": null
  }
}
```
