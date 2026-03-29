/**
 * Memory Tools — expose LCM search/expand/describe as agent tools.
 *
 * These let any agent search conversation history, drill into summaries,
 * and inspect the summary DAG — same capabilities as OpenClaw's
 * lcm_grep, lcm_expand, lcm_describe, and lcm_expand_query.
 */

import type { Tool } from '@rivetos/types';
import type { LcmSearchEngine } from './search.js';
import type { LcmExpander } from './expand.js';

export function createMemoryTools(
  searchEngine: LcmSearchEngine,
  expander: LcmExpander,
): Tool[] {
  return [
    // -----------------------------------------------------------------
    // memory_grep — search across messages and summaries
    // -----------------------------------------------------------------
    {
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
          mode: (args.mode as any) ?? 'fts',
          scope: (args.scope as any) ?? 'both',
          limit: (args.limit as number) ?? 20,
          agent: args.agent as string | undefined,
        });

        if (results.length === 0) return 'No results found.';

        return results
          .map((r, i) => {
            const age = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000);
            const preview = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content;
            return `${i + 1}. [${r.type}] ${r.agent}/${r.role} (${age}d ago, score: ${r.similarity.toFixed(3)})\n   ${preview}`;
          })
          .join('\n\n');
      },
    },

    // -----------------------------------------------------------------
    // memory_expand — drill into a summary node
    // -----------------------------------------------------------------
    {
      name: 'memory_expand',
      description:
        'Expand a summary to see its children and source messages. ' +
        'Use after memory_grep to drill into a summary for more detail.',
      parameters: {
        type: 'object',
        properties: {
          summary_id: { type: 'string', description: 'Summary ID (e.g., sum_abc123)' },
          depth: { type: 'number', description: 'Max traversal depth (default: 3)' },
          include_messages: { type: 'boolean', description: 'Include source messages at leaves (default: true)' },
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
        sections.push(`Kind: ${result.summary.kind} | Depth: ${result.summary.depth} | Descendants: ${result.summary.descendantCount}`);
        sections.push(`Period: ${result.summary.earliestAt?.toISOString().split('T')[0] ?? '?'} → ${result.summary.latestAt?.toISOString().split('T')[0] ?? '?'}`);
        sections.push(`\n${result.summary.content}`);

        if (result.children.length > 0) {
          sections.push(`\n## Children (${result.children.length})`);
          for (const child of result.children) {
            sections.push(`- ${child.summaryId} (${child.kind}, ${child.descendantCount} descendants)`);
            sections.push(`  ${child.content.slice(0, 200)}${child.content.length > 200 ? '…' : ''}`);
          }
        }

        if (result.sourceMessages.length > 0) {
          sections.push(`\n## Source Messages (${result.sourceMessages.length})`);
          for (const msg of result.sourceMessages) {
            sections.push(`[${msg.role}] ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '…' : ''}`);
          }
        }

        return sections.join('\n');
      },
    },

    // -----------------------------------------------------------------
    // memory_describe — inspect a summary node's metadata
    // -----------------------------------------------------------------
    {
      name: 'memory_describe',
      description:
        'Get metadata about a summary node — kind, depth, time range, token count, model used.',
      parameters: {
        type: 'object',
        properties: {
          summary_id: { type: 'string', description: 'Summary ID to inspect' },
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
          `**Tokens:** ${node.tokenCount}`,
          `**Descendants:** ${node.descendantCount}`,
          `**Period:** ${node.earliestAt?.toISOString() ?? '?'} → ${node.latestAt?.toISOString() ?? '?'}`,
          `**Created:** ${node.createdAt.toISOString()}`,
          `**Model:** ${node.model}`,
          `\n${node.content}`,
        ].join('\n');
      },
    },
  ];
}
