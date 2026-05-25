# Advanced Memory Features

This document covers higher-level capabilities of the RivetOS memory system as exposed to Grok Build.

## `window=` Parameter (Time-Aware Browsing)

When available on the MCP server, prefer the `window=` parameter on `memory_browse`:

- `window="this_morning"`
- `window="yesterday"`
- `window="today"`
- `window="this_week"`
- `window="last_24h"`

This is significantly better than manually calculating `since`/`before` because it correctly handles local timezone boundaries.

The `memory-recall` skill is written to take advantage of this when the server supports it.

## Pre-Compaction Capture

Long Grok sessions eventually hit context limits and compact. The `PreCompact`
hook (when wired) triggers an ingest of the session's `updates.jsonl` before
the compactor rewrites it — preserving the messages that are about to be
summarized away.

This is the highest-value capture trigger and the main reason to enable hooks
in long-lived workflows.

## Cross-Agent Memory

All agents write to the same tables. When recalling, you will often surface high-quality work done by `rivet-claude` or `rivet-hermes` sessions. This is intentional and powerful.

Use the `agent` filter only when you specifically want to limit scope.

## Writing to Memory

While the primary use is recall, you can (and should) write important context into memory when the user corrects you or when you discover durable facts through external tools. Good memory entries survive model changes and long gaps between sessions.

See the `memory-recall` skill for patterns around synonym-bridging entries.
