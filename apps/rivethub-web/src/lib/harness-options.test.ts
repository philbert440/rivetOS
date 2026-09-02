import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  defaultEffort,
  defaultModel,
  effortOptionsFor,
  harnessLabel,
  modelOptionsFor,
  rowPillText,
  spawnModelEffort,
  type HarnessSheet,
} from './harness-options.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const CLAUDE: HarnessSheet = {
  models: [
    { id: 'fable', label: 'Fable 5.1', default: true },
    {
      id: 'opus',
      label: 'Opus 5',
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'max', label: 'Max', default: true },
      ],
    },
  ],
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', default: true },
    { id: 'high', label: 'High' },
  ],
}

describe('modelOptionsFor / defaultModel', () => {
  it('maps ids to Select options and picks the default', () => {
    expect(modelOptionsFor(CLAUDE)).toEqual([
      { value: 'fable', label: 'Fable 5.1' },
      { value: 'opus', label: 'Opus 5' },
    ])
    expect(defaultModel(CLAUDE)).toBe('fable')
    expect(modelOptionsFor({ models: [] })).toEqual([])
    expect(defaultModel(undefined)).toBe('')
    expect(defaultModel({ models: [{ id: 'x', label: 'X' }] })).toBe('x')
  })
})

describe('effortOptionsFor / defaultEffort', () => {
  it("uses the model's efforts when present, else harness-wide", () => {
    expect(effortOptionsFor(CLAUDE, 'opus').map((o) => o.value)).toEqual(['low', 'max'])
    expect(defaultEffort(CLAUDE, 'opus')).toBe('max')
    expect(effortOptionsFor(CLAUDE, 'fable').map((o) => o.value)).toEqual(['low', 'medium', 'high'])
    expect(defaultEffort(CLAUDE, 'fable')).toBe('medium')
    expect(effortOptionsFor({ models: [] }, 'x')).toEqual([])
    expect(defaultEffort(undefined, '')).toBe('')
  })
})

describe('rowPillText', () => {
  it('prefers summary.model, then preset.model, then harness label', () => {
    expect(rowPillText({ model: 'fable' }, { model: 'opus' }, 'claude-code')).toBe('fable')
    expect(rowPillText({}, { model: 'opus' }, 'claude-code')).toBe('opus')
    expect(rowPillText({}, { model: '' }, 'claude-code')).toBe('Claude Code')
    expect(rowPillText(undefined, undefined, 'grok-build')).toBe('grok Build')
    expect(rowPillText(undefined, undefined, 'unknown-harness')).toBe('unknown-harness')
  })
})

describe('harnessLabel', () => {
  it('uses the friendly name', () => {
    expect(harnessLabel('claude-code')).toBe('Claude Code')
    expect(harnessLabel('deepseek-harness')).toBe('DeepSeek')
    expect(harnessLabel('nope')).toBe('nope')
  })
})

describe('spawnModelEffort', () => {
  it('sends nothing without a harnessId', () => {
    expect(spawnModelEffort(undefined)).toEqual({})
    expect(spawnModelEffort({ model: 'fable', effort: 'medium', harnessEffort: 'max' })).toEqual({})
  })

  it('sends effort when the preset thread has harnessEffort', () => {
    expect(spawnModelEffort({ harnessId: 'claude-code', harnessEffort: 'max' })).toEqual({
      effort: 'max',
    })
  })

  it('sends model and effort together when both are set', () => {
    expect(
      spawnModelEffort({ harnessId: 'claude-code', model: 'fable', harnessEffort: 'high' }),
    ).toEqual({ model: 'fable', effort: 'high' })
  })
})

describe('source guard', () => {
  it('agents-section has no EFFORT_OPTIONS and does not import model-options', () => {
    const editor = readFileSync(join(HERE, '..', 'components', 'agents-section.tsx'), 'utf8')
    expect(editor).not.toMatch(/EFFORT_OPTIONS/)
    expect(editor).not.toMatch(/model-options/)
    const leftover = join(HERE, 'model-options.ts')
    if (existsSync(leftover)) {
      expect(readFileSync(leftover, 'utf8')).not.toMatch(/export function modelOptions/)
    }
  })
})
