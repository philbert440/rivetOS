/**
 * @rivetos/tool-web-search
 *
 * Web search + URL fetch tools.
 *
 * Two tools:
 *   web_search — search the web (Google CSE → DuckDuckGo fallback)
 *   web_fetch  — fetch and extract readable content from a URL
 *
 * Features:
 *   - Multi-provider search with automatic failover
 *   - Retry with exponential backoff on transient errors
 *   - In-memory result/content caching
 *   - Structured HTML → markdown extraction
 *   - PDF detection, GitHub raw content handling
 */

import type { Tool } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A search provider that can return results for a query. */
export interface SearchProvider {
  name: string
  search(query: string, count: number): Promise<SearchResult[]>
}

interface SearchResult {
  title: string
  snippet: string
  url: string
  source: string
}

interface CacheEntry<T> {
  data: T
  expires: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebSearchConfig {
  /** Google Custom Search API key */
  googleApiKey?: string
  /** Google Custom Search Engine ID */
  googleCseId?: string
  /** Max results per search (default: 5) */
  maxResults?: number
}

export interface WebFetchConfig {
  /** Custom user agent string */
  userAgent?: string
  /** Default max chars (default: 5000) */
  defaultMaxChars?: number
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SEARCH_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const FETCH_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expires) {
    cache.delete(key)
    return undefined
  }
  return entry.data
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttl: number): void {
  cache.set(key, { data, expires: Date.now() + ttl })
}

/** Retry a function with exponential backoff on transient errors. */
async function withRetry<T>(
  fn: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
  maxRetries = 2,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isTransient(err) || attempt === maxRetries) throw err
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw lastError
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    // Network errors
    if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED')) return true
  }
  return false
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429
}

// ---------------------------------------------------------------------------
// Google CSE Provider
// ---------------------------------------------------------------------------

