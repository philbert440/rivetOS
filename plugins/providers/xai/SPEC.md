# xAI Provider Overhaul — Full Specification

**Author:** Rivet (Opus)  
**Date:** 2026-04-14  
**Status:** Ready for implementation  
**Provider path:** `plugins/providers/xai/src/index.ts`

---

## 1. Goal

Rewrite the xAI provider to be a **first-class, fully native implementation** of the xAI Responses API (`/v1/responses`). No OpenAI compatibility shims, no copy-paste artifacts. Every feature documented at `docs.x.ai` that can be leveraged from our agent loop should be supported.

---

## 2. Current State (PR #67 baseline)

The provider (~547 lines) already handles:
- ✅ Native Responses API endpoint (`/v1/responses`)
- ✅ `input_text` / `input_image` content blocks
- ✅ Function calling (client-side tools)
- ✅ Stateful conversations via `previous_response_id` + `store`
- ✅ Encrypted reasoning passthrough (`reasoning.encrypted_content`)
- ✅ Image detection → `store: false`
- ✅ Abort signal wiring
- ✅ 1-hour timeout for reasoning models
- ✅ Basic SSE streaming (text, reasoning, function_call events)
- ✅ `freshConversation` support for delegation isolation
- ✅ `web_search` built-in tool (hardcoded, no filters)

---

## 3. What's Missing (the work)

### 3.1 Config Options

Extend `XAIProviderConfig` with:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `reasoningEffort` | `'low' \| 'medium' \| 'high'` | undefined | Maps to `reasoning.effort` in request body. Supported by all current models (grok-4.20 and grok-4-1-fast families). |
| `webSearch` | `boolean \| WebSearchConfig` | `false` | Enable native web search. `true` = default config. Object = with filters. |
| `xSearch` | `boolean \| XSearchConfig` | `false` | Enable native X search. `true` = default config. Object = with filters. |
| `codeExecution` | `boolean` | `false` | Enable server-side code interpreter. |
| `maxTurns` | `number` | undefined | Limits server-side agentic turns per request. See 3.7 for how this interacts with client-side tools. |
| `toolChoice` | `'auto' \| 'required' \| 'none' \| { type: 'function'; function: { name: string } }` | undefined (API default = 'auto') | Control when model uses tools. |
| `parallelToolCalls` | `boolean` | undefined (API default = true) | Whether model can request multiple tool calls in one response. |
| `truncation` | `'auto' \| 'disabled'` | undefined | Server-side context truncation. |
| `instructions` | `string` | undefined | Developer instructions (separate from system prompt, persisted server-side). |

#### WebSearchConfig
```typescript
interface WebSearchConfig {
  allowedDomains?: string[]     // max 5
  excludedDomains?: string[]    // max 5 (mutually exclusive with allowedDomains)
  enableImageUnderstanding?: boolean
}
```

#### XSearchConfig
```typescript
interface XSearchConfig {
  allowedXHandles?: string[]    // max 10
  excludedXHandles?: string[]   // max 10 (mutually exclusive with allowedXHandles)
  fromDate?: string             // ISO8601 "YYYY-MM-DD"
  toDate?: string               // ISO8601 "YYYY-MM-DD"
  enableImageUnderstanding?: boolean
  enableVideoUnderstanding?: boolean
}
```

### 3.2 Request Body Construction

The `chatStream` method must build the request body with:

```typescript
{
  model,
  input,
  stream: true,
  store: boolean,                          // existing
  include: ['reasoning.encrypted_content'], // existing — see 3.9 for additions
  previous_response_id?: string,           // existing
  
  // NEW fields:
  tools: [                                 // mixed built-in + function tools
    { type: 'web_search', filters?: {...}, enable_image_understanding?: boolean },
    { type: 'x_search', allowed_x_handles?: [...], from_date?: '...', ... },
    { type: 'code_interpreter' },
    ...convertedFunctionTools
  ],
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function', function: { name: string } },
  parallel_tool_calls?: boolean,
  max_turns?: number,
  max_output_tokens?: number,              // from config.maxOutputTokens if > 0
  temperature?: number,                    // existing
  reasoning?: { effort: 'low' | 'medium' | 'high' },  // if configured and model supports it
  truncation?: 'auto' | 'disabled',
  instructions?: string,
}
```

