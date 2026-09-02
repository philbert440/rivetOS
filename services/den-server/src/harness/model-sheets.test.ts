import { describe, expect, it } from 'vitest'
import {
  appendModelEffortArgv,
  applySheetOverride,
  claudeSheet,
  deepseekSheet,
  grokSheet,
  hermesSheet,
  kimiSheet,
  parseKimiToml,
  sanitizeModels,
  sheetForHarness,
} from './model-sheets.js'

const GROK_CACHE = {
  models: {
    'grok-4.6': {
      info: {
        name: 'Grok 4.6',
        hidden: false,
        reasoning_efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', default: true },
          { id: 'xhigh', label: 'X-High' },
        ],
      },
    },
    'grok-4.5': {
      info: {
        name: 'Grok 4.5',
        hidden: false,
        reasoning_efforts: [{ id: 'high', label: 'High', default: true }],
      },
    },
    'grok-hidden': {
      info: { name: 'Hidden', hidden: true, reasoning_efforts: [] },
    },
    'grok-no-reason': {
      info: {
        name: 'No reason',
        hidden: false,
        supports_reasoning_effort: false,
        reasoning_efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', default: true },
        ],
      },
    },
  },
}

describe('claudeSheet', () => {
  it('declares aliases including 1M variants and medium-default efforts', () => {
    const sheet = claudeSheet()
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--effort')
    expect(sheet.models?.map((m) => m.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'fable[1m]',
      'opus[1m]',
      'sonnet[1m]',
    ])
    expect(sheet.models?.find((m) => m.default)?.id).toBe('fable')
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('grokSheet', () => {
  it('filters hidden, maps efforts, and marks the first visible as default', () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--reasoning-effort')
    expect(sheet.models?.map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.5', 'grok-no-reason'])
    expect(sheet.models?.[0]).toMatchObject({
      id: 'grok-4.6',
      label: 'Grok 4.6',
      default: true,
    })
    expect(sheet.models?.[0].efforts?.map((e) => e.id)).toEqual(['low', 'high', 'xhigh'])
    expect(sheet.models?.[0].efforts?.find((e) => e.default)?.id).toBe('high')
    expect(sheet.models?.some((m) => m.id === 'grok-hidden')).toBe(false)
  })

  it('omits efforts when supports_reasoning_effort is false', () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    const row = sheet.models?.find((m) => m.id === 'grok-no-reason')
    expect(row?.efforts).toBeUndefined()
  })

  it("copies the default model's efforts onto the harness-wide list", () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'high', 'xhigh'])
    expect(sheet.efforts).toEqual(sheet.models?.[0].efforts)
  })

  it('falls back to grok-4.6 when the cache is unreadable', () => {
    const sheet = grokSheet(() => {
      throw new Error('ENOENT')
    })
    expect(sheet.models).toEqual([expect.objectContaining({ id: 'grok-4.6', default: true })])
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('high')
    expect(sheet.effortFlag).toBe('--reasoning-effort')
  })
})

describe('kimiSheet / parseKimiToml', () => {
  const toml = `
# comment
default_model = "k2p5"

[models.k2p5]
provider = "moonshot"

[models.kimi-for-coding]
provider = "moonshot"

[other]
x = 1
`
  it('parses aliases and marks default_model', () => {
    const models = parseKimiToml(toml)
    expect(models.map((m) => m.id)).toEqual(['k2p5', 'kimi-for-coding'])
    expect(models.find((m) => m.default)?.id).toBe('k2p5')
  })

  it('reads the first readable config.toml path', () => {
    const sheet = kimiSheet((path) => {
      if (path.endsWith('.kimi/config.toml')) return toml
      throw new Error('missing')
    }, '/home/tester')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheet.efforts).toBeUndefined()
    expect(sheet.models?.map((m) => m.id)).toEqual(['k2p5', 'kimi-for-coding'])
  })

  it('returns models: [] when no config is readable', () => {
    const sheet = kimiSheet(() => {
      throw new Error('ENOENT')
    })
    expect(sheet).toEqual({ models: [], modelFlag: '--model' })
  })
})

