# Provider goldens (TypeScript → Rust parity)

What the six TypeScript HTTP providers at rivetOS `origin/main` `c72e851f` send and produce for one agent turn, recorded by
`/rivet-shared/plans/rust-rewrite/tools/provider-goldens.mjs`. Every request went to a local fake server on 127.0.0.1. The
harness also replaces `globalThis.fetch` with a guard that rejects any other host, so no real provider endpoint was called.

## Regenerate

```
cd /home/rivet/work/w-rust        # built checkout of origin/main, npm deps installed
node /rivet-shared/plans/rust-rewrite/tools/provider-goldens.mjs
```

Optional env: `GOLDEN_OUT` (output dir), `GOLDEN_ONLY` (comma-separated provider ids), `RIVETOS_REPO` (default cwd),
`GOLDEN_BASE_PORT` (default 47811; anthropic 47811, xai 47812, google 47813, vllm 47814, llama-server 47815, ollama 47816).
Two consecutive full runs and a subset run produced byte-identical trees. The harness exits non-zero when a run throws,
aborts, or sees a request count other than the scenario expects. It never writes to the repo; `git status` stays clean.

## How a turn is driven

The provider is built the way boot's plugin registrar builds it: `manifest.register(ctx)` from
`plugins/providers/<id>/dist/index.js`, with a minimal registration ctx (`env: {}`, `pluginConfig` = the config slice below,
`registerProvider` capturing the instance). Each scenario gets a fresh instance; the probe gets its own.

| provider | config slice (YAML keys) | base URL handling |
|---|---|---|
| anthropic | `model: test-model`, `api_key` | No `base_url` key exists for anthropic. After `register`, the harness sets `provider.baseUrl = http://127.0.0.1:47811` (the `AnthropicProvider` constructor option, read at request time). |
| xai | `model`, `api_key`, `base_url: http://127.0.0.1:47812/v1` | `base_url` passes validation but `manifest.register` drops it, so the harness sets `provider.baseUrl` the same way. |
| google | `model`, `api_key` | No `base_url` key. Harness sets `provider.baseUrl = http://127.0.0.1:47813/v1beta`. |
| vllm | `model`, `api_key`, `base_url: http://127.0.0.1:47814` | Honoured by the manifest. |
| llama-server | `model`, `api_key`, `base_url: http://127.0.0.1:47815` | Honoured. |
| ollama | `model`, `base_url: http://127.0.0.1:47816` | Honoured. Ollama has no API key. |

The turn runs through `AgentLoop` from `packages/core/dist/domain/loop.js` with the fields the runtime's turn handler
passes: system prompt `You are a test.`, history `[]`, user message `Say hi.`, tools `[echo]`, `thinking` = the agent's
`default_thinking`, `agentId: test-agent`, `sessionId: test-session` (xAI sends it as `x-grok-conv-id`; without a session
id it would be a random UUID), `contextWindow` from the provider, an abort signal, and `hooks: new HookPipelineImpl()`.
The runtime always wires a hook pipeline, so the model goes through `wrapLanguageModel` and the hook middleware as in
production. A check run with `hooks: undefined` produced byte-identical requests, events, chunks and parts. `modelOverride`
is unset (an agent without `model:`), `maxSteps` and `turnTimeout` are the defaults (50 steps, 1 800 000 ms).

The `echo` tool's parameters are `{"type":"object","properties":{"text":{"type":"string",…},"n":{"type":"number",…}},"required":["text"]}`
and `execute` returns `JSON.stringify(args)`. `input.json` in every scenario directory holds the exact inputs.

LLM chunks and AI SDK `fullStream` parts are captured inside the real loop. The dist is CommonJS: `loop.js` calls
`aisdk_1.translateAiSdkPart` through a live getter that reads `packages/aisdk/dist/stream.js`'s exports, so the harness
replaces that one export in its own process with a wrapper that records the part and the returned chunks and returns them
unchanged. The harness checks that the loop resolves `@rivetos/aisdk` to the patched module before running. AI SDK warnings
are taken through the SDK's own `globalThis.AI_SDK_LOG_WARNINGS` hook (its default printing happens once per process,
which would make the recordings depend on run order).

## Scenarios

