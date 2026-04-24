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
  [--session-id <uuid>] \
  [--permission-mode bypassPermissions]
```

- `ANTHROPIC_API_KEY` is **explicitly scrubbed from the child env** so the CLI
  falls back to its OAuth keychain (the whole point).
- Messages are serialized as a single `{"type":"user","message":...}` line on
  stdin — the CLI handles the conversation from there.
- `stream_event` JSON lines on stdout are translated into `LLMChunk`s.

## Tool handling (Phase 1 — hybrid mode)

Claude runs its **built-in** tools (Bash/Read/Edit/etc.) locally on whatever
host the provider is spawned on. RivetOS-specific tools (`memory_search`,
`delegate_task`, `coding_pipeline`, …) are **not** reachable from this provider
yet — that is planned as a Phase 2 MCP bridge.

If you need RivetOS tools, either use the `anthropic` API-key provider for
that turn or route to a different agent.

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