**Note:** Our own search tool was renamed from `web_search` to `internet_search` to avoid collision with xAI's built-in `web_search` tool. They are now clearly distinct — `internet_search` is our client-side function call (Google CSE / DuckDuckGo); `web_search` is xAI's server-side built-in tool.

**Built-in tool injection:** Only inject built-in tools that are explicitly configured in `XAIProviderConfig`. Never inject them based on what's in `options.tools`. Our agent's `internet_search` tool goes through as a function call; xAI's native `web_search` is a separate, server-side capability enabled via config.

### 3.3 Server-Side Tool Event Handling

The SSE stream includes events for server-side tools that are NOT function calls. These appear as `response.output_item.added` with item types:

| Item type | Responses API output type | Description |
|-----------|--------------------------|-------------|
| `web_search_call` | `web_search_call` | Server-side web search executing |
| `x_search_call` | `x_search_call` | Server-side X search executing |
| `code_interpreter_call` | `code_interpreter_call` | Server-side code execution |
| `file_search_call` | `file_search_call` | Collections search |
| `mcp_call` | `mcp_call` | Remote MCP tool |

**These do NOT require client-side handling.** The server executes them and returns results internally.

Per xAI docs, the server-side tool function names expand beyond the simple type:
- `web_search` → actual function names: `web_search`, `web_search_with_snippets`, `browse_page`
- `x_search` → actual function names: `x_user_search`, `x_keyword_search`, `x_semantic_search`, `x_thread_fetch`
- `code_interpreter` → `code_execution`

The `item.name` and `item.arguments` fields on these events show what the model is actually doing.

**Implementation:** Emit a new `status` chunk type for real-time observability (see 3.4). Also log at debug level.

For the SSE parser, the key distinction is:
- `response.output_item.added` with `item.type === 'function_call'` → yield tool_call_start (existing, correct)
- `response.output_item.added` with `item.type === 'web_search_call' | 'x_search_call' | ...` → yield `status` chunk, do NOT yield tool_call_start

### 3.4 New LLMChunk Type: `status`

Add a `status` chunk type to LLMChunk to surface server-side tool activity:

```typescript
// In LLMChunk type union:
| 'status'

// Emitted as:
yield { type: 'status', delta: 'web_search: searching...' }
yield { type: 'status', delta: 'x_search: x_keyword_search("xAI latest updates")' }
yield { type: 'status', delta: 'code_interpreter: running code...' }
```

The agent loop and platform layers can choose how to surface this — typing indicators, ephemeral messages, or just ignore it. The important thing is the data is in the stream.

**Format:** `{tool_type}: {name}({arguments_summary})` — keep it human-readable.

The `item.status` field on `response.output_item.done` events shows the final status (`completed`, `failed`, `in_progress`). We should emit a status chunk for completion too:

```typescript
yield { type: 'status', delta: 'web_search: completed' }
```

### 3.5 Usage Tracking — Full Detail

The `response.completed` / `response.done` event includes:

```json
{
  "response": {
    "id": "resp_...",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "completion_tokens_details": {
        "reasoning_tokens": 200
      },
      "prompt_tokens_details": {
        "cached_tokens": 800
      }
    }
  }
}
```

Map to our `LLMUsage` type:

```typescript
usage.promptTokens = resp.usage.input_tokens
usage.completionTokens = resp.usage.output_tokens
usage.reasoningTokens = resp.usage.completion_tokens_details?.reasoning_tokens
usage.cachedTokens = resp.usage.prompt_tokens_details?.cached_tokens
```

