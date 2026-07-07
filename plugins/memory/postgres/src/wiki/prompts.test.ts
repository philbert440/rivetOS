import { describe, it, expect } from 'vitest'
import { formatExtractionPrompt, parseWikiPatches } from './prompts.js'

const AT = '2026-07-07T00:00:00Z'

describe('parseWikiPatches', () => {
  it('parses a clean array and normalizes slugs', () => {
    const { patches, rejected } = parseWikiPatches(
      JSON.stringify([
        {
          action: 'create',
          slug: 'GERTY vLLM Stack',
          title: 'GERTY vLLM stack',
          entities: ['host:pve3'],
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
    expect(withC).toContain('### a — A (aliases: aa)')
    const without = formatExtractionPrompt({ summary: 's', summaryDate: '2026-07-07', candidates: [] })
    expect(without).toContain('no matching pages yet')
  })
})
