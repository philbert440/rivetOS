import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cmdNeeds, cmdSpoolState, main } from '../src/cli.js'
import {
  getAgentWatermark,
  readSpoolState,
  recordOkIngest,
  resolveSpoolStatePath,
  TotalDecreasedError,
  writeSpoolState,
} from '../src/spool-state.js'
import { ALPHA_ID } from './ids.js'

const prev = {
  state: process.env.GROKBOT_SPOOL_STATE,
  cap: process.env.GROKBOT_CAPTURE_DIR,
}

afterEach(() => {
  if (prev.state === undefined) delete process.env.GROKBOT_SPOOL_STATE
  else process.env.GROKBOT_SPOOL_STATE = prev.state
  if (prev.cap === undefined) delete process.env.GROKBOT_CAPTURE_DIR
  else process.env.GROKBOT_CAPTURE_DIR = prev.cap
})

describe('spool-state path and watermark', () => {
  it('resolves GROKBOT_SPOOL_STATE, then GROKBOT_CAPTURE_DIR/spool-state.json', () => {
    process.env.GROKBOT_SPOOL_STATE = '/tmp/custom-spool-state.json'
    expect(resolveSpoolStatePath()).toBe('/tmp/custom-spool-state.json')
    delete process.env.GROKBOT_SPOOL_STATE
    process.env.GROKBOT_CAPTURE_DIR = '/tmp/capture-dir'
    expect(resolveSpoolStatePath()).toBe('/tmp/capture-dir/spool-state.json')
  })

  it('advances the watermark only after recordOkIngest and flags a lower total', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-spool-'))
    const path = join(dir, 'spool-state.json')
    const first = recordOkIngest({ agents: {} }, ALPHA_ID, {
      position: 12,
      total: 40,
      at: '2026-10-06T16:00:00.000Z',
    })
    writeSpoolState(path, first)
    expect(getAgentWatermark(readSpoolState(path), ALPHA_ID)).toEqual({
      lastIngestedPosition: 12,
      lastIngestAt: '2026-10-06T16:00:00.000Z',
      lastSeenTotal: 40,
    })
    const before = readFileSync(path, 'utf8')
    expect(() => recordOkIngest(readSpoolState(path), ALPHA_ID, { position: 13, total: 12 })).toThrow(
      TotalDecreasedError,
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
    const again = recordOkIngest(readSpoolState(path), ALPHA_ID, {
      position: 15,
      total: 40,
      at: '2026-10-06T17:00:00.000Z',
    })
    expect(again.agents[ALPHA_ID]?.lastIngestedPosition).toBe(15)
    expect(getAgentWatermark({ agents: {} }, ALPHA_ID).lastIngestedPosition).toBeNull()
  })
})

describe('spool-state / needs CLI', () => {
  it('get / record / needs print the capturer-facing lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-spool-cli-'))
    const state = join(dir, 'spool-state.json')
    const pages = join(dir, 'pages')
    writeFileSync(join(dir, 'keep'), '')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(pages)
    writeFileSync(
      join(pages, 'alpha-16.txt'),
      [
        'Transcript of alpha, positions 13–15 of 40:',
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'covered' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'still' }] },
        }),
        '',
      ].join('\n'),
    )

    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    const write = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s))
      return true
    }) as typeof process.stdout.write
    console.log = (...a: unknown[]) => {
      out.push(a.map(String).join(' '))
    }
    console.error = (...a: unknown[]) => {
      err.push(a.map(String).join(' '))
    }
    try {
      expect(cmdSpoolState(['get', '--state', state, '--agent-id', ALPHA_ID])).toBe(0)
      expect(chunks.join('')).toContain('"lastIngestedPosition":null')
      chunks.length = 0
      expect(
        cmdSpoolState([
          'record',
          '--state',
          state,
          '--agent-id',
          ALPHA_ID,
          '--position',
          '12',
          '--total',
          '40',
        ]),
      ).toBe(0)
      expect(chunks.join('')).toContain('"lastIngestedPosition":12')
      chunks.length = 0
      expect(
        cmdSpoolState([
          'record',
          '--state',
          state,
          '--agent-id',
          ALPHA_ID,
          '--position',
          '13',
          '--total',
          '12',
        ]),
      ).toBe(3)
      expect(err.join('\n')).toMatch(/TOTAL_DECREASED/)
      expect(JSON.parse(readFileSync(state, 'utf8')).agents[ALPHA_ID].lastSeenTotal).toBe(40)
      chunks.length = 0
      expect(cmdNeeds(['--input', pages, '--state', state, '--total', 'alpha=40'])).toBe(0)
      expect(chunks.join('').trim()).toBe('needs: alpha positions 16-39')
      chunks.length = 0
      expect(cmdNeeds(['--input', pages, '--state', state, '--total', 'alpha=16'])).toBe(0)
      expect(chunks.join('')).toBe('')
      const help = await main(['help'])
      expect(help).toBe(0)
    } finally {
      process.stdout.write = write
      console.log = log
      console.error = error
    }
    expect(out.join('\n') + chunks.join('')).toBeDefined()
  })
})