describe('hermesSheet / deepseekSheet', () => {
  it('hermes advertises no models (own picker) and --reasoning efforts', () => {
    const sheet = hermesSheet()
    expect(sheet.models).toEqual([])
    expect(sheet.effortFlag).toBe('--reasoning')
    expect(sheet.modelFlag).toBeUndefined()
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
  })

  it('deepseek is empty', () => {
    expect(deepseekSheet()).toEqual({})
  })
})

describe('applySheetOverride', () => {
  it('replaces models/efforts when the override carries that key', () => {
    const base = claudeSheet()
    const next = applySheetOverride(base, {
      models: [{ id: 'only', label: 'Only' }, { id: 1 }, { nope: true }],
      efforts: [{ id: 'max', label: 'Max', default: true }, 'bad'],
    })
    expect(next.models).toEqual([{ id: 'only', label: 'Only' }])
    expect(next.efforts).toEqual([{ id: 'max', label: 'Max', default: true }])
    expect(next.modelFlag).toBe('--model')
    expect(next.effortFlag).toBe('--effort')
  })

  it('ignores a non-array override and keeps the sheet list', () => {
    const base = claudeSheet()
    const next = applySheetOverride(base, { models: 'nope', efforts: { id: 'x' } })
    expect(next.models).toEqual(base.models)
    expect(next.efforts).toEqual(base.efforts)
  })

  it('ignores an override that sanitizes to empty and logs', () => {
    const base = claudeSheet()
    const logs: string[] = []
    const next = applySheetOverride(base, { models: [], efforts: [{ id: 'bad id!' }] }, (msg) =>
      logs.push(msg),
    )
    expect(next.models).toEqual(base.models)
    expect(next.efforts).toEqual(base.efforts)
    expect(logs.some((l) => l.includes('empty models override'))).toBe(true)
    expect(logs.some((l) => l.includes('empty efforts override'))).toBe(true)
  })
})

describe('sanitizeModels', () => {
  it('drops malformed entries and keeps nested efforts', () => {
    expect(
      sanitizeModels([
        { id: 'ok', label: 'OK', efforts: [{ id: 'low', label: 'Low' }, { id: '' }] },
        { id: 'bad id!' },
        null,
      ]),
    ).toEqual([{ id: 'ok', label: 'OK', efforts: [{ id: 'low', label: 'Low' }] }])
  })
})

describe('appendModelEffortArgv', () => {
  const claude = claudeSheet()
  it('appends flags for listed values', () => {
    expect(appendModelEffortArgv(['claude'], claude, 'fable', 'high')).toEqual([
      'claude',
      '--model',
      'fable',
      '--effort',
      'high',
    ])
  })

  it('omits unknown values and when the harness has no flag', () => {
    expect(appendModelEffortArgv(['claude'], claude, 'not-a-model', 'nope')).toEqual(['claude'])
    expect(
      appendModelEffortArgv(
        ['kimi'],
        { models: [{ id: 'k2p5', label: 'k2p5' }], modelFlag: '--model' },
        'k2',
        'high',
      ),
    ).toEqual(['kimi'])
    expect(appendModelEffortArgv(['dsh'], sheetForHarness('deepseek-harness'), 'x', 'y')).toEqual([
      'dsh',
    ])
  })

  it("uses the model's own efforts when present", () => {
    const grok = grokSheet(() => GROK_CACHE, '/tmp')
    expect(appendModelEffortArgv(['grok'], grok, 'grok-4.6', 'xhigh')).toEqual([
      'grok',
      '--model',
      'grok-4.6',
      '--reasoning-effort',
      'xhigh',
    ])
    // grok-4.5 only lists high
    expect(appendModelEffortArgv(['grok'], grok, 'grok-4.5', 'xhigh')).toEqual([
      'grok',
      '--model',
      'grok-4.5',
    ])
  })
})
