# Spec: Context Window Management

**Author:** Rivet (Opus)
**Status:** Draft — awaiting Phil's review
**Date:** 2025-04-08

---

## Problem

RivetOS has two blunt instruments for context management, and neither works well:

1. **`maxIterations`** (default: 15, hard cap: `maxIterations × 5`) — caps tool loop iterations per turn. Not token-aware. A model with 100k and a model with 1M hit the same cap. Doesn't prevent context overflow; just limits how many times the model can call tools.

2. **History splice at 200 messages** (`turn-handler.ts:189`) — after each turn, if `session.history` exceeds 200 messages, the oldest are silently dropped. No summarization. Context is just lost.

Neither mechanism knows anything about the actual context window of the model being used. A long coding pipeline turn can blow past Local's 100k window mid-turn with no warning. Meanwhile, 200 messages for a 1M-window model is wastefully conservative.

## Goal

Replace both with a single, model-aware context management system where **the agent manages its own context** — it decides what to keep, what to summarize, and what to discard. The system provides the triggers and the tools; the agent provides the judgment.

---

## Design

### 1. Per-Provider Context Window Config

Add `context_window` and `max_output_tokens` to provider config. These are model properties that the runtime needs to know.

**config.yaml:**
```yaml
providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514
    context_window: 200000      # tokens
    max_output_tokens: 16384    # tokens

  xai:
    api_key: ${XAI_API_KEY}
    model: grok-4
    context_window: 1000000
    max_output_tokens: 131072

  ollama:
    base_url: http://gerty.lan:11434
    model: qwen3:32b
    context_window: 100000
    max_output_tokens: 8192
```

**Provider interface addition:**
```typescript
export interface Provider {
  // ...existing...
  /** Context window size in tokens (0 = unknown/unlimited) */
  getContextWindow(): number
  /** Max output tokens (0 = unknown/unlimited) */
  getMaxOutputTokens(): number
}
```

Each provider plugin reads these from its config and exposes them via the interface. If not set, defaults to `0` (unknown — compaction triggers disabled, only user-message-count trigger applies).

### 2. Token Estimator

A simple, fast estimator. Not billing-accurate — just good enough for compaction decisions.

```typescript
// packages/core/src/domain/tokens.ts

/**
 * Rough token estimate. Uses chars ÷ 4 as baseline.
 * For messages array, includes role overhead (~4 tokens per message).
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += 4  // role + framing overhead
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += Math.ceil(part.text.length / 4)
        } else if (part.type === 'image') {
          total += 1000  // rough image token estimate
        }
      }
    }
    // Tool calls: count argument JSON
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += Math.ceil(JSON.stringify(tc.arguments).length / 4) + 10
      }
    }
  }
  return total
}

export function estimateSystemPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4) + 4
}
```

### 3. Compaction Triggers

Two triggers. Whichever fires first wins.

#### Trigger A: User Message Count

After each turn completes, increment a counter of user messages in the session. When it crosses a threshold, inject a compaction nudge before the next turn.

- **Default threshold:** 47 user messages
- **Configurable per-agent** (a local model might want fewer, a 1M model might want more)
- **Counter resets after compaction**

#### Trigger B: Context Window Percentage

Before each provider call inside `loop.ts`, estimate total tokens (`system prompt + messages array`). If the estimate crosses a threshold percentage of the provider's `context_window`:

| Threshold | Action |
|-----------|--------|
| 40% | **Soft nudge** — inject compaction system message. Agent may compact or skip. Informational — "your context is growing." |
| 70% | **Soft nudge** — inject compaction system message. Agent should seriously consider compacting. Same optional behavior but stronger language. |
| 90% | **Hard nudge** — inject mandatory compaction message. Agent must call `compact_context` before continuing. The loop pauses normal tool execution until compaction completes. |

Each threshold fires once per compaction cycle (resets after compaction). If `context_window` is 0 (unknown), Trigger B is disabled — only Trigger A applies.

