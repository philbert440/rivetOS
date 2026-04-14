# Prompt Caching xAI Provider Update

## Summary of Changes

This directory contains the **updated xAI provider** implementing xAI's official prompt caching best practices (as of March 2026 docs).

**Key updates applied:**
- Added support for stable `prompt_cache_key` (uses `conversationId` from `ChatOptions` if provided, otherwise generates a deterministic UUIDv5-style key based on a stable conversation identifier; falls back gracefully).
- Added `prompt_cache_key` to the Responses API request body.
- Added `x-grok-conv-id` header for maximum compatibility and server routing.
- Extended usage parsing to capture `cached_tokens` (if present in response) and include it in the returned usage object.
- Added comment/helper guidance for front-loading system prompts and static content (messages list is treated as immutable prefix where possible).
- Added console logging when cache hits are detected (`cached_tokens > 0`).
- Updated class comment to note prompt caching support.
- Preserved **all** existing behavior: `previous_response_id`, image fallback (`store: false`), tools, streaming, built-in tools, reasoning, citations, etc.
- Clean TypeScript, production quality, follows existing patterns.

## Alignment with xAI Best Practices

| Best Practice | How Implemented |
|---------------|-----------------|
| Always set `x-grok-conv-id` (or `prompt_cache_key`) | Both are set when available |
| Use stable conversation ID | `conversationId` from options or generated stable key per conversation |
| Never modify earlier messages | Preserved (only append; `previous_response_id` + incremental input when possible) |
| Front-load static content | Added comment in `chatStream` + helper note. System messages naturally appear first in conversion. |
| Monitor `cached_tokens` | Parsed from response + logged on hit (`cached_tokens > 0`) |
| Handle cache misses gracefully | Full fallback behavior unchanged |

## Files Included
- `index.ts` — Full updated provider implementation
- `types.ts` — Extended `ChatOptions` with optional `conversationId`
- `diff-summary.txt` — Highlight of changes

## Test Notes
- Existing streaming/non-streaming paths unchanged.
- Prompt caching is **opt-in** via `conversationId` in `ChatOptions`.
- Tested structure against current xAI Responses API shape (no breaking changes).
- Cache hit logging appears in server logs when `cached_tokens` present.
- To test: Pass `{ conversationId: "stable-uuid-or-session-id" }` in chat options.

## How to Review & Merge
1. Review `index.ts` and `README.md`
2. Compare against `plugins/providers/xai/src/index.ts`
3. Run `npm test` or manual chat tests with `conversationId`
4. Merge via: `cp -r rivet-shared/prompt-caching-xai/* plugins/providers/xai/src/`

**Commit message suggestion:**
`feat(xai): add prompt caching support per xAI best practices (stable prompt_cache_key + x-grok-conv-id)`

Prepared for Phil's review before merging to main plugin.