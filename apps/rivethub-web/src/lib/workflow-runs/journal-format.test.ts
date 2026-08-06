import { describe, it, expect } from 'vitest'
import type { WorkflowJournalEntry } from '@rivetos/types'
import { formatJournalEntry, formatJournal } from './journal-format.js'

describe('formatJournalEntry', () => {
  it('formats run_started / run_finished', () => {
    const start = formatJournalEntry({
      type: 'run_started',
      ts: '2026-01-01T00:00:00.000Z',
      workflowId: 'demo',
      version: '1.0.0',
      input: { message: 'hi' },
    } as WorkflowJournalEntry)
    expect(start.summary).toContain('demo')
    expect(start.kind).toBe('run')
    expect(start.severity).toBe('em')

    const done = formatJournalEntry({
      type: 'run_finished',
      ts: '2026-01-01T00:01:00.000Z',
      status: 'done',
      output: { result: 'ok' },
    } as WorkflowJournalEntry)
    expect(done.summary).toBe('Run done')
    expect(done.severity).toBe('em')

    const failed = formatJournalEntry({
      type: 'run_finished',
      ts: 't',
      status: 'failed',
      error: 'boom',
    } as WorkflowJournalEntry)
    expect(failed.severity).toBe('error')
    expect(failed.detail).toBe('boom')
  })

  it('formats step lifecycle', () => {
    const started = formatJournalEntry({
      type: 'step_started',
      ts: 't',
      label: 'load',
      kind: 'run',
      stepId: 'load#1',
      seq: 1,
    } as WorkflowJournalEntry)
    expect(started.summary).toContain('load')
    expect(started.summary).toContain('run')

    const finished = formatJournalEntry({
      type: 'step_finished',
      ts: 't',
      label: 'load',
      kind: 'run',
      stepId: 'load#1',
      seq: 1,
      result: { ok: true },
    } as WorkflowJournalEntry)
    expect(finished.detail).toContain('ok')

    const failed = formatJournalEntry({
      type: 'step_failed',
      ts: 't',
      label: 'load',
      kind: 'run',
      stepId: 'load#1',
      seq: 1,
      error: 'timeout',
    } as WorkflowJournalEntry)
    expect(failed.severity).toBe('error')
    expect(failed.detail).toBe('timeout')
  })

  it('formats gate open/resolve and manifest warn', () => {
    const opened = formatJournalEntry({
      type: 'gate_opened',
      ts: 't',
      label: 'approve',
      stepId: 'approve#1',
      seq: 1,
      prompt: 'Approve?',
      fields: ['approved'],
    } as WorkflowJournalEntry)
    expect(opened.kind).toBe('gate')
    expect(opened.detail).toContain('Approve?')
    expect(opened.detail).toContain('approved')

    const resolved = formatJournalEntry({
      type: 'gate_resolved',
      ts: 't',
      label: 'approve',
      stepId: 'approve#1',
      seq: 1,
      values: { approved: true },
    } as WorkflowJournalEntry)
    expect(resolved.summary).toContain('resolved')

    const warn = formatJournalEntry({
      type: 'manifest_warn',
      ts: 't',
      label: 'agent',
      stepId: 'agent#1',
      seq: 1,
      undeclared: ['extra'],
      message: 'undeclared fields',
    } as WorkflowJournalEntry)
    expect(warn.kind).toBe('warn')
    expect(warn.severity).toBe('warn')
    expect(warn.detail).toContain('extra')
  })

  it('falls back for unknown types', () => {
    const line = formatJournalEntry({ type: 'future_event', ts: 't', foo: 1 } as WorkflowJournalEntry)
    expect(line.kind).toBe('other')
    expect(line.summary).toBe('future_event')
  })
})

describe('formatJournal', () => {
  it('preserves order and assigns unique keys', () => {
    const lines = formatJournal([
      { type: 'run_started', ts: 'a', workflowId: 'w' } as WorkflowJournalEntry,
      { type: 'step_started', ts: 'b', label: 'x', stepId: 'x#1', seq: 1, kind: 'run' } as WorkflowJournalEntry,
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].key).not.toBe(lines[1].key)
  })
})