### 4. Compaction Nudge Messages

**Soft nudge — 40% (or user message threshold):**
```
[SYSTEM — Context Management]
Heads up: your session context is growing ({estimated_tokens} tokens, {pct}% of {context_window} window, {user_message_count} exchanges).

If there are completed tasks, resolved discussions, or verbose tool output you no longer need, consider using `compact_context` to summarize them. Otherwise, carry on.
```

**Soft nudge — 70%:**
```
[SYSTEM — Context Management]
Your session context is getting heavy ({estimated_tokens} tokens, {pct}% of {context_window} window, {user_message_count} exchanges).

You should review your conversation history and use `compact_context` to replace resolved topics, completed tasks, and stale tool output with brief summaries. Keep anything still actively relevant to the current work.

If everything in context is genuinely still needed, you may skip — but be honest about it.
```

**Hard nudge — 90%:**
```
[SYSTEM — Context Management — REQUIRED]
Your context is at {pct}% capacity ({estimated_tokens} / {context_window} tokens). You must free up space before continuing.

Use `compact_context` to summarize or remove the least critical material. Focus on:
- Completed tasks and their verbose tool output
- Resolved discussion threads
- Exploratory paths that were abandoned

Preserve: active work context, recent decisions, anything referenced in the current task.
```

### 5. The `compact_context` Tool

A new built-in tool (not a plugin tool — part of core, like steer) that the agent calls to rewrite its own history.

```typescript
// Tool definition
{
  name: 'compact_context',
  description: 'Summarize and compact conversation history to free context window space. '
    + 'Provide ranges of messages to replace with summaries.',
  parameters: {
    type: 'object',
    properties: {
      replacements: {
        type: 'array',
        description: 'Message ranges to replace with summaries',
        items: {
          type: 'object',
          properties: {
            start_index: {
              type: 'number',
              description: 'Start index in conversation history (0-based, inclusive)'
            },
            end_index: {
              type: 'number',
              description: 'End index in conversation history (0-based, inclusive)'
            },
            summary: {
              type: 'string',
              description: 'Brief summary replacing these messages. '
                + 'Include key decisions, outcomes, and any information still relevant.'
            }
          },
          required: ['start_index', 'end_index', 'summary']
        }
      }
    },
    required: ['replacements']
  }
}
```

**Execution logic:**

1. Validate ranges (no overlaps, valid indices)
2. Sort replacements by `start_index` descending (process from end to avoid index shifting)
3. For each replacement:
   - Remove `history[start_index..end_index]`
   - Insert a single system message: `[Compacted Context] {summary}`
4. Update the session's compaction counter
5. Return: `"Compacted {n} messages into {r} summaries. Context: {before_tokens} → {after_tokens} tokens ({pct_saved}% freed)"`

**What the agent sees:**

Before calling `compact_context`, the agent needs to know what's in its history. It already sees its full history as part of the messages array — that's the context it's reading from. The indices correspond to `session.history` positions. The nudge message can include a brief index:

```
Messages 0-15: [Session init, workspace loading, initial discussion about X]
Messages 16-42: [Coding pipeline: built feature Y, 12 tool calls]
Messages 43-58: [Debugging Z, resolved]
Messages 59-67: [Current topic: context window management spec]
```

This summary index is generated by the turn handler when injecting the nudge — a quick scan of the history producing one-line descriptions per logical chunk.

### 6. What Gets Removed

#### Remove: `maxIterations`

- **`AgentLoopConfig.maxIterations`** — removed
- **`hardCap = maxIterations * 5`** — removed
- **Progress heartbeat** (`iterations % maxIterations`) — replaced with time-based: emit "⏳ Still working..." every 147 seconds of wall-clock time during a turn, including trigger count (how many times the heartbeat has fired this turn)
- **Safety cap reached** response — replaced by turn timeout (see below)

#### Remove: History Splice

