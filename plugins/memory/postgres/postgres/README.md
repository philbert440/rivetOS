# @rivetos/memory-postgres

Memory plugin that adapts over the existing LCM (Lossless Context Management) PostgreSQL schema.

## What this does

- Implements the `Memory` interface from `@rivetos/types`
- Reads and writes the same tables OpenClaw's LCM plugin uses
- No migration needed — 69K messages, 2K summaries preserved
- Provides agent tools for grep/expand/describe over the summary DAG

## LCM Tables Used

| Table | Records | What it stores |
|-------|---------|---------------|
| messages | 69K | Every user/assistant message with embeddings |
| message_parts | 72K | Tool calls, reasoning blocks, files, cost tracking |
| conversations | 367 | Session → agent mapping |
| summaries | 2K | DAG-based compacted summaries |
| summary_parents | — | Parent-child edges in summary DAG |
| summary_messages | — | Summary → source message links |
| agents | 4 | Agent registry (opus, grok, local, gemini) |

## Memory Interface Methods

| Method | Implementation |
|--------|---------------|
| `append()` | INSERT into messages + message_parts, find/create conversation |
| `search()` | Hybrid FTS + temporal decay over messages + summaries |
| `getContextForTurn()` | Recent messages + relevant search, bounded by token budget |
| `getSessionHistory()` | Restore conversation from messages table on restart |

## Agent Tools

| Tool | Replaces | What it does |
|------|----------|-------------|
| `memory_grep` | Search messages + summaries (FTS, trigram, regex, semantic) |
| `memory_expand` | Drill into summary DAG, get children + source messages |
| `memory_describe` | Inspect summary metadata |
| `memory_expand_query` | Ask a focused question against expanded context |

## Configuration

```yaml
memory:
  plugin: postgres
  connection_string: ${RIVETOS_PG_URL}
```

Connection string via environment variable. Never in config files.

## How to write a different Memory plugin

This plugin is the reference implementation. To write your own:

1. Create a class that implements `Memory` from `@rivetos/types`
2. Implement: `append()`, `search()`, `getContextForTurn()`, `getSessionHistory()`
3. Export it from your plugin's `index.ts`
4. Reference it in your config

See `src/adapter.ts` for the full implementation.