function createGoogleProvider(apiKey: string, cseId: string): SearchProvider {
  return {
    name: 'Google',
    async search(query: string, count: number): Promise<SearchResult[]> {
      const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: query,
        num: String(count),
      })

      const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          throw Object.assign(new Error(`Google CSE ${response.status}`), {
            status: response.status,
          })
        }
        const body = await response.text().catch(() => '')
        throw new Error(`Google CSE failed (${response.status}): ${body.slice(0, 200)}`)
      }

      const data = (await response.json()) as Record<string, any>
      const items: any[] = data.items ?? []

      return items.map((item) => ({
        title: item.title ?? '',
        snippet: item.snippet ?? '',
        url: item.link ?? '',
        source: 'Google',
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML Provider (fallback)
// ---------------------------------------------------------------------------

function createDdgProvider(): SearchProvider {
  return {
    name: 'DuckDuckGo',
    async search(query: string, count: number): Promise<SearchResult[]> {
      const params = new URLSearchParams({ q: query })
      const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
        method: 'POST',
        headers: {
          'User-Agent': 'RivetOS/0.1.0 (web-search)',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        throw Object.assign(new Error(`DuckDuckGo ${response.status}`), { status: response.status })
      }

      const html = await response.text()
      return parseDdgResults(html, count)
    },
  }
}

/** Parse DuckDuckGo HTML search results. */
function parseDdgResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Match result blocks — each result is in a div with class "result"
  const resultBlocks =
    html.match(/<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) ?? []

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break

    // Extract title and URL from result__a
    const titleMatch = block.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    )
    // Extract snippet from result__snippet
    const snippetMatch =
      block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/td>/i)

    if (titleMatch) {
      const url = decodeURIComponent(titleMatch[1].replace(/.*uddg=/, '').replace(/&.*/, ''))
      const title = titleMatch[2].replace(/<[^>]+>/g, '').trim()
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

      if (url && title && !url.includes('duckduckgo.com')) {
        results.push({ title, snippet, url, source: 'DuckDuckGo' })
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Web Search Tool
// ---------------------------------------------------------------------------

export class WebSearchTool implements Tool {
  name = 'web_search'
  description =
    'Search the web using Google. Returns titles, snippets, and URLs. ' +
    'Use when you need current information, facts, or to find resources.'
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (default: 5, max: 10)' },
    },
    required: ['query'],
  }

  private providers: SearchProvider[]
  private maxResults: number
  private cache = new Map<string, CacheEntry<string>>()

  constructor(config?: WebSearchConfig) {
    this.maxResults = config?.maxResults ?? 5
    this.providers = []

    const apiKey =
      config?.googleApiKey ?? process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY ?? ''
    const cseId = config?.googleCseId ?? process.env.GOOGLE_CSE_ID ?? ''

    if (apiKey && cseId) {
      this.providers.push(createGoogleProvider(apiKey, cseId))
    }

    // DuckDuckGo is always available as fallback
    this.providers.push(createDdgProvider())
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '').trim()
    const count = Math.min(Number(args.count) || this.maxResults, 10)

    if (!query) return 'Error: No search query provided'

    // Check cache
    const cacheKey = `${query}::${count}`
    const cached = cacheGet(this.cache, cacheKey)
    if (cached) return cached

    // Try each provider in order
    const errors: string[] = []

    for (const provider of this.providers) {
      try {
        const results = await withRetry(
          () => provider.search(query, count),
          (err) => {
            if (isTransientError(err)) return true
            const status = (err as any)?.status
            return typeof status === 'number' && isTransientStatus(status)
          },
        )

        if (results.length === 0) {
          errors.push(`${provider.name}: no results`)
          continue
        }

        const output = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}\n   [Source: ${r.source}]`,
          )
          .join('\n\n')

        cacheSet(this.cache, cacheKey, output, SEARCH_CACHE_TTL)
        return output
      } catch (err: any) {
        errors.push(`${provider.name}: ${err.message}`)
      }
    }

    return `Search failed. All providers exhausted:\n${errors.map((e) => `  - ${e}`).join('\n')}`
  }

  /** Expose cache for testing. */
  _getCache(): Map<string, CacheEntry<string>> {
    return this.cache
  }
}

// ---------------------------------------------------------------------------
// Web Fetch Tool
// ---------------------------------------------------------------------------

export class WebFetchTool implements Tool {
  name = 'web_fetch'
  description =
    'Fetch and extract readable content from a URL. Returns the text/markdown content of a web page. ' +
    'Use when you need to read a specific webpage.'
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      max_chars: { type: 'number', description: 'Max characters to return (default: 5000)' },
    },
    required: ['url'],
  }

  private userAgent: string
  private defaultMaxChars: number
  private cache = new Map<string, CacheEntry<string>>()

  constructor(config?: WebFetchConfig) {
    this.userAgent =
      config?.userAgent ?? process.env.RIVETOS_USER_AGENT ?? 'RivetOS/0.1.0 (web-fetch)'
    this.defaultMaxChars = config?.defaultMaxChars ?? 5000
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '').trim()
    const maxChars = Number(args.max_chars) || this.defaultMaxChars

    if (!url) return 'Error: No URL provided'

    // Check cache
    const cacheKey = `${url}::${maxChars}`
    const cached = cacheGet(this.cache, cacheKey)
    if (cached) return cached

    try {
      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json',
      }

      // GitHub raw content
      if (url.includes('raw.githubusercontent.com')) {
        headers.Accept = 'text/plain'
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      })

      if (!response.ok) {
        return `Fetch failed (${response.status}): ${response.statusText}`
      }

      const contentType = response.headers.get('content-type') ?? ''

      // PDF detection
      if (contentType.includes('application/pdf')) {
        return 'PDF content detected. PDF text extraction is not yet supported. Download the file and extract text locally using pdftotext or similar tools.'
      }

      const rawText = await response.text()

      let result: string

      // JSON — return formatted
      if (contentType.includes('application/json')) {
        try {
          result = JSON.stringify(JSON.parse(rawText), null, 2)
        } catch {
          result = rawText
        }
      }
      // HTML — structured extraction
      else if (contentType.includes('text/html')) {
        result = extractMarkdown(rawText)
      }
      // Plain text / markdown
      else {
        result = rawText
      }

      // Truncation
      if (result.length > maxChars) {
        result =
          result.slice(0, maxChars) +
          `\n\n[Truncated at ${maxChars} chars. Use max_chars parameter to see more.]`
      }

      cacheSet(this.cache, cacheKey, result, FETCH_CACHE_TTL)
      return result
    } catch (err: any) {
      return `Fetch error: ${err.message}`
    }
  }

  /** Expose cache for testing. */
  _getCache(): Map<string, CacheEntry<string>> {
    return this.cache
  }
}

// ---------------------------------------------------------------------------
// HTML → Markdown extraction
// ---------------------------------------------------------------------------

/** Extract readable content from HTML and convert to markdown. */
function extractMarkdown(html: string): string {
  // Step 1: Remove non-content elements entirely
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')

  // Remove header elements but be more careful (they can be nested)
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')

  // Step 2: Try to find the main content area
  const articleMatch = content.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i)

  content = articleMatch?.[1] ?? mainMatch?.[1] ?? bodyMatch?.[1] ?? content

  // Step 3: Convert HTML elements to markdown

  // Code blocks (pre/code)
  content = content.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
  content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
  content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')

  // Headings
  content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  content = content.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  content = content.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
  content = content.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')

  // Links
  content = content.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  // Lists
  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  content = content.replace(/<\/?[ou]l[^>]*>/gi, '\n')

  // Paragraphs and line breaks
  content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
  content = content.replace(/<br\s*\/?>/gi, '\n')
  content = content.replace(/<hr\s*\/?>/gi, '\n---\n')

  // Bold and italic
  content = content.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
  content = content.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')

  // Strip remaining tags
  content = content.replace(/<[^>]+>/g, '')

  // Decode HTML entities
  content = decodeHtmlEntities(content)

  // Clean up whitespace
  content = content
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    .replace(/[ \t]+/g, ' ') // Collapse horizontal whitespace
    .replace(/^ +/gm, '') // Remove leading spaces per line
    .trim()

  return content
}

/** Decode common HTML entities. */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&laquo;': '«',
    '&raquo;': '»',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
  }

  let result = text
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char)
  }

  // Numeric entities (decimal and hex)
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16)),
  )

  return result
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create web search and fetch tools. */
export function createWebTools(config?: WebSearchConfig & WebFetchConfig): Tool[] {
  return [new WebSearchTool(config), new WebFetchTool(config)]
}