- `turn-handler.ts:189-191` (`if (session.history.length > 200) { splice... }`) — removed entirely
- History grows unbounded until compaction triggers fire

#### Remove: `config.runtime.max_tool_iterations`

- From `RuntimeConfig`, `TurnHandlerDeps`, `RuntimeSection`, `AgentLoopConfig`
- From `config.yaml` schema
- From boot index wiring

#### Remove: `/context` File-Pinning Subcommands

- `/context add`, `/context remove`, `/context list`, `/context clear` — all removed
- File-pinning logic in `commands.ts` — removed
- Any pinned file tracking on `SessionState` — removed
- `/context` becomes a single command that shows context stats (no subcommands)

### 7. Turn Timeout (Replaces `maxIterations` Hard Cap)

A wall-clock timeout per turn prevents infinite tool loops.

**Config:**
```yaml
runtime:
  turn_timeout: 600  # seconds (default: 600 = 10 minutes)
```

**Implementation in `loop.ts`:**
```typescript
const turnStart = Date.now()
const turnTimeout = config.turnTimeout ?? 600_000  // 10 min default

while (true) {  // no more iteration cap
  if (Date.now() - turnStart > turnTimeout) {
    this.emit({ type: 'status', content: `⚠️ Turn timeout (${turnTimeout / 1000}s)` })
    return {
      response: partialResponse
        ? partialResponse.trim() + '\n\n⚠️ _Turn timed out. Let me know if you want me to continue._'
        : '⚠️ _Turn timed out. Let me know if you want me to continue._',
      toolsUsed, iterations, aborted: false, usage: totalUsage, hadSteer,
    }
  }
  // ...existing loop body...
}
```

**Progress heartbeat:** Instead of every N iterations, emit "⏳ Still working..." every 147 seconds, including a trigger count so the user can see how many heartbeats have fired:

```typescript
let heartbeatCount = 0

// Inside the loop:
if (Date.now() - lastProgressEmit > 147_000) {
  heartbeatCount++
  this.emit({
    type: 'status',
    content: `⏳ Still working... (${iterations} tool calls, ${Math.floor((Date.now() - turnStart) / 1000)}s, heartbeat #${heartbeatCount})`,
  })
  lastProgressEmit = Date.now()
}
```

### 8. Integration Points

#### Where Compaction Triggers Run

**Trigger A (user message count):**
- In `turn-handler.ts`, after updating history (line 184-191 area)
- Increment `session.userMessageCount`
- If threshold crossed, set `session.compactionNeeded = 'nudge'`
- On the *next* turn's loop construction, inject the nudge into the system prompt or as a prepended system message

**Trigger B (context window %):**
- In `loop.ts`, at the top of the `while` loop, before calling `provider.chatStream()`
- Estimate tokens for `messages` array
- Get `contextWindow` from the provider (passed via `AgentLoopConfig`)
- If 90%+ → inject hard nudge, mark `compactionRequired = true`
- If 70%+ (and not already nudged at this tier) → inject soft nudge (stronger)
- If 40%+ (and not already nudged at this tier) → inject soft nudge (informational)
- If `compactionRequired` and the model responds without calling `compact_context`, re-inject the hard nudge (up to 3 times, then auto-compact oldest 50% as fallback)

#### Where `compact_context` Executes

- Registered as a built-in tool in the loop (like steer is built-in to the loop)
- When called, directly mutates `session.history` (which the loop's `messages` was built from)
- After execution, the loop rebuilds its `messages` array from the updated history and continues

#### `/context` Command Overhaul

The existing `/context` command has file-pinning subcommands that were built as user-facing tools but were really intended as agent-internal utilities:

```
/context add <file>    — pin a file
/context remove <file> — unpin
/context list          — show pinned files
/context clear         — unpin all
```

**Remove all of these.** File pinning, if needed in the future, should be a tool the agent calls internally — not a user-facing slash command.

**Replace `/context` with a single stats command** — no subcommands needed:

```
/context
```

Output:
```
📊 Context Stats
- History: 142 messages (68 user, 74 assistant)
- Estimated tokens: ~45,200
- Context window: 200,000 (anthropic)
- Usage: 22.6%
- Compactions: 2
- User messages since last compaction: 31 / 47
- Next nudge: 40% window (soft) at ~80,000 tokens
```

The existing `/context` command handler, its subcommand routing, and all file-pinning logic in `commands.ts` should be replaced with this single stats readout. Any related types (e.g., pinned file tracking on session state) should also be cleaned up.

### 9. Session State Changes

```typescript
export interface SessionState {
  id: string
  thinking: ThinkingLevel
  reasoningVisible: boolean
  toolsVisible: boolean
  history: Message[]
  systemPrompt?: string

