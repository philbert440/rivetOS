# @rivetos/mcp — agent context

## Current state (2026-08-08)

Everything speaks **MCP 2026-07-28 final** (v2). `packages/mcp-v1` (the
sessionful 2025-11-25 mount on `@modelcontextprotocol/sdk@1.30.0`) is
DELETED — stdio compatibility with 2025-era clients (Claude Code today) is
handled by the v2 SDK's era-negotiating `serveStdio` instead of a separate
v1 mount.

| Package                    | Role                                              | Protocol / SDK                                         |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `@rivetos/mcp`             | SDK-agnostic core (ToolRegistration, adapt, echo) | —                                                      |
| `@rivetos/mcp-v2`          | Stateless mount (HTTP + stdio) + client facade    | 2026-07-28 / `server`/`client`/`node` `@2.0.0`         |
| `@rivetos/mcp-server`      | In-process transport plugin                       | **v2**                                                 |
| `@rivetos/mcp-sidecar`     | Standalone process                                | HTTP→**v2**; stdio→era-negotiating (v2, legacy served) |
| `@rivetos/tool-mcp-client` | Outbound client plugin                            | own SDK dep (not mcp-v1)                               |
| claude-cli `mcp-bridge`    | Per-spawn embedded server                         | **v2** only                                            |

## Spec features wired

- Stateless core (no initialize / Mcp-Session-Id) on v2
- `versionNegotiation: { pin: '2026-07-28' }` on v2 client (SDK defaults to legacy!)
- tools/list **cache hints** (60s private default)
- **Tool annotations** (readOnly/destructive/idempotent/openWorld) on sidecar tools
- **Structured tool results** (content arrays; string still accepted)
- **MRTR** `input_required` on v2 (manual mode on client — `autoFulfill: false`)
- **server/discover** via `connectV2().discover()`
- Tasks extension: scaffold only (`packages/mcp-v2/src/tasks.ts`)

## Env knobs

The `RIVETOS_MCP_PROTOCOL` / `RIVETOS_MCP_BRIDGE_PROTOCOL` switches were
removed with mcp-v1 — every mount is v2. `RIVETOS_DISABLE_MCP_BRIDGE`
(claude-cli provider kill switch) remains.

## Gate

`packages/mcp-v2` round-trip harness is the merge gate. Bump the three
`@modelcontextprotocol/{server,client,node}` packages **together**.

## Open

- Claude Code fleet canary on real `claude` binary (support rolling out)
- Full MCP Tasks RPC (`tasks/get` / `subscriptions/listen`) when a consumer needs it
