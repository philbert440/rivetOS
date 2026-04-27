---
name: websearch
description: Search the web in real-time. Primary provider is Google Custom Search (works with any model). Optional xAI native web search for richer results and citations. Returns up-to-date information for any query requiring current news, facts, documentation, or research. Automatically falls back between providers if one fails.
---

# Web Search

Real-time web search with two providers:
- **Primary (Google):** Custom Search JSON API — fast, model-agnostic, works everywhere
- **Optional (xAI):** Native `web_search` tool via Responses API — richer results with citations

Google is the default because it works with any model. Use `--provider xai` for richer results when running on xAI models.

## Prerequisites

**Google (primary):**
- `GOOGLE_API_KEY` — Google Cloud API key
- `GOOGLE_CSE_ID` — Custom Search Engine ID (from programmablesearchengine.google.com)

**xAI (optional):**
- `XAI_API_KEY` — xAI API key

No additional dependencies — uses Node.js built-in `fetch`.

## Usage

All commands use the script at `~/.rivetos/skills/websearch/scripts/search.mjs`.

### Basic search (uses Google by default)
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "What is the latest news about AI?"
```

### Search with more results
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "TypeScript 5.8 features" --num 10
```

### Restrict to a specific site
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "web search API" --site docs.x.ai
```

### Use xAI native search (richer results with citations)
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "xAI API documentation" --provider xai
```

### xAI with domain filters
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "release notes" --provider xai --allowed-domains docs.x.ai
```

### xAI with excluded domains
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "Python tutorials" --provider xai --excluded-domains w3schools.com,geeksforgeeks.org
```

### Get raw JSON response
```bash
node ~/.rivetos/skills/websearch/scripts/search.mjs "SpaceX launch schedule" --json
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--provider <name>` | `google` | Force provider: `google` or `xai` |
| `--num <n>` | `5` | Number of results, 1-10 (Google only) |
| `--site <domain>` | none | Restrict search to domain (Google, prepends `site:`) |
| `--allowed-domains <d1,d2>` | none | Only search these domains (xAI only, max 5) |
| `--excluded-domains <d1,d2>` | none | Exclude these domains (xAI only, max 5) |
| `--images` | off | Enable image understanding (xAI only) |
| `--model <name>` | `grok-4.20-reasoning` | Override xAI model |
| `--json` | off | Output full JSON response |

## Provider Details

### Google Custom Search (Primary)
- Direct REST API — no LLM involved, pure search results
- Returns title, link, and snippet for each result
- Free: 100 queries/day, then $5/1,000 queries
- Works with any model — completely model-agnostic
- Use `--site` to restrict to a specific domain

### xAI Native Web Search (Optional)
- Uses the Responses API with native `web_search` tool
- Works with grok-4.20 and grok-4-1-fast models
- Returns full LLM-synthesized answers with inline citations
- Supports domain filtering and image understanding
- Richer output but slower and more expensive

### Automatic Fallback
If the primary provider fails (rate limit, API error, etc.) and the other provider's keys are set, the script automatically retries with the fallback. Force a specific provider with `--provider` to disable fallback.

## Tips

- **Google is the default** — fast, cheap, works everywhere.
- **Use `--provider xai` for deep research** — xAI synthesizes an answer from web results.
- **`--site` is great for docs** — e.g. `--site docs.x.ai` to search only xAI docs.
- **`--json` for debugging** — see the full API response from either provider.
- **For bot-protected sites** that block both providers, fall back to the `stealth-browser` skill.
