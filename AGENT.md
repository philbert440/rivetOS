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

Next version bump → push → all 22 land cleanly with OIDC + provenance. No more manual fiddling.

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
| 1.A.1 | Scaffold `packages/mcp-server/` (nx project, MCP SDK dep, tsconfig) | ✅ |
| 1.A.2 | Bare StreamableHTTP server with `/health/live` (no auth, no tools) | ✅ |
| 1.A.3 | First tool wired end-to-end (`rivetos.echo` smoke test → `memory_search` next) | 🟡 echo only |
| 1.A.4 | docker compose target (mcp-server + Postgres) | ⏳ |
| 1.A.5 | mTLS via `rivet-ca` + `rivetos/session.attach` handshake | ⏳ |
| 1.A.6 | Wire real data-plane tools: `memory_*`, `skill_*`, `web_fetch`, `internet_search` | ⏳ |
| 1.B.* | runtime-rpc.ts on `:5701`, inverse-registration, runtime/utility proxies | ⏳ |
| 1.C.* | claude-cli MCP bridge + native-vs-MCP allow-list | ⏳ |

### What's running today (slice 1)
- `packages/mcp-server/` — bare StreamableHTTP server on `:5700`
- `GET /health/live` returns `{status:'ok',name,version}` unauthenticated
- `POST/GET/DELETE /mcp` handles MCP protocol via `StreamableHTTPServerTransport`
- Stateful sessions, one transport per session, cleaned up on close
- Default tool: `rivetos.echo` (smoke test, will be replaced)
- Standalone CLI: `rivetos-mcp-server` binary, `MCP_HOST` / `MCP_PORT` env
- Integration test: 4 specs round-tripping `initialize → tools/list → tools/call` over real HTTP

### Decisions made in slice 1
- **Stateful mode** for the StreamableHTTPServerTransport (one session = one transport instance). Stateless would also work but we want session-scoped state when `session.attach` lands.
- **No auth in slice 1.** Localhost-only by default. mTLS comes in a later slice with the rest of the cert plumbing.
- **Lean dependency surface.** Just `@modelcontextprotocol/sdk` + `zod`. No express, no fastify — raw `http.createServer` because the SDK transport handles all the protocol work.
- **`rivetos.echo` as a permanent smoke-test tool.** It stays around as a "is the wire working" probe even after real tools land. Cheap, useful, removable in a one-line PR if it's ever in the way.

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

---

## Where things live

- **Source of truth:** `github.com/philbert440/rivetOS`
- **Dev checkout:** `/rivet-shared/RivetOS` (Syncthing across mesh)
- **Runtime:** `/opt/rivetos` (managed by `update --mesh`)
- **CA:** root on CT110 `/var/lib/rivet-ca/root/`, intermediate + chain on NFS `/rivet-shared/rivet-ca/`
- **Mesh cutover runbook:** `docs/runbooks/mesh-cutover-to-npm.md`
