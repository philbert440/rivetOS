# rivet-memory (T3 Code) — prototype

Minimal pipe: a T3 Code thread talking to any harness (Claude, Codex, Grok,
OpenCode, …) can call RivetOS memory tools on demand. This is **not** a
production plugin and **not** Cursor-format Agent Plugin.

The backend is the existing RivetOS MCP sidecar
(`services/mcp-sidecar`). This folder only registers it.

## How registration works

T3 Code, verified against [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
main and the [docs/](https://github.com/pingdotgg/t3code/blob/main/docs/README.md)
tree on 2026-09-22:

| T3 surface | Status | What this kit does |
| --- | --- | --- |
| First-class external plugin API (`@t3tools/plugin-api`, marketplace, Pi-style hooks) | **Not shipped.** RFCs [#1582](https://github.com/pingdotgg/t3code/issues/1582), [#5020](https://github.com/pingdotgg/t3code/issues/5020). Current `packages/` has no plugin-api. | Documented, not implemented. |
| Context-injection hook (auto-pull memories into the composer) | **None.** Composer docs cover chips, skills (`$`), commands (`/`) — no third-party context provider. | Memories enter context only when the agent **calls a tool**. `src/recall-client.mjs` formats that result. |
| `t3.json` | Icon, scripts, worktree settings only. No MCP field. | Not used. |
| Built-in MCP | T3 injects `mcpServers.t3-code` as `{ type: "http", url: "http://127.0.0.1:<port>/mcp", headers: { Authorization } }` for preview/device tools. | We do not add tools to T3's server. |
| Harness MCP | Claude sessions pass `settingSources: ["user","project","local"]`, so Claude's own `mcpServers` load beside `t3-code`. Codex / OpenCode / Grok load their own config the same way. | **This is the working path.** Setup writes a `rivetos` stdio MCP entry that execs `bin/rivet-memory-mcp.sh` → existing sidecar. |
| HTTP `mcpUrl` on an Add-plugin tile | Proposed in [RFC #6419](https://github.com/pingdotgg/t3code/issues/6419): HTTP only, no headers, merged into agent `mcpServers`. **Not in** `packages/contracts/src/settings.ts` on current main. | Shipped as `t3-plugin.json` + `mcp-http.json` + `bin/rivet-memory-mcp-http.sh` so the shape matches T3's own `t3-code` entry. T3 will not load it until that RFC ships. |

Tools show up to Claude-style agents as `mcp__rivetos__<tool>` (T3's own
tools are `mcp__t3-code__*`).

```
T3 thread  →  harness (Claude/Codex/…)  →  rivetos MCP (stdio or HTTP)
                                        →  services/mcp-sidecar
                                        →  memory_search / memory_browse / …
```

## Talks to RivetOS MCP

`bin/rivet-memory-mcp.sh` is the same launcher pattern as the Claude / OpenCode
kits: load `~/.rivetos/.env`, resolve
`services/mcp-sidecar/dist/cli.js` (or `npx @rivetos/mcp-sidecar`), exec
`--stdio`.

`bin/rivet-memory-mcp-http.sh` starts the **same** sidecar without `--stdio`
so it speaks streamable HTTP on `http://127.0.0.1:5700/mcp` (override
`MCP_HOST` / `MCP_PORT`). That is the T3 `type: "http"` shape.

### Real tool names (not invented)

There is no MCP tool named `recall`, `store`, or `summarize`.

| Informal | Real tool | When registered |
| --- | --- | --- |
| recall | `memory_search` | `RIVETOS_PG_URL` (or postgres DataHub) set |
| recall (time-bounded) | `memory_browse` | same |
| recall (truncated row) | `memory_get_full` | same |
| health | `memory_stats` | same |
| store | `memory_append` | plus `RIVETOS_MCP_ENABLE_MEMORY_WRITE=1` |
| ingest session | `memory_ingest_session` | same write flag |
| summarize | **none** | Compaction worker writes summaries. Read them with `memory_search` `scope=summaries`. `memory_stats` reports compaction health. |

See `src/tool-map.mjs` and `workspace-templates/MEMORY.md`.

## Run the prototype locally

1. Build RivetOS so the sidecar exists:

   ```bash
   cd /opt/rivetos   # or this checkout
   npm install
   npm run build
   ```

2. Put DataHub credentials in `~/.rivetos/.env` (never in this repo):

   ```bash
   RIVETOS_PG_URL=postgres://USER:PASS@HOST:5432/DB
   # optional hybrid search:
   # RIVETOS_EMBED_URL=https://…
   # RIVETOS_EMBED_MODEL=text-embedding-3-small
   # optional store:
   # RIVETOS_MCP_ENABLE_MEMORY_WRITE=1
   ```

   `RIVETOS_DATAHUB_URL` with a `postgres://` / `postgresql://` scheme maps to
   `RIVETOS_PG_URL`. Without a database URL the sidecar still starts (`echo` +
   web + skills) and memory tools stay off.

3. Print or apply registration:

   ```bash
   integrations/t3code-rivetos-memory/bin/setup-t3code-rivetos-memory.sh
   integrations/t3code-rivetos-memory/bin/setup-t3code-rivetos-memory.sh --apply
   ```

   `--apply` writes `~/.rivetos/t3code-rivetos-memory/*.json` and merges
   `mcpServers.rivetos` into `~/.claude.json` when that file is missing or
   valid JSON. Start a **new** T3 thread so the harness reloads MCP.

4. Optional HTTP sidecar (T3-shaped URL):

   ```bash
   integrations/t3code-rivetos-memory/bin/rivet-memory-mcp-http.sh
   curl -sS http://127.0.0.1:5700/health/live
   ```

5. In a T3 Claude (or other harness) thread, ask the agent to call
   `memory_search` / `memory_browse`. That is the recall flow. T3 will not
   inject memories by itself.

6. Prove the client without T3:

   ```bash
   npm test --prefix integrations/t3code-rivetos-memory
   # or from the repo root:
   npx tsx integrations/t3code-rivetos-memory/test/smoke.test.ts
   integrations/t3code-rivetos-memory/test/standalone.test.sh
   ```

   The smoke test stands up the real RivetOS MCP HTTP mount with a
   `memory_search` tool, calls `recallIntoContext`, and asserts the result
   is formatted for agent context.

### Env reference

| Variable | Purpose |
| --- | --- |
| `RIVETOS_PG_URL` | Postgres memory store. Enables `memory_*` + wiki tools. |
| `RIVETOS_DATAHUB_URL` | If postgres-shaped and PG URL empty, copied to `RIVETOS_PG_URL`. |
| `RIVETOS_EMBED_URL` / `RIVETOS_EMBED_MODEL` | Optional embeddings. Model is required when the URL and PG are both set. |
| `RIVETOS_CLOUD_URL` / `RIVETOS_CLOUD_TOKEN` | Cloud mode (token never printed). |
| `RIVETOS_MCP_ENABLE_MEMORY_WRITE` | `1` to register `memory_append` / `memory_ingest_session`. |
| `RIVETOS_ROOT` | Checkout used to find `services/mcp-sidecar/dist/cli.js`. |
| `RIVETOS_ENV_FILE` | Env file parsed (never sourced). Default `~/.rivetos/.env`. |
| `MCP_HOST` / `MCP_PORT` | HTTP bind. Default `127.0.0.1:5700`. |
| `RIVETOS_MCP_TOKEN` | Bearer for TCP. T3 plugin MCP URLs cannot send headers — leave unset for the HTTP prototype. |

## Known gaps / blockers

1. **No T3 plugin host.** `plugin.json` / `t3-plugin.json` are descriptors, not
   something current T3 loads from disk.
2. **No context-injection hook.** On-demand tool calls only. Automatic
   “pull memories at turn start” would require T3 to ship RFC #5020 (or
   equivalent) or a per-harness hook outside T3.
3. **HTTP `mcpUrl` merge is not shipped.** T3 injects only `t3-code` today.
   Extra HTTP servers work if you add them to the harness config yourself
   (Claude `type: "http"` is valid; T3 will load it via settingSources).
4. **No capture.** Sibling kits (Claude, Codex, OpenCode) ingest sessions.
   This prototype only proves recall/store/summarize mapping.
5. **Not wired into `rivetos plugins install`.** T3 is not a `HARNESS_IDS`
   entry. Install is this setup script.
6. **Untested against a live T3 desktop** in this environment. The MCP
   round-trip and registration artifacts are tested; T3 UI is not.
7. **Claude `--mcp-config` is T3-owned.** T3 passes its preview server that
   way and still loads user MCP via settingSources. If a future T3 build
   set `strictMcpConfig` on normal sessions, user MCP would stop loading —
   that is a T3 change, not something this kit can paper over.

## Files

| Path | Role |
| --- | --- |
| `plugin.json` | Kit metadata + documented T3 surface. |
| `t3-plugin.json` | RFC #6419-shaped `{ name, url, mcpUrl }`. |
| `mcp.json` / `mcp-http.json` | Stdio vs HTTP MCP fragments. |
| `bin/rivet-memory-mcp.sh` | Stdio sidecar launcher. |
| `bin/rivet-memory-mcp-http.sh` | HTTP sidecar launcher. |
| `bin/setup-t3code-rivetos-memory.sh` | Print / apply / remove. |
| `src/recall-client.mjs` | `memory_search` → context block. |
| `src/tool-map.mjs` | Informal names → real tools. |
| `src/t3-surface.mjs` | Verified T3 capabilities. |
| `T3.md` | Short reflex for agents in T3 threads. |