| directory | `default_thinking` | chat requests | canned model behaviour |
|---|---|---|---|
| `probe` | n/a | 1 | `isAvailable()` only |
| `A-text` | medium (runtime default) | 1 | Text `Hi there!` in two deltas; usage 25 in (10 cached) / 5 out |
| `B-tool` | medium | 2 | Request 1: `echo` with arguments `{"text":"hi","n":1.0}`. Request 2, after the tool result: `The echo tool returned hi.` |
| `C-reasoning` | high | 1 | Reasoning `The user wants a greeting. Keep it short.`, then `Hi!`; 22 reasoning tokens where the wire reports them |
| `D-thinking-off` | off | 1 | Same bytes as A; records the thinking-off request shape |
| `E-reasoning-tool` | medium | 2 | Request 1: reasoning `I should call the echo tool.` then the echo call. Request 2 shows how each wire replays reasoning, then text |

D and E go beyond the requested A to C. They cost nothing in the harness and pin request-shape differences the Rust clients
must reproduce: the thinking-off variants, and reasoning or signature replay inside a tool loop.

## Files

Per `<provider>/<scenario>/`:

- `requests.json`: every request the fake server received, in arrival order. Fields: `index`, `method`, `target` (raw
  request-target), `path`, `query` and `headers` as ordered `[name, value]` pairs exactly as received (original case),
  `body` (raw text), and `served` (`status`, the headers the server set explicitly, `bodyFile`). Node adds
  `Connection`, `Keep-Alive` and `Transfer-Encoding: chunked` on its own; those appear in `parts.json` response headers.
- `response-<n>.txt`: the exact bytes served for request `n`.
- `events.json`: every `StreamEvent` the loop emitted through `onStream`, in order.
- `chunks.json`: every `LLMChunk` that `translateAiSdkPart` returned inside the loop, flattened in order. The loop never
  builds a `done` chunk; its usage comes from the accumulator (see `result.json`).
- `parts.json`: every AI SDK `fullStream` part the loop passed to `translateAiSdkPart`, JSON-serialised (Dates as ISO
  strings, Errors as `{name, message}`). It holds `start-step.request.body`, and per step the finish reason, usage,
  provider metadata and response metadata.
- `result.json`: `turnResult` (what `AgentLoop.run` returned), `toolCalls` and `toolResults` (from the tool parts),
  `chunkAccumulator` (final `usage`, `citations`, `hadTextContent`, `responseId`), `aiSdkWarnings`, `console` (lines
  printed during the turn), `providerStateAfterTurn` (xai: `lastResponseId`, `lastResponseModel`, `promptCacheKey`;
  vllm and llama-server: model and context window), and `masks` (counts).
- `input.json`: provider, instantiation method, redacted config slice, base URL override, registration log, agent
  thinking level, loop configuration, user message, tool definition, fake server URL.

`probe/` holds `requests.json`, `response-1.txt` and `result.json` (`available`, provider state after the probe, console).
`versions.json` at the top level records Node, the repo commit and the resolved package versions.

## Masks

Applied after recording. Nothing else in the files is altered.

1. Credentials. The fake keys are replaced with `<redacted>` wherever they occur: `authorization: Bearer <redacted>` (the
   scheme is kept), `x-api-key`, `x-goog-api-key`, Google's probe `?key=<redacted>` in both `target` and `query`, and
   `api_key` in `input.json`. A header whose name matches `/authorization|api[-_]?key|token|secret|cookie/i` and still
   held another value would be replaced whole; none did.
2. `<generated-id-N>`. Ids the TypeScript side draws from `Math.random`: provider-utils `generateId()` (16 characters
   from `[0-9A-Za-z]`) and the `aitxt-` + 24-character response id `streamText` makes when a wire has none. The harness
   masks `id`/`toolCallId` values of those shapes that do not occur in any served byte. N counts first appearance (parts,
   then chunks) within one scenario directory, and one id gets the same placeholder in every file of that directory,
   including request bodies. They occur in google B and E (Gemini's `functionCall` carries no id, so `@ai-sdk/google`
   generates one and replays it as `functionCall.id` and `functionResponse.id` in request 2) and in every ollama scenario
   (text and reasoning block ids; the tool-call id, replayed as `tool_calls[].id` and `tool_call_id`; and the `aitxt-`
   response ids, since Ollama sends none). `<generated-id-1>` to `<generated-id-9>` are 16 characters long, the same as
   the ids they replace in request bodies, so `content-length` still matches the masked bodies.
