import { describe, it, expect } from 'vitest'
import {
  REVIEWED_TAGS_HEADER,
  RULE_TAGS_HEADER,
  WIKI_EXTRACT_SYSTEM_PROMPT,
  formatExtractionPrompt,
  parseWikiPatches,
} from './prompts.js'

const AT = '2026-07-07T00:00:00Z'

describe('parseWikiPatches', () => {
  it('parses a clean array and normalizes slugs', () => {
    const { patches, rejected } = parseWikiPatches(
      JSON.stringify([
        {
          action: 'create',
          slug: 'GERTY vLLM Stack',
          title: 'GERTY vLLM stack',
          entities: ['host:hv-c'],
          current_state: 'Deckard serves qwen-27b on :8003.',
          history_entry: { date: '2026-07-07', title: 'Cutover', body: '- moved' },
        },
      ]),
      AT,
    )
    expect(rejected).toEqual([])
    expect(patches[0]).toMatchObject({
      action: 'create',
      slug: 'gerty-vllm-stack',
      verifiedAt: AT,
      historyEntry: { date: '2026-07-07', title: 'Cutover' },
    })
  })

  it('tolerates a fenced block; drops invalid entries without throwing', () => {
    const raw = '```json\n[{"action":"update","slug":"ok","current_state":"x"},{"action":"nuke","slug":"bad"},{"action":"update","slug":""},"garbage"]\n```'
    const { patches, rejected } = parseWikiPatches(raw, AT)
    expect(patches).toHaveLength(1)
    expect(patches[0].slug).toBe('ok')
    expect(rejected).toHaveLength(3)
  })

  it('empty array and unparseable input degrade cleanly', () => {
    expect(parseWikiPatches('[]', AT).patches).toEqual([])
    const bad = parseWikiPatches('the summary contains no topics', AT)
    expect(bad.patches).toEqual([])
    expect(bad.rejected[0]).toContain('unparseable')
  })

  it('malformed history_entry dates are dropped from the patch, not fatal', () => {
    const { patches } = parseWikiPatches(
      JSON.stringify([
        { action: 'update', slug: 'x', history_entry: { date: 'yesterday', body: 'b' } },
      ]),
      AT,
    )
    expect(patches[0].historyEntry).toBeUndefined()
  })
})

describe('patch cap', () => {
  it('caps at 3 patches regardless of what the LLM emits', () => {
    const many = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({ action: 'create', slug: `t${i}`, current_state: 'x' })),
    )
    const { patches, rejected } = parseWikiPatches(many, '2026-07-07T00:00:00Z')
    expect(patches).toHaveLength(3)
    expect(rejected.some((r) => r.includes('patch cap'))).toBe(true)
  })
})

describe('formatExtractionPrompt', () => {
  it('includes candidates and the no-candidates fallback', () => {
    const withC = formatExtractionPrompt({
      summary: 's',
      summaryDate: '2026-07-07',
      agent: 'rivet',
      candidates: [{ slug: 'a', title: 'A', aliases: ['aa'], currentState: 'state' }],
    })
    expect(withC).toContain('### a — A')
    expect(withC).toContain('aliases: aa')
    const without = formatExtractionPrompt({ summary: 's', summaryDate: '2026-07-07', candidates: [] })
    expect(without).toContain('no matching durable topics yet')
  })

  it('renders reviewed and working-directory tags as separate sections, between the summary and the candidates', () => {
    const prompt = formatExtractionPrompt({
      summary: 'THE-SUMMARY',
      summaryDate: '2026-10-02',
      candidates: [
        { slug: 'a', title: 'A', aliases: [], currentState: 's' },
        { slug: 'b', title: 'B', aliases: [], currentState: 's', fromTag: true },
      ],
      reviewedTags: ['project:TenPAL', 'topic:wiki', ''],
      ruleTags: ['project:rivet\nOS'],
    })
    const lines = prompt.split('\n')
    expect(lines).toContain(REVIEWED_TAGS_HEADER)
    expect(lines).toContain('project:TenPAL, topic:wiki')
    expect(lines).toContain(RULE_TAGS_HEADER)
    expect(lines).toContain('project:rivet OS')
    const at = (needle: string): number => lines.findIndex((l) => l === needle)
    expect(at('THE-SUMMARY')).toBeLessThan(at(REVIEWED_TAGS_HEADER))
    expect(at(REVIEWED_TAGS_HEADER)).toBeLessThan(at(RULE_TAGS_HEADER))
    expect(at(RULE_TAGS_HEADER)).toBeLessThan(
      lines.findIndex((l) => l.startsWith('## Existing durable topic candidates')),
    )
    expect(prompt).toContain('### b — B (tag hint)')
    expect(prompt).toContain('### a — A\n')
  })

  it('omits both tag sections when there are no tags', () => {
    const plain = formatExtractionPrompt({
      summary: 's',
      summaryDate: '2026-10-02',
      candidates: [],
      reviewedTags: [],
      ruleTags: [],
    })
    expect(plain).not.toContain(REVIEWED_TAGS_HEADER)
    expect(plain).not.toContain(RULE_TAGS_HEADER)
  })

  it('the system prompt keeps the unreviewed directory tag out of entities', () => {
    expect(WIKI_EXTRACT_SYSTEM_PROMPT).toMatch(/working-directory tag[^\n]*automatic and unreviewed/i)
    expect(WIKI_EXTRACT_SYSTEM_PROMPT).toMatch(/Never add it as an entity/)
  })
})

describe('v7 summary_delta + article_patches', () => {
  it('parses summary_delta, article_patches, related, and current_state alias', () => {
    const { patches, rejected } = parseWikiPatches(
      JSON.stringify([
        {
          action: 'update',
          slug: 'deckard-40b',
          related: ['hv-c', '1cat-vllm'],
          summary_delta: 'Now serves MTP k=4.',
          article_patches: [
            { heading: 'Configuration', mode: 'merge', body: 'MTP k=4 on :8003.' },
          ],
          history_entry: { date: '2026-07-27', title: 'MTP', body: '- k=4' },
        },
        {
          action: 'create',
          slug: 'new-host',
          current_state: 'A new durable host.',
        },
      ]),
      AT,
    )
    expect(rejected).toEqual([])
    expect(patches[0]).toMatchObject({
      slug: 'deckard-40b',
      summaryDelta: 'Now serves MTP k=4.',
      addRelated: ['hv-c', '1cat-vllm'],
    })
    expect(patches[0].articlePatches?.[0]).toMatchObject({
      heading: 'Configuration',
      mode: 'merge',
    })
    expect(patches[1].currentState).toBe('A new durable host.')
  })
})
