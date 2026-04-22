# @rivetos/provider-openai-compat

OpenAI-compatible chat-completions provider for RivetOS, tuned for **strict servers**.

Target: vLLM, Text Generation Inference (TGI), LocalAI, Together, Fireworks,
Groq, Azure OpenAI — anything that speaks the OpenAI `/v1/chat/completions`
wire format but enforces the spec more tightly than `llama-server` does.

## Why not just use `llama-server`?

`@rivetos/provider-llama-server` is llama.cpp-specific: it sends llama-native
sampling knobs (`typical_p`, `min_p`, `mirostat`, `repeat_penalty`,
`repeat_last_n`) and pings `/health` (a llama.cpp-only endpoint). Strict
OpenAI-compatible servers reject those extra keys with 400, and don't expose
`/health`.

This provider sends only standard OpenAI sampling, pings `/v1/models`, and
includes vLLM-specific fixes (see below).

## Key behaviors

### 1. Strict message ordering

vLLM + Qwen/Llama chat templates reject mid-conversation system messages
with `System message must be at the beginning.` RivetOS legitimately injects
mid-conversation system messages for:

- Context-window nudges (50%, 70%, 85%)
- `/steer` events (user sends a new message mid-turn)
- Turn-timeout warnings

This provider folds any `role: 'system'` that arrives after the first
non-system message into a `role: 'user'` message prefixed with
`[SYSTEM NOTICE]`. The text still reaches the model; the template is happy.

### 2. Native reasoning via `reasoning_content`

When vLLM is started with `--reasoning-parser` (e.g. `deepseek_r1`,
`qwen3`), it emits reasoning as a separate `reasoning_content` field on the
streaming delta. This provider consumes that field directly. If the server
emits reasoning inline (e.g. raw `<think>` blocks in `content`), the
provider still parses them as a fallback.

### 3. Tool-call passthrough

`tools` and `tool_choice` are forwarded. Default `tool_choice: auto` when
tools are present. vLLM requires `--enable-auto-tool-choice` and a
`--tool-call-parser` (e.g. `hermes`, `mistral`, `llama`) on the server
side.

### 4. Forgiving `base_url`

Accepts either `http://host:port` or `http://host:port/v1`. The provider
normalizes internally.

### 5. Optional startup verification

Set `verify_model_on_init: true` to validate that the configured `model`
id is actually served by `/v1/models` on boot.

## Config example

```yaml
providers:
  openai-compat:
    name: 'Rivet Local (Qwen3.6-35B-A3B @ vLLM)'
    base_url: http://192.168.1.10:8003
    api_key: ${OPENAI_COMPAT_API_KEY}    # or sk-no-key-required
    model: qwen3.6-35b-a3b-awq
    temperature: 0.7
    top_p: 0.9
    max_tokens: 8192
    context_window: 65536
    max_output_tokens: 8192
    # default_tool_choice: auto          # or 'none' | 'required' | { type, function }
    # verify_model_on_init: true         # probe /v1/models at boot

agents:
  local:
    provider: openai-compat
```

## Supported config keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `base_url` | string | (required) | `http://host:port` or `http://host:port/v1` |
| `api_key` | string | `''` | Sent as `Authorization: Bearer …`. Falls back to `OPENAI_COMPAT_API_KEY` env var. |
| `model` | string | `default` | As served by `/v1/models` |
| `max_tokens` | integer | `4096` | |
| `temperature` | number | `0.7` | |
| `top_p` | number | `0.95` | |
| `presence_penalty` | number | — | |
| `frequency_penalty` | number | — | |
| `seed` | integer | — | |
| `default_tool_choice` | string | `auto` | `auto`, `none`, `required`, or `{type: function, function: { name }}` |
| `verify_model_on_init` | boolean | `false` | Reject boot if `/v1/models` does not list the configured id |
| `name` | string | `openai-compat` | Display name in logs/errors |
| `context_window` | integer | — | Runtime budgeting |
| `max_output_tokens` | integer | — | Runtime budgeting |

## vLLM server flags (for reference)

To get the full feature set on the server side:

```
vllm serve <model> \
  --host 0.0.0.0 --port 8003 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --reasoning-parser deepseek_r1 \
  --max-model-len 65536 \
  --gpu-memory-utilization 0.93
```

## License

MIT
