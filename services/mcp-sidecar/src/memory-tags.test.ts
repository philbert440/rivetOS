import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveMemoryWriteTags } from './memory-write.js'

const KEYS = [
  'RIVETOS_MEMORY_SOURCE',
  'RIVETOS_MEMORY_AGENT',
  'RIVETOS_MEMORY_PERSONA',
  'RIVETOS_MEMORY_CHANNEL',
] as const

function clearTagEnv(): void {
  for (const k of KEYS) delete process.env[k]
}

beforeEach(clearTagEnv)
afterEach(clearTagEnv)

describe('resolveMemoryWriteTags', () => {
  it('defaults source/agent/channel to mcp', () => {
    expect(resolveMemoryWriteTags({})).toEqual({
      source: 'mcp',
      agent: 'mcp',
      channel: 'mcp',
    })
  })

  it('prefers explicit args over env', () => {
    process.env.RIVETOS_MEMORY_SOURCE = 'env-source'
    process.env.RIVETOS_MEMORY_AGENT = 'env-agent'
    process.env.RIVETOS_MEMORY_PERSONA = 'env-persona'
    process.env.RIVETOS_MEMORY_CHANNEL = 'env-channel'
    expect(
      resolveMemoryWriteTags({
        source: 'grokbot',
        agent: 'rivet-grokbot',
        persona: 'Developer',
        channel: 'grokbot',
      }),
    ).toEqual({
      source: 'grokbot',
      agent: 'rivet-grokbot',
      persona: 'Developer',
      channel: 'grokbot',
    })
  })

  it('reads launcher env when args omitted', () => {
    process.env.RIVETOS_MEMORY_SOURCE = 'grokbot'
    process.env.RIVETOS_MEMORY_AGENT = 'rivet-grokbot'
    process.env.RIVETOS_MEMORY_PERSONA = 'Developer'
    process.env.RIVETOS_MEMORY_CHANNEL = 'grokbot'
    expect(resolveMemoryWriteTags({})).toEqual({
      source: 'grokbot',
      agent: 'rivet-grokbot',
      persona: 'Developer',
      channel: 'grokbot',
    })
  })
})
