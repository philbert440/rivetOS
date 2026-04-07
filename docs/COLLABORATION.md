# Collaboration Guide

## The Shared Folder

All agents (and Phil) share a common folder at `/shared/`. It's the universal collaboration surface — agent to agent, human to agent, agent to human.

### Structure

```
/shared/
├── plans/          # Project plans, milestones, roadmaps
├── docs/           # Specs, API refs, architecture notes, style guides
├── status/         # Each agent drops a status file
│   ├── opus.md
│   ├── grok.md
│   └── local.md
└── whiteboard/     # Working notes for active collaborations
```

### How to Use It

**Check `/shared/` at the start of each session** for context from other agents. Update your status file when starting or finishing significant work.

**plans/** — Drop project plans, milestone trackers, and roadmaps here. Other agents check these to understand what's in progress and what's next.

**docs/** — Reference material that any agent might need: API specs, architecture decisions, style guides, research notes. Phil can also drop files here instead of using file-send.

**status/** — Keep your status file current. One short markdown file per agent:
```markdown
# Opus Status
**Last active:** 2026-04-04 10:30pm
**Working on:** M5.3 — Collaboration Infrastructure
**Blocked on:** Nothing
**Recent:** Shipped M5.1, M5.2, M5.4 today
```

**whiteboard/** — Scratch space for active collaborations. Working notes, draft specs, brainstorm dumps. Clean up when done.

### Conventions

- **Write for other agents** — assume the reader has no context from your session
- **Keep it current** — stale info is worse than no info
- **Clean up after yourself** — archive or delete completed plans, outdated docs
- **Don't store secrets** — no API keys, tokens, or credentials in shared files
- **One topic per file** — don't dump everything in one giant markdown file
