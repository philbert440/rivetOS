# Example Configurations

These examples cover common RivetOS setups. Copy one to `config.yaml` and customize it.

| Example | Description | Providers | Channels |
|---------|-------------|-----------|----------|
| [`single-agent.yaml`](single-agent.yaml) | Simplest setup — one agent, one channel | Anthropic | Discord |
| [`multi-agent.yaml`](multi-agent.yaml) | Three agents with delegation and fallbacks | Anthropic, xAI, Ollama | Discord + Agent |
| [`local-only.yaml`](local-only.yaml) | Fully self-hosted, no cloud APIs | Ollama | Telegram |
| [`homelab.yaml`](homelab.yaml) | Multi-node Proxmox deployment | Anthropic, xAI, Ollama | Discord + Agent |

## Quick Start

```bash
# Copy an example
cp examples/single-agent.yaml config.yaml

# Set up secrets
cp .env.example .env
# Edit .env with your API keys

# Start
npx rivetos start
```

## Customizing

All examples use environment variables for secrets (API keys, tokens). Set these in your `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-...
XAI_API_KEY=xai-...
DISCORD_BOT_TOKEN=...
TELEGRAM_BOT_TOKEN=...
RIVETOS_PG_URL=postgresql://...
RIVETOS_AGENT_SECRET=...
```

See [CONFIG-REFERENCE.md](../docs/CONFIG-REFERENCE.md) for every configuration option.