The `LLMUsage` type already has optional `reasoningTokens` and `cachedTokens` fields. Just need to populate them.

**Additional per-docs fields available but NOT exposed in our types (future):**
- `prompt_image_tokens` — tokens from visual content (separate from text tokens)

### 3.6 Citations Support

When built-in search tools are used, the response includes:

1. **`response.citations`** — Array of URLs (all sources encountered). Always returned by default. Includes sources the agent examined but didn't reference in the answer.
2. **Inline citations** — `[[N]](url)` markdown in the text output. **Returned by default** in the Responses API. Numbering starts at 1, sequential. Same source reuses original number.
3. **Structured annotations** — On `output_text` content blocks in the response: `{ type: 'url_citation', url, start_index, end_index, title }`. These are positional references into the text content.

**Implementation:**
- **Inline citations:** Flow through naturally in `response.output_text.delta` events. They appear in the text we yield. **No special handling needed** — they flow through as text. Works great in Discord/Telegram.
- **`response.citations` array:** Available on the final `response.completed` event. Include on the `done` chunk. Add `citations?: string[]` to `LLMChunk` for the `done` type.
- **Structured annotations:** Available in `response.output_item.done` events for `message` items. Not parsing these for now — inline citations are sufficient.
- **Disabling inline citations:** If we ever need to, pass `'no_inline_citations'` in the `include` array.

### 3.7 `max_turns` and Client-Side Tool Interaction

Per xAI docs, `max_turns` only limits **server-side** assistant/tool-call turns within a single request. When the model calls a client-side tool (function_call), execution pauses and returns to us. The next follow-up request starts with a **fresh** `max_turns` count.

This means for our agent loop:
- `max_turns` controls how many rounds of web_search/x_search/code_interpreter the model does per request
- Our function calling loop is separate and not affected by `max_turns`
- Setting `max_turns` too low (1-2) means quick lookups; too high (10+) means deep research but longer latency and higher cost

**Recommended defaults by use case:**
| Use Case | max_turns | Tradeoff |
|----------|-----------|----------|
| Quick lookups | 1-2 | Fastest, may miss deeper insights |
| Balanced research | 3-5 | Good balance of speed and thoroughness |
| Deep research | 10+ or unset | Most comprehensive, longer latency |

### 3.8 Accessing Server-Side Tool Outputs

By default, server-side tool call outputs (the actual search results, code output) are NOT returned in the response. They can be large. To receive them, add to the `include` array:

| Tool | Include value |
|------|--------------|
| web_search | `'web_search_call.action.sources'` |
| code_interpreter | `'code_interpreter_call.outputs'` |
| file_search | `'file_search_call.results'` |

**Decision:** Don't include these by default — they can be massive. Can be enabled later via config if we need to inspect/log what the model found.

### 3.9 `include` Array Construction

Current: `['reasoning.encrypted_content']`

Should be dynamic based on config:
- **Always include:** `'reasoning.encrypted_content'` (for stateful continuity)
- **Optional (config-driven):**
  - `'verbose_streaming'` — shows reasoning token count during stream. Useful for UX but burns more bandwidth.
  - `'no_inline_citations'` — suppress inline citations (default: keep them enabled)
  - `'web_search_call.action.sources'` — get raw web search results
  - `'code_interpreter_call.outputs'` — get code execution output

**Decision:** Always include `'reasoning.encrypted_content'`. No other includes needed for now. The `include` array building logic should be easily extensible.

### 3.10 ThinkingLevel → reasoning.effort Mapping

Our `ChatOptions.thinking` uses `ThinkingLevel = 'off' | 'low' | 'medium' | 'high'`.

xAI `reasoning.effort` accepts `'low' | 'medium' | 'high'`.

Mapping:
- `'off'` → omit `reasoning` from request body entirely  
- `'low'` / `'medium'` / `'high'` → `{ reasoning: { effort: level } }`

