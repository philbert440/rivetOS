import { describe, expect, it } from 'vitest'
import {
  formatRunDuration,
  matchesWorkflowQuery,
  previewRunLabel,
  relativeTime,
  runDisplayName,
  slugifyWorkflowId,
} from './hub.js'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')

describe('relativeTime', () => {
  it('buckets by age and tolerates missing / bad input', () => {
    expect(relativeTime('2026-10-07T11:59:30.000Z', NOW)).toBe('just now')
    expect(relativeTime('2026-10-07T11:50:00.000Z', NOW)).toBe('10m ago')
    expect(relativeTime('2026-10-07T09:00:00.000Z', NOW)).toBe('3h ago')
    expect(relativeTime('2026-10-05T12:00:00.000Z', NOW)).toBe('2d ago')
    expect(relativeTime(undefined, NOW)).toBe('—')
    expect(relativeTime('nope', NOW)).toBe('—')
  })
})

describe('formatRunDuration', () => {
  it('formats finished and live runs', () => {
    expect(formatRunDuration('2026-10-07T11:59:15.000Z', '2026-10-07T11:59:57.000Z', NOW)).toBe(
      '42s',
    )
    expect(formatRunDuration('2026-10-07T11:55:00.000Z', undefined, NOW)).toBe('5m 0s')
    expect(formatRunDuration('2026-10-07T09:30:00.000Z', undefined, NOW)).toBe('2h 30m')
    expect(formatRunDuration('2026-10-05T10:00:00.000Z', undefined, NOW)).toBe('2d 2h')
    expect(formatRunDuration(undefined, undefined, NOW)).toBe('—')
  })
})

describe('runDisplayName', () => {
  const names = new Map([['pr-review', 'PR review']])
  it('prefers label, then def name, then id', () => {
    expect(runDisplayName({ label: 'rivetOS#12', workflowId: 'pr-review' }, names)).toBe(
      'rivetOS#12',
    )
    expect(runDisplayName({ workflowId: 'pr-review' }, names)).toBe('PR review')
    expect(runDisplayName({ workflowId: 'gone' }, names)).toBe('gone')
  })
})

describe('matchesWorkflowQuery', () => {
  const def = { id: 'pr-review', name: 'PR review', description: 'Three-model code review' }
  it('matches name, id, description case-insensitively', () => {
    expect(matchesWorkflowQuery(def, '')).toBe(true)
    expect(matchesWorkflowQuery(def, 'pr-rev')).toBe(true)
    expect(matchesWorkflowQuery(def, 'CODE')).toBe(true)
    expect(matchesWorkflowQuery(def, 'deploy')).toBe(false)
  })
})

describe('previewRunLabel', () => {
  it('fills from form values and collapses blanks', () => {
    expect(previewRunLabel('{{repo}}#{{ pr }}', { repo: 'rivetOS', pr: '12' })).toBe('rivetOS#12')
    expect(previewRunLabel('{{repo}}   {{missing}}', { repo: 'x' })).toBe('x')
    expect(previewRunLabel('{{missing}}', {})).toBeUndefined()
    expect(previewRunLabel(undefined, {})).toBeUndefined()
  })
})

describe('slugifyWorkflowId', () => {
  it('lowercases, hyphenates, trims', () => {
    expect(slugifyWorkflowId('  PR Review — v2! ')).toBe('pr-review-v2')
    expect(slugifyWorkflowId('!!!')).toBe('')
  })
})
