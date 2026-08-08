# CLAUDE.md — rivetOS repo

Project-specific guidance for AI agents working in this repo. Pairs with
`~/.claude/CLAUDE.md` (identity, workspace, memory) and
`.github/PULL_REQUEST_TEMPLATE.md` (PR checklist).

## Memory first

Before asking the user for context, before guessing, before re-deriving
something from the codebase — **search the RivetOS memory system first**.
Every prior conversation with this human is indexed there. The answer to
"what did we decide about X?", "why does Y work the way it does?", "did
we already try Z?" is almost always already in memory.

Tools (exposed by the `rivet-memory` MCP server):

- `memory_search` — semantic + lexical hybrid search. Default first move.
- `memory_browse` — chronological / by-conversation browse for when you
  know roughly when something happened.
- `memory_stats` — health check on the memory system itself.

A `memory_search` call costs ~50ms. Asking the user costs minutes of
back-and-forth and breaks their flow. The default is to query first and
only ask if memory comes up empty.

If workspace files and memory disagree, **memory wins** — the user was
there, the file might be stale. Update the file.

## Commit & PR signature

Use **RivetOS Claude**, not Claude Code branding.

- ✅ `Co-Authored-By: RivetOS Claude <noreply@rivetos.dev>`
- ❌ `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
- ❌ `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

Applies to every commit message and PR body. The identity is Rivet — the
underlying model/tool is an implementation detail and shouldn't leak into
artifacts.

## Commit messages

Conventional Commits, scoped by area. Examples from recent history:

- `fix(memory_stats): bucket unsummarized by compactor eligibility`
- `feat(heartbeat): migrate scheduler to graphile-worker`
- `build(deps): sync lockfile — bump devalue 5.8.0→5.8.1`
- `refactor(channel-telegram): rewrite on @chat-adapter/telegram`

Body should explain **why** (what was broken / what motivated the change),
not just **what** (the diff already shows that).

## Build & deploy

- This repo *is* the upstream source (`github.com/philbert440/rivetOS`).
  When developing here, commits push directly to origin.
- The runtime service (`rivetos.service`) loads from this same checkout
  via `/etc/systemd/system/rivetos.service`, so source edits + service
  restart = deploy. Restart only after typecheck/build/tests pass.
- The compaction-worker and embedding-worker live at
  `services/{compaction,embedding}-worker/` and run as **separate**
  systemd services (where deployed) — not as part of `rivetos.service`.

## Workspace layout & installs

This is an **npm workspace** monorepo (`package-lock.json`, `npm ci` in CI) —
not pnpm and not yarn. Workspace members are listed under `workspaces` in the
root `package.json`: `packages/*`, `plugins/*/*`, `services/*`, and several
`apps/`.

Internal packages depend on each other by **pinned version**
(`"@rivetos/types": "0.4.0-beta.6"`) rather than the `workspace:*` protocol,
which npm does not support. npm still links them from the workspace as long as
the pinned version matches the member's `version` field — so a version bump
that lands in one package but not its consumers will silently pull the
published tarball from the registry instead of the local source. Bump in
lockstep.

Edits to a workspace package need a rebuild before consumers see them:

```bash
npx nx build @rivetos/memory-postgres   # or: npx nx run-many -t build
```

`npm install` re-links workspace members; there is no per-consumer cache to
hand-copy.

## Tests

- Each plugin/service has its own `npm test` (vitest). Run from the
  package directory.
- The compactor + embedder integration tests skip if `RIVETOS_PG_URL` is
  unset, which is fine for the default CI run.
