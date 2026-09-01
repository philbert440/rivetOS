import { describe, it, expect } from 'vitest'
import { filterPersistentWorkspaceItems } from './update.js'

describe('filterPersistentWorkspaceItems', () => {
  it('includes users among watched workspace items', () => {
    expect(
      filterPersistentWorkspaceItems(['AGENT.md', 'users', 'noise', 'skills', 'memory']),
    ).toEqual(['AGENT.md', 'users', 'skills', 'memory'])
  })
})
