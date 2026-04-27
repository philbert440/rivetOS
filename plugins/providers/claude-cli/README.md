# @rivetos/provider-claude-cli

**Claude Code CLI provider** — routes chat requests through the locally installed
`claude` binary, so Rivet uses the user's Claude subscription OAuth token
instead of console API key billing.

## Why this exists

In April 2026 Anthropic softened the January 2025 third-party harness ban.
The sanctioned pattern is: **don't extract OAuth tokens to impersonate Claude
Code** (banned), but **do shell out to the real Claude CLI and let it own auth,
caching, and the wire protocol** (allowed). This provider implements the
sanctioned pattern.

## How it works

For each `chatStream` call we spawn:

```
claude -p \
  --input-format  stream-json \
  --output-format stream-json \
  --verbose \
  --tools "Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write" \
  --effort medium \
  --exclude-dynamic-system-prompt-sections \
  [--model opus|sonnet] \
  [--append-system-prompt <persona>] \
  [--mcp-config <ephemeral-tempfile>] \
  [--session-id <uuid>] \
  [--permission-mode bypassPermissions]
```

- `ANTHROPIC_API_KEY` is **explicitly scrubbed from the child env** so the CLI
  falls back to its OAuth keychain (the whole point).
- Messages are serialized as a single `{"type":"user","message":...}` line on
  stdin — the CLI handles the conversation from there.
- `stream_event` JSON lines on stdout are translated into `LLMChunk`s.

## Tool handling (Phase 1.C — embedded MCP bridge)

Two surfaces, two lanes:

1. **Native Claude Code tools** (Bash/Read/Edit/Grep/Glob/WebFetch/WebSearch/Task/
   TodoWrite/Write) run inside the CLI process exactly as before. We don't shadow
   what works.
2. **RivetOS tools** (`memory_search`, `delegate_task`, `skill_list`, `web_fetch`,
   the lot — every tool the host AgentLoop has) are exposed via a per-spawn
   embedded MCP server. Claude sees them as `mcp__rivetos__<name>`.

Mechanics for each `chatStream()` turn:

1. `embedMcpServerForTurn({ tools, agentId })` brings up a fresh
   `RivetMcpServer` on `127.0.0.1:0` (ephemeral OS-picked port) protected by
   a 32-byte hex bearer.
2. Each executable tool is wrapped via `adaptRivetToolDynamic` — its zod
   schema is derived from the `Tool.parameters` JSON-Schema-ish object. Live
   `execute` closures retain the host runtime context (DelegationEngine,
   channel handle, conversation buffer) — that is the whole point of doing
   this in-process instead of via runtime-RPC.
3. A `.mcp-config.json` tempfile is written (mode 0600) pointing
   claude-cli at the server with the bearer in the `headers` block.
4. `claude -p ... --mcp-config <tempfile> ...` is spawned.
5. On every exit path (success / error / timeout / abort), `bridge.close()`
   stops the server and unlinks the tempfile.

Soft-fail: if bridge bring-up throws, the provider logs to stderr and continues
without it — the CLI still has its native tools, so the agent stays usable.

Kill switch: set `RIVETOS_DISABLE_MCP_BRIDGE=1` to skip the bridge (e.g. for
smoke testing the bare shellout).

## Config

```yaml
providers:
  claude-cli:
    binary: claude                 # default
    model: opus                    # or 'sonnet' — default: CLI default
    effort: medium                 # low|medium|high|xhigh|max — default: medium
    tools: default                 # or comma-separated list, or "" to disable
    permission_mode: bypassPermissions
    exclude_dynamic_sections: true
    append_system_prompt: true     # fold system messages into --append-system-prompt
    cwd: /root/.rivetos/workspace  # cwd for the spawned process
    context_window: 200000
    max_output_tokens: 32000
```
