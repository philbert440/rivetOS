/**
 * memory_search — unified search + auto-expand tool.
 */

import type { Tool } from '@rivetos/types'
import type { SearchEngine, SearchHit } from '../search.js'
import type { Expander } from '../expand.js'
import type { ExpandedSummary, MemoryToolsConfig } from './helpers.js'
import { fmtDate, queryLlm, MS_PER_DAY } from './helpers.js'

export function createSearchTool(
  searchEngine: SearchEngine,
  expander: Expander,
  config?: MemoryToolsConfig,
): Tool {
  return {
    name: 'memory_search',
    description:
      'Search conversation history and summaries. Automatically expands promising summary hits ' +
      'to show children and source messages. Returns structured, scored results. ' +
      'Use for finding past decisions, discussions, context, or answering "what did we decide about X" questions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — natural language question or keywords',
        },
        mode: {
          type: 'string',
          enum: ['fts', 'trigram', 'regex'],
          description:
            'Search mode: fts (full-text, default), trigram (fuzzy/typo-tolerant), regex (pattern match)',
        },
        scope: {
          type: 'string',
          enum: ['messages', 'summaries', 'both'],
          description: 'Where to search (default: both)',
        },
        limit: { type: 'number', description: 'Max top-level results (default: 10)' },
        agent: { type: 'string', description: 'Filter by agent (opus, grok, etc.)' },
        since: {
          type: 'string',
          description: 'Only return results after this date (ISO timestamp, e.g. 2025-01-15)',
        },
        before: {
          type: 'string',
          description: 'Only return results before this date (ISO timestamp, e.g. 2025-06-01)',
        },
        expand: {
          type: 'boolean',
          description: 'Auto-expand top summary hits to show source messages (default: true)',
        },
        synthesize: {
          type: 'boolean',
          description:
            'Use LLM to synthesize a focused answer from results (default: false). Requires Rivet Local.',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const query = args.query as string
      const mode = (args.mode as string | undefined) ?? 'fts'
      const scope = (args.scope as string | undefined) ?? 'both'
      const limit = Math.min(Math.max((args.limit as number | undefined) ?? 10, 1), 50)
      const agent = args.agent as string | undefined
      const since = args.since as string | undefined
      const before = args.before as string | undefined
      const shouldExpand = args.expand !== false // default true
      const shouldSynthesize = args.synthesize === true

      // 1. Search
      const results = await searchEngine.search(query, {
        mode: mode as 'fts' | 'trigram' | 'regex',
        scope: scope as 'messages' | 'summaries' | 'both',
        limit,
        agent,
        since,
        before,
      })

      if (results.length === 0) return 'No results found.'

      // 2. Separate summaries from messages
      const summaryHits = results.filter((r) => r.type === 'summary')
      const messageHits = results.filter((r) => r.type === 'message')

      // 3. Auto-expand top summary hits
      const expandedSummaries: ExpandedSummary[] = []

      if (shouldExpand && summaryHits.length > 0) {
        const toExpand = summaryHits.slice(0, 3)
        for (const hit of toExpand) {
          try {
            const depth = hit.score > 0.5 ? 3 : 2
            const expanded = await expander.expandDeep(hit.id, depth)
            if (expanded) {
              expandedSummaries.push({
                hit,
                children: expanded.children,
                sourceMessages: expanded.sourceMessages,
              })
            }
          } catch {
            expandedSummaries.push({ hit, children: [], sourceMessages: [] })
          }
        }
      }

      // 4. Build structured output
      const sections: string[] = []
      sections.push(`## Memory Search: "${query}"`)
      sections.push(
        `Found ${String(results.length)} results (${String(summaryHits.length)} summaries, ${String(messageHits.length)} messages)\n`,
      )

      // Expanded summaries first (highest signal)
      if (expandedSummaries.length > 0) {
        formatExpandedSummaries(sections, expandedSummaries, summaryHits)
      } else if (summaryHits.length > 0) {
        formatUnexpandedSummaries(sections, summaryHits)
      }

      // Messages
      if (messageHits.length > 0) {
        formatMessages(sections, messageHits)
      }

      // 5. Optional LLM synthesis
      if (shouldSynthesize && config?.compactorEndpoint) {
        const contextText = sections.join('\n')
        const answer = await queryLlm(
          config.compactorEndpoint,
          config.compactorModel ?? 'rivet-v0.1',
          query,
          contextText,
          2000,
          config.compactorApiKey,
        )
        return `## Synthesized Answer\n\n${answer}\n\n---\n\n${sections.join('\n')}`
      }

      return sections.join('\n')
    },
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatExpandedSummaries(
  sections: string[],
  expanded: ExpandedSummary[],
  allSummaryHits: SearchHit[],
): void {
  sections.push('### Summaries (expanded)\n')
  for (const { hit, children, sourceMessages } of expanded) {
    const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
    const period =
      hit.earliestAt && hit.latestAt
        ? `${fmtDate(hit.earliestAt)} → ${fmtDate(hit.latestAt)}`
        : fmtDate(hit.createdAt)

    sections.push(
      `**[${hit.kind ?? 'summary'}]** (${String(age)}d ago, score: ${hit.score.toFixed(3)}, period: ${period})`,
    )
    sections.push(hit.content)

    if (children.length > 0) {
      sections.push(`\n  **Children (${String(children.length)}):**`)
      for (const child of children.slice(0, 5)) {
        const preview =
          child.content.length > 200 ? child.content.slice(0, 200) + '…' : child.content
        sections.push(`  - [${child.kind}] ${preview}`)
      }
      if (children.length > 5) {
        sections.push(`  - ... and ${String(children.length - 5)} more`)
      }
    }

    if (sourceMessages.length > 0) {
      sections.push(`\n  **Source messages (${String(sourceMessages.length)}):**`)
      for (const msg of sourceMessages.slice(0, 8)) {
        const msgContent = msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content
        sections.push(`  > [${msg.role}] ${msgContent}`)
      }
      if (sourceMessages.length > 8) {
        sections.push(`  > ... and ${String(sourceMessages.length - 8)} more messages`)
      }
    }

    sections.push('')
  }

  // Show remaining unexpanded summaries
  const remaining = allSummaryHits.slice(3)
  if (remaining.length > 0) {
    sections.push('### Additional summaries (not expanded)\n')
    for (const hit of remaining) {
      const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
      const preview = hit.content.length > 300 ? hit.content.slice(0, 300) + '…' : hit.content
      sections.push(
        `- [${hit.kind ?? 'summary'}] (${String(age)}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
      )
    }
    sections.push('')
  }
}

function formatUnexpandedSummaries(sections: string[], summaryHits: SearchHit[]): void {
  sections.push('### Summaries\n')
  for (const hit of summaryHits) {
    const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
    const preview = hit.content.length > 300 ? hit.content.slice(0, 300) + '…' : hit.content
    sections.push(
      `- [${hit.kind ?? 'summary'}/${hit.id}] (${String(age)}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
    )
  }
  sections.push('')
}

function formatMessages(sections: string[], messageHits: SearchHit[]): void {
  sections.push('### Messages\n')
  for (const hit of messageHits) {
    const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
    const preview = hit.content.length > 400 ? hit.content.slice(0, 400) + '…' : hit.content
    sections.push(
      `- [${hit.agent}/${hit.role}] (${String(age)}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
    )
  }
}
