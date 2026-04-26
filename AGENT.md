# AGENT.md — RivetOS Project Context

Live continuity file. Any agent (Opus/Grok/Sonnet/Local) picking this up cold should read this first.

## Current Phase: 0.75 — CLOSED ✅

**"Make RivetOS installable from npm."** Done as of 2026-04-26.

### What "closed" means
- ✅ All 22 packages installable as `@rivetos/*` from the public npm registry
- ✅ CI auto-publishes on push to `main` via `.github/workflows/publish.yml`
- ✅ OIDC Trusted Publishing wired up for every package (no long-lived NPM_TOKEN)
- ✅ `--provenance` SLSA attestation on every CI publish
- ✅ 0 known vulnerabilities (`npm audit` clean)
- ✅ 0 outdated majors across the workspace
- ✅ Mesh cutover runbook: `docs/runbooks/mesh-cutover-to-npm.md`

### Recent PRs (the sweep)
| PR | Scope |
|---|---|
| #129 | publish.yml `actions: read` + mesh cutover runbook |
| #131 | nx subtree transitive vuln overrides (10 → 4 vulns) |
| #132 | astro 5 → 6, starlight 0.32 → 0.38, sharp 0.34 (4 → 0 vulns) |
| #133 | runtime majors: TS 6, undici 8, vitest 4, zod 4, pulumi 5 (TS 6 needed `types: ["node"]` in tsconfig.base.json) |
| #134 | publish loop `((var++))` → `((++var))` to survive `set -e` on first skip |

### Bootstrap publishes (manual, classic-token, OTP)
Two net-new package names couldn't first-publish via OIDC (npm requires the package name to exist before a trusted publisher can be configured). Phil bootstrapped them manually with `--otp` from his laptop, then added GitHub Actions trusted publishers on npmjs.com:
- `@rivetos/provider-claude-cli`
- `@rivetos/provider-llama-server`

Future first-publishes of new package names will need the same one-time bootstrap dance. Document this when adding new plugins.

