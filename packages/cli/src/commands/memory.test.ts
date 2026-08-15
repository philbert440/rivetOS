import { describe, it, expect } from 'vitest'
import { buildRetryFailedWhere, parseRetryFailedFlags } from './memory.js'

describe('parseRetryFailedFlags', () => {
  it('requires at least one --task', () => {
    expect(() => parseRetryFailedFlags(['--dry-run'])).toThrow(/--task/)
  })

  it('parses task, error, limit, dry-run, json', () => {
    const flags = parseRetryFailedFlags([
      '--task',
      'extract-wiki',
      '--error',
      'text[] &',
      '--limit',
      '100',
      '--dry-run',
      '--json',
    ])
    expect(flags).toEqual({
      tasks: ['extract-wiki'],
      errorSubstr: 'text[] &',
      limit: 100,
      dryRun: true,
      json: true,
    })
  })

  it('accepts repeated --task', () => {
    const flags = parseRetryFailedFlags([
      '--task',
      'extract-wiki',
      '--task',
      'compact-conversation',
    ])
    expect(flags.tasks).toEqual(['extract-wiki', 'compact-conversation'])
  })

  it('rejects unknown options', () => {
    expect(() => parseRetryFailedFlags(['--task', 'x', '--nope'])).toThrow(/Unknown option/)
  })

  it('rejects --task without a value', () => {
    expect(() => parseRetryFailedFlags(['--task'])).toThrow(/--task requires/)
  })

  it('treats non-positive --limit as unbounded', () => {
    const flags = parseRetryFailedFlags(['--task', 'extract-wiki', '--limit', '0'])
    expect(flags.limit).toBeNull()
  })
})

describe('buildRetryFailedWhere', () => {
  it('binds tasks as $1 and locks the dead/unlocked filter', () => {
    const { whereSql, params, limitSql } = buildRetryFailedWhere({
      tasks: ['extract-wiki'],
      errorSubstr: null,
      limit: null,
      dryRun: false,
      json: false,
    })
    expect(params).toEqual([['extract-wiki']])
    expect(whereSql).toContain('j.attempts >= j.max_attempts')
    expect(whereSql).toContain('t.identifier = ANY($1::text[])')
    expect(whereSql).toContain('j.locked_at IS NULL')
    expect(whereSql).not.toContain('last_error')
    expect(limitSql).toBe('')
  })

  it('adds error substring and limit as later params', () => {
    const { whereSql, params, limitSql } = buildRetryFailedWhere({
      tasks: ['extract-wiki', 'compact-conversation'],
      errorSubstr: 'text[] &',
      limit: 50,
      dryRun: true,
      json: false,
    })
    expect(params).toEqual([['extract-wiki', 'compact-conversation'], 'text[] &', 50])
    expect(whereSql).toContain("j.last_error ILIKE '%' || $2::text || '%'")
    expect(limitSql).toBe(' LIMIT $3')
  })
})
