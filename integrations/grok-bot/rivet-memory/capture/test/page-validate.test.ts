import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ingestPages } from '../src/ingest-pages.js'
import {
  applySpoolConsensus,
  collapseRanges,
  formatNeedsLine,
  inspectPageText,
  neededPositions,
} from '../src/page-validate.js'
import { ALPHA_ID, BETA_ID } from './ids.js'

function rec(text: string) {
  return JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } })
}

describe('page inspect', () => {
  it('rejects a two-position header with one JSON line and leaves the range as gaps', () => {
    const got = inspectPageText(
      `Transcript of alpha, positions 12–13 of 40:\n${rec('only one')}\n`,
    )
    expect(got.error?.code).toBe('range_mismatch')
    expect(got.error?.detail).toMatch(/does not match 1 JSON line/)
    expect(got.header).toMatchObject({ a: 12, b: 13, total: 40 })
  })

  it('rejects a body line that is not JSON', () => {
    const got = inspectPageText(
      `Transcript of alpha, positions 12–12 of 40:\n{not-json\n`,
    )
    expect(got.error?.code).toBe('json_parse')
    expect(got.error?.detail).toMatch(/line 2/)
  })
})

describe('live spool consensus', () => {
  it('skips a smaller leftover total and a different agent id', () => {
    const pages = applySpoolConsensus(
      [
        {
          file: { path: '/tmp/alpha-40.txt', slug: 'alpha', before: 40 },
          header: { a: 38, b: 39, total: 40, thisConversation: false },
          records: [{}, {}],
          sourceLines: [1, 2],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
        {
          file: { path: '/tmp/alpha-12.txt', slug: 'alpha', before: 12 },
          header: { a: 10, b: 11, total: 12, thisConversation: false },
          records: [{}, {}],
          sourceLines: [1, 2],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
        {
          file: { path: '/tmp/alpha-39.txt', slug: 'alpha', before: 39 },
          header: {
            a: 36,
            b: 37,
            total: 40,
            thisConversation: false,
            id: ALPHA_ID,
          },
          records: [{}, {}],
          sourceLines: [1, 2],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
        {
          file: { path: '/tmp/alpha-38.txt', slug: 'alpha', before: 38 },
          header: {
            a: 34,
            b: 35,
            total: 40,
            thisConversation: false,
            id: BETA_ID,
          },
          records: [{}, {}],
          sourceLines: [1, 2],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
      ],
      { live: true },
    )
    expect(pages[0]?.ok).toBe(true)
    expect(pages[1]?.ok).toBe(false)
    expect(pages[1]?.error?.code).toBe('total_mismatch')
    expect(pages[1]?.skippedPositions).toEqual([10, 11])
    expect(pages[1]?.reason).toMatch(/positions 10-11 left as gaps/)
    expect(pages[2]?.ok).toBe(false)
    expect(pages[2]?.error?.code).toBe('agent_id_mismatch')
    expect(pages[3]?.ok).toBe(true)
  })

  it('does not apply total consensus unless --live', () => {
    const pages = applySpoolConsensus(
      [
        {
          file: { path: '/tmp/alpha-3.txt', slug: 'alpha', before: 3 },
          header: { a: 1, b: 2, total: 3, thisConversation: false },
          records: [{}, {}],
          sourceLines: [1, 2],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
        {
          file: { path: '/tmp/alpha-1.txt', slug: 'alpha', before: 1 },
          header: { a: 0, b: 0, total: 1, thisConversation: false },
          records: [{}],
          sourceLines: [1],
          hasOlderFooter: false,
          ok: true,
          skippedPositions: [],
        },
      ],
      { live: false },
    )
    expect(pages.every((page) => page.ok)).toBe(true)
  })
})

describe('needs ranges', () => {
  it('formats one line per hole and skips an up-to-date range', () => {
    expect(formatNeedsLine('alpha', 13, 20)).toBe('needs: alpha positions 13-20')
    expect(collapseRanges([13, 14, 15, 25, 26])).toEqual([
      [13, 15],
      [25, 26],
    ])
    const missing = neededPositions({
      covered: new Set([13, 14, 15]),
      lastIngestedPosition: 12,
      total: 40,
    })
    expect(missing[0]).toBe(16)
    expect(missing[missing.length - 1]).toBe(39)
    expect(
      neededPositions({
        covered: new Set(),
        lastIngestedPosition: 39,
        total: 40,
      }),
    ).toEqual([])
  })
})

describe('ingest-pages does not rewrite a rejected file', () => {
  it('leaves a range-mismatched page on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-page-val-'))
    const path = join(dir, 'alpha-13.txt')
    const body = `Transcript of alpha, positions 12–13 of 40:\n${rec('only one')}\n`
    writeFileSync(path, body)
    const errs: string[] = []
    const err = console.error
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    }
    try {
      const result = await ingestPages(dir, { live: true })
      const bot = result.bots[0]
      expect(bot?.pagesFailed).toBe(1)
      expect(bot?.skippedGaps).toBe(2)
      expect(bot?.new).toBe(0)
    } finally {
      console.error = err
    }
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(errs.join('\n')).toMatch(/SKIP malformed page alpha-13.txt/)
    expect(errs.join('\n')).toMatch(/positions 12-13 left as gaps/)
  })
})
