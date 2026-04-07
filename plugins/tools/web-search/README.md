# @rivetos/tool-web-search

Web search and URL fetching with multi-provider failover

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Gives agents the ability to search the web and fetch content from URLs. Search uses Google Custom Search with automatic DuckDuckGo fallback. URL fetching extracts readable content from web pages, with PDF detection and GitHub raw content handling.

## Tools provided

- **`web_search`** — search the web using Google CSE (falls back to DuckDuckGo)
- **`web_fetch`** — fetch and extract readable text/markdown content from a URL

## Features

- **Multi-provider search** — Google Custom Search Engine with automatic DuckDuckGo fallback
- **Retry with backoff** — exponential backoff on transient errors
- **Result caching** — in-memory cache for search results and fetched content
- **HTML → Markdown** — structured extraction of readable content from web pages
- **PDF detection** — identifies PDF URLs and handles them appropriately
- **GitHub raw content** — automatic handling of GitHub raw file URLs
- **Configurable limits** — max results per search, max characters per fetch

## Configuration

```yaml
# Google Custom Search (optional — falls back to DuckDuckGo)
GOOGLE_API_KEY: your-api-key
GOOGLE_CSE_ID: your-cse-id
```

## Installation

```bash
npm install @rivetos/tool-web-search
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
