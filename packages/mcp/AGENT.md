# @rivetos/mcp — agent context

## Current state (2026-08-04)

Full ABC cutover to **MCP 2026-07-28 final** is on branch `feat/mcp-2026-07-28-final`.

| Package | Role | Protocol / SDK |
|---|---|---|
| `@rivetos/mcp` | SDK-agnostic core (ToolRegistration, adapt) | — |
| `@rivetos/mcp-v1` | Sessionful mount | 2025-11-25 / `@modelcontextprotocol/sdk@1.30.0` |
| `@rivetos/mcp-v2` | Stateless mount + client facade | 2026-07-28 / `server|client|node@2.0.0` |
| `@rivetos/mcp-server` | In-process transport plugin | **v2** |
| `@rivetos/mcp-sidecar` | Standalone process | HTTP→**v2**, stdio→**v1** (env override) |
| `@rivetos/tool-mcp-client` | Outbound client plugin | dual-stack, default v1 |
| claude-cli `mcp-bridge` | Per-spawn embedded server | **v2** default, `RIVETOS_MCP_BRIDGE_PROTOCOL=v1` fallback |

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

- `RIVETOS_MCP_PROTOCOL=v1|v2` — sidecar (stdio defaults v1; HTTP defaults v2)
- `RIVETOS_MCP_BRIDGE_PROTOCOL=v1|v2` — claude-cli bridge (default v2)

## Gate

`packages/mcp-v2` round-trip harness is the merge gate. Bump the three
`@modelcontextprotocol/{server,client,node}` packages **together**.

## Open

- Claude Code fleet canary on real `claude` binary (support rolling out)
- Full MCP Tasks RPC (`tasks/get` / `subscriptions/listen`) when a consumer needs it
- v2 stdio transport for sidecar (currently refused — use HTTP/socket)