  // New fields:
  /** Count of user messages since last compaction (or session start) */
  userMessageCount: number
  /** Number of compactions performed in this session */
  compactionCount: number
  /** Whether a compaction nudge is pending for the next turn */
  compactionPending?: 'soft' | 'hard' | undefined
  /** Which nudge tiers have fired this compaction cycle (reset after compaction) */
  nudgesFired?: Set<40 | 70 | 90>
}
```

### 10. Config Shape

```yaml
runtime:
  # Removed: max_tool_iterations
  turn_timeout: 600  # seconds, default 600

  context:
    # Trigger A: user message count threshold
    compact_after_messages: 47   # default 47, per-agent override possible
    # Trigger B: context window percentage thresholds  
    soft_nudge_pct: [40, 70]     # soft nudges at 40% and 70%
    hard_nudge_pct: 90           # mandatory compaction at 90%

providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514
    context_window: 200000
    max_output_tokens: 16384

  xai:
    api_key: ${XAI_API_KEY}
    model: grok-4
    context_window: 1000000
    max_output_tokens: 131072

  ollama:
    base_url: http://gerty.lan:11434
    model: qwen3:32b
    context_window: 100000
    max_output_tokens: 8192
```

Per-agent override:
```yaml
agents:
  local:
    provider: ollama
    local: true
    context:
      compact_after_messages: 25  # smaller window, compact sooner
```

---

## Implementation Plan

### Phase 1: Foundation
1. Add `context_window` and `max_output_tokens` to provider interface + all provider plugins
2. Add `estimateTokens()` utility
3. Add new fields to `SessionState`
4. Remove `/context` file-pinning subcommands, replace with single `/context` stats command

### Phase 2: Compaction Tool
5. Build `compact_context` as a built-in tool in the loop
6. Wire it to mutate `session.history`

### Phase 3: Triggers
7. Implement Trigger A (user message count) in turn handler
8. Implement Trigger B (context window %) in loop
9. Add nudge/force message injection

### Phase 4: Cleanup
10. Remove `maxIterations` from loop, config, types, boot
11. Remove history splice from turn handler
12. Replace with turn timeout + wall-clock progress heartbeat

### Phase 5: Config
13. Add `runtime.context` config section
14. Add `runtime.turn_timeout` config
15. Add per-agent context overrides
16. Update config validation

---

## Open Questions

1. **Should compaction summaries be stored in memory (postgres)?** Right now memory gets the raw messages. After compaction, the session history has `[Compacted Context]` summaries. Should we also write a compaction event to memory so the memory system knows context was compressed?

2. **Sub-agent / delegation context:** When Opus delegates to Grok, the sub-agent gets its own fresh context. Does the sub-agent need its own compaction, or are delegated tasks short enough that it doesn't matter?

3. **Heartbeat turns:** Heartbeats create one-shot loops with empty history. They don't need compaction. Should they be explicitly excluded, or does the threshold naturally handle it (they'll never hit 47 user messages)?

4. **Image tokens:** The rough estimate of 1000 tokens per image is... rough. Anthropic charges ~1600 tokens for a 1024×1024 image. Worth using a more accurate estimate based on image dimensions, or is rough good enough for compaction triggers?
