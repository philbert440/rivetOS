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
| 1.A.6 | Skill tools: `skill_list`, `skill_manage` (workspace + system dirs both writable) | ✅ |
| 1.A.7' | Bearer-token auth (TCP) + unix-socket binding + `rivetos.session.attach` handshake | ✅ |
| 1.B'.1 | Utility surface: `shell`, `file_read`/`write`/`edit`, `search_glob`/`grep` (opt-in via env, write-surface gating) | ✅ |
| **Rescope** | `todo` and `ask_user` dropped (Claude Code natives); `subagent_*` and `compact_context` deferred indefinitely (Claude Code natives `Task` + `/compact`). `delegate_task` rolled into 1.C via dynamic adapter. | ✅ |
| 1.C | Claude-CLI MCP bridge: per-spawn embedded MCP server, dynamic tool wrapping via `adaptRivetToolDynamic`, ephemeral 127.0.0.1 + bearer, `--mcp-config` synthesis, `delegate_task` + every other runtime tool exposed. | ✅ |
| 1.D / canary | Live end-to-end: deploy to CT canary `opus-cli-canary`, exercise from Discord, soak ~24h before flipping live `rivet-opus`. | ⏳ |

**Note (Phase 1 rescope):** With Phil's "MCP server just for claude-cli for now"
direction, mTLS / `rivet-ca` / runtime-RPC / inverse-registration are out of
scope. claude-cli is a child process of the runtime on the same host — auth
collapses to a per-spawn bearer token over unix socket, and tool dispatch is
direct in-process function calls (no separate process, no mesh wire). See
"Foundations cleanup" section below for the broader architecture rethink.

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

### Decisions made in slice 1.B'.1 (utility tools — shell, file, search)
- **Phase 1.B' split into 1.B'.1 (utility, this slice) + 1.B'.2 (runtime-context, next).**
  Utility tools (`shell`, `file_*`, `search_*`) are pure in-process — no
  runtime context needed. Runtime-context tools (`delegate_task`, `subagent_*`,
  `ask_user`, `todo`, `compact_context`) require the MCP server to be hosted
  *inside* the agent runtime so they can reach `DelegationEngine`,
  `SubagentManager`, the channel handle, and the conversation buffer. That's
  a separate architectural lift (in-process embedding story, lifecycle hook,
  one MCP server per agent vs. per node). Splitting keeps slice sizes
  reasonable.
- **Opt-in via env, not enabled by default.** `RIVETOS_MCP_ENABLE_SHELL=1`,
  `RIVETOS_MCP_ENABLE_FILE=1`, `RIVETOS_MCP_ENABLE_SEARCH=1`. Three of the
  six tools (`shell`, `file_write`, `file_edit`) are write surfaces — anyone
  who can call them can run arbitrary commands or write arbitrary files as
  the MCP server process. Bearer/unix-socket auth is the access boundary,
  but on top of that we keep the surface dark by default. `search_*` is
  read-only; gated for symmetry, safe to enable freely.
- **Reused `adaptRivetTool` template verbatim.** Same wrap-and-register
  pattern as memory/web/skills. Three new files (`tools/shell.ts`,
  `tools/file.ts`, `tools/search.ts`) with hand-written zod schemas, factory
  functions returning `{tools, close}` handles. CLI gates each behind its
  own env var. No new infrastructure needed in the server core.
- **`composite: true` added to `plugins/tools/{shell,file,search}/tsconfig.json`.**
  Required for project references to work — those packages were previously
  built standalone but didn't have `composite` set, so referencing them
  from `mcp-server`'s tsconfig.json would have produced TS6306 errors at
  build time. Single-line addition each.
- **`shell` session cwd is per-`createShellTool`-instance.** The MCP wrapper
  holds one `ShellTool` for the lifetime of the server, so `cd` in one MCP
  call persists to the next. This matches how the in-process tool behaves
  for an agent. Tests verify: `cd src` then `pwd` shows the new dir.
