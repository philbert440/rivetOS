import { describe, it, expect } from 'vitest'
import {
  splitFrontmatter,
  joinFrontmatter,
  agentFieldsFromConfig,
  configFromAgentFields,
} from './frontmatter.js'

describe('splitFrontmatter / joinFrontmatter', () => {
  it('returns whole body when no fence', () => {
    const r = splitFrontmatter('hello\nworld\n')
    expect(r.hasFrontmatter).toBe(false)
    expect(r.yaml).toBeNull()
    expect(r.body).toBe('hello\nworld\n')
  })

  it('splits YAML frontmatter (CRLF + BOM tolerant)', () => {
    const src = '\uFEFF---\r\nmodel: claude\r\nmaxTurns: 4\r\n---\r\n\r\nprompt body\r\n'
    const r = splitFrontmatter(src)
    expect(r.hasFrontmatter).toBe(true)
    expect(r.yaml).toContain('model: claude')
    expect(r.body.replace(/\r\n/g, '\n').trim()).toBe('prompt body')
  })

  it('throws on unterminated fence', () => {
    expect(() => splitFrontmatter('---\nmodel: x\nno close')).toThrow(/Unterminated/)
  })

  it('round-trips join → split', () => {
    const joined = joinFrontmatter('model: opus\nmaxTurns: 3', 'Do the thing.\n')
    const r = splitFrontmatter(joined)
    expect(r.hasFrontmatter).toBe(true)
    expect(r.yaml).toContain('model: opus')
    expect(r.body.trim()).toBe('Do the thing.')
  })

  it('join without yaml emits body only', () => {
    expect(joinFrontmatter(null, 'plain\n')).toBe('plain\n')
  })
})

describe('agentFieldsFromConfig / configFromAgentFields', () => {
  it('extracts known fields and preserves extras', () => {
    const fields = agentFieldsFromConfig({
      model: 'gpt',
      maxTurns: 5,
      tools: ['shell'],
      custom: true,
    })
    expect(fields.model).toBe('gpt')
    expect(fields.maxTurns).toBe(5)
    expect(fields.tools).toEqual(['shell'])
    expect(fields.extras?.custom).toBe(true)

    const back = configFromAgentFields(fields)
    expect(back.model).toBe('gpt')
    expect(back.maxTurns).toBe(5)
    expect(back.tools).toEqual(['shell'])
    expect(back.custom).toBe(true)
  })


  it('preserves type-mismatched known keys living in extras on round-trip', () => {
    const fields = agentFieldsFromConfig({ maxTurns: '5', model: 42, keep: 1 })
    expect(fields.maxTurns).toBeUndefined()
    expect(fields.extras?.maxTurns).toBe('5')
    const back = configFromAgentFields(fields)
    expect(back.maxTurns).toBe('5')
    expect(back.model).toBe(42)
    expect(back.keep).toBe(1)
  })

  it('omits empty model on serialize', () => {
    const back = configFromAgentFields({ model: '', extras: { keep: 1 } })
    expect(back.model).toBeUndefined()
    expect(back.keep).toBe(1)
  })
})
