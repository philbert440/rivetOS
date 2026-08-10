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

Commits are **authored** as `Rivet Philbot <rivetphilbot@gmail.com>` — the
account's own identity — and carry **no trailer of any kind**. Nothing is
co-authored: there is one author, and it is already on the commit.

- ✅ `git commit --author='Rivet Philbot <rivetphilbot@gmail.com>'`, body ends
  at the last line of prose
- ❌ any `Co-Authored-By:` trailer, including a RivetOS-branded one
- ❌ `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

Applies to every commit message and PR body alike. The identity is Rivet —
neither the vendor nor the model behind it belongs in a repo artifact.

## Commit messages

Conventional Commits, scoped by area. Examples from recent history:

- `fix(memory_stats): bucket unsummarized by compactor eligibility`
- `feat(heartbeat): migrate scheduler to graphile-worker`
- `build(deps): sync lockfile — bump devalue 5.8.0→5.8.1`
- `refactor(channel-agent): tighten mTLS peer handshake`

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
not pnpm and not yarn. Workspace members are enumerated under `workspaces` in
the root `package.json`: `packages/*`, five per-category plugin globs
(`plugins/{channels,memory,providers,tools,transports}/*`), `services/*`, four
explicitly-listed apps (`apps/den`, `apps/site`, `apps/rivethub-web`,
`apps/rivet-android` — note `apps/rivethub-desktop` is *not* a member), and the
two `integrations/*/rivet-memory/capture` packages.

Internal packages mostly depend on each other by **exact pinned version**
rather than the `workspace:*` protocol. This is a repo convention, not an npm
limitation: most of these packages are published to npm, and a pinned version
is what consumers outside the workspace resolve against, so the manifest reads
the same in-tree and on the registry.

The pins track each dependency's own version, so they are not uniform. Most
of the tree is at `0.4.0-beta.6`, but several members are not — e.g.
`den-protocol` and `den-packs` at `0.1.0`; `den-server`, `embedding-worker`,
`compaction-worker`, `den-app`, and `site` at `0.4.0`; `rivet-android` at
`0.0.0`; and the two capture packages at `0.3.0` and `0.1.0`. Check the
member's own `version` rather than assuming the common one. A handful of edges
opt out with `"*"` (`gateway-client` → types, `den-server` → types,
`rivethub-web` → types and gateway-client); those always resolve to the local
member.

For every pinned edge, npm links the workspace member locally only while the
pin still matches that member's own `version`. Bump a package's version
without bumping the consumers that pin it and npm will quietly resolve the
**published tarball** from the registry instead of your local source — the
build succeeds, and you are testing the wrong code. Bump in lockstep.

Edits to a workspace package need a rebuild before consumers see them:

```bash
npx nx build @rivetos/memory-postgres   # or: npx nx run-many -t build
```

`npm install` re-links workspace members; there is no per-consumer cache to
hand-copy.

## Tests

- Each plugin/service has its own `npm test` (vitest). Run from the
  package directory.
- The tests that need a live Postgres skip when `RIVETOS_PG_URL` is unset —
  `plugins/memory/postgres/src/adapter.test.ts` and
  `services/mcp-sidecar/src/memory.test.ts`. The compaction- and
  embedding-worker tests are plain unit tests and always run.
