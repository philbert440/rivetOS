import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { compareInput, formatCompareTable } from '../src/compare.js'
import { ALPHA_ID } from './ids.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

it('prints a before/after table for every fixture sample', () => {
  const files = readdirSync(FIX)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .sort()
  const rows = files.map((name) => ({
    name,
    result: compareInput(readFileSync(join(FIX, name), 'utf8'), {
      sessionKey: 'grokbot-alpha',
      agent: 'grokbot-alpha',
      agentId: ALPHA_ID,
    }),
  }))
  const table = formatCompareTable(rows)
  console.log(`\n${table}\n`)
  expect(table).toContain('ondisk-alpha-first-run-0-240.jsonl')
  expect(table).toContain('page-alpha-this-conversation-3040-3056.txt')
  expect(table).toContain('page-gamma-0-20.txt')
  expect(table).toContain('after user')
  expect(table).toContain('after asst')
  for (const { name, result } of rows) {
    expect(result.after.rows, name).toBeGreaterThan(0)
    expect(result.after.avgChars.user, name).toBeGreaterThanOrEqual(0)
    expect(result.after.avgChars.assistant, name).toBeGreaterThanOrEqual(0)
    const beforeNoise = Object.values(result.before.noise).reduce((a, b) => a + b, 0)
    const afterNoise = Object.values(result.after.noise).reduce((a, b) => a + b, 0)
    if (beforeNoise > 0) expect(afterNoise, name).toBeLessThanOrEqual(beforeNoise)
    if (result.before.avgChars.user > 0 && result.after.stats.user > 0) {
      expect(result.after.avgChars.user, name).toBeLessThanOrEqual(result.before.avgChars.user)
    }
  }
  const firstRun = rows.find((r) => r.name === 'ondisk-alpha-first-run-0-240.jsonl')
  expect(firstRun).toBeTruthy()
  expect(firstRun!.result.after.stats.systemEvents).toBeGreaterThan(0)
  expect(firstRun!.result.after.avgChars.user).toBeLessThan(firstRun!.result.before.avgChars.user)
})
