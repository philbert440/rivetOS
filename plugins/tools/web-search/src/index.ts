/**
 * @rivetos/tool-web-search
 *
 * Web search + URL fetch for non-xAI providers (Opus, Gemini, Local).
 * xAI has native web search built into the Responses API — this is for everyone else.
 *
 * Two tools:
 *   web_search — search the web via Google Custom Search API
 *   web_fetch  — fetch and extract readable content from a URL
 */

import type { Tool } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebSearchConfig {
  /** Google Custom Search API key */
  googleApiKey?: string;
  /** Google Custom Search Engine ID */
  googleCseId?: string;
  /** Max results per search (default: 5) */
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Web Search Tool (Google Custom Search)
// ---------------------------------------------------------------------------

export class WebSearchTool implements Tool {
  name = 'web_search';
  description = 'Search the web using Google. Returns titles, snippets, and URLs. Use when you need current information, facts, or to find resources.';
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (default: 5, max: 10)' },
    },
    required: ['query'],
  };

  private apiKey: string;
  private cseId: string;
  private maxResults: number;

  constructor(config: WebSearchConfig) {
    this.apiKey = config.googleApiKey ?? process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    this.cseId = config.googleCseId ?? process.env.GOOGLE_CSE_ID ?? '';
    this.maxResults = config.maxResults ?? 5;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const count = Math.min(Number(args.count) || this.maxResults, 10);

    if (!query.trim()) return 'Error: No search query provided';
    if (!this.apiKey) return 'Error: GOOGLE_CSE_API_KEY not configured';
    if (!this.cseId) return 'Error: GOOGLE_CSE_ID not configured';

    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        cx: this.cseId,
        q: query,
        num: String(count),
      });

      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?${params}`,
        { signal: AbortSignal.timeout(10000) },
      );

      if (!response.ok) {
        const err = await response.text().catch(() => '');
        return `Search failed (${response.status}): ${err.slice(0, 200)}`;
      }

      const data = await response.json() as Record<string, unknown>;
      const items = data.items ?? [];

      if (items.length === 0) return `No results found for: ${query}`;

      return items.map((item: any, i: number) => {
        const title = item.title ?? '';
        const snippet = item.snippet ?? '';
        const link = item.link ?? '';
        return `${i + 1}. **${title}**\n   ${snippet}\n   ${link}`;
      }).join('\n\n');
    } catch (err: any) {
      return `Search error: ${err.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Web Fetch Tool (URL content extraction)
// ---------------------------------------------------------------------------

export class WebFetchTool implements Tool {
  name = 'web_fetch';
  description = 'Fetch and extract readable content from a URL. Returns the text/markdown content of a web page. Use when you need to read a specific webpage.';
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      max_chars: { type: 'number', description: 'Max characters to return (default: 5000)' },
    },
    required: ['url'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    const maxChars = Number(args.max_chars) || 5000;

    if (!url.trim()) return 'Error: No URL provided';

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'RivetOS/0.1.0 (web-fetch)',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });

      if (!response.ok) {
        return `Fetch failed (${response.status}): ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();

      // JSON — return formatted
      if (contentType.includes('application/json')) {
        try {
          const formatted = JSON.stringify(JSON.parse(text), null, 2);
          return formatted.slice(0, maxChars);
        } catch {
          return text.slice(0, maxChars);
        }
      }

      // HTML — strip tags for readable text
      if (contentType.includes('text/html')) {
        const stripped = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .trim();
        return stripped.slice(0, maxChars);
      }

      // Plain text / markdown
      return text.slice(0, maxChars);
    } catch (err: any) {
      return `Fetch error: ${err.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebTools(config?: WebSearchConfig): Tool[] {
  const tools: Tool[] = [new WebFetchTool()];

  // Only include web_search if Google API is configured
  if (config?.googleApiKey || process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY) {
    tools.unshift(new WebSearchTool(config ?? {}));
  }

  return tools;
}
