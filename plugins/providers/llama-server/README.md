# @rivetos/provider-llama-server

Dedicated provider for [llama.cpp](https://github.com/ggml-org/llama.cpp)'s
`llama-server` OpenAI-compatible endpoint. Deliberately lean:

- Standard OpenAI sampling plus llama.cpp's `top_k` / `min_p` extensions.
- A generic `extra_body` escape hatch for server-specific fields (`grammar`,
  `n_probs`, …).
- Native `reasoning_content` parsing via the AI SDK reasoning surface (start the
  server with `--reasoning-format deepseek`).
- Folds mid-conversation `system` messages into `user [SYSTEM NOTICE]` content.
- `/v1/models` probe that auto-selects the served model when `model: default`.

It carries **none** of the vLLM-only machinery (`mm_processor_kwargs`,
`chat_template_kwargs`, `repetition_penalty`, `min_tokens`, video). For a vLLM
server, use [`@rivetos/provider-vllm`](../vllm) instead.

## Config

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080      # trailing /v1 optional
    model: default                       # auto-discovers from /v1/models
    top_k: 40
    min_p: 0.05

agents:
  local:
    provider: llama-server
    local: true
```

Start a server with `llama-server -m <model.gguf> --port 8080
[--reasoning-format deepseek]`. The API key falls back to the
`LLAMA_SERVER_API_KEY` environment variable (only needed if you started the
server with `--api-key`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | llama-server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${LLAMA_SERVER_API_KEY}` | Bearer token (only if `--api-key` set). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` / `top_p` | number | `0.7` / `0.95` | Standard sampling. |
| `top_k` / `min_p` | number | — | llama.cpp sampling extensions. |
| `presence_penalty` / `frequency_penalty` / `seed` / `stop` | — | — | Standard OpenAI knobs. |
| `extra_body` | object | — | Escape hatch (`grammar`, `n_probs`, …). |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot. |
| `context_window` / `max_output_tokens` | number | — | Runtime budgeting overrides. |
| `name` | string | `llama-server` | Display name in logs/errors. |

## License

MIT
