# @rivetos/provider-vllm

Dedicated [vLLM](https://docs.vllm.ai/) provider for RivetOS. Exposes the full
vLLM surface on top of vLLM's OpenAI-compatible server:

- Standard OpenAI sampling plus vLLM extensions: `top_k`, `min_p`,
  `repetition_penalty`, `min_tokens`.
- `mm_processor_kwargs` / `chat_template_kwargs` and an `extra_body` escape hatch.
- `video_url` content blocks (carried out-of-band so the AI SDK serializer
  doesn't reject them).
- Native `reasoning_content` parsing via the AI SDK reasoning surface (configure
  a server-side `--reasoning-parser`).
- Folds mid-conversation `system` messages into `user [SYSTEM NOTICE]` content
  (vLLM/Qwen/Llama chat templates reject them).
- `/v1/models` probe that auto-selects the served model and its context window
  when `model: default`.

For llama.cpp's `llama-server`, use [`@rivetos/provider-llama-server`](../llama-server)
instead.

## Config

```yaml
providers:
  vllm:
    base_url: http://localhost:8000      # trailing /v1 optional
    model: default                       # auto-discovers from /v1/models
    top_k: 40
    min_p: 0.05
    # api_key: ${VLLM_API_KEY}           # only if vLLM was started with --api-key

agents:
  local:
    provider: vllm
    local: true
```

Start a server with `vllm serve <model> --port 8000 [--reasoning-parser ...]
[--enable-auto-tool-choice]`. The API key falls back to the `VLLM_API_KEY`
environment variable.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | vLLM server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${VLLM_API_KEY}` | Bearer token (only if `--api-key` set). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` / `top_p` | number | `0.7` / `0.95` | Standard sampling. |
| `top_k` / `min_p` | number | — | vLLM sampling extensions. |
| `presence_penalty` / `frequency_penalty` / `seed` / `stop` | — | — | Standard OpenAI knobs. |
| `repetition_penalty` / `min_tokens` | number | — | vLLM extensions. |
| `mm_processor_kwargs` / `chat_template_kwargs` / `extra_body` | object | — | vLLM passthroughs. |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot. |
| `context_window` / `max_output_tokens` | number | — | Runtime budgeting overrides. |
| `name` | string | `vllm` | Display name in logs/errors. |

## License

MIT
