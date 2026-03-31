/**
 * Memory Tools — agent-facing tools for searching and exploring memory.
 *
 * Exposes four tools:
 *   memory_grep         — search messages and summaries (FTS, trigram, regex)
 *   memory_expand       — drill into a summary: children + source messages
 *   memory_describe     — inspect summary metadata
 *   memory_expand_query — ask a focused question against expanded memory context
 *
 * Tools implement the Tool interface from @rivetos/types.
 * They delegate all data access to SearchEngine and Expander.
 */

import type { Tool } from '@rivetos/types';
import type { SearchEngine } from './search.js';
import type { Expander } from './expand.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryToolsConfig {
  /** Rivet Local endpoint for memory_expand_query (e.g., http://10.4.20.12:8000/v1) */
  compactorEndpoint?: string;
  /** Model name for expand_query (default: rivet-v0.1) */
  compactorModel?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function createMemoryTools(
  searchEngine: SearchEngine,
  expander: Expander,
  config?: MemoryToolsConfig,
): Tool[] {
  const tools: Tool[] = [
    createGrepTool(searchEngine),
    createExpandTool(expander),
    createDescribeTool(expander),
  ];

  if (config?.compactorEndpoint) {
    tools.push(
      createExpandQueryTool(searchEngine, expander, config.compactorEndpoint, config.compactorModel ?? 'rivet-v0.1'),
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// memory_grep
// ---------------------------------------------------------------------------

function createGrepTool(searchEngine: SearchEngine): Tool {
  return {
    name: 'memory_grep',
    description:
      'Search conversation history and summaries. Use when looking for past decisions, ' +
      'discussions, or context. Supports full-text search, trigram (fuzzy), and regex modes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        mode: {
          type: 'string',
          enum: ['fts', 'trigram', 'regex'],
          description: 'Search mode (default: fts)',
        },
        scope: {
          type: 'string',
          enum: ['messages', 'summaries', 'both'],
          description: 'Where to search (default: both)',
        },
        limit: { type: 'number', description: 'Max results (default: 20)' },
        agent: { type: 'string', description: 'Filter by agent (opus, grok, etc.)' },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const results = await searchEngine.search(args.query as string, {
        mode: (args.mode as string | undefined) ?? 'fts',
        scope: (args.scope as string | undefined) ?? 'both',
        limit: (args.limit as number) ?? 20,
        agent: args.agent as string | undefined,
      });

      if (results.length === 0) return 'No results found.';

      return results
        .map((r, i) => {
          const age = Math.floor(
            (Date.now() - r.createdAt.getTime()) / MS_PER_DAY,
          );
          const preview =
            r.content.length > 300
              ? r.content.slice(0, 300) + '…'
              : r.content;
          return `${i + 1}. [${r.type}] ${r.agent}/${r.role} (${age}d ago, score: ${r.score.toFixed(3)})\n   ${preview}`;
        })
        .join('\n\n');
    },
  };
}

// ---------------------------------------------------------------------------
// memory_expand
// ---------------------------------------------------------------------------

function createExpandTool(expander: Expander): Tool {
  return {
    name: 'memory_expand',
    description:
      'Expand a summary to see its children and source messages. ' +
      'Use after memory_grep to drill into a summary for more detail.',
    parameters: {
      type: 'object',
      properties: {
        summary_id: { type: 'string', description: 'Summary UUID' },
        depth: { type: 'number', description: 'Max traversal depth (default: 3)' },
        include_messages: {
          type: 'boolean',
          description: 'Include source messages at leaves (default: true)',
        },
      },
      required: ['summary_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const depth = (args.depth as number) ?? 3;
      const includeMessages = args.include_messages !== false;

      const result = includeMessages
        ? await expander.expandDeep(args.summary_id as string, depth)
        : await expander.expand(args.summary_id as string);

      if (!result) return `Summary ${args.summary_id} not found.`;

      const sections: string[] = [];

      sections.push(`## Summary: ${result.summary.summaryId}`);
      sections.push(
        `Kind: ${result.summary.kind} | Depth: ${result.summary.depth} | Messages: ${result.summary.messageCount}`,
      );
      sections.push(
        `Period: ${fmtDate(result.summary.earliestAt)} → ${fmtDate(result.summary.latestAt)}`,
      );
      sections.push(`\n${result.summary.content}`);

      if (result.children.length > 0) {
        sections.push(`\n## Children (${result.children.length})`);
        for (const child of result.children) {
          sections.push(
            `- ${child.summaryId} (${child.kind}, ${child.messageCount} msgs)`,
          );
          sections.push(
            `  ${child.content.slice(0, 200)}${child.content.length > 200 ? '…' : ''}`,
          );
        }
      }

      if (result.sourceMessages.length > 0) {
        sections.push(
          `\n## Source Messages (${result.sourceMessages.length})`,
        );
        for (const msg of result.sourceMessages) {
          sections.push(
            `[${msg.role}] ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '…' : ''}`,
          );
        }
      }

      return sections.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// memory_describe
// ---------------------------------------------------------------------------

function createDescribeTool(expander: Expander): Tool {
  return {
    name: 'memory_describe',
    description:
      'Get metadata about a summary node — kind, depth, time range, message count, model used.',
    parameters: {
      type: 'object',
      properties: {
        summary_id: {
          type: 'string',
          description: 'Summary UUID to inspect',
        },
      },
      required: ['summary_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const node = await expander.describe(args.summary_id as string);
      if (!node) return `Summary ${args.summary_id} not found.`;

      return [
        `**Summary:** ${node.summaryId}`,
        `**Kind:** ${node.kind}`,
        `**Depth:** ${node.depth}`,
        `**Messages:** ${node.messageCount}`,
        `**Access Count:** ${node.accessCount}`,
        `**Period:** ${node.earliestAt?.toISOString() ?? '?'} → ${node.latestAt?.toISOString() ?? '?'}`,
        `**Created:** ${node.createdAt.toISOString()}`,
        `**Model:** ${node.model ?? 'unknown'}`,
        `\n${node.content}`,
      ].join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// memory_expand_query
// ---------------------------------------------------------------------------

function createExpandQueryTool(
  searchEngine: SearchEngine,
  expander: Expander,
  endpoint: string,
  model: string,
): Tool {
  return {
    name: 'memory_expand_query',
    description:
      'Ask a focused question against conversation history. Searches for relevant summaries, ' +
      'expands them to source messages, and uses Rivet Local to synthesize a focused answer. ' +
      'Use for "pick up where we left off" or "what did we decide about X" questions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Question to answer from memory',
        },
        max_tokens: {
          type: 'number',
          description: 'Max tokens for the answer (default: 2000)',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const query = args.query as string;
      const maxTokens = (args.max_tokens as number) ?? 2000;

      // 1. Search summaries first (they're higher-signal)
      const summaryHits = await searchEngine.search(query, {
        scope: 'summaries',
        limit: 5,
      });

      let contextText: string;

      if (summaryHits.length > 0) {
        // 2a. Expand top summary hits to source messages
        const contextParts: string[] = [];
        for (const hit of summaryHits.slice(0, 3)) {
          const expanded = await expander.expandDeep(hit.id, 2);
          if (expanded) {
            contextParts.push(
              `### Summary (${expanded.summary.kind})\n${expanded.summary.content}`,
            );
            if (expanded.sourceMessages.length > 0) {
              const msgLines = expanded.sourceMessages
                .slice(0, 10)
                .map((m) => `[${m.role}] ${m.content.slice(0, 300)}`)
                .join('\n');
              contextParts.push(`**Source messages:**\n${msgLines}`);
            }
          }
        }

        if (contextParts.length === 0) {
          return 'Found summaries but could not expand them.';
        }
        contextText = contextParts.join('\n\n---\n\n');
      } else {
        // 2b. Fall back to direct message search
        const msgHits = await searchEngine.search(query, {
          scope: 'messages',
          limit: 10,
        });

        if (msgHits.length === 0) {
          return 'No relevant context found in memory.';
        }

        contextText = msgHits
          .map((h) => `[${h.agent}/${h.role}] ${h.content.slice(0, 500)}`)
          .join('\n\n');
      }

      // 3. Send context + question to Rivet Local
      return await queryLlm(endpoint, model, query, contextText, maxTokens);
    },
  };
}

// ---------------------------------------------------------------------------
// LLM call for expand_query
// ---------------------------------------------------------------------------

async function queryLlm(
  endpoint: string,
  model: string,
  query: string,
  context: string,
  maxTokens: number,
): Promise<string> {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a memory assistant. Answer the question using ONLY the provided context. ' +
              'Be concise and specific. If the context does not contain enough information, say so.',
          },
          {
            role: 'user',
            content: `## Context from conversation history:\n\n${context}\n\n## Question:\n${query}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return `Rivet Local query failed: ${response.status} ${response.statusText}`;
    }

    const data = await response.json() as Record<string, unknown>;
    return data.choices?.[0]?.message?.content ?? 'No answer generated.';
  } catch (err: any) {
    return `Failed to query Rivet Local: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?';
}
