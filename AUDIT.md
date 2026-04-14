# RivetOS Architecture Audit — April 14, 2025

Comprehensive review of codebase patterns, bugs, and architectural issues.

## 🔴 Bugs (Active)

### 1. xAI `lastResponseId` bleeds into heartbeats
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/runtime.ts` (lines 294–302), `packages/providers/src/xai.ts` (line 233)
- **Problem:** Heartbeats create a new `AgentLoop` but share the same provider instance. `freshConversation` is never set for heartbeats, so xAI sends a stale `previous_response_id` → 404.
- **Evidence:** `12:48:16 [Heartbeat] Error running grok: xAI 404: Response with id=820ef2c7... not found` (April 14)
- **Fix:** Set `freshConversation: true` on the heartbeat `AgentLoop` in `runtime.ts:294`. ~1 line.
- **Assigned:** —

### 2. Double-counting token usage on `done` chunks
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/loop.ts` (lines 373–385, 455–458)
- **Problem:** Per-chunk usage tracking uses `Math.max()`, but the `done` event handler uses `+=`, double-counting the final chunk's tokens.
- **Fix:** Use `Math.max()` in the `done` handler too, or remove per-chunk tracking since `done` is authoritative. ~3 lines.
- **Assigned:** —

### 3. Circuit breaker exists but is never wired in
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/circuit-breaker.ts`
- **Problem:** Well-written module with global registry, but nothing in runtime/turn-handler/providers calls `canRequest()`, `recordSuccess()`, or `recordFailure()`. Dead code.
- **Fix:** Either wire it into the provider layer or remove it. Medium effort if wiring in.
- **Assigned:** —

---

## 🟡 Architecture Issues

### 4. Fallback hook has full handler duplication
- **Status:** 🔲 Open
- **File:** `packages/core/src/hooks/fallback.ts` (lines 75–168 vs 174–263)
- **Problem:** `createFallbackHook()` and `createFallbackHookWithState()` contain identical handler logic copy-pasted. Fix a bug in one, forget the other.
- **Fix:** Extract shared handler logic into a common function. ~30 min.
- **Assigned:** —

### 5. Provider `model` access via unsafe cast
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/loop.ts` (lines 341, 491, 529)
- **Problem:** Reaches into provider to read `.model` using `as unknown as Record<string, unknown>`. The `Provider` interface already has `getModel()`.
- **Fix:** Replace casts with `this.provider.getModel()`. ~3 lines.
- **Assigned:** —

### 6. `console.*` instead of structured logger
- **Status:** 🔲 Open
- **Files:** `heartbeat.ts` (5), Discord channel (~15), voice-discord (~15), Anthropic provider (2), memory/postgres plugins (20+)
- **Problem:** Raw `console.log/error` bypasses the structured logger. Won't respect log levels or formatting.
- **Fix:** Replace with `logger.*` calls. Tedious but straightforward.
- **Assigned:** —

### 7. Sub-agent sessions never expire
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/subagent.ts` (line 83)
- **Problem:** Sessions stored in `Map` that never gets cleaned up. Completed/failed/killed sessions accumulate forever. Each includes full conversation history → memory leak over days.
- **Fix:** Add TTL (e.g., 1h after completion) with periodic cleanup. ~20 lines.
- **Assigned:** —

### 8. Delegation result caching keyed on full task text
- **Status:** 🔲 Open
- **File:** `packages/core/src/domain/delegation.ts` (line 418)
- **Problem:** Cache key is `${fromAgent}:${toAgent}:${request.task}`. Long tasks = huge keys. Tasks with different `context` arrays get same key → stale results.
- **Fix:** Hash the task text + include context in key. ~10 lines.
- **Assigned:** —

### 9. No body size limit on agent channel
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/agent-channel.ts` (lines 285–298)
- **Problem:** `readBody()` reads all chunks with no size limit. Malicious/buggy remote node could OOM the process.
- **Fix:** Add max body size (e.g., 1MB) and reject with 413. ~5 lines.
- **Assigned:** —

### 10. Workspace file cache never invalidates
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/workspace.ts` (line 36)
- **Problem:** Cache on first read, never invalidates unless `clearCache()` via `/new`. Edits to `CORE.md` etc. during a session are invisible.
- **Fix:** Stat-based invalidation (check mtime) or file watcher. ~20 lines.
- **Assigned:** —

---

## 🟢 Style / Cleanup

### 11. Stale TODO in delegation.ts
- **Status:** 🔲 Open
- **File:** `packages/core/src/domain/delegation.ts` (line 1)
- **Problem:** `// TODO: Support agent-scoped tool filtering` — but `filterToolsForAgent()` already exists.
- **Fix:** Delete the comment. 1 line.
- **Assigned:** —

### 12. Blanket eslint-disable on loop.ts
- **Status:** 🔲 Open
- **File:** `packages/core/src/runtime/loop.ts` (line 1)
- **Problem:** `/* eslint-disable @typescript-eslint/no-unsafe-assignment */` at file scope on the most critical file.
- **Fix:** Narrow to specific lines or fix the underlying type issues.
- **Assigned:** —

### 13. Unnecessary async on sub-agent tool executors
- **Status:** 🔲 Open
- **File:** Sub-agent tool definitions
- **Problem:** 5 tool `execute` functions are `async` but don't `await` anything.
- **Fix:** Remove `async` or make interface allow sync executors.
- **Assigned:** —

### 14. Duplicated `chat()` non-streaming logic across providers
- **Status:** 🔲 Open
- **Files:** All 4 providers (Anthropic, Google, xAI, OpenAI-compat)
- **Problem:** Each implements `chat()` by consuming `chatStream()` identically. Copy-paste.
- **Fix:** Shared base class or utility function. ~30 min.
- **Assigned:** —

---

## Priority Order

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | #1 — Heartbeat freshConversation | 1 line | Fixes active failures |
| P0 | #2 — Token double-counting | 3 lines | Corrects metrics |
| P1 | #7 — Sub-agent session TTL | 20 lines | Memory leak |
| P1 | #9 — Body size limit | 5 lines | Security |
| P1 | #4 — Fallback handler dedup | 30 min | Bug surface |
| P2 | #5 — Use getModel() | 3 lines | Type safety |
| P2 | #10 — Workspace cache invalidation | 20 lines | Correctness |
| P2 | #8 — Delegation cache key | 10 lines | Correctness |
| P3 | #3 — Wire circuit breaker or remove | Medium | Dead code |
| P3 | #6 — Console → logger | Tedious | Consistency |
| P3 | #11–14 — Style cleanup | Small each | Hygiene |
