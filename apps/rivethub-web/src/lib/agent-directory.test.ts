import { describe, expect, it } from 'vitest'
import { agentDirectoryPlaceholder, slugify } from './agent-directory.js'

describe('slugify', () => {
  // Same cases as packages/agent-registry slugify — the hub copy must not drift.
  it.each([
    ['Hello World', 'hello-world'],
    ['  Foo__Bar!! ', 'foo-bar'],
    ['Hello---World', 'hello-world'],
    ['123 Agent', '123-agent'],
    ['---', 'agent'],
    ['', 'agent'],
    ['...', 'agent'],
    ['A'.repeat(80), 'a'.repeat(48)],
    ['a'.repeat(48) + 'b', 'a'.repeat(48)],
  ])('slugify(%j) → %j', (name, expected) => {
    expect(slugify(name)).toBe(expected)
  })
})

describe('agentDirectoryPlaceholder', () => {
  it('joins the selected node directory root and the slug', () => {
    expect(agentDirectoryPlaceholder('/home/rivet/.rivetos/agents/', 'Hello World')).toBe(
      '/home/rivet/.rivetos/agents/hello-world',
    )
  })

  it('is just the slug when the list response has no directory root', () => {
    expect(agentDirectoryPlaceholder(undefined, 'Reviewer')).toBe('reviewer')
    expect(agentDirectoryPlaceholder('  ', 'Reviewer')).toBe('reviewer')
  })
})