Config-level `reasoningEffort` is the default. `ChatOptions.thinking` overrides per-request.

**Model gating:** grok-4.20 and grok-4-1-fast support `reasoning.effort`. Plain grok-4 does NOT — it errors with a 400 if you send it. The provider must check the model name and omit `reasoning.effort` for grok-4.

### 3.11 Conversation State Management

Current implementation is correct but can be improved:

1. **Reset on image requests:** Currently `store: false` when images present. Correct per docs.
2. **Reset on freshConversation:** Currently skips `previous_response_id`. Correct.
3. **NEW: Reset when model changes.** If `options.modelOverride` differs from the model used for the stored `lastResponseId`, we must NOT use `previous_response_id` — the server-side conversation was with a different model.
4. **NEW: Handle store failure gracefully.** If a request fails, don't corrupt `lastResponseId`. Only update on successful completion (`response.completed`), not on `response.created`.
5. **NEW: Handle `response.failed` event.** Don't save response ID on failure.

Add a `lastResponseModel: string | null` field to track which model the stored conversation belongs to.

### 3.12 Error Handling Improvements

1. **Rate limiting:** xAI returns 429. Already handled by `ProviderError` with `RETRYABLE_STATUS_CODES`.
2. **Usage guideline violations:** xAI returns specific error codes for content policy. Surface these as non-retryable `ProviderError`.
3. **Store failure:** If an image request fails with a store-related error, ensure we retry with `store: false`.
4. **SSE error events:** Handle `type: 'error'` events in the SSE stream — surface as `LLMChunk { type: 'error' }`.
5. **`response.incomplete` event:** Handle truncation — model hit limits. Yield done with whatever we have.

### 3.13 ResponsesEvent Type — Full Shape

Expand the `ResponsesEvent` interface to capture all fields we might see:

```typescript
interface ResponsesEvent {
  type?: string
  // output_item.added / output_item.done
  item?: {
    type?: string           // 'function_call' | 'web_search_call' | 'x_search_call' | 'code_interpreter_call' | 'file_search_call' | 'mcp_call' | 'message'
    call_id?: string
    id?: string
    name?: string
    arguments?: string      // for function_call items, full args in non-streaming
    status?: string         // 'completed' | 'failed' | 'in_progress'
    content?: Array<{
      type?: string         // 'output_text'
      text?: string
      annotations?: Array<{
        type?: string       // 'url_citation'
        url?: string
        start_index?: number
        end_index?: number
        title?: string
      }>
    }>
  }
  // function_call_arguments.delta / .done
  call_id?: string
  item_id?: string
  delta?: string
  // response.completed / response.done / response.created
  response?: {
    id?: string
    status?: string         // 'completed' | 'failed' | 'incomplete'
    usage?: {
      input_tokens?: number
      output_tokens?: number
      completion_tokens_details?: {
        reasoning_tokens?: number
      }
      prompt_tokens_details?: {
        cached_tokens?: number
      }
    }
    citations?: string[]
  }
  // error events
  error?: {
    message?: string
    type?: string
    code?: string
  }
}
```

### 3.14 Mixed Server-Side + Client-Side Tool Loop

Per xAI docs, when both server-side tools (web_search, x_search, code_interpreter) and client-side tools (our function calls) are in the `tools` array, xAI handles them differently:

1. **Server-side tools execute automatically** — xAI runs them on their servers, feeds results back to the model internally
2. **Client-side tools pause execution** — xAI returns `function_call` output items to us, we execute them, and send results back via `function_call_output`

Our existing agent loop already handles #2 correctly. The new server-side tools just work silently. The critical thing is that **we don't try to execute server-side tool calls** — we only execute `function_call` type items.

When sending function call results back:
- Use `previous_response_id` to continue from where the model paused
- The `max_turns` counter **resets** on each new request after a client-side tool call

---

## 4. Implementation Plan

### Phase 1: Types & Config (no behavior change)

