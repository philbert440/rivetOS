import { describe, it, expect } from 'vitest'
import type { CatalogAgent } from '@rivetos/types'
import { criteriaFromLines, taskAgentOptions } from './task-create.js'

describe('criteriaFromLines', () => {
  it('builds manual criteria with stable ids', () => {
    expect(criteriaFromLines('  first\n\nsecond  \n')).toEqual([
      { id: 'c1', description: 'first', kind: 'manual' },
      { id: 'c2', description: 'second', kind: 'manual' },
    ])
  })

  it('returns empty for blank input', () => {
    expect(criteriaFromLines('')).toEqual([])
    expect(criteriaFromLines('  \n  ')).toEqual([])
  })
})

describe('taskAgentOptions', () => {
  const agents: CatalogAgent[] = [
    { id: 'remote-g', node: 'ct112', local: false, provider: 'xai' },
    { id: 'claude', provider: 'claude-cli', model: 'opus', node: 'here', local: true },
    { id: 'claude', provider: 'claude-cli', node: 'here', local: true }, // dupe
    { id: 'grok', node: 'ct112', local: false },
  ]

  it('lists locals first, then mesh; de-dupes by id', () => {
    const opts = taskAgentOptions(agents)
    expect(opts.map((o) => o.value)).toEqual(['claude', 'remote-g', 'grok'])
    expect(opts[0]?.label).toContain('this node')
    expect(opts[1]?.label).toContain('@ ct112')
  })
})
