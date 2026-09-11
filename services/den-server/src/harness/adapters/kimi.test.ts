import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  kimiDeltasFromTurns,
  kimiTurnsFromLines,
  watchKimiWire,
  type KimiLiveDelta,
} from './kimi.js'
import { objectsFromLines } from './parse-helpers.js'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'kimi-wire-live.jsonl',
)

const user = {
  type: 'context.append_message',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'review the diff' }],
    origin: { kind: 'user' },
  },
}
const ev = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'context.append_loop_event',
  event,
})

async function until<T>(pick: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = pick()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('kimiTurnsFromLines', () => {
  it('folds text, thinking and usage the way wire.jsonl step.end stamps them', () => {
    const turns = kimiTurnsFromLines([
      user,
      { type: 'llm.request', model: 'kimi-k2', kind: 'chat' },
      ev({ type: 'step.begin' }),
      ev({ type: 'content.part', part: { type: 'think', think: 'weighing it' } }),
      ev({
        type: 'tool.call',
        toolCallId: 'Bash_0',
        name: 'Bash',
        args: { command: 'git diff' },
      }),
      ev({ type: 'tool.result', toolCallId: 'Bash_0', result: { isError: true } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'looks good' } }),
      ev({
        type: 'step.end',
        usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 40 },
      }),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'review the diff' },
      {
        role: 'assistant',
        text: 'looks good',
        stopReason: 'end_turn',
        lastBlock: 'text',
        complete: true,
        thinking: 'weighing it',
        tools: [{ name: 'Bash', status: 'error', args: { command: 'git diff' }, id: 'Bash_0' }],
        usage: { promptTokens: 125, completionTokens: 40, cachedTokens: 20 },
        model: 'kimi-k2',
      },
    ])
  })
})

describe('kimiDeltasFromTurns', () => {
  it('emits nothing on the first snapshot (history is transcript, not deltas)', () => {
    const next = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'think', think: 'plan' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'done' } }),
    ])
    expect(kimiDeltasFromTurns(undefined, next)).toEqual([])
    expect(kimiDeltasFromTurns([], next)).toEqual([
      { kind: 'reasoning', text: 'plan' },
      { kind: 'assistant', text: 'done' },
    ])
  })

  it('emits thinking then text suffixes as the last assistant turn grows', () => {
    const start = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'think', think: 'weighing ' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'looks ' } }),
    ])
    const grewThink = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'think', think: 'weighing ' } }),
      ev({ type: 'content.part', part: { type: 'think', think: 'it' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'looks ' } }),
    ])
    expect(kimiDeltasFromTurns(start, grewThink)).toEqual([{ kind: 'reasoning', text: 'it' }])

    const grewText = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'think', think: 'weighing ' } }),
      ev({ type: 'content.part', part: { type: 'think', think: 'it' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'looks ' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'good' } }),
    ])
    expect(kimiDeltasFromTurns(grewThink, grewText)).toEqual([{ kind: 'assistant', text: '\n\ngood' }])
  })

  it('does not emit when the tail is a user turn or the parse shrinks', () => {
    const asst = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'text', text: 'done' } }),
    ])
    const plusUser = [
      ...asst,
      { role: 'user' as const, text: 'again' },
    ]
    expect(kimiDeltasFromTurns(asst, plusUser)).toEqual([])
    expect(kimiDeltasFromTurns(asst, [asst[0]!])).toEqual([])
  })
})

describe('watchKimiWire', () => {
  let off: (() => void) | undefined

  afterEach(() => {
    off?.()
    off = undefined
  })

  it('emits assistant/reasoning deltas as a wire.jsonl fixture grows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-wire-'))
    const file = join(dir, 'wire.jsonl')
    writeFileSync(file, readFileSync(FIXTURE, 'utf8'))

    const seen: KimiLiveDelta[] = []
    off = watchKimiWire(file, (d) => seen.push(d), { debounceMs: 0, safetyPollMs: 20 })
    expect(seen).toEqual([])

    appendFileSync(
      file,
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'think', think: 'it' } },
      }) + '\n',
    )
    await until(() => seen.find((d) => d.kind === 'reasoning' && d.text === 'it'))

    appendFileSync(
      file,
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'good' } },
      }) + '\n',
    )
    await until(() => seen.find((d) => d.kind === 'assistant' && d.text === '\n\ngood'))

    expect(seen).toEqual([
      { kind: 'reasoning', text: 'it' },
      { kind: 'assistant', text: '\n\ngood' },
    ])

    // The seed fixture itself must parse: if the watcher replayed history as
    // deltas this assertion is the one that fails.
    const seeded = kimiTurnsFromLines(objectsFromLines(readFileSync(FIXTURE, 'utf8').split('\n')))
    expect(seeded[1]?.thinking).toBe('weighing ')
    expect(seeded[1]?.text).toBe('looks')
  })
})