1. Add `status` to `LLMChunk` type union + `citations?: string[]` to LLMChunk
2. Extend `XAIProviderConfig` with all new fields (section 3.1)
3. Add `WebSearchConfig` and `XSearchConfig` interfaces

### Phase 2: Request Body Construction

4. Build request body dynamically (section 3.2)
5. Fix built-in tool injection logic — only inject what's configured, not hardcoded
6. Add `reasoning.effort` mapping (section 3.10) — no model gating needed, all supported models accept it
7. Add `max_output_tokens`, `tool_choice`, `parallel_tool_calls`, `max_turns`, `truncation`, `instructions` to request body when configured
8. Make `include` array dynamic (section 3.9)

### Phase 3: SSE Parser Improvements

9. Expand `ResponsesEvent` type (section 3.13)
10. Handle server-side tool events — emit `status` chunks (section 3.3, 3.4)
11. Handle `response.output_item.done` for server-side tools (completion status)
12. Parse full usage details including `reasoningTokens` and `cachedTokens` (section 3.5)
13. Parse `response.citations` and include on `done` chunk (section 3.6)
14. Handle `response.failed` and `response.incomplete` events (section 3.12)
15. Handle SSE `error` events

### Phase 4: Conversation State

16. Track `lastResponseModel` — reset state on model change (section 3.11)
17. Only update `lastResponseId` on successful `response.completed`
18. Don't save response ID from `response.created` (wait for completion)

### Phase 5: Polish

19. Clean up types — remove any remaining OpenAI naming artifacts
20. Add JSDoc comments for all config options
21. Update `chat()` non-streaming method to handle new chunk types (`status`, `citations`)
22. Test all scenarios

---

## 5. What We're NOT Doing (and why)

| Feature | Reason |
|---------|--------|
| Structured outputs (`response_format`) | Agent loop uses function calling; no use case yet. Easy to add later. |
| Collections search / file_search | We don't upload files to xAI; our tools handle files locally |
| Remote MCP | We have our own tool system; no need for xAI's MCP passthrough |
| `verbose_streaming` | Extra bandwidth for marginal gain; can add via include array later |
| Server-side tool output inclusion | Raw search results / code output can be huge. Available via include array if needed. |
| Batch API | Different endpoint, different use case; not relevant for real-time agent loop |
| Voice API | Completely separate capability; would be a new provider |
| Structured annotations parsing | Inline citations in text are sufficient; structured position data is future |

---

## 6. xAI API Reference Summary

### Endpoint
`POST /v1/responses`

### Request Body Fields
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | ✅ | e.g., `grok-4.20-reasoning`, `grok-4`, `grok-4-1-fast-reasoning` |
| `input` | array | ✅ | Messages + function_call_outputs |
| `stream` | boolean | | Default: false |
| `store` | boolean | | Default: true. Force false for images. 30-day retention. |
| `previous_response_id` | string | | Continue from server-stored conversation |
| `include` | string[] | | `reasoning.encrypted_content`, `no_inline_citations`, `verbose_streaming`, etc. |
| `tools` | array | | Mixed built-in + function tools |
| `tool_choice` | string \| object | | `auto`, `required`, `none`, or specific function |
| `parallel_tool_calls` | boolean | | Default: true |
| `max_turns` | number | | Limits server-side agentic turns. Resets on client-side tool calls. |
| `max_output_tokens` | number | | Limit output length |
| `temperature` | number | | Not supported by reasoning models |
| `reasoning` | object | | `{ effort: 'low' \| 'medium' \| 'high' }`. Supported by grok-4.20 and grok-4-1-fast. NOT supported by grok-4. |
| `truncation` | string | | `auto` or `disabled` |
| `instructions` | string | | Developer instructions |
| `response_format` | object | | Structured output (NOT implementing) |