- **No `cwd` plumbing for file/search tools.** The in-process tools resolve
  relative paths against `ToolContext.session.workingDir` when called by an
  agent; over MCP we have no such context, so we fall back to
  `process.cwd()` (the MCP server's cwd at start). Absolute paths work
  unchanged. README + tool descriptions call this out.
- **Test playground in temp dir.** `utility.test.ts` mkdtemps a playground,
  seeds it with `src/index.ts`, `src/helper.ts`, `README.md`, exercises all
  six tools end-to-end via real MCP client → real HTTP. 8 specs added,
  43 total now passing.

### Decisions made in slice 7' (auth + unix socket + session.attach)
- **Two transports, two auth models.** TCP requires `RIVETOS_MCP_TOKEN`
  bearer (constant-time compare). Unix socket (`RIVETOS_MCP_SOCKET`) gets
  filesystem perms (mode 0600) as the auth boundary — bearer skipped unless
  `RIVETOS_MCP_REQUIRE_BEARER=1`. claude-cli child-process scope means the
  unix-socket path is the realistic deploy mode; TCP+bearer stays for dev /
  future remote use.
- **Liveness probe always open.** `/health/live` never gates on auth — it's
  for orchestrators (docker-compose healthcheck, k8s probes) and exists to
  answer "is the process up", not "do I have access."
- **`rivetos.session.attach` registered per-session.** New tool factory
  binds a closure over the live session id at session-init time, so the call
  site doesn't have to thread the id through. Agent / pid / clientName are
  all optional — every field is descriptive metadata for observability,
  not a gate. Server records `SessionState` in a `Map<sessionId, state>` and
  exposes it as `server.sessions` (read-only) for tests + future quotas.
- **Session id generated eagerly.** The SDK calls `sessionIdGenerator()`
  inside `transport.handleRequest` — too late for a closure over it. We
  generate the UUID up front, hand it to both the transport and the
  per-session tool list, then let `onsessioninitialized` confirm.
- **Stale socket cleanup.** Server `unlink`s the socket file on stop; if
  startup finds an existing file at the path it removes it only if it's a
  socket (won't blow away an arbitrary file by mistake — non-socket
  presence is treated as an error).

### Decisions made in slice 1.C (claude-cli bridge — embedded MCP)
- **Per-spawn embedded MCP server.** Each `chatStream()` call brings up a
  fresh `RivetMcpServer` on `127.0.0.1:0` (ephemeral port, OS-picked), tears
  it down in `finally`. ~20ms overhead per turn; no shared-server lifecycle,
  no auth-rotation problem, no orphan sockets. Bridge file lives in
  `provider-claude-cli/src/mcp-bridge.ts`.
- **HTTP transport, not unix socket.** claude-cli's MCP config schema only
  supports `stdio | http | sse`. No native unix-socket transport. So we use
  loopback HTTP + 32-byte hex bearer token in the `Authorization` header.
  `127.0.0.1` is the security boundary; bearer is defense-in-depth on a
  process boundary.
- **Dynamic tool wrapping via `adaptRivetToolDynamic` + new
  `jsonSchemaToZodShape` translator.** Instead of hand-mapping a zod schema
  per tool, the bridge derives schemas from each `Tool.parameters` JSON
  schema at bring-up time. Covers string / number / integer / boolean /
  null / array / object / enum / `description`-passthrough; falls back to
  `z.unknown()` for novel shapes (the in-process tool's own validation
  catches bad inputs). This means **every tool the host AgentLoop has —
  including `delegate_task`, `subagent_*`, `compact_context`, the lot — is
  reachable from claude-cli with zero per-tool wiring.** The standalone CLI
  keeps its hand-mapped schemas for better wire descriptions; the dynamic
  path is bridge-only.
- **`ChatOptions.executableTools: Tool[]` added to `@rivetos/types`.** The
  AgentLoop now passes its live tool array through `ChatOptions` so
  out-of-process-runner providers (claude-cli today; SSH-bridged providers
  in a future slice) can register them on an embedded MCP server. LLM-only
  providers ignore the field.
- **`ChatOptions.agentId` added.** Mirror of `AgentLoopConfig.agentId` —
  lets the bridge label its tempdir (`rivetos-mcp-<agent>-XXXX`) so
  multi-agent hosts can correlate spawns to agents in logs.
- **Soft-fail on bridge bring-up.** If `embedMcpServerForTurn` throws, the
  provider logs to stderr and continues without the bridge — claude-cli
  still has its native tools (Bash, Read, Edit, Grep, Glob, WebFetch,
  WebSearch, Task, TodoWrite, Write), so the agent stays usable. Kill
  switch: `RIVETOS_DISABLE_MCP_BRIDGE=1` skips bridge altogether.
- **Tool name rename: dropped `rivetos.` prefix; `session.attach` →
  `session_attach`.** claude-cli prefixes MCP tools as
  `mcp__<server>__<name>`. With `rivetos` as the server name in the
  synthesized `.mcp-config.json`, `mcp__rivetos__memory_search` is the
  canonical form. The dot in `session.attach` would have rendered awkwardly
  (`mcp__rivetos__session.attach`); underscore is cleaner. Default `prefix`
  on every tool factory is now `''`; tests + descriptions updated. Pre-1.0,
  no external consumers, low cost.
- **`@rivetos/provider-claude-cli` flipped to ESM (`"type": "module"`).**
  Required to import from `@rivetos/mcp-server` (which is ESM). Also added
  `composite: true` to its tsconfig and project references for `mcp-server`.
- **Live e2e canary deferred.** This slice ships the bridge, dynamic
  adapter, and 8 specs (HTTP smoke, bearer-required, list/call round-trip,
  enum schema, teardown, idempotency, kill-switch, soft-fail). Wiring
  to a real `claude` binary on a real CT (Phase 1.D / canary) needs Phil
  to drive — `claude login`, watch logs, decide when to flip live
  `rivet-opus`. Tests don't shell out; they hit the embedded server with
  the same MCP SDK client claude-cli would use.

### Decisions made in slice 6 (skill tools)
- **Both workspace and system skill dirs are writable from MCP.** Phil's call:
  claude-cli through MCP gets the same skill-write surface in-process Opus has,
  no second-class citizen. Discovery picks up `RIVETOS_SKILL_DIRS`
  (colon-separated) or falls back to `${HOME}/.rivetos/skills`.
- **Auto-rediscovery on writes.** Wraps `skill_manage.execute` to call
  `manager.rediscover(dir)` after any non-`read` action (create/edit/patch/
  delete/retire/write_file). Keeps `skill_list` consistent with disk without
  requiring explicit refresh calls. Cost is one readdir/stat sweep per dir,
  cheap.
- **`@rivetos/core` is a direct workspace dep on `@rivetos/mcp-server` now.**
  Same call as memory tools — direct dep, project reference, type-safe imports.
  Pulls in `SkillManagerImpl + createSkillListTool + createSkillManageTool`
  cleanly.
- **No skill_match wrapped.** `skill_match` is not exposed via MCP — it's an
  internal trigger-matching helper used by the in-process agent loop, not a
  user-facing tool. If a future use case needs it we can add it.

### Decisions made in slice 5 (docker compose + schema bootstrap)
- **`infra/containers/datahub/init-db.sh` was missing the core ros_* tables.** Only the queue tables (`ros_embedding_queue`, `ros_compaction_queue`) were ever bootstrapped from the script. The actual schema (`ros_messages`, `ros_conversations`, `ros_summaries`, `ros_summary_sources`, `ros_tool_synth_queue` + their indexes + FKs) had been created by hand on CT110 long ago and never made it into the script. **Latent bug for any fresh datahub deploy** — not just the MCP stack. Fixed in this slice. Verified the script applies cleanly on a fresh DB (7 tables, 23 indexes, 3 functions, 3 triggers).
- **Separate `infra/docker/mcp-stack/` instead of overloading the root `docker-compose.yaml`.** The root compose stands up the full agent runtime; this stack is just `datahub + mcp-server` for exercising the MCP wire surface in isolation. Different audience (tool consumers, claude-cli devs) than the runtime compose (full RivetOS users). Cheaper to keep them separate.
- **Single-stage Dockerfile, mirrored from `infra/containers/agent/Dockerfile`.** The workspace graph requires the full source tree at `npm ci` time, so a multi-stage build that tries to ship "just the mcp-server runtime" is more trouble than it's worth at this stage. Image size optimization is a follow-up if it ever matters.
- **Datahub host port mapped to `5433`** to avoid colliding with a system Postgres on the developer laptop.
- **Verification path documented** in `infra/docker/mcp-stack/README.md` — `docker compose up`, curl `/health/live`, `npx @modelcontextprotocol/inspector`, or a Node smoke script. Future slices can hang the claude-cli smoke test off this same stack.

---

## Foundations cleanup (post Phase 1, planning) — DECIDED 2026-04-26

After Phase 1 closes, a focused architectural cleanup pass. **Decided** with
Phil — single container image, role-selected at startup. Not a rewrite, an
incremental simplification.

### Decision: one image, two roles minimum

```
postgres            (upstream image, persistent)
datahub             (rivetos image, --role=datahub: schema migrator, workers, queue bridge)
agent-<name> × N    (rivetos image, --role=agent --agent=<name>)
```

One image. One Dockerfile. One CI build job. One version stream. Roles split
at process start, not at image level — same pattern Kubernetes uses.

### Cleanup ordering (the spine)

1. **One image, role-selected** — collapse `infra/containers/{agent,datahub}` into
   one Dockerfile + `--role` switch. Forces decisions on schema (one migrator)
   and CI (one build job).
2. **Drizzle as schema source of truth** — datahub role runs migrations on boot.
   `init-db.sh` becomes a generated artifact or goes away entirely.
3. **Build simplification** — drop project references / `composite: true` /
   tsbuildinfo. Bundle with esbuild for the container; tsc for typecheck only.
   Kills the entire class of build bugs from the recent past (the tsbuildinfo
   leak, the parallel race, the cold-cache TS6305 cascade).
4. **Single npm publish** — only `@rivetos/cli` is publicly distributable.
   Internal packages flip to `private: true`. ~90% less version-bump churn.
5. **Retire `provision-ct.sh`** — replace with Pulumi templates that consume
   the unified compose file. 938 lines of imperative bash → declarative IaC.
6. **Plugin self-registration** — `definePlugin({ type, name, init, lifecycle })`
   exported from each plugin file; boot scans `src/plugins/**`. Retires the
   registrar switch statements and lifecycle monkey-patches.
7. **Typed provider configs** — discriminated unions instead of
   `Record<string, unknown>`. Compile-time safety, kills wizard regressions
   like the `max_tokens` issue caught in #138.

Top two (#1 + #2) get ~70% of the value for ~3 days. Full pass is ~2 weeks.

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
