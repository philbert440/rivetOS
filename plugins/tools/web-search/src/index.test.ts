/**
 * Web search + web fetch tool tests.
 *
 * Uses vitest mocking to avoid real network calls.
 */

import { describe, it, beforeEach, vi, type Mock } from 'vitest';
import assert from 'node:assert/strict';
import { WebSearchTool, WebFetchTool } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mock global fetch */
function mockFetch(impl: Mock) {
  vi.stubGlobal('fetch', impl);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function textResponse(text: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType },
  });
}

function pdfResponse(): Response {
  return new Response('binary pdf data', {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

// ---------------------------------------------------------------------------
// WebSearchTool
// ---------------------------------------------------------------------------

describe('WebSearchTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct tool metadata', () => {
    const tool = new WebSearchTool();
    assert.equal(tool.name, 'internet_search');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('query'));
  });

  it('returns error for empty query', async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute({ query: '' });
    assert.ok(result.includes('Error'));
  });

  it('returns Google results on success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        items: [
          { title: 'Test Result', snippet: 'A test snippet', link: 'https://example.com' },
          { title: 'Another Result', snippet: 'More info', link: 'https://example.org' },
        ],
      }),
    );
    mockFetch(fetchMock);

    const tool = new WebSearchTool({ googleApiKey: 'test-key', googleCseId: 'test-cse' });
    const result = await tool.execute({ query: 'test query' });

    assert.ok(result.includes('Test Result'));
    assert.ok(result.includes('example.com'));
    assert.ok(result.includes('[Source: Google]'));
  });

  it('falls back to DuckDuckGo when Google returns 403', async () => {
    const ddgHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.com">DDG Title</a>
          <a class="result__snippet">DDG snippet here</a>
        </div>
      </div>
    `;

    const fetchMock = vi.fn()
      // Google CSE fails (403) — 3 times (1 initial + 2 retries)
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      // DDG succeeds
      .mockResolvedValueOnce(htmlResponse(ddgHtml));
    mockFetch(fetchMock);

    const tool = new WebSearchTool({ googleApiKey: 'test-key', googleCseId: 'test-cse' });
    const result = await tool.execute({ query: 'test fallback' });

    assert.ok(result.includes('DDG Title') || result.includes('DuckDuckGo'), `Expected DDG results, got: ${result}`);
  });

  it('returns error when all providers fail', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    mockFetch(fetchMock);

    const tool = new WebSearchTool({ googleApiKey: 'test-key', googleCseId: 'test-cse' });
    const result = await tool.execute({ query: 'doomed query' });

    assert.ok(result.includes('Search failed'));
    assert.ok(result.includes('All providers exhausted'));
  });

  it('returns cached results on second call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ title: 'Cached', snippet: 'cached result', link: 'https://cached.com' }],
      }),
    );
    mockFetch(fetchMock);

    const tool = new WebSearchTool({ googleApiKey: 'key', googleCseId: 'cse' });

    const result1 = await tool.execute({ query: 'cache test', count: 5 });
    const result2 = await tool.execute({ query: 'cache test', count: 5 });

    assert.equal(result1, result2);
    // Fetch should only be called once (second call uses cache)
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('works with only DDG when no Google keys configured', async () => {
    // Clear env vars that would enable Google CSE
    const savedApiKey = process.env.GOOGLE_API_KEY;
    const savedCseKey = process.env.GOOGLE_CSE_API_KEY;
    const savedCseId = process.env.GOOGLE_CSE_ID;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_API_KEY;
    delete process.env.GOOGLE_CSE_ID;

    try {
      const ddgHtml = `
        <div class="result">
          <div class="result__body">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg-only.com">DDG Only</a>
            <a class="result__snippet">Only DDG available</a>
          </div>
        </div>
      `;

      const fetchMock = vi.fn().mockResolvedValue(htmlResponse(ddgHtml));
      mockFetch(fetchMock);

      // No Google keys — should only use DDG
      const tool = new WebSearchTool();
      const result = await tool.execute({ query: 'ddg only' });

      // Should attempt DDG (the first and only provider)
      assert.ok(fetchMock.mock.calls.length >= 1);
      const firstCallUrl = String(fetchMock.mock.calls[0][0]);
      assert.ok(firstCallUrl.includes('duckduckgo'));
    } finally {
      // Restore env vars
      if (savedApiKey) process.env.GOOGLE_API_KEY = savedApiKey;
      if (savedCseKey) process.env.GOOGLE_CSE_API_KEY = savedCseKey;
      if (savedCseId) process.env.GOOGLE_CSE_ID = savedCseId;
    }
  });
});

// ---------------------------------------------------------------------------
// WebFetchTool
// ---------------------------------------------------------------------------

describe('WebFetchTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct tool metadata', () => {
    const tool = new WebFetchTool();
    assert.equal(tool.name, 'web_fetch');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('url'));
  });

  it('returns error for empty URL', async () => {
    const tool = new WebFetchTool();
    const result = await tool.execute({ url: '' });
    assert.ok(result.includes('Error'));
  });

  it('extracts markdown from HTML', async () => {
    const html = `
      <html>
      <head><title>Test</title></head>
      <body>
        <nav>Skip this nav</nav>
        <main>
          <h1>Main Title</h1>
          <p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
          <h2>Section Two</h2>
          <ul>
            <li>Item one</li>
            <li>Item two</li>
          </ul>
          <a href="https://example.com">A link</a>
        </main>
        <footer>Skip this footer</footer>
      </body>
      </html>
    `;

    mockFetch(vi.fn().mockResolvedValue(htmlResponse(html)));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com' });

    assert.ok(result.includes('# Main Title'), 'Should have h1 as markdown heading');
    assert.ok(result.includes('**bold**'), 'Should convert strong to bold');
    assert.ok(result.includes('*italic*'), 'Should convert em to italic');
    assert.ok(result.includes('- Item one'), 'Should convert li to list');
    assert.ok(result.includes('[A link](https://example.com)'), 'Should convert links');
    assert.ok(!result.includes('Skip this nav'), 'Should strip nav');
    assert.ok(!result.includes('Skip this footer'), 'Should strip footer');
  });

  it('removes script and style tags', async () => {
    const html = `
      <html><body>
        <script>alert('xss')</script>
        <style>.red { color: red; }</style>
        <p>Visible content</p>
      </body></html>
    `;

    mockFetch(vi.fn().mockResolvedValue(htmlResponse(html)));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com' });

    assert.ok(result.includes('Visible content'));
    assert.ok(!result.includes('alert'));
    assert.ok(!result.includes('.red'));
  });

  it('returns formatted JSON', async () => {
    const data = { key: 'value', nested: { a: 1 } };
    mockFetch(vi.fn().mockResolvedValue(jsonResponse(data)));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://api.test.com/data' });

    assert.ok(result.includes('"key": "value"'));
    assert.ok(result.includes('"a": 1'));
  });

  it('detects PDF and returns placeholder message', async () => {
    mockFetch(vi.fn().mockResolvedValue(pdfResponse()));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com/file.pdf' });

    assert.ok(result.includes('PDF'));
    assert.ok(result.includes('not yet supported'));
  });

  it('truncates and adds hint', async () => {
    const longText = 'a'.repeat(10000);
    mockFetch(vi.fn().mockResolvedValue(textResponse(longText)));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com', max_chars: 100 });

    assert.ok(result.length < 10000);
    assert.ok(result.includes('[Truncated at 100 chars'));
    assert.ok(result.includes('max_chars'));
  });

  it('returns cached content on second call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('cached content'));
    mockFetch(fetchMock);

    const tool = new WebFetchTool();

    const result1 = await tool.execute({ url: 'https://cache-test.com' });
    const result2 = await tool.execute({ url: 'https://cache-test.com' });

    assert.equal(result1, result2);
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('uses custom user agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('content'));
    mockFetch(fetchMock);

    const tool = new WebFetchTool({ userAgent: 'CustomBot/2.0' });
    await tool.execute({ url: 'https://test.com' });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    assert.equal(headers['User-Agent'], 'CustomBot/2.0');
  });

  it('sets text/plain Accept for GitHub raw URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('# README'));
    mockFetch(fetchMock);

    const tool = new WebFetchTool();
    await tool.execute({ url: 'https://raw.githubusercontent.com/user/repo/main/README.md' });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    assert.equal(headers.Accept, 'text/plain');
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch(vi.fn().mockRejectedValue(new Error('Connection refused')));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://down.com' });

    assert.ok(result.includes('Fetch error'));
    assert.ok(result.includes('Connection refused'));
  });

  it('handles non-OK response', async () => {
    mockFetch(vi.fn().mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' })));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com/missing' });

    assert.ok(result.includes('404'));
    assert.ok(result.includes('Not Found'));
  });

  it('decodes HTML entities', async () => {
    const html = '<html><body><p>AT&amp;T &mdash; &ldquo;quoted&rdquo; &#169;</p></body></html>';
    mockFetch(vi.fn().mockResolvedValue(htmlResponse(html)));

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'https://test.com' });

    assert.ok(result.includes('AT&T'));
    assert.ok(result.includes('—'));
    assert.ok(result.includes('©'));
  });
});
