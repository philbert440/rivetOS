#!/usr/bin/env node

/**
 * Web Search skill for RivetOS
 * 
 * Primary: Google Custom Search JSON API (works with any model)
 * Optional: xAI native web_search tool (grok-4 family, richer results)
 * 
 * Usage: node search.mjs "query" [options]
 */

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
  console.log(`Usage: node search.mjs "query" [options]

Options:
  --provider <name>         Force provider: google or xai (default: google)
  --num <n>                 Number of results (google: 1-10, default: 5)
  --allowed-domains d1,d2   Only search these domains (xAI only, max 5)
  --excluded-domains d1,d2  Exclude these domains (xAI only, max 5)
  --images                  Enable image understanding (xAI only)
  --model <name>            Override model (xAI only, default: grok-4.20-reasoning)
  --json                    Output full JSON response
  --site <domain>           Restrict to domain (google, prepends site: to query)`);
  process.exit(0);
}

// Parse arguments
let query = null;
let allowedDomains = null;
let excludedDomains = null;
let enableImages = false;
let model = null;
let provider = null;
let jsonOutput = false;
let numResults = 5;
let siteDomain = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allowed-domains' && args[i + 1]) {
    allowedDomains = args[++i].split(',').map(d => d.trim()).filter(Boolean);
  } else if (args[i] === '--excluded-domains' && args[i + 1]) {
    excludedDomains = args[++i].split(',').map(d => d.trim()).filter(Boolean);
  } else if (args[i] === '--images') {
    enableImages = true;
  } else if (args[i] === '--model' && args[i + 1]) {
    model = args[++i];
  } else if (args[i] === '--provider' && args[i + 1]) {
    provider = args[++i].toLowerCase();
  } else if (args[i] === '--json') {
    jsonOutput = true;
  } else if (args[i] === '--num' && args[i + 1]) {
    numResults = Math.min(10, Math.max(1, parseInt(args[++i], 10)));
  } else if (args[i] === '--site' && args[i + 1]) {
    siteDomain = args[++i];
  } else if (!args[i].startsWith('--')) {
    query = args[i];
  }
}

if (!query) {
  console.error('Error: No search query provided');
  process.exit(1);
}

// Determine which provider to use
function detectProvider() {
  if (provider) return provider;
  
  // Google Custom Search is the primary (works with any model)
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) return 'google';
  if (process.env.XAI_API_KEY) return 'xai';
  
  console.error('Error: No API keys found. Set GOOGLE_API_KEY + GOOGLE_CSE_ID, or XAI_API_KEY');
  process.exit(1);
}

// ─── Google Custom Search JSON API ────────────────────────────────────────────

async function searchGoogle() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  
  if (!apiKey || !cseId) {
    throw new Error('GOOGLE_API_KEY and GOOGLE_CSE_ID must both be set');
  }

  let searchQuery = query;
  if (siteDomain) {
    searchQuery = `site:${siteDomain} ${query}`;
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: searchQuery,
    num: numResults.toString()
  });

  const url = `https://www.googleapis.com/customsearch/v1?${params}`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Custom Search API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Format results
  const totalResults = data.searchInformation?.totalResults || '0';
  const searchTime = data.searchInformation?.searchTime || 'N/A';
  
  console.log(`Found ${totalResults} results (${searchTime}s)\n`);

  if (data.items && data.items.length > 0) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      console.log(`${i + 1}. ${item.title}`);
      console.log(`   ${item.link}`);
      if (item.snippet) {
        console.log(`   ${item.snippet.replace(/\n/g, ' ')}`);
      }
      console.log('');
    }
  } else {
    console.log('No results found.');
  }
}

// ─── xAI Web Search (Responses API) ───────────────────────────────────────────

async function searchXAI() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY not set');
  }

  const searchModel = model || 'grok-4.20-reasoning';

  const webSearchTool = { type: 'web_search' };
  if (allowedDomains && allowedDomains.length > 0) {
    webSearchTool.filters = { allowed_domains: allowedDomains.slice(0, 5) };
  }
  if (excludedDomains && excludedDomains.length > 0) {
    webSearchTool.filters = { ...(webSearchTool.filters || {}), excluded_domains: excludedDomains.slice(0, 5) };
  }
  if (enableImages) {
    webSearchTool.enable_image_understanding = true;
  }

  const body = {
    model: searchModel,
    input: [{ role: 'user', content: query }],
    tools: [webSearchTool]
  };

  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xAI API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  let textContent = '';
  let citations = [];

  if (data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text') {
            textContent += block.text;
            if (block.annotations) {
              for (const ann of block.annotations) {
                if (ann.type === 'url_citation') {
                  citations.push({ title: ann.title || 'Untitled', url: ann.url });
                }
              }
            }
          }
        }
      }
    }
  }

  if (textContent) {
    console.log(textContent);
  } else {
    console.log('No text response received.');
    if (data.output) {
      console.log('\nRaw output:');
      console.log(JSON.stringify(data.output, null, 2));
    }
  }

  const seen = new Set();
  const uniqueCitations = citations.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  if (uniqueCitations.length > 0) {
    console.log('\nCitations:');
    for (const c of uniqueCitations) {
      console.log(`- ${c.title}`);
      console.log(`  ${c.url}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const selectedProvider = detectProvider();
  
  try {
    if (selectedProvider === 'google') {
      await searchGoogle();
    } else if (selectedProvider === 'xai') {
      await searchXAI();
    } else {
      console.error(`Unknown provider: ${selectedProvider}`);
      process.exit(1);
    }
  } catch (err) {
    // If primary fails and the other provider is available, try fallback
    if (selectedProvider === 'google' && process.env.XAI_API_KEY && !provider) {
      console.error(`[Google search failed: ${err.message}]`);
      console.error('[Falling back to xAI search...]\n');
      try {
        await searchXAI();
        return;
      } catch (fallbackErr) {
        console.error(`xAI fallback also failed: ${fallbackErr.message}`);
        process.exit(1);
      }
    }
    if (selectedProvider === 'xai' && process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID && !provider) {
      console.error(`[xAI search failed: ${err.message}]`);
      console.error('[Falling back to Google search...]\n');
      try {
        await searchGoogle();
        return;
      } catch (fallbackErr) {
        console.error(`Google fallback also failed: ${fallbackErr.message}`);
        process.exit(1);
      }
    }
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