### Registry state at closeout
- 9 packages auto-published to `0.4.0-beta.2` by the most recent CI run after #134
- 11 packages still on `0.4.0-beta.1` (CI loop completed cleanly but those didn't get version-bumped this round)
- 2 net-new names exist via manual bootstrap

PR #135 bumps every workspace package to `0.4.0-beta.3`. After merge, CI should land the full 22-package set on beta.3 with OIDC + provenance. `@rivetos/mcp-server` is intentionally **not** in `publish.yml` `PACKAGES` yet — first-publish needs the same manual `--otp` bootstrap dance as claude-cli/llama-server, then a follow-up PR to add it to the array.

---

## Current Phase: 1 — MCP server for claude-cli (IN PROGRESS)

**Goal:** Expose RivetOS tools/memory/skills as an MCP (Model Context Protocol) server so `claude-cli` (and any other MCP-compatible client) can wire into a RivetOS node and use it as an agent backend.

**Spec:** `/rivet-shared/plans/mcp-architecture-overhaul.md` (Phase 1 starts at §230)

### Sub-phases
- **1.A** Server scaffold + data-plane tools (3–4 days)
- **1.B** Runtime-RPC + runtime/utility-plane proxies (5–6 days)
- **1.C** Claude-CLI bridge (2–3 days)

### Slice progress

| Slice | Scope | Status |
|---|---|---|
| 1.A.1 | Scaffold `plugins/transports/mcp-server/` (nx project, MCP SDK dep, tsconfig) | ✅ |
| 1.A.2 | Bare StreamableHTTP server with `/health/live` (no auth, no tools) | ✅ |
| 1.A.3 | First tool wired end-to-end (`rivetos.echo` smoke test → `rivetos.memory_search`) | ✅ |
| 1.A.4 | Memory + web data-plane tools: `memory_browse`, `memory_stats`, `internet_search`, `web_fetch` | ✅ |
| 1.A.5 | docker compose target (mcp-server + Postgres) + schema bootstrap | ✅ |
| 1.A.6 | Skill tools: `skill_list`, `skill_manage` (workspace + system dirs both writable) | ⏳ |
| 1.A.7 | mTLS via `rivet-ca` + `rivetos/session.attach` handshake | ⏳ |
| 1.B.* | runtime-rpc.ts on `:5701`, inverse-registration, runtime/utility proxies | ⏳ |
| 1.C.* | claude-cli MCP bridge + native-vs-MCP allow-list | ⏳ |

### What's running today (slice 3)
- `plugins/transports/mcp-server/` — StreamableHTTP server on `:5700`
- `GET /health/live` returns `{status:'ok',name,version}` unauthenticated
- `POST/GET/DELETE /mcp` handles MCP protocol via `StreamableHTTPServerTransport`
- Stateful sessions, one transport per session, cleaned up on close
- Tools registered:
  - `rivetos.echo` — smoke-test tool, stays around as a wire probe
  - `rivetos.memory_search`, `rivetos.memory_browse`, `rivetos.memory_stats`
    — full memory data-plane wrapping `@rivetos/memory-postgres`. Auto-enabled
    when `RIVETOS_PG_URL` is set (disabled otherwise).
  - `rivetos.internet_search`, `rivetos.web_fetch` — web data-plane wrapping
    `@rivetos/tool-web-search`. Always enabled (DuckDuckGo fallback for search,
    Google CSE used when `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID` are set).
- Standalone CLI: `rivetos-mcp-server` binary. Env: `MCP_HOST`, `MCP_PORT`,
  `RIVETOS_PG_URL`, `RIVETOS_EMBED_URL`, `RIVETOS_EMBED_MODEL`,
  `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID`, `RIVETOS_USER_AGENT`.
- Generic `adaptRivetTool(tool, zodSchema, opts?)` helper — the template every
  in-process tool follows when crossing the MCP wire. Flattens
  `string | ContentPart[]` results to text for the current wire shape.
- Factories follow `{tools: ToolRegistration[], close: () => Promise<void>}`
  shape: `createMemoryTools` (3 tools, drains pg pool), `createWebTools`
  (2 tools, no-op close).
- Tests: 18 specs total — 11 wire/adapter, 4 memory (PG-gated), 3 web
  (1 always-on, 1 always-on, 1 network-gated via `RIVETOS_TEST_SKIP_NETWORK=1`).

### Decisions made in slice 1
- **Stateful mode** for the StreamableHTTPServerTransport (one session = one transport instance). Stateless would also work but we want session-scoped state when `session.attach` lands.
- **No auth in slice 1.** Localhost-only by default. mTLS comes in a later slice with the rest of the cert plumbing.
- **Lean dependency surface.** Just `@modelcontextprotocol/sdk` + `zod`. No express, no fastify — raw `http.createServer` because the SDK transport handles all the protocol work.
- **`rivetos.echo` as a permanent smoke-test tool.** It stays around as a "is the wire working" probe even after real tools land. Cheap, useful, removable in a one-line PR if it's ever in the way.

### Decisions made in slice 2
- **Direct workspace dep on `@rivetos/memory-postgres`** rather than a dynamic import. Simpler types, project-reference build chain works out of the box, and the cost is small — anyone installing `@rivetos/mcp-server` already has Postgres on the table conceptually.
- **Hand-written zod schema for `memory_search`.** The RivetOS `Tool.parameters` is a JSON-Schema-ish `Record<string, unknown>` and the MCP SDK validates inputs via zod at the wire. Auto-translating the JSON schema would be brittle; one hand-mapped schema per tool gives us better descriptions for the MCP audience anyway.
- **Generic `adaptRivetTool` helper.** Every future data-plane tool follows the same template: build the in-process Tool, write a zod schema, call `adaptRivetTool`. This kills boilerplate before it accretes.
- **String-only wire result for slice 2.** `ContentPart[]` results from RivetOS tools (e.g., images from `web_fetch` screenshots) get flattened to text with a `[non-text part: image]` placeholder. Slice 3 widens this to native MCP content arrays once any tool actually exercises it.
- **PG pool ownership.** `createMemorySearchTool` opens its own pool and returns `{tool, close}`. Caller is responsible for `close()` on shutdown — the CLI does this in its SIGTERM/SIGINT handler.

### Decisions made in slice 3
- **Refactored `createMemorySearchTool` → `createMemoryTools`.** Single factory now returns all three memory tools (`memory_search`, `memory_browse`, `memory_stats`) sharing one PG pool. `createMemorySearchTool` kept as a deprecated shim for backwards compat — calling code should migrate to the new name. Avoids opening N pools for N tools, and the call site stays a single `tools.push(...handle.tools)`.
- **Web tools always enabled.** `internet_search` falls back to DuckDuckGo without Google credentials; `web_fetch` needs nothing. No env-gating necessary, so the CLI registers them unconditionally. Cleaner UX than "configure 4 env vars to get any web access."
- **Hand-mapped zod schemas per tool.** Same call as slice 2 — auto-translating from `Tool.parameters` JSON schema would be brittle, and writing zod by hand lets us tighten descriptions for the MCP audience. Five schemas now live in `tools/memory.ts` + `tools/web.ts`.
- **Skills deferred to a separate slice.** `skill_list`/`skill_manage` need `SkillManagerImpl` initialization, skill-dir discovery, and a write-surface security model (which dirs should be writable from MCP?). Worth its own slice rather than being shoehorned in. **Phil's call:** workspace + system dirs both writable from MCP — same surface in-process Opus has.
- **Network-gated test instead of skipping always.** `web.test.ts` runs `internet_search` against the real network by default, opt-out via `RIVETOS_TEST_SKIP_NETWORK=1`. Better signal in CI than auto-skip.

### Decisions made in slice 5 (docker compose + schema bootstrap)
- **`infra/containers/datahub/init-db.sh` was missing the core ros_* tables.** Only the queue tables (`ros_embedding_queue`, `ros_compaction_queue`) were ever bootstrapped from the script. The actual schema (`ros_messages`, `ros_conversations`, `ros_summaries`, `ros_summary_sources`, `ros_tool_synth_queue` + their indexes + FKs) had been created by hand on CT110 long ago and never made it into the script. **Latent bug for any fresh datahub deploy** — not just the MCP stack. Fixed in this slice. Verified the script applies cleanly on a fresh DB (7 tables, 23 indexes, 3 functions, 3 triggers).
- **Separate `infra/docker/mcp-stack/` instead of overloading the root `docker-compose.yaml`.** The root compose stands up the full agent runtime; this stack is just `datahub + mcp-server` for exercising the MCP wire surface in isolation. Different audience (tool consumers, claude-cli devs) than the runtime compose (full RivetOS users). Cheaper to keep them separate.
- **Single-stage Dockerfile, mirrored from `infra/containers/agent/Dockerfile`.** The workspace graph requires the full source tree at `npm ci` time, so a multi-stage build that tries to ship "just the mcp-server runtime" is more trouble than it's worth at this stage. Image size optimization is a follow-up if it ever matters.
- **Datahub host port mapped to `5433`** to avoid colliding with a system Postgres on the developer laptop.
- **Verification path documented** in `infra/docker/mcp-stack/README.md` — `docker compose up`, curl `/health/live`, `npx @modelcontextprotocol/inspector`, or a Node smoke script. Future slices can hang the claude-cli smoke test off this same stack.

---

## Earlier Phases (history)

### Phase 0.5 — Mesh mTLS Migration ✅
Shared CA on CT110, intermediate + chain on NFS. `MeshConfig.tls: boolean` switch. Server uses `https.createServer({ requestCert, rejectUnauthorized })`, client uses `undici.Agent` with mTLS. CA = allow-list (signed by our intermediate ⇒ trusted). Node certs only on the wire; agent certs issued but unused. `mesh.secret` deprecated. Single PR / single cutover via `update --mesh`.

### Phase 0.75 — npm publishability ✅ (this phase)

---

## Future Phases (not started)
- **Phase 2:** Per-agent client certs on the wire (CN binding, `fromAgent` ↔ CN strict check)
- **Phase 3:** CRL distribution, cert rotation automation
- **Phase 4:** Drop `mesh.secret` field entirely from types
- **Eventually:** Make the monorepo private and ship only the published packages publicly. We're already 90% set up for that — every package has its own `package.json`, OIDC trusted publishing is per-package, and `publish.yml` is a simple loop. Repo strategy concern, not publish mechanics.

---

## Gotchas (carried forward)

- `/opt/rivetos` is **runtime** — never edit code there. Dev work goes in `/rivet-shared/RivetOS`.
- `update --mesh` is the ONLY correct way to deploy. Don't hand-roll `git pull && npm install && nx build && systemctl restart`.
- CA root key is **CT110-only**. Any cert issuance runs on CT110.
- **Sonnet sub-agents wedged** twice during 0.5 (0 iterations, no progress). If delegating, watch closely; fall back to direct edits.
- **Grok hallucinated commit success** in `coding_pipeline` once — verify with `git log` before trusting "done".
- **`((var++))` is a `set -e` footgun.** Returns exit 1 when var is 0. Always use `((++var))` in bash scripts under `set -e`.
- **TS 6 dropped auto-discovery of `@types/*`.** If TS 6+ build complains about `Buffer`/`process`/`console`, add `"types": ["node"]` to `tsconfig.base.json`.
- **astro 6 + zod v4** conflict if root `package.json` pins `zod ^3`. Drop the root override; let astro nest its own zod 4 under `@astrojs/sitemap` while MCP SDK uses zod 3 from root devDeps.
- **vitest version drift across workspace** breaks CI even when local node_modules looks fine. If you bump root vitest, sweep every plugin's `package.json` for matching version. `npm ls vitest` to verify dedupe.
- **Dependabot lockfile drift** — same shape as #123 keeps recurring. `@dependabot recreate` first, fall back to manual `npm install` heal if that fails. Don't push without verifying `npm run build`.
- **OIDC trusted publishing** can't first-publish a brand-new package name. Bootstrap with classic token + OTP, add trusted publisher on npmjs.com, future CI publishes work cleanly.
- **Datahub `init-db.sh` carried a latent gap pre-slice 1.A.5.** Core `ros_*` tables had to be bootstrapped via the script (was previously hand-rolled on CT110 only). Anyone deploying a fresh datahub now or after this slice gets the full schema automatically. If you ever see "relation ros_messages does not exist" on a brand-new node, this script is what should be running.

---

## Where things live

- **Source of truth:** `github.com/philbert440/rivetOS`
- **Dev checkout:** `/rivet-shared/RivetOS` (Syncthing across mesh)
- **Runtime:** `/opt/rivetos` (managed by `update --mesh`)
- **CA:** root on CT110 `/var/lib/rivet-ca/root/`, intermediate + chain on NFS `/rivet-shared/rivet-ca/`
- **Mesh cutover runbook:** `docs/runbooks/mesh-cutover-to-npm.md`
