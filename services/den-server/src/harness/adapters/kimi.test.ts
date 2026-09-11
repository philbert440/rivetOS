import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessTranscriptTurn } from '@rivetos/types'
import { kimiDeltasFromTurns, kimiTurnsFromLines, type KimiLiveDelta } from './kimi.js'
import { objectsFromLines, THINKING_TAIL_CHARS } from './parse-helpers.js'

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

/** Test helper: production tails wire.jsonl via the transcript watcher, not this. */
function watchKimiWire(
  path: string,
  onDelta: (d: KimiLiveDelta) => void,
  timings: { debounceMs?: number; safetyPollMs?: number } = {},
): () => void {
  const debounceMs = timings.debounceMs ?? 250
  const safetyPollMs = timings.safetyPollMs ?? 10_000
  let prev: HarnessTranscriptTurn[] | undefined
  let debounce: NodeJS.Timeout | undefined
  let closed = false
  let lastSize = -1
  let lastMtime = -1

  const readTurns = (): HarnessTranscriptTurn[] => {
    if (!existsSync(path)) return []
    return kimiTurnsFromLines(objectsFromLines(readFileSync(path, 'utf8').split('\n')))
  }

  const parse = (): void => {
    if (closed) return
    let next: HarnessTranscriptTurn[]
    try {
      next = readTurns()
      if (existsSync(path)) {
        const st = statSync(path)
        lastSize = st.size
        lastMtime = st.mtimeMs
      }
    } catch {
      return
    }
    const deltas = kimiDeltasFromTurns(prev, next)
    prev = next
    for (const d of deltas) onDelta(d)
  }

  const schedule = (): void => {
    if (closed) return
    if (debounceMs <= 0) {
      parse()
      return
    }
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(parse, debounceMs)
    debounce.unref?.()
  }

  parse()

  let fsWatcher: FSWatcher | undefined
  try {
    fsWatcher = watch(path, () => schedule())
    fsWatcher.on('error', () => undefined)
  } catch {
    // file not there yet — safety poll will pick it up
  }

  const poll = setInterval(() => {
    if (closed) return
    try {
      if (!existsSync(path)) return
      const st = statSync(path)
      if (st.size !== lastSize || st.mtimeMs !== lastMtime) schedule()
    } catch {
      /* gone */
    }
  }, safetyPollMs)
  poll.unref?.()

  return () => {
    closed = true
    if (debounce) clearTimeout(debounce)
    clearInterval(poll)
    fsWatcher?.close()
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
    // Empty from:0 (store not resolved yet) is the same as no baseline.
    expect(kimiDeltasFromTurns([], next)).toEqual([])
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

  it('does not emit when an unchanged assistant is followed by a user, or the parse shrinks', () => {
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

  it('emits the assistant suffix when a coalesced snapshot finishes it then appends a user', () => {
    const partial = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'text', text: 'looks' } }),
    ])
    const finishedThenUser = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'text', text: 'looks' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'good' } }),
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'again' }],
          origin: { kind: 'user' },
        },
      },
    ])
    expect(finishedThenUser.map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
    expect(kimiDeltasFromTurns(partial, finishedThenUser)).toEqual([
      { kind: 'assistant', text: '\n\ngood' },
    ])

    const finishedThenNextAsst = kimiTurnsFromLines([
      user,
      ev({ type: 'content.part', part: { type: 'text', text: 'looks' } }),
      ev({ type: 'content.part', part: { type: 'text', text: 'good' } }),
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'again' }],
          origin: { kind: 'user' },
        },
      },
      ev({ type: 'content.part', part: { type: 'text', text: 'on it' } }),
    ])
    expect(kimiDeltasFromTurns(partial, finishedThenNextAsst)).toEqual([
      { kind: 'assistant', text: '\n\ngood' },
      { kind: 'assistant', text: 'on it' },
    ])
  })

  it('diffs untruncated thinking across the 8k display cap without replaying the window', () => {
    const parseThink = (think: string) =>
      kimiTurnsFromLines([user, ev({ type: 'content.part', part: { type: 'think', think } })])

    const rawA = 'a'.repeat(THINKING_TAIL_CHARS)
    const rawB = rawA + 'X'
    const rawC = rawB + 'Y'.repeat(80)
    const rawD = rawC + 'Z'

    const a = parseThink(rawA)
    const b = parseThink(rawB)
    const c = parseThink(rawC)
    const d = parseThink(rawD)

    expect(a[1]?.thinking).toBe(rawA)
    expect(b[1]?.thinking?.startsWith('…')).toBe(true)
    expect(b[1]?.thinking).toHaveLength(1 + THINKING_TAIL_CHARS)
    expect(c[1]?.thinking).toBe('…' + rawC.slice(-THINKING_TAIL_CHARS))

    expect(kimiDeltasFromTurns(undefined, a)).toEqual([])
    const d1 = kimiDeltasFromTurns(a, b)
    const d2 = kimiDeltasFromTurns(b, c)
    const d3 = kimiDeltasFromTurns(c, d)
    expect(d1).toEqual([{ kind: 'reasoning', text: 'X' }])
    expect(d2).toEqual([{ kind: 'reasoning', text: 'Y'.repeat(80) }])
    expect(d3).toEqual([{ kind: 'reasoning', text: 'Z' }])

    const emitted = [...d1, ...d2, ...d3]
      .filter((x) => x.kind === 'reasoning')
      .map((x) => x.text)
      .join('')
    const growth = rawD.slice(rawA.length)
    expect(emitted).toBe(growth)
    expect(emitted).toHaveLength(rawD.length - rawA.length)
    expect(emitted.includes('…')).toBe(false)
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
