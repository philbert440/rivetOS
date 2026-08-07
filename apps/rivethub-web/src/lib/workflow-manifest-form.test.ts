import { describe, it, expect } from 'vitest'
import {
  manifestFormFromRaw,
  rawFromManifestForm,
  emptyManifestForm,
} from './workflow-manifest-form.js'

describe('manifestFormFromRaw / rawFromManifestForm', () => {
  it('round-trips known fields and preserves unknown keys', () => {
    const raw = {
      id: 'demo',
      version: '1.2.0',
      name: 'Demo',
      description: 'hi',
      input: [{ name: 'msg', type: 'string', required: true }],
      output: [{ name: 'out', type: 'string' }],
      budgets: { maxTokens: 1000, maxConcurrentRuns: 2 },
      outline: [{ id: 'a', label: 'A' }],
      customFlag: true,
    }
    const form = manifestFormFromRaw(raw)
    expect(form.id).toBe('demo')
    expect(form.input).toHaveLength(1)
    expect(form.budgets.maxTokens).toBe(1000)
    expect(form._raw.customFlag).toBe(true)

    form.name = 'Demo 2'
    form.description = ''
    form.budgets.maxCost = 3.5
    const back = rawFromManifestForm(form)
    expect(back.name).toBe('Demo 2')
    expect(back.description).toBeUndefined()
    expect(back.customFlag).toBe(true)
    expect(back.outline).toEqual([{ id: 'a', label: 'A' }])
    expect((back.budgets as { maxCost: number }).maxCost).toBe(3.5)
    expect((back.input as unknown[]).length).toBe(1)
  })


  it('preserves unknown keys nested under budgets and does not invent version', () => {
    const form = manifestFormFromRaw({
      id: 'x',
      budgets: { maxTokens: 10, customCap: 'keep-me' },
    })
    expect(form.version).toBe('')
    form.budgets.maxTokens = 20
    const back = rawFromManifestForm(form)
    expect((back.budgets as Record<string, unknown>).customCap).toBe('keep-me')
    expect((back.budgets as Record<string, unknown>).maxTokens).toBe(20)
    expect('version' in back).toBe(false)
    expect('name' in back).toBe(false)
  })

  it('rejects non-object roots', () => {
    expect(() => manifestFormFromRaw(null)).toThrow(/object/)
    expect(() => manifestFormFromRaw([])).toThrow(/object/)
  })

  it('emptyManifestForm is serializable', () => {
    const back = rawFromManifestForm(emptyManifestForm())
    expect(back.version).toBe('1.0.0')
    expect(back.input).toEqual([])
  })
})
