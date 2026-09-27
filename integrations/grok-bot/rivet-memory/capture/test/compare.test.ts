import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { compareInput, formatCompareTable } from '../src/compare.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

it('prints a before/after table for every fixture sample', () => {
  const files = readdirSync(FIX)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .sort()
  const rows = files.map((name) => ({
    name,
    result: compareInput(readFileSync(join(FIX, name), 'utf8'), {
      sessionKey: 'grokbot-rivet-grokbot',
      agent: 'rivet-grokbot',
      agentId: '6a155e75-0dd5-4c8a-8391-994878ed683a',
    }),
  }))
  const table = formatCompareTable(rows)
  console.log(`\n${table}\n`)
  expect(table).toContain('ondisk-rivet-first-run-0-240.jsonl')
  expect(table).toContain('page-rivet-this-conversation-3040-3056.txt')
  expect(table).toContain('page-maggie-0-20.txt')
  for (const { result } of rows) {
    expect(result.after.rows).toBeGreaterThan(0)
  }
})