3. `<generated-timestamp>`. `finish-step.response.timestamp` in `parts.json` when the wire has no creation time
   (anthropic, google): `streamText` falls back to `new Date()`. Timestamps derived from canned bytes (xAI `created_at`,
   OpenAI-compatible `created`, Ollama `created_at`) are kept.
4. Console durations. The loop's `[Tool] echo args=… → 19b in Nms` line is recorded as `in <ms>ms`.

Not masked: `host` (fixed ports) and `user-agent`, whose `runtime/node.js/22` is the Node major version from
`navigator.userAgent`, not a random value.

## TypeScript versions

| package | version |
|---|---|
| node | v22.22.2 |
| ai | 6.0.241 |
| @ai-sdk/anthropic | 3.0.105 |
| @ai-sdk/xai | 3.0.114 |
| @ai-sdk/google | 3.0.103 |
| @ai-sdk/openai-compatible | 2.0.63 (vllm, llama-server) |
| ollama-ai-provider-v2 | 3.6.0 |
| @ai-sdk/provider-utils | 4.0.41 |
| @ai-sdk/provider | 3.0.14 (each provider plugin also has a nested 3.0.10, imported for types only) |

Core and all six plugins are CommonJS dist, so the runtime loads the CommonJS builds (`dist/index.js`) of these packages.
`versions.json` lists where each one resolved from.

## Canned wire bytes

Synthetic, not captured from the real APIs. They are built from the zod schemas and stream transforms of the packages
above, so every byte parses on the TypeScript side, and every id in them is fixed (`msg_golden_*`, `resp_golden_*`,
`toolu_golden_echo_1`, `call_golden_echo_1`, `chatcmpl-golden-*`, `golden-google-*`). Shape choices that matter when
replaying them against a Rust parser:

- Anthropic: `event:` + `data:` SSE; `ping` after the first `content_block_start`; tool input as `input_json_delta`
  strings with an empty first delta; thinking closed by a `signature_delta`.
- xAI Responses: `event:` + `data:` SSE with `sequence_number`; arguments in `response.function_call_arguments.delta`;
  reasoning through `response.reasoning_summary_*` events; usage only in `response.completed`.
- Gemini: data-only SSE framed with CRLF CRLF; `usageMetadata` on every chunk; `finishReason: STOP` on the last;
  `functionCall` without an id; thoughts as `{text, thought: true}`; a `thoughtSignature` on the first answer part (C)
  and on the `functionCall` part (E).
- vLLM: `chat.completion.chunk` with `logprobs: null` and `stop_reason` on the finish chunk; usage in its own chunk with
  `choices: []`; `data: [DONE]`; reasoning as `delta.reasoning_content`.
- llama-server: llama.cpp key order, `system_fingerprint`, and a usage chunk that also carries `timings`.
- Ollama: NDJSON with nanosecond `created_at`; `tool_calls` arguments as a JSON object and no id; a final line with
  `done_reason: "stop"` and the duration counters.

The echo arguments carry the literal `1.0` in every response, as an argument string or inside a JSON object.

## Parity notes surfaced by the recordings

1. Number formatting. `1.0` survives in `tool_call_delta` chunks on wires that stream argument strings (anthropic, xai,
   vllm, llama-server). On google and ollama the arguments arrive as JSON objects and the SDK re-stringifies them, so the
   chunk carries `1`. Every follow-up request, the `tool_start` event args, and the tool result carry `1`.
2. Every request carries the loop's built-in `compact_context` tool after `echo`, and tool choice auto in each wire's
   form.
3. Config keys that are dropped. Anthropic and google have no `base_url` key. xAI validation accepts `base_url`, `store`,
   `web_search`, `x_search`, `code_execution`, `reasoning_effort` and others, but `manifest.register` passes only
   `api_key`, `model`, `temperature`, `context_window`, `max_output_tokens` and the token command, and `XAIProvider`
   never uses `temperature`.