### SSE Event Types
| Event | When |
|-------|------|
| `response.created` | Request accepted, response object created |
| `response.output_item.added` | New output item started (function_call, web_search_call, message, etc.) |
| `response.output_text.delta` | Text content chunk |
| `response.reasoning.delta` | Reasoning/thinking chunk |
| `response.function_call_arguments.delta` | Function call args streaming |
| `response.function_call_arguments.done` | Function call args complete |
| `response.output_item.done` | Output item finished — has `item.status` (completed/failed) |
| `response.completed` | Full response complete — has usage, citations |
| `response.done` | Alias for completed (seen in some responses) |
| `response.failed` | Request failed mid-stream |
| `response.incomplete` | Response truncated (hit limits) |
| `error` | SSE error event |

### Server-Side Tool Function Names
| Tool Category | Actual Function Names | Billing Category |
|--------------|----------------------|-----------------|
| web_search | `web_search`, `web_search_with_snippets`, `browse_page` | `SERVER_SIDE_TOOL_WEB_SEARCH` |
| x_search | `x_user_search`, `x_keyword_search`, `x_semantic_search`, `x_thread_fetch` | `SERVER_SIDE_TOOL_X_SEARCH` |
| code_interpreter | `code_execution` | `SERVER_SIDE_TOOL_CODE_EXECUTION` |

**Billing note:** Only successful tool executions are billed. Failed attempts are not charged.

### Supported Models

Supported models: grok-4.20, grok-4, and grok-4-1-fast (reasoning variants only). All deprecated models (grok-3, grok-3-mini) are no longer supported.

| Model | Context | reasoning.effort | Pricing (in/out per M) | Notes |
|-------|---------|-----------------|----------------------|-------|
| `grok-4.20-0309-reasoning` | 2M | ✅ | $2.00 / $6.00 | Flagship. Fast + agentic. Alias: `grok-4.20-reasoning`. |
| `grok-4` | 256K | ❌ (errors!) | deprecated pricing | Deep reasoning. Slower. No reasoning.effort support. |
| `grok-4-1-fast-reasoning` | — | ✅ | $0.20 / $0.50 | Fast + cheap. 10x cheaper than 4.20. Good for compaction/fallback. |

**Default model:** `grok-4.20-reasoning` (alias for latest dated version)

---

## 7. Testing Checklist

- [ ] Basic text generation (no tools)
- [ ] Function calling (single tool)
- [ ] Function calling (parallel tools)
- [ ] Native web_search (built-in, server-side)
- [ ] Native x_search (built-in, server-side)  
- [ ] web_search with filters (allowed_domains)
- [ ] x_search with filters (handle filtering, date range)
- [ ] Code interpreter (built-in)
- [ ] Mixed built-in + function calling (server-side executes, client-side pauses)
- [ ] Image input → store: false
- [ ] Conversation continuity (previous_response_id)
- [ ] freshConversation isolation
- [ ] Model switch → conversation state reset
- [ ] reasoning.effort with grok-4.20 (should work)
- [ ] reasoning.effort with grok-4-1-fast (should work)
- [ ] Abort signal
- [ ] Usage tracking (input, output, reasoning, cached tokens)
- [ ] Error handling (429, 400, 500)
- [ ] Inline citations in text output
- [ ] Citations array on done chunk
- [ ] Status chunks for server-side tool calls
- [ ] Status chunks for server-side tool completion
- [ ] tool_choice (auto, required, none)
- [ ] max_turns limiting server-side iterations
- [ ] max_output_tokens
- [ ] response.failed event handling
- [ ] response.incomplete event handling

---

## 8. File Changes

| File | Change |
|------|--------|
| `plugins/providers/xai/src/index.ts` | Full rewrite per this spec |
| `packages/types/src/provider.ts` | Add `status` to LLMChunk type union, add `citations?: string[]` to LLMChunk |
| Agent configs (`*.yaml`) | Can add new config fields (webSearch, xSearch, etc.) — optional, not required for this PR |
