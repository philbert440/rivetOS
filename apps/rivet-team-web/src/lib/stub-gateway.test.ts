import { afterEach, describe, expect, it } from 'vitest'
import { createStubGateway } from './stub-gateway.js'
import { SAMPLE_PERSONAS } from './seed.js'
import type { SessionWsFrame } from './types.js'

describe('createStubGateway', () => {
  afterEach(() => {
    // each test gets a fresh module-level thread map via new posts only
  })

  it('lists the three sample personas', () => {
    const g = createStubGateway()
    const personas = g.listPersonas('local-user')
    expect(personas).toHaveLength(3)
    expect(personas.every((p) => p.sample === true)).toBe(true)
    expect(personas.map((p) => p.name)).toEqual(SAMPLE_PERSONAS.map((p) => p.name))
  })

  it('accepts a post and emits user + working + assistant frames', async () => {
    const g = createStubGateway()
    const session = SAMPLE_PERSONAS[0].threadId
    const frames: SessionWsFrame[] = []
    const sub = g.watchSessions((f) => frames.push(f), session)
    const accepted = await g.postMessage(session, { text: 'hello team', userId: 'local-user' })
    expect(accepted.accepted).toBe(true)
    await new Promise((r) => setTimeout(r, 700))
    sub.close()
    const kinds = frames.map((f) => f.kind)
    expect(kinds).toContain('message')
    expect(kinds).toContain('stream')
    const messages = frames.filter((f) => f.kind === 'message')
    expect(messages.some((m) => m.kind === 'message' && m.role === 'user')).toBe(true)
    expect(messages.some((m) => m.kind === 'message' && m.role === 'assistant')).toBe(true)
  })
})
