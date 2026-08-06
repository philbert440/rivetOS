import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendJournal,
  readJournal,
  findCachedStepResult,
  maxSeqForLabel,
  isOpenGate,
} from './journal.js'
import type { JournalEntry } from './types.js'

describe('journal', () => {
  it('appends and reads JSONL entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    const e1: JournalEntry = {
      type: 'run_started',
      ts: '2026-01-01T00:00:00.000Z',
      runId: 'r1',
      workflowId: 'w',
      version: '1',
      input: {},
      startedBy: { type: 'human' },
    }
    const e2: JournalEntry = {
      type: 'step_finished',
      ts: '2026-01-01T00:00:01.000Z',
      stepId: 'a#1',
      label: 'a',
      seq: 1,
      kind: 'agent',
      result: { x: 1 },
    }
    await appendJournal(dir, e1)
    await appendJournal(dir, e2)
    const all = await readJournal(dir)
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ type: 'step_finished', result: { x: 1 } })
  })

  it('findCachedStepResult prefers step_finished and gate_resolved', () => {
    const entries: JournalEntry[] = [
      {
        type: 'step_finished',
        ts: 't',
        stepId: 'a#1',
        label: 'a',
        seq: 1,
        kind: 'run',
        result: 42,
      },
      {
        type: 'gate_resolved',
        ts: 't',
        stepId: 'g#1',
        label: 'g',
        seq: 1,
        values: { ok: true },
      },
    ]
    expect(findCachedStepResult(entries, 'a', 1)).toEqual({
      hit: true,
      result: 42,
      from: 'step_finished',
    })
    expect(findCachedStepResult(entries, 'g', 1)).toEqual({
      hit: true,
      result: { ok: true },
      from: 'gate_resolved',
    })
    expect(findCachedStepResult(entries, 'a', 2).hit).toBe(false)
  })

  it('maxSeqForLabel and isOpenGate', () => {
    const entries: JournalEntry[] = [
      {
        type: 'gate_opened',
        ts: 't',
        stepId: 'g#1',
        label: 'g',
        seq: 1,
        fields: ['a'],
      },
      {
        type: 'step_finished',
        ts: 't',
        stepId: 'x#2',
        label: 'x',
        seq: 2,
        kind: 'run',
        result: null,
      },
    ]
    expect(maxSeqForLabel(entries, 'g')).toBe(1)
    expect(maxSeqForLabel(entries, 'x')).toBe(2)
    expect(isOpenGate(entries, 'g', 1)).toBe(true)
    entries.push({
      type: 'gate_resolved',
      ts: 't',
      stepId: 'g#1',
      label: 'g',
      seq: 1,
      values: {},
    })
    expect(isOpenGate(entries, 'g', 1)).toBe(false)
  })

  it('serializes concurrent appends so every line parses as JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-race-'))
    const N = 40
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendJournal(dir, {
          type: 'step_finished',
          ts: `t-${i}`,
          stepId: `s#${i}`,
          label: 's',
          seq: i,
          kind: 'run',
          result: { i, pad: 'x'.repeat(20) },
        }),
      ),
    )
    const all = await readJournal(dir)
    expect(all).toHaveLength(N)
    // Every entry is a full object (no partial interleave)
    for (const e of all) {
      expect(e.type).toBe('step_finished')
    }
  })
})
