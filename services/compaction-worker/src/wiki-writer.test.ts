import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WikiWriter } from './wiki-writer.js'

describe('WikiWriter', () => {
  let root: string
  let writer: WikiWriter

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wiki-writer-'))
    writer = new WikiWriter(root)
    await writer.ensureRepo()
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('create → commit; update archives prior state; no-op patch reuses HEAD sha', async () => {
    const first = await writer.apply(
      {
        action: 'create',
        slug: 'test-topic',
        title: 'Test Topic',
        currentState: 'v1',
        verifiedAt: '2026-07-07T00:00:00Z',
      },
      { summaryId: '11111111-1111-1111-1111-111111111111' },
    )
    expect(first.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(first.page.currentState).toBe('v1')

    const second = await writer.apply(
      {
        action: 'update',
        slug: 'test-topic',
        currentState: 'v2',
        historyEntry: { date: '2026-07-08', title: 'Bump', body: '- v2' },
        verifiedAt: '2026-07-08T00:00:00Z',
      },
      { summaryId: '22222222-2222-2222-2222-222222222222' },
    )
    expect(second.gitSha).not.toBe(first.gitSha)
    const md = await readFile(join(root, 'topics', 'test-topic.md'), 'utf8')
    expect(md).toContain('v2')
    expect(md).toContain('Superseded current state')

    // Identical patch → no new commit.
    const third = await writer.apply(
      {
        action: 'update',
        slug: 'test-topic',
        currentState: 'v2',
        historyEntry: { date: '2026-07-08', title: 'Bump', body: '- v2' },
        verifiedAt: '2026-07-08T00:00:00Z',
      },
      { summaryId: '33333333-3333-3333-3333-333333333333' },
    )
    expect(third.gitSha).toBe(second.gitSha)
  })

  it('human edit survives: extractor patch archives the human state to History', async () => {
    const { writeFile } = await import('node:fs/promises')
    const humanMd = (await readFile(join(root, 'topics', 'test-topic.md'), 'utf8')).replace(
      'v2',
      'human-edited truth',
    )
    await writeFile(join(root, 'topics', 'test-topic.md'), humanMd)
    const applied = await writer.apply(
      {
        action: 'update',
        slug: 'test-topic',
        currentState: 'v3 from extractor',
        verifiedAt: '2026-07-09T00:00:00Z',
      },
      { summaryId: '44444444-4444-4444-4444-444444444444' },
    )
    expect(applied.page.currentState).toBe('v3 from extractor')
    expect(applied.page.history.some((h) => h.body.includes('human-edited truth'))).toBe(true)
  })
})
