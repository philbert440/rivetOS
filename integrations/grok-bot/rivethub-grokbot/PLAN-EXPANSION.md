# rivethub-grokbot expansion plan (narrowed + prioritized)

**Status:** plan only — hold for maintainer approval before any implementation  
**Scope:** expand `rivethub-grokbot` to mesh-agent parity with Claude Code (`rivet-memory` + `rivet-den`) and Grok Build (`rivet-memory`).  
**Priority order (locked 2026-09-12 — do not reorder):**  
1. **Capture**  
2. **Delegation**  
3. **Den** (live session stream for RivetHub / native apps)  
**Owner (draft):** rivethub-grokbot maintainers · **Requester:** Rivet  
**Current kit:** `integrations/grok-bot/rivethub-grokbot` **0.2.0** (local prove PASS 2026-09-05)

---

## Goal

Same loop other mesh agents have — delivered in priority order:

| Priority | Piece | Today | Target |
| --- | --- | --- | --- |
| 1 | Capture | Host file watcher; hooks example only | Fail-loud watcher; prove tool rows; hooks when Grok Bot has them; **same ingest contract** as Claude/Grok; **no third path** |
| 2 | Delegation | `mesh-delegate` skill → curl | Real MCP tool on den task API |
| 3 | Den | Missing | `rivet-den`-style live session stream so RivetHub / native apps see the session, not only Postgres after the fact |

Supporting parity (discipline skills, slash shortcuts, memory-researcher, member rule, MCP as recall door) stays in scope but **does not jump ahead of 1→2→3**.

**Hard constraints:** no Grok Bot app patches; no second store; no third capture architecture; port Claude/Grok style, don’t invent a third discipline voice.

---

## Current state (short)

- MCP + `memory-recall` + `mesh-delegate` skill + thin member rule  
- Capture: host file-watch / batch; `hooks/` is example only  
- Mesh: skill text, not MCP  
- Den: no Grok Bot / Cursor sibling  
- Local prove PASS; Grok Bot still doesn’t load `~/.cursor/plugins/local`

---

## Priority 1 — Capture (first)

**Goal:** fail-loud watcher, prove tool rows, hooks when the host supports them. Same ingest contract as Claude Code / Grok Build. No third path. No app patches.

### Until Grok Bot has hooks

1. Keep host file watcher + batch backstop as **the** capture path (`host/capture` → `~/.rivetos/capture/*`).
2. **Fail loud:** missing `RIVETOS_PG_URL`, missing packages, or ingest errors must be visible (still no secret dumps). Convert-only with silent ingest failure is not done.
3. **Prove tool rows:** convert preserves tool_use blocks; ingest lands tool-tagged rows findable via `memory_search` / browse (same bar as Grok Build capture tests).
4. One convert → ingest entry used by watcher and (later) hooks.

### When Grok Bot exposes hooks

1. Real `hooks.json` mirroring Claude/Grok: at least `SessionEnd`, `PostToolUse`, `Stop` (add `UserPromptSubmit` / `PostToolUseFailure` if the surface matches).
2. Hook script calls the **same** convert/ingest entry as the watcher.
3. Watcher demotes to backstop only — not a parallel product path.

### Done when

Tool-row ingest proven on watcher; hooks ready to flip; zero app patches; still one capture contract.

---

## Priority 2 — Delegation (second)

**Goal:** mesh handoff as a **real MCP tool** on the den task API — not a skill that points at curl.

### Work

1. MCP tool(s) e.g. `mesh_delegate` / `mesh_task_status` wrapping den tasks API (`goal`, `agentId`, `nodeAffinity`, `requestedBy`, budget, acceptance).
2. Skill `mesh-delegate` becomes “when to call these tools,” not a curl recipe.
3. Fan-out policy unchanged: one teammate default; ask before multi.
4. Still no injecting into Grok Bot UI threads (no public app API).

### Done when

Create + poll a mesh task via MCP.

**Depends on:** Priority 1 does not block starting design, but ship after capture prove is green so the member kit isn’t “delegate without durable memory.”

---

## Priority 3 — Den for native apps (third)

**Goal:** `rivet-den`-style live session stream so RivetHub / native apps see the session live — not only Postgres after the fact.

### Work

1. Sibling under `integrations/grok-bot/rivet-den` (preferred, matches Claude) or optional kit component.
2. Stream lifecycle / prompts / tools → `POST /event` or `/events`.
3. Best-effort; never break the chat (exit 0 on den failure).
4. Config: `RIVET_DEN_URL`, `RIVET_DEN_TOKEN`, `RIVET_DEN_NAME`, `RIVET_DEN_TERM`.
5. Prefer hooks when available; any interim bridge must **not** become a second memory-ingest path (den stream ≠ capture ingest).

### Done when

A Grok Bot / Cursor session appears in RivetHub / den viewers like Claude’s does.

**Depends on:** hooks surface or approved interim; ship after Priority 1–2 unless re-approved.

---

## Supporting parity (after / beside 1→2→3 — do not reorder ahead of them)

| Piece | Action |
| --- | --- |
| MCP recall door | Prefer plugin MCP over house den-HTTP helper once loaded |
| Discipline | Port `memory-today` / `yesterday` / `stats` / `recall` (commands and/or skills) |
| memory-researcher | Port `agents/memory-researcher.md` |
| Member rule | Strengthen browse-first / no invented memories / redact |

These fill out “full parity” but **the sequence is Capture → Delegation → Den.**

---

## Sequencing (locked)

```
1 Capture (fail-loud watcher → prove tool rows → hooks when available)
2 Delegation (mesh MCP tool on den task API)
3 Den (rivet-den live stream for RivetHub / native apps)
Then: discipline / researcher / member-rule polish as needed
```

---

## Non-goals

- Grok Bot app patches  
- Second store / new agent tags / third capture path  
- Collapsing Claude Code or Grok Build plugins into this kit  
- Building before maintainer approval  

---

## Later (one line each — not workstreams)

- Marketplace publish  
- Per-user datahub onboarding for strangers → see `PLAN-STRANGER-ONBOARDING.md` (approved for implementation, 2026-09-19; landed as a separate slice from 1→2→3)  
- Cloud capture when the computer is off  

---

## Hold

No implementation until approved.
