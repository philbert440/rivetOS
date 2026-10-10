import { describe, expect, it } from 'vitest'
import type { HarnessSessionSummary } from '@rivetos/types'
import { finishedNotice, finishedTurns } from './finished-turns.js'

const row = (sessionId: string, status: HarnessSessionSummary['status'], title?: string) =>
  ({
    sessionId,
    harnessId: 'claude-code',
    createdAt: '',
    updatedAt: '',
    status,
    title,
  }) as HarnessSessionSummary

describe('finishedTurns', () => {
  it('reports only active → idle edges', () => {
    const first = finishedTurns(new Map(), [row('a', 'active'), row('b', 'idle')])
    expect(first.finished).toEqual([])
    const second = finishedTurns(first.next, [row('a', 'idle'), row('b', 'idle')])
    expect(second.finished.map((s) => s.sessionId)).toEqual(['a'])
    expect(finishedTurns(second.next, [row('a', 'idle')]).finished).toEqual([])
  })

  it('a session seen for the first time never notifies', () => {
    expect(finishedTurns(new Map(), [row('new', 'idle')]).finished).toEqual([])
  })

  it('an error or end is not a finished reply', () => {
    const prev = finishedTurns(new Map(), [row('a', 'active')]).next
    expect(finishedTurns(prev, [row('a', 'error')]).finished).toEqual([])
  })
})

describe('finishedNotice', () => {
  it('names the conversation, or its id when untitled', () => {
    expect(finishedNotice(row('a', 'idle', ' Fix the den '))).toEqual({
      title: 'Agent finished replying',
      body: 'Fix the den',
    })
    expect(finishedNotice(row('claude-code:x', 'idle')).body).toBe('claude-code:x')
  })
})
