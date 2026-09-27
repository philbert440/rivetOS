import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'

const BOB = '00df02ea-4f5f-4d3e-945a-864e1c9c78dc'

function page(a: number, text: string): string {
  return `Transcript of agent "Bob" (${BOB}), positions ${String(a)}–${String(a)} of 2:\n${JSON.stringify(
    {
      role: 'user',
      message: { content: [{ type: 'text', text }] },
    },
  )}\n`
}

describe('backfill CLI', () => {
  it('skips unidentified files instead of tagging grokbot-unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-unident-'))
    writeFileSync(
      join(dir, 'orphan.jsonl'),
      `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    )
    const out = join(dir, 'spool')
    mkdirSync(out)
    const logs: string[] = []
    const errs: string[] = []
    const log = console.log
    const err = console.error
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    }
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    }
    try {
      const code = await main(['backfill', '--input', dir, '--write', '--out', out])
      expect(code).toBe(0)
      expect(errs.some((l) => l.includes('SKIP unidentified'))).toBe(true)
      expect(readdirSync(out)).toEqual([])
      expect(logs.some((l) => l.includes('grokbot-unknown'))).toBe(false)
    } finally {
      console.log = log
      console.error = err
    }
  })

  it('refuses --write when overlapping pages disagree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-conflict-'))
    writeFileSync(join(dir, 'a.txt'), page(10, 'one'))
    writeFileSync(join(dir, 'b.txt'), page(10, 'OTHER'))
    const out = join(dir, 'spool')
    mkdirSync(out)
    const errs: string[] = []
    const err = console.error
    const log = console.log
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    }
    console.log = () => {}
    try {
      const code = await main([
        'backfill',
        '--input',
        dir,
        '--format',
        'page',
        '--write',
        '--out',
        out,
      ])
      expect(code).toBe(3)
      expect(errs.some((l) => l.includes('CONFLICT positions'))).toBe(true)
      expect(existsSync(join(out, 'grokbot-bob-v3.jsonl'))).toBe(false)
    } finally {
      console.error = err
      console.log = log
    }
  })
})