4. xAI `previous_response_id` never engages. `captureStepResult` reads `providerMetadata.xai.responseId`, which
   `@ai-sdk/xai` 3.0.114 never emits, so `lastResponseId` stays null (`providerStateAfterTurn`). With `store` left at true
   the body omits `store`. Reasoning effort is sent only for model ids containing `multi-agent`, so none appears here.
   Request 2 replays the function call with `id` equal to the `call_id` (the SDK keeps no item id for it) and the
   reasoning item with its own id.
5. Anthropic `max_tokens` is the AI SDK's: 4096 for an unknown model id (with the compatibility warning in
   `aiSdkWarnings`) plus the thinking budget, so 14096 at medium and 54096 at high. `providers.anthropic.max_tokens`
   (default 8192) is not used on the loop path. `test-model` is not Claude 4, so thinking maps to
   `{"type":"enabled","budget_tokens":10000|50000}`. The body has a top-level `cache_control: {"type":"ephemeral"}` and
   `eager_input_streaming: true` on every tool; E replays the thinking block with its signature.
6. Gemini sends `thinkingConfig: {thinkingBudget: 8192|32768, includeThoughts: true}`, and `generationConfig: {}` when
   thinking is off. Tool parameters are converted to the OpenAPI subset with key order changed (`required` first,
   `description` before `type`).
7. vLLM and llama-server bodies get `max_tokens: 4096`, `temperature: 0.7`, `top_p: 0.95` from `transformRequestBody`
   (config defaults), in the AI SDK's key order. vLLM adds `chat_template_kwargs: {"enable_thinking": false}` only when
   thinking is off; llama-server has no thinking toggle. Reasoning is replayed as `reasoning_content`.
8. Ollama sends `think: true` for every level except off and `tool_choice: "auto"`, but not the configured
   `temperature`/`top_p` (they never leave the provider object on the loop path). Reasoning is replayed as `thinking`.
9. Usage. `TurnResult.usage` takes the per-step maximum of prompt and completion tokens independently and keeps the last
   non-zero reasoning and cached counts. `chunkAccumulator.usage` holds only the last step.
10. Headers. `host`, `connection`, `accept`, `accept-language`, `sec-fetch-mode`, `accept-encoding` and `content-length`
    come from Node's undici, not from RivetOS or the AI SDK. AI SDK requests use lowercase names and the user agent
    `ai-sdk/<package>/<version> ai-sdk/provider-utils/4.0.41 runtime/node.js/22`; `ollama-ai-provider-v2` adds no package
    segment. Probes use bare `fetch`, so they send `user-agent: node` and header names in the case the plugin wrote them.
11. Probes: anthropic posts a non-streaming `ping` to `/v1/messages` and treats 2xx or 429 as up; xai `GET /v1/models`;
    google `GET /v1beta/models/test-model?key=…` (key in the query, no header); vllm `GET /v1/models`, whose discovery
    adopts `max_model_len` as the context window (32768 on that instance); llama-server `GET /v1/models`, which also reads
    `max_model_len`, but the canned llama.cpp-style listing carries only `meta.n_ctx_train`, so it stays 0; ollama
    `GET /api/tags`.

## Not recorded

- CLI subprocess providers (claude-cli, codex-cli, grok-cli and the rest): not HTTP clients.
- Failure paths: HTTP 4xx/5xx, SSE error events, AI SDK retries (`maxRetries` 2), mid-stream abort, turn timeout, and the
  token-command 401 re-mint. Each needs its own canned failure and was outside this task.
- `token_command` auth through `createAuthorizedFetch`: no token command configured.
- xAI server-side tools and `previous_response_id`: unreachable from config at this commit (notes 3 and 4).
- Model-id-dependent mappings: Claude 4 adaptive thinking with `effort`, xAI multi-agent `reasoningEffort`, the Gemini 3
  thought-signature sentinel, known-model `max_tokens`. The task fixed the model to `test-model`; changing `MODEL` in the
  harness records them.
- Multi-turn history, images and video (vLLM `RVT_VIDEO` markers), mid-conversation system folding, and hooks that
  rewrite parameters: every turn here is single-turn text.
- The legacy `chatStream` path (`chat-stream-aisdk.ts`): the loop uses only `aiSdkBridge`.
- Ollama model management (list, show, pull, unload): not used by the loop.
- Exact network chunk boundaries: the server writes each SSE event or NDJSON line separately, but TCP may coalesce
  writes. Both SDK parsers are boundary-independent.
