import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CODEX_SHEET,
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
    expect(rowPillText(undefined, undefined, 'codex')).toBe('Codex')
    expect(rowPillText(undefined, undefined, 'opencode')).toBe('opencode')
    expect(rowPillText(undefined, undefined, 'qwen-code')).toBe('Qwen Code')
    expect(rowPillText(undefined, undefined, 'unknown-harness')).toBe('unknown-harness')
  })
})

describe('harnessLabel', () => {
  it('uses the friendly name', () => {
    expect(harnessLabel('claude-code')).toBe('Claude Code')
    expect(harnessLabel('codex')).toBe('Codex')
    expect(harnessLabel('opencode')).toBe('opencode')
    expect(harnessLabel('qwen-code')).toBe('Qwen Code')
    expect(harnessLabel('nope')).toBe('nope')
  })
})

describe('CODEX_SHEET', () => {
  it('mirrors the den default model and low/medium/high/xhigh efforts', () => {
    expect(defaultModel(CODEX_SHEET)).toBe('default')
    expect(modelOptionsFor(CODEX_SHEET).map((o) => o.value)).toEqual(['default'])
    expect(effortOptionsFor(CODEX_SHEET, 'default').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(defaultEffort(CODEX_SHEET, 'default')).toBe('medium')
  })
})

describe('spawnModelEffort', () => {
  const sheet = ['fable', 'opus']

  it('sends nothing when settings are absent or carry no model/effort', () => {
    expect(spawnModelEffort(undefined)).toEqual({})
    expect(spawnModelEffort({ effort: 'medium', harnessEffort: 'max' }, sheet)).toEqual({})
  })

  it('sends an on-sheet launch model without a harnessId, and never an unvetted one', () => {
    // A catalog thread carries the pre-spawn model only when that id is on the
    // resolved launchModel sheet, and must NOT inherit `--effort`.
    expect(
      spawnModelEffort({ model: 'opus', effort: 'medium', harnessEffort: 'max' }, sheet),
    ).toEqual({ model: 'opus' })
    expect(spawnModelEffort({ model: '  fable  ' }, sheet)).toEqual({ model: 'fable' })
    // Off the sheet.
    expect(spawnModelEffort({ model: 'sonnet' }, sheet)).toEqual({})
    // Malformed tokens the den would 400 (space, over 64 chars, `..`).
    expect(spawnModelEffort({ model: 'provider model' }, sheet)).toEqual({})
    expect(spawnModelEffort({ model: 'a'.repeat(65) }, sheet)).toEqual({})
    expect(spawnModelEffort({ model: 'foo..bar' }, sheet)).toEqual({})
    // Registry pending/errored/row missing → no vetted ids → harness default.
    expect(spawnModelEffort({ model: 'opus' })).toEqual({})
    expect(spawnModelEffort({ model: 'opus' }, undefined)).toEqual({})
  })

  it('sends effort when the preset thread has harnessEffort', () => {
    expect(spawnModelEffort({ harnessId: 'claude-code', harnessEffort: 'max' })).toEqual({
      effort: 'max',
    })
  })

  it('preset threads still send model and effort without a sheet check', () => {
    expect(
      spawnModelEffort({ harnessId: 'claude-code', model: 'fable', harnessEffort: 'high' }, sheet),
    ).toEqual({ model: 'fable', effort: 'high' })
    // Off-sheet and malformed stay as they are today for a preset.
    expect(
      spawnModelEffort({ harnessId: 'claude-code', model: 'provider model', harnessEffort: 'max' }),
    ).toEqual({ model: 'provider model', effort: 'max' })
    expect(
      spawnModelEffort(
        { harnessId: 'claude-code', model: 'foo..bar', harnessEffort: 'low' },
        sheet,
      ),
    ).toEqual({ model: 'foo..bar', effort: 'low' })
    expect(spawnModelEffort({ harnessId: 'claude-code', model: 'a'.repeat(65) }, sheet)).toEqual({
      model: 'a'.repeat(65),
    })
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
