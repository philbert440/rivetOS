# @rivetos/provider-codex-cli

RivetOS provider backed by the installed [OpenAI Codex CLI](https://developers.openai.com/codex/cli). It runs `codex exec --json`, so it uses the same ChatGPT subscription login as the Codex TUI (`codex login`) instead of requiring `OPENAI_API_KEY` or billing the API separately.

## Setup

```bash
npm install -g @openai/codex
codex login
npm install @rivetos/provider-codex-cli
```

```yaml
plugins:
  - '@rivetos/provider-codex-cli'

providers:
  codex-cli:
    # Omit or use `default` to follow the model selected by Codex itself.
    model: default
    sandbox: read-only
    session: resume

agents:
  main:
    provider: codex-cli
```

Each RivetOS conversation maps to a persistent Codex thread in `~/.rivetos/codex-cli-sessions.json`. On its first turn the complete RivetOS transcript is sent; later turns use `codex exec resume` with only the newest user message.

Options: `binary`, `model`, `reasoning_effort`, `cwd`, `sandbox`, `approve_for_me`, `skip_git_repo_check`, `profile`, `session` (`resume` or `replay`), `context_window`, and `max_output_tokens`.

`read-only` is the safe default. Set `sandbox: workspace-write` only when the node should let Codex edit its working directory. `danger-full-access` and `approve_for_me` broaden autonomous access and should be enabled deliberately.
